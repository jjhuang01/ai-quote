"""操作层 — 鼠标 + 键盘 + 剪贴板 + 窗口控制。

职责:
  - 精确鼠标移动和点击 (Quartz CGEvent, 0px 误差)
  - 键盘输入 (AppleScript keystroke / key code)
  - 剪贴板读写 (pbcopy/pbpaste, 支持中文)
  - 窗口激活和焦点管理
  - 所有操作前后有 clipboard_guard 保护

不做感知，不做验证 — 单一职责。
"""

from __future__ import annotations

import subprocess
import time
from contextlib import contextmanager
from typing import Optional

from .config import Config, DEFAULT_CONFIG
from .logger import AgentLogger
from .models import ActionResult


class Action:
    """操作引擎 — GUI Agent 的手。"""

    def __init__(self, config: Config = DEFAULT_CONFIG, logger: Optional[AgentLogger] = None):
        self.cfg = config
        self.log = logger or AgentLogger("action", config)
        self._quartz = None
        self._init_quartz()

    def _init_quartz(self):
        try:
            import Quartz
            self._quartz = Quartz
            self.log.debug("Quartz mouse control available")
        except ImportError:
            self.log.warn("Quartz not available — falling back to AppleScript mouse")

    # ─── 窗口控制 ────────────────────────────────────────────────────────

    def activate_app(self, app_name: str) -> ActionResult:
        """激活指定应用（置前台）。"""
        start = time.time()
        try:
            self._run_applescript(f'tell application "{app_name}" to activate')
            time.sleep(self.cfg.action_settle_ms / 1000)
            elapsed = (time.time() - start) * 1000
            self.log.info(f"Activated {app_name}", elapsed_ms=elapsed)
            return ActionResult(success=True, action="activate_app", elapsed_ms=elapsed,
                                detail=app_name)
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            self.log.error(f"activate_app failed: {e}")
            return ActionResult(success=False, action="activate_app", elapsed_ms=elapsed,
                                error=str(e))

    def get_frontmost_app(self) -> Optional[str]:
        """获取当前前台应用名。"""
        try:
            result = self._run_applescript('''
                tell application "System Events"
                    return name of first process whose frontmost is true
                end tell
            ''')
            return result.strip()
        except Exception:
            return None

    # ─── 键盘操作 ────────────────────────────────────────────────────────

    def key_combo(self, key: str, modifiers: list[str] = None) -> ActionResult:
        """发送键盘组合键。

        Args:
            key: 键名或 key code (如 "l", "36" for Enter)
            modifiers: 修饰键列表 (如 ["command", "shift"])
        """
        start = time.time()
        mod_str = ""
        if modifiers:
            mod_str = " using " + " & ".join(f"{m} down" for m in modifiers)

        # key code 或 keystroke
        if key.isdigit():
            cmd = f'key code {key}{mod_str}'
        else:
            cmd = f'keystroke "{key}"{mod_str}'

        script = f'''
            tell application "System Events"
                {cmd}
            end tell
        '''
        try:
            self._run_applescript(script)
            elapsed = (time.time() - start) * 1000
            desc = f"{'+'.join(modifiers or [])}+{key}" if modifiers else key
            self.log.debug(f"Key: {desc}", elapsed_ms=elapsed)
            return ActionResult(success=True, action="key_combo", elapsed_ms=elapsed,
                                detail=desc)
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            return ActionResult(success=False, action="key_combo", elapsed_ms=elapsed,
                                error=str(e))

    def cmd_l(self) -> ActionResult:
        """发送 Cmd+L (聚焦/新建 Cascade)。"""
        return self.key_combo("l", ["command"])

    def enter(self) -> ActionResult:
        """发送 Enter 键。"""
        return self.key_combo("36")

    def escape(self) -> ActionResult:
        """发送 Escape 键。"""
        return self.key_combo("53")

    def select_all(self) -> ActionResult:
        """发送 Cmd+A 全选。"""
        return self.key_combo("a", ["command"])

    def paste(self) -> ActionResult:
        """发送 Cmd+V 粘贴。"""
        return self.key_combo("v", ["command"])

    def type_text(self, text: str) -> ActionResult:
        """通过 AppleScript keystroke 输入纯 ASCII 文本。"""
        start = time.time()
        # 转义特殊字符
        escaped = text.replace('\\', '\\\\').replace('"', '\\"')
        try:
            self._run_applescript(f'''
                tell application "System Events"
                    keystroke "{escaped}"
                end tell
            ''')
            elapsed = (time.time() - start) * 1000
            return ActionResult(success=True, action="type_text", elapsed_ms=elapsed,
                                detail=f"len={len(text)}")
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            return ActionResult(success=False, action="type_text", elapsed_ms=elapsed,
                                error=str(e))

    # ─── 鼠标操作 ────────────────────────────────────────────────────────

    def move_mouse(self, x: int, y: int) -> ActionResult:
        """移动鼠标到指定屏幕逻辑坐标。"""
        start = time.time()
        if self._quartz:
            event = self._quartz.CGEventCreateMouseEvent(
                None, self._quartz.kCGEventMouseMoved,
                self._quartz.CGPointMake(x, y), 0,
            )
            self._quartz.CGEventPost(self._quartz.kCGHIDEventTap, event)
        else:
            # AppleScript fallback
            self._run_applescript(f'''
                tell application "System Events"
                    set position of mouse to {{{x}, {y}}}
                end tell
            ''')
        elapsed = (time.time() - start) * 1000
        return ActionResult(success=True, action="move_mouse", elapsed_ms=elapsed,
                            detail=f"({x},{y})")

    def click(self, x: int, y: int) -> ActionResult:
        """在指定坐标点击。"""
        start = time.time()
        if self._quartz:
            point = self._quartz.CGPointMake(x, y)
            # Mouse down
            event = self._quartz.CGEventCreateMouseEvent(
                None, self._quartz.kCGEventLeftMouseDown, point, 0,
            )
            self._quartz.CGEventPost(self._quartz.kCGHIDEventTap, event)
            time.sleep(0.05)
            # Mouse up
            event = self._quartz.CGEventCreateMouseEvent(
                None, self._quartz.kCGEventLeftMouseUp, point, 0,
            )
            self._quartz.CGEventPost(self._quartz.kCGHIDEventTap, event)
        else:
            self._run_applescript(f'''
                tell application "System Events"
                    click at {{{x}, {y}}}
                end tell
            ''')
        elapsed = (time.time() - start) * 1000
        self.log.debug(f"Click ({x},{y})", elapsed_ms=elapsed)
        return ActionResult(success=True, action="click", elapsed_ms=elapsed,
                            detail=f"({x},{y})")

    def get_mouse_position(self) -> tuple[int, int]:
        """获取当前鼠标位置。"""
        if self._quartz:
            event = self._quartz.CGEventCreate(None)
            point = self._quartz.CGEventGetLocation(event)
            return int(point.x), int(point.y)
        return 0, 0

    # ─── 剪贴板操作 ──────────────────────────────────────────────────────

    def clipboard_get(self) -> str:
        """读取剪贴板内容。"""
        try:
            result = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=3)
            return result.stdout
        except Exception:
            return ""

    def clipboard_set(self, text: str):
        """写入剪贴板内容（支持中文）。"""
        subprocess.run(
            ["pbcopy"], input=text.encode("utf-8"),
            capture_output=True, timeout=3,
        )

    @contextmanager
    def clipboard_guard(self):
        """保护剪贴板：操作前保存，结束后恢复。"""
        original = self.clipboard_get()
        self.log.debug("Clipboard saved")
        try:
            yield
        finally:
            self.clipboard_set(original)
            self.log.debug("Clipboard restored")

    def paste_text(self, text: str) -> ActionResult:
        """通过剪贴板粘贴文本（支持中文）。

        这是发送非 ASCII 文本的唯一可靠方式。
        """
        start = time.time()
        with self.clipboard_guard():
            self.clipboard_set(text)
            time.sleep(0.05)
            result = self.paste()
            if not result.success:
                return result
        elapsed = (time.time() - start) * 1000
        return ActionResult(success=True, action="paste_text", elapsed_ms=elapsed,
                            detail=f"len={len(text)}")

    # ─── 复合操作 ────────────────────────────────────────────────────────

    def focus_input_and_paste(self, text: str) -> ActionResult:
        """聚焦 Cascade 输入框 + 粘贴消息。

        流程: Cmd+L → Cmd+A → 剪贴板写入 → Cmd+V
        """
        start = time.time()
        steps = []

        # 聚焦
        r = self.cmd_l()
        steps.append(r)
        if not r.success:
            return ActionResult(success=False, action="focus_input_and_paste",
                                elapsed_ms=(time.time() - start) * 1000,
                                error="cmd_l failed")
        time.sleep(0.3)

        # 全选 (清除旧内容)
        r = self.select_all()
        steps.append(r)
        time.sleep(0.1)

        # 粘贴
        with self.clipboard_guard():
            self.clipboard_set(text)
            time.sleep(0.05)
            r = self.paste()
            steps.append(r)

        elapsed = (time.time() - start) * 1000
        return ActionResult(success=True, action="focus_input_and_paste",
                            elapsed_ms=elapsed, detail=f"steps={len(steps)}")

    def click_to_focus_and_paste(self, text: str, lx: int, ly: int) -> ActionResult:
        """通过标定坐标直接点击输入框聚焦 + 粘贴消息。

        Args:
            lx, ly: 输入框中心屏幕逻辑坐标 (来自 calibration.json)
        """
        start = time.time()

        # 点击输入框
        r = self.click(lx, ly)
        if not r.success:
            return ActionResult(success=False, action="click_to_focus_and_paste",
                                elapsed_ms=(time.time() - start) * 1000,
                                error="click failed")
        time.sleep(0.15)

        # 全选旧内容
        r = self.select_all()
        time.sleep(0.05)

        # 粘贴
        with self.clipboard_guard():
            self.clipboard_set(text)
            time.sleep(0.05)
            r = self.paste()

        elapsed = (time.time() - start) * 1000
        return ActionResult(success=True, action="click_to_focus_and_paste",
                            elapsed_ms=elapsed,
                            detail=f"click=({lx},{ly}) len={len(text)}")

    def send_message(self, text: str) -> ActionResult:
        """完整发送消息：聚焦 → 粘贴 → Enter。"""
        start = time.time()

        r = self.focus_input_and_paste(text)
        if not r.success:
            return r
        time.sleep(0.2)

        r = self.enter()
        if not r.success:
            elapsed = (time.time() - start) * 1000
            return ActionResult(success=False, action="send_message",
                                elapsed_ms=elapsed, error="enter failed")

        elapsed = (time.time() - start) * 1000
        self.log.info(f"Message sent: '{text[:50]}...'", elapsed_ms=elapsed)
        return ActionResult(success=True, action="send_message",
                            elapsed_ms=elapsed, detail=f"len={len(text)}")

    def new_session(self) -> ActionResult:
        """Cmd+L×2 新建 Cascade 会话。"""
        start = time.time()
        r1 = self.cmd_l()
        time.sleep(0.5)
        r2 = self.cmd_l()
        time.sleep(0.5)
        elapsed = (time.time() - start) * 1000
        success = r1.success and r2.success
        return ActionResult(success=success, action="new_session",
                            elapsed_ms=elapsed)

    # ─── AppleScript 执行 ────────────────────────────────────────────────

    def _run_applescript(self, script: str) -> str:
        """执行 AppleScript 并返回输出。"""
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True,
            timeout=self.cfg.applescript_timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(f"AppleScript error: {result.stderr.strip()}")
        return result.stdout.strip()
