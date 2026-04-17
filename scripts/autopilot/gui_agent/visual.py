"""视觉检测层 — 像素级 UI 元素发现与状态分类。

职责 (视觉优先管线的核心):
  - 自适应检测输入框区域 (底部扫描, 边框色差)
  - 检测发送按钮位置与状态 (HSV 色相分类)
  - 三种按钮状态: SENDABLE / RUNNING / DISABLED
  - 不依赖 OCR, 不依赖校准缓存, 每次运行自适应

技术:
  - PIL/Pillow 像素操作
  - HSV 色彩空间分析
  - 区域扫描 + 色差阈值
"""

from __future__ import annotations

import colorsys
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from PIL import Image


# ─── 数据模型 ─────────────────────────────────────────────────────────────

class SendButtonState(Enum):
    SENDABLE = "sendable"    # ↑ 箭头, 紫/蓝色
    RUNNING = "running"      # ■ 方块, 停止按钮
    DISABLED = "disabled"    # 灰色, 不可用
    UNKNOWN = "unknown"


@dataclass
class Region:
    """矩形区域 (像素坐标, 原点左上)。"""
    x: int
    y: int
    w: int
    h: int

    @property
    def center(self) -> tuple[int, int]:
        return self.x + self.w // 2, self.y + self.h // 2

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h

    def contains(self, px: int, py: int) -> bool:
        return self.x <= px < self.right and self.y <= py < self.bottom


@dataclass
class UIElements:
    """一次检测的全部 UI 元素。"""
    input_box: Optional[Region] = None
    send_button: Optional[Region] = None
    send_state: SendButtonState = SendButtonState.UNKNOWN
    toolbar_region: Optional[Region] = None
    confidence: float = 0.0
    debug_info: dict = None

    def __post_init__(self):
        if self.debug_info is None:
            self.debug_info = {}

    @property
    def is_ready(self) -> bool:
        return self.send_state == SendButtonState.SENDABLE

    @property
    def is_running(self) -> bool:
        return self.send_state == SendButtonState.RUNNING

    def to_json(self) -> dict:
        return {
            "input_box": {"x": self.input_box.x, "y": self.input_box.y,
                          "w": self.input_box.w, "h": self.input_box.h} if self.input_box else None,
            "send_button": {"x": self.send_button.x, "y": self.send_button.y,
                            "w": self.send_button.w, "h": self.send_button.h} if self.send_button else None,
            "send_state": self.send_state.value,
            "confidence": round(self.confidence, 3),
        }


# ─── 颜色分析 ────────────────────────────────────────────────────────────

class ColorAnalyzer:
    """HSV 色彩空间分析工具。"""

    @staticmethod
    def rgb_to_hsv(r: int, g: int, b: int) -> tuple[float, float, float]:
        """RGB (0-255) → HSV (H: 0-360, S: 0-1, V: 0-1)。"""
        h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        return h * 360, s, v

    @staticmethod
    def is_purple_blue(r: int, g: int, b: int, min_sat: float = 0.25) -> bool:
        """判断颜色是否为紫/蓝色调 (发送按钮的标志色)。"""
        h, s, v = ColorAnalyzer.rgb_to_hsv(r, g, b)
        return 200 <= h <= 300 and s >= min_sat and v >= 0.3

    @staticmethod
    def is_bright(r: int, g: int, b: int, threshold: float = 0.7) -> bool:
        """判断是否为亮色 (白色/浅色, 可能是停止按钮图标)。"""
        _, _, v = ColorAnalyzer.rgb_to_hsv(r, g, b)
        return v >= threshold

    @staticmethod
    def is_dark_bg(r: int, g: int, b: int) -> bool:
        """判断是否为深色背景 (Cascade 的暗色主题)。"""
        _, s, v = ColorAnalyzer.rgb_to_hsv(r, g, b)
        return v < 0.35 and s < 0.3

    @staticmethod
    def color_distance(c1: tuple[int, int, int], c2: tuple[int, int, int]) -> float:
        """欧氏色差。"""
        return sum((a - b) ** 2 for a, b in zip(c1, c2)) ** 0.5

    @staticmethod
    def dominant_color(img: Image.Image, region: Region, sample_step: int = 2) -> tuple[int, int, int]:
        """采样区域内的主导颜色 (排除深色背景)。"""
        colors = {}
        for y in range(region.y, min(region.bottom, img.height), sample_step):
            for x in range(region.x, min(region.right, img.width), sample_step):
                r, g, b = img.getpixel((x, y))[:3]
                if not ColorAnalyzer.is_dark_bg(r, g, b):
                    # 量化到 8 级减少碎片
                    key = (r // 32 * 32, g // 32 * 32, b // 32 * 32)
                    colors[key] = colors.get(key, 0) + 1
        if not colors:
            return (0, 0, 0)
        return max(colors, key=colors.get)


# ─── UI 检测器 ────────────────────────────────────────────────────────────

class UIDetector:
    """自适应 UI 元素检测器 — 按钮优先, 全图扫描。

    检测策略 (不假设 Cascade 面板位置):
      1. 全图扫描紫蓝色像素集群 → 定位发送按钮 (SENDABLE)
      2. 若无紫蓝, 扫描停止按钮特征 → RUNNING
      3. 以按钮位置为锚点, 反推输入框区域
    """

    # 调参常量
    SCAN_STEP = 3             # 像素扫描步长 (越小越精确, 越慢)
    MIN_CLUSTER_SIZE = 8      # 最少彩色像素数构成按钮 (step=3 下约 8 个)
    CLUSTER_RADIUS = 20       # 聚类半径 — 按钮很小, 约 30px 直径
    BTN_MIN_SIZE = 10         # 按钮最小尺寸 (px)
    BTN_MAX_SIZE = 80         # 按钮最大尺寸 (px)
    BTN_MAX_ASPECT = 2.5      # 最大宽高比 (>此值 = 不是圆形按钮, 是文字)
    INPUT_BOX_PAD_UP = 5      # 从按钮向上扩展
    INPUT_BOX_PAD_DOWN = 40   # 从按钮向下扩展

    def __init__(self):
        self.color = ColorAnalyzer()

    def detect_all(self, img: Image.Image, ocr_results: list = None,
                   coords=None) -> UIElements:
        """执行完整 UI 检测。

        策略: OCR 定位 → 视觉分类
          1. OCR 找到 "Ask anything" 等锚点文字 → 定位输入区域
          2. 在锚定区域右侧做像素分析 → 判断按钮状态

        Args:
            coords: CoordinateSystem 实例，用于精确坐标转换
        """
        debug = {}
        img_rgb = img.convert("RGB")
        w, h = img_rgb.size
        debug["image_size"] = (w, h)
        if coords:
            debug["coord_system"] = f"scale={coords.scale:.3f}x"

        # 策略 A: OCR 锚定 (高精度)
        if ocr_results:
            anchor = self._find_anchor_by_ocr(ocr_results, w, h, debug, coords=coords)
            if anchor:
                input_box = anchor
                send_btn, send_state = self._detect_button_in_region(
                    img_rgb, anchor, debug,
                )
                confidence = self._calc_confidence(input_box, send_btn, send_state)
                debug["detection_method"] = "ocr_anchored"
                return UIElements(
                    input_box=input_box, send_button=send_btn,
                    send_state=send_state, confidence=confidence,
                    debug_info=debug,
                )

        # OCR 找不到锚点 = Cascade 面板不可见 → 直接报告 UNKNOWN
        # 不启用全图扫描 fallback (假阳性太多)
        debug["detection_method"] = "ocr_anchor_not_found"
        return UIElements(
            input_box=None, send_button=None,
            send_state=SendButtonState.UNKNOWN, confidence=0.0,
            debug_info=debug,
        )

    # ─── OCR 锚定检测 (高精度) ─────────────────────────────────────

    # 锚点关键词 (Cascade 输入区域独有的文字)
    ANCHOR_KEYWORDS = [
        "ask anything",
        "ask a follow",
        "type a message",
        "type your message",
    ]
    # 工具栏关键词 (输入框下方)
    TOOLBAR_KEYWORDS = ["code", "thinking", "opus", "sonnet", "claude"]

    def _find_anchor_by_ocr(self, ocr_results: list, img_w: int, img_h: int,
                             debug: dict, coords=None) -> Optional[Region]:
        """用 OCR 结果定位 Cascade 输入区域。

        坐标转换规则 (统一用 CoordinateSystem):
          - OCR BBox = Vision 归一化 (原点左下), y 轴翻转
          - 优先用 coords.ocr_result_to_pixel() 转换
          - fallback: 用 BBox.to_pixels(img_w, img_h)
        """
        for result in ocr_results:
            text_lower = result.text.lower() if hasattr(result, 'text') else str(result).lower()
            for keyword in self.ANCHOR_KEYWORDS:
                if keyword in text_lower:
                    if hasattr(result, 'bbox') and result.bbox:
                        bbox = result.bbox
                        # 坐标转换: CoordinateSystem 优先
                        if coords is not None:
                            px = coords.ocr_result_to_pixel(bbox)
                        else:
                            px = bbox.to_pixels(img_w, img_h)

                        # 输入框区域: 锚点文字向右延伸覆盖发送按钮
                        region = Region(
                            x=max(0, px.x - 30),
                            y=max(0, px.y - 15),
                            w=min(img_w - px.x + 30, px.w + 650),
                            h=px.h + 60,
                        )
                        debug["anchor"] = {
                            "keyword": keyword,
                            "text": result.text if hasattr(result, 'text') else str(result),
                            "norm_bbox": f"({bbox.x:.3f},{bbox.y:.3f},{bbox.w:.3f},{bbox.h:.3f})",
                            "pixel_bbox": f"({px.x},{px.y},{px.w},{px.h})",
                            "region": f"({region.x},{region.y},{region.w},{region.h})",
                            "coord_via": "CoordinateSystem" if coords else "BBox.to_pixels",
                        }
                        return region
        debug["anchor"] = "not_found"
        return None

    def _detect_button_in_region(self, img: Image.Image, anchor: Region,
                                 debug: dict) -> tuple[Optional[Region], SendButtonState]:
        """在锚定区域的右侧检测发送按钮状态。

        发送按钮在输入框右侧末尾, 是一个小圆形图标。
        """
        w, h = img.size

        # 扫描区域: 锚点区域的右侧 150px 范围
        scan_x_start = max(0, anchor.right - 150)
        scan_x_end = min(w, anchor.right + 30)
        scan_y_start = max(0, anchor.y)
        scan_y_end = min(h, anchor.bottom + 20)

        purple_count = 0
        bright_count = 0
        purple_px = []
        bright_px = []

        for y in range(scan_y_start, scan_y_end, 2):
            for x in range(scan_x_start, scan_x_end, 2):
                if x >= w or y >= h:
                    continue
                r, g, b = img.getpixel((x, y))[:3]

                if self.color.is_dark_bg(r, g, b):
                    continue

                if self.color.is_purple_blue(r, g, b):
                    purple_count += 1
                    purple_px.append((x, y))
                elif self.color.is_bright(r, g, b, threshold=0.7):
                    bright_count += 1
                    bright_px.append((x, y))

        debug["btn_region_scan"] = {
            "area": f"({scan_x_start},{scan_y_start})-({scan_x_end},{scan_y_end})",
            "purple_count": purple_count,
            "bright_count": bright_count,
        }

        # 在这个小区域内, 阈值可以很低 (因为区域已经很精确)
        btn_region = None
        state = SendButtonState.UNKNOWN

        if purple_count >= 5:
            state = SendButtonState.SENDABLE
            btn_region = self._pixels_to_region(purple_px)
        elif bright_count >= 3:
            # 检查亮色像素是否紧凑 (停止按钮 ■)
            if bright_px:
                region = self._pixels_to_region(bright_px)
                if region.w < 60 and region.h < 60:
                    state = SendButtonState.RUNNING
                    btn_region = region
        if state == SendButtonState.UNKNOWN:
            state = SendButtonState.DISABLED

        return btn_region, state

    # ─── 全图像素扫描 ─────────────────────────────────────────────

    def _scan_feature_pixels(self, img: Image.Image,
                             debug: dict) -> tuple[list, list, list]:
        """扫描全图, 收集三类特征像素坐标。

        Returns:
            (紫蓝色像素, 亮色像素, 中饱和度像素)
        """
        w, h = img.size
        step = self.SCAN_STEP
        purple_px = []   # 紫蓝色 (发送按钮特征)
        bright_px = []   # 亮色/白色 (停止按钮图标)
        mid_sat_px = []  # 中等饱和度 (可能是 disabled 按钮)

        # 只扫描下半部分 (输入框不会在窗口上半部)
        y_start = h // 2

        for y in range(y_start, h, step):
            for x in range(0, w, step):
                r, g, b = img.getpixel((x, y))[:3]

                if self.color.is_dark_bg(r, g, b):
                    continue

                if self.color.is_purple_blue(r, g, b):
                    purple_px.append((x, y))
                elif self.color.is_bright(r, g, b, threshold=0.75):
                    bright_px.append((x, y))
                else:
                    hsv = self.color.rgb_to_hsv(r, g, b)
                    if 0.15 < hsv[1] < 0.5 and hsv[2] > 0.3:
                        mid_sat_px.append((x, y))

        debug["scan_pixels"] = {
            "purple_blue": len(purple_px),
            "bright": len(bright_px),
            "mid_sat": len(mid_sat_px),
            "y_start": y_start,
        }
        return purple_px, bright_px, mid_sat_px

    # ─── 按钮发现 (聚类) ──────────────────────────────────────────

    def _find_send_button(self, purple_px: list, bright_px: list,
                          mid_sat_px: list,
                          debug: dict) -> tuple[Optional[Region], SendButtonState]:
        """从特征像素中聚类找到发送按钮。

        关键过滤: 按钮是圆形/方形小图标, 不是代码语法高亮:
          - 宽高比 < 2.5 (排除长条文字)
          - 尺寸 10-80px (排除大面积)
          - 优先选最底部的候选 (输入框在底部)
        """

        # 尝试 1: 紫蓝色集群 → SENDABLE
        region = self._find_button_cluster(purple_px, debug, "purple_blue")
        if region:
            return region, SendButtonState.SENDABLE

        # 尝试 2: 亮色集群 → RUNNING (停止按钮)
        region = self._find_button_cluster(bright_px, debug, "bright_stop")
        if region:
            return region, SendButtonState.RUNNING

        # 尝试 3: 中饱和度 → DISABLED
        region = self._find_button_cluster(mid_sat_px, debug, "mid_sat")
        if region:
            return region, SendButtonState.DISABLED

        debug["send_btn"] = {"method": "none_found"}
        return None, SendButtonState.UNKNOWN

    def _find_button_cluster(self, pixels: list, debug: dict,
                             label: str) -> Optional[Region]:
        """从像素列表中找所有紧凑集群, 过滤形状, 选最底部的。"""
        clusters = self._find_all_clusters(pixels)
        candidates = []

        for cluster in clusters:
            if len(cluster) < self.MIN_CLUSTER_SIZE:
                continue
            region = self._pixels_to_region(cluster)
            # 形状过滤
            if region.w < self.BTN_MIN_SIZE or region.h < self.BTN_MIN_SIZE:
                continue
            if region.w > self.BTN_MAX_SIZE or region.h > self.BTN_MAX_SIZE:
                continue
            aspect = max(region.w, region.h) / max(1, min(region.w, region.h))
            if aspect > self.BTN_MAX_ASPECT:
                continue
            # 像素密度: 集群像素 / 区域面积 (排除稀疏分布的代码文字)
            area = max(1, region.w * region.h)
            # step=3 时, 密度需要 ÷9 校正
            density = len(cluster) * (self.SCAN_STEP ** 2) / area
            if density < 0.08:  # 最少 8% 填充率
                continue
            candidates.append((region, cluster, density))

        if not candidates:
            return None

        # 选最底部的候选 (输入框/按钮在面板底部)
        best = max(candidates, key=lambda c: c[0].bottom)
        debug["send_btn"] = {
            "method": label,
            "pixels": len(best[1]),
            "region": f"({best[0].x},{best[0].y},{best[0].w},{best[0].h})",
            "density": round(best[2], 3),
            "candidates": len(candidates),
        }
        return best[0]

    def _find_all_clusters(self, pixels: list[tuple[int, int]]) -> list[list]:
        """将像素列表分成独立的空间集群。

        使用简单的贪心聚合: 按 y 排序后, 从上到下扫描,
        如果像素在 radius 内有已知集群, 加入之; 否则开新集群。
        """
        if len(pixels) < 3:
            return []

        radius = self.CLUSTER_RADIUS
        # 按 y, x 排序
        sorted_px = sorted(pixels, key=lambda p: (p[1], p[0]))
        clusters: list[list] = []
        assigned = [False] * len(sorted_px)

        for i, (px, py) in enumerate(sorted_px):
            if assigned[i]:
                continue
            # 开一个新集群
            cluster = [(px, py)]
            assigned[i] = True
            # 找邻居
            for j in range(i + 1, len(sorted_px)):
                if assigned[j]:
                    continue
                qx, qy = sorted_px[j]
                # y 方向超出 radius → 后续都不会在范围内
                if qy - py > radius * 2:
                    break
                # 检查是否在集群内任一点的邻域
                for cx, cy in cluster:
                    if abs(qx - cx) <= radius and abs(qy - cy) <= radius:
                        cluster.append((qx, qy))
                        assigned[j] = True
                        break
            clusters.append(cluster)

        return clusters

    # ─── 输入框反推 ───────────────────────────────────────────────

    def _infer_input_box(self, img: Image.Image, send_btn: Region,
                         debug: dict) -> Optional[Region]:
        """以发送按钮为锚点, 反推输入框区域。

        输入框在按钮的左侧, 同一水平线上。
        通过向左扫描找到输入框的左边界。
        """
        w, h = img.size
        btn_cy = send_btn.y + send_btn.h // 2

        # 从按钮向左扫描, 找输入框的左边界
        # 输入框背景通常与外部面板背景有色差
        scan_y = btn_cy
        btn_left = send_btn.x

        # 先采样按钮附近的输入框背景色 (按钮左侧 50px 处)
        sample_x = max(0, btn_left - 50)
        if sample_x < w and scan_y < h:
            input_bg = img.getpixel((sample_x, scan_y))[:3]
        else:
            return None

        # 向左扫描直到颜色显著变化 (= 输入框左边界)
        left_x = 0
        for x in range(sample_x, 0, -3):
            r, g, b = img.getpixel((x, scan_y))[:3]
            diff = self.color.color_distance((r, g, b), input_bg)
            if diff > 30:
                left_x = x + 3
                break

        # 输入框区域
        box_x = left_x
        box_y = max(0, send_btn.y - self.INPUT_BOX_PAD_UP)
        box_right = min(w, send_btn.right + 10)
        box_bottom = min(h, send_btn.bottom + self.INPUT_BOX_PAD_DOWN)
        box_w = box_right - box_x
        box_h = box_bottom - box_y

        if box_w < 100 or box_h < 20:
            debug["input_box_reason"] = f"too_small: {box_w}x{box_h}"
            return None

        region = Region(x=box_x, y=box_y, w=box_w, h=box_h)
        debug["input_box"] = {"x": box_x, "y": box_y, "w": box_w, "h": box_h,
                              "method": "inferred_from_button"}
        return region

    # ─── 工具方法 ──────────────────────────────────────────────────

    def _pixels_to_region(self, pixels: list[tuple]) -> Region:
        """从像素坐标列表计算包围盒。"""
        xs = [p[0] for p in pixels]
        ys = [p[1] for p in pixels]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        # 扩展一点边距
        pad = 4
        return Region(
            x=max(0, min_x - pad), y=max(0, min_y - pad),
            w=max_x - min_x + pad * 2, h=max_y - min_y + pad * 2,
        )

    def _calc_confidence(self, input_box: Optional[Region],
                         send_btn: Optional[Region],
                         state: SendButtonState) -> float:
        """计算检测置信度 (0-1)。"""
        score = 0.0
        if input_box:
            score += 0.4
        if send_btn:
            score += 0.3
        if state != SendButtonState.UNKNOWN:
            score += 0.3
        return score
