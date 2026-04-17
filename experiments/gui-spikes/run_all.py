#!/usr/bin/env python3
"""run_all.py — 批量运行 GUI Agent Spike 套件

用法:
  python3 run_all.py              # 运行安全层 (不会发送消息)
  python3 run_all.py --all        # 运行全部 (包括发送层)
  python3 run_all.py spike_01     # 运行指定 spike
  python3 run_all.py --layer 0    # 运行 Layer 0 (基础)
  python3 run_all.py --layer 1    # 运行 Layer 1 (感知)
  python3 run_all.py --layer 2    # 运行 Layer 2 (操作)
  python3 run_all.py --layer 3    # 运行 Layer 3 (集成, 需 --allow-send)
"""

import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent

# 层级定义
LAYERS = {
    0: {
        "name": "基础层",
        "spikes": ["spike_01_screenshot", "spike_02_resolution", "spike_10_window_focus"],
        "safe": True,
    },
    1: {
        "name": "感知层",
        "spikes": ["spike_03_multiscreen", "spike_04_ocr_basic", "spike_05_ocr_coords", "spike_06_grid_overlay"],
        "safe": True,
    },
    2: {
        "name": "操作层",
        "spikes": ["spike_07_mouse_click", "spike_08_clipboard_input", "spike_09_send_enter", "spike_11_new_session"],
        "safe": True,  # 默认安全模式
    },
    3: {
        "name": "集成层",
        "spikes": ["spike_12_perf_pipeline", "spike_13_verify_sent", "spike_14_at_conversation"],
        "safe": False,  # 需要 --allow-send
    },
}

# 颜色
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def run_spike(name: str, extra_args: list[str] = None) -> dict:
    """运行单个 spike 脚本。"""
    script = SCRIPT_DIR / f"{name}.py"
    if not script.exists():
        return {"name": name, "status": "missing", "error": f"文件不存在: {script}"}

    cmd = [sys.executable, str(script)] + (extra_args or [])
    start = time.time()
    try:
        result = subprocess.run(
            cmd, capture_output=False, text=True,
            timeout=120, cwd=str(SCRIPT_DIR),
        )
        elapsed = time.time() - start
        return {
            "name": name,
            "status": "pass" if result.returncode == 0 else "fail",
            "exit_code": result.returncode,
            "elapsed_s": round(elapsed, 1),
        }
    except subprocess.TimeoutExpired:
        return {"name": name, "status": "timeout", "elapsed_s": 120}
    except Exception as e:
        return {"name": name, "status": "error", "error": str(e)}


def main():
    args = sys.argv[1:]
    allow_send = "--allow-send" in args
    run_all_flag = "--all" in args

    # 确定要运行的 spikes
    target_spikes = []
    target_layer = None

    for arg in args:
        if arg.startswith("--layer"):
            idx = args.index(arg)
            if idx + 1 < len(args):
                target_layer = int(args[idx + 1])
        elif arg.startswith("spike_"):
            target_spikes.append(arg.replace(".py", ""))

    if target_spikes:
        # 运行指定的 spikes
        pass
    elif target_layer is not None:
        layer = LAYERS.get(target_layer)
        if layer:
            target_spikes = layer["spikes"]
        else:
            print(f"{RED}未知 layer: {target_layer}{RESET}")
            sys.exit(1)
    elif run_all_flag:
        for layer in LAYERS.values():
            target_spikes.extend(layer["spikes"])
    else:
        # 默认: 运行安全层 (Layer 0 + 1)
        for lid, layer in LAYERS.items():
            if layer["safe"]:
                target_spikes.extend(layer["spikes"])

    # 运行
    print(f"\n{CYAN}{BOLD}🔬 GUI Agent Spike 套件{RESET}")
    print(f"{DIM}{'═' * 60}{RESET}")
    print(f"目标: {len(target_spikes)} 个 spike")
    print(f"模式: {'完整 (--allow-send)' if allow_send else '安全 (不发送消息)'}")
    print(f"{DIM}{'═' * 60}{RESET}\n")

    results = []
    for name in target_spikes:
        extra = []
        if allow_send and name in ["spike_09_send_enter", "spike_13_verify_sent", "spike_14_at_conversation"]:
            extra.append("--allow-send")

        r = run_spike(name, extra)
        results.append(r)

        # 简短状态
        icon = {"pass": "✅", "fail": "❌", "timeout": "⏰", "error": "💥", "missing": "⚠️"}.get(r["status"], "?")
        elapsed = f" ({r.get('elapsed_s', '?')}s)" if "elapsed_s" in r else ""
        print(f"{icon} {name}{elapsed}")

    # 汇总
    print(f"\n{DIM}{'═' * 60}{RESET}")
    passed = sum(1 for r in results if r["status"] == "pass")
    failed = sum(1 for r in results if r["status"] == "fail")
    others = len(results) - passed - failed

    color = GREEN if failed == 0 else RED
    print(f"{color}{BOLD}汇总: {passed}/{len(results)} 通过, {failed} 失败, {others} 其他{RESET}\n")

    # 保存报告
    report = {
        "timestamp": datetime.now().isoformat(),
        "mode": "allow_send" if allow_send else "safe",
        "results": results,
        "summary": {"total": len(results), "passed": passed, "failed": failed, "others": others},
    }
    report_path = SCRIPT_DIR / "output" / "report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"📄 报告: {report_path}")

    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
