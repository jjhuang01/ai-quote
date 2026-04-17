"""GUI Agent — 感知型 Windsurf Cascade GUI 自动化。

架构：四层职责分离
  - perception: 截图 + OCR + UI 状态解析
  - action:     鼠标 + 键盘 + 剪贴板 + 窗口控制
  - verification: 操作前后状态对比 + 特征标记验证
  - coordinator: 编排感知-行动-验证循环

Spike 验证数据 (2026-04-14):
  - 截图: avg 301ms, Retina 2x (2880x1800)
  - OCR: ~1000ms, 143+ 文字片段, pyobjc Vision
  - 鼠标: 0.0px 误差, Quartz CGEvent 控制
  - 剪贴板: 中文OK, avg 37ms, clipboard_guard 恢复正确
  - 窗口: Windsurf activate 200ms, 3/3 焦点切换成功
  - 坐标: screenshot_pixel × 0.464 + window_offset = screen_coord
  - 全链路: ~1700ms (截图+OCR+操作)
"""

__version__ = "0.1.0"
