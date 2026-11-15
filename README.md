# dsh-subagent-tool-guard

> **测试版（0.1.x）**：仍在验证阶段，行为可能随版本变化。正式使用前请先在一个测试会话里试。

子代理只能看见**它自己 preset 声明的工具**；从全局层和祖先层继承来的一律移除。主代理一行不动。

## 为什么需要它

DSH 里，一个 agent 能看到的工具 = **全局层 + 祖先层 + 自己这层**。而 agent preset 里的插件行是挂在一个独立的 standing scope 上的，对 agent 而言属于「继承来的」。结果是：

> 一个只装了两个 B 站工具的 preset，派出去的子代理照样能用浏览器、任务看板、文件系统——全套全局工具。

主代理还好，有人在看着、能喊停。子代理在后台跑，没人盯着，这就是问题。

本插件只对**子代理**动手：把继承来的工具全部移除，只保留该子代理自己 preset 声明的那几个。

- 主代理（`origin` 不是 `subagent` 的会话）：**完全不动**
- 子代理（`subagent` / `subagent_fork` / 任何后台派发的）：严格白名单
- Team 队友：在 DSH 内部同样是 subagent，默认一起限制

## 安装

Host-only bundle，没有构建步骤、没有运行时依赖、不联网。

1. 打开 DSH 的 **插件** 页面
2. **添加插件** → 选本地目录 → 选本仓库根目录
3. 确认插件行出现且为启用状态
4. 重启 DSH

装好之后，子代理只能用它自己 preset 里声明的工具；主代理完全不受影响。

## 它怎么工作

`tools.restrict()` 是 DSH 提供的唯一"减法"接口。但直接用 `allow: []`（继承归零）会把 preset 自己的工具一起挡掉——**这也是本插件存在的第一原因**：

`restrict` 只过滤「继承来的」工具，而 preset 的插件行挂在 agent 的一个独立 standing scope 上，从 agent 的视角看它们同样是"继承来的"。所以 `allow: []` 会把 preset 自己声明的工具一并移除，子代理会变成能说话、没有手的哑巴。

本插件的做法是显式算差集：

```
allow = names(preset 视角可见的工具) - names(全局层可见的工具)
```

- `tools.definitions()` 是 DSH 的 public API：不传 scope 是全局层视角，传 preset 的 scope key 是「全局 + 该 preset」视角
- preset 的 scope key 通过 `agentPresets.acquireScope(presetId)` 借出，用完立即归还
- 差集天然免疫"将来全局层又装了新工具"——新工具不在 allow 里，就进不来

逐行源码依据（含文件与行号）在 [`docs/01-源码核实报告.md`](docs/01-源码核实报告.md)。

## 自检：派活之前先问一句

装好之后会多一个只读工具 `subagent_tool_report`：

```
子代理工具白名单：当前生效 2 个子代理。

· preset example-reader（1 个 agent）：保留 15 个工具
  search_topic, search_queries, read_transcript, …, web_search, web_fetch
· preset empty-preset（1 个 agent）：保留 0 个工具 —— ⚠️ 一个都没有！
```

**某个 preset 的 `allowCount` 是 0，就别用它派活**：那个子代理什么工具都没有，只会回你"我做不到"。要么给那个 preset 挂上需要的工具插件，要么把它写进 `skipPresets`。

## 配置

在插件详情页改，或写进 profile 的 `cordis.patch.yml`：

```yaml
- id: subagent-tool-guard
  name: dsh-subagent-tool-guard
  config:
    enabled: true
    skipPresets: []          # 这些 preset 的子代理不限制
    restrictTeamMembers: true # Team 队友是否一起限制
    registerReportTool: true  # 提供 subagent_tool_report
    warnOnEmptyPreset: true   # preset 零工具时告警
    verbose: false
```

## 限制与边界

- **挡的是"工具"，不是"能力"。** 子代理如果仍保有 `web_fetch`，照样能抓网页；保有 `pwsh` 等于完全没限制。严格程度取决于那个 preset 装了什么。
- **不动主代理。** 主代理的工具表一行都没变。
- **子代理自己 scope 上注册的工具永远豁免**（DSH 机制，插件改不了）。
- 若某个 preset 注册了与全局同名的工具（shadow），差集会把它吞掉——安全优先。
- preset 一个工具都没声明时，插件会告警，但仍会限制（这就是严格白名单的语义）。
- 卸载即撤销；急救开关 `DSH_SUBAGENT_TOOL_GUARD_OFF=1`。

## 仓库结构

```
dsh-subagent-tool-guard/
├── package.json  cordis.patch.yml  index.js  icon.svg
├── locale/{en,zh}.json
├── docs/
│   ├── DETAIL.md                    插件详情页正文
│   ├── 01-源码核实报告.md
│   ├── 02-设计与算法.md
│   ├── 03-风险与边界.md
│   ├── 04-审查清单.md
│   ├── 05-安装与验证.md
│   └── 06-回滚与急救.md
└── tools/
    ├── selftest.mjs                 mock 自测（10 个场景）
    ├── identity-probe/              只读探针：验证"怎么认出子代理"
    └── {ls,slice,search,walksearch}.js   asar 只读探查脚本
```

## 开发

自测是纯 mock 的，不需要装进 DSH：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& $env:DSH_NODE_EXECUTABLE tools\selftest.mjs
```

期望最后一行是 `✅ 全部通过`。

文档里的占位符指你自己机器上的 DSH 安装位置：

| 占位符 | 是什么 | 怎么求 |
|---|---|---|
| `<DSH_HOME>` | DSH 家目录 | 环境变量 `$env:DSH_HOME`，默认 `~/.dsh` |
| `<DSH_INSTALL_DIR>` | 当前运行的 DSH CLI 包目录 | 环境变量 `$env:DSH_INSTALL_DIR` |
| `<DSH_APP_ASAR>` | Desktop 版 `app.asar` | 在 `<DSH_INSTALL_DIR>` 往上找 `resources/app.asar` |
| `<profile>` | 你的 profile 名 | 环境变量 `$env:DSH_PROFILE` |

所有源码引用按 DSH **0.2.2-rc.3** 的随包源码核对过行号；换版本后行号可能漂移。

## 相关插件

- **[dsh-context-slimmer](https://github.com/z11y11w/dsh-context-slimmer)** —— 管**主代理**的工具分组：把不常用的工具按组收起来，模型需要时自己展开，省每轮的工具定义 token。两个插件各管一边（这个管子代理，那个管主代理），可以同时装。

## 许可

[MIT](LICENSE)
