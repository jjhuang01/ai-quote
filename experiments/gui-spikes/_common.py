#!/usr/bin/env python3
"""共享工具模块 — GUI Agent Spike 套件的基础设施。

提供:
- SpikeRunner: 统一的步骤管理、日志、产物保存、汇总报告
- capture_screen / capture_window: 截图工具
- run_applescript: AppleScript 执行器
- get_window_info: 窗口位置查询
"""

import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Optional


# ─── 颜色常量 ─────────────────────────────────────────────────────────────────

class C:
    """终端颜色。"""
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    DIM    = "\033[2m"
    RED    = "\033[91m"
    GREEN  = "\033[92m"
    YELLOW = "\033[93m"
    BLUE   = "\033[94m"
    CYAN   = "\033[96m"
    GRAY   = "\033[90m"


# ─── SpikeRunner ──────────────────────────────────────────────────────────────

class SpikeRunner:
    """统一的 spike 步骤管理器。

    用法:
        spike = SpikeRunner("A1: Screenshot Capture")
        spike.step("检查 screencapture")
        spike.pass_step("存在")
        spike.summary()
    """

    def __init__(self, name: str, spike_id: str = ""):
        self.name = name
        self.spike_id = spike_id or name.split(":")[0].strip().lower().replace(" ", "_")
        self.steps: list[dict] = []
        self._current_step: Optional[str] = None
        self._step_start: float = 0
        self._step_num: int = 0
        self._start_time: float = time.time()

        # output 目录
        self.output_dir = Path(__file__).parent / "output" / self.spike_id
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # 打印 header
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"\n{C.CYAN}[{ts}]{C.RESET} {C.BOLD}🔬 {self.name}{C.RESET}")
        print(f"{C.GRAY}{'─' * 60}{C.RESET}")

    def step(self, name: str):
        """开始一个新步骤。"""
        self._step_num += 1
        self._current_step = name
        self._step_start = time.time()
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"{C.CYAN}[{ts}]{C.RESET}   ├─ {C.BOLD}Step {self._step_num}: {name}{C.RESET}")

    def pass_step(self, detail: str = ""):
        """当前步骤通过。"""
        elapsed = (time.time() - self._step_start) * 1000
        msg = f"✅ {detail}" if detail else "✅ 通过"
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"{C.CYAN}[{ts}]{C.RESET}   │  {C.GREEN}{msg}{C.RESET} {C.DIM}({elapsed:.0f}ms){C.RESET}")
        self.steps.append({
            "num": self._step_num,
            "name": self._current_step,
            "status": "pass",
            "detail": detail,
            "elapsed_ms": round(elapsed, 1),
        })

    def fail_step(self, detail: str = "", fatal: bool = True):
        """当前步骤失败。

        Args:
            detail: 失败详情
            fatal: 如果 True，在 summary 时 exit(1)
        """
        elapsed = (time.time() - self._step_start) * 1000
        msg = f"❌ {detail}" if detail else "❌ 失败"
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"{C.CYAN}[{ts}]{C.RESET}   │  {C.RED}{msg}{C.RESET} {C.DIM}({elapsed:.0f}ms){C.RESET}")
        self.steps.append({
            "num": self._step_num,
            "name": self._current_step,
            "status": "fail",
            "detail": detail,
            "elapsed_ms": round(elapsed, 1),
            "fatal": fatal,
        })

    def skip_step(self, reason: str = ""):
        """跳过当前步骤。"""
        msg = f"⏭️  跳过: {reason}" if reason else "⏭️  跳过"
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"{C.CYAN}[{ts}]{C.RESET}   │  {C.YELLOW}{msg}{C.RESET}")
        self.steps.append({
            "num": self._step_num,
            "name": self._current_step,
            "status": "skip",
            "detail": reason,
            "elapsed_ms": 0,
        })

    def log(self, msg: str):
        """信息日志。"""
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"{C.CYAN}[{ts}]{C.RESET}   │  {msg}")

    def debug(self, msg: str):
        """debug 日志。"""
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"{C.CYAN}[{ts}]{C.RESET}   │  {C.GRAY}🔍 {msg}{C.RESET}")

    def warn(self, msg: str):
        """警告日志。"""
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"{C.CYAN}[{ts}]{C.RESET}   │  {C.YELLOW}⚠️  {msg}{C.RESET}")

    def save_artifact(self, name: str, data: Any = None, path: Optional[str] = None):
        """保存 debug 产物到 output/<spike>/ 目录。

        Args:
            name: 文件名（如 screenshot.png）
            data: 要写入的数据（dict → JSON, str → 文本, bytes → 二进制）
            path: 如果提供，从此路径复制（data 忽略）
        """
        dest = self.output_dir / name
        if path:
            import shutil
            src = Path(path).resolve()
            dst = dest.resolve()
            if src != dst:
                shutil.copy2(path, dest)
        elif isinstance(data, dict) or isinstance(data, list):
            dest.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        elif isinstance(data, bytes):
            dest.write_bytes(data)
        elif isinstance(data, str):
            dest.write_text(data, encoding="utf-8")
        self.log(f"📁 产物保存: {dest.relative_to(Path(__file__).parent)}")
        return str(dest)

    @contextmanager
    def timer(self, label: str = ""):
        """计时上下文管理器。"""
        start = time.time()
        yield
        elapsed = (time.time() - start) * 1000
        if label:
            self.debug(f"⏱️  {label}: {elapsed:.0f}ms")

    def summary(self):
        """打印汇总 + 保存报告 + 设置退出码。"""
        total_elapsed = (time.time() - self._start_time) * 1000
        passed = sum(1 for s in self.steps if s["status"] == "pass")
        failed = sum(1 for s in self.steps if s["status"] == "fail")
        skipped = sum(1 for s in self.steps if s["status"] == "skip")
        total = len(self.steps)

        print(f"{C.GRAY}{'─' * 60}{C.RESET}")
        color = C.GREEN if failed == 0 else C.RED
        icon = "🎉" if failed == 0 else "💥"
        print(
            f"   {icon} {color}{C.BOLD}汇总: {passed}/{total} 通过"
            f", {failed} 失败, {skipped} 跳过{C.RESET}"
            f" {C.DIM}(总耗时 {total_elapsed:.0f}ms){C.RESET}\n"
        )

        # 保存 JSON 报告
        report = {
            "spike": self.name,
            "spike_id": self.spike_id,
            "timestamp": datetime.now().isoformat(),
            "total_elapsed_ms": round(total_elapsed, 1),
            "passed": passed,
            "failed": failed,
            "skipped": skipped,
            "steps": self.steps,
        }
        report_path = self.output_dir / "report.json"
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

        has_fatal = any(s.get("fatal") for s in self.steps if s["status"] == "fail")
        sys.exit(1 if has_fatal else 0)


# ─── 截图工具 ─────────────────────────────────────────────────────────────────

def capture_screen(output_path: str, display_id: Optional[int] = None) -> dict:
    """截取全屏。

    Returns:
        {"path": str, "elapsed_ms": float, "size_bytes": int, "width": int, "height": int}
    """
    start = time.time()
    cmd = ["screencapture", "-x", "-C", "-t", "png"]
    if display_id is not None:
        cmd.extend(["-D", str(display_id)])
    cmd.append(output_path)

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    elapsed = (time.time() - start) * 1000

    if result.returncode != 0:
        raise RuntimeError(f"screencapture failed: {result.stderr}")

    path = Path(output_path)
    if not path.exists() or path.stat().st_size == 0:
        raise RuntimeError(f"screencapture produced empty file: {output_path}")

    size_bytes = path.stat().st_size

    # 尝试用 sips 获取尺寸（macOS 原生，无需 Pillow）
    width, height = 0, 0
    try:
        sips = subprocess.run(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", output_path],
            capture_output=True, text=True, timeout=5,
        )
        for line in sips.stdout.splitlines():
            if "pixelWidth" in line:
                width = int(line.split(":")[-1].strip())
            elif "pixelHeight" in line:
                height = int(line.split(":")[-1].strip())
    except Exception:
        pass

    return {
        "path": output_path,
        "elapsed_ms": round(elapsed, 1),
        "size_bytes": size_bytes,
        "width": width,
        "height": height,
    }


def capture_window(app_name: str, output_path: str) -> dict:
    """截取指定应用窗口。

    Returns:
        与 capture_screen 相同的 dict + window_id
    """
    # 获取窗口 ID
    window_id = _get_window_id(app_name)
    if not window_id:
        raise RuntimeError(f"未找到 {app_name} 窗口")

    start = time.time()
    cmd = ["screencapture", "-x", "-C", "-t", "png", "-l", str(window_id), output_path]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    elapsed = (time.time() - start) * 1000

    if result.returncode != 0:
        raise RuntimeError(f"screencapture -l failed: {result.stderr}")

    path = Path(output_path)
    if not path.exists() or path.stat().st_size == 0:
        raise RuntimeError(f"screencapture produced empty file")

    size_bytes = path.stat().st_size
    width, height = 0, 0
    try:
        sips = subprocess.run(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", output_path],
            capture_output=True, text=True, timeout=5,
        )
        for line in sips.stdout.splitlines():
            if "pixelWidth" in line:
                width = int(line.split(":")[-1].strip())
            elif "pixelHeight" in line:
                height = int(line.split(":")[-1].strip())
    except Exception:
        pass

    return {
        "path": output_path,
        "elapsed_ms": round(elapsed, 1),
        "size_bytes": size_bytes,
        "width": width,
        "height": height,
        "window_id": window_id,
    }


def _get_window_id(app_name: str) -> Optional[int]:
    """通过 AppleScript 获取应用主窗口 ID。

    使用 CGWindowListCopyWindowInfo 通过 Python Quartz 绑定。
    回退方案：AppleScript。
    """
    try:
        # 优先使用 Quartz（更可靠）
        from Quartz import (
            CGWindowListCopyWindowInfo,
            kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
            kCGWindowListExcludeDesktopElements,
        )
        windows = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )
        for w in windows:
            owner = w.get("kCGWindowOwnerName", "")
            name = w.get("kCGWindowName", "")
            layer = w.get("kCGWindowLayer", 999)
            if app_name.lower() in owner.lower() and layer == 0:
                return w.get("kCGWindowNumber")
    except ImportError:
        pass

    # 回退: 用 osascript 获取窗口列表（不返回 window ID，但可以获取 PID）
    # screencapture -l 需要 CGWindowID，纯 AppleScript 拿不到
    # 此时只能截全屏
    return None


# ─── AppleScript 执行器 ──────────────────────────────────────────────────────

def run_applescript(script: str, timeout: float = 5.0) -> str:
    """执行 AppleScript 并返回 stdout。

    Raises:
        RuntimeError: 如果执行失败或超时
    """
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(f"AppleScript error: {result.stderr.strip()}")
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"AppleScript timeout after {timeout}s")


# ─── 窗口信息 ─────────────────────────────────────────────────────────────────

def get_window_info(app_name: str) -> dict:
    """获取应用窗口位置和大小。

    Returns:
        {"x": int, "y": int, "width": int, "height": int,
         "frontmost": bool, "window_id": int|None}
    """
    # 用 AppleScript 获取窗口 bounds（使用 | 分隔避免歧义）
    script = f'''
        tell application "System Events"
            set appProcess to first process whose name contains "{app_name}"
            set frontApp to name of first process whose frontmost is true
            tell appProcess
                set winPos to position of window 1
                set winSize to size of window 1
            end tell
        end tell
        set px to item 1 of winPos as text
        set py to item 2 of winPos as text
        set sx to item 1 of winSize as text
        set sy to item 2 of winSize as text
        return px & "|" & py & "|" & sx & "|" & sy & "|" & frontApp
    '''
    try:
        output = run_applescript(script, timeout=5.0)
        parts = [p.strip() for p in output.split("|")]
        if len(parts) >= 5:
            x, y, w, h = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
            front_app = "|".join(parts[4:]).strip()
            is_front = app_name.lower() in front_app.lower()
            window_id = _get_window_id(app_name)
            return {
                "x": x, "y": y, "width": w, "height": h,
                "frontmost": is_front, "window_id": window_id,
            }
        return {"error": f"unexpected output format: '{output}'"}
    except Exception as e:
        return {"error": str(e)}


# ─── 剪贴板工具 ──────────────────────────────────────────────────────────────

def clipboard_get() -> str:
    """获取当前剪贴板内容。"""
    try:
        result = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=3)
        return result.stdout
    except Exception:
        return ""


def clipboard_set(text: str):
    """设置剪贴板内容。"""
    subprocess.run(["pbcopy"], input=text, text=True, timeout=3)


@contextmanager
def clipboard_guard():
    """上下文管理器: 保存/恢复剪贴板内容。"""
    original = clipboard_get()
    try:
        yield
    finally:
        clipboard_set(original)
