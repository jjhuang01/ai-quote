# Requirements

## Functional Requirements

1. 创建一个单一项目目录，集中存放代码、文档、证据、日志、测试、调试配置。
2. 恢复原 VSIX 中 manifest 可见能力：
   - Activity Bar 容器 `infinite-dialog-sidebar`
   - Webview View `infiniteDialogView`
   - Commands：`openPanel` / `refresh` / `testFeedback` / `showStatus`
   - Settings：`serverPort` / `autoConfigureRules`
3. 启动本地 bridge，并暴露已观测到的关键接口族：
   - `GET /events`
   - `GET /sse`
   - `POST /message`
   - `GET /api/version`
   - `POST /api/verify`
   - `POST /api/firebase/login`
4. 提供当前 IDE MCP 配置自动化写入能力。
5. 提供规则文件生成能力，至少覆盖：
   - 工作区 `AI_FEEDBACK_RULES.md`
   - Cursor `~/.cursor/rules/EVILZIXIE.mdc`
6. 提供可观测性：状态栏、OutputChannel、结构化日志。
7. 提供测试：单测、Bridge E2E、扩展宿主集成测试。

## Non-Functional Requirements

- 不使用类型逃逸。
- 尽量幂等，不重复污染用户配置。
- 对未证实行为进行显式降级，而不是伪装实现。
- 调试体验清晰：可 F5、可看日志、可跑测试。
