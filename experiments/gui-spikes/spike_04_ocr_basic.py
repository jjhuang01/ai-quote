#!/usr/bin/env python3
"""spike_04_ocr_basic — A4: macOS Vision OCR 基础识别

验证:
  - pyobjc Vision 框架可用
  - 能对 Windsurf 截图执行 OCR
  - 能识别 Cascade UI 中的英文和中文

通过标准: 至少识别到 5 个文字片段, 置信度 > 0.5
"""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, capture_screen, capture_window


def perform_ocr(image_path: str, languages: list[str] = None) -> list[dict]:
    """对图片执行 macOS Vision OCR。

    Returns:
        [{"text": str, "confidence": float, "bbox": {"x": f, "y": f, "w": f, "h": f}}]
        bbox 是归一化坐标 (0-1), 原点在左下角
    """
    import Quartz
    import Vision

    # 加载图片
    url = Quartz.NSURL.fileURLWithPath_(image_path)
    ci_image = Quartz.CIImage.imageWithContentsOfURL_(url)
    if ci_image is None:
        raise RuntimeError(f"无法加载图片: {image_path}")

    # 获取 CGImage
    context = Quartz.CIContext.context()
    extent = ci_image.extent()
    cg_image = context.createCGImage_fromRect_(ci_image, extent)
    if cg_image is None:
        raise RuntimeError("CIContext.createCGImage 失败")

    # 创建 OCR 请求
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(1)  # 1 = accurate, 0 = fast
    if languages:
        request.setRecognitionLanguages_(languages)
    else:
        request.setRecognitionLanguages_(["en", "zh-Hans"])
    request.setUsesLanguageCorrection_(True)

    # 执行
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, None)
    success, error = handler.performRequests_error_([request], None)
    if not success:
        raise RuntimeError(f"OCR 失败: {error}")

    # 解析结果
    results = []
    for observation in request.results():
        top_candidate = observation.topCandidates_(1)
        if not top_candidate:
            continue
        text = top_candidate[0].string()
        confidence = observation.confidence()
        bbox = observation.boundingBox()
        results.append({
            "text": text,
            "confidence": round(float(confidence), 4),
            "bbox": {
                "x": round(float(bbox.origin.x), 6),
                "y": round(float(bbox.origin.y), 6),
                "w": round(float(bbox.size.width), 6),
                "h": round(float(bbox.size.height), 6),
            },
        })

    return results


def main():
    spike = SpikeRunner("A4: OCR Basic Recognition", spike_id="spike_04")

    # ── Step 1: 检查 pyobjc Vision 可用性 ───────────────────────────────
    spike.step("检查 pyobjc Vision 框架")
    try:
        import Vision
        import Quartz

        spike.debug(f"Vision 模块: {Vision.__file__}")
        spike.debug(f"Quartz 模块: {Quartz.__file__}")

        # 检查关键类是否存在
        assert hasattr(Vision, "VNRecognizeTextRequest"), "VNRecognizeTextRequest 不存在"
        assert hasattr(Vision, "VNImageRequestHandler"), "VNImageRequestHandler 不存在"
        spike.pass_step("Vision + Quartz 框架可用")
    except ImportError as e:
        spike.fail_step(f"缺少依赖: {e}. 运行: pip install pyobjc-framework-Vision pyobjc-framework-Quartz")
        spike.summary()
        return
    except AssertionError as e:
        spike.fail_step(f"Vision 框架不完整: {e}")
        spike.summary()
        return

    # ── Step 2: 截取 Windsurf 窗口 ──────────────────────────────────────
    spike.step("截取目标窗口")
    screenshot_path = str(spike.output_dir / "screenshot.png")
    try:
        # 优先窗口截图
        for app_name in ["Windsurf", "Cursor"]:
            try:
                info = capture_window(app_name, screenshot_path)
                spike.debug(f"窗口截图: {app_name}, {info['width']}x{info['height']}")
                spike.save_artifact("screenshot.png", path=screenshot_path)
                spike.pass_step(f"{app_name} 窗口截图: {info['width']}x{info['height']}")
                break
            except Exception:
                continue
        else:
            # 回退全屏
            spike.warn("窗口截图失败，使用全屏截图")
            info = capture_screen(screenshot_path)
            spike.save_artifact("screenshot.png", path=screenshot_path)
            spike.pass_step(f"全屏截图: {info['width']}x{info['height']}")
    except Exception as e:
        spike.fail_step(f"截图失败: {e}")
        spike.summary()
        return

    # ── Step 3: 执行 OCR ────────────────────────────────────────────────
    spike.step("执行 Vision OCR")
    try:
        with spike.timer("OCR 耗时"):
            results = perform_ocr(screenshot_path)

        spike.debug(f"识别到 {len(results)} 个文字片段")

        # 打印前 20 个结果
        for i, r in enumerate(results[:20]):
            conf_color = "🟢" if r["confidence"] > 0.8 else "🟡" if r["confidence"] > 0.5 else "🔴"
            spike.debug(
                f"  [{i+1}] {conf_color} ({r['confidence']:.2f}) "
                f'"{r["text"][:60]}"'
            )

        if len(results) > 20:
            spike.debug(f"  ... 还有 {len(results) - 20} 个结果")

        spike.save_artifact("ocr_results.json", results)
        spike.pass_step(f"识别到 {len(results)} 个文字片段")
    except Exception as e:
        spike.fail_step(f"OCR 失败: {e}")
        spike.summary()
        return

    # ── Step 4: 验证关键 UI 元素识别 ────────────────────────────────────
    spike.step("验证关键 UI 元素识别")
    all_text = " ".join(r["text"] for r in results).lower()
    spike.debug(f"全部文字 (前 500 字符): {all_text[:500]}")

    # 期望识别到的关键词
    keywords = {
        "cascade": False,
        "ask": False,
    }
    # 宽松匹配
    for kw in keywords:
        if kw in all_text:
            keywords[kw] = True
            spike.debug(f"  ✓ 关键词 '{kw}' 已找到")
        else:
            spike.debug(f"  ✗ 关键词 '{kw}' 未找到")

    found = sum(1 for v in keywords.values() if v)
    spike.log(f"关键词匹配: {found}/{len(keywords)}")

    # ── Step 5: 置信度分析 ──────────────────────────────────────────────
    spike.step("置信度分析")
    if results:
        confidences = [r["confidence"] for r in results]
        avg_conf = sum(confidences) / len(confidences)
        high_conf = sum(1 for c in confidences if c > 0.8)
        mid_conf = sum(1 for c in confidences if 0.5 <= c <= 0.8)
        low_conf = sum(1 for c in confidences if c < 0.5)

        spike.debug(f"平均置信度: {avg_conf:.2f}")
        spike.debug(f"高置信度 (>0.8): {high_conf}")
        spike.debug(f"中置信度 (0.5-0.8): {mid_conf}")
        spike.debug(f"低置信度 (<0.5): {low_conf}")

        stats = {
            "total": len(results),
            "avg_confidence": round(avg_conf, 4),
            "high_confidence_count": high_conf,
            "mid_confidence_count": mid_conf,
            "low_confidence_count": low_conf,
        }
        spike.save_artifact("ocr_stats.json", stats)

        # 通过标准: 至少 5 个片段, 置信度 > 0.5
        valid_count = high_conf + mid_conf
        if valid_count >= 5:
            spike.pass_step(f"有效片段: {valid_count} (>=5), 平均置信度: {avg_conf:.2f}")
        else:
            spike.fail_step(f"有效片段不足: {valid_count} (<5)")
    else:
        spike.fail_step("没有识别到任何文字")

    spike.summary()


if __name__ == "__main__":
    main()
