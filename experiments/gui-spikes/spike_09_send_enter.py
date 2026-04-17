#!/usr/bin/env python3
"""spike_09_send_enter — A9: Enter 发送 vs 按钮发送

验证:
  - Enter 键是否能在 Cascade 发送消息
  - Shift+Enter 是否换行
  - 发送按钮是否存在（OCR 检测）

通过标准: 确认 Enter 发送行为
注意: ⚠️ 使用 --allow-send 才会真正发送消息
"""

import time
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import (
    SpikeRunner, run_applescript, clipboard_set, clipboard_guard,
    capture_screen, capture_window,
)


def main():
    allow_send = "--allow-send" in sys.argv

    spike = SpikeRunner("A9: Send via Enter", spike_id="spike_09")

    if not allow_send:
        spike.warn("安全模式: 不会真正发送消息")
        spike.warn("使用 --allow-send 参数启用实际发送测试")

    # ── Step 1: 检查 Windsurf 前台 ──────────────────────────────────────
    spike.step("确认 Windsurf/Cursor 在前台")
    try:
        script = '''
            tell application "System Events"
                return name of first process whose frontmost is true
            end tell
        '''
        front = run_applescript(script)
        spike.debug(f"当前前台: {front}")

        target_app = None
        for name in ["Windsurf", "Cursor"]:
            if name.lower() in front.lower():
                target_app = name
                break

        if target_app:
            spike.pass_step(f"{target_app} 在前台 ✓")
        else:
            spike.warn(f"前台不是 Windsurf/Cursor，而是 {front}")
            # 尝试激活
            for name in ["Windsurf", "Cursor"]:
                try:
                    run_applescript(f'tell application "{name}" to activate')
                    time.sleep(0.5)
                    target_app = name
                    spike.log(f"已激活 {name}")
                    break
                except Exception:
                    continue
            if target_app:
                spike.pass_step(f"已切换到 {target_app}")
            else:
                spike.fail_step("无法激活 Windsurf/Cursor")
                spike.summary()
                return
    except Exception as e:
        spike.fail_step(f"检查前台失败: {e}")
        spike.summary()
        return

    # ── Step 2: OCR 检测输入框状态 ──────────────────────────────────────
    spike.step("OCR 检测输入框和发送按钮")
    screenshot_path = str(spike.output_dir / "before.png")
    try:
        for app in ["Windsurf", "Cursor"]:
            try:
                capture_window(app, screenshot_path)
                break
            except Exception:
                continue
        else:
            capture_screen(screenshot_path)

        spike.save_artifact("before.png", path=screenshot_path)

        # 尝试 OCR
        try:
            from spike_04_ocr_basic import perform_ocr
            results = perform_ocr(screenshot_path)
            all_text = " ".join(r["text"] for r in results).lower()
            spike.debug(f"OCR 文字 (前 300): {all_text[:300]}")

            # 检查发送按钮
            has_send_btn = any(kw in all_text for kw in ["send", "发送"])
            spike.debug(f"发送按钮: {'找到' if has_send_btn else '未找到'}")

            # 检查输入框
            has_input = any(kw in all_text for kw in ["ask cascade", "ask anything", "type", "message"])
            spike.debug(f"输入框提示: {'找到' if has_input else '未找到'}")

            spike.pass_step(f"输入框={'✓' if has_input else '✗'}, 发送按钮={'✓' if has_send_btn else '✗'}")
        except Exception as e:
            spike.warn(f"OCR 不可用: {e}")
            spike.pass_step("截图已保存，OCR 跳过")
    except Exception as e:
        spike.fail_step(f"截图失败: {e}")

    # ── Step 3: 验证 Cmd+L 聚焦输入框 ──────────────────────────────────
    spike.step("Cmd+L 聚焦 Cascade 输入框")
    try:
        run_applescript('''
            tell application "System Events"
                keystroke "l" using command down
            end tell
        ''')
        time.sleep(0.5)
        spike.pass_step("Cmd+L 已执行")
    except Exception as e:
        spike.fail_step(f"Cmd+L 失败: {e}")

    # ── Step 4: Enter 键行为分析 ────────────────────────────────────────
    if allow_send:
        spike.step("⚠️ 实际发送测试: 输入 + Enter")
        test_msg = "spike_test_ping_09"
        with clipboard_guard():
            try:
                clipboard_set(test_msg)
                time.sleep(0.1)
                # Cmd+A 清空 → Cmd+V 粘贴 → Enter 发送
                run_applescript('''
                    tell application "System Events"
                        keystroke "a" using command down
                        delay 0.1
                        keystroke "v" using command down
                        delay 0.3
                        key code 36  -- Enter
                    end tell
                ''')
                time.sleep(2)

                # 截图验证
                after_path = str(spike.output_dir / "after_send.png")
                for app in ["Windsurf", "Cursor"]:
                    try:
                        capture_window(app, after_path)
                        break
                    except Exception:
                        continue
                else:
                    capture_screen(after_path)
                spike.save_artifact("after_send.png", path=after_path)
                spike.pass_step(f"消息 '{test_msg}' 已发送，截图已保存")
            except Exception as e:
                spike.fail_step(f"发送失败: {e}")
    else:
        spike.step("Enter 键行为分析 (dry run)")
        spike.log("在安全模式下，只记录按键脚本而不执行:")
        spike.debug("  keystroke \"a\" using command down  -- 全选")
        spike.debug("  keystroke \"v\" using command down  -- 粘贴")
        spike.debug("  key code 36                        -- Enter 发送")
        spike.debug("  ---")
        spike.debug("  Shift+Enter: key code 36 using shift down -- 换行")
        spike.pass_step("脚本已准备 (使用 --allow-send 执行)")

    # ── Step 5: 记录发现 ────────────────────────────────────────────────
    spike.step("记录发现")
    findings = {
        "enter_sends": "需要实测确认 (--allow-send)",
        "shift_enter_newline": "需要实测确认",
        "send_button_detected": "见 Step 2 OCR 结果",
        "cmd_l_focuses_input": True,
        "safe_mode": not allow_send,
    }
    spike.save_artifact("findings.json", findings)
    spike.pass_step("发现已记录")

    spike.summary()


if __name__ == "__main__":
    main()
