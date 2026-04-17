"""数据模型 — 所有跨层通信使用的不可变数据结构。"""

from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ─── 坐标系统 ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CoordinateSystem:
    """统一坐标系管理 — GUI Agent 的空间语言。

    坐标系层级:
      1. 截图像素坐标  (screenshot_px): screencapture 物理像素, 原点左上
      2. 屏幕逻辑坐标  (screen_logical): CGEvent / AppleScript 使用, 原点左上
      3. Vision 归一化  (vision_norm):  OCR bbox, 原点左下, 0.0-1.0
      4. 窗口逻辑坐标  (window_logical): 相对窗口左上角的逻辑坐标

    转换关系:
      截图像素 → 屏幕逻辑 = 截图像素 × (logical_w / screenshot_w)
      Vision归一化 → 截图像素:
          px_x = norm_x × screenshot_w
          px_y = (1 - norm_y - norm_h) × screenshot_h   ← y 轴翻转！
    """
    # 显示器信息
    screenshot_w: int    # 截图物理宽度 (px)
    screenshot_h: int    # 截图物理高度 (px)
    logical_w: int       # 屏幕逻辑宽度 (pt)
    logical_h: int       # 屏幕逻辑高度 (pt)
    window_x: int = 0   # 窗口在屏幕的逻辑 x 偏移
    window_y: int = 0   # 窗口在屏幕的逻辑 y 偏移
    window_w: int = 0   # 窗口逻辑宽度 (0 = 全屏)
    window_h: int = 0   # 窗口逻辑高度 (0 = 全屏)
    shadow_px: int = 0  # screencapture -l 截图四周的阴影边距(物理像素)

    @property
    def display_scale(self) -> float:
        """显示器物理 scale（全屏截图 / 逻辑分辨率），标准 Retina = 2.0。"""
        return (self.screenshot_w - 2 * self.shadow_px) / self.window_w if self.window_w else 2.0

    @property
    def scale(self) -> float:
        """截图像素 → 屏幕逻辑坐标的缩放因子（含阴影补偿）。"""
        return self.logical_w / self.screenshot_w if self.screenshot_w else 1.0

    # ── 坐标转换 ─────────────────────────────────────────────────

    def vision_to_pixel(self, norm_x: float, norm_y: float,
                        norm_w: float, norm_h: float) -> "PixelBBox":
        """Vision 归一化坐标 → 截图像素坐标（y 轴翻转）。"""
        px_x = int(norm_x * self.screenshot_w)
        px_y = int((1.0 - norm_y - norm_h) * self.screenshot_h)
        px_w = int(norm_w * self.screenshot_w)
        px_h = int(norm_h * self.screenshot_h)
        return PixelBBox(x=px_x, y=px_y, w=px_w, h=px_h)

    def pixel_to_logical(self, px_x: int, px_y: int) -> tuple[int, int]:
        """截图像素坐标 → 屏幕逻辑坐标（用于 CGEvent / AppleScript 点击）。

        注意: screencapture -l 截图包含窗口阴影，内容从 shadow_px 开始。
        先减去阴影偏移，再用显示器 scale 换算到逻辑坐标，再加窗口位置。
        """
        content_x = px_x - self.shadow_px
        content_y = px_y - self.shadow_px
        ds = self.display_scale if self.display_scale > 0 else 2.0
        lx = int(content_x / ds) + self.window_x
        ly = int(content_y / ds) + self.window_y
        return lx, ly

    def region_center_logical(self, region: "Region") -> tuple[int, int]:
        """Region 中心点 → 屏幕逻辑坐标。"""
        cx = region.x + region.w // 2
        cy = region.y + region.h // 2
        return self.pixel_to_logical(cx, cy)

    def ocr_result_to_pixel(self, bbox: "BBox") -> "PixelBBox":
        """OCR BBox (Vision归一化) → 截图像素坐标。"""
        return self.vision_to_pixel(bbox.x, bbox.y, bbox.w, bbox.h)

    def __repr__(self) -> str:
        return (f"CoordinateSystem(screenshot={self.screenshot_w}x{self.screenshot_h}, "
                f"logical={self.logical_w}x{self.logical_h}, scale={self.scale:.3f}x, "
                f"window_offset=({self.window_x},{self.window_y}), shadow={self.shadow_px}px)")


# ─── 感知层模型 ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DisplayInfo:
    """显示器信息。"""
    display_id: int
    logical_width: int
    logical_height: int
    physical_width: int
    physical_height: int
    origin_x: int = 0
    origin_y: int = 0
    is_main: bool = False

    @property
    def scale_factor(self) -> float:
        return self.physical_width / self.logical_width if self.logical_width else 1.0


@dataclass(frozen=True)
class WindowInfo:
    """应用窗口信息。"""
    app_name: str
    x: int
    y: int
    width: int
    height: int
    window_id: Optional[int] = None
    frontmost: bool = False
    display_id: Optional[int] = None


@dataclass(frozen=True)
class Screenshot:
    """截图结果。"""
    path: str
    width: int
    height: int
    size_bytes: int
    elapsed_ms: float
    window_id: Optional[int] = None


@dataclass(frozen=True)
class BBox:
    """归一化 bounding box (Vision 坐标系: 原点左下角, 0-1)。"""
    x: float
    y: float
    w: float
    h: float

    def to_pixels(self, img_width: int, img_height: int) -> PixelBBox:
        """转换为像素坐标 (原点左上角)。"""
        px = int(self.x * img_width)
        py = int((1 - self.y - self.h) * img_height)
        pw = int(self.w * img_width)
        ph = int(self.h * img_height)
        return PixelBBox(x=px, y=py, w=pw, h=ph)


@dataclass(frozen=True)
class PixelBBox:
    """像素坐标 bounding box (原点左上角)。"""
    x: int
    y: int
    w: int
    h: int

    @property
    def center(self) -> tuple[int, int]:
        return self.x + self.w // 2, self.y + self.h // 2

    def to_screen(self, scale: float, offset_x: int = 0, offset_y: int = 0) -> tuple[int, int]:
        """像素坐标转屏幕逻辑坐标。"""
        cx, cy = self.center
        return int(cx * scale) + offset_x, int(cy * scale) + offset_y


@dataclass(frozen=True)
class OCRResult:
    """单个 OCR 识别结果。"""
    text: str
    confidence: float
    bbox: BBox


@dataclass(frozen=True)
class OCROutput:
    """完整 OCR 输出。"""
    results: list[OCRResult]
    screenshot: Screenshot
    elapsed_ms: float

    @property
    def texts(self) -> list[str]:
        return [r.text for r in self.results]

    @property
    def full_text(self) -> str:
        return " ".join(self.texts)

    def find(self, keyword: str, min_confidence: float = 0.3) -> list[OCRResult]:
        """搜索包含关键词的 OCR 结果。"""
        kw = keyword.lower()
        return [r for r in self.results
                if kw in r.text.lower() and r.confidence >= min_confidence]


# ─── UI 状态模型 ─────────────────────────────────────────────────────────────

class CascadeState(Enum):
    """Cascade 面板状态。"""
    READY = "ready"           # 输入框可用
    LOADING = "loading"       # AI 正在生成
    DIALOG = "dialog"         # 弹窗遮挡
    RATE_LIMIT = "rate_limit" # Rate limit 错误
    QUOTA_ERROR = "quota_error"  # 配额耗尽
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class ScreenState:
    """解析后的屏幕状态 — 感知层的最终输出。"""
    cascade_visible: bool
    state: CascadeState
    input_ready: bool
    has_dialog: bool
    has_loading: bool
    has_error: bool
    error_type: Optional[str] = None
    last_text_snippet: Optional[str] = None
    ocr_output: Optional[OCROutput] = None
    window: Optional[WindowInfo] = None

    def to_json(self) -> dict:
        return {
            "cascade_visible": self.cascade_visible,
            "state": self.state.value,
            "input_ready": self.input_ready,
            "has_dialog": self.has_dialog,
            "has_loading": self.has_loading,
            "has_error": self.has_error,
            "error_type": self.error_type,
            "last_text_snippet": self.last_text_snippet,
        }


# ─── 操作层模型 ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ActionResult:
    """操作结果 — 每次 action 的返回值。"""
    success: bool
    action: str
    elapsed_ms: float
    detail: str = ""
    error: Optional[str] = None

    def to_json(self) -> dict:
        d = {"success": self.success, "action": self.action, "elapsed_ms": round(self.elapsed_ms, 1)}
        if self.detail:
            d["detail"] = self.detail
        if self.error:
            d["error"] = self.error
        return d


# ─── 编排层模型 ──────────────────────────────────────────────────────────────

@dataclass
class CommandResult:
    """CLI 命令的最终结果 — 编排层输出给调用者。"""
    success: bool
    command: str
    elapsed_ms: float = 0
    verified: bool = False
    retries: int = 0
    error: Optional[str] = None
    state: Optional[ScreenState] = None
    details: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        d = {
            "success": self.success,
            "command": self.command,
            "elapsed_ms": round(self.elapsed_ms, 1),
            "verified": self.verified,
        }
        if self.retries > 0:
            d["retries"] = self.retries
        if self.error:
            d["error"] = self.error
        if self.state:
            d["state"] = self.state.to_json()
        if self.details:
            d.update(self.details)
        return d
