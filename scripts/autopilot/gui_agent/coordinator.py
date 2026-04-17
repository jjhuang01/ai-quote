"""编排层 — 感知-行动-验证循环。

职责:
  - 组合 Perception + Action + Verification 执行完整 CLI 命令
  - 实现重试逻辑 (最多 max_retries 次)
  - 收集 trace 级日志贯穿全流程
  - 返回 CommandResult JSON

设计:
  - Coordinator 不直接操作 GUI，只编排三层
  - 每个命令是一个 Perceive → Act → Verify 循环
  - 失败时 re-perceive 再决定是否重试
"""

from __future__ import annotations

import time
from typing import Optional

from .config import Config, DEFAULT_CONFIG
from .logger import AgentLogger
from .models import CascadeState, CommandResult
from .perception import Perception
from .action import Action
from .verification import Verification
from .calibrator import load_calibration


class Coordinator:
    """编排器 — GUI Agent 的大脑。"""

    def __init__(self, config: Config = DEFAULT_CONFIG, logger: Optional[AgentLogger] = None):
        self.cfg = config
        self.log = logger or AgentLogger("coordinator", config)
        self.perception = Perception(config, self.log.child("perception"))
        self.action = Action(config, self.log.child("action"))
        self.verification = Verification(config, self.log.child("verification"))
        # 加载标定数据 (若存在)
        self.calibration = load_calibration()
        if self.calibration:
            self.log.info(
                f"标定数据已加载: input=({self.calibration.input_box.lx},{self.calibration.input_box.ly})"
                f" send=({self.calibration.send_button.lx},{self.calibration.send_button.ly})"
                f" [{self.calibration.calibrated_at}]"
            )

    # ─── 公开命令 (对应 CLI) ─────────────────────────────────────────────

    def status(self) -> CommandResult:
        """读取 Cascade 当前状态。

        流程: 截图 → OCR → 解析状态 → 返回 JSON
        """
        start = time.time()
        self.log.info("Command: status")

        target = self._ensure_target_app()
        if target is None:
            return CommandResult(success=False, command="status",
                                error="target_app_not_found")

        state = self.perception.read_state(target)
        elapsed = (time.time() - start) * 1000

        self.log.info(f"Status: {state.state.value}", elapsed_ms=elapsed)
        return CommandResult(
            success=True, command="status",
            elapsed_ms=elapsed, state=state,
            verified=True,
        )

    def send(self, message: str) -> CommandResult:
        """发送消息到 Cascade。

        流程:
          1. 感知: 截图 + OCR 确认 Cascade 就绪
          2. 操作: 聚焦 → 粘贴 → Enter
          3. 验证: 截图 + OCR 确认消息已发送
          4. 重试: 失败时 re-perceive 再决定
        """
        start = time.time()
        self.log.info(f"Command: send (len={len(message)})")
        marker = self.verification.generate_marker()
        marked_message = f"{message}"  # 可选: 注入 marker 到消息中

        for attempt in range(1, self.cfg.max_retries + 1):
            self.log.info(f"Attempt {attempt}/{self.cfg.max_retries}")

            # Phase 1: Perceive
            target = self._ensure_target_app()
            if target is None:
                return CommandResult(success=False, command="send",
                                    error="target_app_not_found",
                                    elapsed_ms=(time.time() - start) * 1000)

            before_state = self.perception.read_state(target)
            if before_state.has_error:
                self.log.warn(f"Error detected: {before_state.error_type}")
                return CommandResult(
                    success=False, command="send",
                    error=before_state.error_type,
                    elapsed_ms=(time.time() - start) * 1000,
                    state=before_state,
                )

            # Phase 2: Act
            self.action.activate_app(target)
            if self.calibration:
                # 标定模式: 直接点击输入框 → 粘贴 → Enter
                self.log.info(
                    f"使用标定坐标: input=({self.calibration.input_box.lx},"
                    f"{self.calibration.input_box.ly})"
                )
                result = self.action.click_to_focus_and_paste(
                    message,
                    self.calibration.input_box.lx,
                    self.calibration.input_box.ly,
                )
                if result.success:
                    import time as _t; _t.sleep(0.2)
                    result = self.action.enter()
            else:
                # 无标定: Cmd+L 快捷键聚焦
                result = self.action.send_message(message)
            if not result.success:
                self.log.warn(f"send_message failed: {result.error}")
                time.sleep(self.cfg.retry_interval_ms / 1000)
                continue

            # Phase 3: Verify
            time.sleep(self.cfg.verify_wait_ms / 1000)
            after_state = self.perception.read_state(target)
            verify = self.verification.verify_send(marker, before_state, after_state)

            elapsed = (time.time() - start) * 1000
            if verify["verified"]:
                return CommandResult(
                    success=True, command="send",
                    elapsed_ms=elapsed, verified=True,
                    retries=attempt - 1,
                    state=after_state,
                    details={"marker": marker, "verification": verify},
                )
            else:
                self.log.warn(f"Verification failed on attempt {attempt}")
                if attempt < self.cfg.max_retries:
                    time.sleep(self.cfg.retry_interval_ms / 1000)

        elapsed = (time.time() - start) * 1000
        return CommandResult(
            success=False, command="send",
            elapsed_ms=elapsed, verified=False,
            retries=self.cfg.max_retries,
            error="verification_failed_after_retries",
            details={"marker": marker},
        )

    def new_tab(self, message: Optional[str] = None) -> CommandResult:
        """新建 Cascade 会话，可选发送消息。

        流程:
          1. 感知: 截图记录当前状态
          2. 操作: Cmd+L×2 新建会话
          3. 验证: 截图确认状态变化
          4. (可选) 发送消息
        """
        start = time.time()
        self.log.info("Command: new_tab")

        target = self._ensure_target_app()
        if target is None:
            return CommandResult(success=False, command="new_tab",
                                error="target_app_not_found")

        # Phase 1: Perceive
        self.action.activate_app(target)
        before_state = self.perception.read_state(target)

        # Phase 2: Act
        result = self.action.new_session()
        if not result.success:
            return CommandResult(success=False, command="new_tab",
                                elapsed_ms=(time.time() - start) * 1000,
                                error="new_session_failed")

        # Phase 3: Verify
        time.sleep(1)
        after_state = self.perception.read_state(target)
        verify = self.verification.verify_new_session(before_state, after_state)

        # Phase 4: (可选) 发送消息
        if message and verify["verified"]:
            send_result = self.send(message)
            elapsed = (time.time() - start) * 1000
            return CommandResult(
                success=send_result.success, command="new_tab",
                elapsed_ms=elapsed, verified=send_result.verified,
                state=send_result.state,
                details={"tab": "new", "message_sent": send_result.success,
                          "session_verification": verify},
            )

        elapsed = (time.time() - start) * 1000
        return CommandResult(
            success=verify["verified"], command="new_tab",
            elapsed_ms=elapsed, verified=verify["verified"],
            state=after_state,
            details={"tab": "new", "session_verification": verify},
        )

    def read_state(self) -> CommandResult:
        """OCR 读取 Cascade 面板最后回复。"""
        return self.status()

    def dismiss_dialog(self) -> CommandResult:
        """检测并关闭弹窗。

        流程:
          1. 感知: 检测是否有弹窗
          2. 操作: 按 Escape
          3. 验证: 弹窗消失
        """
        start = time.time()
        self.log.info("Command: dismiss_dialog")

        target = self._ensure_target_app()
        if target is None:
            return CommandResult(success=False, command="dismiss_dialog",
                                error="target_app_not_found")

        before_state = self.perception.read_state(target)
        if not before_state.has_dialog:
            self.log.info("No dialog detected")
            return CommandResult(
                success=True, command="dismiss_dialog",
                elapsed_ms=(time.time() - start) * 1000,
                state=before_state,
                details={"had_dialog": False},
            )

        # 尝试 Escape
        self.action.escape()
        time.sleep(0.5)

        after_state = self.perception.read_state(target)
        dismissed = not after_state.has_dialog

        elapsed = (time.time() - start) * 1000
        self.log.info(f"Dialog dismissed: {dismissed}")
        return CommandResult(
            success=dismissed, command="dismiss_dialog",
            elapsed_ms=elapsed, verified=dismissed,
            state=after_state,
            details={"had_dialog": True, "dismissed": dismissed},
        )

    # ─── 内部工具 ────────────────────────────────────────────────────────

    def _ensure_target_app(self) -> Optional[str]:
        """确保目标应用存在并返回其名称。"""
        return self.perception._find_target_app()
