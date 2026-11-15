# 子代理工具白名单（dsh-subagent-tool-guard）

## 它做什么

DSH 里，一个 agent 能看到的工具 = **全局层 + 祖先层 + 自己这层**。而 agent preset 里的插件行是挂在一个独立的 *standing scope* 上的，对 agent 而言属于「继承来的」。结果是：**一个只装了 B 站工具的 preset，照样能看见浏览器、任务看板、文件系统……全套全局工具。**

本插件只对**子代理**动手：把从全局层 / 祖先层继承来的工具全部移除，只保留**该子代理自己 preset 声明的那几个**。

- 主代理（你和你的主会话）：**完全不动**。
- 子代理（`subagent` / `subagent_fork` / `search_topic` 之类的后台代理）：严格白名单。
- Team 队友：在 DSH 内部同样是 subagent，默认一起限制（可关）。

## 为什么不是一句 `restrict({ allow: [] })`

那句是"全部继承归零"的写法，但它会把**preset 自己声明的工具也一起归零** —— 子代理会变成一个能说话、没手的哑巴。

原因是源码事实：`ToolsService.restrict()` 只作用于「继承来的」工具，而 preset 的行注册在 agent 的**祖先 scope** 上，所以它们也属于"继承来的"。

本插件因此显式计算差集：

```
allow = 该 preset 视角下可见的工具名 - 全局层可见的工具名
```

这个差集天然免疫"将来全局层又装了新工具"——新工具不在 allow 里，就进不来，符合白名单语义。

## 用法

1. 在「插件」页面安装本目录里的 `package/`（本地目录安装）。
2. 改配置（插件详情页，或 profile 的 `cordis.patch.yml` 对应行）：
   - `skipPresets`：哪些 preset 的子代理不限制（默认空 = 全都限制）。
   - `restrictTeamMembers`：Team 队友是否一起限制（默认 `true`）。
   - `registerReportTool`：是否提供只读工具 `subagent_tool_report`。
3. 重启 DSH 后生效。

## 自检：派活之前先问一句

主代理可以直接调只读工具 `subagent_tool_report`：

```
子 agent 工具白名单：当前生效 2 个子 agent。

· preset example-reader（1 个 agent）：保留 15 个工具
  search_topic, search_queries, read_transcript, …, web_search, web_fetch
· preset empty-preset（1 个 agent）：保留 0 个工具 —— ⚠️ 一个都没有！
```

**某个 preset 的 `allowCount` 是 0，就别用它派活**：那个子代理什么工具都没有，只会回你"我做不到"。要么给那个 preset 挂上它需要的工具插件，要么把它写进 `skipPresets`。

## 限制与边界（先说清楚，别误解）

- **挡的是"工具"，不是"能力"。** 子代理如果仍然保留了 `web_fetch`，它照样能抓网页；保留了 `pwsh`，等于完全没限制。白名单的严格程度取决于那个 preset 装了什么。
- **不动主代理。** 主代理的工具表一行都没变。
- **卸载即撤销。** 插件卸载或 `enabled: false` 后，新会话恢复完整工具表；已存在的子代理在它们被销毁时也会解除。
- **急救**：设环境变量 `DSH_SUBAGENT_TOOL_GUARD_OFF=1` 后重启，本插件完全不生效。

## 已知边界

- 子代理**自己 scope 上注册的**工具永远豁免（DSH 机制，插件改不了）。
- 若某个 preset 一层注册了与全局同名的工具（shadow），那个名字会被一并移除——安全优先。
- 子代理的 preset 一个工具都没声明时，插件会告警，但**仍然限制**（这就是严格白名单的语义）。

更细的源码依据、风险清单和验证步骤见仓库根目录的 `docs/`。
