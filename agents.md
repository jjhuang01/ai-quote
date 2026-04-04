# AI Echo Rebuild Agent Notes

## Mission

在单一项目目录内，以“证据优先、行为对齐、接口隔离、可验证交付”为原则，重建 `ai-echo-2.1.4.vsix` 的可观察能力。

## Hard Rules

- 不把混淆代码中的推断行为伪装成已知事实。
- 先恢复 manifest / command / view / config / local bridge 等可证实能力，再逐步补齐高风险功能。
- 所有运行时日志默认写入 VS Code `logUri`，仓库内 `logs/` 只存调试说明与测试产物。
- 对会修改用户目录的能力（MCP 配置、规则文件）必须做到：幂等、最小化、可追踪。

## Evidence Anchors

- Activity Bar 容器：`infinite-dialog-sidebar`
- Webview View：`infiniteDialogView`
- Commands：`infiniteDialog.openPanel` / `refresh` / `testFeedback` / `showStatus`
- Config：`infiniteDialog.serverPort` / `infiniteDialog.autoConfigureRules`
- Inferred bridge endpoints：`/events` `/message` `/api/version` `/api/verify` `/api/firebase/login` `/sse`
- Inferred config targets：Windsurf / Cursor / Kiro / Trae / VS Code

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

## Delivery Standard

- `npm run check-types`
- `npm run build`
- `npm run test`
- `npm run test:integration`

全部通过前，不得宣称完成。
