# Parity Matrix

| Feature                             | Status  | Confidence | Notes                                                            |
| ----------------------------------- | ------- | ---------: | ---------------------------------------------------------------- |
| Activity Bar container              | ✅ Done |        1.0 | Manifest proven, `quote-sidebar`                                 |
| Webview view                        | ✅ Done |        1.0 | Manifest proven, `quoteView`                                     |
| openPanel command                   | ✅ Done |        1.0 | `quote.openPanel`                                                |
| refresh command                     | ✅ Done |        1.0 | `quote.refresh`                                                  |
| testFeedback command                | ✅ Done |        1.0 | `quote.testFeedback`                                             |
| showStatus command                  | ✅ Done |        1.0 | `quote.showStatus`                                               |
| copyPort command                    | ✅ Done |        1.0 | `quote.copyPort`                                                 |
| rotateName command                  | ✅ Done |        1.0 | `quote.rotateName`                                               |
| testDialog command                  | ✅ Done |        1.0 | `quote.testDialog` — simulates LLM call to test dialog panel     |
| Local bridge                        | ✅ Done |        0.9 | Symbols + routes proven                                          |
| `/events` + `/message` + `/sse`     | ✅ Done |        0.9 | Strong route evidence                                            |
| `/api/version` + `/mcp` + `/status` | ✅ Done |        0.9 | Strong route evidence                                            |
| `/api/verify`                       | ✅ Done |        0.9 | Strong route evidence                                            |
| `/api/firebase/login`               | ✅ Done |        0.8 | Strong route evidence, payload inferred                          |
| Windsurf MCP config                 | ✅ Done |       0.95 | `.codeium/windsurf/mcp_config.json` — append mode                |
| Cursor MCP config                   | ✅ Done |       0.95 | `.cursor/mcp.json` — append mode                                 |
| VS Code MCP config                  | ✅ Done |       0.95 | `.vscode/mcp.json` — append mode                                 |
| Trae MCP config                     | ✅ Done |        0.9 | `.trae/mcp.json` — append mode                                   |
| Kiro MCP config                     | ✅ Done |       0.55 | `.kiro/steering/mcp.json` — path inferred                        |
| Workspace feedback rules            | ✅ Done |        1.0 | `AI_FEEDBACK_RULES.md` (workspace only)                          |
| Windsurf workspace rules            | ✅ Done |        1.0 | `.windsurfrules` (workspace only, no global .mdc writes)         |
| Cursor global rules                 | ❌ N/A  |          — | Removed in v2.7.2: no longer writes `.cursor/rules/*.mdc`        |
| Windsurf global rules               | ❌ N/A  |          — | Removed in v2.7.2: no longer writes `~/.codeium/windsurf/rules/` |
| Multi-window isolation              | ✅ Done |        1.0 | Session-scoped toolName + port, MCP append, cleanup on exit      |
| Dialog Panel                        | ✅ Done |        1.0 | Editor tab, Markdown/code/Mermaid/KaTeX, file attach, queue      |
| File attachment dedup               | ✅ Done |        1.0 | filename+size check prevents duplicate uploads                   |
| Queue auto-reply                    | ✅ Done |        1.0 | Consumes first item, decrements, syncs to sidebar                |
| DataManager singleton               | ✅ Done |        0.9 | `DataManager.getInstance()` pattern                              |
| SessionHistory                      | ✅ Done |        0.8 | `sessionHistory` strings in original                             |
| StatusTTL                           | ✅ Done |        0.7 | `statusTTL` strings in original                                  |
| Chinese UI labels                   | ✅ Done |        0.9 | `服务端口` / `自动配置全局规则` in original                      |
| WindsurfAccountManager              | ✅ Done |       0.95 | Class name strongly evidenced                                    |
