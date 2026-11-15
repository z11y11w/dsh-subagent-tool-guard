/**
 * tools/selftest.mjs —— 用假 ctx 跑一遍 package/index.js 的关键路径
 * ============================================================================
 * 目的：在**不安装、不接触真实 DSH** 的前提下，验证
 *   · 差集算法算出来的 allow 是不是预期的那几个名字
 *   · 主 agent 不被误伤
 *   · 零工具 preset 会告警且 allow 为空
 *   · skipPresets / 环境变量开关 / disposed 回收 / 报告工具 都按设计工作
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & $env:DSH_NODE_EXECUTABLE tools\selftest.mjs
 * ============================================================================
 */
import { apply } from '../index.js'

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ✅ ${label}`)
  } else {
    failures += 1
    console.log(`  ❌ ${label}${detail === undefined ? '' : ` → ${detail}`}`)
  }
}

/** 造一个假 ctx / 假 tools 服务。 */
function makeWorld(options = {}) {
  const logs = []
  const registeredTools = []
  const restrictions = []
  const listeners = new Map()

  const GLOBAL_TOOLS = options.globalTools ?? [
    'dsh_browser_open', 'dsh_browser_snapshot', 'read', 'write', 'pwsh', 'web_fetch',
  ]
  // preset 视角 = 全局 + preset 自己那几个（模拟 example-reader 挂了 example-tools + tool-web）
  const PRESET_TOOLS = {
    'example-reader': [...GLOBAL_TOOLS, 'search_topic', 'search_queries', 'read_transcript', 'read_comments', 'web_search'],
    'empty-preset': [...GLOBAL_TOOLS],
  }

  const toolDef = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })

  const tools = {
    definitions(scope) {
      if (scope === undefined) return GLOBAL_TOOLS.map(toolDef)
      if (scope === 'PRESET_KEY') return PRESET_TOOLS[world.currentPreset]?.map(toolDef) ?? []
      if (scope === 'AGENT_KEY' || typeof scope === 'object') return PRESET_TOOLS[world.currentPreset]?.map(toolDef) ?? []
      return []
    },
    restrict(filter) {
      const record = { filter, disposed: false }
      restrictions.push(record)
      return () => { record.disposed = true }
    },
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
  }

  const agents = {
    existing: [],
    list() { return this.existing },
  }

  const agentPresets = {
    composedPreset() { return options.presetId ?? 'example-reader' },
    async acquireScope(id) {
      if (options.acquireScopeFails === true) throw new Error('preset gone')
      return {
        key: 'PRESET_KEY',
        async [Symbol.asyncDispose]() { agentPresets.disposedLeases = (agentPresets.disposedLeases ?? 0) + 1 },
      }
    },
    disposedLeases: 0,
  }

  const services = {
    tools,
    agents,
    agentPresets,
    ...(options.withTeams === true ? { agentTeams: { isEnabled: () => options.teamEnabled === true } } : {}),
  }

  const ctx = {
    logger: {
      info: (message) => logs.push(String(message)),
      warn: (message) => logs.push(`WARN ${String(message)}`),
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      ctx.__cleanups.push(disposer)
      return disposer
    },
    get(name) { return services[name] },
    inject(_deps, callback) { callback(ctx); return () => {} },
    tools,
    __cleanups: [],
    __emit(event, payload) {
      const handlers = listeners.get(event) ?? []
      return Promise.all(handlers.map(handler => handler(payload)))
    },
  }

  const world = {
    ctx, tools, agents, agentPresets, services,
    logs, registeredTools, restrictions, PRESET_TOOLS, GLOBAL_TOOLS,
    currentPreset: options.presetId ?? 'example-reader',
  }
  world.currentPreset = options.presetId ?? 'example-reader'
  return world
}

/** 造一个假 agent。 */
function makeAgent(id, options = {}) {
  const header = {
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
    ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
  }
  const agent = {
    id,
    session: { header },
    ctx: { get: (name) => agent.__services[name] },
    __services: {},
  }
  return agent
}

/** 统一跑一个场景。 */
async function scenario(name, options, body) {
  console.log(`\n▶ ${name}`)
  const world = makeWorld(options)
  const original = { ...process.env }
  if (options.envOff === true) process.env.DSH_SUBAGENT_TOOL_GUARD_OFF = '1'
  else delete process.env.DSH_SUBAGENT_TOOL_GUARD_OFF
  try {
    apply(world.ctx, options.config ?? undefined)
    await body(world)
  } finally {
    process.env = { ...original }
  }
}

// ── 场景 1：主 agent 不该被限制 ─────────────────────────────────────────────
await scenario('主 agent（origin 为空）不被限制', {}, async (world) => {
  const agent = makeAgent('main-1')
  agent.__services = world.services
  await world.ctx.__emit('agent/created', { agent })
  check('没有产生 restriction', world.restrictions.length === 0, `实际 ${world.restrictions.length}`)
})

// ── 场景 2：普通会话 fork（无 origin）不该被限制 ────────────────────────────
await scenario('普通 fork（有 parentSession 但无 origin）不被限制', {}, async (world) => {
  const agent = makeAgent('fork-1')
  agent.session.header.parentSession = 'main-1'
  agent.__services = world.services
  await world.ctx.__emit('agent/created', { agent })
  check('没有产生 restriction', world.restrictions.length === 0)
})

// ── 场景 3：子 agent 的 allow 必须等于「preset − global」 ────────────────────
await scenario('子 agent 走差集算法', { presetId: 'example-reader' }, async (world) => {
  const agent = makeAgent('sub-1', { origin: 'subagent', delegationDepth: 1, agentPreset: 'example-reader' })
  agent.__services = world.services
  await world.ctx.__emit('agent/created', { agent })

  check('产生了一条 restriction', world.restrictions.length === 1)
  const allow = world.restrictions[0]?.filter?.allow ?? []
  const expected = ['search_topic', 'search_queries', 'read_transcript', 'read_comments', 'web_search']
  check('allow 恰好是 preset 自己那几个', JSON.stringify(allow) === JSON.stringify(expected), `实际 ${JSON.stringify(allow)}`)
  check('浏览器工具被排除', !allow.some(n => n.startsWith('dsh_browser_')), JSON.stringify(allow))
  check('全局 read/write/pwsh 被排除', !allow.some(n => ['read', 'write', 'pwsh'].includes(n)))
  check('preset 自带的 web_search 被保留', allow.includes('web_search'))
  check('acquireScope 的租约被归还', world.agentPresets.disposedLeases === 1, `实际 ${world.agentPresets.disposedLeases}`)
})

// ── 场景 4：零工具 preset → allow 为空 + 告警 ──────────────────────────────
await scenario('零工具 preset 会告警', { presetId: 'empty-preset' }, async (world) => {
  const agent = makeAgent('sub-2', { origin: 'subagent', agentPreset: 'empty-preset' })
  agent.__services = world.services
  await world.ctx.__emit('agent/created', { agent })
  const allow = world.restrictions[0]?.filter?.allow ?? null
  check('restriction 的 allow 是空数组', Array.isArray(allow) && allow.length === 0, JSON.stringify(allow))
  check('日志里有零工具告警', world.logs.some(line => line.includes('自己没有声明任何工具')))
})

// ── 场景 5：skipPresets 不施加限制 ─────────────────────────────────────────
await scenario('skipPresets 生效', { presetId: 'example-reader', config: { skipPresets: ['example-reader'] } }, async (world) => {
  const agent = makeAgent('sub-3', { origin: 'subagent', agentPreset: 'example-reader' })
  agent.__services = world.services
  await world.ctx.__emit('agent/created', { agent })
  check('没有产生 restriction', world.restrictions.length === 0)
})

// ── 场景 6：agent/disposed 撤掉限制 ────────────────────────────────────────
await scenario('disposed 时撤销限制', { presetId: 'example-reader' }, async (world) => {
  const agent = makeAgent('sub-4', { origin: 'subagent', agentPreset: 'example-reader' })
  agent.__services = world.services
  await world.ctx.__emit('agent/created', { agent })
  check('先产生了一条 restriction', world.restrictions.length === 1)
  await world.ctx.__emit('agent/disposed', { agent })
  check('disposed 后被撤销', world.restrictions[0]?.disposed === true)
})

// ── 场景 7：acquireScope 失败 → 降级不崩 ───────────────────────────────────
await scenario('acquireScope 失败时降级放行', { presetId: 'example-reader', acquireScopeFails: true }, async (world) => {
  const agent = makeAgent('sub-5', { origin: 'subagent', agentPreset: 'example-reader' })
  agent.__services = world.services
  await world.ctx.__emit('agent/created', { agent })
  check('没有抛错、创建流程正常结束', true)
  check('日志记录了降级', world.logs.some(line => line.includes('降级用 agent 视角')))
})

// ── 场景 8：环境变量开关 ───────────────────────────────────────────────────
await scenario('急救开关 DSH_SUBAGENT_TOOL_GUARD_OFF=1', { envOff: true }, async (world) => {
  const agent = makeAgent('sub-6', { origin: 'subagent', agentPreset: 'example-reader' })
  agent.__services = world.services
  await world.ctx.__emit('agent/created', { agent })
  check('没有施加任何限制', world.restrictions.length === 0)
  check('没有注册报告工具', world.registeredTools.length === 0)
  check('日志说明已关闭', world.logs.some(line => line.includes('DSH_SUBAGENT_TOOL_GUARD_OFF')))
})

// ── 场景 9：报告工具 ───────────────────────────────────────────────────────
await scenario('报告工具输出', { presetId: 'example-reader' }, async (world) => {
  const agent = makeAgent('sub-7', { origin: 'subagent', agentPreset: 'example-reader' })
  agent.__services = world.services
  await world.ctx.__emit('agent/created', { agent })

  const report = world.registeredTools.find(tool => tool.name === 'subagent_tool_report')
  check('报告工具已注册', report !== undefined)
  if (report !== undefined) {
    check('output.schema 是 object 且带 additionalProperties', report.output?.schema?.type === 'object'
      && report.output?.schema?.additionalProperties === false)
    const value = await report.execute({}, {})
    check('restrictedAgents 计数正确', value.restrictedAgents === 1, JSON.stringify(value))
    const row = value.presets?.[0]
    check('报告里 preset 是 example-reader', row?.preset === 'example-reader')
    check('报告里 allowCount 是 5', row?.allowCount === 5, JSON.stringify(row))
    const text = report.output.render({}, value)
    check('render 产出了文字块', Array.isArray(text) && text[0]?.type === 'text' && text[0].text.includes('example-reader'))
  }
})

// ── 场景 10：已存在 agent 的补扫 ───────────────────────────────────────────
console.log('\n▶ 补扫已存在的子 agent（插件晚于 agent 加载）')
{
  const world = makeWorld({ presetId: 'example-reader' })
  const agent = makeAgent('sub-old', { origin: 'subagent', agentPreset: 'example-reader' })
  agent.__services = world.services
  // ★ 先让 agent 存在，再 apply —— 模拟「插件加载时 agent 已经在跑」
  world.agents.existing.push(agent)
  apply(world.ctx, undefined)
  await new Promise(resolve => setTimeout(resolve, 10))
  check('补扫给已存在的子 agent 加了限制', world.restrictions.length === 1, `实际 ${world.restrictions.length}`)
  check('补扫算出来的 allow 同样正确', (world.restrictions[0]?.filter?.allow ?? []).includes('search_queries'))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
