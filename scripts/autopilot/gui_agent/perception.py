"""感知层 — 视觉优先 + OCR 交叉验证。

职责 (视觉优先管线):
  - 截取屏幕或窗口图像
  - **主信号**: visual.py 像素级 UI 检测 (<50ms)
  - **辅信号**: macOS Vision OCR 文字验证
  - 交叉验证: visual + OCR 信号合并为 ScreenState
  - 可视化: --visual 模式下产出红框标注截图
  - 不执行任何 GUI 操作（纯感知）
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Optional

from PIL import Image

from .config import Config, DEFAULT_CONFIG
from .logger import AgentLogger
from .models import (
    BBox, CascadeState, CoordinateSystem, DisplayInfo, OCROutput, OCRResult,
    ScreenState, Screenshot, WindowInfo,
)
from .visual import UIDetector, UIElements, SendButtonState
from .annotator import Annotator


class Perception:
    """感知引擎 — GUI Agent 的眼睛。"""

    def __init__(self, config: Config = DEFAULT_CONFIG, logger: Optional[AgentLogger] = None):
        self.cfg = config
        self.log = logger or AgentLogger("perception", config)
        self._quartz = None
        self._vision = None
        self._init_frameworks()

        # 坐标系统 (截图后更新)
        self.coords: Optional[CoordinateSystem] = None

        # 视觉优先管线
        self.detector = UIDetector()
        self.annotator = Annotator(
            visual_mode=config.visual_mode,
            delay=config.visual_delay,
            output_dir=config.visual_dir if hasattr(config, 'visual_dir') else None,
            grid_spacing=config.visual_grid_spacing if hasattr(config, 'visual_grid_spacing') else 50,
        )

    # ─── 初始化 ──────────────────────────────────────────────────────────

    def _init_frameworks(self):
        """懒加载 macOS 框架（避免 import 失败阻断整个模块）。"""
        try:
            import Quartz
            self._quartz = Quartz
            self.log.debug("Quartz framework loaded")
        except ImportError:
            self.log.warn("Quartz framework not available")

        try:
            import Vision
            self._vision = Vision
            self.log.debug("Vision framework loaded")
        except ImportError:
            self.log.warn("Vision framework not available — OCR disabled")

    @property
    def has_ocr(self) -> bool:
        return self._vision is not None and self._quartz is not None

    # ─── 截图 ────────────────────────────────────────────────────────────

    def capture_screen(self, path: Optional[str] = None) -> Screenshot:
        """全屏截图。"""
        if path is None:
            path = str(self.cfg.screenshot_dir / f"screen_{int(time.time() * 1000)}.png")
        Path(path).parent.mkdir(parents=True, exist_ok=True)

        with self.log.timer("capture_screen"):
            start = time.time()
            result = subprocess.run(
                ["screencapture", "-x", "-C", path],
                capture_output=True, timeout=self.cfg.screenshot_timeout,
            )
            if result.returncode != 0:
                raise RuntimeError(f"screencapture failed: {result.stderr.decode()}")
            elapsed = (time.time() - start) * 1000

        return self._build_screenshot(path, elapsed)

    def capture_window(self, app_name: str, path: Optional[str] = None) -> Screenshot:
        """指定窗口截图（通过 window_id）。"""
        win_id = self._get_window_id(app_name)
        if win_id is None:
            self.log.warn(f"Window ID not found for {app_name}, falling back to full screen")
            return self.capture_screen(path)

        if path is None:
            path = str(self.cfg.screenshot_dir / f"window_{int(time.time() * 1000)}.png")
        Path(path).parent.mkdir(parents=True, exist_ok=True)

        with self.log.timer("capture_window"):
            start = time.time()
            result = subprocess.run(
                ["screencapture", "-x", "-o", "-l", str(win_id), path],
                capture_output=True, timeout=self.cfg.screenshot_timeout,
            )
            if result.returncode != 0:
                raise RuntimeError(f"screencapture -l failed: {result.stderr.decode()}")
            elapsed = (time.time() - start) * 1000

        ss = self._build_screenshot(path, elapsed, window_id=win_id)
        self._build_coordinate_system(ss, app_name)
        self.log.info(f"Window captured: {app_name} (id={win_id}) {ss.width}x{ss.height}")
        return ss

    def _build_coordinate_system(self, ss: Screenshot, app_name: str = "") -> None:
        """截图完成后构建坐标系统。

        Flow:
          1. Quartz 读取主显示器逻辑尺寸
          2. 截图物理尺寸 = ss.width x ss.height
          3. scale = 逻辑宽 / 截图宽
          4. 窗口偏移 = 通过 get_window_info 获取
        """
        logical_w, logical_h = 1440, 900  # fallback
        window_x, window_y = 0, 0
        window_w, window_h = 0, 0
        display_scale = 2.0  # Retina fallback
        shadow_px = 0

        try:
            if self._quartz:
                main_id = self._quartz.CGMainDisplayID()
                bounds = self._quartz.CGDisplayBounds(main_id)
                logical_w = int(bounds.size.width)
                logical_h = int(bounds.size.height)
        except Exception as e:
            self.log.warn(f"Cannot read display info: {e}")

        if app_name:
            try:
                win = self.get_window_info(app_name)
                if win:
                    window_x = win.x
                    window_y = win.y
                    window_w = win.width
                    window_h = win.height
                    # 计算 shadow_px:
                    # screencapture -l 截图包含窗口阴影，截图比窗口内容大
                    # display_scale = 全屏截图物理宽 / 逻辑宽 = 2.0 (Retina)
                    # 内容区物理宽 = window_w × display_scale
                    # shadow_px = (截图宽 - 内容区物理宽) / 2
                    if window_w > 0:
                        content_px_w = int(window_w * display_scale)
                        shadow_px = max(0, (ss.width - content_px_w) // 2)
                        if shadow_px > 0:
                            self.log.debug(
                                f"Window shadow detected: {shadow_px}px each side "
                                f"(screenshot={ss.width} content={content_px_w})"
                            )
            except Exception:
                pass

        self.coords = CoordinateSystem(
            screenshot_w=ss.width,
            screenshot_h=ss.height,
            logical_w=logical_w,
            logical_h=logical_h,
            window_x=window_x,
            window_y=window_y,
            window_w=window_w,
            window_h=window_h,
            shadow_px=shadow_px,
        )
        self.log.debug(f"CoordSystem: {self.coords}")

    def _build_screenshot(self, path: str, elapsed_ms: float,
                          window_id: Optional[int] = None) -> Screenshot:
        """从文件构建 Screenshot 对象。"""
        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(f"Screenshot not found: {path}")
        self._cleanup_old_screenshots()

        width, height = self._get_image_size(path)
        return Screenshot(
            path=str(p.resolve()),
            width=width,
            height=height,
            size_bytes=p.stat().st_size,
            elapsed_ms=elapsed_ms,
            window_id=window_id,
        )

    def _get_image_size(self, path: str) -> tuple[int, int]:
        """获取图片尺寸（无需 Pillow）。"""
        import struct
        with open(path, "rb") as f:
            header = f.read(32)
            if header[:8] == b'\x89PNG\r\n\x1a\n':
                w, h = struct.unpack('>II', header[16:24])
                return w, h
        # fallback: 用 sips
        result = subprocess.run(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
            capture_output=True, text=True, timeout=5,
        )
        w = h = 0
        for line in result.stdout.splitlines():
            if "pixelWidth" in line:
                w = int(line.split(":")[-1].strip())
            elif "pixelHeight" in line:
                h = int(line.split(":")[-1].strip())
        return w, h

    # ─── OCR ─────────────────────────────────────────────────────────────

    def ocr(self, screenshot: Screenshot) -> OCROutput:
        """对截图执行 macOS Vision OCR。"""
        if not self.has_ocr:
            raise RuntimeError("OCR not available — install pyobjc-framework-Vision")

        import Vision
        import Quartz
        from Foundation import NSURL

        with self.log.timer("ocr_recognize"):
            start = time.time()

            # 加载图片
            url = NSURL.fileURLWithPath_(screenshot.path)
            ci_image = Quartz.CIImage.imageWithContentsOfURL_(url)
            if ci_image is None:
                raise RuntimeError(f"Failed to load image: {screenshot.path}")

            handler = Vision.VNImageRequestHandler.alloc().initWithCIImage_options_(ci_image, None)

            # 创建 OCR 请求
            request = Vision.VNRecognizeTextRequest.alloc().init()
            request.setRecognitionLevel_(self.cfg.ocr_recognition_level)
            request.setRecognitionLanguages_(list(self.cfg.ocr_languages))
            request.setUsesLanguageCorrection_(True)

            success, error = handler.performRequests_error_([request], None)
            if not success:
                raise RuntimeError(f"OCR failed: {error}")

            # 解析结果
            results = []
            for observation in request.results():
                candidate = observation.topCandidates_(1)
                if not candidate:
                    continue
                text = candidate[0].string()
                confidence = candidate[0].confidence()
                bbox_ref = observation.boundingBox()
                bbox = BBox(
                    x=bbox_ref.origin.x,
                    y=bbox_ref.origin.y,
                    w=bbox_ref.size.width,
                    h=bbox_ref.size.height,
                )
                results.append(OCRResult(text=text, confidence=confidence, bbox=bbox))

            elapsed = (time.time() - start) * 1000

        self.log.info(f"OCR: {len(results)} texts, {elapsed:.0f}ms")
        return OCROutput(results=results, screenshot=screenshot, elapsed_ms=elapsed)

    # ─── UI 状态解析 ─────────────────────────────────────────────────────

    def read_state(self, app_name: Optional[str] = None) -> ScreenState:
        """视觉优先感知循环:

        截图 → 视觉检测(主) → OCR(辅) → 交叉验证 → ScreenState
                    ↓
              标注截图 (--visual 模式)
        """
        target = app_name or self._find_target_app()
        if target is None:
            return ScreenState(
                cascade_visible=False, state=CascadeState.UNKNOWN,
                input_ready=False, has_dialog=False, has_loading=False,
                has_error=True, error_type="app_not_found",
            )

        # Step 1: 截图
        try:
            ss = self.capture_window(target)
        except Exception as e:
            self.log.error(f"Screenshot failed: {e}")
            return ScreenState(
                cascade_visible=False, state=CascadeState.UNKNOWN,
                input_ready=False, has_dialog=False, has_loading=False,
                has_error=True, error_type="screenshot_failed",
            )

        # Step 2: OCR (定位锚点)
        ocr_output = None
        if self.has_ocr:
            try:
                ocr_output = self.ocr(ss)
            except Exception as e:
                self.log.error(f"OCR failed: {e}")

        # Step 3: 视觉检测 (OCR 锚定 + 像素分类)
        ui_elements = None
        img = None
        try:
            img = Image.open(ss.path).convert("RGB")
            ocr_for_visual = ocr_output.results if ocr_output else None
            with self.log.timer("visual_detect"):
                ui_elements = self.detector.detect_all(
                    img, ocr_results=ocr_for_visual, coords=self.coords,
                )
            method = ui_elements.debug_info.get("detection_method", "?")
            self.log.info(
                f"Visual [{method}]: input_box={'✓' if ui_elements.input_box else '✗'}, "
                f"send={ui_elements.send_state.value}, "
                f"conf={ui_elements.confidence:.0%}",
            )
        except Exception as e:
            self.log.error(f"Visual detection failed: {e}")

        # Step 4: 可视化标注 (--visual 模式)
        if ui_elements and img and (self.cfg.visual_mode or self.annotator.visual_mode):
            try:
                path = self.annotator.annotate_and_show(
                    img, ui_elements, title="detection", with_grid=True,
                )
                self.log.info(f"📸 标注截图: {path}")
            except Exception as e:
                self.log.warn(f"Annotation failed: {e}")

        # Step 5: 获取窗口信息
        window = self.get_window_info(target)

        # Step 6: 交叉验证 → ScreenState
        return self._cross_validate(ui_elements, ocr_output, window, ss)

    def _cross_validate(self, visual: Optional[UIElements],
                        ocr: Optional[OCROutput],
                        window: Optional[WindowInfo],
                        screenshot: Optional[Screenshot] = None) -> ScreenState:
        """交叉验证: 视觉检测(主) + OCR(辅) → ScreenState。

        优先级: visual > OCR
        冲突时: 记录 warning, visual 结果优先
        """
        is_front = window is not None and window.frontmost

        # ── 视觉主判 ─────────────────────────────────────────────────
        visual_state = CascadeState.UNKNOWN
        visual_input_ready = False
        visual_loading = False

        if visual:
            if visual.send_state == SendButtonState.SENDABLE:
                visual_state = CascadeState.READY
                visual_input_ready = True
            elif visual.send_state == SendButtonState.RUNNING:
                visual_state = CascadeState.LOADING
                visual_input_ready = False
                visual_loading = True
            elif visual.send_state == SendButtonState.DISABLED:
                visual_state = CascadeState.READY
                visual_input_ready = visual.input_box is not None

        # ── OCR 辅判 ──────────────────────────────────────────────────
        ocr_state = CascadeState.UNKNOWN
        ocr_input_ready = False
        has_rate_limit = False
        has_quota_error = False
        has_dialog = False
        last_snippet = None

        if ocr:
            full_text = ocr.full_text.lower()
            has_rate_limit = any(kw in full_text for kw in self.cfg.rate_limit_keywords)
            has_quota_error = any(kw in full_text for kw in self.cfg.quota_error_keywords)
            has_dialog = any(kw in full_text for kw in self.cfg.dialog_keywords)
            ocr_has_input = any(kw in full_text for kw in self.cfg.input_box_keywords)
            ocr_has_send = any(kw in full_text for kw in self.cfg.send_button_keywords)

            if has_rate_limit:
                ocr_state = CascadeState.RATE_LIMIT
            elif has_quota_error:
                ocr_state = CascadeState.QUOTA_ERROR
            elif has_dialog:
                ocr_state = CascadeState.DIALOG
            elif ocr_has_input or ocr_has_send:
                ocr_state = CascadeState.READY
                ocr_input_ready = True

            texts = [r.text for r in ocr.results if r.confidence >= 0.4]
            last_snippet = texts[-1] if texts else None

        # ── 交叉验证合并 ─────────────────────────────────────────────
        # OCR 错误信号优先 (rate_limit / quota_error 比视觉更可靠)
        if has_rate_limit:
            final_state = CascadeState.RATE_LIMIT
            error_type = "rate_limit"
        elif has_quota_error:
            final_state = CascadeState.QUOTA_ERROR
            error_type = "quota_exceeded"
        elif visual_state != CascadeState.UNKNOWN:
            # 视觉信号有效 → 用视觉
            final_state = visual_state
            error_type = None
        elif ocr_state != CascadeState.UNKNOWN:
            # 视觉无效 → 降级到 OCR
            final_state = ocr_state
            error_type = None
            self.log.warn("Visual detection unavailable, falling back to OCR")
        else:
            final_state = CascadeState.UNKNOWN
            error_type = None

        # 冲突检测
        if (visual_state != CascadeState.UNKNOWN and ocr_state != CascadeState.UNKNOWN
                and visual_state != ocr_state
                and not has_rate_limit and not has_quota_error):
            self.log.warn(
                f"⚠️ 信号冲突: visual={visual_state.value}, ocr={ocr_state.value} → 使用 visual"
            )

        input_ready = visual_input_ready if visual else ocr_input_ready

        return ScreenState(
            cascade_visible=is_front,
            state=final_state,
            input_ready=input_ready,
            has_dialog=has_dialog,
            has_loading=visual_loading,
            has_error=has_rate_limit or has_quota_error,
            error_type=error_type,
            last_text_snippet=last_snippet,
            ocr_output=ocr,
            window=window,
        )

    # ─── 窗口信息 ────────────────────────────────────────────────────────

    def get_window_info(self, app_name: str) -> Optional[WindowInfo]:
        """获取指定应用的窗口信息。"""
        script = f'''
            tell application "System Events"
                set appProcess to first process whose name contains "{app_name}"
                set frontApp to name of first process whose frontmost is true
                tell appProcess
                    set winPos to position of window 1
                    set winSize to size of window 1
                end tell
            end tell
            set px to item 1 of winPos as text
            set py to item 2 of winPos as text
            set sx to item 1 of winSize as text
            set sy to item 2 of winSize as text
            return px & "|" & py & "|" & sx & "|" & sy & "|" & frontApp
        '''
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True,
                timeout=self.cfg.applescript_timeout,
            )
            if result.returncode != 0:
                self.log.warn(f"AppleScript error: {result.stderr.strip()}")
                return None

            parts = [p.strip() for p in result.stdout.strip().split("|")]
            if len(parts) >= 5:
                x, y = int(parts[0]), int(parts[1])
                w, h = int(parts[2]), int(parts[3])
                front_app = "|".join(parts[4:]).strip()
                is_front = app_name.lower() in front_app.lower()
                win_id = self._get_window_id(app_name)
                return WindowInfo(
                    app_name=app_name, x=x, y=y, width=w, height=h,
                    window_id=win_id, frontmost=is_front,
                )
        except Exception as e:
            self.log.error(f"get_window_info failed: {e}")
        return None

    def get_coordinate_scale(self, screenshot: Screenshot,
                             window: Optional[WindowInfo] = None) -> float:
        """计算截图像素 → 屏幕逻辑坐标的缩放比。"""
        if window is not None and window.width > 0:
            return window.width / screenshot.width
        return 1.0 / self.cfg.retina_scale_fallback

    # ─── 内部工具 ────────────────────────────────────────────────────────

    def _find_target_app(self) -> Optional[str]:
        """查找正在运行的目标应用（通过 System Events 检测）。"""
        for name in self.cfg.app_names:
            try:
                result = subprocess.run(
                    ["osascript", "-e",
                     f'tell application "System Events" to return (exists process "{name}")'],
                    capture_output=True, text=True, timeout=3,
                )
                if result.returncode == 0 and "true" in result.stdout.strip().lower():
                    self.log.debug(f"Found target app: {name}")
                    return name
            except Exception:
                continue
        # fallback: pgrep 模糊匹配
        for name in self.cfg.app_names:
            try:
                result = subprocess.run(
                    ["pgrep", "-i", "-l", name], capture_output=True, timeout=3,
                )
                if result.returncode == 0:
                    self.log.debug(f"Found target app (pgrep): {name}")
                    return name
            except Exception:
                continue
        self.log.warn("No target app found")
        return None

    def _cleanup_old_screenshots(self):
        """保留最新 N 张截图，删除旧的。"""
        try:
            pngs = sorted(self.cfg.screenshot_dir.glob("*.png"), key=lambda p: p.stat().st_mtime)
            if len(pngs) > self.cfg.max_screenshots:
                for old in pngs[:len(pngs) - self.cfg.max_screenshots]:
                    old.unlink()
        except Exception:
            pass

    def _get_window_id(self, app_name: str) -> Optional[int]:
        """获取窗口 ID (优先 Quartz API, fallback AppleScript)。"""
        # 方案 A: Quartz CGWindowListCopyWindowInfo (spike_03 验证可靠)
        if self._quartz:
            try:
                windows = self._quartz.CGWindowListCopyWindowInfo(
                    self._quartz.kCGWindowListOptionOnScreenOnly,
                    self._quartz.kCGNullWindowID,
                )
                for w in windows:
                    owner = str(w.get("kCGWindowOwnerName", ""))
                    layer = w.get("kCGWindowLayer", 999)
                    if app_name.lower() in owner.lower() and layer == 0:
                        wid = w.get("kCGWindowNumber")
                        if wid:
                            self.log.debug(f"Window ID via Quartz: {wid} ({owner})")
                            return int(wid)
            except Exception as e:
                self.log.debug(f"Quartz window ID failed: {e}")

        # 方案 B: AppleScript fallback
        script = f'''
            tell application "System Events"
                tell process "{app_name}"
                    set winId to id of window 1
                end tell
            end tell
            return winId as text
        '''
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=3,
            )
            if result.returncode == 0 and result.stdout.strip():
                wid = int(result.stdout.strip())
                self.log.debug(f"Window ID via AppleScript: {wid}")
                return wid
        except Exception as e:
            self.log.debug(f"AppleScript window ID failed: {e}")
        return None
