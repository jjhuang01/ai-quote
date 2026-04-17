#!/usr/bin/env python3
"""spike_05_ocr_coords — A5: OCR 文字坐标精度验证

验证:
  - OCR bounding box 能精确定位 UI 元素
  - 归一化坐标 → 像素坐标转换正确
  - 在截图上标注 bounding box 供人工检查

通过标准: 标注矩形与 UI 元素对齐（人工检查 annotated.png）
依赖: Pillow (pip install Pillow)
"""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, capture_screen, capture_window


def main():
    spike = SpikeRunner("A5: OCR Coordinate Precision", spike_id="spike_05")

    # ── Step 1: 检查依赖 ────────────────────────────────────────────────
    spike.step("检查依赖: Pillow + Vision")
    try:
        from PIL import Image, ImageDraw, ImageFont
        spike.debug("Pillow 可用 ✓")
    except ImportError:
        spike.fail_step("需要 Pillow: pip install Pillow")
        spike.summary()
        return

    try:
        from spike_04_ocr_basic import perform_ocr
        spike.debug("OCR 函数可用 ✓")
    except ImportError:
        spike.fail_step("无法导入 spike_04_ocr_basic.perform_ocr")
        spike.summary()
        return
    spike.pass_step("所有依赖就绪")

    # ── Step 2: 截图 ────────────────────────────────────────────────────
    spike.step("截取目标窗口")
    screenshot_path = str(spike.output_dir / "screenshot.png")
    try:
        for app_name in ["Windsurf", "Cursor"]:
            try:
                info = capture_window(app_name, screenshot_path)
                spike.debug(f"{app_name} 窗口: {info['width']}x{info['height']}")
                break
            except Exception:
                continue
        else:
            info = capture_screen(screenshot_path)
            spike.debug(f"全屏: {info['width']}x{info['height']}")

        spike.save_artifact("screenshot.png", path=screenshot_path)
        spike.pass_step(f"截图: {info['width']}x{info['height']}")
    except Exception as e:
        spike.fail_step(f"截图失败: {e}")
        spike.summary()
        return

    # ── Step 3: OCR + 坐标收集 ──────────────────────────────────────────
    spike.step("执行 OCR 并收集坐标")
    try:
        with spike.timer("OCR"):
            results = perform_ocr(screenshot_path)
        spike.debug(f"识别到 {len(results)} 个文字片段")
        spike.save_artifact("ocr_raw.json", results)
        spike.pass_step(f"OCR 完成: {len(results)} 个片段")
    except Exception as e:
        spike.fail_step(f"OCR 失败: {e}")
        spike.summary()
        return

    # ── Step 4: 坐标转换 ────────────────────────────────────────────────
    spike.step("归一化坐标 → 像素坐标转换")
    img = Image.open(screenshot_path)
    img_w, img_h = img.size
    spike.debug(f"截图像素尺寸: {img_w}x{img_h}")

    converted = []
    for r in results:
        bbox = r["bbox"]
        # Vision 归一化坐标: 原点左下角, x/y/w/h 都是 0-1
        # 转换为像素坐标: 原点左上角
        px_x = int(bbox["x"] * img_w)
        px_y = int((1 - bbox["y"] - bbox["h"]) * img_h)  # 翻转 Y 轴
        px_w = int(bbox["w"] * img_w)
        px_h = int(bbox["h"] * img_h)

        converted.append({
            "text": r["text"],
            "confidence": r["confidence"],
            "normalized": r["bbox"],
            "pixels": {"x": px_x, "y": px_y, "w": px_w, "h": px_h},
        })

    spike.save_artifact("coords_converted.json", converted)
    spike.pass_step(f"转换完成: {len(converted)} 个坐标")

    # ── Step 5: 标注截图 ────────────────────────────────────────────────
    spike.step("在截图上标注 bounding box")
    try:
        draw = ImageDraw.Draw(img)

        # 颜色梯度: 高置信度绿色, 低置信度红色
        for item in converted:
            px = item["pixels"]
            conf = item["confidence"]
            if conf > 0.8:
                color = (0, 200, 0, 128)  # 绿
            elif conf > 0.5:
                color = (200, 200, 0, 128)  # 黄
            else:
                color = (200, 0, 0, 128)  # 红

            rect = [px["x"], px["y"], px["x"] + px["w"], px["y"] + px["h"]]
            draw.rectangle(rect, outline=color[:3], width=2)

            # 文字标签（截断到 30 字符）
            label = f'{item["text"][:30]} ({conf:.2f})'
            try:
                draw.text((px["x"], px["y"] - 12), label, fill=color[:3])
            except Exception:
                pass  # 字体问题忽略

        annotated_path = str(spike.output_dir / "annotated.png")
        img.save(annotated_path)
        spike.save_artifact("annotated.png", path=annotated_path)
        spike.pass_step(f"标注图保存: {annotated_path}")
        spike.log("🔍 请手动检查 annotated.png 确认标注与 UI 元素对齐")
    except Exception as e:
        spike.fail_step(f"标注失败: {e}")

    # ── Step 6: 输入框定位验证 ──────────────────────────────────────────
    spike.step("尝试定位 Cascade 输入框")
    input_candidates = []
    for item in converted:
        text_lower = item["text"].lower()
        # 搜索输入框相关文字
        if any(kw in text_lower for kw in ["ask cascade", "type a message", "ask anything", "send a message"]):
            input_candidates.append(item)
            spike.debug(f'  候选: "{item["text"]}" @ pixels ({item["pixels"]["x"]},{item["pixels"]["y"]})')

    if input_candidates:
        best = max(input_candidates, key=lambda x: x["confidence"])
        spike.save_artifact("input_box_candidates.json", input_candidates)
        spike.pass_step(
            f'找到 {len(input_candidates)} 个输入框候选, '
            f'最佳: "{best["text"][:40]}" ({best["confidence"]:.2f}) '
            f'@ ({best["pixels"]["x"]},{best["pixels"]["y"]})'
        )
    else:
        spike.warn("未找到输入框相关文字")
        spike.log("已知 OCR 文字 (前 10):")
        for item in converted[:10]:
            spike.debug(f'  "{item["text"][:50]}"')
        spike.fail_step("无法定位输入框", fatal=False)

    spike.summary()


if __name__ == "__main__":
    main()
