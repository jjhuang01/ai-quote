# Recovered Facts

## Proven

- 包内存在：`extension/package.json`, `extension/out/extension.js`, `extension/README.md`, `extension/resources/icon.svg`
- 激活事件：`onStartupFinished`
- 主入口：`./dist/extension.js`
- View Container：`quote-sidebar`
- Webview View：`quoteView`
- Commands：
  - `quote.openPanel`
  - `quote.refresh`
  - `quote.testFeedback`
  - `quote.showStatus`
  - `quote.copyPort`
  - `quote.rotateName`
  - `quote.testDialog`
- Settings：
  - `quote.serverPort` default `3456`
  - `quote.autoConfigureRules` default `false`
  - `quote.dialogTimeoutSeconds` default `0`
- Dependencies：`mammoth`, `proxy-agent`, `xlsx`, `highlight.js`, `katex`, `mermaid`
- Bundle strings / symbols：`MCPHttpServer`, `configureMcpConfig`, `configureGlobalRules`, `WindsurfAccountManager`
- Route fragments：`/events`, `/message`, `/api/version`, `/api/verify`, `/api/firebase/login`, `/sse`
- MCP file targets (append mode)：`.cursor/mcp.json`, `.vscode/mcp.json`, `.trae/mcp.json`, `.codeium/windsurf/mcp_config.json`, `.kiro/steering/mcp.json`
- Rules file targets (workspace only)：`AI_FEEDBACK_RULES.md`, `.windsurfrules`

## Inferred

- Kiro 目标 MCP 文件路径
- 远端 verify/version/firebase 接口的完整字段语义
- account / credits / token 刷新完整规则
