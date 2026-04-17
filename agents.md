# Quote Agent Notes

## Mission

在单一项目目录内，以“证据优先、行为对齐、接口隔离、可验证交付”为原则，构建 Quote VS Code 扩展的完整能力。

## Hard Rules

- 不把混淆代码中的推断行为伪装成已知事实。
- 先恢复 manifest / command / view / config / local bridge 等可证实能力，再逐步补齐高风险功能。
- 所有运行时日志默认写入 VS Code `logUri`，仓库内 `logs/` 只存调试说明与测试产物。
- 对会修改用户目录的能力（MCP 配置、规则文件）必须做到：幂等、最小化、可追踪。
- MCP 配置采用**追加模式**：多窗口各自写入独立 toolName 条目，不清理其他窗口的条目。
- 规则文件只写**工作区级别**（`AI_FEEDBACK_RULES.md` + `.windsurfrules`），不写全局 `.mdc`。

## Evidence Anchors

- Activity Bar 容器：`quote-sidebar`
- Webview View：`quoteView`
- Commands：`quote.openPanel` / `quote.refresh` / `quote.testFeedback` / `quote.showStatus` / `quote.copyPort` / `quote.rotateName` / `quote.testDialog`
- Config：`quote.serverPort` / `quote.autoConfigureRules` / `quote.dialogTimeoutSeconds`
- Bridge endpoints：`/events` `/message` `/api/version` `/api/verify` `/api/firebase/login` `/sse`
- MCP config targets：Windsurf / Cursor / Kiro / Trae / VS Code
- Rules targets：`AI_FEEDBACK_RULES.md`（工作区）/ `.windsurfrules`（工作区）

## 日志文件位置

插件运行时日志写入 VS Code 扩展日志目录，路径格式：

```
~/Library/Application Support/Cursor/User/logs/<timestamp>/exthost/windsurf-account-manager/windsurf-account-manager.log
```

**获取日志路径**：

1. 打开插件侧边栏 → 切换到"调试" tab
2. 点击"复制路径"按钮获取完整路径
3. 或点击"复制给 AI"获取带诊断信息的完整日志

**日志内容**：

- 账号切换流程（补丁检查、Firebase 登录、API Key 获取、Session 注入）
- 配额获取（Channel E 本地 proto、Channel B GetPlanStatus）
- 错误详情（版本不匹配、权限问题、网络异常）
- MCP 配置写入、规则文件操作

## 打包约定

- 打包前必须升级 `package.json` 版本号。
- 产物应保持精简：排除 `archives/`、`experiments/`、`.superpowers/`、`data/`、源码 map 等非运行时内容。
- 交付前至少执行：`npm run test:unit`、`npm run check-types`、`npm run build`、`vsce package --no-dependencies`。

## Delivery Standard

- `npm run check-types`
- `npm run build`
- `npm run test`（含 unit + e2e）

全部通过前，不得宣称完成。
