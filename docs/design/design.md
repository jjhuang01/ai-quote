# Design

## Design Direction

采用 **VS Code-native dark UI + low-friction operational dashboard** 风格。

## Key Principles

- 不做“花里胡哨”的独立产品感，而是融入 VS Code。
- 优先展示状态、端口、IDE 目标、规则文件、最近消息、桥接事件。
- 用户一眼能看出：服务是否运行、配置是否落盘、最近一次消息是否成功。

## Information Hierarchy

1. 顶部：Bridge 状态 + 端口 + 当前 IDE + 工具名
2. 中部：Recent events / messages
3. 下部：Quick actions（Refresh / Test Feedback / Open Config）
4. 侧信息：Parity badge（Proven / Inferred）与日志路径
