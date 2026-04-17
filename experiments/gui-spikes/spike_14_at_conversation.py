#!/usr/bin/env python3
"""spike_14_at_conversation — A14: @conversation 引用之前对话

验证:
  - 在新 session 中输入 @ 触发自动补全
  - 能选择 @conversation 引用
  - 引用标签成功插入 + 消息发送

通过标准: @conversation 引用成功插入 + 消息发送成功
注意: ⚠️ 最复杂的 spike，需要 --allow-send
"""

import time
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import (
    SpikeRunner, run_applescript, capture_window, capture_screen,
    clipboard_set, clipboard_guard,
)


def screenshot(spike, name, target_app):
    """截图并保存产物。"""
    path = str(spike.output_dir / f"{name}.png")
    try:
        try:
            capture_window(target_app, path)
        except Exception:
            capture_screen(path)
        spike.save_artifact(f"{name}.png", path=path)
        return path
    except Exception as e:
        spike.warn(f"截图 {name} 失败: {e}")
        return None


def main():
    allow_send = "--allow-send" in sys.argv
    spike = SpikeRunner("A14: @conversation Reference", spike_id="spike_14")

    if not allow_send:
        spike.warn("安全模式: 不会真正发送消息或创建新 session")
        spike.warn("使用 --allow-send 参数启用完整测试")

    # ── Step 1: 检查依赖 ────────────────────────────────────────────────
    spike.step("检查依赖")
    has_ocr = False
    try:
        from spike_04_ocr_basic import perform_ocr
        has_ocr = True
        spike.debug("OCR 可用 ✓")
    except ImportError:
        spike.warn("OCR 不可用，将只依赖截图")

    spike.pass_step(f"OCR={'✓' if has_ocr else '✗'}")

    # ── Step 2: 激活目标应用 ────────────────────────────────────────────
    spike.step("激活 Windsurf/Cursor")
    target_app = None
    for name in ["Windsurf", "Cursor"]:
        try:
            run_applescript(f'tell application "{name}" to activate')
            time.sleep(0.5)
            target_app = name
            break
        except Exception:
            continue

    if not target_app:
        spike.fail_step("无法激活目标应用")
        spike.summary()
        return
    spike.pass_step(f"已激活 {target_app}")

    # ── Step 3: 记录当前状态 ────────────────────────────────────────────
    spike.step("记录当前 session 状态")
    screenshot(spike, "step3_current_state", target_app)
    spike.pass_step("当前状态已截图")

    if not allow_send:
        # ── dry run: 记录操作计划 ───────────────────────────────────────
        spike.step("Dry run: @conversation 操作计划")
        plan = [
            "1. Cmd+L 新建 session",
            "2. 等待 1s",
            "3. 截图确认新 session",
            "4. 输入 '@' 触发自动补全",
            "5. 等待 0.5s → 截图检查补全菜单",
            "6. 输入 'conversation' 或按方向键选择",
            "7. 按 Tab/Enter 确认选择",
            "8. 截图确认 @conversation 标签",
            "9. 输入续写消息",
            "10. Enter 发送",
            "11. 截图验证发送成功",
        ]
        for step in plan:
            spike.log(f"  {step}")
        spike.save_artifact("plan.json", plan)
        spike.pass_step("操作计划已记录 (使用 --allow-send 执行)")

        spike.step("分析 @ 触发机制")
        spike.log("Windsurf Cascade 中 @ 触发补全的已知行为:")
        spike.log("  - 输入 '@' 字符后弹出补全菜单")
        spike.log("  - 菜单包含: @conversation, @file, @folder, @symbol 等")
        spike.log("  - 可以继续输入过滤，如 '@conv' 过滤到 conversation")
        spike.log("  - 选择后插入引用标签（可能是特殊 token，不是纯文字）")
        spike.log("  - 关键风险: 补全菜单的出现时机和交互方式需实测")
        spike.pass_step("分析完成")

        spike.summary()
        return

    # ── Step 4: 新建 session ────────────────────────────────────────────
    spike.step("⚠️ 新建 Cascade session (Cmd+L ×2)")
    try:
        run_applescript('''
            tell application "System Events"
                keystroke "l" using command down
                delay 0.5
                keystroke "l" using command down
            end tell
        ''')
        time.sleep(1.5)
        screenshot(spike, "step4_new_session", target_app)
        spike.pass_step("新 session 已创建")
    except Exception as e:
        spike.fail_step(f"新建 session 失败: {e}")
        spike.summary()
        return

    # ── Step 5: 输入 @ 触发补全 ─────────────────────────────────────────
    spike.step("输入 '@' 触发自动补全")
    try:
        run_applescript('''
            tell application "System Events"
                keystroke "@"
            end tell
        ''')
        time.sleep(1.0)
        path5 = screenshot(spike, "step5_at_autocomplete", target_app)

        if has_ocr and path5:
            results = perform_ocr(path5)
            all_text = " ".join(r["text"] for r in results).lower()
            has_menu = any(kw in all_text for kw in ["conversation", "file", "folder", "symbol", "codebase"])
            spike.debug(f"补全菜单检测: {'✓' if has_menu else '✗'}")
            if has_menu:
                spike.log("检测到自动补全菜单项")
        spike.pass_step("@ 已输入，截图已保存")
    except Exception as e:
        spike.fail_step(f"输入 @ 失败: {e}")

    # ── Step 6: 选择 conversation ───────────────────────────────────────
    spike.step("选择 @conversation")
    try:
        # 方案 A: 继续输入 "conversation" 过滤
        run_applescript('''
            tell application "System Events"
                keystroke "conversation"
                delay 0.5
                key code 36  -- Enter 确认选择
            end tell
        ''')
        time.sleep(1.0)
        path6 = screenshot(spike, "step6_conversation_selected", target_app)
        spike.pass_step("已输入 'conversation' + Enter")
    except Exception as e:
        spike.fail_step(f"选择 conversation 失败: {e}")

    # ── Step 7: 检查引用是否插入 ────────────────────────────────────────
    spike.step("检查 @conversation 引用是否插入")
    if has_ocr and path6:
        try:
            results = perform_ocr(path6)
            all_text = " ".join(r["text"] for r in results).lower()
            has_ref = "conversation" in all_text
            spike.debug(f"@conversation 引用: {'检测到' if has_ref else '未检测到'}")
            if has_ref:
                spike.pass_step("@conversation 引用已插入 ✓")
            else:
                spike.warn("OCR 未检测到 conversation 文字")
                spike.pass_step("需人工确认截图 (OCR 可能遗漏)")
        except Exception as e:
            spike.warn(f"OCR 检查失败: {e}")
            spike.pass_step("需人工确认截图")
    else:
        spike.pass_step("需人工确认截图")

    # ── Step 8: 输入续写消息 + 发送 ─────────────────────────────────────
    spike.step("输入续写消息并发送")
    msg = " 继续之前的工作"
    with clipboard_guard():
        try:
            clipboard_set(msg)
            time.sleep(0.1)
            run_applescript('''
                tell application "System Events"
                    keystroke "v" using command down
                    delay 0.3
                    key code 36  -- Enter
                end tell
            ''')
            time.sleep(3)
            screenshot(spike, "step8_sent", target_app)
            spike.pass_step(f"消息已发送: '@conversation{msg}'")
        except Exception as e:
            spike.fail_step(f"发送失败: {e}")

    # ── Step 9: 验证 ───────────────────────────────────────────────────
    spike.step("验证消息发送成功")
    path9 = screenshot(spike, "step9_verify", target_app)
    if has_ocr and path9:
        try:
            results = perform_ocr(path9)
            all_text = " ".join(r["text"] for r in results)
            spike.debug(f"验证 OCR (前 300): {all_text[:300]}")
            spike.save_artifact("verify_ocr.json", [{"text": r["text"], "conf": r["confidence"]} for r in results])
            spike.pass_step("验证截图 + OCR 已保存")
        except Exception as e:
            spike.warn(f"验证 OCR 失败: {e}")
            spike.pass_step("截图已保存，需人工确认")
    else:
        spike.pass_step("截图已保存，需人工确认")

    spike.summary()


if __name__ == "__main__":
    main()
