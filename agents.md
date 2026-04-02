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

## Delivery Standard

- `npm run check-types`
- `npm run build`
- `npm run test`
- `npm run test:integration`

全部通过前，不得宣称完成。
