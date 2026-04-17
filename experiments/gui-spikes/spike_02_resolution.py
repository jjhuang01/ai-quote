#!/usr/bin/env python3
"""spike_02_resolution — A2: 屏幕分辨率检测 (Retina 逻辑 vs 物理像素)

验证:
  - 能获取逻辑分辨率和物理分辨率
  - 能计算 Retina scale factor
  - 截图像素尺寸 = 逻辑分辨率 × scale factor

通过标准: 逻辑分辨率 × scale = 截图像素尺寸
"""

import json
import subprocess
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, capture_screen


def main():
    spike = SpikeRunner("A2: Resolution Detection", spike_id="spike_02")

    display_info = {}

    # ── Step 1: system_profiler 获取显示器信息 ───────────────────────────
    spike.step("system_profiler 获取显示器信息")
    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType", "-json"],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(result.stdout)
        displays = []
        for gpu in data.get("SPDisplaysDataType", []):
            for d in gpu.get("spdisplays_ndrvs", []):
                info = {
                    "name": d.get("_name", "unknown"),
                    "resolution": d.get("_spdisplays_resolution", ""),
                    "pixels": d.get("_spdisplays_pixels", ""),
                    "retina": d.get("spdisplays_retina", ""),
                }
                displays.append(info)
                spike.debug(f"  显示器: {info['name']}")
                spike.debug(f"  分辨率: {info['resolution']}")
                spike.debug(f"  像素: {info['pixels']}")
                spike.debug(f"  Retina: {info['retina']}")

        display_info["system_profiler"] = displays
        spike.save_artifact("system_profiler.json", displays)
        spike.pass_step(f"发现 {len(displays)} 个显示器")
    except Exception as e:
        spike.fail_step(f"system_profiler 失败: {e}")
        spike.summary()
        return

    # ── Step 2: Quartz API 获取精确像素信息 ──────────────────────────────
    spike.step("Quartz API 获取物理像素信息")
    quartz_info = {}
    try:
        from Quartz import (
            CGMainDisplayID,
            CGDisplayPixelsWide,
            CGDisplayPixelsHigh,
            CGDisplayBounds,
            CGDisplayScreenSize,
        )

        main_id = CGMainDisplayID()
        phys_w = CGDisplayPixelsWide(main_id)
        phys_h = CGDisplayPixelsHigh(main_id)
        bounds = CGDisplayBounds(main_id)
        logical_w = int(bounds.size.width)
        logical_h = int(bounds.size.height)

        # screen size in mm
        size_mm = CGDisplayScreenSize(main_id)

        quartz_info = {
            "display_id": main_id,
            "physical_pixels": {"width": phys_w, "height": phys_h},
            "logical_points": {"width": logical_w, "height": logical_h},
            "scale_factor": phys_w / logical_w if logical_w > 0 else 0,
            "screen_size_mm": {"width": round(size_mm.width, 1), "height": round(size_mm.height, 1)},
        }

        spike.debug(f"物理像素: {phys_w}x{phys_h}")
        spike.debug(f"逻辑点数: {logical_w}x{logical_h}")
        spike.debug(f"Scale factor: {quartz_info['scale_factor']:.1f}")
        spike.debug(f"物理尺寸: {size_mm.width:.0f}x{size_mm.height:.0f}mm")

        display_info["quartz"] = quartz_info
        spike.save_artifact("quartz_info.json", quartz_info)
        spike.pass_step(
            f"物理 {phys_w}x{phys_h}, 逻辑 {logical_w}x{logical_h}, "
            f"scale={quartz_info['scale_factor']:.1f}"
        )
    except ImportError:
        spike.warn("Quartz 模块不可用，尝试回退方案")
        spike.skip_step("需要 pyobjc-framework-Quartz: pip install pyobjc-framework-Quartz")
    except Exception as e:
        spike.fail_step(f"Quartz API 失败: {e}")

    # ── Step 3: 截图尺寸交叉验证 ────────────────────────────────────────
    spike.step("截图尺寸与分辨率交叉验证")
    screenshot_path = str(spike.output_dir / "validation_screenshot.png")
    try:
        ss_info = capture_screen(screenshot_path)
        ss_w, ss_h = ss_info["width"], ss_info["height"]
        spike.debug(f"截图像素: {ss_w}x{ss_h}")

        if quartz_info:
            phys_w = quartz_info["physical_pixels"]["width"]
            phys_h = quartz_info["physical_pixels"]["height"]
            logical_w = quartz_info["logical_points"]["width"]
            logical_h = quartz_info["logical_points"]["height"]
            scale = quartz_info["scale_factor"]

            # screencapture 在 Retina 下通常输出物理像素
            if ss_w == phys_w and ss_h == phys_h:
                spike.debug("截图 = 物理像素 ✓ (screencapture 输出 Retina 分辨率)")
                spike.pass_step(f"截图 {ss_w}x{ss_h} = 物理像素 {phys_w}x{phys_h}")
            elif ss_w == logical_w and ss_h == logical_h:
                spike.debug("截图 = 逻辑像素 ⚠️ (screencapture 输出 1x 分辨率)")
                spike.pass_step(f"截图 {ss_w}x{ss_h} = 逻辑点数 {logical_w}x{logical_h}")
            else:
                spike.warn(f"截图尺寸 {ss_w}x{ss_h} 与物理 {phys_w}x{phys_h} / 逻辑 {logical_w}x{logical_h} 都不匹配")
                spike.fail_step("截图尺寸不匹配任何已知分辨率", fatal=False)

            # 记录坐标映射规则
            mapping = {
                "screenshot_pixels": {"width": ss_w, "height": ss_h},
                "logical_points": {"width": logical_w, "height": logical_h},
                "physical_pixels": {"width": phys_w, "height": phys_h},
                "screenshot_to_logical_scale": logical_w / ss_w if ss_w > 0 else 0,
                "screenshot_to_physical_scale": phys_w / ss_w if ss_w > 0 else 0,
                "note": "OCR 坐标是截图像素坐标，AppleScript 使用逻辑点坐标",
            }
            spike.save_artifact("coordinate_mapping.json", mapping)
            spike.log(f"📐 截图→逻辑 scale: {mapping['screenshot_to_logical_scale']:.2f}")
            spike.log(f"📐 截图→物理 scale: {mapping['screenshot_to_physical_scale']:.2f}")
        else:
            spike.warn("无 Quartz 数据，跳过交叉验证")
            spike.skip_step("需要 Step 2 的 Quartz 数据")

    except Exception as e:
        spike.fail_step(f"交叉验证失败: {e}")

    # ── Step 4: 总结坐标映射规则 ─────────────────────────────────────────
    spike.step("总结坐标映射规则")
    if quartz_info:
        logical_w = quartz_info["logical_points"]["width"]
        ss_w = ss_info.get("width", 0) if "ss_info" in dir() else 0
        if ss_w > 0 and logical_w > 0:
            ratio = ss_w / logical_w
            spike.log(f"🔑 关键发现: screencapture 截图是逻辑分辨率的 {ratio:.1f}x")
            spike.log(f"🔑 OCR 在截图上的坐标需要除以 {ratio:.1f} 才能转为 AppleScript 坐标")
            spike.pass_step(f"坐标映射规则: 截图坐标 / {ratio:.1f} = AppleScript 坐标")
        else:
            spike.skip_step("数据不完整")
    else:
        spike.skip_step("无 Quartz 数据")

    spike.save_artifact("display_info.json", display_info)
    spike.summary()


if __name__ == "__main__":
    main()
