/**
 * subagent-identity-probe —— 只观测、不限制
 * ============================================================================
 * 用途：在**装正式插件之前**，先确认「怎么可靠地认出子 agent」这件事。
 * 设计初稿 §3.4 把这个列为本任务唯一的硬不确定点；判错会把主 agent 一起关进笼子。
 *
 * 本探针**不改任何工具表**。它在以下时机把结构化的观察写进
 *   `<DSH_HOME>/subagent-probe.jsonl`（一行一个 JSON）
 * 并同时打到日志里：
 *   · 启动时对已存在的 agent 扫一遍
 *   · 每个 agent/created
 *   · 每个 agent/disposed
 *
 * 需要对照的四个样本（见 probe/README.md）：
 *   1. 主 agent（当前会话）
 *   2. 普通子代理（如 search_topic 派出的 example-reader）
 *   3. Team 队友（会话菜单里开 Team 后派一个）
 *   4. fork 出来的（subagent_fork）
 *
 * 判据成立的条件：样本 1 与 2/4 之间存在稳定、可程序化判断的差异，
 * 且样本 3 的归属是你明确接受的那一边。
 * ============================================================================
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'subagent-identity-probe'
export const inject = ['tools']

const TAG = '[subagent-probe]'

export function apply(ctx) {
  const lines = []

  const append = (record) => {
    lines.push(record)
    try { ctx.logger?.info?.(`${TAG} ${JSON.stringify(record)}`) } catch { /* 没有 logger 也能落盘 */ }
    try { flush() } catch { /* 落盘失败不致命 */ }
  }

  const flush = () => {
    if (lines.length === 0) return
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh')
      const file = join(home, 'subagent-probe.jsonl')
      const text = lines.splice(0, lines.length).map(line => JSON.stringify(line)).join('\n') + '\n'
      appendFileSync(file, text, 'utf8')
    } catch {
      // 落盘失败不致命：日志里仍然有完整记录。
    }
  }

  /** 安全读一个 getter。 */
  const read = (fn, fallback = undefined) => {
    try { return fn() } catch { return fallback }
  }

  /** 读会话 header 里所有与"身份"有关的字段。 */
  const headerFacts = (agent) => {
    const header = read(() => agent?.session?.header)
    if (header === undefined || header === null) return { header: 'missing' }
    return {
      origin: header.origin ?? null,
      delegationDepth: header.delegationDepth ?? null,
      parentSession: header.parentSession ?? null,
      isSeeded: header.isSeeded ?? null,
      agentPreset: header.agentPreset ?? null,
      cwd: header.cwd ?? null,
    }
  }

  /** 数一数某个视角下有几个工具、叫什么。 */
  const toolNames = (tools, scope) => {
    if (typeof tools?.definitions !== 'function') return null
    let list
    try { list = scope === undefined ? tools.definitions() : tools.definitions(scope) } catch { return null }
    if (!Array.isArray(list)) return null
    return list.map(definition => definition?.name).filter(name => typeof name === 'string')
  }

  const describe = async (agent, phase) => {
    const tools = read(() => agent?.ctx?.get?.('tools'))
    const presets = read(() => agent?.ctx?.get?.('agentPresets'))

    const ownNames = toolNames(tools, agent)
    const globalNames = toolNames(tools, undefined)

    let presetId = null
    try {
      const live = presets?.composedPreset?.(agent.ctx)
      if (typeof live === 'string' && live.length > 0) presetId = live
    } catch { /* ignore */ }
    if (presetId === null) {
      const recorded = read(() => agent?.session?.header?.agentPreset)
      if (typeof recorded === 'string' && recorded.length > 0) presetId = recorded
    }

    // preset 视角：借 lease，读完立刻还
    let presetNames = null
    let presetScopeError = null
    if (presetId !== null && typeof presets?.acquireScope === 'function') {
      let lease
      try {
        lease = await presets.acquireScope(presetId)
        presetNames = toolNames(tools, lease.key)
      } catch (error) {
        presetScopeError = String(error?.message ?? error).slice(0, 200)
      } finally {
        if (lease !== undefined) {
          try { await lease[Symbol.asyncDispose]?.() } catch { /* ignore */ }
        }
      }
    }

    // preset 贡献（差集）—— 正式插件用的就是这个
    let contributed = null
    if (presetNames !== null && globalNames !== null) {
      const globalSet = new Set(globalNames)
      contributed = presetNames.filter(name => !globalSet.has(name))
    }

    return {
      phase,
      at: new Date().toISOString(),
      agentId: read(() => agent?.id) ?? null,
      header: headerFacts(agent),
      presetId,
      hasAgentCtx: read(() => Boolean(agent?.ctx)) ?? false,
      toolsOnAgentScope: ownNames === null ? null : ownNames.length,
      toolsOnGlobal: globalNames === null ? null : globalNames.length,
      toolsOnPresetScope: presetNames === null ? null : presetNames.length,
      presetScopeError,
      /** ★ 正式插件施加的 allow 列表就是这个 */
      wouldAllow: contributed,
      /** 判定（按当前采用的判据算出来的结论，供人工对照） */
      judgedAsSubagent: read(() => agent?.session?.header?.origin) === 'subagent',
    }
  }

  const observe = (agent, phase) => {
    // 不 await：探针绝不能影响别人的创建流程。
    void describe(agent, phase)
      .then(record => append(record))
      .catch(error => append({
        phase,
        error: String(error?.message ?? error).slice(0, 300),
        agentId: read(() => agent?.id) ?? null,
      }))
  }

  ctx.on('agent/created', ({ agent }) => { observe(agent, 'created') })
  ctx.on('agent/disposed', ({ agent }) => { observe(agent, 'disposed') })

  // 补扫已存在的 agent（插件加载晚于会话的情况）
  const scanExisting = () => {
    const agents = read(() => ctx.get('agents'))
    if (typeof agents?.list !== 'function') return
    let existing
    try { existing = agents.list() } catch { return }
    for (const agent of existing ?? []) observe(agent, 'existing')
  }

  scanExisting()
  try { ctx.inject(['agents'], () => { scanExisting() }) } catch { /* 老内核没有 inject */ }

  try { ctx.logger?.info?.(`${TAG} 探针已启动（只观测，不限制）`) } catch { /* ignore */ }
}
