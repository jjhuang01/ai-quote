#!/usr/bin/env python3
"""gui-agent.py — 感知型 Windsurf Cascade GUI 自动化 CLI。

用法:
  python3 gui-agent.py status                # 读取 Cascade 状态
  python3 gui-agent.py send "消息"            # 发送消息 + 验证
  python3 gui-agent.py new-tab "消息"         # 新建会话 + 可选发送
  python3 gui-agent.py read-state            # OCR 读取面板状态
  python3 gui-agent.py dismiss-dialog        # 关闭弹窗

选项:
  --verbose / --quiet    控制终端输出详细程度
  --json                 仅输出 JSON（供程序调用）

输出: JSON 格式的 CommandResult
"""

import argparse
import json
import sys
import time

# 确保导入路径
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))

from gui_agent.config import Config
from gui_agent.logger import AgentLogger
from gui_agent.coordinator import Coordinator
from gui_agent.calibrator import run_calibration
from gui_agent.perception import Perception


def main():
    parser = argparse.ArgumentParser(
        description="GUI Agent — 感知型 Windsurf Cascade GUI 自动化",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("command",
                        choices=["status", "send", "new-tab", "read-state",
                                 "dismiss-dialog", "calibrate"],
                        help="要执行的命令")
    parser.add_argument("message", nargs="?", default=None,
                        help="要发送的消息 (send / new-tab 命令)")
    parser.add_argument("--verbose", action="store_true", default=True,
                        help="详细输出 (默认)")
    parser.add_argument("--quiet", action="store_true",
                        help="安静模式（仅 JSON 输出）")
    parser.add_argument("--json", action="store_true",
                        help="仅输出 JSON")
    parser.add_argument("--visual", action="store_true",
                        help="可视化模式: 红框标注 + 网格 + Preview + 延迟展示")
    parser.add_argument("--delay", type=float, default=None,
                        help="可视化延迟秒数 (默认 2.0)")

    args = parser.parse_args()
    verbose = not (args.quiet or args.json)

    config = Config()
    # --visual 模式运行时设置
    if args.visual:
        object.__setattr__(config, 'visual_mode', True)
    if args.delay is not None:
        object.__setattr__(config, 'visual_delay', args.delay)

    logger = AgentLogger("cli", config, verbose=verbose)
    coord = Coordinator(config, logger)

    start = time.time()

    # calibrate 命令单独处理 (交互式, 不走 Coordinator)
    if args.command == "calibrate":
        perception = Perception(config, logger)
        cal = run_calibration(perception)
        sys.exit(0 if cal else 1)

    if args.command == "status":
        result = coord.status()
    elif args.command == "send":
        if not args.message:
            parser.error("send 命令需要消息参数")
        result = coord.send(args.message)
    elif args.command == "new-tab":
        result = coord.new_tab(args.message)
    elif args.command == "read-state":
        result = coord.read_state()
    elif args.command == "dismiss-dialog":
        result = coord.dismiss_dialog()
    else:
        parser.error(f"未知命令: {args.command}")
        return

    # 输出 JSON
    output = result.to_json()
    print(json.dumps(output, indent=2, ensure_ascii=False))

    # 退出码: 成功=0, 失败=1
    sys.exit(0 if result.success else 1)


if __name__ == "__main__":
    main()
