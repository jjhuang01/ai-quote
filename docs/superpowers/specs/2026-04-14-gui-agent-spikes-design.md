# GUI Agent 假设验证 Spike 套件 — 设计规格

> **日期**: 2026-04-14 | **状态**: 已批准
>
> 目标：逐一验证 GUI Agent 的 14 个技术假设，每个假设一个独立 Python 脚本，
> 丰富 debug 输出，可观测性优先，不打包进插件。

---

## 1. 背景

架构文档 `docs/research/autopilot-architecture.md` §6.2 列出了 5 个未验证假设，
但实际上完整的假设链远不止此。本 spike 套件将 13+1 个隐含假设全部显式化，
逐一用独立脚本验证，为后续 `gui-agent.py` 的实现提供坚实的技术地基。

## 2. 假设矩阵（14 个关键技术节点）

| # | 假设 | 风险 | 层 | 依赖 |
|---|------|------|----|------|
| A1 | `screencapture -x -C` 能截取屏幕 | 🟢低 | 截图 | 屏幕录制权限 |
| A2 | 能检测屏幕分辨率（Retina 逻辑 vs 物理像素） | 🟡中 | 截图 | Quartz API |
| A3 | 双屏时能定位 Windsurf 在哪个屏幕 | 🟡中 | 截图 | NSScreen / AppleScript |
| A4 | macOS Vision OCR 能识别 Cascade UI 文字 | 🟡中 | OCR | pyobjc + Vision |
| A5 | OCR 返回的文字坐标足够精确可用于点击 | 🔴高 | OCR | Vision bounding box |
| A6 | 画网格标注后能反推屏幕坐标 | 🟡中 | OCR | 坐标映射 |
| A7 | AppleScript 能精确移动鼠标到指定坐标并点击 | 🟢低 | 操作 | System Events |
| A8 | 剪贴板 + Cmd+V 能在 Cascade 输入框输入中文 | 🟡中 | 操作 | pbcopy + AppleScript |
| A9 | Enter 键能发送消息（vs 需点击按钮） | 🟡中 | 操作 | Windsurf 行为 |
| A10 | AppleScript 能激活 Windsurf 窗口获得焦点 | 🟢低 | 操作 | `activate` |
| A11 | Cmd+L 两次 = 新建 Cascade 会话 | 🟡中 | 操作 | Windsurf 快捷键 |
| A12 | 截图 → OCR → 操作全链路 < 2 秒 | 🟡中 | 性能 | 全链路 |
| A13 | 操作后能截图验证消息已发送 | 🟡中 | 验证 | OCR 对比 |
| A14 | 新 session 中 `@conversation` 能引用之前对话 | 🔴高 | 操作 | 自动补全 + 下拉选择 |

## 3. 文件结构

```
experiments/
└── gui-spikes/
    ├── README.md                     # 总览 + 运行说明
    ├── _common.py                    # 共享：SpikeRunner, 日志, 截图, 计时
    ├── spike_01_screenshot.py        # A1: screencapture
    ├── spike_02_resolution.py        # A2: 分辨率检测
    ├── spike_03_multiscreen.py       # A3: 多屏 + 窗口定位
    ├── spike_04_ocr_basic.py         # A4: Vision OCR 基础
    ├── spike_05_ocr_coords.py        # A5: OCR 坐标精度
    ├── spike_06_grid_overlay.py      # A6: 网格叠加 + 反推
    ├── spike_07_mouse_click.py       # A7: 鼠标移动 + 点击
    ├── spike_08_clipboard_input.py   # A8: 剪贴板输入
    ├── spike_09_send_enter.py        # A9: Enter 发送
    ├── spike_10_window_focus.py      # A10: 窗口焦点
    ├── spike_11_new_session.py       # A11: Cmd+L 新建会话
    ├── spike_12_perf_pipeline.py     # A12: 全链路性能
    ├── spike_13_verify_sent.py       # A13: 发送验证
    ├── spike_14_at_conversation.py   # A14: @conversation 引用
    ├── run_all.py                    # 批量运行器
    └── output/                       # debug 产物
        └── .gitkeep
```

## 4. 共享模块 `_common.py`

### SpikeRunner 类

```python
class SpikeRunner:
    def __init__(self, name: str)
    def step(self, name: str)          # 开始步骤，打印带序号+时间戳的标题
    def pass_step(self, detail: str)   # ✅ 绿色通过
    def fail_step(self, detail: str)   # ❌ 红色失败
    def skip_step(self, reason: str)   # ⏭️ 跳过
    def save_artifact(self, name, data_or_path)  # 保存到 output/<spike>/
    def log(self, msg: str)            # 信息日志
    def debug(self, msg: str)          # debug 日志（默认开启）
    def warn(self, msg: str)           # 警告日志
    def timer(self) -> ContextManager  # 计时上下文管理器
    def summary(self)                  # 打印汇总 + sys.exit
```

### 工具函数

```python
def capture_screen(output_path: str) -> str
def capture_window(app_name: str, output_path: str) -> str
def run_applescript(script: str, timeout: float = 5.0) -> str
def get_window_info(app_name: str) -> dict  # {x, y, w, h, screen_index}
```

## 5. 各 Spike 详细设计

### spike_01_screenshot — 截图基础

**验证**: `screencapture` 命令能否工作
**步骤**:
1. 检查 `screencapture` 命令存在
2. 执行全屏截图 `screencapture -x -C -t png <path>`
3. 验证文件存在 + 非空 + 是有效 PNG
4. 记录尺寸、文件大小、耗时
**通过标准**: 截图文件 > 10KB，尺寸 > 100x100
**产物**: `output/spike_01/fullscreen.png`

### spike_02_resolution — 分辨率检测

**验证**: 能否正确获取逻辑分辨率和物理分辨率
**步骤**:
1. 用 `system_profiler SPDisplaysDataType -json` 获取显示器信息
2. 用 Quartz `CGMainDisplayID()` + `CGDisplayPixelsWide/High()` 获取物理像素
3. 计算 scale factor（Retina 通常 = 2）
4. 与截图实际尺寸交叉验证
**通过标准**: 逻辑分辨率 × scale factor = 截图像素尺寸
**产物**: `output/spike_02/display_info.json`

### spike_03_multiscreen — 多屏幕 + 窗口定位

**验证**: 能否枚举所有屏幕 + 定位 Windsurf 窗口
**步骤**:
1. 用 Quartz 枚举所有 display（`CGGetActiveDisplayList`）
2. 获取每个 display 的 bounds
3. 用 AppleScript 获取 Windsurf 窗口位置 `{x, y, w, h}`
4. 判断窗口在哪个屏幕上
5. 只截 Windsurf 所在窗口 `screencapture -l <windowID>`
**通过标准**: 能正确返回窗口位置，窗口截图包含 Windsurf UI
**产物**: `output/spike_03/screens.json`, `output/spike_03/windsurf_window.png`

### spike_04_ocr_basic — Vision OCR 基础

**验证**: macOS Vision 能否识别 Cascade UI 中的文字
**步骤**:
1. 截取 Windsurf 窗口
2. 加载截图到 Vision `VNImageRequestHandler`
3. 执行 `VNRecognizeTextRequest`（语言: en + zh-Hans）
4. 打印所有识别到的文字 + 置信度
5. 检查是否能识别到关键 UI 元素（"Cascade", "Ask", 输入框提示文字等）
**通过标准**: 至少识别到 5 个文字片段，置信度 > 0.5
**产物**: `output/spike_04/ocr_results.json`, `output/spike_04/screenshot.png`

### spike_05_ocr_coords — OCR 坐标精度

**验证**: OCR 返回的 bounding box 能否精确定位 UI 元素
**步骤**:
1. 截取 Windsurf 窗口
2. OCR 识别全部文字 + bounding box（归一化坐标 0-1）
3. 将归一化坐标转换为屏幕像素坐标
4. 在截图上标注每个文字的 bounding box（画矩形 + 文字标签）
5. 保存标注后的截图供人工检查
6. 检查关键元素（输入框）的坐标是否在合理范围
**通过标准**: 标注矩形与实际 UI 元素重叠率 > 80%（人工检查）
**产物**: `output/spike_05/annotated.png`, `output/spike_05/coords.json`

### spike_06_grid_overlay — 网格叠加 + 坐标映射

**验证**: 画网格后能否反推任意像素的屏幕坐标
**步骤**:
1. 截取 Windsurf 窗口
2. 叠加 50px 网格（水平+垂直线 + 坐标标签）
3. 保存网格图
4. 给定一个 OCR 识别到的元素，反推其在屏幕上的绝对坐标
5. 用 AppleScript 将鼠标移到该坐标，验证位置是否正确
**通过标准**: 鼠标移到 OCR 标注位置时，视觉上在目标元素上
**产物**: `output/spike_06/grid.png`, `output/spike_06/coordinate_map.json`

### spike_07_mouse_click — 鼠标移动 + 点击

**验证**: AppleScript 能否精确控制鼠标
**步骤**:
1. 获取当前鼠标位置（AppleScript / Quartz）
2. 移动鼠标到屏幕中心
3. 验证鼠标确实移到了目标位置
4. 点击一个已知位置（如 Windsurf 标题栏）
5. 验证点击生效（窗口获得焦点）
**通过标准**: 鼠标移动偏差 < 5 像素
**产物**: `output/spike_07/mouse_trace.json`

### spike_08_clipboard_input — 剪贴板输入

**验证**: 能否通过剪贴板向 Cascade 输入框输入文字
**步骤**:
1. 保存当前剪贴板内容
2. 写入测试文字到剪贴板 `pbcopy`（含中文）
3. 激活 Windsurf → 聚焦输入框（Cmd+L 或点击）
4. 执行 Cmd+V 粘贴
5. 截图验证输入框中出现了测试文字（OCR）
6. Cmd+A → Delete 清除输入（不发送）
7. 恢复原始剪贴板内容
**通过标准**: OCR 在输入框区域识别到测试文字
**产物**: `output/spike_08/before.png`, `output/spike_08/after_paste.png`

### spike_09_send_enter — Enter 发送验证

**验证**: Enter 键是否能发送消息
**步骤**:
1. 确认 Cascade 输入框有焦点
2. 输入一个安全的测试消息（如 "spike test ping"）
3. 按 Enter
4. 等待 2 秒
5. 截图 → OCR 检查消息是否出现在对话区域
6. 备选：检查 Shift+Enter 是否换行而非发送
**通过标准**: 消息出现在 Cascade 对话区域
**注意**: ⚠️ 这会真正发送消息到 Cascade，需要用户确认
**产物**: `output/spike_09/before.png`, `output/spike_09/after_send.png`

### spike_10_window_focus — 窗口焦点

**验证**: 能否可靠地激活 Windsurf 窗口
**步骤**:
1. 用 AppleScript 激活另一个应用（如 Finder）
2. 验证 Windsurf 不是前台窗口
3. 用 AppleScript `tell application "Windsurf" to activate`
4. 等待 0.5s
5. 验证 Windsurf 是前台窗口（`frontmost`）
**通过标准**: `frontmost` 返回 true
**产物**: `output/spike_10/focus_log.json`

### spike_11_new_session — Cmd+L 新建会话

**验证**: Cmd+L 是否能打开/新建 Cascade 会话
**步骤**:
1. 截图 → OCR 记录当前 Cascade 状态
2. 执行 Cmd+L
3. 等待 1s → 截图 → OCR
4. 对比前后状态，检查是否新建了会话
5. 再次 Cmd+L → 截图 → 对比
**通过标准**: Cascade 输入框获得焦点或新建了空会话
**产物**: `output/spike_11/before.png`, `output/spike_11/after_cmdl.png`

### spike_12_perf_pipeline — 全链路性能

**验证**: 截图→OCR→操作→验证 全链路 < 2 秒
**步骤**:
1. 计时: `screencapture` 截图
2. 计时: Vision OCR 识别
3. 计时: AppleScript 执行操作
4. 计时: 截图验证
5. 汇总各环节耗时
6. 重复 5 次取平均值
**通过标准**: 平均全链路耗时 < 2000ms
**产物**: `output/spike_12/perf_report.json`

### spike_13_verify_sent — 发送后验证

**验证**: 能否通过截图+OCR 确认消息已发送
**步骤**:
1. 截图 → OCR 记录发送前状态
2. 发送一条带特征标记的消息（如 "SPIKE_VERIFY_abc123"）
3. 等待 3s
4. 截图 → OCR 搜索特征标记
5. 对比前后 OCR 结果
**通过标准**: 特征标记出现在发送后的 OCR 结果中
**注意**: ⚠️ 会真正发送消息
**产物**: `output/spike_13/before.png`, `output/spike_13/after.png`, `output/spike_13/diff.json`

### spike_14_at_conversation — @conversation 引用

**验证**: 能否在新 session 中通过 `@conversation` 引用之前对话
**步骤**:
1. 记录当前 session 状态（OCR）
2. Cmd+L 新建 session
3. 输入 "@" → 等待自动补全下拉
4. 截图 → OCR 检查是否出现补全菜单
5. 继续输入 "conversation" 或从菜单选择
6. 截图确认引用标签已插入
7. 追加消息 "继续之前的工作"
8. Enter 发送
9. 截图验证
**通过标准**: `@conversation` 引用成功插入 + 消息发送成功
**注意**: ⚠️ 会真正发送消息 + 创建新 session，最复杂的 spike
**产物**: `output/spike_14/step_*.png` (多步截图)

## 6. 依赖

### 零安装层（A1-A3, A7-A11）
- 纯 `subprocess` 调用: `screencapture`, `osascript`, `pbcopy`, `system_profiler`
- Python 3.9+ 标准库

### OCR 层（A4-A6, A12-A14）
```bash
pip install pyobjc-framework-Vision pyobjc-framework-Quartz
```

### 可选
```bash
pip install Pillow  # A6 网格叠加用
```

## 7. 可观测性设计

每次运行生成：
1. **终端输出** — 彩色步骤状态 + 时间 + 详细日志
2. **截图产物** — `output/<spike>/step_N_<name>.png`
3. **OCR dump** — `output/<spike>/ocr_results.json`
4. **汇总报告** — `output/report.json`（所有 spike 结果）

日志格式：
```
[14:30:01] 🔬 spike_01_screenshot
[14:30:01]   ├─ Step 1: 检查 screencapture 可用性
[14:30:01]   │  ✅ screencapture 存在: /usr/sbin/screencapture
[14:30:01]   ├─ Step 2: 执行全屏截图
[14:30:01]   │  📸 保存: output/spike_01/fullscreen.png (2880x1800, 1.2MB)
[14:30:01]   │  ⏱️  耗时: 87ms
[14:30:01]   │  ✅ 截图成功
[14:30:01]   └─ 汇总: 2/2 通过, 0 失败, 0 跳过
```

## 8. 执行顺序建议

```
Layer 0 (基础):     spike_01 → spike_02 → spike_10
Layer 1 (感知):     spike_03 → spike_04 → spike_05 → spike_06
Layer 2 (操作):     spike_07 → spike_08 → spike_09 → spike_11
Layer 3 (集成):     spike_12 → spike_13 → spike_14
```

每层依赖前一层通过。`run_all.py` 按此顺序执行，遇到失败可选择停止或继续。

## 9. 安全注意事项

- **spike_09, spike_13, spike_14** 会真正发送消息到 Cascade，默认需要 `--allow-send` 参数
- 所有鼠标操作前后保存/恢复鼠标位置
- 所有剪贴板操作前后保存/恢复剪贴板内容
- AppleScript 执行有 5 秒超时保护
