/**
 * dsh-subagent-tool-guard —— 子 agent 工具白名单（主机半端）
 * ============================================================================
 * 一句话：**子 agent 只能看见它自己 preset 声明的工具；从全局层和祖先层继承来的
 * 一律挡掉。**主 agent 不动。
 *
 * ── 为什么必须"算出名字"而不是 `restrict({ allow: [] })` ─────────────────────
 * 2026-11-15 对 DSH 0.2.2-rc.3 源码逐行核实（见 docs/01-源码核实报告.md）：
 *
 *   1. `ToolsService.view(scope)`（dsh-tools/src/index.ts:199-227）把工具分成两堆：
 *        · `inherited` = global 层 + 从 scope 链上除"自己这层"以外的所有祖先层
 *        · `own`       = 该 scope 自己注册的
 *      `restrict` 的 restriction 只参与 `inherited` 的 `admits()` 判定；
 *      `own` 那堆**永远可见**，完全不受限。
 *
 *   2. preset 里的行**不挂载在 agent 的 scope 上**。`dsh-agent-preset-registry`
 *      给每个 preset 单独 `createScope(owner, key)`（src/index.ts:121），
 *      preset 的行注册在那个 **standing scope**；agent 创建时只是
 *      `bindScopeParent(agentKey, presetKey)` 把自己挂到它下面（src/index.ts:282）。
 *      ⇒ **preset 注册的工具，从 agent 的视角看属于 `inherited`。**
 *
 *   结合 1+2：`restrict({ allow: [] })` 会把 preset 自己的工具**一起挡掉**，
 *   造出一个"能说话、没手"的子 agent。设计初稿 §3.8 担心的正是这件事，**它成立**。
 *
 *   所以本插件显式算出「preset 自己贡献的工具名」，用 `allow: <那些名字>` 施加限制：
 *        allow = names(preset 视角) - names(全局视角)
 *   这个差集天然免疫"将来全局层新增工具"，符合"没登记的一概不给"的白名单语义。
 *
 * ── 怎么识别子 agent ────────────────────────────────────────────────────────
 * `agent.session.header.origin === 'subagent'`（dsh-session/src/types.ts:122）。
 * dsh-subagent 的 `childSessionMeta()` 在创建子会话时写死这个字段
 * （dsh-subagent/src/child-agent.ts:150）。Team 队友同样是 subagent
 * （dsh-agent-team/src/index.ts:65 明说 "teammates are subagents"），也会被命中。
 * 普通会话 fork **不带** origin（types.ts:108-112 注释），所以不会被误伤。
 *
 * ── 已知边界（都是刻意的，见 docs/03-风险与边界.md）────────────────────────────
 *   · 只挡"工具"，不挡能力：子 agent 若仍保有 web_fetch / pwsh，它照样能联网 / 跑命令。
 *   · 若 preset 一层注册了与全局同名的工具（shadow），差集会把它吞掉，那个工具会
 *     整个消失。安全优先，符合"继承来的一个不留"。
 *   · agent 自己 scope 注册的工具永远豁免（DSH 机制如此，我们改不了）。
 *   · 插件晚于 agent 加载时（HMR / 重启），会补扫一遍已存在的 agent（见 installExisting）。
 * ============================================================================
 */

export const name = 'subagent-tool-guard'

/** `tools` 是硬依赖：没有工具注册表就无从限制。agentPresets / agents 走 ctx.get 软取。 */
export const inject = ['tools']

/** 一键关掉本插件（急救通道）。设成 '1' 即完全不生效。 */
const OFF_ENV = 'DSH_SUBAGENT_TOOL_GUARD_OFF'

/** 报告工具名。注册在插件自己的 ctx = 全局层，所以主 agent 有、子 agent 被挡。 */
const REPORT_TOOL = 'subagent_tool_report'

const TAG = '[subagent-tool-guard]'

/**
 * 默认配置。逐字段按类型挑一遍 —— DSH 传进来的 config 值**不保证是标量**
 * （真实事故：一个第三方插件就因为 config 字段不是标量，在定时器回调里抛错，把整个宿主进程带走了）。
 */
const DEFAULTS = {
  /** 总开关。false = 完全不施加任何限制，也不注册报告工具。 */
  enabled: true,
  /** 这些 preset 的子 agent 不施加限制（例如某个确实需要全局工具的专用 preset）。 */
  skipPresets: [],
  /** 是否连 Team 队友（同样是 subagent）一起限制。默认 true。 */
  restrictTeamMembers: true,
  /** 是否注册只读工具 subagent_tool_report（给主 agent 派活前自检）。 */
  registerReportTool: true,
  /** preset 一个工具都没声明时是否告警（防呆：那样子 agent 会被归零）。 */
  warnOnEmptyPreset: true,
  /** 每个 agent 都打一行日志。排查时开，平时关。 */
  verbose: false,
}

/** 只接受布尔，其余一律回落到默认值。 */
function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 只接受字符串数组，其余一律回落到默认值。 */
function pickStringArray(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const out = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.push(item)
  }
  return out
}

/** 把不可信的 config 压成确定的形状。 */
function readConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS }
  return {
    enabled: pickBool(raw.enabled, DEFAULTS.enabled),
    skipPresets: pickStringArray(raw.skipPresets, DEFAULTS.skipPresets),
    restrictTeamMembers: pickBool(raw.restrictTeamMembers, DEFAULTS.restrictTeamMembers),
    registerReportTool: pickBool(raw.registerReportTool, DEFAULTS.registerReportTool),
    warnOnEmptyPreset: pickBool(raw.warnOnEmptyPreset, DEFAULTS.warnOnEmptyPreset),
    verbose: pickBool(raw.verbose, DEFAULTS.verbose),
  }
}

/** 从一份工具定义列表里取名字集合（调用方保证传数组）。 */
function namesOf(definitions) {
  const out = new Set()
  if (!Array.isArray(definitions)) return out
  for (const definition of definitions) {
    const toolName = definition?.name
    if (typeof toolName === 'string' && toolName.length > 0) out.add(toolName)
  }
  return out
}

/** 报告工具的输出 schema：object 必须带 additionalProperties，否则注册期会被拒。 */
const REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    restrictedAgents: { type: 'integer' },
    presets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preset: { type: 'string' },
          agents: { type: 'integer' },
          allowCount: { type: 'integer' },
          allow: { type: 'array', items: { type: 'string' } },
          empty: { type: 'boolean' },
        },
        required: ['preset', 'agents', 'allowCount', 'allow', 'empty'],
      },
    },
  },
  required: ['enabled', 'restrictedAgents', 'presets'],
}

export function apply(ctx, config) {
  /** 日志一律吞异常：日志不该成为插件挂掉的理由。 */
  const log = (message) => {
    try { ctx.logger?.info?.(`${TAG} ${message}`) } catch { /* 没有 logger 就算了 */ }
  }
  const warn = (message) => {
    try { ctx.logger?.warn?.(`${TAG} ${message}`) } catch { /* 同上 */ }
  }

  // ── 急救开关：环境变量优先于一切 ──────────────────────────────────────────
  let offByEnv = false
  try { offByEnv = process.env[OFF_ENV] === '1' } catch { /* 没有 process 环境也就算了 */ }
  if (offByEnv) {
    warn(`已通过环境变量 ${OFF_ENV}=1 关闭，本次不施加任何限制`)
    return
  }

  const cfg = readConfig(config)
  if (!cfg.enabled) {
    log('配置 enabled=false，不施加任何限制')
    return
  }

  /**
   * 已被我们处理过的 agent → 记录。
   * 用 Map 而不是 WeakMap：卸载插件时必须能逐个 dispose 掉限制
   * （practices: 卸载插件不会自动清掉 agent.ctx 上的注册）。
   */
  const guarded = new Map()

  /** preset → { allow, agents }，给报告工具读。没有 agent 引用，不会拖住 GC。 */
  const presetIndex = new Map()

  /** 判断是不是子 agent。读 header 允许失败（防御性）。 */
  const isSubagent = (agent) => {
    try { return agent?.session?.header?.origin === 'subagent' } catch { return false }
  }

  /**
   * 判断这个子 agent 是不是「Team 树里的成员」。
   *
   * DSH 没有 `isTeamMember(agent)` 这种 API（核实过 dsh-subagent 的公开方法：
   * startActivation / rootOf / namesOf / resolveName / waitForTreeWork / sendMessage /
   * interrupt / drainDescendants / listDescendants / prompt / registerProvider …）。
   * 能用的最接近的东西是 `agentTeams.isEnabled(agent)`
   * （dsh-agent-team/src/index.ts:94-97，内部走 `subagents.rootOf(caller)`）。
   *
   * ⇒ 这是一个**近似**：Team 模式开着时，那棵树里的所有 subagent 都被当成 Team 成员。
   *   它只会让限制**更松**（`restrictTeamMembers: false` 时多放行一批），
   *   不会把普通子代理误当成"该放行"的 —— 因为 Team 默认是关的。
   */
  const isTeamMemberSafe = (agent) => {
    try {
      const teams = ctx.get('agentTeams')
      if (typeof teams?.isEnabled !== 'function') return false
      return teams.isEnabled(agent) === true
    } catch { return false }
  }

  /**
   * 算出「这个 agent 应该保留哪些工具名」。
   *
   * `tools.definitions(scope)` 是 public API（dsh-tools/src/index.ts:305）：
   *   · 不传 scope → 全局层视角
   *   · 传 preset 的 scope key → 全局层 + preset 层
   * 两者相减就是 preset 自己贡献的名字。
   *
   * preset 的 scope key 通过 `agentPresets.acquireScope(presetId)` 借出
   * （dsh-agent-preset-registry/src/index.ts:389，dsh-tool-manager 也这么用），
   * 用完必须还 lease，否则会把这个 preset revision 一直 retain 住。
   *
   * @returns {{ allow: string[], source: string }}
   */
  async function resolveAllowedNames(agent, tools, presetId) {
    const globalNames = namesOf(tools.definitions())

    let presetNames = null
    let source = 'preset-scope'
    const presets = ctx.get('agentPresets')

    if (typeof presets?.acquireScope === 'function') {
      let lease
      try {
        lease = await presets.acquireScope(presetId)
        presetNames = namesOf(tools.definitions(lease.key))
      } catch (error) {
        // preset 已不在注册表里（部署换过预设）、或 acquireScope 内部失败。
        warn(`读取 preset "${presetId}" 的工具表失败，降级用 agent 视角：${safeMessage(error)}`)
        presetNames = null
      } finally {
        if (lease !== undefined) {
          try { await lease[Symbol.asyncDispose]?.() } catch { /* 还不上也不影响本次限制 */ }
        }
      }
    }

    if (presetNames === null) {
      // 降级：agent 视角 = 全局 + preset + agent 自己这层。自家这层的名字
      // 塞进 allow 会让 restrict 抛 unknown，所以调用方要能容忍失败（见 guardAgent）。
      source = 'agent-scope-fallback'
      presetNames = namesOf(tools.definitions(agent))
    }

    const allow = []
    for (const toolName of presetNames) {
      if (!globalNames.has(toolName)) allow.push(toolName)
    }
    return { allow, source }
  }

  /**
   * 给一个 agent 施加限制。返回 promise 时 `agent/created` 会等它，
   * 这样子 agent 的第一个 turn 就已经看到正确的工具表。
   */
  async function guardAgent(agent) {
    if (!agent || guarded.has(agent)) return
    if (!isSubagent(agent)) return

    if (!cfg.restrictTeamMembers && isTeamMemberSafe(agent)) {
      log(`${agent.id} 是 Team 成员，且 restrictTeamMembers=false，跳过`)
      return
    }

    // 先占位，挡住并发重入（agent/created 与补扫可能撞上同一个 agent）。
    guarded.set(agent, { pending: true, preset: undefined, allow: [], dispose: undefined })

    try {
      const tools = agent.ctx?.get?.('tools')
      if (!tools || typeof tools.restrict !== 'function' || typeof tools.definitions !== 'function') {
        warn(`${agent.id}: agent.ctx.tools 不可用，跳过`)
        guarded.delete(agent)
        return
      }

      const presetId = readPresetId(agent)
      if (presetId === undefined) {
        warn(`${agent.id}: 拿不到 preset id，跳过`)
        guarded.delete(agent)
        return
      }
      if (cfg.skipPresets.includes(presetId)) {
        log(`${agent.id}: preset "${presetId}" 在 skipPresets 里，跳过`)
        guarded.delete(agent)
        return
      }

      const { allow, source } = await resolveAllowedNames(agent, tools, presetId)

      if (allow.length === 0 && cfg.warnOnEmptyPreset) {
        warn(
          `⚠️ preset "${presetId}" 自己没有声明任何工具：子 agent ${agent.id} 将被归零`
          + '（能推理、能说话，但没有任何工具）。'
          + '给这个 preset 至少挂一个工具插件，或把 preset 加进 skipPresets。',
        )
      }

      const dispose = tools.restrict({ allow })

      // 复查：上面有 await，期间这个 agent 可能已经被 dispose 掉了
      // （releaseAgent 会把占位记录删掉）。那种情况下立即撤销，别留孤儿 restriction。
      if (!guarded.has(agent)) {
        try { dispose() } catch { /* 已经失效就算了 */ }
        return
      }

      guarded.set(agent, { pending: false, preset: presetId, allow, dispose, source })

      const slot = presetIndex.get(presetId) ?? { allow, agents: 0 }
      slot.allow = allow
      slot.agents += 1
      presetIndex.set(presetId, slot)

      if (cfg.verbose || allow.length === 0) {
        log(`限制子 agent ${agent.id}（preset=${presetId}, 来源=${source}）：`
          + `保留 ${allow.length} 个${allow.length > 0 ? ` → ${allow.join(', ')}` : ''}`)
      }
    } catch (error) {
      // 限制失败一律"放行"而不是"崩溃"：宁可子 agent 能力大一点，
      // 也不能因为一个插件把别人的子 agent 直接搞死。
      guarded.delete(agent)
      warn(`${agent.id}: 施加工具限制失败，已放行该子 agent：${safeMessage(error)}`)
    }
  }

  /** agent 走了：撤掉限制、清索引。 */
  function releaseAgent(agent) {
    const record = guarded.get(agent)
    if (record === undefined) return
    guarded.delete(agent)
    try { record.dispose?.() } catch { /* disposer 已失效也无所谓 */ }
    if (typeof record.preset === 'string') {
      const slot = presetIndex.get(record.preset)
      if (slot !== undefined) {
        slot.agents = Math.max(0, slot.agents - 1)
        if (slot.agents === 0) presetIndex.delete(record.preset)
      }
    }
  }

  /**
   * 补扫已存在的 agent。插件晚于 agent 创建才加载时（HMR / 重启恢复），
   * `agent/created` 对它们不会触发；不补扫就会出现「装完重启，老会话照样能用」
   * 的假阴性（设计初稿 R2）。
   */
  function installExisting() {
    let agents
    try { agents = ctx.get('agents') } catch { agents = undefined }
    if (typeof agents?.list !== 'function') {
      warn('agents 服务不可用，跳过对已存在 agent 的补扫')
      return
    }
    let existing
    try { existing = agents.list() } catch (error) {
      warn(`枚举已存在 agent 失败：${safeMessage(error)}`)
      return
    }
    if (!Array.isArray(existing) || existing.length === 0) return
    let count = 0
    for (const agent of existing) {
      if (!isSubagent(agent)) continue
      count += 1
      // 不 await：apply 不能被别人的创建流程拖住。
      void guardAgent(agent).catch(() => { /* guardAgent 内部已全兜底，这里只是保险 */ })
    }
    if (count > 0) log(`补扫：发现 ${count} 个已存在的子 agent，正在补加限制`)
  }

  // ── 监听 ────────────────────────────────────────────────────────────────
  // agent/created 的监听器如果返回 promise，DSH 会在 creation 结束前 await 它，
  // 所以这里直接返回 guardAgent 的 promise（dsh-agent/src/runtime-types.ts:279-291）。
  ctx.on('agent/created', ({ agent }) => guardAgent(agent))
  ctx.on('agent/disposed', ({ agent }) => releaseAgent(agent))

  // ── 报告工具（只读）─────────────────────────────────────────────────────
  if (cfg.registerReportTool) {
    try {
      ctx.tools.register({
        name: REPORT_TOOL,
        description:
          '只读：报告"子 agent 工具白名单"当前保留了哪些工具。'
          + '派子代理之前可以用它自检——某个 preset 的 allowCount 是 0，说明那个子 agent 什么工具都没有，'
          + '派出去只会得到"我做不到"。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
          schema: REPORT_OUTPUT_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: formatReport(value) }],
        },
        async execute() {
          const presets = []
          for (const [preset, slot] of presetIndex) {
            presets.push({
              preset,
              agents: slot.agents,
              allowCount: slot.allow.length,
              allow: [...slot.allow],
              empty: slot.allow.length === 0,
            })
          }
          presets.sort((left, right) => left.preset.localeCompare(right.preset))
          let restrictedAgents = 0
          for (const record of guarded.values()) {
            if (record?.pending !== true) restrictedAgents += 1
          }
          return { enabled: true, restrictedAgents, presets }
        },
      })
    } catch (error) {
      // 工具名撞了、schema 被拒 —— 都不值得让插件整体失败。
      warn(`注册 ${REPORT_TOOL} 失败（不影响限制功能）：${safeMessage(error)}`)
    }
  }

  // ── 卸载时统一收回 ──────────────────────────────────────────────────────
  ctx.effect(() => () => {
    for (const record of guarded.values()) {
      try { record?.dispose?.() } catch { /* 逐个吞 */ }
    }
    guarded.clear()
    presetIndex.clear()
  }, 'subagent-tool-guard.cleanup')

  // ── 启动自检 + 补扫 ─────────────────────────────────────────────────────
  installExisting()
  // agents 服务可能比本插件晚就绪：就绪后再补扫一次（已经处理过的会被 guarded 挡住）。
  try {
    ctx.inject(['agents'], () => { installExisting() })
  } catch { /* 老内核没有 ctx.inject 也无妨 */ }

  log(`已启动（skipPresets=${cfg.skipPresets.length > 0 ? cfg.skipPresets.join(', ') : '无'}，`
    + `Team=${cfg.restrictTeamMembers ? '限制' : '放行'}，急救开关 ${OFF_ENV}=1 可关闭）`)
}

/** 读 preset id：优先用 registry 的实时绑定，其次用会话 header 里的持久记录。 */
function readPresetId(agent) {
  try {
    const presets = agent?.ctx?.get?.('agentPresets')
    if (typeof presets?.composedPreset === 'function') {
      const live = presets.composedPreset(agent.ctx)
      if (typeof live === 'string' && live.length > 0) return live
    }
  } catch { /* 落到 header */ }
  try {
    const recorded = agent?.session?.header?.agentPreset
    if (typeof recorded === 'string' && recorded.length > 0) return recorded
  } catch { /* 拿不到就是拿不到 */ }
  return undefined
}

/** 把未知异常压成一行可读文本。 */
function safeMessage(error) {
  try {
    if (error === null || error === undefined) return String(error)
    if (typeof error === 'string') return error
    const message = error?.message
    return typeof message === 'string' ? message : String(error)
  } catch {
    return '(无法读取错误信息)'
  }
}

/** 把报告渲染成人读得懂的一段。 */
function formatReport(value) {
  const lines = []
  const presets = Array.isArray(value?.presets) ? value.presets : []
  lines.push(`子 agent 工具白名单：当前生效 ${value?.restrictedAgents ?? 0} 个子 agent。`)
  if (presets.length === 0) {
    lines.push('还没有任何子 agent 被处理过（本进程内）。')
    return lines.join('\n')
  }
  lines.push('')
  for (const row of presets) {
    const head = `· preset ${row.preset}（${row.agents} 个 agent）：保留 ${row.allowCount} 个工具`
    if (row.empty) {
      lines.push(`${head} —— ⚠️ 一个都没有！这个 preset 派出去的子 agent 什么都干不了。`)
      continue
    }
    lines.push(head)
    lines.push(`  ${row.allow.join(', ')}`)
  }
  return lines.join('\n')
}
