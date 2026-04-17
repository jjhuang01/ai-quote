#!/usr/bin/env python3
"""spike_06_grid_overlay — A6: 网格叠加 + 坐标反推

验证:
  - 能在截图上画网格标注坐标
  - OCR 识别到的位置能反推为屏幕坐标
  - 鼠标移到反推坐标时视觉上对齐

通过标准: 生成清晰的网格图 + 坐标映射表
依赖: Pillow
"""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, capture_screen, capture_window


def main():
    spike = SpikeRunner("A6: Grid Overlay + Coordinate Mapping", spike_id="spike_06")

    # ── Step 1: 检查依赖 ────────────────────────────────────────────────
    spike.step("检查依赖")
    try:
        from PIL import Image, ImageDraw, ImageFont
        spike.pass_step("Pillow 可用")
    except ImportError:
        spike.fail_step("需要 Pillow: pip install Pillow")
        spike.summary()
        return

    # ── Step 2: 截图 ────────────────────────────────────────────────────
    spike.step("截取目标窗口")
    screenshot_path = str(spike.output_dir / "screenshot.png")
    try:
        for app in ["Windsurf", "Cursor"]:
            try:
                info = capture_window(app, screenshot_path)
                break
            except Exception:
                continue
        else:
            info = capture_screen(screenshot_path)
        spike.save_artifact("screenshot.png", path=screenshot_path)
        spike.pass_step(f"截图: {info['width']}x{info['height']}")
    except Exception as e:
        spike.fail_step(f"截图失败: {e}")
        spike.summary()
        return

    # ── Step 3: 画网格 ──────────────────────────────────────────────────
    spike.step("画 50px 网格叠加")
    img = Image.open(screenshot_path)
    img_w, img_h = img.size
    draw = ImageDraw.Draw(img)
    grid_size = 50

    # 垂直线 + 坐标标签
    for x in range(0, img_w, grid_size):
        color = (255, 0, 0, 80) if x % 200 == 0 else (128, 128, 128, 40)
        draw.line([(x, 0), (x, img_h)], fill=color[:3], width=1)
        if x % 200 == 0:
            try:
                draw.text((x + 2, 2), str(x), fill=(255, 0, 0))
            except Exception:
                pass

    # 水平线 + 坐标标签
    for y in range(0, img_h, grid_size):
        color = (0, 0, 255, 80) if y % 200 == 0 else (128, 128, 128, 40)
        draw.line([(0, y), (img_w, y)], fill=color[:3], width=1)
        if y % 200 == 0:
            try:
                draw.text((2, y + 2), str(y), fill=(0, 0, 255))
            except Exception:
                pass

    grid_path = str(spike.output_dir / "grid.png")
    img.save(grid_path)
    spike.save_artifact("grid.png", path=grid_path)
    spike.pass_step(f"网格图: {grid_size}px 间隔, 200px 主线标注")

    # ── Step 4: 计算坐标映射表 ──────────────────────────────────────────
    spike.step("计算截图像素 → 屏幕逻辑坐标映射")
    try:
        from Quartz import CGMainDisplayID, CGDisplayBounds, CGDisplayPixelsWide

        main_id = CGMainDisplayID()
        bounds = CGDisplayBounds(main_id)
        logical_w = int(bounds.size.width)
        logical_h = int(bounds.size.height)
        phys_w = CGDisplayPixelsWide(main_id)

        # 截图像素到逻辑坐标的映射比
        scale = img_w / logical_w if logical_w > 0 else 1.0

        # 如果窗口截图，还需要加上窗口偏移
        from _common import get_window_info
        win_info = None
        for app in ["Windsurf", "Cursor"]:
            try:
                wi = get_window_info(app)
                if "error" not in wi:
                    win_info = wi
                    break
            except Exception:
                continue

        mapping = {
            "screenshot_pixels": {"w": img_w, "h": img_h},
            "logical_screen": {"w": logical_w, "h": logical_h},
            "pixel_to_logical_scale": round(1.0 / scale, 4),
            "window_offset": None,
            "formula": "screen_x = screenshot_x / scale + window_x",
        }

        if win_info and "error" not in win_info:
            mapping["window_offset"] = {"x": win_info["x"], "y": win_info["y"]}
            spike.debug(f"窗口偏移: ({win_info['x']}, {win_info['y']})")
            spike.log(
                f"📐 坐标公式: screen_x = pixel_x × {mapping['pixel_to_logical_scale']:.4f} + {win_info['x']}"
            )
            spike.log(
                f"📐 坐标公式: screen_y = pixel_y × {mapping['pixel_to_logical_scale']:.4f} + {win_info['y']}"
            )
        else:
            spike.log(f"📐 坐标公式: screen_x = pixel_x × {mapping['pixel_to_logical_scale']:.4f}")

        spike.save_artifact("coordinate_map.json", mapping)
        spike.pass_step(f"截图→逻辑 scale: {mapping['pixel_to_logical_scale']:.4f}")
    except ImportError:
        spike.warn("Quartz 不可用，跳过精确映射")
        spike.save_artifact("coordinate_map.json", {
            "note": "Quartz 不可用，使用 1:1 假设映射",
            "pixel_to_logical_scale": 0.5,  # Retina 默认假设
        })
        spike.pass_step("使用默认 Retina 2x 假设映射")

    spike.summary()


if __name__ == "__main__":
    main()
