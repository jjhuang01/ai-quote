#!/usr/bin/env python3
"""spike_11_new_session — A11: Cmd+L 新建 Cascade 会话

验证:
  - Cmd+L 能聚焦 Cascade 输入框
  - 多次 Cmd+L 的行为（新建 vs 切换）
  - OCR 对比前后状态

通过标准: Cascade 输入框获得焦点或新建了空会话
"""

import time
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, run_applescript, capture_screen, capture_window


def main():
    spike = SpikeRunner("A11: New Session (Cmd+L)", spike_id="spike_11")

    target_app = None

    # ── Step 1: 激活 Windsurf ────────────────────────────────────────────
    spike.step("激活 Windsurf/Cursor")
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
        spike.fail_step("无法激活 Windsurf 或 Cursor")
        spike.summary()
        return

    # ── Step 2: 截图 before ─────────────────────────────────────────────
    spike.step("截图: Cmd+L 之前")
    before_path = str(spike.output_dir / "before.png")
    try:
        for app in [target_app]:
            try:
                capture_window(app, before_path)
                break
            except Exception:
                capture_screen(before_path)
        spike.save_artifact("before.png", path=before_path)
        spike.pass_step("before 截图已保存")
    except Exception as e:
        spike.fail_step(f"截图失败: {e}")

    # ── Step 3: 第一次 Cmd+L ────────────────────────────────────────────
    spike.step("执行第一次 Cmd+L")
    try:
        run_applescript('''
            tell application "System Events"
                keystroke "l" using command down
            end tell
        ''')
        time.sleep(1.0)

        after1_path = str(spike.output_dir / "after_cmdl_1.png")
        for app in [target_app]:
            try:
                capture_window(app, after1_path)
                break
            except Exception:
                capture_screen(after1_path)
        spike.save_artifact("after_cmdl_1.png", path=after1_path)
        spike.pass_step("第一次 Cmd+L 已执行 + 截图")
    except Exception as e:
        spike.fail_step(f"Cmd+L 失败: {e}")

    # ── Step 4: 第二次 Cmd+L ────────────────────────────────────────────
    spike.step("执行第二次 Cmd+L (可能新建会话)")
    try:
        run_applescript('''
            tell application "System Events"
                keystroke "l" using command down
            end tell
        ''')
        time.sleep(1.0)

        after2_path = str(spike.output_dir / "after_cmdl_2.png")
        for app in [target_app]:
            try:
                capture_window(app, after2_path)
                break
            except Exception:
                capture_screen(after2_path)
        spike.save_artifact("after_cmdl_2.png", path=after2_path)
        spike.pass_step("第二次 Cmd+L 已执行 + 截图")
    except Exception as e:
        spike.fail_step(f"第二次 Cmd+L 失败: {e}")

    # ── Step 5: OCR 对比分析 ────────────────────────────────────────────
    spike.step("OCR 对比前后状态")
    try:
        from spike_04_ocr_basic import perform_ocr

        before_text = set(r["text"] for r in perform_ocr(before_path))
        after1_text = set(r["text"] for r in perform_ocr(after1_path))
        after2_text = set(r["text"] for r in perform_ocr(after2_path))

        new_in_1 = after1_text - before_text
        new_in_2 = after2_text - after1_text

        spike.debug(f"before 文字数: {len(before_text)}")
        spike.debug(f"after1 文字数: {len(after1_text)}")
        spike.debug(f"after2 文字数: {len(after2_text)}")
        spike.debug(f"Cmd+L 1 新增: {list(new_in_1)[:10]}")
        spike.debug(f"Cmd+L 2 新增: {list(new_in_2)[:10]}")

        spike.save_artifact("ocr_diff.json", {
            "before_count": len(before_text),
            "after1_count": len(after1_text),
            "after2_count": len(after2_text),
            "new_after_cmdl_1": list(new_in_1)[:20],
            "new_after_cmdl_2": list(new_in_2)[:20],
        })
        spike.pass_step("OCR 对比完成，请检查 ocr_diff.json")
    except Exception as e:
        spike.warn(f"OCR 对比失败: {e}")
        spike.pass_step("截图已保存，需要人工对比")

    # ── Step 6: 总结发现 ────────────────────────────────────────────────
    spike.step("总结 Cmd+L 行为")
    spike.log("🔍 请手动检查截图对比:")
    spike.log(f"  1. {spike.output_dir}/before.png")
    spike.log(f"  2. {spike.output_dir}/after_cmdl_1.png")
    spike.log(f"  3. {spike.output_dir}/after_cmdl_2.png")
    spike.log("预期行为:")
    spike.log("  - Cmd+L 1次: 聚焦 Cascade 输入框")
    spike.log("  - Cmd+L 2次: 可能新建空会话")
    spike.pass_step("截图已保存，请人工确认")

    spike.summary()


if __name__ == "__main__":
    main()
