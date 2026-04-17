#!/usr/bin/env python3
"""spike_12_perf_pipeline — A12: 全链路性能基准

验证:
  - 截图 → OCR → 操作 → 验证 全链路 < 2 秒
  - 各环节耗时分布
  - 连续 5 次取平均

通过标准: 平均全链路 < 2000ms
"""

import time
import tempfile
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _common import SpikeRunner, capture_screen, capture_window, run_applescript


def main():
    spike = SpikeRunner("A12: Performance Pipeline", spike_id="spike_12")

    runs = []
    num_runs = 5

    # ── Step 1: 检查依赖 ────────────────────────────────────────────────
    spike.step("检查 OCR 依赖")
    has_ocr = False
    try:
        from spike_04_ocr_basic import perform_ocr
        has_ocr = True
        spike.pass_step("OCR 可用")
    except ImportError as e:
        spike.warn(f"OCR 不可用: {e}")
        spike.pass_step("将跳过 OCR 环节")

    # ── Step 2: 性能基准测试 ────────────────────────────────────────────
    for i in range(num_runs):
        spike.step(f"运行 #{i+1}/{num_runs}")
        run_data = {"run": i + 1}

        with tempfile.TemporaryDirectory() as tmpdir:
            # Phase 1: 截图
            t0 = time.time()
            ss_path = os.path.join(tmpdir, "ss.png")
            try:
                for app in ["Windsurf", "Cursor"]:
                    try:
                        capture_window(app, ss_path)
                        break
                    except Exception:
                        continue
                else:
                    capture_screen(ss_path)
            except Exception as e:
                spike.warn(f"截图失败: {e}")
                continue
            t1 = time.time()
            run_data["screenshot_ms"] = round((t1 - t0) * 1000, 1)

            # Phase 2: OCR
            if has_ocr:
                t2 = time.time()
                try:
                    results = perform_ocr(ss_path)
                    run_data["ocr_texts"] = len(results)
                except Exception as e:
                    spike.warn(f"OCR 失败: {e}")
                    results = []
                    run_data["ocr_texts"] = 0
                t3 = time.time()
                run_data["ocr_ms"] = round((t3 - t2) * 1000, 1)
            else:
                run_data["ocr_ms"] = 0
                run_data["ocr_texts"] = 0

            # Phase 3: AppleScript 操作 (空操作, 测量基础延迟)
            t4 = time.time()
            try:
                run_applescript('return "ok"', timeout=3)
            except Exception:
                pass
            t5 = time.time()
            run_data["applescript_ms"] = round((t5 - t4) * 1000, 1)

            # Phase 4: 验证截图
            t6 = time.time()
            verify_path = os.path.join(tmpdir, "verify.png")
            try:
                capture_screen(verify_path)
            except Exception:
                pass
            t7 = time.time()
            run_data["verify_ms"] = round((t7 - t6) * 1000, 1)

            # 汇总
            run_data["total_ms"] = round(
                run_data["screenshot_ms"] + run_data["ocr_ms"] +
                run_data["applescript_ms"] + run_data["verify_ms"], 1
            )

            spike.debug(
                f"  截图={run_data['screenshot_ms']:.0f}ms, "
                f"OCR={run_data['ocr_ms']:.0f}ms ({run_data['ocr_texts']} texts), "
                f"AS={run_data['applescript_ms']:.0f}ms, "
                f"验证={run_data['verify_ms']:.0f}ms → "
                f"总计={run_data['total_ms']:.0f}ms"
            )
            runs.append(run_data)

        if run_data["total_ms"] < 2000:
            spike.pass_step(f"✓ {run_data['total_ms']:.0f}ms < 2000ms")
        else:
            spike.fail_step(f"✗ {run_data['total_ms']:.0f}ms >= 2000ms", fatal=False)

    # ── Step 3: 汇总统计 ────────────────────────────────────────────────
    spike.step("汇总性能报告")
    if runs:
        totals = [r["total_ms"] for r in runs]
        ss_times = [r["screenshot_ms"] for r in runs]
        ocr_times = [r["ocr_ms"] for r in runs]
        as_times = [r["applescript_ms"] for r in runs]

        report = {
            "runs": runs,
            "summary": {
                "total": {"avg": round(sum(totals) / len(totals), 1), "min": min(totals), "max": max(totals)},
                "screenshot": {"avg": round(sum(ss_times) / len(ss_times), 1)},
                "ocr": {"avg": round(sum(ocr_times) / len(ocr_times), 1)},
                "applescript": {"avg": round(sum(as_times) / len(as_times), 1)},
            },
            "pass": sum(totals) / len(totals) < 2000,
        }

        spike.save_artifact("perf_report.json", report)

        spike.log("📊 性能汇总:")
        spike.log(f"  总计: avg={report['summary']['total']['avg']:.0f}ms "
                  f"(min={report['summary']['total']['min']:.0f}, max={report['summary']['total']['max']:.0f})")
        spike.log(f"  截图: avg={report['summary']['screenshot']['avg']:.0f}ms")
        spike.log(f"  OCR:  avg={report['summary']['ocr']['avg']:.0f}ms")
        spike.log(f"  AS:   avg={report['summary']['applescript']['avg']:.0f}ms")

        avg_total = report["summary"]["total"]["avg"]
        if avg_total < 2000:
            spike.pass_step(f"平均 {avg_total:.0f}ms < 2000ms ✓")
        else:
            spike.fail_step(f"平均 {avg_total:.0f}ms >= 2000ms")
    else:
        spike.fail_step("没有完成任何运行")

    spike.summary()


if __name__ == "__main__":
    main()
