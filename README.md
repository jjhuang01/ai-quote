# AI Echo Rebuild

基于本地证据对 `/Users/os/Downloads/ai-echo-2.1.4.vsix` 的 **高保真重建项目**。目标不是伪造"已知一切"，而是在单一目录内完成：证据归档、需求与架构文档、VS Code 扩展工程、MCP/HTTP bridge、规则自动配置、测试、调试、日志与验证链路。

---

## 🚀 开发指南

### 安装与构建

```bash
npm install
npm run build          # 类型检查 + 构建
npm run check-types    # 仅类型检查
```

### 开发模式

```bash
# Watch 模式 - 自动重编译
npm run dev

# 调试模式 - 构建后启动 VS Code 扩展宿主
npm run dev:debug
```

### 调试扩展

**方式 1: VS Code 内置调试**

1. 打开项目
2. 按 `F5` 启动调试
3. 新窗口自动加载扩展

**方式 2: 命令行调试**

```bash
npm run dev:debug
```

### 查看日志

**方式 1: 命令面板**

```
Cmd+Shift+P → AI Echo: Open Logs
```

**方式 2: Output 面板**

```
View → Output → 选择 "AI Echo Rebuild"
```

**方式 3: 直接打开**
日志路径: `~/Library/Application Support/Code/logs/.../exthost/ai-echo-rebuild.log`

---

## 🧪 测试

```bash
npm run test:unit        # 单元测试 (Vitest)
npm run test:e2e         # E2E 测试
npm run test             # 全部测试
npm run test:integration # 集成测试 (需要 VS Code)
npm run verify           # 完整验证流程
```

---

## 🔧 命令列表

| 命令                     | 说明                     |
| ------------------------ | ------------------------ |
| `AI Echo: Open Panel`    | 打开侧边栏面板           |
| `AI Echo: Refresh`       | 刷新状态                 |
| `AI Echo: Test Feedback` | 发送测试反馈消息         |
| `AI Echo: Show Status`   | 显示桥接状态             |
| `AI Echo: Open Logs`     | 在 Finder 中打开日志目录 |

---

## 🐛 常见问题排查

### 界面不显示

1. **检查 Output 面板**: `View → Output → AI Echo Rebuild`
2. **检查 Activity Bar**: 左侧边栏应有 "AI Echo" 图标
3. **手动触发**: `Cmd+Shift+P → AI Echo: Open Panel`
4. **开发者工具**: `Help → Toggle Developer Tools → Console`

### 端口冲突

```bash
# 检查端口占用
lsof -i :3456

# 更换端口 (设置中修改)
# infiniteDialog.serverPort: 3456 → 其他端口
```

### 扩展未激活

检查 `activationEvents`: `onStartupFinished` - 扩展在 VS Code 启动完成后激活

---

## 📁 项目结构

```
src/
├── extension.ts          # 扩展入口
├── core/
│   ├── bridge.ts         # HTTP/MCP 桥接服务器
│   ├── config.ts         # 配置读取
│   ├── contracts.ts      # 类型定义
│   └── logger.ts         # 日志系统
├── adapters/
│   ├── mcp-config.ts     # MCP 配置写入
│   ├── rules.ts          # 规则文件配置
│   └── remote-api.ts     # 远程 API 调用
├── webview/
│   ├── provider.ts       # Webview View Provider
│   └── view-html.ts      # HTML 模板
└── utils/
    └── tool-name.ts      # 工具名生成

media/
├── main.ts               # Webview 前端脚本
└── main.css              # Webview 样式

tests/
├── unit/                 # 单元测试
├── e2e/                  # E2E 测试
└── integration/          # 集成测试
```

---

## 📋 技术栈

| 类别   | 技术                               |
| ------ | ---------------------------------- |
| 语言   | TypeScript 5.8                     |
| 打包   | esbuild 0.27                       |
| 测试   | Vitest 4.1 + @vscode/test-electron |
| 运行时 | Node 18+ (VS Code Extension Host)  |
| 依赖   | mammoth, xlsx, proxy-agent         |

---

## 目录

- `agents.md`：项目级执行规则
- `docs/`：requirements / PRD / design / plan / tasks / architecture / epics / evidence / research
- `_evidence/original-vsix/`：原 VSIX 解包产物
- `src/`：扩展宿主、bridge、适配器、webview provider
- `media/`：webview 前端资源源码
- `tests/`：unit / e2e / integration
- `logs/`：仓库内日志约定与测试产物占位
- `.vscode/`：调试与任务配置

## 当前结论

- **已证实**：原扩展存在 Activity Bar Webview、4 个命令、2 个配置项、`mammoth/xlsx/proxy-agent` 依赖、`onStartupFinished` 激活。
- **高置信推断**：扩展包含本地 HTTP/MCP bridge、SSE 事件通道、远端版本/校验接口、多 IDE MCP 配置写入、规则文件自动生成。
- **不能诚实宣称**：在未获得未混淆源码或原始后端协议说明前，无法数学意义上声称"100% bit-level parity"。本项目采用的是 **evidence-driven functional parity**。

## 已恢复能力

1. 恢复原扩展 manifest 中已知的 view / command / config。
2. 启动本地 Echo Bridge，提供 `/events`、`/message`、`/api/version`、`/api/verify`、`/api/firebase/login`、`/sse` 等已观测端点。
3. 自动写入当前 IDE 对应的 MCP 配置文件，并在工作区写入反馈规则文件。
4. 提供状态栏、侧边栏 webview、测试反馈命令、桥接状态查看。
5. 以 parity matrix 记录"已证实 / 推断 / 未证实"。

## 重要说明

本项目对 `Kiro` 的 MCP 路径仍属于**推断实现**；其余 `Windsurf / Cursor / Trae / VS Code` 已有较强证据锚点。详情见 `docs/evidence/parity-matrix.md`。

## 快速开始

```bash
npm install
npm run build
npm run test
npm run test:integration
```

按 `F5` 使用扩展宿主启动调试。
