"""可视化标注层 — 红框/标签/网格/Preview 展示。

职责:
  - 在截图上绘制检测到的 UI 元素边界框 (红色)
  - 添加状态标签 (SENDABLE/RUNNING/DISABLED)
  - 叠加坐标网格 (可配置间距)
  - --visual 模式下打开 Preview + 延迟展示
  - 所有标注产物保存到截图目录

不做检测，不做业务逻辑 — 纯可视化。
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

from .visual import Region, SendButtonState, UIElements


# ─── 颜色常量 ─────────────────────────────────────────────────────────────

class Colors:
    RED = (255, 50, 50)
    GREEN = (50, 255, 50)
    BLUE = (80, 120, 255)
    YELLOW = (255, 255, 50)
    WHITE = (255, 255, 255)
    CYAN = (50, 255, 255)
    ORANGE = (255, 165, 0)
    GRID = (255, 255, 255, 40)  # 半透明白色


# 状态 → 颜色映射
STATE_COLORS = {
    SendButtonState.SENDABLE: Colors.GREEN,
    SendButtonState.RUNNING: Colors.ORANGE,
    SendButtonState.DISABLED: Colors.RED,
    SendButtonState.UNKNOWN: Colors.YELLOW,
}


class Annotator:
    """截图标注器 — GUI Agent 的可视化引擎。

    用法:
        ann = Annotator(visual_mode=True, delay=2.0)
        annotated = ann.annotate_all(img, elements)
        ann.show(annotated, "检测结果")
    """

    def __init__(self, visual_mode: bool = False, delay: float = 2.0,
                 output_dir: Optional[Path] = None, grid_spacing: int = 50):
        self.visual_mode = visual_mode
        self.delay = delay
        self.output_dir = output_dir or Path.home() / ".quote-autopilot" / "gui-agent" / "visual"
        self.grid_spacing = grid_spacing
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._font = self._load_font()

    def _load_font(self) -> ImageFont.FreeTypeFont:
        """加载字体 (fallback 到默认)。"""
        font_paths = [
            "/System/Library/Fonts/Menlo.ttc",
            "/System/Library/Fonts/Monaco.dfont",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
        for fp in font_paths:
            try:
                return ImageFont.truetype(fp, 14)
            except Exception:
                continue
        return ImageFont.load_default()

    # ─── 核心标注 ────────────────────────────────────────────────────

    def annotate_all(self, img: Image.Image, elements: UIElements,
                     label_prefix: str = "") -> Image.Image:
        """综合标注: 输入框 + 发送按钮 + 状态标签。"""
        annotated = img.copy().convert("RGBA")

        # 画输入框
        if elements.input_box:
            self.draw_box(annotated, elements.input_box,
                          f"{label_prefix}INPUT_BOX", Colors.RED, thickness=3)

        # 画发送按钮
        if elements.send_button:
            state_label = f"SEND[{elements.send_state.value.upper()}]"
            btn_color = STATE_COLORS.get(elements.send_state, Colors.YELLOW)
            self.draw_box(annotated, elements.send_button,
                          f"{label_prefix}{state_label}", btn_color, thickness=3)

        # 画工具栏区域
        if elements.toolbar_region:
            self.draw_box(annotated, elements.toolbar_region,
                          f"{label_prefix}TOOLBAR", Colors.CYAN, thickness=1)

        # 右上角状态文字
        draw = ImageDraw.Draw(annotated)
        status_text = f"State: {elements.send_state.value} | Conf: {elements.confidence:.0%}"
        draw.text((10, 10), status_text, fill=Colors.WHITE, font=self._font)

        return annotated

    def draw_box(self, img: Image.Image, region: Region, label: str,
                 color: tuple = Colors.RED, thickness: int = 2):
        """在图片上画矩形框 + 标签。"""
        draw = ImageDraw.Draw(img)

        # 矩形框
        for i in range(thickness):
            draw.rectangle(
                [region.x - i, region.y - i, region.right + i, region.bottom + i],
                outline=color,
            )

        # 标签背景
        text_bbox = draw.textbbox((0, 0), label, font=self._font)
        text_w = text_bbox[2] - text_bbox[0]
        text_h = text_bbox[3] - text_bbox[1]
        label_x = region.x
        label_y = max(0, region.y - text_h - 6)
        draw.rectangle(
            [label_x, label_y, label_x + text_w + 8, label_y + text_h + 4],
            fill=color,
        )
        draw.text((label_x + 4, label_y + 2), label, fill=(0, 0, 0), font=self._font)

    def draw_grid(self, img: Image.Image, spacing: Optional[int] = None) -> Image.Image:
        """在图片上叠加坐标网格。"""
        spacing = spacing or self.grid_spacing
        overlay = img.copy().convert("RGBA")
        grid_layer = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(grid_layer)
        w, h = overlay.size

        # 垂直线
        for x in range(0, w, spacing):
            draw.line([(x, 0), (x, h)], fill=(255, 255, 255, 30), width=1)
            if x % (spacing * 2) == 0:
                draw.text((x + 2, 2), str(x), fill=(255, 255, 255, 80), font=self._font)

        # 水平线
        for y in range(0, h, spacing):
            draw.line([(0, y), (w, y)], fill=(255, 255, 255, 30), width=1)
            if y % (spacing * 2) == 0:
                draw.text((2, y + 2), str(y), fill=(255, 255, 255, 80), font=self._font)

        return Image.alpha_composite(overlay, grid_layer)

    # ─── 保存与展示 ──────────────────────────────────────────────────

    def save(self, img: Image.Image, name: str) -> Path:
        """保存标注图片到输出目录。"""
        # 转回 RGB 保存 PNG
        save_img = img.convert("RGB") if img.mode == "RGBA" else img
        path = self.output_dir / f"{name}_{int(time.time() * 1000)}.png"
        save_img.save(path, "PNG")
        return path

    def show(self, img: Image.Image, title: str = "annotated") -> Optional[Path]:
        """保存 + (visual 模式下) 打开 Preview + 延迟。

        Returns:
            保存的文件路径
        """
        path = self.save(img, title)

        if self.visual_mode:
            # macOS Preview 打开
            try:
                subprocess.Popen(["open", "-a", "Preview", str(path)])
            except Exception:
                pass
            # 延迟展示
            if self.delay > 0:
                time.sleep(self.delay)

        return path

    def annotate_and_show(self, img: Image.Image, elements: UIElements,
                          title: str = "detection", with_grid: bool = True) -> Path:
        """完整流程: 标注 → 网格 → 保存 → (可选)展示。"""
        annotated = self.annotate_all(img, elements)
        if with_grid:
            annotated = self.draw_grid(annotated)
        return self.show(annotated, title)
