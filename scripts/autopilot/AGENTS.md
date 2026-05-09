# AGENTS.md

Project: `tmp/ai-quote/scripts/autopilot`

## 依赖管理策略
- JavaScript/TypeScript 项目优先使用 `pnpm` 安装依赖，通过全局 content-addressable store 与硬链接复用包内容。
- Python 项目优先使用 `uv`，保留每项目 `.venv`，通过全局 uv cache / 文件系统 CoW 复用包内容。
- 禁止创建单一共享的全局 `node_modules` 或单一共享的全局 Python virtualenv。
- 保留 lockfile，并优先使用 frozen/locked install。
- 如果项目不兼容 pnpm 或 uv，必须在本文件记录例外原因后再更换包管理器。
