#!/usr/bin/env python3
"""spike_13_verify_sent — A13: 发送后截图验证

验证:
  - 发送消息后能通过 OCR 确认消息已出现在对话区
  - 使用特征标记确保是当前消息
  - 前后 OCR 对比

通过标准: 特征标记出现在发送后的 OCR 结果中
注意: ⚠️ 需要 --allow-send 才会真正发送
"""

import time
import uuid
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import (
    SpikeRunner, run_applescript, capture_window, capture_screen,
    clipboard_set, clipboard_guard,
)


def main():
    allow_send = "--allow-send" in sys.argv
    spike = SpikeRunner("A13: Verify Sent Message", spike_id="spike_13")

    if not allow_send:
        spike.warn("安全模式: 不会真正发送消息")
        spike.warn("使用 --allow-send 参数启用实际发送测试")

    # ── Step 1: 检查 OCR 可用 ───────────────────────────────────────────
    spike.step("检查 OCR 可用性")
    try:
        from spike_04_ocr_basic import perform_ocr
        spike.pass_step("OCR 可用")
    except ImportError as e:
        spike.fail_step(f"OCR 不可用: {e}")
        spike.summary()
        return

    # ── Step 2: 激活目标应用 ────────────────────────────────────────────
    spike.step("激活 Windsurf/Cursor")
    target_app = None
    for name in ["Windsurf", "Cursor"]:
        try:
            run_applescript(f'tell application "{name}" to activate')
            time.sleep(0.5)
            target_app = name
            spike.pass_step(f"已激活 {name}")
            break
        except Exception:
            continue
    if not target_app:
        spike.fail_step("无法激活目标应用")
        spike.summary()
        return

    # ── Step 3: 发送前截图 + OCR ────────────────────────────────────────
    spike.step("发送前截图 + OCR 基线")
    before_path = str(spike.output_dir / "before.png")
    try:
        try:
            capture_window(target_app, before_path)
        except Exception:
            capture_screen(before_path)
        spike.save_artifact("before.png", path=before_path)

        before_results = perform_ocr(before_path)
        before_texts = set(r["text"] for r in before_results)
        spike.debug(f"基线 OCR: {len(before_texts)} 个文字片段")
        spike.pass_step(f"基线已建立: {len(before_texts)} 个片段")
    except Exception as e:
        spike.fail_step(f"基线截图失败: {e}")
        spike.summary()
        return

    if not allow_send:
        # ── dry run 模式 ────────────────────────────────────────────────
        spike.step("Dry run: 生成特征标记")
        marker = f"SPIKE13_{uuid.uuid4().hex[:8]}"
        spike.debug(f"特征标记: {marker}")
        spike.log("在 --allow-send 模式下，会:")
        spike.log(f"  1. 粘贴 '{marker}' 到输入框")
        spike.log("  2. 按 Enter 发送")
        spike.log("  3. 等待 3 秒")
        spike.log("  4. 截图 + OCR 搜索标记")
        spike.save_artifact("marker.txt", marker)
        spike.pass_step(f"标记已生成: {marker} (未发送)")

        spike.step("验证流程模拟完毕")
        spike.pass_step("使用 --allow-send 执行完整验证")
        spike.summary()
        return

    # ── Step 4: 发送带标记的消息 ────────────────────────────────────────
    spike.step("⚠️ 发送带特征标记的消息")
    marker = f"SPIKE13_{uuid.uuid4().hex[:8]}"
    spike.debug(f"特征标记: {marker}")
    spike.save_artifact("marker.txt", marker)

    with clipboard_guard():
        try:
            # 聚焦输入框
            run_applescript('''
                tell application "System Events"
                    keystroke "l" using command down
                end tell
            ''')
            time.sleep(0.5)

            # 粘贴 + 发送
            clipboard_set(marker)
            time.sleep(0.1)
            run_applescript('''
                tell application "System Events"
                    keystroke "a" using command down
                    delay 0.1
                    keystroke "v" using command down
                    delay 0.3
                    key code 36
                end tell
            ''')
            spike.log(f"已发送: {marker}")
            spike.pass_step(f"消息已发送: {marker}")
        except Exception as e:
            spike.fail_step(f"发送失败: {e}")
            spike.summary()
            return

    # ── Step 5: 等待 + 发送后截图 ───────────────────────────────────────
    spike.step("等待 3s + 发送后截图 + OCR")
    time.sleep(3)

    after_path = str(spike.output_dir / "after.png")
    try:
        try:
            capture_window(target_app, after_path)
        except Exception:
            capture_screen(after_path)
        spike.save_artifact("after.png", path=after_path)

        after_results = perform_ocr(after_path)
        after_texts = set(r["text"] for r in after_results)
        spike.debug(f"发送后 OCR: {len(after_texts)} 个片段")
        spike.pass_step(f"发送后截图: {len(after_texts)} 个片段")
    except Exception as e:
        spike.fail_step(f"发送后截图失败: {e}")
        spike.summary()
        return

    # ── Step 6: 搜索特征标记 ────────────────────────────────────────────
    spike.step("在 OCR 结果中搜索特征标记")
    all_after_text = " ".join(r["text"] for r in after_results)
    spike.debug(f"全部文字 (前 500): {all_after_text[:500]}")

    found = marker in all_after_text or marker.lower() in all_after_text.lower()

    # 也检查部分匹配（OCR 可能分段识别）
    partial_found = False
    marker_prefix = marker[:12]
    if marker_prefix in all_after_text:
        partial_found = True

    diff = {
        "marker": marker,
        "found_exact": found,
        "found_partial": partial_found,
        "new_texts": list(after_texts - before_texts)[:30],
        "before_count": len(before_texts),
        "after_count": len(after_texts),
    }
    spike.save_artifact("diff.json", diff)

    if found:
        spike.pass_step(f"✓ 特征标记 '{marker}' 在 OCR 结果中找到")
    elif partial_found:
        spike.pass_step(f"✓ 部分匹配 '{marker_prefix}' 找到 (OCR 可能分段)")
    else:
        spike.warn(f"未找到标记，新增文字: {diff['new_texts'][:5]}")
        spike.fail_step(f"特征标记 '{marker}' 未在 OCR 结果中找到", fatal=False)

    spike.summary()


if __name__ == "__main__":
    main()
