# probe/ · 只读探针：先确认判据，再装正式插件

## 它是什么

一个**只观测、不限制**的 bundle。它不会改动任何 agent 的工具表。

它把观察写到两处：

- 日志：`[subagent-probe] {...}`（插件日志里能搜到）
- 文件：`<DSH_HOME>/subagent-probe.jsonl`（默认 `<DSH_HOME>/subagent-probe.jsonl`），一行一个 JSON

每个记录包含：

| 字段 | 含义 |
|---|---|
| `phase` | `existing` / `created` / `disposed` |
| `agentId` | 会话 id |
| `header.origin` | **判据字段**：`subagent` 就是子 agent |
| `header.delegationDepth` | 备用判据：主 agent 是 0 |
| `header.parentSession` / `isSeeded` | 血缘线索 |
| `header.agentPreset` / `presetId` | 它跑的 preset |
| `toolsOnAgentScope` / `toolsOnGlobal` / `toolsOnPresetScope` | 三个视角各有多少工具 |
| `presetScopeError` | `acquireScope` 失败时的错误 |
| `wouldAllow` | **正式插件会保留的工具名清单**（差集算法的预演） |
| `judgedAsSubagent` | 按 `origin` 判据算出来的结论 |

## 为什么还需要它

`docs/01` 已经把判据从源码里挖出来了。探针的价值变成两件事：

1. **确认判据在这台机器上、在四个真实样本上表现一致**（源码对 ≠ 运行时一定对）
2. **提前看到 `wouldAllow`** —— 在真正施加限制之前，就知道某个 preset 会被保留几个工具。如果 `wouldAllow` 是空的，正式插件一装上去那个子 agent 就哑了

## 怎么用

1. 安装探针（插件页面 → 添加插件 → 选 `probe/` 目录），重启 DSH。
2. 依次造四个样本：

| 样本 | 怎么造 | 期望 |
|---|---|---|
| 1 主 agent | 在当前会话说一句话 | `header.origin` 为空，`judgedAsSubagent: false` |
| 2 普通子代理 | 调一次 `search_topic`（会派 `example-reader` 子代理） | `origin: "subagent"`，`presetId: "example-reader"` |
| 3 Team 队友 | 会话菜单里开 `Select Agent Teams per Session`，派一个队友 | 若也是 `origin: "subagent"` ⇒ R1 确认成立 |
| 4 fork | 用 `subagent_fork` 派一个 | `origin: "subagent"` |

3. 读结果：

```powershell
Get-Content '<DSH_HOME>\subagent-probe.jsonl' -Encoding utf8 | ForEach-Object { $_ } | Select-Object -Last 20
```

或者只看关键字段：

```powershell
Get-Content '<DSH_HOME>\subagent-probe.jsonl' -Encoding utf8 |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Select-Object phase, agentId, @{n='origin';e={$_.header.origin}}, @{n='depth';e={$_.header.delegationDepth}}, presetId, toolsOnGlobal, toolsOnPresetScope, judgedAsSubagent |
  Format-Table -AutoSize
```

## 判据成立的条件

样本 1 与样本 2、4 之间有稳定且可程序化的差异（`origin` 有/无），且样本 3 落在你明确接受的那一边。

如果样本 3 也是 `subagent`，而你不希望队友被限制 → 正式插件里配 `restrictTeamMembers: false`。

## 收尾

看完就把探针**卸载**（它会持续往 jsonl 里追加记录）。它不改变任何行为，留着也无害，但没有必要。
