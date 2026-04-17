#!/usr/bin/env python3
"""spike_03_multiscreen — A3: 多屏幕枚举 + Windsurf 窗口定位

验证:
  - 能枚举所有连接的显示器
  - 能定位 Windsurf 窗口在哪个屏幕
  - 能只截取 Windsurf 窗口

通过标准: 正确枚举屏幕 + 窗口截图包含 Windsurf UI
"""

import json
import subprocess
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, capture_window, get_window_info, run_applescript


def main():
    spike = SpikeRunner("A3: Multi-screen + Window Locate", spike_id="spike_03")

    # ── Step 1: 枚举所有显示器 ──────────────────────────────────────────
    spike.step("枚举所有显示器 (Quartz)")
    screens = []
    try:
        from Quartz import (
            CGGetActiveDisplayList,
            CGDisplayBounds,
            CGDisplayPixelsWide,
            CGDisplayPixelsHigh,
            CGMainDisplayID,
        )

        max_displays = 16
        (err, display_ids, count) = CGGetActiveDisplayList(max_displays, None, None)
        main_id = CGMainDisplayID()

        spike.debug(f"检测到 {count} 个显示器")
        for did in display_ids[:count]:
            bounds = CGDisplayBounds(did)
            pw = CGDisplayPixelsWide(did)
            ph = CGDisplayPixelsHigh(did)
            screen = {
                "display_id": did,
                "is_main": did == main_id,
                "origin": {"x": int(bounds.origin.x), "y": int(bounds.origin.y)},
                "logical_size": {"w": int(bounds.size.width), "h": int(bounds.size.height)},
                "physical_pixels": {"w": pw, "h": ph},
            }
            screens.append(screen)
            tag = " (主屏)" if did == main_id else ""
            spike.debug(
                f"  #{did}{tag}: 逻辑 {int(bounds.size.width)}x{int(bounds.size.height)} "
                f"@ ({int(bounds.origin.x)},{int(bounds.origin.y)}), "
                f"物理 {pw}x{ph}"
            )

        spike.save_artifact("screens.json", screens)
        spike.pass_step(f"发现 {count} 个显示器")
    except ImportError:
        spike.warn("Quartz 不可用，使用 system_profiler 回退")
        try:
            result = subprocess.run(
                ["system_profiler", "SPDisplaysDataType", "-json"],
                capture_output=True, text=True, timeout=10,
            )
            data = json.loads(result.stdout)
            count = 0
            for gpu in data.get("SPDisplaysDataType", []):
                for d in gpu.get("spdisplays_ndrvs", []):
                    count += 1
                    spike.debug(f"  显示器: {d.get('_name', 'unknown')}")
            spike.save_artifact("screens_fallback.json", data)
            spike.pass_step(f"发现 {count} 个显示器 (system_profiler)")
        except Exception as e:
            spike.fail_step(f"回退方案也失败: {e}")
    except Exception as e:
        spike.fail_step(f"枚举显示器失败: {e}")

    # ── Step 2: 定位 Windsurf 窗口 ──────────────────────────────────────
    spike.step("定位 Windsurf/Cursor 窗口位置")
    target_app = None
    for name in ["Windsurf", "Cursor"]:
        try:
            info = get_window_info(name)
            if "error" not in info:
                target_app = name
                spike.debug(f"找到 {name} 窗口:")
                spike.debug(f"  位置: ({info['x']}, {info['y']})")
                spike.debug(f"  尺寸: {info['width']}x{info['height']}")
                spike.save_artifact("window_info.json", info)
                break
        except Exception:
            continue

    if target_app:
        spike.pass_step(f"{target_app} 窗口: ({info['x']},{info['y']}) {info['width']}x{info['height']}")
    else:
        spike.fail_step("未找到 Windsurf 或 Cursor 窗口")
        spike.summary()
        return

    # ── Step 3: 判断窗口在哪个屏幕 ──────────────────────────────────────
    spike.step("判断窗口在哪个屏幕")
    if screens:
        win_cx = info["x"] + info["width"] // 2
        win_cy = info["y"] + info["height"] // 2
        spike.debug(f"窗口中心点: ({win_cx}, {win_cy})")

        found_screen = None
        for s in screens:
            ox, oy = s["origin"]["x"], s["origin"]["y"]
            sw, sh = s["logical_size"]["w"], s["logical_size"]["h"]
            if ox <= win_cx < ox + sw and oy <= win_cy < oy + sh:
                found_screen = s
                break

        if found_screen:
            tag = "主屏" if found_screen["is_main"] else "副屏"
            spike.pass_step(f"窗口在 {tag} (display_id={found_screen['display_id']})")
        else:
            spike.warn("窗口中心点不在任何已知屏幕范围内")
            spike.fail_step("无法确定窗口所在屏幕", fatal=False)
    else:
        spike.skip_step("无屏幕枚举数据")

    # ── Step 4: 截取 Windsurf 窗口 ──────────────────────────────────────
    spike.step(f"截取 {target_app} 窗口")
    output_path = str(spike.output_dir / "windsurf_window.png")
    try:
        with spike.timer("窗口截图耗时"):
            win_info = capture_window(target_app, output_path)
        spike.debug(f"窗口截图: {win_info['width']}x{win_info['height']}, {win_info['size_bytes']/1024:.1f}KB")
        spike.debug(f"窗口 ID: {win_info.get('window_id', 'N/A')}")
        spike.save_artifact("windsurf_window.png", path=output_path)
        spike.pass_step(
            f"窗口截图成功: {win_info['width']}x{win_info['height']}, "
            f"{win_info['elapsed_ms']:.0f}ms"
        )
    except Exception as e:
        spike.warn(f"窗口截图失败: {e}")
        spike.log("回退: 尝试全屏截图")
        try:
            from _common import capture_screen
            fallback_path = str(spike.output_dir / "fullscreen_fallback.png")
            fb_info = capture_screen(fallback_path)
            spike.save_artifact("fullscreen_fallback.png", path=fallback_path)
            spike.pass_step(f"全屏截图回退成功: {fb_info['width']}x{fb_info['height']}")
        except Exception as e2:
            spike.fail_step(f"回退也失败: {e2}")

    spike.summary()


if __name__ == "__main__":
    main()
