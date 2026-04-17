#!/usr/bin/env python3
"""spike_10_window_focus — A10: 窗口激活 + 焦点获取

验证:
  - AppleScript activate 能激活 Windsurf 窗口
  - 能检测当前前台应用
  - 能在不同应用间切换焦点

通过标准: activate 后 Windsurf 成为 frontmost
"""

import time
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, run_applescript, get_window_info


def get_frontmost_app() -> str:
    """获取当前前台应用名称。"""
    script = '''
        tell application "System Events"
            set frontApp to name of first process whose frontmost is true
        end tell
        return frontApp
    '''
    return run_applescript(script)


def activate_app(name: str):
    """激活指定应用。"""
    run_applescript(f'tell application "{name}" to activate')


def main():
    spike = SpikeRunner("A10: Window Focus", spike_id="spike_10")

    # ── Step 1: 检查 Windsurf 是否运行 ──────────────────────────────────
    spike.step("检查 Windsurf 进程是否存在")
    try:
        script = '''
            tell application "System Events"
                set appList to name of every process
            end tell
            return appList as text
        '''
        apps = run_applescript(script)
        # Windsurf 可能以 "Windsurf" 或 "Electron" 等名称出现
        windsurf_names = ["Windsurf", "Cursor"]  # 兼容 Cursor 用于测试
        found_name = None
        for name in windsurf_names:
            if name.lower() in apps.lower():
                found_name = name
                break

        if found_name:
            spike.debug(f"找到应用: {found_name}")
            spike.pass_step(f"应用 '{found_name}' 正在运行")
        else:
            spike.warn(f"Windsurf/Cursor 未找到，已知进程列表:")
            # 列出可能相关的进程
            for app in apps.split(", "):
                if any(kw in app.lower() for kw in ["wind", "code", "cursor", "electron"]):
                    spike.debug(f"  相关进程: {app}")
            spike.fail_step("未找到 Windsurf 或 Cursor 进程")
            spike.summary()
            return
    except Exception as e:
        spike.fail_step(f"进程检查失败: {e}")
        spike.summary()
        return

    target_app = found_name

    # ── Step 2: 获取当前前台应用 ─────────────────────────────────────────
    spike.step("获取当前前台应用")
    try:
        front = get_frontmost_app()
        spike.debug(f"当前前台: {front}")
        spike.pass_step(f"当前前台应用: {front}")
    except Exception as e:
        spike.fail_step(f"获取前台应用失败: {e}")

    # ── Step 3: 切换到 Finder（制造焦点变化） ───────────────────────────
    spike.step("切换到 Finder（制造焦点变化）")
    try:
        activate_app("Finder")
        time.sleep(0.5)
        front_after = get_frontmost_app()
        spike.debug(f"切换后前台: {front_after}")
        if "finder" in front_after.lower():
            spike.pass_step("成功切换到 Finder")
        else:
            spike.warn(f"切换后前台不是 Finder 而是: {front_after}")
            spike.pass_step(f"切换后前台: {front_after}")
    except Exception as e:
        spike.fail_step(f"切换到 Finder 失败: {e}")

    # ── Step 4: 激活 Windsurf ────────────────────────────────────────────
    spike.step(f"激活 {target_app}")
    try:
        with spike.timer(f"activate {target_app}"):
            activate_app(target_app)
        time.sleep(0.5)

        front_after = get_frontmost_app()
        spike.debug(f"激活后前台: {front_after}")

        if target_app.lower() in front_after.lower():
            spike.pass_step(f"{target_app} 成为前台应用 ✓")
        else:
            spike.fail_step(f"激活后前台不是 {target_app} 而是 {front_after}")
    except Exception as e:
        spike.fail_step(f"激活 {target_app} 失败: {e}")

    # ── Step 5: 获取窗口详细信息 ─────────────────────────────────────────
    spike.step(f"获取 {target_app} 窗口信息")
    try:
        info = get_window_info(target_app)
        spike.debug(f"窗口信息: {info}")

        if "error" in info:
            spike.fail_step(f"获取窗口信息失败: {info['error']}")
        else:
            spike.debug(f"位置: ({info['x']}, {info['y']})")
            spike.debug(f"尺寸: {info['width']}x{info['height']}")
            spike.debug(f"前台: {info['frontmost']}")
            spike.debug(f"窗口 ID: {info.get('window_id', 'N/A')}")
            spike.save_artifact("window_info.json", info)
            spike.pass_step(
                f"位置=({info['x']},{info['y']}), "
                f"尺寸={info['width']}x{info['height']}, "
                f"前台={info['frontmost']}"
            )
    except Exception as e:
        spike.fail_step(f"获取窗口信息失败: {e}")

    # ── Step 6: 快速焦点切换压力测试 ────────────────────────────────────
    spike.step("焦点切换压力测试 (Finder ↔ Windsurf × 3)")
    success_count = 0
    total = 3
    for i in range(total):
        try:
            activate_app("Finder")
            time.sleep(0.3)
            activate_app(target_app)
            time.sleep(0.3)
            front = get_frontmost_app()
            ok = target_app.lower() in front.lower()
            spike.debug(f"  #{i+1}: {'✓' if ok else '✗'} (前台: {front})")
            if ok:
                success_count += 1
        except Exception as e:
            spike.debug(f"  #{i+1}: 异常 - {e}")

    if success_count == total:
        spike.pass_step(f"全部 {total}/{total} 次切换成功")
    elif success_count > 0:
        spike.fail_step(f"部分成功: {success_count}/{total}", fatal=False)
    else:
        spike.fail_step(f"全部失败: 0/{total}")

    spike.summary()


if __name__ == "__main__":
    main()
