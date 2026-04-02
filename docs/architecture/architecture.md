# Architecture

## Layers

- `src/extension.ts`：装配入口
- `src/core/`：状态、日志、bridge、命令编排
- `src/adapters/`：remote API、MCP 配置、规则文件、导入器
- `src/webview/`：VS Code webview provider 与 HTML 生成
- `media/`：webview 前端资源源码
- `tests/`：单测 / E2E / integration

## Boundary Rules

1. `shared contracts` 不依赖 VS Code API。
2. `adapters` 才允许接触文件系统、网络与第三方库。
3. `webview` 不直接操作本地文件，只通过 message 与 extension host 通讯。
4. `bridge` 只暴露证据明确支持的端点，不额外发明复杂协议。

## Runtime Flow

`activate()` → load config → start bridge → register provider & commands → optional auto-configure → push state to status bar & webview。
