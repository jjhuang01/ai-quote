# Windsurf/VS Code 自动化操控可行性调研报告

> **日期**: 2026-04-14
> **作者**: AI Quote 项目
> **状态**: 调研完成
> **场景**: 夜间无人值守时，自动检测 rate limit → 切换账号 → 在 Cascade 聊天框发送"继续" → 上下文过长时开新 tab

---

## 一、核心发现摘要

| 能力                       | 可行性               | 最佳方案                                                |
| -------------------------- | -------------------- | ------------------------------------------------------- |
| 检测 rate limit / 额度耗尽 | ✅ 完全可行          | Cascade Hooks (`post_cascade_response`)                 |
| 自动切换账号               | ✅ 完全可行          | Quote 扩展已有能力 + Bridge API                         |
| 在聊天框输入并发送消息     | ⚠️ 有限可行          | AppleScript/Hammerspoon 键盘模拟                        |
| 识别聊天框文字内容         | ✅ 可行              | Cascade Hooks (`post_cascade_response_with_transcript`) |
| 开新 Cascade tab           | ⚠️ 有限可行          | 键盘快捷键模拟 (Cmd+L)                                  |
| @mention 之前的 session    | ✅ Windsurf 原生支持 | `@conversation` 语法                                    |
| OpenClaw 驱动编排          | ✅ 可行              | Hooks + HTTP Bridge                                     |

**整体结论**: **可行，但需要混合方案**。纯 VS Code Extension API 无法直接操控 Cascade 聊天框（Windsurf 不暴露此 API），需要结合 Cascade Hooks（官方）+ 系统级键盘模拟（AppleScript/Hammerspoon）+ Quote Bridge HTTP API 来实现完整自动化。

---

## 1.5、已有代码能力验证（反向对齐）

### Bridge HTTP 路由（已验证 `bridge.ts:554-637`）

| 路由                           | 方法 | 功能               | 自动化可用  |
| ------------------------------ | ---- | ------------------ | ----------- |
| `/status`                      | GET  | 获取状态           | ✅ 直接可用 |
| `/message`                     | POST | 发送消息/MCP 请求  | ✅ 直接可用 |
| `/sse`                         | GET  | SSE 事件流         | ✅ 监听事件 |
| `/api/version`                 | GET  | 版本信息           | ✅          |
| `/api/verify`                  | POST | 验证码             | ❌ 无关     |
| `/api/firebase/login`          | POST | Firebase 登录      | ⚠️ 间接可用 |
| ~~`/api/switch-next-account`~~ | -    | **不存在，需新增** | ❌          |
| ~~`/api/quota-status`~~        | -    | **不存在，需新增** | ❌          |
| ~~`/api/autopilot/action`~~    | -    | **不存在，需新增** | ❌          |

### 账号切换能力（已验证 `windsurf-account.ts:343-402`）

- **`switchTo(id)`**: Firebase signIn → 发现 Windsurf auth 命令 → 注入 idToken
- **`autoSwitchIfNeeded()`**: 检查配额阈值 → 找到有余量的候选 → 调用 `switchTo()`
- **`_accountNeedsSwitch()`**: 支持 realQuota（API 实时）和本地计数器双重判断
- **`fetchAllRealQuotas()`**: Channel B (GetPlanStatus) → Channel E/A (本地缓存) 降级策略

### ⚠️ 已发现的假设性风险

1. **`switchTo()` 后 Cascade 会话连续性**: 代码注释说"LS 的下一次请求会自动读取新 session"，但**当前正在进行的 Cascade 对话可能因 auth 变更而中断**。需要测试验证。
2. **Bridge 端口**: 默认 3456，但多窗口会自动 fallback 到随机端口。外部脚本需要先查询实际端口。
3. **AppleScript 发送中文**: 不能用 `keystroke`，必须用**剪贴板粘贴**方式。
4. **Cascade Hook 超时**: Windsurf 文档未明确 Hook 执行时间限制，但建议 Hook 快速返回。长时间操作应异步化。

---

## 二、技术路径深度分析

### 路径 A：Cascade Hooks（官方，推荐核心）

Windsurf 提供了 **12 个 Hook 事件**，这是最重要的发现：

#### Hook 事件列表

| Hook                                    | 时机               | 可阻断 | 用途                           |
| --------------------------------------- | ------------------ | ------ | ------------------------------ |
| `pre_user_prompt`                       | 用户发送消息前     | ✅     | 拦截/审计用户输入              |
| `post_cascade_response`                 | Cascade 回复后     | ❌     | **检测 rate limit 错误**       |
| `post_cascade_response_with_transcript` | 回复后(含完整历史) | ❌     | **分析完整对话判断上下文长度** |
| `pre_run_command`                       | 执行命令前         | ✅     | 安全控制                       |
| `post_run_command`                      | 执行命令后         | ❌     | 触发后续动作                   |
| `pre/post_mcp_tool_use`                 | MCP 工具调用前后   | pre ✅ | **检测 Quote MCP 调用**        |
| `pre/post_read_code`                    | 读文件前后         | pre ✅ | 文件访问控制                   |
| `pre/post_write_code`                   | 写文件前后         | pre ✅ | 代码变更审计                   |
| `post_setup_worktree`                   | 创建 worktree 后   | ❌     | 工作区初始化                   |

#### 配置方式

```json
// ~/.codeium/windsurf/hooks.json（用户级）
// 或 .windsurf/hooks.json（工作区级）
{
  "hooks": {
    "post_cascade_response": [
      {
        "command": "python3 /path/to/auto-pilot.py",
        "show_output": false
      }
    ],
    "post_cascade_response_with_transcript": [
      {
        "command": "python3 /path/to/context-monitor.py",
        "show_output": false
      }
    ]
  }
}
```

#### Hook 收到的数据示例

```json
// post_cascade_response 收到的 JSON (stdin)
{
  "agent_action_name": "post_cascade_response",
  "trajectory_id": "unique-conversation-id",
  "execution_id": "unique-turn-id",
  "timestamp": "2026-04-14T00:00:00Z",
  "tool_info": {
    "response": "### Planner Response\n\nSorry, you have reached the rate limit..."
  }
}
```

#### ⭐ 关键能力

1. **检测 rate limit**: `post_cascade_response` 的 `response` 字段包含 Cascade 完整回复，可以正则匹配 "rate limit"、"quota exceeded" 等关键词
2. **检测上下文长度**: `post_cascade_response_with_transcript` 提供完整 JSONL 文件路径，可以计算 token 数量
3. **检测 MCP 调用**: `post_mcp_tool_use` 可以监听 Quote MCP 工具的调用结果

#### 🔴 限制

- **Hook 只能被动监听**，不能主动向 Cascade 发送消息
- **Hook 是 post 触发**（除了 pre_user_prompt），不能阻断 rate limit（已经发生了）
- Hook 没有"向聊天框注入文字"的能力

---

### 路径 B：VS Code / Windsurf 内部命令

#### VS Code 官方 Chat API

VS Code 提供了聊天相关命令：

```typescript
// 打开聊天并发送消息
vscode.commands.executeCommand('workbench.action.chat.open', {
  query: '@participant /hello friend',
  previousRequests: [...]
});

// 创建新聊天会话
vscode.commands.executeCommand('workbench.action.chat.newChat');
```

#### ⚠️ Windsurf 的情况

**Windsurf 是 VS Code 的深度 fork**，但：

1. **Cascade 不是标准 VS Code Chat Participant** — 它是 Windsurf 的内部实现，不遵循 `vscode.chat` API
2. **`workbench.action.chat.open` 在 Windsurf 中不一定能操控 Cascade** — 这个命令是 VS Code Copilot Chat 的，Windsurf 可能覆盖/禁用了它
3. **没有公开的 `cascade.sendMessage` 命令** — 调研未发现 Windsurf 暴露任何程序化控制 Cascade 的扩展 API
4. **Windsurf 内部通信走私有二进制协议** — 据 [Windsurf Internals](https://medium.com/@GenerationAI/windsurf-internals-ac4b807a0) 分析，Cascade 通过加密的 HTTP 与 `35.x.x.x` 后端通信

#### 💡 可尝试的命令探测

我们的 Quote 扩展可以尝试枚举 Windsurf 的内部命令：

```typescript
// 在扩展中探测
const allCommands = await vscode.commands.getCommands(true);
const cascadeCommands = allCommands.filter(
  (cmd) =>
    cmd.includes("cascade") ||
    cmd.includes("windsurf") ||
    cmd.includes("codeium"),
);
```

**评估**: 即使找到了内部命令，Windsurf 随时可能在更新中改变它们，**不稳定**。

---

### 路径 C：系统级 UI 自动化（键盘/鼠标模拟）

当 API 方案不可行时，这是最可靠的备选方案。

#### 方案 C1：AppleScript（推荐）

```applescript
-- 激活 Windsurf 窗口
tell application "Windsurf" to activate
delay 0.5

-- 聚焦 Cascade 输入框（Cmd+L 是 Windsurf 快捷键）
tell application "System Events"
    tell process "Windsurf"
        -- 打开新的 Cascade 会话
        keystroke "l" using {command down}
        delay 0.3

        -- 输入消息
        keystroke "继续上面的任务 @conversation"
        delay 0.1

        -- 发送（Enter）
        key code 36  -- Enter
    end tell
end tell
```

**能力矩阵**:

| 操作               | AppleScript 实现                            | 可靠性                |
| ------------------ | ------------------------------------------- | --------------------- |
| 聚焦 Windsurf 窗口 | `tell application "Windsurf" to activate`   | ⭐⭐⭐⭐⭐            |
| 打开 Cascade 面板  | `keystroke "l" using {command down}`        | ⭐⭐⭐⭐              |
| 新建 Cascade 会话  | `keystroke "l" using {command down}` (再次) | ⭐⭐⭐⭐              |
| 输入文字           | `keystroke "文字内容"`                      | ⭐⭐⭐ (中文需剪贴板) |
| 发送消息           | `key code 36` (Enter)                       | ⭐⭐⭐⭐⭐            |
| 读取聊天内容       | ❌ 无法直接读取 Electron WebView            | ⭐                    |
| 点击特定按钮       | 需要坐标或 AX 树                            | ⭐⭐                  |

**中文输入的特殊处理**:

```applescript
-- 中文不能直接 keystroke，需要用剪贴板
set the clipboard to "继续上面的任务"
tell application "System Events"
    tell process "Windsurf"
        keystroke "v" using {command down}  -- 粘贴
        delay 0.1
        key code 36  -- Enter
    end tell
end tell
```

#### 方案 C2：Hammerspoon（更灵活）

```lua
-- hammerspoon 配置
local windsurf = hs.application.find("Windsurf")

function sendToCascade(message)
    if not windsurf then
        windsurf = hs.application.find("Windsurf")
    end
    if not windsurf then return false end

    windsurf:activate()
    hs.timer.doAfter(0.5, function()
        -- Cmd+L 打开/聚焦 Cascade
        hs.eventtap.keyStroke({"cmd"}, "l")
        hs.timer.doAfter(0.3, function()
            -- 通过剪贴板输入
            hs.pasteboard.setContents(message)
            hs.eventtap.keyStroke({"cmd"}, "v")
            hs.timer.doAfter(0.1, function()
                -- 发送
                hs.eventtap.keyStroke({}, "return")
            end)
        end)
    end)
    return true
end

function newCascadeSession(message)
    if not windsurf then return false end
    windsurf:activate()
    hs.timer.doAfter(0.5, function()
        -- Cmd+L 两次 = 新会话
        hs.eventtap.keyStroke({"cmd"}, "l")
        hs.timer.doAfter(0.3, function()
            hs.eventtap.keyStroke({"cmd"}, "l")
            hs.timer.doAfter(0.3, function()
                hs.pasteboard.setContents(message)
                hs.eventtap.keyStroke({"cmd"}, "v")
                hs.timer.doAfter(0.1, function()
                    hs.eventtap.keyStroke({}, "return")
                end)
            end)
        end)
    end)
end
```

#### 方案 C3：cliclick（CLI 鼠标模拟）

```bash
# 安装
brew install cliclick

# 点击特定坐标
cliclick c:500,400

# 输入文字 + 回车
cliclick t:"continue" kp:return
```

#### 方案 C4：屏幕识别（九宫格/图色对比）

```python
# 使用 pyautogui 进行屏幕坐标定位
import pyautogui
import subprocess

# 截图并识别 Cascade 输入框位置
screenshot = pyautogui.screenshot()

# 方法1: 模板匹配（找 Cascade 输入框的图标/特征）
location = pyautogui.locateOnScreen('cascade_input_icon.png', confidence=0.9)
if location:
    pyautogui.click(location.left + 50, location.top + 10)
    pyautogui.typewrite('continue', interval=0.05)
    pyautogui.press('enter')

# 方法2: 固定比例计算（基于窗口尺寸）
# Cascade 面板通常在右侧 30% 区域，输入框在底部
import Quartz
window_info = get_windsurf_window_bounds()  # 获取窗口边界
input_x = window_info.x + window_info.width * 0.85  # 右侧 85%
input_y = window_info.y + window_info.height * 0.95  # 底部 95%
```

---

### 路径 D：macOS Accessibility API（AXUIElement）

Electron 应用（VS Code/Windsurf）的辅助功能树结构：

```
AXApplication "Windsurf"
  └── AXWindow "main window"
       └── AXGroup (main content)
            └── AXWebArea (Electron webview)
                 └── ... (Shadow DOM, 不可直接访问)
```

#### 🔴 限制

- **Electron 应用的 WebView 内部元素对 AX API 暴露有限**
- VS Code/Windsurf 使用 Monaco Editor 和自定义渲染，**不是标准的 AXTextField**
- Cascade 面板是 Webview，AX 树中看到的是 `AXWebArea`，**内部元素不可程序化遍历**
- 据 [Electron issue #36337](https://github.com/electron/electron/issues/36337)，文本选择等 AX 功能在 Electron 中存在 bug

**评估**: ❌ **不推荐**作为主要方案，可作为辅助检测窗口状态用。

---

## 三、推荐架构：三方职责分离

> **核心思想**: 插件管换号、脚本管 GUI、OpenClaw 管决策，各司其职互不越界。

### 3.1 职责矩阵

| 角色             | 职责                                             | **不做什么**                           |
| ---------------- | ------------------------------------------------ | -------------------------------------- |
| **Quote 插件**   | 换号、配额查询、状态 API                         | 不操作 GUI、不做决策、不管任务队列     |
| **GUI 脚本**     | 操作 Windsurf 界面（输入、发送、新建会话）       | 不换号、不做决策、无状态               |
| **OpenClaw**     | 决策大脑（何时换号、何时重试、何时开新 session） | 不直接换号、不直接操作 GUI             |
| **Cascade Hook** | 事件感知（检测 response 内容）                   | 不做决策、不做操作，只向 OpenClaw 报告 |

### 3.2 设计原则

1. **单一职责**: 每个组件只做一件事，做好做透
2. **OpenClaw 是唯一决策者**: 所有"该怎么办"的判断都在 OpenClaw
3. **插件是纯 API 服务**: 暴露 HTTP 端点，被调用时执行，不主动干活
4. **脚本是无状态工具**: 被调用 → 执行 → 退出，不维护任何状态

### 3.3 整体架构图

```
                    ┌──────────────────────────────────┐
                    │       OpenClaw (决策大脑)          │
                    │                                    │
                    │  • 接收 Hook 事件 → 分析 → 决策    │
                    │  • 管理任务队列                     │
                    │  • 状态机: idle/executing/error     │
                    │  • 定时轮询配额                     │
                    │                                    │
                    │     决策规则:                       │
                    │     rate_limit → 等30s → 重试      │
                    │     quota_exhausted → 换号 → 继续   │
                    │     context_overflow → 新session    │
                    │     task_completed → 取下一个任务    │
                    └──────────┬────────┬────────────────┘
                               │        │
              ┌────────────────┘        └───────────────┐
              ▼                                         ▼
┌──────────────────────────┐          ┌──────────────────────────┐
│  Quote 插件 (换号服务)     │          │  GUI 脚本 (界面操作)       │
│                          │          │                          │
│  HTTP API:               │          │  CLI 接口:                │
│  GET  /api/ap/accounts   │          │  ui-control.sh send MSG  │
│  GET  /api/ap/quota      │          │  ui-control.sh new-session│
│  POST /api/ap/switch     │          │  ui-control.sh focus     │
│  POST /api/ap/switch-next│          │  ui-control.sh check     │
│  POST /api/ap/refresh    │          │                          │
│                          │          │  实现:                    │
│  内部调用:                │          │  • AppleScript 键盘模拟   │
│  WindsurfAccountManager  │          │  • 剪贴板粘贴中文          │
│  .switchTo(id)           │          │  • Cmd+L 聚焦/新建会话    │
│  .autoSwitchIfNeeded()   │          │  • Enter 发送              │
│  .fetchAllRealQuotas()   │          │                          │
│  .getAll()               │          │  特点: 完全无状态          │
└──────────────────────────┘          └──────────────────────────┘
              ▲                                         ▲
              │ HTTP                          subprocess │
              │                                         │
              └──────────┬──────────────────────────────┘
                         │  OpenClaw 分别调用
                         │
              ┌──────────┴──────────────┐
              │  Cascade Hook (事件感知)  │
              │                          │
              │  Windsurf → stdin JSON   │
              │  分析 response → 分类     │
              │  HTTP → OpenClaw webhook  │
              └──────────┬───────────────┘
                         │ stdin
                  ┌──────┴──────┐
                  │  Windsurf    │
                  │  (Cascade)   │
                  └─────────────┘
```

### 3.4 数据流详解

#### 场景 1: 配额耗尽 → 换号 → 继续

```
T0  Cascade 回复包含 quota exhausted 错误
T1  Windsurf 触发 post_cascade_response Hook
T2  Hook 脚本解析 stdin JSON, 分类为 "quota_exhausted"
T3  Hook → HTTP POST OpenClaw webhook
      body: { event: "quota_exhausted", trajectoryId: "abc123" }
T4  Hook 退出 (< 1s)

    ┌─ OpenClaw 决策引擎 ─────────────────────────────────┐
    │                                                       │
    │ T5  收到事件, 查询插件: GET /api/ap/quota             │
    │ T6  确认当前账号配额耗尽 → 决策: 换号                  │
    │ T7  调用插件: POST /api/ap/switch-next                │
    │     插件返回: { success: true, switchedTo: "b@x.com" }│
    │ T8  等待 3s (让 Windsurf LS 刷新 session)             │
    │ T9  调用脚本: ui-control.sh send "继续上面的任务"      │
    │ T10 状态机 → executing                                │
    │                                                       │
    └───────────────────────────────────────────────────────┘
```

#### 场景 2: 临时限速 → 等待 → 重试

```
T0  Hook 分类为 "rate_limit_temp"
T1  Hook → OpenClaw: { event: "rate_limit_temp" }
T2  OpenClaw 决策: 临时限速, 不换号
T3  OpenClaw 等待 30s
T4  OpenClaw → ui-control.sh send "继续"
```

#### 场景 3: 上下文过长 → 新 Session

```
T0  Hook (with_transcript) 统计 JSONL 行数 > 200
T1  Hook → OpenClaw: { event: "context_overflow", stepCount: 250 }
T2  OpenClaw → ui-control.sh new-session "@conversation 继续之前的工作"
```

#### 场景 4: 任务完成 → 下一个任务

```
T0  Hook 分类为 "completed"
T1  Hook → OpenClaw: { event: "completed" }
T2  OpenClaw 检查任务队列
      有 → ui-control.sh send "{next_prompt}"
      空 → 状态 → idle
```

### 3.5 组件 A: Quote 插件新增 HTTP API

**不需要新建文件**, 在 `bridge.ts` 中新增路由, handler 直接调用 `WindsurfAccountManager` 已有方法。

| 路由                  | 方法 | 请求体          | 响应                                      | 调用的已有方法                     |
| --------------------- | ---- | --------------- | ----------------------------------------- | ---------------------------------- |
| `/api/ap/accounts`    | GET  | -               | `{ accounts: [...] }` (脱敏, 无 password) | `getAll()`                         |
| `/api/ap/quota`       | GET  | -               | `{ current, all }`                        | `getCurrentAccount()` + `getAll()` |
| `/api/ap/switch`      | POST | `{ accountId }` | `{ success, switchedTo? }`                | `switchTo(id)`                     |
| `/api/ap/switch-next` | POST | -               | `{ success, switchedTo? }`                | `autoSwitchIfNeeded()`             |
| `/api/ap/refresh`     | POST | -               | `{ success, count }`                      | `fetchAllRealQuotas()`             |

**实现要点**:

```typescript
// bridge.ts 路由处理 — 示意代码
// 注: accountManager 通过构造函数或 setter 注入到 Bridge

if (pathname === "/api/ap/accounts" && method === "GET") {
  const accounts = this.accountManager.getAll().map((a) => ({
    ...a,
    password: "***", // 脱敏
  }));
  writeJson(response, 200, { success: true, accounts });
  return;
}

if (pathname === "/api/ap/switch-next" && method === "POST") {
  const switched = await this.accountManager.autoSwitchIfNeeded();
  if (switched) {
    const current = this.accountManager.getCurrentAccount();
    writeJson(response, 200, {
      success: true,
      switchedTo: current?.email,
    });
  } else {
    writeJson(response, 200, {
      success: false,
      error: "无可用账号或无需切换",
    });
  }
  return;
}
```

**端口发现** (供 Hook 和 OpenClaw 使用):

```typescript
// bridge.ts start() 完成后
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const portFile = path.join(os.homedir(), ".quote-bridge-port");
await fs.writeFile(portFile, String(runningPort));

// deactivate() 时清理
await fs.unlink(portFile).catch(() => {});
```

### 3.6 组件 B: GUI 脚本 (ui-control.sh)

**位置**: `scripts/autopilot/ui-control.sh`
**特点**: 无状态, 被 OpenClaw 通过 subprocess 调用

```bash
#!/bin/bash
# ui-control.sh — Windsurf GUI 自动化工具
# 被 OpenClaw 调用，不做任何决策
#
# 用法:
#   ui-control.sh check                         # 检查 Windsurf 是否运行
#   ui-control.sh focus                          # 激活 Windsurf 窗口
#   ui-control.sh send "继续上面的任务"           # 向 Cascade 发送消息
#   ui-control.sh new-session "@conversation ..."# 开新会话并发送
#
# 退出码: 0=成功, 1=参数错误, 2=Windsurf未运行

ACTION="$1"
MESSAGE="$2"

check_windsurf() {
    pgrep -x "Windsurf" > /dev/null 2>&1
}

activate_windsurf() {
    if ! check_windsurf; then
        echo "ERROR: Windsurf is not running" >&2
        exit 2
    fi
    osascript -e 'tell application "Windsurf" to activate' 2>/dev/null
    sleep 0.5
}

focus_cascade() {
    osascript -e '
    tell application "System Events"
        tell process "Windsurf"
            keystroke "l" using {command down}
        end tell
    end tell
    ' 2>/dev/null
    sleep 0.3
}

paste_and_send() {
    local msg="$1"
    local old_clip
    old_clip=$(pbpaste 2>/dev/null)
    echo -n "$msg" | pbcopy
    osascript -e '
    tell application "System Events"
        tell process "Windsurf"
            keystroke "v" using {command down}
            delay 0.3
            key code 36
        end tell
    end tell
    ' 2>/dev/null
    sleep 0.5
    echo -n "$old_clip" | pbcopy 2>/dev/null
}

case "$ACTION" in
    check)
        check_windsurf && echo "OK" || { echo "NOT_RUNNING"; exit 2; }
        ;;
    focus)
        activate_windsurf
        ;;
    send)
        [ -z "$MESSAGE" ] && { echo "ERROR: message required" >&2; exit 1; }
        activate_windsurf
        focus_cascade
        paste_and_send "$MESSAGE"
        ;;
    new-session)
        [ -z "$MESSAGE" ] && { echo "ERROR: message required" >&2; exit 1; }
        activate_windsurf
        focus_cascade
        sleep 0.2
        focus_cascade  # 第二次 Cmd+L = 新建会话
        sleep 0.5
        paste_and_send "$MESSAGE"
        ;;
    *)
        echo "Usage: ui-control.sh <check|focus|send|new-session> [message]" >&2
        exit 1
        ;;
esac
```

### 3.7 组件 C: Cascade Hook 脚本 (cascade-hook.py)

**位置**: `scripts/autopilot/cascade-hook.py`
**职责**: 分析 → 分类 → 通知 OpenClaw → 退出 (< 1s)

```python
#!/usr/bin/env python3
"""
Cascade Hook — 事件感知层
只负责分析和通知，不做任何决策或操作。
"""
import sys, json, re, os, urllib.request
from datetime import datetime

LOG = os.path.expanduser("~/.quote-autopilot.log")
OPENCLAW_WEBHOOK = os.environ.get(
    "OPENCLAW_WEBHOOK", "http://127.0.0.1:9090/hooks/cascade-event")

def log(msg):
    try:
        with open(LOG, "a") as f:
            f.write(f"[{datetime.now().isoformat()}] {msg}\n")
    except: pass

def get_bridge_url():
    try:
        with open(os.path.expanduser("~/.quote-bridge-port")) as f:
            return f"http://127.0.0.1:{f.read().strip()}"
    except:
        return "http://127.0.0.1:3456"

def post(url, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=5)
        return True
    except:
        return False

QUOTA_PATTERNS = [
    r"quota.?(?:has been|is).?(?:exceeded|exhausted|used up)",
    r"no.?(?:remaining|available).?(?:credits|quota)",
    r"upgrade.?(?:your|to).?plan",
]
RATE_PATTERNS = [
    r"rate.?limit", r"too.?many.?requests", r"429",
    r"please.?wait", r"try.?again.?later",
]

def classify(text):
    for p in QUOTA_PATTERNS:
        if re.search(p, text, re.I): return "quota_exhausted"
    for p in RATE_PATTERNS:
        if re.search(p, text, re.I): return "rate_limit_temp"
    return "completed"

def main():
    try:
        data = json.loads(sys.stdin.read())
    except:
        return

    action = data.get("agent_action_name", "")
    tid = data.get("trajectory_id", "")
    info = data.get("tool_info", {})
    event = None

    if action == "post_cascade_response":
        event = {
            "source": "cascade_hook",
            "event": classify(info.get("response", "")),
            "trajectoryId": tid,
            "ts": datetime.now().isoformat(),
        }
    elif action == "post_cascade_response_with_transcript":
        tp = info.get("transcript_path", "")
        if tp and os.path.exists(tp):
            with open(tp) as f:
                n = sum(1 for _ in f)
            if n > 200:
                event = {
                    "source": "cascade_hook",
                    "event": "context_overflow",
                    "trajectoryId": tid,
                    "stepCount": n,
                    "ts": datetime.now().isoformat(),
                }

    if event:
        log(f"{event['event']} tid={tid}")
        if not post(OPENCLAW_WEBHOOK, event):
            post(f"{get_bridge_url()}/api/ap/event", event)

if __name__ == "__main__":
    main()
```

### 3.8 组件 D: Windsurf Hooks 配置

**位置**: `~/.codeium/windsurf/hooks.json`

```json
{
  "hooks": {
    "post_cascade_response": [
      {
        "command": "python3 ~/Desktop/code/tmp/ai-quote/scripts/autopilot/cascade-hook.py",
        "show_output": false
      }
    ],
    "post_cascade_response_with_transcript": [
      {
        "command": "python3 ~/Desktop/code/tmp/ai-quote/scripts/autopilot/cascade-hook.py",
        "show_output": false
      }
    ]
  }
}
```

### 3.9 组件 E: OpenClaw 决策引擎

**OpenClaw 是唯一的决策者。** 以下是它的决策流程和配置:

```
收到事件
  │
  ├─ event = "completed"
  │    └─ 检查任务队列
  │         ├─ 有 → ui-control.sh send "{next_prompt}"
  │         └─ 空 → idle
  │
  ├─ event = "rate_limit_temp"
  │    └─ 等待 30s → ui-control.sh send "继续"
  │
  ├─ event = "quota_exhausted"
  │    └─ POST /api/ap/switch-next (插件换号)
  │         ├─ 成功 → sleep 3s → ui-control.sh send "继续上面的任务"
  │         └─ 失败 → waiting, 每5分钟 GET /api/ap/quota 检查恢复
  │
  └─ event = "context_overflow"
       └─ ui-control.sh new-session "@conversation 继续之前的工作"
```

OpenClaw 配置示例:

```yaml
# openclaw-rules.yaml
name: windsurf-autopilot
triggers:
  - webhook: /hooks/cascade-event

vars:
  bridge_port_file: ~/.quote-bridge-port
  ui_script: ~/Desktop/code/tmp/ai-quote/scripts/autopilot/ui-control.sh

rules:
  - when: event == "quota_exhausted"
    do:
      - http_post: "http://127.0.0.1:{bridge_port}/api/ap/switch-next"
      - wait: 3s
      - exec: "{ui_script} send '继续上面的任务'"

  - when: event == "rate_limit_temp"
    do:
      - wait: 30s
      - exec: "{ui_script} send '继续'"

  - when: event == "context_overflow"
    do:
      - exec: "{ui_script} new-session '@conversation 继续之前的工作'"

  - when: event == "completed"
    do:
      - dequeue_next_task:
          on_task: exec "{ui_script} send '{task.prompt}'"
          on_empty: set_state idle

nightwatch:
  pre_start:
    - exec: "caffeinate -dims -t 28800 &" # 8小时防休眠
  health_check:
    interval: 5m
    do:
      - exec: "{ui_script} check"
      - http_get: "http://127.0.0.1:{bridge_port}/api/ap/quota"
```

### 3.10 Edge Cases 和故障模式

| 场景                     | 谁处理    | 解决方案                                        |
| ------------------------ | --------- | ----------------------------------------------- |
| 两个 Hook 同时触发       | OpenClaw  | 去重: 同一 trajectoryId 5s 内只处理一次         |
| switchTo 后 Cascade 中断 | OpenClaw  | 等 3s, 若 10s 内无 completed 事件则开新 session |
| Bridge 端口变化          | Hook 脚本 | 读取 `~/.quote-bridge-port`                     |
| AppleScript 焦点丢失     | OpenClaw  | ui-control.sh 返回非 0, 重试 3 次               |
| 所有账号额度耗尽         | OpenClaw  | 状态 → waiting, 每 5 分钟查配额                 |
| OpenClaw 挂掉            | 插件      | 插件内置 autoSwitch 定时器仍在运行 (fallback)   |
| Windsurf 崩溃            | OpenClaw  | ui-control.sh check 返回 exit 2, 等待重启       |
| 剪贴板竞争               | GUI 脚本  | 保存/恢复剪贴板内容                             |
| macOS 权限缺失           | 用户      | 首次手动授权 System Events                      |

---

## 四、Windsurf 已有的辅助能力

### 1. Auto-Continue（内置）

Windsurf 已内置 **Auto-Continue** 设置：当 Cascade 因工具调用次数限制（20次/prompt）停止时，可以自动发送 `continue`。

> "You can configure an Auto-Continue setting to have Cascade automatically continue its response if it hits a limit."

**但这只针对工具调用次数限制**，不处理 rate limit 或额度耗尽。

### 2. @-mention Previous Conversations（内置）

Windsurf 原生支持通过 `@conversation` 引用之前的对话：

> "When you do this, Cascade will retrieve the most relevant and useful information like the conversation summaries and checkpoints."

**这意味着开新 tab 后可以 @mention 之前的对话来延续上下文。**

### 3. Simultaneous Cascades（内置）

可以同时运行多个 Cascade，通过下拉菜单切换。

### 4. Queued Messages（内置）

Cascade 工作时可以排队新消息，工作完成后自动依次发送。

---

## 五、风险与缓解

| 风险                                       | 严重性 | 缓解措施                                |
| ------------------------------------------ | ------ | --------------------------------------- |
| AppleScript 键盘模拟不可靠（窗口焦点丢失） | 🟡 中  | 发送前先 activate 窗口 + delay 等待     |
| Windsurf 更新可能改变快捷键                | 🟡 中  | 快捷键配置化，检测版本号                |
| macOS 安全性限制（辅助功能权限）           | 🟢 低  | 首次需要手动授权 System Events 访问权限 |
| Hook 执行超时                              | 🟡 中  | 异步执行，不阻塞 Cascade                |
| 屏幕锁定/休眠导致自动化失败                | 🔴 高  | caffeinate 命令保持唤醒 + 禁用锁屏      |
| 中文输入法干扰                             | 🟡 中  | 使用剪贴板粘贴代替直接输入              |
| 多显示器坐标偏移                           | 🟢 低  | 使用键盘快捷键代替鼠标坐标              |

### 🔴 最大风险：屏幕必须保持活跃

AppleScript/Hammerspoon 的键盘模拟需要**窗口可见**。夜间自动化需要：

```bash
# 防止 Mac 休眠（无限期）
caffeinate -dims &

# 或者在自动化脚本中
caffeinate -dims -t 28800 &  # 8 小时
```

同时在 System Settings → Lock Screen → 设置"永不"锁屏。

---

## 六、替代方案对比

| 方案                               | 可行性   | 稳定性   | 维护成本 | 推荐度             |
| ---------------------------------- | -------- | -------- | -------- | ------------------ |
| **A: Cascade Hooks + AppleScript** | ⭐⭐⭐⭐ | ⭐⭐⭐   | ⭐⭐⭐   | ✅ **推荐**        |
| B: 纯 VS Code Extension API        | ⭐⭐     | ⭐⭐⭐⭐ | ⭐⭐     | ❌ API 不足        |
| C: Hammerspoon 全自动化            | ⭐⭐⭐⭐ | ⭐⭐⭐   | ⭐⭐⭐   | ✅ 备选            |
| D: pyautogui 屏幕坐标              | ⭐⭐⭐   | ⭐⭐     | ⭐       | ⚠️ 脆弱            |
| E: macOS Accessibility API         | ⭐⭐     | ⭐⭐     | ⭐       | ❌ Electron 支持差 |
| F: 直接劫持 Windsurf 协议          | ⭐       | ⭐       | ⭐       | ❌ 高风险          |

---

## 七、实施 SOP（标准操作流程）

### Phase 1：插件 API 层（1-2天）

**目标**: 让 Quote 插件成为可被外部调用的换号服务

| #   | 任务                                             | 文件           | 验证方式                                                             |
| --- | ------------------------------------------------ | -------------- | -------------------------------------------------------------------- |
| 1.1 | Bridge 启动后写入端口文件 `~/.quote-bridge-port` | `bridge.ts`    | `cat ~/.quote-bridge-port` 显示端口                                  |
| 1.2 | 新增路由 `GET /api/ap/accounts`                  | `bridge.ts`    | `curl localhost:3456/api/ap/accounts`                                |
| 1.3 | 新增路由 `GET /api/ap/quota`                     | `bridge.ts`    | `curl localhost:3456/api/ap/quota`                                   |
| 1.4 | 新增路由 `POST /api/ap/switch`                   | `bridge.ts`    | `curl -X POST -d '{"accountId":"xxx"}' localhost:3456/api/ap/switch` |
| 1.5 | 新增路由 `POST /api/ap/switch-next`              | `bridge.ts`    | `curl -X POST localhost:3456/api/ap/switch-next`                     |
| 1.6 | 新增路由 `POST /api/ap/refresh`                  | `bridge.ts`    | `curl -X POST localhost:3456/api/ap/refresh`                         |
| 1.7 | `deactivate()` 时清理端口文件                    | `extension.ts` | 关闭 Windsurf 后文件消失                                             |
| 1.8 | 单元测试: 路由返回格式正确                       | `tests/`       | `npm run test`                                                       |

**SOP 步骤**:

1. `bridge.ts` 构造函数接收 `WindsurfAccountManager` 引用
2. 在 `handleRequest()` 中新增 `/api/ap/*` 路由分支
3. 每个路由 handler 直接调用 `accountManager` 已有方法
4. `/api/ap/accounts` 脱敏: `password` → `"***"`
5. 测试: 手动 curl 验证所有 5 个端点

### Phase 2：GUI 脚本 + Hook 脚本（1天）

**目标**: 创建两个独立脚本，分别验证可用

| #   | 任务                   | 文件                                | 验证方式                                    |
| --- | ---------------------- | ----------------------------------- | ------------------------------------------- |
| 2.1 | 创建 `ui-control.sh`   | `scripts/autopilot/ui-control.sh`   | `./ui-control.sh check` 返回 OK             |
| 2.2 | 验证 send 功能         | -                                   | `./ui-control.sh send "hello"` Cascade 收到 |
| 2.3 | 验证 new-session       | -                                   | `./ui-control.sh new-session "test"` 新 tab |
| 2.4 | 创建 `cascade-hook.py` | `scripts/autopilot/cascade-hook.py` | 手动 pipe 测试 JSON                         |
| 2.5 | 配置 `hooks.json`      | `~/.codeium/windsurf/hooks.json`    | Cascade 回复后看日志                        |
| 2.6 | 验证 Hook → 日志       | -                                   | `tail -f ~/.quote-autopilot.log`            |

**SOP 步骤**:

1. `chmod +x scripts/autopilot/ui-control.sh`
2. 打开 Windsurf，执行 `./ui-control.sh send "测试"` → 确认 Cascade 收到
3. 执行 `./ui-control.sh new-session "测试新会话"` → 确认新 tab
4. 手动测试 Hook: `echo '{"agent_action_name":"post_cascade_response","trajectory_id":"test","tool_info":{"response":"rate limit exceeded"}}' | python3 cascade-hook.py`
5. 检查 `~/.quote-autopilot.log` 有日志
6. 配置 hooks.json，在 Cascade 中触发一次回复，看日志是否自动产生

### Phase 3：OpenClaw 集成（2-3天）

**目标**: OpenClaw 作为决策大脑驱动完整循环

| #   | 任务                            | 位置     | 验证方式           |
| --- | ------------------------------- | -------- | ------------------ |
| 3.1 | OpenClaw webhook 接收 Hook 事件 | OpenClaw | 收到 Hook POST     |
| 3.2 | 实现 quota_exhausted 规则       | OpenClaw | 换号 + 发送继续    |
| 3.3 | 实现 rate_limit_temp 规则       | OpenClaw | 等 30s + 重试      |
| 3.4 | 实现 context_overflow 规则      | OpenClaw | 新 session         |
| 3.5 | 实现 completed 规则 + 任务队列  | OpenClaw | 自动派发下一个任务 |
| 3.6 | caffeinate 防休眠集成           | OpenClaw | Mac 不休眠         |
| 3.7 | 端到端全链路测试                | -        | 夜间空跑 4 小时    |

**SOP 步骤**:

1. OpenClaw 注册 webhook `/hooks/cascade-event`
2. 配置决策规则 (参考 3.9 节 YAML)
3. 手动模拟: `curl -X POST -d '{"event":"quota_exhausted"}' localhost:9090/hooks/cascade-event`
4. 观察: OpenClaw → POST /api/ap/switch-next → ui-control.sh send → Cascade 收到
5. 端到端测试: 在 Cascade 中故意触发 rate limit，观察全链路自动恢复

### Phase 4：稳定化（持续）

| #   | 任务                                  | 说明                                |
| --- | ------------------------------------- | ----------------------------------- |
| 4.1 | OpenClaw 去重 (同 trajectoryId 5s 内) | 防两个 Hook 重复触发                |
| 4.2 | switchTo 后超时检测                   | 10s 无 completed → 开新 session     |
| 4.3 | 全部账号耗尽 → waiting 状态           | 每 5 分钟检查配额恢复               |
| 4.4 | Windsurf 崩溃恢复                     | check → exit 2 → 等待重启           |
| 4.5 | AppleScript 重试机制                  | 失败 → 重试 3 次, 间隔 1s           |
| 4.6 | 监控面板                              | OpenClaw 状态 + 插件配额 + 脚本健康 |
| 4.7 | 夜间 8 小时空跑测试                   | 完整验收                            |

---

## 八、关键技术参考

### 文档来源

| 来源                   | URL                                                            | 关键信息                     |
| ---------------------- | -------------------------------------------------------------- | ---------------------------- |
| Windsurf Cascade Hooks | https://docs.windsurf.com/windsurf/cascade/hooks               | 12 个 Hook 事件              |
| Windsurf Cascade 概览  | https://docs.windsurf.com/windsurf/cascade/cascade             | Auto-Continue, @mention      |
| VS Code Chat API       | https://code.visualstudio.com/api/extension-guides/ai/chat     | Chat Participant API         |
| VS Code Commands       | SO #77739243                                                   | `workbench.action.chat.open` |
| OpenClaw Hooks         | https://docs.openclaw.ai/automation/hooks                      | 事件系统                     |
| OpenClaw Sub-agents    | https://docs.openclaw.ai/tools/subagents                       | 子代理编排                   |
| cliclick               | https://github.com/BlueM/cliclick                              | macOS CLI 鼠标模拟           |
| Hammerspoon            | https://www.hammerspoon.org/                                   | macOS 自动化框架             |
| Electron Accessibility | https://www.electronjs.org/docs/latest/tutorial/accessibility/ | AX API 限制                  |

### Windsurf 快捷键（macOS）

| 快捷键         | 功能              |
| -------------- | ----------------- |
| `Cmd+L`        | 打开/聚焦 Cascade |
| `Cmd+L` (再次) | 新建 Cascade 会话 |
| `Cmd+Shift+R`  | Cascade Code 模式 |
| `Cmd+I`        | 内联命令          |
| `Enter`        | 发送消息          |
| `Shift+Enter`  | 换行不发送        |

---

## 九、结论

### 可行性判定：✅ 完全可行

### 架构定性：三方职责分离

```
┌─────────────┐     事件      ┌─────────────┐     HTTP      ┌─────────────┐
│ Cascade Hook │ ──────────▶ │  OpenClaw    │ ──────────▶ │ Quote 插件   │
│ (感知)       │              │  (决策)      │              │ (换号)       │
└─────────────┘              │              │              └─────────────┘
                             │              │   subprocess  ┌─────────────┐
                             │              │ ──────────▶ │ GUI 脚本     │
                             └─────────────┘              │ (界面操作)   │
                                                          └─────────────┘
```

| 组件             | 位置                                | 通信方式                           | 状态管理                 |
| ---------------- | ----------------------------------- | ---------------------------------- | ------------------------ |
| **Cascade Hook** | `scripts/autopilot/cascade-hook.py` | stdin → HTTP POST                  | 无状态                   |
| **OpenClaw**     | 外部                                | webhook 接收, HTTP/subprocess 调用 | 有状态 (任务队列+状态机) |
| **Quote 插件**   | `bridge.ts` 新增路由                | HTTP API (被调用)                  | 已有状态 (账号+配额)     |
| **GUI 脚本**     | `scripts/autopilot/ui-control.sh`   | CLI (被调用)                       | 无状态                   |

### 核心洞见

1. **插件只管换号** — 已有 `switchTo()` / `autoSwitchIfNeeded()` / 配额检测, 只需暴露 5 个 HTTP 端点
2. **脚本只管 GUI** — AppleScript + 剪贴板, 4 个命令 (check/focus/send/new-session)
3. **OpenClaw 只管决策** — 接收事件 → 判断策略 → 分别调用插件和脚本
4. **每个组件可独立测试** — curl 测插件, 手动执行测脚本, 模拟 webhook 测 OpenClaw

### 已验证事实 vs 未验证假设

**已验证** ✅:

- Cascade Hook `post_cascade_response` 提供完整回复文本
- Hook stdin JSON 包含 `trajectory_id`
- `switchTo()` 通过 Firebase + Windsurf 原生 auth 命令实现
- Bridge 已有 HTTP 服务器, 新增路由零成本
- Windsurf 支持 `@conversation` 引用和 Auto-Continue

**需实测** ⚠️:

- `switchTo()` 后当前 Cascade 对话是否仍可继续
- `Cmd+L` 两次是否新建会话
- Hook 脚本执行超时限制
- 多窗口下 AppleScript `activate` 定位

### 预估工作量

| Phase             | 工作量               | 改动范围                     |
| ----------------- | -------------------- | ---------------------------- |
| Phase 1: 插件 API | 1-2 天               | `bridge.ts` + `extension.ts` |
| Phase 2: 脚本     | 1 天                 | 两个新文件 + hooks.json      |
| Phase 3: OpenClaw | 2-3 天               | OpenClaw 规则 + 全链路联调   |
| Phase 4: 稳定化   | 持续                 | 去重/重试/监控               |
| **总计**          | **~6 天** + 持续优化 |                              |
