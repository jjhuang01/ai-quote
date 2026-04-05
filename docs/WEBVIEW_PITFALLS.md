# VS Code / Windsurf WebviewPanel 避坑指南

> 版本: 2025-04 | 适用: VS Code ≥ 1.80, Windsurf (Codeium fork)

---

## 🔴 致命坑 #1: 内联脚本被 CSP 静默阻止

### 现象

WebviewPanel 中所有 JS 功能完全失效 — 按钮不响应、拖拽无效、快捷键无反应。
**没有任何错误提示**，浏览器控制台也看不到 CSP 违规报告（因为 webview DevTools 默认不开）。

### 根因

VS Code / Windsurf 的 webview 容器（iframe host）会在你的 HTML 外层施加自己的 CSP 策略。
当你的 `<meta http-equiv="Content-Security-Policy">` 写了 `script-src 'unsafe-inline'`，
但容器层的 CSP 不允许 `'unsafe-inline'`，**双层 CSP 同时生效，取交集**，结果所有内联脚本被静默阻止。

### 解决方案: 外部脚本 + nonce（官方推荐模式）

```html
<!-- CSP: 用 nonce 而非 unsafe-inline -->
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    img-src ${webview.cspSource} data:;">

<!-- 小型 inline bootstrap 传递配置（有 nonce） -->
<script nonce="${nonce}">
  window.__CONFIG__ = { sessionId: "...", ... };
</script>

<!-- 主逻辑放外部文件（有 nonce + src） -->
<script nonce="${nonce}" src="${scriptUri}"></script>
```

**关键要素:**
1. `nonce` 由 `crypto.randomBytes(16).toString('hex')` 生成
2. **每个** `<script>` 标签都必须有 `nonce` 属性
3. `scriptUri` 通过 `webview.asWebviewUri()` 转换
4. 外部脚本文件由 esbuild 打包到 `dist/webview/`

### 参考

- [VS Code 官方 webview-sample](https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts) — 使用外部 JS + nonce
- [VS Code Webview 文档 CSP 章节](https://code.visualstudio.com/api/extension-guides/webview#content-security-policy)

---

## 🔴 致命坑 #2: 模板字面量中的转义字符

### 现象

TypeScript 模板字面量 (`` `...` ``) 中嵌入的 JS 代码，其中的 `\n`, `\t`, `\\` 等转义序列
会被 TypeScript **在编译期求值**，变成真正的换行符/制表符。

### 典型错误

```typescript
// ❌ 错误：\n 变成真换行，正则跨行断裂 → JS 语法错误
return `<script>
  var items = raw.split(/\n---\n/);
</script>`;
```

生成的 HTML 中 JS 实际变成:

```javascript
var items = raw.split(/
---
/);  // ← 语法错误！正则不能跨行
```

### 解决方案

**方案 A（推荐）:** 将 JS 提取到外部 `.ts` 文件，由 esbuild 单独打包。
模板字面量里只保留极简的配置注入。

**方案 B:** 如果必须内联，用 `\\n` 双重转义:

```typescript
// ✅ 正确：\\n 在模板字面量中变成 \n 字面文本
return `<script>
  var items = raw.split(/\\n---\\n/);
</script>`;
```

---

## 🟡 常见坑 #3: acquireVsCodeApi 只能调用一次

```javascript
// ❌ 错误：重复调用会抛异常
const vscode1 = acquireVsCodeApi();
const vscode2 = acquireVsCodeApi(); // throws!

// ✅ 正确：全局保存一次
const vscode = acquireVsCodeApi();
```

---

## 🟡 常见坑 #4: webview.html 赋值会完全重置状态

每次设置 `panel.webview.html = ...` 都等于重新加载 iframe。
所有 JS 状态丢失。如果需要保留状态，使用 `vscode.getState()` / `vscode.setState()`。

---

## 🟡 常见坑 #5: localResourceRoots 限制资源加载

外部脚本必须在 `localResourceRoots` 允许的目录内。
如果脚本在 `dist/webview/dialog.js`，则 `localResourceRoots` 必须包含 `dist` 目录:

```typescript
vscode.window.createWebviewPanel('id', 'title', column, {
  enableScripts: true,
  retainContextWhenHidden: true,
  localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
});
```

---

## 📋 Checklist: WebviewPanel 上线前检查

- [ ] `enableScripts: true` 已设置
- [ ] CSP 使用 nonce-based `script-src`，不用 `'unsafe-inline'`
- [ ] 每个 `<script>` 标签都有 `nonce="${nonce}"` 属性
- [ ] 主逻辑在外部 JS 文件中，通过 `webview.asWebviewUri()` 加载
- [ ] `localResourceRoots` 包含脚本所在目录
- [ ] 模板字面量中无 `\n` / `\t` 等会被编译器求值的转义
- [ ] `acquireVsCodeApi()` 只调用一次
- [ ] 使用 **Developer: Toggle Developer Tools** 检查控制台有无 CSP 违规或 JS 错误

---

## 项目架构示例（Quote 插件）

```
media/
  main.ts          → sidebar webview 入口 (esbuild → dist/webview/main.js)
  dialog.ts        → dialog panel 入口 (esbuild → dist/webview/dialog.js)
src/webview/
  view-html.ts     → sidebar HTML 生成 (nonce + 外部脚本)
  dialog-panel.ts  → dialog HTML 生成 (nonce + 外部脚本 + inline bootstrap)
  provider.ts      → sidebar WebviewView provider
esbuild.mjs        → 三个构建目标: extension / webview / dialog
```
