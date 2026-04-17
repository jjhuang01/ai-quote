#!/usr/bin/env python3
"""spike_01_screenshot — A1: screencapture 能否截取屏幕

验证:
  - screencapture 命令存在且可执行
  - 能截取全屏截图
  - 截图文件有效（非空、合理尺寸）

通过标准: 截图文件 > 10KB, 尺寸 > 100x100
"""

import shutil
import subprocess
import sys
import os
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, capture_screen


def main():
    spike = SpikeRunner("A1: Screenshot Capture", spike_id="spike_01")

    # ── Step 1: 检查 screencapture 命令 ──────────────────────────────────
    spike.step("检查 screencapture 命令可用性")
    sc_path = shutil.which("screencapture")
    if sc_path:
        spike.pass_step(f"screencapture 存在: {sc_path}")
    else:
        spike.fail_step("screencapture 未找到，请确认 macOS 环境")
        spike.summary()
        return

    # ── Step 2: 检查版本信息 ─────────────────────────────────────────────
    spike.step("获取 screencapture 帮助信息")
    try:
        result = subprocess.run(
            ["screencapture", "-h"], capture_output=True, text=True, timeout=5
        )
        # screencapture -h 通常输出到 stderr
        help_text = result.stderr or result.stdout
        spike.debug(f"帮助信息前 200 字符: {help_text[:200]}")
        has_l_flag = "-l" in help_text
        spike.log(f"支持 -l (窗口截图) 参数: {'是' if has_l_flag else '否'}")
        spike.pass_step(f"帮助信息获取成功, -l 参数: {'✓' if has_l_flag else '✗'}")
    except Exception as e:
        spike.warn(f"获取帮助信息失败 (非致命): {e}")
        spike.pass_step("跳过帮助信息检查")

    # ── Step 3: 执行全屏截图 ─────────────────────────────────────────────
    spike.step("执行全屏截图")
    output_path = str(spike.output_dir / "fullscreen.png")
    try:
        with spike.timer("screencapture 截图耗时"):
            info = capture_screen(output_path)
        spike.debug(f"尺寸: {info['width']}x{info['height']}")
        spike.debug(f"文件大小: {info['size_bytes']} bytes ({info['size_bytes'] / 1024:.1f} KB)")
        spike.debug(f"耗时: {info['elapsed_ms']:.0f}ms")
        spike.save_artifact("fullscreen.png", path=output_path)
        spike.pass_step(
            f"截图成功: {info['width']}x{info['height']}, "
            f"{info['size_bytes'] / 1024:.1f}KB, {info['elapsed_ms']:.0f}ms"
        )
    except Exception as e:
        spike.fail_step(f"截图失败: {e}")
        spike.summary()
        return

    # ── Step 4: 验证截图质量 ─────────────────────────────────────────────
    spike.step("验证截图有效性")
    checks_passed = True

    # 文件大小检查
    if info["size_bytes"] < 10 * 1024:
        spike.warn(f"截图文件太小: {info['size_bytes']} bytes (期望 > 10KB)")
        checks_passed = False
    else:
        spike.debug(f"文件大小 OK: {info['size_bytes'] / 1024:.1f}KB > 10KB")

    # 尺寸检查
    if info["width"] < 100 or info["height"] < 100:
        spike.warn(f"截图尺寸太小: {info['width']}x{info['height']} (期望 > 100x100)")
        checks_passed = False
    else:
        spike.debug(f"尺寸 OK: {info['width']}x{info['height']}")

    # PNG 魔数检查
    with open(output_path, "rb") as f:
        header = f.read(8)
    is_png = header[:4] == b"\x89PNG"
    if is_png:
        spike.debug("PNG 格式验证: ✓")
    else:
        spike.warn(f"文件不是有效 PNG, header: {header.hex()}")
        checks_passed = False

    if checks_passed:
        spike.pass_step("所有验证通过")
    else:
        spike.fail_step("部分验证失败，请检查 debug 输出")

    # ── Step 5: 连续截图性能测试 ─────────────────────────────────────────
    spike.step("连续截图性能 (5 次)")
    times = []
    with tempfile.TemporaryDirectory() as tmpdir:
        for i in range(5):
            tmp_path = os.path.join(tmpdir, f"perf_{i}.png")
            try:
                info_i = capture_screen(tmp_path)
                times.append(info_i["elapsed_ms"])
                spike.debug(f"  #{i+1}: {info_i['elapsed_ms']:.0f}ms")
            except Exception as e:
                spike.warn(f"  #{i+1}: 失败 - {e}")

    if times:
        avg = sum(times) / len(times)
        mn, mx = min(times), max(times)
        spike.save_artifact("perf_times.json", {
            "times_ms": times, "avg_ms": round(avg, 1),
            "min_ms": round(mn, 1), "max_ms": round(mx, 1),
        })
        spike.pass_step(f"平均 {avg:.0f}ms (min={mn:.0f}, max={mx:.0f})")
    else:
        spike.fail_step("所有性能测试截图都失败了")

    spike.summary()


if __name__ == "__main__":
    main()
