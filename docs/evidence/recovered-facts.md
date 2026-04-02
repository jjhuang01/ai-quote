# Recovered Facts

## Proven

- 包内存在：`extension/package.json`, `extension/out/extension.js`, `extension/README.md`, `extension/resources/icon.svg`
- 激活事件：`onStartupFinished`
- 主入口：`./out/extension.js`
- View Container：`infinite-dialog-sidebar`
- Webview View：`infiniteDialogView`
- Commands：
  - `infiniteDialog.openPanel`
  - `infiniteDialog.refresh`
  - `infiniteDialog.testFeedback`
  - `infiniteDialog.showStatus`
- Settings：
  - `infiniteDialog.serverPort` default `3456`
  - `infiniteDialog.autoConfigureRules` default `true`
- Dependencies：`mammoth`, `proxy-agent`, `xlsx`
- Bundle strings / symbols：`MCPHttpServer`, `configureMcpConfig`, `configureGlobalRules`, `WindsurfAccountManager`
- Route fragments：`/events`, `/message`, `/api/version`, `/api/verify`, `/api/firebase/login`, `/sse`
- File targets：`.cursor/mcp.json`, `.vscode/mcp.json`, `.trae/mcp.json`, `.codeium/windsurf/mcp_config.json`, `AI_FEEDBACK_RULES.md`, `.cursor/rules/EVILZIXIE.mdc`

## Inferred

- Kiro 目标 MCP 文件路径
- 远端 verify/version/firebase 接口的完整字段语义
- account / credits / token 刷新完整规则
