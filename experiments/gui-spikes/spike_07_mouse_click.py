#!/usr/bin/env python3
"""spike_07_mouse_click — A7: 鼠标移动 + 精确点击

验证:
  - AppleScript 能读取当前鼠标位置
  - AppleScript 能移动鼠标到指定坐标
  - 移动精度验证

通过标准: 鼠标移动偏差 < 5 像素
"""

import time
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, run_applescript


def get_mouse_position() -> tuple[int, int]:
    """获取当前鼠标位置 (需要 Quartz)。"""
    try:
        from Quartz import CGEventCreate, CGEventGetLocation
        event = CGEventCreate(None)
        loc = CGEventGetLocation(event)
        return int(loc.x), int(loc.y)
    except ImportError:
        # 回退: AppleScript (精度可能低一点)
        script = '''
            tell application "System Events"
                set mousePos to do shell script "python3 -c 'from Quartz import CGEventCreate, CGEventGetLocation; e=CGEventCreate(None); l=CGEventGetLocation(e); print(int(l.x),int(l.y))'"
            end tell
            return mousePos
        '''
        result = run_applescript(script)
        parts = result.split()
        return int(parts[0]), int(parts[1])


def move_mouse(x: int, y: int):
    """用 AppleScript 移动鼠标。"""
    # 使用 cliclick 如果可用，否则用 Quartz
    try:
        from Quartz import CGEventCreateMouseEvent, CGEventPost, kCGEventMouseMoved, kCGHIDEventTap
        from Quartz import CGPointMake

        point = CGPointMake(float(x), float(y))
        event = CGEventCreateMouseEvent(None, kCGEventMouseMoved, point, 0)
        CGEventPost(kCGHIDEventTap, event)
    except ImportError:
        # 回退: AppleScript + python subprocess
        run_applescript(
            f'do shell script "python3 -c \\"from Quartz import *; '
            f'e=CGEventCreateMouseEvent(None,kCGEventMouseMoved,CGPointMake({x},{y}),0); '
            f'CGEventPost(kCGHIDEventTap,e)\\""'
        )


def click_at(x: int, y: int):
    """在指定坐标点击。"""
    try:
        from Quartz import (
            CGEventCreateMouseEvent, CGEventPost,
            kCGEventLeftMouseDown, kCGEventLeftMouseUp,
            kCGHIDEventTap, CGPointMake,
        )
        point = CGPointMake(float(x), float(y))
        down = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, point, 0)
        up = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, point, 0)
        CGEventPost(kCGHIDEventTap, down)
        time.sleep(0.05)
        CGEventPost(kCGHIDEventTap, up)
    except ImportError:
        run_applescript(
            f'tell application "System Events" to click at {{{x}, {y}}}'
        )


def main():
    spike = SpikeRunner("A7: Mouse Click Precision", spike_id="spike_07")

    # ── Step 1: 检查 Quartz 可用性 ──────────────────────────────────────
    spike.step("检查鼠标控制能力")
    has_quartz = False
    try:
        from Quartz import CGEventCreate, CGEventCreateMouseEvent
        has_quartz = True
        spike.pass_step("Quartz 鼠标控制可用 (高精度)")
    except ImportError:
        spike.warn("Quartz 不可用，回退到 AppleScript (精度可能较低)")
        spike.pass_step("AppleScript 鼠标控制 (回退)")

    # ── Step 2: 读取当前鼠标位置 ────────────────────────────────────────
    spike.step("读取当前鼠标位置")
    try:
        x0, y0 = get_mouse_position()
        spike.debug(f"当前鼠标位置: ({x0}, {y0})")
        spike.pass_step(f"鼠标位置: ({x0}, {y0})")
    except Exception as e:
        spike.fail_step(f"无法获取鼠标位置: {e}")
        spike.summary()
        return

    # ── Step 3: 移动鼠标到目标位置 ──────────────────────────────────────
    spike.step("移动鼠标到屏幕中心区域")
    # 选择一个安全的中心位置
    target_x, target_y = 500, 400
    try:
        move_mouse(target_x, target_y)
        time.sleep(0.2)

        # 验证
        actual_x, actual_y = get_mouse_position()
        dx = abs(actual_x - target_x)
        dy = abs(actual_y - target_y)
        spike.debug(f"目标: ({target_x}, {target_y})")
        spike.debug(f"实际: ({actual_x}, {actual_y})")
        spike.debug(f"偏差: dx={dx}, dy={dy}")

        if dx <= 5 and dy <= 5:
            spike.pass_step(f"偏差 ({dx},{dy}) ≤ 5 像素 ✓")
        else:
            spike.fail_step(f"偏差 ({dx},{dy}) > 5 像素", fatal=False)
    except Exception as e:
        spike.fail_step(f"鼠标移动失败: {e}")

    # ── Step 4: 多点移动精度测试 ────────────────────────────────────────
    spike.step("多点移动精度测试")
    test_points = [
        (100, 100), (800, 100), (800, 600), (100, 600), (400, 300),
    ]
    errors = []
    for tx, ty in test_points:
        try:
            move_mouse(tx, ty)
            time.sleep(0.1)
            ax, ay = get_mouse_position()
            err = ((ax - tx) ** 2 + (ay - ty) ** 2) ** 0.5
            errors.append({"target": (tx, ty), "actual": (ax, ay), "error_px": round(err, 1)})
            spike.debug(f"  ({tx},{ty}) → ({ax},{ay}) err={err:.1f}px")
        except Exception as e:
            spike.debug(f"  ({tx},{ty}) → 失败: {e}")
            errors.append({"target": (tx, ty), "error": str(e)})

    spike.save_artifact("mouse_trace.json", errors)
    valid_errors = [e["error_px"] for e in errors if "error_px" in e]
    if valid_errors:
        avg_err = sum(valid_errors) / len(valid_errors)
        max_err = max(valid_errors)
        spike.debug(f"平均误差: {avg_err:.1f}px, 最大: {max_err:.1f}px")
        if max_err <= 5:
            spike.pass_step(f"所有点精度 ≤ 5px (avg={avg_err:.1f}, max={max_err:.1f})")
        else:
            spike.fail_step(f"最大误差 {max_err:.1f}px > 5px", fatal=False)
    else:
        spike.fail_step("所有测试点都失败了")

    # ── Step 5: 恢复鼠标位置 ────────────────────────────────────────────
    spike.step("恢复原始鼠标位置")
    try:
        move_mouse(x0, y0)
        time.sleep(0.1)
        spike.pass_step(f"鼠标已恢复到 ({x0}, {y0})")
    except Exception as e:
        spike.warn(f"恢复失败 (非致命): {e}")
        spike.pass_step("跳过恢复")

    spike.summary()


if __name__ == "__main__":
    main()
