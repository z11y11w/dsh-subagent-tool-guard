# Changelog

## 0.1.0 — 2026-11-15（首个测试版）

首个版本。

- 用 `agent.session.header.origin === 'subagent'` 识别子代理，主代理不动。
- 施加 `tools.restrict({ allow })`，`allow` 是「preset 视角工具名 − 全局层工具名」的差集，
  因此只保留该子代理自己 preset 声明的工具。
- 修正了一个常见误解：`restrict({ allow: [] })` 会把 preset 自己的工具一起挡掉，
  因为 preset 的行挂在独立的 standing scope 上（详见 `docs/01-源码核实报告.md`）。
- 只读报告工具 `subagent_tool_report`，派活前可自检某个 preset 还剩几个工具。
- 补扫已存在的 agent（插件晚于会话加载的情况）。
- 急救开关：`DSH_SUBAGENT_TOOL_GUARD_OFF=1`。
