# tools/ · asar 只读探查脚本 + 自测

这一目录有两类东西：

1. **`selftest.mjs`** —— 用假 `ctx` 跑一遍 `package/index.js` 的关键路径（差集算法、主 agent 不误伤、零工具告警、skipPresets、disposed 回收、acquireScope 失败降级、环境变量开关、报告工具、补扫）。**不接触真实 DSH**。
2. **四个 asar 探查脚本** —— 本报告所有源码引用的取证工具，**只读**。

## 先跑自测

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& $env:DSH_NODE_EXECUTABLE .\selftest.mjs
```

期望最后一行是 `✅ 全部通过`。任何一个 ❌ 都说明实现和文档描述不一致，先别安装。

## asar 探查脚本

DSH Desktop 把代码装在 `app.asar` 里。**普通的 `grep` / `ls` / `cat` / PATH 里的 node 都读不了 asar**，必须用宿主自己那个 Electron 可执行文件（它带 asar 支持），并设 `ELECTRON_RUN_AS_NODE=1`。

## 准备

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$asar = '<DSH_APP_ASAR>'
$pkg  = "$asar\dsh\node_modules\@deepseek-ai"
```

## 列目录

```powershell
& $env:DSH_NODE_EXECUTABLE .\ls.js "$pkg\dsh-tools" 2
```

第三个参数是递归深度（默认 2）。

## 看某几行

```powershell
$env:TARGET = "$pkg\dsh-tools\src\index.ts"
& $env:DSH_NODE_EXECUTABLE .\slice.js 199 227
# → 打印 199–227 行，正好是 ToolsService.view() 的实现
```

## 在某个包内搜字面量

```powershell
& $env:DSH_NODE_EXECUTABLE .\search.js "$pkg\dsh-subagent\src" "toolFilter" 8
```

## 跨所有 `dsh-*` 包搜源码

```powershell
& $env:DSH_NODE_EXECUTABLE .\walksearch.js $pkg
```

（`walksearch.js` 里的搜索词写死在文件里，要改就自己编辑那行 `const term = 'createScope'`。）

## 本报告用它们取证到的关键位置

| 结论 | 命令 |
|---|---|
| `restrict()` 必须在 scoped ctx 上 | `slice.js` on `dsh-tools/src/index.ts` **162 189** |
| `view()` 里 own 无条件可见 | `slice.js` on `dsh-tools/src/index.ts` **199 227** |
| preset 有自己的 standing scope | `slice.js` on `dsh-agent-preset-registry/src/index.ts` **119 138** |
| agent 挂到 preset scope 下面 | `slice.js` on `dsh-agent-preset-registry/src/index.ts` **281 290** |
| `origin: 'subagent'` 的写入点 | `slice.js` on `dsh-subagent/src/child-agent.ts` **135 153** |
| agent 对象本身就是 scope key | `search.js` on `dsh-agent-loop/src` "createScope" |
| `acquireScope` 的租约语义 | `slice.js` on `dsh-agent-preset-registry/src/index.ts` **385 398** |
| rc.3 只有 `startActivation` | `slice.js` on `dsh-subagent/src/index.ts` **252 292** |
