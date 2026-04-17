"""验证层 — 操作后状态确认。

职责:
  - 发送后截图 + OCR 验证消息是否出现
  - 基于特征标记的精确验证
  - 前后 OCR diff 对比
  - 状态变迁检测 (如 READY → LOADING)
"""

from __future__ import annotations

import time
import uuid
from typing import Optional

from .config import Config, DEFAULT_CONFIG
from .logger import AgentLogger
from .models import CascadeState, OCROutput, ScreenState


class Verification:
    """验证引擎 — GUI Agent 的确认环。"""

    def __init__(self, config: Config = DEFAULT_CONFIG, logger: Optional[AgentLogger] = None):
        self.cfg = config
        self.log = logger or AgentLogger("verification", config)

    def generate_marker(self) -> str:
        """生成唯一特征标记（嵌入消息用于后续验证）。"""
        marker = f"{self.cfg.verify_marker_prefix}{uuid.uuid4().hex[:8]}"
        self.log.debug(f"Marker generated: {marker}")
        return marker

    def verify_marker_in_ocr(self, marker: str, ocr: OCROutput) -> bool:
        """检查 OCR 结果中是否包含特征标记。"""
        full_text = ocr.full_text
        # 精确匹配
        if marker in full_text:
            self.log.info(f"✓ Marker '{marker}' found (exact)")
            return True
        # 大小写不敏感匹配
        if marker.lower() in full_text.lower():
            self.log.info(f"✓ Marker '{marker}' found (case-insensitive)")
            return True
        # 前缀匹配 (OCR 可能分段识别)
        prefix = marker[:12]
        if prefix in full_text:
            self.log.info(f"✓ Marker prefix '{prefix}' found (partial)")
            return True
        self.log.warn(f"✗ Marker '{marker}' NOT found in OCR output")
        return False

    def verify_state_change(self, before: ScreenState, after: ScreenState,
                            expected_state: Optional[CascadeState] = None) -> bool:
        """验证状态发生了预期变迁。"""
        changed = before.state != after.state
        if expected_state:
            result = after.state == expected_state
            self.log.info(f"State: {before.state.value} → {after.state.value} "
                          f"(expected={expected_state.value}, match={result})")
            return result
        self.log.info(f"State: {before.state.value} → {after.state.value} (changed={changed})")
        return changed

    def verify_ocr_diff(self, before: Optional[OCROutput],
                        after: Optional[OCROutput]) -> dict:
        """比较前后 OCR 结果，返回差异。"""
        if before is None or after is None:
            return {"error": "missing_ocr", "changed": False}

        before_texts = set(r.text for r in before.results)
        after_texts = set(r.text for r in after.results)
        added = after_texts - before_texts
        removed = before_texts - after_texts

        diff = {
            "changed": bool(added or removed),
            "before_count": len(before_texts),
            "after_count": len(after_texts),
            "added": list(added)[:20],
            "removed": list(removed)[:20],
        }
        self.log.info(f"OCR diff: +{len(added)} -{len(removed)} texts")
        return diff

    def verify_send(self, marker: str, before_state: ScreenState,
                    after_state: ScreenState) -> dict:
        """综合验证消息发送是否成功。

        Returns:
            {"verified": bool, "marker_found": bool, "state_changed": bool, ...}
        """
        result = {
            "verified": False,
            "marker_found": False,
            "state_changed": False,
            "ocr_changed": False,
        }

        # 1. 特征标记验证
        if after_state.ocr_output:
            result["marker_found"] = self.verify_marker_in_ocr(marker, after_state.ocr_output)

        # 2. 状态变迁
        result["state_changed"] = self.verify_state_change(before_state, after_state)

        # 3. OCR 内容变化
        before_ocr = before_state.ocr_output
        after_ocr = after_state.ocr_output
        diff = self.verify_ocr_diff(before_ocr, after_ocr)
        result["ocr_changed"] = diff.get("changed", False)
        result["ocr_diff"] = diff

        # 综合判断: 任意一个强信号即可
        result["verified"] = result["marker_found"] or (
            result["state_changed"] and result["ocr_changed"]
        )

        level = "info" if result["verified"] else "warn"
        getattr(self.log, level)(
            f"Send verification: verified={result['verified']}, "
            f"marker={result['marker_found']}, "
            f"state_changed={result['state_changed']}"
        )
        return result

    def verify_new_session(self, before_state: ScreenState,
                           after_state: ScreenState) -> dict:
        """验证新 session 创建是否成功。"""
        result = {
            "verified": False,
            "ocr_changed": False,
            "input_ready": after_state.input_ready,
        }

        diff = self.verify_ocr_diff(
            before_state.ocr_output, after_state.ocr_output
        )
        result["ocr_changed"] = diff.get("changed", False)
        result["ocr_diff"] = diff

        # 新 session = OCR 内容变化 + 输入框就绪
        result["verified"] = result["ocr_changed"] or result["input_ready"]

        self.log.info(f"New session verification: verified={result['verified']}, "
                      f"input_ready={result['input_ready']}")
        return result
