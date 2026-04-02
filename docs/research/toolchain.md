# Toolchain Research Summary

## Official Guidance Used

- VS Code Testing Extensions
- VS Code Bundling Extensions
- VS Code Webview API
- VS Code Extension Manifest
- VS Code Activation Events
- VS Code Extension Host
- VS Code Workspace Trust

## Selected Stack

- TypeScript：与 VS Code 扩展生态一致
- esbuild：官方 bundling 页面明确推荐，构建快、调试轻量
- Vitest：现代 TS 单测体验好，启动快
- `@vscode/test-cli` + `@vscode/test-electron`：官方扩展测试链路

## Why Not Over-Engineer

- 不引入 React / Vite 作为扩展核心依赖，避免桥接与调试成本上升
- webview 采用轻量 TS + CSS，足够表达状态型 UI
