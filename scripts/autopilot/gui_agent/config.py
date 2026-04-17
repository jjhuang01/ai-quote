"""配置中心 — 所有可调参数集中管理。

设计原则:
  - 所有魔数集中于此，不散落在业务代码中
  - 支持环境变量覆盖 (GUI_AGENT_ 前缀)
  - 不可变 dataclass 防止运行时意外修改
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_int(key: str, default: int) -> int:
    return int(os.environ.get(f"GUI_AGENT_{key}", default))


def _env_float(key: str, default: float) -> float:
    return float(os.environ.get(f"GUI_AGENT_{key}", default))


def _env_str(key: str, default: str) -> str:
    return os.environ.get(f"GUI_AGENT_{key}", default)


@dataclass(frozen=True)
class Config:
    """GUI Agent 全局配置。"""

    # ── 目标应用 ─────────────────────────────────────────────────────────
    app_names: tuple[str, ...] = ("Windsurf", "Cursor")

    # ── 超时 (秒) ───────────────────────────────────────────────────────
    screenshot_timeout: float = field(default_factory=lambda: _env_float("SCREENSHOT_TIMEOUT", 10.0))
    ocr_timeout: float = field(default_factory=lambda: _env_float("OCR_TIMEOUT", 15.0))
    applescript_timeout: float = field(default_factory=lambda: _env_float("APPLESCRIPT_TIMEOUT", 5.0))
    action_settle_ms: int = field(default_factory=lambda: _env_int("ACTION_SETTLE_MS", 500))

    # ── 重试 ────────────────────────────────────────────────────────────
    max_retries: int = field(default_factory=lambda: _env_int("MAX_RETRIES", 3))
    retry_interval_ms: int = field(default_factory=lambda: _env_int("RETRY_INTERVAL_MS", 1000))

    # ── OCR ──────────────────────────────────────────────────────────────
    ocr_languages: tuple[str, ...] = ("en", "zh-Hans")
    ocr_recognition_level: int = 1  # 0=fast, 1=accurate
    ocr_min_confidence: float = 0.3

    # ── 坐标映射 (Retina) ───────────────────────────────────────────────
    # spike_02 验证: screencapture 输出 = 逻辑坐标 × 2
    # spike_06 验证: pixel_to_screen_scale ≈ 0.464 (窗口截图)
    # 实际值在运行时由 perception 层自动检测
    retina_scale_fallback: float = 2.0

    # ── 路径 ─────────────────────────────────────────────────────────────
    log_dir: Path = field(default_factory=lambda: Path(_env_str("LOG_DIR",
        str(Path.home() / ".quote-autopilot" / "gui-agent"))))
    screenshot_dir: Path = field(default_factory=lambda: Path(_env_str("SCREENSHOT_DIR",
        str(Path.home() / ".quote-autopilot" / "gui-agent" / "screenshots"))))

    # ── UI 识别模式 ─────────────────────────────────────────────────────
    # spike_04/09 验证: 这些关键词在 OCR 结果中可匹配
    input_box_keywords: tuple[str, ...] = (
        "ask cascade", "ask anything", "type a message",
        "send a message", "ask windsurf",
    )
    rate_limit_keywords: tuple[str, ...] = (
        "rate limit", "too many requests", "429", "please wait",
        "try again later",
    )
    quota_error_keywords: tuple[str, ...] = (
        "quota exceeded", "no remaining credits", "upgrade your plan",
        "upgrade plan",
    )
    dialog_keywords: tuple[str, ...] = (
        "accept and continue", "decline and close",
        "do you want to", "are you sure",
        "rate limit reached", "upgrade your plan",
    )
    send_button_keywords: tuple[str, ...] = (
        "send",
    )

    # ── 验证 ────────────────────────────────────────────────────────────
    verify_wait_ms: int = field(default_factory=lambda: _env_int("VERIFY_WAIT_MS", 3000))
    verify_marker_prefix: str = "GA_"

    # ── 截图保留策略 ────────────────────────────────────────────────────
    max_screenshots: int = field(default_factory=lambda: _env_int("MAX_SCREENSHOTS", 50))

    # ── 可视化模式 (--visual) ────────────────────────────────────────
    visual_mode: bool = False  # 运行时由 CLI 设置
    visual_delay: float = field(default_factory=lambda: _env_float("VISUAL_DELAY", 2.0))
    visual_grid_spacing: int = field(default_factory=lambda: _env_int("VISUAL_GRID_SPACING", 50))
    visual_dir: Path = field(default_factory=lambda: Path(_env_str("VISUAL_DIR",
        str(Path.home() / ".quote-autopilot" / "gui-agent" / "visual"))))

    def __post_init__(self):
        """确保目录存在。"""
        # frozen=True 下无法直接赋值，用 object.__setattr__ 绕过
        object.__setattr__(self, 'log_dir', Path(self.log_dir))
        object.__setattr__(self, 'screenshot_dir', Path(self.screenshot_dir))
        object.__setattr__(self, 'visual_dir', Path(self.visual_dir))
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        self.visual_dir.mkdir(parents=True, exist_ok=True)


# 全局单例
DEFAULT_CONFIG = Config()
