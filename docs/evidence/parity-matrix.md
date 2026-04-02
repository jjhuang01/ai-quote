# Parity Matrix

| Feature                             | Status  | Confidence | Notes                                              |
| ----------------------------------- | ------- | ---------: | -------------------------------------------------- |
| Activity Bar container              | ✅ Done |        1.0 | Manifest proven, `infinite-dialog-sidebar`         |
| Webview view                        | ✅ Done |        1.0 | Manifest proven, `infiniteDialogView`              |
| openPanel command                   | ✅ Done |        1.0 | Manifest proven                                    |
| refresh command                     | ✅ Done |        1.0 | Manifest proven                                    |
| testFeedback command                | ✅ Done |        0.8 | Title proven, internals inferred                   |
| showStatus command                  | ✅ Done |        0.8 | Title proven, internals inferred                   |
| Local bridge                        | ✅ Done |        0.9 | Symbols + routes proven                            |
| `/events` + `/message` + `/sse`     | ✅ Done |        0.9 | Strong route evidence                              |
| `/api/version` + `/mcp` + `/status` | ✅ Done |        0.9 | Strong route evidence                              |
| `/api/verify`                       | ✅ Done |        0.9 | Strong route evidence                              |
| `/api/firebase/login`               | ✅ Done |        0.8 | Strong route evidence, payload inferred            |
| Windsurf MCP config                 | ✅ Done |       0.95 | `.codeium/windsurf/mcp_config.json`                |
| Cursor MCP config                   | ✅ Done |       0.95 | `.cursor/mcp.json`                                 |
| VS Code MCP config                  | ✅ Done |       0.95 | `.vscode/mcp.json`                                 |
| Trae MCP config                     | ✅ Done |        0.9 | `.trae/mcp.json`                                   |
| Kiro MCP config                     | ✅ Done |       0.55 | Exists as target, exact path inferred              |
| Cursor rules file                   | ✅ Done |       0.95 | `.cursor/rules/EVILZIXIE.mdc`                      |
| Workspace feedback rules            | ✅ Done |        0.9 | `AI_FEEDBACK_RULES.md`                             |
| DataManager singleton               | ✅ Done |        0.9 | `DataManager.getInstance()` pattern                |
| SessionHistory                      | ✅ Done |        0.8 | `sessionHistory` strings in original               |
| StatusTTL                           | ✅ Done |        0.7 | `statusTTL` strings in original                    |
| Submit continue/end                 | ✅ Done |        0.8 | `submit('continue')` / `submit('end')` in original |
| History menu/delete                 | ✅ Done |        0.9 | `.history-menu` CSS class in original              |
| Pagination (accountPage/pageSize)   | ✅ Done |        0.8 | `_accountPage` / `_pageSize` state vars            |
| Chinese UI labels                   | ✅ Done |        0.9 | `服务端口` / `自动配置全局规则` in original        |
| WindsurfAccountManager              | ✅ Done |       0.95 | Class name strongly evidenced                      |
