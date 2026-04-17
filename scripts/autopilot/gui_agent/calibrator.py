"""标定模块 — 用户交互选区 + 坐标验证 + 配置持久化。

流程:
  1. 截图 Windsurf 窗口 (全屏背景)
  2. tkinter 全屏半透明覆盖层, 用户拖拽选 INPUT 区域
  3. 用户再拖拽选 SEND BUTTON 区域
  4. 系统计算: 屏幕逻辑坐标 + 截图像素坐标 + scale
  5. 生成标注截图验证坐标准确性
  6. 用户终端确认 → 写入 calibration.json
  7. 后续运行自动加载标定坐标

标定数据格式 (calibration.json):
  {
    "screenshot_w": 3104, "screenshot_h": 1834,
    "logical_w": 1440, "logical_h": 900,
    "scale": 0.464,
    "input_box": {"px_x":105,"px_y":1484,"px_w":700,"px_h":60,
                  "lx":50,"ly":710},
    "send_button": {"px_x":780,"px_y":1490,"px_w":40,"px_h":40,
                    "lx":362,"ly":692},
    "calibrated_at": "2026-04-14T02:48:00"
  }
"""

from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

from .models import CoordinateSystem
from .visual import Region


CALIBRATION_PATH = Path.home() / ".quote-autopilot" / "gui-agent" / "calibration.json"


@dataclass
class CalibrationRegion:
    """标定区域 — 同时存储截图像素坐标和屏幕逻辑坐标。"""
    px_x: int    # 截图像素 x
    px_y: int    # 截图像素 y
    px_w: int    # 截图像素宽
    px_h: int    # 截图像素高
    lx: int      # 屏幕逻辑 x (用于点击)
    ly: int      # 屏幕逻辑 y (用于点击)

    @property
    def click_center_logical(self) -> tuple[int, int]:
        return self.lx + self.lx * 0 // 1, self.ly  # 已是中心点

    def to_region(self) -> Region:
        return Region(x=self.px_x, y=self.px_y, w=self.px_w, h=self.px_h)

    def to_dict(self) -> dict:
        return {"px_x": self.px_x, "px_y": self.px_y,
                "px_w": self.px_w, "px_h": self.px_h,
                "lx": self.lx, "ly": self.ly}

    @classmethod
    def from_dict(cls, d: dict) -> "CalibrationRegion":
        return cls(**d)


@dataclass
class Calibration:
    """完整标定数据。"""
    screenshot_w: int
    screenshot_h: int
    logical_w: int
    logical_h: int
    scale: float
    input_box: CalibrationRegion
    send_button: CalibrationRegion
    calibrated_at: str = ""

    def to_coordinate_system(self) -> CoordinateSystem:
        return CoordinateSystem(
            screenshot_w=self.screenshot_w,
            screenshot_h=self.screenshot_h,
            logical_w=self.logical_w,
            logical_h=self.logical_h,
        )

    def to_dict(self) -> dict:
        return {
            "screenshot_w": self.screenshot_w,
            "screenshot_h": self.screenshot_h,
            "logical_w": self.logical_w,
            "logical_h": self.logical_h,
            "scale": round(self.scale, 4),
            "input_box": self.input_box.to_dict(),
            "send_button": self.send_button.to_dict(),
            "calibrated_at": self.calibrated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Calibration":
        return cls(
            screenshot_w=d["screenshot_w"],
            screenshot_h=d["screenshot_h"],
            logical_w=d["logical_w"],
            logical_h=d["logical_h"],
            scale=d["scale"],
            input_box=CalibrationRegion.from_dict(d["input_box"]),
            send_button=CalibrationRegion.from_dict(d["send_button"]),
            calibrated_at=d.get("calibrated_at", ""),
        )


def load_calibration() -> Optional[Calibration]:
    """加载已有标定数据，不存在返回 None。"""
    if not CALIBRATION_PATH.exists():
        return None
    try:
        with open(CALIBRATION_PATH) as f:
            return Calibration.from_dict(json.load(f))
    except Exception:
        return None


def save_calibration(cal: Calibration) -> None:
    CALIBRATION_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CALIBRATION_PATH, "w") as f:
        json.dump(cal.to_dict(), f, indent=2, ensure_ascii=False)


class Calibrator:
    """交互式标定工具。"""

    def __init__(self, screenshot_path: str, coords: CoordinateSystem):
        self.screenshot_path = screenshot_path
        self.coords = coords
        self._selected_regions: list[tuple[int, int, int, int]] = []  # 截图像素坐标

    def run_interactive(self) -> Optional[Calibration]:
        """交互式标定：用 screencapture -i -s 直接框选区域，Quartz 记录选区位置。

        流程:
          1. 用户在屏幕上用鼠标拖拽框选目标区域（屏幕变暗，选中区域高亮）
          2. 松开鼠标后，用 Quartz 的 kCGWindowImageBoundsIgnoreFraming 读取
             选区的屏幕逻辑坐标
          3. 换算到窗口截图的像素坐标

        坐标换算（修正 shadow）:
          选区逻辑坐标 (lx, ly) → 截图像素 (px_x, px_y)
          px_x = (lx - window_x) × display_scale + shadow_px
          px_y = (ly - window_y) × display_scale + shadow_px
        """
        try:
            import Quartz
        except ImportError:
            print("❌ Quartz 不可用")
            return None

        ds = self.coords.display_scale if self.coords.display_scale > 0 else 2.0
        shadow = self.coords.shadow_px

        print("\n" + "="*60)
        print("🎯 GUI Agent 标定模式")
        print("="*60)
        print(f"📐 显示器: 逻辑 {self.coords.logical_w}×{self.coords.logical_h}")
        print(f"📸 截图:   物理 {self.coords.screenshot_w}×{self.coords.screenshot_h}")
        print(f"🔍 Display scale: {ds:.1f}x  Shadow: {shadow}px")
        print()
        print("操作方式：")
        print("  屏幕会变暗，用鼠标直接拖拽框选目标区域（像截图一样框选）")
        print("  松开后自动记录坐标，无需按 Enter")
        print()

        def capture_region(name: str, hint: str) -> Optional[tuple[int, int, int, int]]:
            """用 screencapture -i -s 框选 + Quartz Event Tap 捕获鼠标按下/松开坐标。

            在 screencapture 运行期间，后台用 CGEventTap 监听 mouseDown/mouseUp，
            精确捕获框选的两个角坐标（逻辑坐标），不需要用户额外操作。
            """
            import subprocess, threading, time

            print(f"── {name} ──")
            print(f"  💡 {hint}")
            print(f"  ⌛ 1 秒后屏幕变暗，直接拖拽框选目标区域，松开即完成...")
            time.sleep(1)

            # 用 Quartz Event Tap 在后台监听鼠标按下/松开
            mouse_down_pt: list = []
            mouse_up_pt: list = []
            tap_done = threading.Event()

            def run_event_tap():
                import Quartz as Q

                def handler(proxy, type_, event, refcon):
                    pt = Q.CGEventGetLocation(event)
                    lx, ly = int(pt.x), int(pt.y)
                    if type_ == Q.kCGEventLeftMouseDown:
                        mouse_down_pt.clear()
                        mouse_down_pt.append((lx, ly))
                    elif type_ == Q.kCGEventLeftMouseUp:
                        mouse_up_pt.clear()
                        mouse_up_pt.append((lx, ly))
                        tap_done.set()
                    return event

                mask = (
                    (1 << Q.kCGEventLeftMouseDown) |
                    (1 << Q.kCGEventLeftMouseUp)
                )
                tap = Q.CGEventTapCreate(
                    Q.kCGSessionEventTap,
                    Q.kCGHeadInsertEventTap,
                    Q.kCGEventTapOptionListenOnly,
                    mask,
                    handler,
                    None,
                )
                if not tap:
                    return
                loop_src = Q.CFMachPortCreateRunLoopSource(None, tap, 0)
                loop = Q.CFRunLoopGetCurrent()
                Q.CFRunLoopAddSource(loop, loop_src, Q.kCFRunLoopCommonModes)
                Q.CGEventTapEnable(tap, True)
                # 运行 runloop 直到 tap_done
                import CoreFoundation as CF
                while not tap_done.is_set():
                    CF.CFRunLoopRunInMode(Q.kCFRunLoopDefaultMode, 0.1, False)
                Q.CFRunLoopRemoveSource(loop, loop_src, Q.kCFRunLoopCommonModes)

            tap_thread = threading.Thread(target=run_event_tap, daemon=True)
            tap_thread.start()

            # 运行 screencapture -i -s (会阻塞直到用户完成框选)
            crop_path = f"/tmp/_cal_crop_{name.replace(' ','_')}.png"
            result = subprocess.run(
                ["screencapture", "-i", "-s", crop_path],
                capture_output=True,
            )
            tap_done.set()
            tap_thread.join(timeout=1.0)

            if result.returncode != 0 or not Path(crop_path).exists():
                print(f"  ❌ 框选取消或失败")
                return None

            if not mouse_down_pt or not mouse_up_pt:
                print(f"  ❌ 未能捕获鼠标坐标，请重试")
                return None

            # 从两个角坐标计算选区（处理任意方向的拖拽）
            x1, y1 = mouse_down_pt[0]
            x2, y2 = mouse_up_pt[0]
            tl_lx = min(x1, x2)
            tl_ly = min(y1, y2)
            logic_w = abs(x2 - x1)
            logic_h = abs(y2 - y1)

            # 换算：逻辑坐标 → 截图像素（含 shadow 补偿）
            px_x = int((tl_lx - self.coords.window_x) * ds) + shadow
            px_y = int((tl_ly - self.coords.window_y) * ds) + shadow
            px_w = int(logic_w * ds)
            px_h = int(logic_h * ds)

            print(f"  ✅ {name}: 逻辑({tl_lx},{tl_ly} w={logic_w} h={logic_h})"
                  f" → 截图像素({px_x},{px_y} w={px_w} h={px_h})")
            Path(crop_path).unlink(missing_ok=True)
            return px_x, px_y, px_w, px_h

        regions = []
        specs = [
            ("INPUT 输入框", "框选 Cascade 聊天输入框（底部横条）"),
            ("SEND 发送按钮", "框选发送按钮（↑ 箭头图标）"),
        ]

        for name, hint in specs:
            r = capture_region(name, hint)
            if r is None:
                return None
            regions.append(r)
            print()

        # 构建 CalibrationRegion
        def build_region(px_x, px_y, px_w, px_h) -> CalibrationRegion:
            cx_px = px_x + px_w // 2
            cy_px = px_y + px_h // 2
            lx, ly = self.coords.pixel_to_logical(cx_px, cy_px)
            return CalibrationRegion(
                px_x=px_x, px_y=px_y, px_w=px_w, px_h=px_h,
                lx=lx, ly=ly,
            )

        input_reg = build_region(*regions[0])
        send_reg = build_region(*regions[1])

        cal = Calibration(
            screenshot_w=self.coords.screenshot_w,
            screenshot_h=self.coords.screenshot_h,
            logical_w=self.coords.logical_w,
            logical_h=self.coords.logical_h,
            scale=self.coords.scale,
            input_box=input_reg,
            send_button=send_reg,
            calibrated_at=datetime.now().isoformat(timespec="seconds"),
        )

        return cal

    def _find_position(self, full: Image.Image, crop: Image.Image) -> tuple[int, int]:
        """在 full 中用模板匹配定位 crop 的左上角像素坐标。

        原理: 滑动窗口比对像素差，找最小误差位置。
        为了速度，先缩小 4x 做粗定位，再在附近精确匹配。
        """
        import numpy as np

        fw, fh = full.size
        cw, ch = crop.size

        if cw > fw or ch > fh:
            return -1, -1

        # screencapture -i -s 截出的是物理像素，但坐标系是屏幕逻辑像素
        # 选区会是 scale 倍大，需要将 crop 缩放到与 full 同一分辨率
        # full 是窗口物理截图 (retina)，crop 是 screencapture 全屏物理截图
        # 两者都是物理像素，可以直接匹配

        scale_hint = 4
        full_small = full.resize((fw // scale_hint, fh // scale_hint), Image.BOX)
        crop_small = crop.resize((cw // scale_hint, ch // scale_hint), Image.BOX)

        fa = np.array(full_small, dtype=np.int32)
        ca = np.array(crop_small, dtype=np.int32)
        csw, csh = crop_small.size

        best_score = float("inf")
        best_x = best_y = 0

        step = 2
        for y in range(0, fa.shape[0] - csh, step):
            for x in range(0, fa.shape[1] - csw, step):
                patch = fa[y:y+csh, x:x+csw]
                score = float(np.mean(np.abs(patch - ca)))
                if score < best_score:
                    best_score = score
                    best_x, best_y = x, y

        # 粗定位结果反推全尺寸坐标
        rx = best_x * scale_hint
        ry = best_y * scale_hint

        # 精确匹配: 在粗定位附近 ±scale_hint*2 范围内搜索
        margin = scale_hint * 3
        fa2 = np.array(full, dtype=np.int32)
        ca2 = np.array(crop, dtype=np.int32)

        x_start = max(0, rx - margin)
        y_start = max(0, ry - margin)
        x_end = min(fw - cw, rx + margin)
        y_end = min(fh - ch, ry + margin)

        for y in range(y_start, y_end + 1):
            for x in range(x_start, x_end + 1):
                patch = fa2[y:y+ch, x:x+cw]
                if patch.shape != ca2.shape:
                    continue
                score = float(np.mean(np.abs(patch - ca2)))
                if score < best_score:
                    best_score = score
                    rx, ry = x, y

        return rx, ry

    def generate_verification_image(self, cal: Calibration) -> str:
        """生成带红框标注的验证截图，供用户肉眼确认。"""
        img = Image.open(self.screenshot_path).convert("RGB")
        draw = ImageDraw.Draw(img)

        try:
            font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 20)
            font_small = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 14)
        except Exception:
            font = font_small = ImageFont.load_default()

        def draw_box(region: CalibrationRegion, label: str, color: tuple):
            r = region
            for i in range(3):
                draw.rectangle(
                    [r.px_x - i, r.px_y - i, r.px_x + r.px_w + i, r.px_y + r.px_h + i],
                    outline=color,
                )
            # 标签背景
            draw.rectangle([r.px_x, r.px_y - 26, r.px_x + len(label) * 11, r.px_y],
                           fill=color)
            draw.text((r.px_x + 4, r.px_y - 24), label, fill=(0, 0, 0), font=font)
            # 中心十字
            cx, cy = r.px_x + r.px_w // 2, r.px_y + r.px_h // 2
            draw.line([(cx - 15, cy), (cx + 15, cy)], fill=color, width=2)
            draw.line([(cx, cy - 15), (cx, cy + 15)], fill=color, width=2)
            # 逻辑坐标标注
            draw.text((r.px_x + 4, r.px_y + r.px_h + 4),
                      f"click=({r.lx},{r.ly})", fill=color, font=font_small)

        draw_box(cal.input_box, "INPUT_BOX", (255, 50, 50))
        draw_box(cal.send_button, "SEND_BTN", (50, 200, 50))

        # 顶部信息栏
        info = (f"scale={cal.scale:.4f}x  "
                f"screenshot={cal.screenshot_w}×{cal.screenshot_h}  "
                f"logical={cal.logical_w}×{cal.logical_h}")
        draw.rectangle([0, 0, img.width, 30], fill=(0, 0, 0, 180))
        draw.text((8, 6), info, fill=(255, 255, 0), font=font_small)

        out_path = str(Path.home() / ".quote-autopilot" / "gui-agent" / "calibration_verify.png")
        img.save(out_path)
        return out_path


def run_calibration(perception) -> Optional[Calibration]:
    """主标定流程 — 在 coordinator/CLI 中调用。

    Args:
        perception: Perception 实例 (已截图, coords 已构建)

    Returns:
        Calibration 或 None (用户取消)
    """
    # 确保有最新截图和坐标系
    target = perception._find_target_app()
    if not target:
        print("❌ 找不到目标应用")
        return None

    print(f"\n📸 正在截取 {target} 窗口...")
    ss = perception.capture_window(target)

    if not perception.coords:
        print("❌ 坐标系初始化失败")
        return None

    calibrator = Calibrator(ss.path, perception.coords)
    cal = calibrator.run_interactive()
    if not cal:
        return None

    # 打印计算结果
    print("\n" + "="*60)
    print("📊 标定结果计算")
    print("="*60)
    print(f"  Scale 因子:  {cal.scale:.4f}x  (截图像素 × {cal.scale:.4f} = 屏幕逻辑坐标)")
    print(f"\n  INPUT 区域:")
    print(f"    截图像素: ({cal.input_box.px_x}, {cal.input_box.px_y}, "
          f"w={cal.input_box.px_w}, h={cal.input_box.px_h})")
    print(f"    点击坐标: ({cal.input_box.lx}, {cal.input_box.ly})  ← 逻辑坐标")
    print(f"\n  SEND 按钮:")
    print(f"    截图像素: ({cal.send_button.px_x}, {cal.send_button.px_y}, "
          f"w={cal.send_button.px_w}, h={cal.send_button.px_h})")
    print(f"    点击坐标: ({cal.send_button.lx}, {cal.send_button.ly})  ← 逻辑坐标")

    # 生成验证截图
    print("\n🖼  生成验证截图...")
    verify_path = calibrator.generate_verification_image(cal)
    print(f"  标注截图: {verify_path}")

    # 打开预览
    subprocess.Popen(["open", "-a", "Preview", verify_path])
    print("\n✅ Preview 已打开标注截图，请检查红框是否准确覆盖了 INPUT 和 SEND 区域")
    print()

    # 用户确认
    while True:
        ans = input("确认标定正确？[y/n/r(重新标定)]: ").strip().lower()
        if ans == "y":
            save_calibration(cal)
            print(f"\n✅ 标定已保存: {CALIBRATION_PATH}")
            print("   后续 send 命令将直接使用标定坐标精确点击")
            return cal
        elif ans == "n":
            print("❌ 标定取消")
            return None
        elif ans == "r":
            print("🔄 重新标定...")
            return run_calibration(perception)
        else:
            print("请输入 y / n / r")
