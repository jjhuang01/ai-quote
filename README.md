# Quote

Windsurf 账号管理工具。支持多账号切换、配额统计、本地 MCP Bridge、LLM 对话面板。

---

## 安装

从 VSIX 安装：扩展面板右上角 `···` → **从 VSIX 安装** → 选择 `ai-quote-2.7.7.vsix`。

安装后重新加载窗口，Activity Bar 会自动出现 Quote 图标。若未出现，右键单击 Activity Bar 空白处 → 勾选 **Quote**。

---

## 功能

- **账号管理** — 添加、切换、删除 Windsurf 账号
- **配额统计** — 查看各账号日/周配额使用情况
- **MCP Bridge** — 本地 SSE 桥接服务（默认端口 3456），支持多窗口独立端口
- **Dialog Panel** — LLM 调用时弹出对话面板，支持 Markdown 渲染（代码高亮、Mermaid 流程图、KaTeX 数学公式）
- **文件附件** — 拖拽/粘贴文件和图片，自动去重，支持 100+ 文件类型
- **无人值守队列** — 预设回复队列，LLM 调用时自动发送
- **调试面板** — 查看运行日志，一键复制给 AI 排错

---

## 命令

`Cmd+Shift+P` 输入 `Quote` 可找到以下命令：

| 命令                     | 说明                        |
| ------------------------ | --------------------------- |
| `Quote: Open Panel`      | 打开侧边栏面板              |
| `Quote: Refresh`         | 刷新状态                    |
| `Quote: Show Status`     | 查看 Bridge 运行状态        |
| `Quote: Copy Port`       | 复制当前端口号              |
| `Quote: Rotate MCP Name` | 轮换 MCP 工具名             |
| `Quote: Test Dialog`     | 模拟 LLM 调用，测试对话面板 |
| `Quote: Test Feedback`   | 发送测试反馈消息            |

---

## 设置

在 VS Code / Cursor 设置中搜索 `Quote`：

| 设置项                       | 默认值  | 说明                                           |
| ---------------------------- | ------- | ---------------------------------------------- |
| `quote.serverPort`           | `3456`  | MCP Bridge 监听端口                            |
| `quote.autoConfigureRules`   | `false` | 自动配置工作区级别规则文件                     |
| `quote.dialogTimeoutSeconds` | `0`     | 对话框超时秒数（0 = 不超时，无限等待用户回复） |

---

## 常见问题

**侧边栏图标不显示**
右键单击 Activity Bar → 找到 **Quote** → 勾选。

**端口冲突**
在设置中将 `quote.serverPort` 改为其他端口（如 `3457`），重新加载窗口。

**多窗口使用**
每个窗口自动分配独立端口和工具名，MCP 配置采用追加模式，互不干扰。

**账号切换不生效**
查看调试面板（**调试** 标签页）获取详细日志。
