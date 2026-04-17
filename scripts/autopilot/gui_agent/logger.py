"""结构化日志 — 可观测性核心。

设计:
  - JSON 结构化日志写文件 (机器可读)
  - 彩色终端输出 (人类可读)
  - 每次操作带 trace_id 串联调用链
  - 支持 performance metric 自动收集
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from .config import Config, DEFAULT_CONFIG


class _Colors:
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    DIM    = "\033[2m"
    RED    = "\033[91m"
    GREEN  = "\033[92m"
    YELLOW = "\033[93m"
    BLUE   = "\033[94m"
    CYAN   = "\033[96m"


class AgentLogger:
    """GUI Agent 结构化日志器。

    用法:
        log = AgentLogger("perception")
        log.info("OCR completed", texts=143, elapsed_ms=1048)
        with log.timer("ocr_recognize"):
            ...
    """

    def __init__(self, component: str, config: Config = DEFAULT_CONFIG,
                 trace_id: Optional[str] = None, verbose: bool = True):
        self.component = component
        self.config = config
        self.trace_id = trace_id or uuid.uuid4().hex[:8]
        self.verbose = verbose
        self._metrics: list[dict] = []

        # 日志文件
        today = datetime.now().strftime("%Y-%m-%d")
        self._log_file = config.log_dir / f"gui-agent-{today}.jsonl"

    def _write(self, level: str, msg: str, **kwargs: Any):
        """写入结构化日志。"""
        record = {
            "ts": datetime.now().isoformat(),
            "trace": self.trace_id,
            "component": self.component,
            "level": level,
            "msg": msg,
        }
        record.update(kwargs)

        # 写文件
        try:
            with open(self._log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception:
            pass  # 日志不应阻塞业务

        # 终端输出
        if self.verbose:
            self._print(level, msg, kwargs)

    def _print(self, level: str, msg: str, extra: dict):
        ts = datetime.now().strftime("%H:%M:%S")
        colors = {
            "debug": _Colors.DIM,
            "info": _Colors.CYAN,
            "warn": _Colors.YELLOW,
            "error": _Colors.RED,
            "metric": _Colors.BLUE,
        }
        c = colors.get(level, "")
        prefix = f"[{ts}] [{self.component}]"
        extra_str = ""
        if extra:
            parts = [f"{k}={v}" for k, v in extra.items() if k not in ("ts", "trace", "component", "level", "msg")]
            if parts:
                extra_str = f" {_Colors.DIM}({', '.join(parts)}){_Colors.RESET}"
        print(f"{_Colors.CYAN}{prefix}{_Colors.RESET} {c}{msg}{_Colors.RESET}{extra_str}", file=sys.stderr)

    def debug(self, msg: str, **kwargs):
        self._write("debug", msg, **kwargs)

    def info(self, msg: str, **kwargs):
        self._write("info", msg, **kwargs)

    def warn(self, msg: str, **kwargs):
        self._write("warn", msg, **kwargs)

    def error(self, msg: str, **kwargs):
        self._write("error", msg, **kwargs)

    def metric(self, name: str, value: float, unit: str = "ms", **kwargs):
        """记录性能指标。"""
        self._metrics.append({"name": name, "value": value, "unit": unit})
        self._write("metric", f"⏱ {name}={value:.1f}{unit}", **kwargs)

    @contextmanager
    def timer(self, name: str):
        """计时上下文管理器，自动记录 metric。"""
        start = time.time()
        yield
        elapsed = (time.time() - start) * 1000
        self.metric(name, elapsed)

    def child(self, component: str) -> AgentLogger:
        """创建子日志器（共享 trace_id）。"""
        return AgentLogger(
            component=component,
            config=self.config,
            trace_id=self.trace_id,
            verbose=self.verbose,
        )

    @property
    def metrics_summary(self) -> dict:
        """返回收集的性能指标摘要。"""
        return {m["name"]: m["value"] for m in self._metrics}
