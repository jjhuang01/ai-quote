# GUI Agent 假设验证 Spike 套件

> 逐一验证 GUI Agent 的 14 个技术假设，为 `gui-agent.py` 的实现提供坚实地基。

## 快速开始

```bash
cd experiments/gui-spikes

# 安装 OCR 依赖（可选，Layer 1+ 需要）
pip install pyobjc-framework-Vision pyobjc-framework-Quartz Pillow

# 运行安全层（不会发送消息）
python3 run_all.py

# 运行全部（包括发送测试）
python3 run_all.py --all --allow-send

# 运行单个 spike
python3 spike_01_screenshot.py

# 按层运行
python3 run_all.py --layer 0   # 基础: 截图 + 分辨率 + 窗口焦点
python3 run_all.py --layer 1   # 感知: 多屏 + OCR + 坐标 + 网格
python3 run_all.py --layer 2   # 操作: 鼠标 + 剪贴板 + 发送 + 新 session
python3 run_all.py --layer 3 --allow-send  # 集成: 性能 + 验证 + @conversation
```

## 层级结构

| Layer | 名称 | Spikes | 安全 |
|-------|------|--------|------|
| 0 | 基础 | 01_screenshot, 02_resolution, 10_window_focus | ✅ |
| 1 | 感知 | 03_multiscreen, 04_ocr_basic, 05_ocr_coords, 06_grid_overlay | ✅ |
| 2 | 操作 | 07_mouse_click, 08_clipboard_input, 09_send_enter, 11_new_session | ⚠️ |
| 3 | 集成 | 12_perf_pipeline, 13_verify_sent, 14_at_conversation | ⚠️ |

⚠️ = Layer 2/3 中部分 spike 会操作 GUI（移动鼠标、按键），但不会发送消息（除非 `--allow-send`）

## 假设矩阵

| # | 假设 | 风险 | Spike |
|---|------|------|-------|
| A1 | screencapture 能截取屏幕 | 🟢 | spike_01 |
| A2 | 分辨率检测 (Retina) | 🟡 | spike_02 |
| A3 | 双屏 + 窗口定位 | 🟡 | spike_03 |
| A4 | Vision OCR 识别 UI | 🟡 | spike_04 |
| A5 | OCR 坐标精度 | 🔴 | spike_05 |
| A6 | 网格 + 坐标映射 | 🟡 | spike_06 |
| A7 | 鼠标精确控制 | 🟢 | spike_07 |
| A8 | 剪贴板输入 | 🟡 | spike_08 |
| A9 | Enter 发送 | 🟡 | spike_09 |
| A10 | 窗口焦点 | 🟢 | spike_10 |
| A11 | Cmd+L 新 session | 🟡 | spike_11 |
| A12 | 全链路 < 2s | 🟡 | spike_12 |
| A13 | 发送后验证 | 🟡 | spike_13 |
| A14 | @conversation 引用 | 🔴 | spike_14 |

## Debug 产物

每个 spike 运行后在 `output/<spike_id>/` 生成：
- 截图 (`*.png`)
- OCR 结果 (`ocr_results.json`)
- 性能数据 (`perf_*.json`)
- 步骤报告 (`report.json`)

汇总报告: `output/report.json`

## macOS 权限

首次运行可能需要授权：
- **屏幕录制** — System Preferences → Privacy → Screen Recording → 允许 Terminal/IDE
- **辅助功能** — System Preferences → Privacy → Accessibility → 允许 Terminal/IDE

## 设计文档

详见 `docs/superpowers/specs/2026-04-14-gui-agent-spikes-design.md`
