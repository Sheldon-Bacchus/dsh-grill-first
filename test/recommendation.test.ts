/**
 * 「默认按推荐执行」模式回归测试：严格覆盖 SDD 的 AC-01 ~ AC-12，
 * 以及协议提示词四档输出与 Schemastery 配置校验。
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONFIG,
  RECOMMENDATION_CATEGORIES,
  RECOMMENDATION_MODES,
  normalizeConfig,
  resolveEffectiveRecommendationCategories,
  type GrillConfig,
} from '../dist/config.js'
import { Config } from '../dist/configSchema.js'
import { GATE_RECOMMENDED_DENY_REASON, GateRegistry } from '../dist/gate/preExecute.js'
import { apply } from '../dist/index.js'
import { detectMissingCriticalFacts, judgeTask } from '../dist/judge/heuristics.js'
import { loadMemory } from '../dist/memory/store.js'
import { PROTOCOL_CHAR_LIMIT, buildProtocolText, protocolLength } from '../dist/prompt/protocol.js'
import {
  CLOSED_PRESENTATION_OPTIONS,
  DECISION_TYPE_CATEGORY,
  buildSafeAuditTokens,
  formatAppliedSummary,
  hasManualReviewSignal,
  validateRecommendationBatch,
} from '../dist/recommendation.js'
import {
  createSettingsHandler,
  validateSettingsPatch,
  type BrowserPeer,
  type Connection,
  type Settings,
} from '../dist/settings/bridge.js'
import { createGrillConfirmTool } from '../dist/tools/grillConfirm.js'
import { createGrillStartTool } from '../dist/tools/grillStart.js'
import { SessionRegistry } from '../dist/tools/sessions.js'

let home: string
let workspace: string
const originalHome = process.env.DSH_GRILL_HOME

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'grill-rec-home-'))
  workspace = await mkdtemp(path.join(tmpdir(), 'grill-rec-ws-'))
  process.env.DSH_GRILL_HOME = home
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalHome === undefined) delete process.env.DSH_GRILL_HOME
  else process.env.DSH_GRILL_HOME = originalHome
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

/** 构造工具测试夹具，支持测试中动态切换生效配置并捕获 logger.warn 审计日志。 */
function makeDeps(overrides: Partial<GrillConfig> = {}, ask?: (request: unknown) => Promise<unknown>) {
  let config: GrillConfig = { ...DEFAULT_CONFIG, ...overrides }
  const gates = new GateRegistry()
  const sessions = new SessionRegistry()
  const warnLogs: string[] = []
  const logger = {
    warn: (message: string) => {
      warnLogs.push(String(message))
    },
  }
  const questions = ask ? { ask: ask as (request: never) => Promise<never> } : undefined
  const base = {
    config: () => config,
    gates,
    sessions,
    workspaceRoot: () => workspace,
    logger,
  }
  return {
    gates,
    sessions,
    warnLogs,
    getConfig: () => config,
    setConfig: (patch: Partial<GrillConfig>) => {
      config = normalizeConfig({ ...config, ...patch })
    },
    grillStart: createGrillStartTool(base),
    grillConfirm: createGrillConfirmTool({ ...base, questions: () => questions as never }),
  }
}

function execCtx(agentId = 'agent-1', signal?: AbortSignal) {
  return { callId: 'call-rec', name: 'grill_confirm', agent: { id: agentId }, ...(signal ? { signal } : {}) } as never
}

const DEFAULT_REQUIREMENTS =
  '目标：整理内部报告草稿\n范围：仅包含本周研发进展，不对外发布\n约束：使用中文输出，不改路径和既有文件\n验收标准：字段齐全、排版清晰即算完成'

let itemSeq = 0

function makeItem(overrides: Record<string, unknown> = {}) {
  itemSeq += 1
  return {
    id: `rec-${itemSeq}`,
    category: 'presentation',
    decision_type: 'presentation.report_layout',
    options: [
      { id: 'table', label: '表格' },
      { id: 'list', label: '列表' },
    ],
    recommended_option_id: 'table',
    reason: '结构化字段对比用表格更清晰',
    impact: '仅调整报告的视觉展示方式，不改变数据字段和含义',
    ...overrides,
  }
}

type Handler = (...args: never[]) => unknown

/**
 * 真实 DSH 0.2.2-rc.5 宿主夹具：
 * - `agents` 仅提供真实宿主存在的 `{ get(id), list() }`，绝不注入不存在的 `roots()`；
 * - 同时挂入根会话 `root-1`、普通 fork 根会话 `fork-root-1` 与委派子会话 `sub-1`；
 * - 捕获 `logger.warn` / `logger.info` 供审计日志防泄漏断言使用。
 */
function createHost(options: {
  config?: Record<string, unknown>
  ask?: (request: unknown) => Promise<unknown>
  downstreamPreExecute?: (exec: { name: string }, next: () => Promise<{ kind: string; reason?: string }>) => Promise<{ kind: string; reason?: string }>
} = {}) {
  const definitions = new Map<string, Record<string, unknown>>()
  const listeners = new Map<string, Handler[]>()
  const rootAgent = { id: 'root-1', session: { header: { cwd: workspace } } }
  const forkRootAgent = { id: 'fork-root-1', session: { header: { cwd: workspace, parentSession: 'root-1' } } }
  const subAgent = {
    id: 'sub-1',
    session: { header: { cwd: workspace, origin: 'subagent' as const, parentSession: 'root-1', delegationDepth: 1 } },
  }
  const agentMap = new Map<string, Record<string, unknown>>([
    [rootAgent.id, rootAgent],
    [forkRootAgent.id, forkRootAgent],
    [subAgent.id, subAgent],
  ])
  const warnLogs: string[] = []
  const infoLogs: string[] = []
  const questions = options.ask ? { ask: options.ask } : undefined
  const agentsService = {
    get: (id: string) => agentMap.get(id),
    list: () => [...agentMap.values()],
  }

  const services: Record<string, unknown> = {
    tools: {
      register(definition: { name: string }) {
        definitions.set(definition.name, definition as unknown as Record<string, unknown>)
        return () => definitions.delete(definition.name)
      },
    },
    agents: agentsService,
    sandboxPolicy: { resolve: () => ({ workspaceRoot: workspace }) },
    get userQuestions() {
      return questions
    },
  }

  const base = {
    logger: {
      info: (message: string) => {
        infoLogs.push(String(message))
      },
      warn: (message: string) => {
        warnLogs.push(String(message))
      },
      error: () => {},
    },
    get: (service: string) => services[service],
    effect: (factory: () => unknown) => factory(),
    on: (event: string, handler: Handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    inject: () => {},
  } as Record<string, unknown>

  apply(base as never, Config(options.config ?? {}))

  if (options.downstreamPreExecute) {
    const list = listeners.get('tools/pre-execute') ?? []
    list.push(options.downstreamPreExecute as unknown as Handler)
    listeners.set('tools/pre-execute', list)
  }

  const resolveAgent = (agentId: string) => agentMap.get(agentId) ?? { id: agentId }

  return {
    warnLogs,
    infoLogs,
    agentsService,
    async preExecute(toolName: string, agentId = 'root-1') {
      const handlers = listeners.get('tools/pre-execute') ?? []
      const exec = { callId: 'call-x', name: toolName, arguments: {}, agent: resolveAgent(agentId) }
      type Decision = { kind: string; reason?: string; displayReason?: string }
      const run = async (index: number): Promise<Decision> => {
        if (index >= handlers.length) return { kind: 'allow' }
        return (await handlers[index]!(exec as never, (() => run(index + 1)) as never)) as Decision
      }
      return run(0)
    },
    inbox(agentId = 'root-1', role = 'user', text = '') {
      for (const handler of listeners.get('agent/inbox/inserted') ?? []) {
        handler({ agent: resolveAgent(agentId), message: { role, text } } as never)
      }
    },
    async callTool(toolName: string, args: unknown, agentId = 'root-1') {
      const definition = definitions.get(toolName)
      if (!definition) throw new Error(`工具未注册：${toolName}`)
      const execute = definition.execute as (args: unknown, exec: unknown) => Promise<unknown>
      return execute(args, { callId: 'call-1', name: toolName, arguments: args, agent: resolveAgent(agentId) })
    },
  }
}

/** 驱动真实 client/index.js 的轻量 React 渲染器（执行 useEffect 与状态更新）。 */
function mountClientSettings(initialConfig: Record<string, unknown>) {
  const state: unknown[] = []
  const effects: Array<{ deps?: unknown[]; cleanup?: unknown; fn: () => unknown }> = []
  let pendingEffects: number[] = []
  let cursor = 0
  let effectCursor = 0
  let component: ((props: { connection: unknown }) => unknown) | undefined
  let currentConfig = { ...initialConfig }
  let revision = 1
  const savedPatches: Array<Record<string, unknown>> = []

  const depsChanged = (prev?: unknown[], next?: unknown[]) => {
    if (!prev || !next || prev.length !== next.length) return true
    return next.some((item, idx) => !Object.is(item, prev[idx]))
  }

  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity),
    }),
    useState: (initial: unknown) => {
      const idx = cursor++
      if (!(idx in state)) state[idx] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [
        state[idx],
        (updater: unknown) => {
          state[idx] = typeof updater === 'function' ? (updater as (prev: unknown) => unknown)(state[idx]) : updater
        },
      ]
    },
    useRef: (initial: unknown) => {
      const idx = cursor++
      if (!(idx in state)) state[idx] = { current: initial }
      return state[idx]
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const idx = effectCursor++
      const prev = effects[idx]
      if (!prev || depsChanged(prev.deps, deps)) {
        effects[idx] = { deps, fn, cleanup: prev?.cleanup }
        pendingEffects.push(idx)
      }
    },
  }

  const connection = {
    rpc: {
      call: async (_channel: string, endpoint: string, payload: Record<string, unknown>) => {
        if (endpoint === 'read') {
          return {
            ok: true,
            value: {
              config: { ...currentConfig },
              revision,
              workspaces: [{ id: 'ws-1', title: '测试项目' }],
            },
          }
        }
        if (endpoint === 'preferences') {
          return { ok: true, value: { scope: payload.scope ?? 'global', revision: 'pref-r0', preferences: [] } }
        }
        if (endpoint === 'save') {
          const patch = (payload.patch ?? {}) as Record<string, unknown>
          savedPatches.push(patch)
          currentConfig = { ...currentConfig, ...patch }
          revision += 1
          return { ok: true, value: { saved: true } }
        }
        return { ok: false, error: { code: 'UNKNOWN', message: 'unknown endpoint', details: {} } }
      },
    },
  }

  vm.runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load: ({ factory }: { factory: (req: (name: string) => unknown) => { apply: (ctx: unknown) => void } }) => {
          factory(() => React).apply({
            connection,
            slots: {
              inject: (_slot: string, cb: () => void) => cb(),
              register: (_meta: unknown, comp: typeof component) => {
                component = comp
              },
            },
          })
        },
      },
    },
    AbortController,
  })

  type VNode = { type: unknown; props: Record<string, any>; children: unknown[] }

  async function render(): Promise<VNode> {
    cursor = 0
    effectCursor = 0
    pendingEffects = []
    const tree = component!({ connection }) as VNode
    const indices = [...pendingEffects]
    pendingEffects = []
    for (const idx of indices) {
      const eff = effects[idx]!
      if (typeof eff.cleanup === 'function') eff.cleanup()
      eff.cleanup = eff.fn()
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    return tree
  }

  async function renderSettled(): Promise<VNode> {
    await render()
    return render()
  }

  function nodes(node: unknown): VNode[] {
    if (!node || typeof node !== 'object') return []
    const vnode = node as VNode
    const children = Array.isArray(vnode.children) ? vnode.children.flatMap(nodes) : []
    return [vnode, ...children]
  }

  function textOf(node: unknown): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!node || typeof node !== 'object') return ''
    const vnode = node as VNode
    return (Array.isArray(vnode.children) ? vnode.children : []).map(textOf).join('')
  }

  return { render, renderSettled, nodes, textOf, savedPatches, getCurrentConfig: () => currentConfig }
}

describe('共享契约常量与基础映射', () => {
  it('暴露推荐模式、类别列表、封闭排版选项与安全审计辅助函数', () => {
    expect(RECOMMENDATION_MODES).toEqual(['manual', 'conservative', 'standard', 'custom', 'autonomous'])
    expect(RECOMMENDATION_CATEGORIES).toEqual(['presentation', 'draft_wording', 'draft_label'])
    expect(DECISION_TYPE_CATEGORY['presentation.report_layout']).toBe('presentation')
    expect(DECISION_TYPE_CATEGORY['draft_wording.title']).toBe('draft_wording')
    expect(DECISION_TYPE_CATEGORY['draft_label.display_title']).toBe('draft_label')
    expect(Array.from(CLOSED_PRESENTATION_OPTIONS['presentation.report_layout'] ?? [])).toEqual(
      expect.arrayContaining(['table', 'list', 'outline', 'cards', 'sections']),
    )
    expect(typeof validateRecommendationBatch).toBe('function')
    expect(typeof buildSafeAuditTokens).toBe('function')
    expect(formatAppliedSummary([])).toBe('')
  })
})

describe('AC-01：旧 profile 默认手动，不新增弹卡，未知档位不放宽', () => {
  it('旧配置缺省归一化为 manual + []；未知档位回退 manual', () => {
    expect(DEFAULT_CONFIG.recommendationMode).toBe('manual')
    expect(DEFAULT_CONFIG.recommendationCategories).toEqual([])
    const legacy = normalizeConfig({ enabled: true, gateMode: 'strict' })
    expect(legacy.recommendationMode).toBe('manual')
    expect(legacy.recommendationCategories).toEqual([])
    expect(resolveEffectiveRecommendationCategories(legacy)).toEqual([])

    for (const bad of ['auto', 'all', 'aggressive', 123, null]) {
      const normalized = normalizeConfig({ recommendationMode: bad, recommendationCategories: ['presentation', 'bad'] })
      expect(normalized.recommendationMode).toBe('manual')
      expect(normalized.recommendationCategories).toEqual(['presentation'])
      expect(resolveEffectiveRecommendationCategories(normalized)).toEqual([])
    }
  })

  it('manual 模式下明确任务直接 clear；模糊任务走旧流程且无推荐回执', async () => {
    const ask = vi.fn(async () => ({ answers: [{ id: 'grill-confirm', selected: ['确认，按此开工'] }] }))
    const { grillStart, grillConfirm, gates } = makeDeps({}, ask)

    const clearResult = (await grillStart.execute(
      { task: '只改 app.ts 的拼写，用 TypeScript，跑通 vitest 就算完成', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>
    expect(clearResult.verdict).toBe('clear')
    expect(clearResult.skip).toBe(true)
    expect(clearResult.gate_state).toBe('open')
    expect(clearResult.recommendation_mode).toBe('manual')
    expect(clearResult.effective_recommendation_categories).toEqual([])
    expect(clearResult.recommendation_eligible).toBe(false)
    expect(ask).not.toHaveBeenCalled()

    const vague = (await grillStart.execute({ task: '帮我做个爬虫' }, execCtx('agent-2'))) as Record<string, unknown>
    expect(vague.verdict).toBe('needs-clarification')
    expect(gates.stateOf('agent-2')).toBe('closed')

    const confirmed = (await grillConfirm.execute(
      { requirements: '目标：做一个爬虫\n范围：只抓商品列表\n约束：用 Python\n验收标准：跑通并输出 CSV' },
      execCtx('agent-2'),
    )) as Record<string, unknown>
    expect(ask).toHaveBeenCalledTimes(1)
    expect(confirmed.confirmed).toBe(true)
    expect(confirmed.decision).toBeUndefined()
    expect(confirmed.released).toBeUndefined()
    expect(gates.stateOf('agent-2')).toBe('open')
  })
})

describe('AC-02：保守模式（conservative）唯一推荐表格，0 张卡放行', () => {
  it('pending_recommendations=true 保持门禁关闭，由 grill_confirm(recommended) 0 卡放行', async () => {
    const ask = vi.fn(async () => ({ answers: [{ id: 'grill-confirm', selected: ['确认，按此开工'] }] }))
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' }, ask)

    const start = (await grillStart.execute(
      {
        task: '只整理本周研发进度内部报告，用中文输出，字段齐全即算完成',
        pending_recommendations: true,
      },
      execCtx(),
    )) as Record<string, unknown>

    expect(start.skip).toBe(false)
    expect(start.gate_state).toBe('closed')
    expect(gates.stateOf('agent-1')).toBe('closed')
    expect(start.task_id).toBeTruthy()
    expect(start.task_version).toBeDefined()
    expect(start.recommendation_mode).toBe('conservative')
    expect(start.effective_recommendation_categories).toEqual(['presentation'])
    expect(start.recommendation_eligible).toBe(true)

    const result = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [makeItem()],
      },
      execCtx(),
    )) as Record<string, unknown>

    expect(ask).not.toHaveBeenCalled()
    expect(result.confirmed).toBe(false)
    expect(result.released).toBe(true)
    expect(result.decision).toBe('recommended')
    expect(result.task_id).toBe(start.task_id)
    expect(result.recommendation_mode).toBe('conservative')
    expect(Array.isArray(result.applied)).toBe(true)
    expect((result.applied as unknown[]).length).toBe(1)
    expect(String(result.summary)).toContain('表格')
    expect(formatAppliedSummary(result.applied as never)).toContain('表格')
    expect(gates.stateOf('agent-1')).toBe('open')
  })
})

describe('AC-03：保守模式仅有 draft_wording 待选时不代选', () => {
  it('拒绝为 category-not-enabled，不放行且门禁保持关闭', async () => {
    const ask = vi.fn()
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' }, ask)

    const start = (await grillStart.execute(
      { task: '只整理内部周报草稿，用中文输出，跑通校对就算完成', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>

    const result = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [
          makeItem({
            category: 'draft_wording',
            decision_type: 'draft_wording.title',
            options: [
              { id: 'weekly_progress', label: '本周进展' },
              { id: 'weekly_summary', label: '周度汇总' },
            ],
            recommended_option_id: 'weekly_progress',
            reason: '内部周报常规标题',
          }),
        ],
      },
      execCtx(),
    )) as Record<string, unknown>

    expect(ask).not.toHaveBeenCalled()
    expect(result.confirmed).toBe(false)
    expect(result.released).not.toBe(true)
    expect(result.reason).toBe('category-not-enabled')
    expect(gates.stateOf('agent-1')).toBe('closed')
  })
})

describe('AC-04：标准模式（standard）内部草稿标题与显示名称 0 卡放行', () => {
  it('draft_wording.title 与 draft_label.display_title 均可自动采用，且不允许改路径或既有文件名', async () => {
    const ask = vi.fn()
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'standard' }, ask)

    const start = (await grillStart.execute(
      { task: '只起草一份新内部草稿，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>

    expect(start.effective_recommendation_categories).toEqual(['presentation', 'draft_wording', 'draft_label'])

    const ok = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [
          makeItem({
            category: 'draft_wording',
            decision_type: 'draft_wording.title',
            options: [
              { id: 't1', label: '本周进展' },
              { id: 't2', label: '工作周报' },
            ],
            recommended_option_id: 't1',
            reason: '突出本周研发进展',
          }),
          makeItem({
            category: 'draft_label',
            decision_type: 'draft_label.display_title',
            options: [
              { id: 'l1', label: '内部草稿：本周进展' },
              { id: 'l2', label: '内部草稿：常规汇总' },
            ],
            recommended_option_id: 'l1',
            reason: '仅设置新建未公开草稿的展示名称',
          }),
        ],
      },
      execCtx(),
    )) as Record<string, unknown>

    expect(ask).not.toHaveBeenCalled()
    expect(ok.confirmed).toBe(false)
    expect(ok.released).toBe(true)
    expect(ok.decision).toBe('recommended')
    expect((ok.applied as unknown[]).length).toBe(2)
    expect(String(ok.summary)).toContain('本周进展')
    expect(gates.stateOf('agent-1')).toBe('open')

    // 即使在 standard 模式，带路径/既有文件名更改也必须拒绝
    const start2 = (await grillStart.execute(
      { task: '只整理一份新内部草稿，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx('agent-2'),
    )) as Record<string, unknown>
    const blockedPath = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start2.task_id,
        task_version: start2.task_version,
        recommendations: [
          makeItem({
            category: 'draft_label',
            decision_type: 'draft_label.display_title',
            options: [
              { id: 'p1', label: '把 src/index.ts 改为 docs/report.md' },
              { id: 'p2', label: '保持原名' },
            ],
            recommended_option_id: 'p1',
            reason: '修改路径',
          }),
        ],
      },
      execCtx('agent-2'),
    )) as Record<string, unknown>
    expect(blockedPath.released).not.toBe(true)
    expect(blockedPath.reason).toBe('policy-blocked')
    expect(gates.stateOf('agent-2')).toBe('closed')
  })

  it('CLOSED_PRESENTATION_OPTIONS：presentation.report_layout 放行封闭选项 ID，拒绝非法自由选项 ID', async () => {
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' })

    const s1 = (await grillStart.execute(
      { task: '只整理内部报告草稿，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx('agent-closed-ok'),
    )) as Record<string, unknown>

    const ok = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: s1.task_id,
        task_version: s1.task_version,
        recommendations: [
          makeItem({
            options: [
              { id: 'outline', label: '提纲' },
              { id: 'cards', label: '卡片' },
              { id: 'sections', label: '分节' },
            ],
            recommended_option_id: 'sections',
          }),
        ],
      },
      execCtx('agent-closed-ok'),
    )) as Record<string, unknown>
    expect(ok.released).toBe(true)
    expect(gates.stateOf('agent-closed-ok')).toBe('open')

    const s2 = (await grillStart.execute(
      { task: '只整理内部报告草稿，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx('agent-closed-bad'),
    )) as Record<string, unknown>

    const bad = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: s2.task_id,
        task_version: s2.task_version,
        recommendations: [
          makeItem({
            options: [
              { id: 'freeform_exec_chart', label: '自由格式' },
              { id: 'table', label: '表格' },
            ],
            recommended_option_id: 'freeform_exec_chart',
          }),
        ],
      },
      execCtx('agent-closed-bad'),
    )) as Record<string, unknown>
    expect(bad.confirmed).toBe(false)
    expect(bad.released).not.toBe(true)
    expect(bad.reason).toBe('invalid-recommendation')
    expect(gates.stateOf('agent-closed-bad')).toBe('closed')
  })
})

describe('AC-05：自定义（custom）按勾选类别精确控制，清空后全拒', () => {
  it('只选 presentation 时放行排版、拒绝措辞；清空 [] 后排版也拒绝', async () => {
    const { grillStart, grillConfirm, gates, setConfig } = makeDeps({
      recommendationMode: 'custom',
      recommendationCategories: ['presentation'],
    })

    const s1 = (await grillStart.execute(
      { task: '只整理内部报告，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>
    expect(s1.effective_recommendation_categories).toEqual(['presentation'])

    const deniedWording = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: s1.task_id,
        task_version: s1.task_version,
        recommendations: [
          makeItem({
            category: 'draft_wording',
            decision_type: 'draft_wording.title',
            options: [
              { id: 't1', label: '本周进展' },
              { id: 't2', label: '项目周报' },
            ],
            recommended_option_id: 't1',
          }),
        ],
      },
      execCtx(),
    )) as Record<string, unknown>
    expect(deniedWording.released).not.toBe(true)
    expect(deniedWording.reason).toBe('category-not-enabled')
    expect(gates.stateOf('agent-1')).toBe('closed')

    const allowedPres = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: s1.task_id,
        task_version: s1.task_version,
        recommendations: [makeItem()],
      },
      execCtx(),
    )) as Record<string, unknown>
    expect(allowedPres.released).toBe(true)
    expect(gates.stateOf('agent-1')).toBe('open')

    // 新任务进入待推荐门禁后，清空自定义勾选为 [] -> 排版也拒绝且门禁保持关闭
    const s2 = (await grillStart.execute(
      { task: '只整理第二份内部报告，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx('agent-2'),
    )) as Record<string, unknown>
    setConfig({ recommendationMode: 'custom', recommendationCategories: [] })

    const deniedPres = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: s2.task_id,
        task_version: s2.task_version,
        recommendations: [makeItem()],
      },
      execCtx('agent-2'),
    )) as Record<string, unknown>
    expect(deniedPres.released).not.toBe(true)
    expect(deniedPres.reason).toBe('category-not-enabled')
    expect(gates.stateOf('agent-2')).toBe('closed')

    // 清空后重新判定：有效类别为空，recommendation_eligible 为 false
    const s3 = (await grillStart.execute(
      { task: '只整理第三份内部报告，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx('agent-3'),
    )) as Record<string, unknown>
    expect(s3.effective_recommendation_categories).toEqual([])
    expect(s3.recommendation_eligible).toBe(false)
  })
})

describe('AC-06：自定义勾选在切到 manual / conservative / standard 后再切回 custom 仍保留', () => {
  it('设置 bridge 保存与校验：切换模式保留原 recommendationCategories 且不污染', async () => {
    expect(
      validateSettingsPatch({
        recommendationMode: 'custom',
        recommendationCategories: ['presentation', 'draft_wording'],
      }),
    ).toEqual({
      recommendationMode: 'custom',
      recommendationCategories: ['presentation', 'draft_wording'],
    })
    expect(() => validateSettingsPatch({ recommendationMode: 'invalid' })).toThrow()
    expect(() => validateSettingsPatch({ recommendationCategories: ['unknown_cat'] })).toThrow()

    const owner: BrowserPeer = { principal: { kind: 'owner' } }
    const connection: Connection = { browserPeer: owner, rpc: { handle: () => async () => {} } }
    let revision = 1
    let stored: Record<string, unknown> = { ...DEFAULT_CONFIG }
    const settings: Settings = {
      describe: () => [{ ns: 'entry:test', revision, value: stored }],
      update: async (_ns, patch, expected) => {
        if (expected !== revision) throw new Error('conflict')
        stored = { ...stored, ...patch }
        revision += 1
      },
    }
    const registry = { list: () => [], get: () => undefined }
    const handler = createSettingsHandler(connection, settings, registry, { namespace: 'entry:test' })
    const call = (endpoint: string, payload: unknown) =>
      handler(endpoint, payload, new AbortController().signal, owner)

    expect(
      await call('save', {
        revision: 1,
        patch: { recommendationMode: 'custom', recommendationCategories: ['presentation', 'draft_wording'] },
      }),
    ).toMatchObject({ ok: true })

    // 切到 manual：manual 下有效类别为空，但保存的自定义列表完整保留
    expect(await call('save', { revision: 2, patch: { recommendationMode: 'manual' } })).toMatchObject({ ok: true })
    const manualRead = (await call('read', {})) as { ok: true; value: { config: GrillConfig; revision: number } }
    expect(manualRead.value.config.recommendationMode).toBe('manual')
    expect(manualRead.value.config.recommendationCategories).toEqual(['presentation', 'draft_wording'])
    expect(resolveEffectiveRecommendationCategories(manualRead.value.config)).toEqual([])

    // 经过 conservative 与 standard，也不能把 draft_label 写进自定义列表
    expect(await call('save', { revision: 3, patch: { recommendationMode: 'conservative' } })).toMatchObject({ ok: true })
    expect(await call('save', { revision: 4, patch: { recommendationMode: 'standard' } })).toMatchObject({ ok: true })
    expect(await call('save', { revision: 5, patch: { recommendationMode: 'custom' } })).toMatchObject({ ok: true })

    const backToCustom = (await call('read', {})) as { ok: true; value: { config: GrillConfig } }
    expect(backToCustom.value.config.recommendationMode).toBe('custom')
    expect(backToCustom.value.config.recommendationCategories).toEqual(['presentation', 'draft_wording'])
    expect(resolveEffectiveRecommendationCategories(backToCustom.value.config)).toEqual([
      'presentation',
      'draft_wording',
    ])
  })

  it('客户端设置页：渲染「开工决策」四档、帮助文案、自定义勾选及切换保留勾选', async () => {
    const ui = mountClientSettings({
      ...DEFAULT_CONFIG,
      recommendationMode: 'custom',
      recommendationCategories: ['presentation', 'draft_wording'],
    })

    let tree = await ui.renderSettled()
    const fullText = ui.textOf(tree)
    expect(fullText).toContain('开工决策')
    expect(fullText).toContain('启用的类别可以直接采用推荐，不用点选；超出范围的决定仍会按原流程处理')

    const findModeSelect = (root: unknown) =>
      ui
        .nodes(root)
        .find(
          (n) =>
            n.type === 'select' &&
            ui.nodes(n).some((c) => c.type === 'option' && c.props.value === 'conservative') &&
            ui.nodes(n).some((c) => c.type === 'option' && c.props.value === 'custom'),
        )

    const modeSelect = findModeSelect(tree)
    expect(modeSelect).toBeDefined()
    const optionValues = ui
      .nodes(modeSelect)
      .filter((n) => n.type === 'option')
      .map((n) => n.props.value)
    expect(optionValues).toEqual(expect.arrayContaining(['manual', 'conservative', 'standard', 'custom']))

    const findCategoryCheckboxes = (root: unknown) =>
      ui
        .nodes(root)
        .filter(
          (n) =>
            n.type === 'input' &&
            n.props.type === 'checkbox' &&
            ['presentation', 'draft_wording', 'draft_label'].includes(String(n.props.value ?? n.props['data-category'] ?? '')),
        )

    // 自定义初始勾选状态
    const initialBoxes = findCategoryCheckboxes(tree)
    expect(initialBoxes).toHaveLength(3)
    const checkedOf = (boxes: typeof initialBoxes) =>
      boxes
        .filter((b) => Boolean(b.props.checked))
        .map((b) => String(b.props.value ?? b.props['data-category']))
    expect(checkedOf(initialBoxes)).toEqual(['presentation', 'draft_wording'])

    // 切到 manual -> standard -> 切回 custom，勾选仍完整保留
    findModeSelect(tree)!.props.onChange({ target: { value: 'manual' } })
    tree = await ui.render()
    findModeSelect(tree)!.props.onChange({ target: { value: 'standard' } })
    tree = await ui.render()
    findModeSelect(tree)!.props.onChange({ target: { value: 'custom' } })
    tree = await ui.render()

    const restoredBoxes = findCategoryCheckboxes(tree)
    expect(checkedOf(restoredBoxes)).toEqual(['presentation', 'draft_wording'])

    const form = ui.nodes(tree).find((n) => n.type === 'form' && typeof n.props.onSubmit === 'function')
    expect(form).toBeDefined()
    await form!.props.onSubmit({ preventDefault: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ui.savedPatches.at(-1)).toMatchObject({
      recommendationMode: 'custom',
      recommendationCategories: ['presentation', 'draft_wording'],
    })
  })
})

describe('AC-07：可代选排版 + 缺收件人，补齐阻塞事实前拦截，补齐后放行且不替代外发审批', () => {
  it('未通过 continue 补齐收件人前拒绝为 needs-clarification；补齐后 0 卡放行且独立工具审批仍生效', async () => {
    const ask = vi.fn()
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative', gateMode: 'strict' }, ask)

    const start = (await grillStart.execute(
      { task: '制作并发送本周进展报告', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>
    expect(start.verdict).toBe('needs-clarification')
    expect(gates.stateOf('agent-1')).toBe('closed')

    // 尚未补齐收件人直接送推荐 -> 被拒
    const blocked = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [makeItem()],
      },
      execCtx(),
    )) as Record<string, unknown>
    expect(blocked.confirmed).toBe(false)
    expect(blocked.released).not.toBe(true)
    expect(blocked.reason).toBe('needs-clarification')
    expect(gates.stateOf('agent-1')).toBe('closed')

    // 通过 continue 只补齐阻塞事实（收件人等），未再问表格/列表
    const continued = (await grillStart.execute(
      {
        task: '制作并发送本周进展报告',
        mode: 'continue',
        answer_summary: '只发给内部研发邮件组 dev@example.com，用中文 Markdown，输出后核对全部字段齐全即可',
        asked_dimensions: ['scope', 'constraint', 'acceptance'],
        pending_recommendations: true,
      },
      execCtx(),
    )) as Record<string, unknown>
    expect(continued.gate_state).toBe('closed')

    const settled = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: continued.task_id,
        task_version: continued.task_version,
        recommendations: [makeItem()],
      },
      execCtx(),
    )) as Record<string, unknown>
    expect(ask).not.toHaveBeenCalled()
    expect(settled.confirmed).toBe(false)
    expect(settled.released).toBe(true)
    expect(settled.decision).toBe('recommended')
    expect(gates.stateOf('agent-1')).toBe('open')

    // 宿主层验证：推荐放行仅打开 grill 门禁，不替代独立的外发工具审批
    const host = createHost({
      config: { gateMode: 'strict', recommendationMode: 'conservative', memoryEnabled: false },
      downstreamPreExecute: async (exec, next) => {
        if (exec.name === 'send_email') return { kind: 'ask', reason: 'external-send-approval' }
        return next()
      },
    })
    const hostStart = (await host.callTool('grill_start', {
      task: '制作并发送本周进展报告',
      pending_recommendations: true,
    })) as Record<string, unknown>
    const hostContinue = (await host.callTool('grill_start', {
      task: '制作并发送本周进展报告',
      mode: 'continue',
      answer_summary: '只发给内部研发邮件组 dev@example.com，用中文 Markdown，输出后核对全部字段齐全即可',
      asked_dimensions: ['scope', 'constraint', 'acceptance'],
      pending_recommendations: true,
    })) as Record<string, unknown>
    const hostConfirm = (await host.callTool('grill_confirm', {
      requirements: DEFAULT_REQUIREMENTS,
      decision_mode: 'recommended',
      task_id: hostContinue.task_id ?? hostStart.task_id,
      task_version: hostContinue.task_version,
      recommendations: [makeItem()],
    })) as Record<string, unknown>
    expect(hostConfirm.released).toBe(true)
    expect('roots' in host.agentsService).toBe(false)
    expect((await host.preExecute('write', 'root-1')).kind).toBe('allow')
    expect((await host.preExecute('write', 'fork-root-1')).kind).toBe('deny')
    expect((await host.preExecute('write', 'sub-1')).kind).toBe('allow')
    expect(await host.preExecute('send_email', 'root-1')).toMatchObject({ kind: 'ask', reason: 'external-send-approval' })
  })

  it('P1-2：intensity=gentle 下缺收件人的“制作并发送报告”仍判 needs-clarification（missing-critical-facts），不误判 clear', async () => {
    const taskMissingRecipient = '制作并发送本周进展报告，用中文输出，字段齐全即算完成'
    const missing = detectMissingCriticalFacts(taskMissingRecipient)
    expect(Array.isArray(missing) ? missing.length > 0 : Boolean(missing)).toBe(true)

    const withRecipient = detectMissingCriticalFacts('制作并发送本周进展报告给 dev@example.com，用中文输出，字段齐全即算完成')
    expect(Array.isArray(withRecipient) ? withRecipient.length === 0 : !withRecipient).toBe(true)

    const judged = judgeTask({
      text: taskMissingRecipient,
      mode: 'new-task',
      intensity: 'gentle',
    })
    expect(judged.verdict).toBe('needs-clarification')
    expect(judged.reason).toBe('missing-critical-facts')

    const { grillStart, grillConfirm, gates } = makeDeps({
      intensity: 'gentle',
      recommendationMode: 'conservative',
      gateMode: 'strict',
    })

    const start = (await grillStart.execute(
      { task: taskMissingRecipient, pending_recommendations: true },
      execCtx('agent-gentle-1'),
    )) as Record<string, unknown>
    expect(start.verdict).toBe('needs-clarification')
    expect(start.skip).toBe(false)
    expect(start.reason).toBe('missing-critical-facts')
    expect(start.gate_state).toBe('closed')
    expect(gates.stateOf('agent-gentle-1')).toBe('closed')

    const blocked = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [makeItem()],
      },
      execCtx('agent-gentle-1'),
    )) as Record<string, unknown>
    expect(blocked.released).not.toBe(true)
    expect(blocked.reason).toBe('needs-clarification')
    expect(gates.stateOf('agent-gentle-1')).toBe('closed')

    const continued = (await grillStart.execute(
      {
        task: taskMissingRecipient,
        mode: 'continue',
        answer_summary: '收件人是内部研发组 dev@example.com',
        asked_dimensions: ['scope'],
        pending_recommendations: true,
      },
      execCtx('agent-gentle-1'),
    )) as Record<string, unknown>
    const settled = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: continued.task_id,
        task_version: continued.task_version,
        recommendations: [makeItem()],
      },
      execCtx('agent-gentle-1'),
    )) as Record<string, unknown>
    expect(settled.released).toBe(true)
    expect(gates.stateOf('agent-gentle-1')).toBe('open')
  })
})

describe('AC-08：用户指定选项或要求「先看方案」/「逐项确认」优先', () => {
  it('hasManualReviewSignal 识别显式人工审查请求', () => {
    expect(hasManualReviewSignal('先看方案再决定要不要改')).toBe(true)
    expect(hasManualReviewSignal('请逐项确认后再执行')).toBe(true)
    expect(hasManualReviewSignal('只整理内部周报')).toBe(false)
  })

  it('用户要求先看方案、逐项确认或明确指定列表时拒绝自动推荐，不误报已采用', async () => {
    const tasks = [
      '只整理本周内部报告，请先看方案再执行，用中文输出，字段齐全即算完成',
      '只整理本周内部报告，需要逐项确认后再出稿，用中文输出，字段齐全即算完成',
      '只整理本周内部报告，明确指定用列表展示不要表格，用中文输出，字段齐全即算完成',
    ]

    for (const [idx, task] of tasks.entries()) {
      const agentId = `agent-ac08-${idx}`
      const ask = vi.fn(async () => ({ answers: [{ id: 'grill-confirm', selected: ['确认，按此开工'] }] }))
      const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' }, ask)

      const start = (await grillStart.execute({ task, pending_recommendations: true }, execCtx(agentId))) as Record<
        string,
        unknown
      >
      const rejected = (await grillConfirm.execute(
        {
          requirements: DEFAULT_REQUIREMENTS,
          decision_mode: 'recommended',
          task_id: start.task_id,
          task_version: start.task_version,
          recommendations: [makeItem({ recommended_option_id: 'table' })],
        },
        execCtx(agentId),
      )) as Record<string, unknown>

      expect(rejected.confirmed).toBe(false)
      expect(rejected.released).not.toBe(true)
      expect(rejected.reason).toBe('manual-confirmation-required')
      expect(rejected.applied).toBeUndefined()
      expect(String(rejected.summary ?? '')).not.toContain('表格')
      expect(gates.stateOf(agentId)).toBe('closed')

      // 仍保留人工确认流程
      const manual = (await grillConfirm.execute(
        { requirements: '目标：整理内部报告\n范围：只含本周进展\n约束：按用户要求确认\n验收标准：字段齐全' },
        execCtx(agentId),
      )) as Record<string, unknown>
      expect(ask).toHaveBeenCalledTimes(1)
      expect(manual.confirmed).toBe(true)
      expect(gates.stateOf(agentId)).toBe('open')
    }
  })

  it('P1-2：英文显式指令（use list / in list format）与澄清答复中改选均拦截为 manual-confirmation-required', async () => {
    const englishTasks = [
      'Prepare internal weekly report, use list format, only include engineering progress, complete when all fields pass',
      'Prepare internal weekly report in list format, only include engineering progress, complete when all fields pass',
    ]
    for (const [idx, task] of englishTasks.entries()) {
      const direct = validateRecommendationBatch({
        items: [makeItem({ recommended_option_id: 'table' })],
        config: { recommendationMode: 'conservative', recommendationCategories: [] },
        task,
        requirements: DEFAULT_REQUIREMENTS,
      })
      expect(direct.ok, `direct-en-${idx}`).toBe(false)
      if (!direct.ok) expect(direct.reason).toBe('manual-confirmation-required')

      const agentId = `agent-ac08-en-${idx}`
      const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' })
      const start = (await grillStart.execute({ task, pending_recommendations: true }, execCtx(agentId))) as Record<
        string,
        unknown
      >
      const rejected = (await grillConfirm.execute(
        {
          requirements: DEFAULT_REQUIREMENTS,
          decision_mode: 'recommended',
          task_id: start.task_id,
          task_version: start.task_version,
          recommendations: [makeItem({ recommended_option_id: 'table' })],
        },
        execCtx(agentId),
      )) as Record<string, unknown>
      expect(rejected.released).not.toBe(true)
      expect(rejected.reason).toBe('manual-confirmation-required')
      expect(gates.stateOf(agentId)).toBe('closed')
    }

    // 澄清答复中改选其他选项（纯函数 + 端到端 continue）
    const directClarified = validateRecommendationBatch({
      items: [makeItem({ recommended_option_id: 'table' })],
      config: { recommendationMode: 'conservative', recommendationCategories: [] },
      task: '制作并发送本周进展报告',
      requirements: DEFAULT_REQUIREMENTS,
      clarificationAnswers: ['发给内部研发组 dev@example.com，排版请用列表展示'],
    })
    expect(directClarified.ok).toBe(false)
    if (!directClarified.ok) expect(directClarified.reason).toBe('manual-confirmation-required')

    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' })
    await grillStart.execute({ task: '制作并发送本周进展报告', pending_recommendations: true }, execCtx('agent-clarify-switch'))
    const cont = (await grillStart.execute(
      {
        task: '制作并发送本周进展报告',
        mode: 'continue',
        answer_summary: '只发给 dev@example.com，用中文输出，排版用 list format，字段齐全即算完成',
        asked_dimensions: ['scope', 'constraint', 'acceptance'],
        pending_recommendations: true,
      },
      execCtx('agent-clarify-switch'),
    )) as Record<string, unknown>
    const rejectedAfterClarify = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: cont.task_id,
        task_version: cont.task_version,
        recommendations: [makeItem({ recommended_option_id: 'table' })],
      },
      execCtx('agent-clarify-switch'),
    )) as Record<string, unknown>
    expect(rejectedAfterClarify.released).not.toBe(true)
    expect(rejectedAfterClarify.reason).toBe('manual-confirmation-required')
    expect(gates.stateOf('agent-clarify-switch')).toBe('closed')
  })

  it('P1-2：「先看方案」即使四维度齐全且未开启推荐也阻断普通 clear，保持门禁关闭', async () => {
    for (const mode of ['manual', 'conservative'] as const) {
      const agentId = `agent-manual-clear-block-${mode}`
      const { grillStart, gates } = makeDeps({ recommendationMode: mode })
      const start = (await grillStart.execute(
        { task: '只整理本周内部报告，请先看方案再执行，用中文输出，字段齐全即算完成' },
        execCtx(agentId),
      )) as Record<string, unknown>
      expect(start.verdict, mode).toBe('needs-clarification')
      expect(start.skip, mode).toBe(false)
      expect(start.gate_state, mode).toBe('closed')
      expect(gates.stateOf(agentId), mode).toBe('closed')
    }
  })
})

describe('AC-09：危险动作包装与未知字段全部被拦截', () => {
  it('重命名既有文件/删除/权限/付费/发布外发/Team-Sub 派发一律 policy-blocked', async () => {
    const cases = [
      {
        label: '重命名 src/index.ts 为 src/main.ts',
        reason: '重命名既有文件 src/index.ts',
        category: 'draft_label',
        decision_type: 'draft_label.display_title',
      },
      {
        label: '删除旧文件 dist/old.js',
        reason: '删除无用产物',
        category: 'draft_label',
        decision_type: 'draft_label.display_title',
      },
      {
        label: '修改 chmod 777 权限并提权',
        reason: '变更权限以方便写入',
        category: 'draft_wording',
        decision_type: 'draft_wording.title',
      },
      {
        label: '自动扣费购买付费套餐',
        reason: '付费升级额度',
        category: 'draft_wording',
        decision_type: 'draft_wording.title',
      },
      {
        label: '公开发布到 npm 并外发邮件给全部客户',
        reason: '发布并外发',
        category: 'draft_wording',
        decision_type: 'draft_wording.title',
      },
      {
        label: '调用 spawn_teammate 派发 subagent 并行修改',
        reason: 'Team/Sub 派发加速执行',
        category: 'draft_label',
        decision_type: 'draft_label.display_title',
      },
    ]

    for (const [idx, item] of cases.entries()) {
      const agentId = `agent-policy-${idx}`
      const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'standard' })
      const start = (await grillStart.execute(
        { task: '只起草一份新内部文档，用中文输出，字段齐全即算完成', pending_recommendations: true },
        execCtx(agentId),
      )) as Record<string, unknown>

      const res = (await grillConfirm.execute(
        {
          requirements: DEFAULT_REQUIREMENTS,
          decision_mode: 'recommended',
          task_id: start.task_id,
          task_version: start.task_version,
          recommendations: [
            makeItem({
              category: item.category,
              decision_type: item.decision_type,
              options: [
                { id: 'act', label: item.label },
                { id: 'keep', label: '保持不变' },
              ],
              recommended_option_id: 'act',
              reason: item.reason,
            }),
          ],
        },
        execCtx(agentId),
      )) as Record<string, unknown>

      expect(res.confirmed).toBe(false)
      expect(res.released).not.toBe(true)
      expect(res.reason).toBe('policy-blocked')
      expect(gates.stateOf(agentId)).toBe('closed')
    }
  })

  it('拒绝任何额外未知字段（lowRisk / path / command / blockers）', async () => {
    const unknownFields: Array<{ top?: Record<string, unknown>; item?: Record<string, unknown> }> = [
      { item: { lowRisk: true } },
      { item: { path: 'src/index.ts' } },
      { item: { command: 'rm -rf .' } },
      { item: { tool: 'write' } },
      { top: { blockers: [] } },
      { top: { lowRisk: true } },
    ]

    for (const [idx, extra] of unknownFields.entries()) {
      const agentId = `agent-extra-${idx}`
      const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'standard' })
      const start = (await grillStart.execute(
        { task: '只整理内部报告，用中文输出，字段齐全即算完成', pending_recommendations: true },
        execCtx(agentId),
      )) as Record<string, unknown>

      const res = (await grillConfirm.execute(
        {
          requirements: DEFAULT_REQUIREMENTS,
          decision_mode: 'recommended',
          task_id: start.task_id,
          task_version: start.task_version,
          recommendations: [makeItem(extra.item ?? {})],
          ...(extra.top ?? {}),
        },
        execCtx(agentId),
      )) as Record<string, unknown>

      expect(res.confirmed).toBe(false)
      expect(res.released).not.toBe(true)
      expect(res.reason).toBe('policy-blocked')
      expect(gates.stateOf(agentId)).toBe('closed')
      const leakedKey = Object.keys(extra.item ?? extra.top ?? {})[0] ?? ''
      expect(String(res.instructions ?? '')).not.toContain(leakedKey)
    }
  })

  it('P0-3 / AC-09：task 或 requirements 含删除/权限/付费/不可逆/Team-Sub 或既有文件重命名时，即使推荐项本身无害也拦截为 policy-blocked', async () => {
    const dangerousRequirements = [
      `${DEFAULT_REQUIREMENTS}\n附注：执行删除历史归档数据`,
      `${DEFAULT_REQUIREMENTS}\n附注：修改目录权限 chmod 777`,
      `${DEFAULT_REQUIREMENTS}\n附注：付费购买导出套餐`,
      `${DEFAULT_REQUIREMENTS}\n附注：执行不可逆表结构覆盖`,
      `${DEFAULT_REQUIREMENTS}\n附注：调用 sws_team_dispatch 派发 subagent 并行处理`,
    ]
    for (const [idx, reqs] of dangerousRequirements.entries()) {
      const direct = validateRecommendationBatch({
        items: [makeItem()],
        config: { recommendationMode: 'standard', recommendationCategories: [] },
        task: '只整理本周内部报告，用中文输出，字段齐全即算完成',
        requirements: reqs,
      })
      expect(direct.ok, `req-direct-${idx}`).toBe(false)
      if (!direct.ok) expect(direct.reason).toBe('policy-blocked')

      const agentId = `agent-danger-req-${idx}`
      const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'standard' })
      const start = (await grillStart.execute(
        { task: '只整理本周内部报告，用中文输出，字段齐全即算完成', pending_recommendations: true },
        execCtx(agentId),
      )) as Record<string, unknown>
      const res = (await grillConfirm.execute(
        {
          requirements: reqs,
          decision_mode: 'recommended',
          task_id: start.task_id,
          task_version: start.task_version,
          recommendations: [makeItem()],
        },
        execCtx(agentId),
      )) as Record<string, unknown>
      expect(res.released, `req-e2e-${idx}`).not.toBe(true)
      expect(res.reason, `req-e2e-${idx}`).toBe('policy-blocked')
      expect(gates.stateOf(agentId), `req-e2e-${idx}`).toBe('closed')
    }

    const dangerousTasks = [
      '只整理本周内部报告并删除旧目录数据，用中文输出，字段齐全即算完成',
      '只整理本周内部报告并修改目录权限 chmod 777，用中文输出，字段齐全即算完成',
      '只整理本周内部报告并付费升级套餐，用中文输出，字段齐全即算完成',
      '只整理本周内部报告并执行不可逆迁移，用中文输出，字段齐全即算完成',
      '只整理本周内部报告并调用 sws_team_dispatch 派发子代理，用中文输出，字段齐全即算完成',
    ]
    for (const [idx, task] of dangerousTasks.entries()) {
      const agentId = `agent-danger-task-${idx}`
      const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'standard' })
      const start = (await grillStart.execute({ task, pending_recommendations: true }, execCtx(agentId))) as Record<
        string,
        unknown
      >
      const res = (await grillConfirm.execute(
        {
          requirements: DEFAULT_REQUIREMENTS,
          decision_mode: 'recommended',
          task_id: start.task_id,
          task_version: start.task_version,
          recommendations: [makeItem()],
        },
        execCtx(agentId),
      )) as Record<string, unknown>
      expect(res.released, `task-e2e-${idx}`).not.toBe(true)
      expect(res.reason, `task-e2e-${idx}`).toBe('policy-blocked')
      expect(gates.stateOf(agentId), `task-e2e-${idx}`).toBe('closed')
    }

    // draft_label 对应的 task / requirements 含既有文件重命名时同样拦截
    const benignDraftLabel = makeItem({
      category: 'draft_label',
      decision_type: 'draft_label.display_title',
      options: [
        { id: 'l1', label: '内部草稿：本周进展' },
        { id: 'l2', label: '内部草稿：周度复盘' },
      ],
      recommended_option_id: 'l1',
      reason: '仅设置展示标题',
    })
    const renameInTask = validateRecommendationBatch({
      items: [benignDraftLabel],
      config: { recommendationMode: 'standard', recommendationCategories: [] },
      task: '只把既有文件 src/index.ts 重命名并整理内部说明，用中文输出，字段齐全即算完成',
      requirements: DEFAULT_REQUIREMENTS,
    })
    expect(renameInTask.ok).toBe(false)
    if (!renameInTask.ok) expect(renameInTask.reason).toBe('policy-blocked')

    const renameInReqs = validateRecommendationBatch({
      items: [benignDraftLabel],
      config: { recommendationMode: 'standard', recommendationCategories: [] },
      task: '只起草一份新内部草稿，用中文输出，字段齐全即算完成',
      requirements: `${DEFAULT_REQUIREMENTS}\n附注：将既有文件 src/index.ts 重命名为 src/main.ts`,
    })
    expect(renameInReqs.ok).toBe(false)
    if (!renameInReqs.ok) expect(renameInReqs.reason).toBe('policy-blocked')
  })

  it('P0-3：推荐放行后 write 可过门禁，但 sws_team_dispatch / sws_subagent / spawn_teammate / subagent / plugin_manager 在 strict 与 ask 下仍被拦截', async () => {
    const privilegedTools = ['sws_team_dispatch', 'sws_subagent', 'spawn_teammate', 'subagent', 'plugin_manager']

    for (const gateMode of ['strict', 'ask'] as const) {
      const expectedKind = gateMode === 'strict' ? 'deny' : 'ask'
      const host = createHost({
        config: { gateMode, recommendationMode: 'conservative', memoryEnabled: false },
      })
      expect('roots' in host.agentsService).toBe(false)

      const start = (await host.callTool('grill_start', {
        task: '只整理本周内部报告，用中文输出，字段齐全即算完成',
        pending_recommendations: true,
      })) as Record<string, unknown>

      const confirmed = (await host.callTool('grill_confirm', {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [makeItem()],
      })) as Record<string, unknown>
      expect(confirmed.released, gateMode).toBe(true)

      // 普通 write 放行，子会话不误拦
      expect((await host.preExecute('write', 'root-1')).kind, `${gateMode}:write`).toBe('allow')
      expect((await host.preExecute('write', 'sub-1')).kind, `${gateMode}:sub-write`).toBe('allow')

      // 委派与高权限工具仍被门禁拦截
      for (const tool of privilegedTools) {
        const decision = await host.preExecute(tool, 'root-1')
        expect(decision.kind, `${gateMode}:${tool}`).toBe(expectedKind)
        expect(decision.reason, `${gateMode}:${tool}`).toBe(GATE_RECOMMENDED_DENY_REASON)
      }
    }
  })
})

describe('AC-10：畸形推荐、缺失选项、未知类别、类型不匹配、空答与取消信号', () => {
  it('全部不得放行，无 released=true，且不写入任何记忆', async () => {
    const invalidPayloads: Array<{ label: string; recs: unknown; abort?: boolean }> = [
      { label: '空数组', recs: [] },
      { label: '少于 2 个选项', recs: [makeItem({ options: [{ id: 'table', label: '表格' }] })] },
      { label: '推荐选项不存在', recs: [makeItem({ recommended_option_id: 'chart' })] },
      {
        label: '选项 ID 重复导致推荐不唯一',
        recs: [
          makeItem({
            options: [
              { id: 'table', label: '表格 A' },
              { id: 'table', label: '表格 B' },
            ],
          }),
        ],
      },
      {
        label: '选项文本重复导致不区分',
        recs: [
          makeItem({
            options: [
              { id: 'table', label: '表格' },
              { id: 'list', label: '表格' },
            ],
            recommended_option_id: 'table',
          }),
        ],
      },
      {
        label: '推荐项 ID 重复导致批次不唯一',
        recs: [makeItem({ id: 'dup-rec-id' }), makeItem({ id: 'dup-rec-id', recommended_option_id: 'list' })],
      },
      {
        label: 'presentation.report_layout 非封闭选项 ID',
        recs: [
          makeItem({
            options: [
              { id: 'freeform_chart', label: '图表' },
              { id: 'list', label: '列表' },
            ],
            recommended_option_id: 'freeform_chart',
          }),
        ],
      },
      { label: 'recommended_option_id 为数组（推荐不唯一）', recs: [makeItem({ recommended_option_id: ['table', 'list'] })] },
      { label: '未知类别', recs: [makeItem({ category: 'filesystem' })] },
      {
        label: '决策类型与类别不匹配',
        recs: [makeItem({ category: 'presentation', decision_type: 'draft_wording.title' })],
      },
      { label: '未知决策类型', recs: [makeItem({ decision_type: 'presentation.unknown' })] },
      { label: '选择理由为空', recs: [makeItem({ reason: '   ' })] },
      { label: '影响说明为空', recs: [makeItem({ impact: '   ' })] },
      { label: '已取消信号 AbortSignal', recs: [makeItem()], abort: true },
    ]

    for (const [idx, testCase] of invalidPayloads.entries()) {
      const agentId = `agent-ac10-${idx}`
      const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'standard' })
      const start = (await grillStart.execute(
        { task: '只整理内部周报，用中文输出，字段齐全即算完成', pending_recommendations: true },
        execCtx(agentId),
      )) as Record<string, unknown>

      const controller = new AbortController()
      if (testCase.abort) controller.abort()

      const res = (await grillConfirm.execute(
        {
          requirements: DEFAULT_REQUIREMENTS,
          decision_mode: 'recommended',
          task_id: start.task_id,
          task_version: start.task_version,
          recommendations: testCase.recs,
        },
        execCtx(agentId, controller.signal),
      )) as Record<string, unknown>

      expect(res.confirmed, testCase.label).toBe(false)
      expect(res.released, testCase.label).not.toBe(true)
      expect(res.decision, testCase.label).not.toBe('recommended')
      expect(gates.stateOf(agentId), testCase.label).toBe('closed')
    }

    const memory = await loadMemory(workspace, 'project')
    expect(memory.global.preferences).toEqual([])
    expect(memory.project.history).toEqual([])
    expect(memory.project.project_context).toEqual([])
  })
})

describe('P2 误拦截回归：保持 .md 格式不变与同批不同 ID 同类型排版', () => {
  it('理由/影响说明中写「保持 .md 格式不变」允许放行，改为 .pdf 仍拦截', async () => {
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' })

    const s1 = (await grillStart.execute(
      { task: '只整理本周内部报告，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx('agent-p2-md'),
    )) as Record<string, unknown>

    const allowed = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: s1.task_id,
        task_version: s1.task_version,
        recommendations: [
          makeItem({
            reason: '保持 .md 格式不变，使用表格对比各模块进度更直观',
            impact: '保持 .md 文件格式不变，仅调整章节呈现布局',
          }),
        ],
      },
      execCtx('agent-p2-md'),
    )) as Record<string, unknown>
    expect(allowed.released).toBe(true)
    expect(allowed.decision).toBe('recommended')
    expect(gates.stateOf('agent-p2-md')).toBe('open')

    // 真正变更文件类型（改为 .pdf）仍必须拦截
    const blocked = validateRecommendationBatch({
      items: [
        makeItem({
          reason: '改为 .pdf 导出方便打印',
          impact: '转成 PDF 文件',
        }),
      ],
      config: { recommendationMode: 'conservative', recommendationCategories: [] },
      task: '只整理本周内部报告，用中文输出，字段齐全即算完成',
      requirements: DEFAULT_REQUIREMENTS,
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('policy-blocked')
  })

  it('同批两条不同 id 的 presentation.report_layout 允许放行', async () => {
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' })

    const start = (await grillStart.execute(
      { task: '只整理本周研发总览与附录两份内部报告，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx('agent-p2-multi-layout'),
    )) as Record<string, unknown>

    const res = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [
          makeItem({
            id: 'main-report-layout',
            decision_type: 'presentation.report_layout',
            options: [
              { id: 'table', label: '主报告表格' },
              { id: 'outline', label: '主报告提纲' },
            ],
            recommended_option_id: 'table',
          }),
          makeItem({
            id: 'appendix-report-layout',
            decision_type: 'presentation.report_layout',
            options: [
              { id: 'list', label: '附录列表' },
              { id: 'cards', label: '附录卡片' },
            ],
            recommended_option_id: 'list',
          }),
        ],
      },
      execCtx('agent-p2-multi-layout'),
    )) as Record<string, unknown>

    expect(res.released).toBe(true)
    expect(res.decision).toBe('recommended')
    expect((res.applied as unknown[]).length).toBe(2)
    expect(gates.stateOf('agent-p2-multi-layout')).toBe('open')
  })
})

describe('AC-11：任务变更、切手动、人工先确认与重放请求均被拒绝', () => {
  it('(a) drift-check 变更任务或新消息重置门禁后，旧推荐请求被拒绝为 stale-decision', async () => {
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' })
    const oldStart = (await grillStart.execute(
      { task: '只整理内部周报，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>

    // 发生任务漂移
    await grillStart.execute(
      { task: '算了改成做下载器', mode: 'drift-check', pending_recommendations: true },
      execCtx(),
    )
    const afterDrift = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: oldStart.task_id,
        task_version: oldStart.task_version,
        recommendations: [makeItem()],
      },
      execCtx(),
    )) as Record<string, unknown>
    expect(afterDrift.released).not.toBe(true)
    expect(afterDrift.reason).toBe('stale-decision')
    expect(gates.stateOf('agent-1')).toBe('closed')

    // 宿主新消息关闭门禁后，旧请求同样被拒
    const host = createHost({ config: { gateMode: 'strict', recommendationMode: 'conservative' } })
    const s2 = (await host.callTool('grill_start', {
      task: '只整理内部周报，用中文输出，字段齐全即算完成',
      pending_recommendations: true,
    })) as Record<string, unknown>
    host.inbox('root-1', 'user', '帮我改另一个接口的实现')
    const afterInbox = (await host.callTool('grill_confirm', {
      requirements: DEFAULT_REQUIREMENTS,
      decision_mode: 'recommended',
      task_id: s2.task_id,
      task_version: s2.task_version,
      recommendations: [makeItem()],
    })) as Record<string, unknown>
    expect(afterInbox.released).not.toBe(true)
    expect(afterInbox.reason).toBe('stale-decision')
    expect((await host.preExecute('write')).kind).toBe('deny')
  })

  it('(b) 生成推荐后配置切到生效的 manual，再送旧请求被拒绝为 recommendation-mode-disabled', async () => {
    const { grillStart, grillConfirm, gates, setConfig } = makeDeps({ recommendationMode: 'conservative' })
    const start = (await grillStart.execute(
      { task: '只整理内部周报，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>

    setConfig({ recommendationMode: 'manual' })

    const res = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [makeItem()],
      },
      execCtx(),
    )) as Record<string, unknown>

    expect(res.confirmed).toBe(false)
    expect(res.released).not.toBe(true)
    expect(res.reason).toBe('recommendation-mode-disabled')
    expect(gates.stateOf('agent-1')).toBe('closed')
  })

  it('(c) 人工先提交确认完成，再送旧推荐请求被拒绝为 stale-decision 且不覆盖人工结果', async () => {
    const ask = vi.fn(async () => ({ answers: [{ id: 'grill-confirm', selected: ['确认，按此开工'] }] }))
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' }, ask)

    const start = (await grillStart.execute(
      { task: '只整理内部周报，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>

    const manualReqs = '目标：整理内部周报\n范围：只包含本周进展\n约束：使用列表展示\n验收标准：字段齐全'
    const manual = (await grillConfirm.execute({ requirements: manualReqs }, execCtx())) as Record<string, unknown>
    expect(manual.confirmed).toBe(true)
    expect(gates.stateOf('agent-1')).toBe('open')

    const staleRec = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [makeItem()],
      },
      execCtx(),
    )) as Record<string, unknown>
    expect(staleRec.confirmed).toBe(false)
    expect(staleRec.released).not.toBe(true)
    expect(staleRec.reason).toBe('stale-decision')

    const memory = await loadMemory(workspace, 'project')
    expect(memory.project.history).toHaveLength(1)
    expect(memory.project.history[0]?.requirements).toContain('使用列表展示')
  })

  it('(d) 推荐已正常结算一次，重放同一请求被拒绝为 stale-decision（同版本只结算一次）', async () => {
    const { grillStart, grillConfirm } = makeDeps({ recommendationMode: 'conservative' })
    const start = (await grillStart.execute(
      { task: '只整理内部周报，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>

    const payload = {
      requirements: DEFAULT_REQUIREMENTS,
      decision_mode: 'recommended',
      task_id: start.task_id,
      task_version: start.task_version,
      recommendations: [makeItem()],
    }

    const first = (await grillConfirm.execute(payload, execCtx())) as Record<string, unknown>
    expect(first.released).toBe(true)

    const replay = (await grillConfirm.execute(payload, execCtx())) as Record<string, unknown>
    expect(replay.confirmed).toBe(false)
    expect(replay.released).not.toBe(true)
    expect(replay.reason).toBe('stale-decision')
  })

  it('(e) P1-1：省略 task_version 或传非法 task_version 必须拒绝为 stale-decision', async () => {
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' })
    const start = (await grillStart.execute(
      { task: '只整理内部周报，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx('agent-no-ver'),
    )) as Record<string, unknown>

    const omitted = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        recommendations: [makeItem()],
      },
      execCtx('agent-no-ver'),
    )) as Record<string, unknown>
    expect(omitted.confirmed).toBe(false)
    expect(omitted.released).not.toBe(true)
    expect(omitted.reason).toBe('stale-decision')
    expect(gates.stateOf('agent-no-ver')).toBe('closed')

    const nonFinite = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: Number.NaN,
        recommendations: [makeItem()],
      },
      execCtx('agent-no-ver'),
    )) as Record<string, unknown>
    expect(nonFinite.released).not.toBe(true)
    expect(nonFinite.reason).toBe('stale-decision')
    expect(gates.stateOf('agent-no-ver')).toBe('closed')
  })

  it('(f) P1-1：未经 grill_start(..., pending_recommendations: true) 进入就绪态，推荐结算拒绝放行（needs-clarification）', async () => {
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'conservative' })

    // 先以模糊任务开启会话（未传 pending_recommendations: true），再 continue 补齐四维度但仍未声明待推荐
    await grillStart.execute({ task: '帮我整理内部周报' }, execCtx('agent-not-ready'))
    const cont = (await grillStart.execute(
      {
        task: '帮我整理内部周报',
        mode: 'continue',
        answer_summary: '只整理本周研发进展，用中文 Markdown 输出，字段齐全即算完成',
        asked_dimensions: ['scope', 'constraint', 'acceptance'],
      },
      execCtx('agent-not-ready'),
    )) as Record<string, unknown>
    expect(cont.gate_state).toBe('closed')

    const rejected = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: cont.task_id,
        task_version: cont.task_version,
        recommendations: [makeItem()],
      },
      execCtx('agent-not-ready'),
    )) as Record<string, unknown>
    expect(rejected.confirmed).toBe(false)
    expect(rejected.released).not.toBe(true)
    expect(rejected.reason).toBe('needs-clarification')
    expect(gates.stateOf('agent-not-ready')).toBe('closed')
  })

  it('(g) P1-1：gateMode=off 时新用户消息仍推进 gateRevision，旧推荐请求被拒为 stale-decision', async () => {
    const host = createHost({ config: { gateMode: 'off', recommendationMode: 'conservative' } })
    expect('roots' in host.agentsService).toBe(false)

    const start = (await host.callTool('grill_start', {
      task: '只整理内部周报，用中文输出，字段齐全即算完成',
      pending_recommendations: true,
    })) as Record<string, unknown>

    host.inbox('root-1', 'user', '算了改成重构订单接口')

    const stale = (await host.callTool('grill_confirm', {
      requirements: DEFAULT_REQUIREMENTS,
      decision_mode: 'recommended',
      task_id: start.task_id,
      task_version: start.task_version,
      recommendations: [makeItem()],
    })) as Record<string, unknown>
    expect(stale.confirmed).toBe(false)
    expect(stale.released).not.toBe(true)
    expect(stale.reason).toBe('stale-decision')
  })

  it('(h) P1-1：continue 遇到已漂移的 gateRevision 返回 stale-task 且不复活旧任务', async () => {
    const host = createHost({ config: { gateMode: 'strict', recommendationMode: 'conservative' } })

    const start = (await host.callTool('grill_start', {
      task: '帮我做个爬虫',
      pending_recommendations: true,
    })) as Record<string, unknown>

    // 新用户消息到达导致 gateRevision 漂移
    host.inbox('root-1', 'user', '改成做日志分析脚本')

    const cont = (await host.callTool('grill_start', {
      task: '帮我做个爬虫',
      mode: 'continue',
      answer_summary: '只抓商品列表，用 Python 输出 CSV，跑通测试即算完成',
      asked_dimensions: ['scope', 'constraint', 'acceptance'],
      pending_recommendations: true,
    })) as Record<string, unknown>
    expect(cont.verdict).toBe('needs-clarification')
    expect(cont.skip).toBe(false)
    expect(cont.reason).toBe('stale-task')
    expect(cont.gate_state).toBe('closed')

    // 旧 task_id 无法被复活结算
    const tryRevive = (await host.callTool('grill_confirm', {
      requirements: DEFAULT_REQUIREMENTS,
      decision_mode: 'recommended',
      task_id: start.task_id,
      task_version: cont.task_version ?? start.task_version,
      recommendations: [makeItem()],
    })) as Record<string, unknown>
    expect(tryRevive.released).not.toBe(true)
    expect(tryRevive.reason).toBe('stale-decision')
    expect((await host.preExecute('write', 'root-1')).kind).toBe('deny')
  })

  it('(i) P1-1：同毫秒两次创建任务的 task_id 必须不同，旧 task_id 不能结算新任务', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123)
    try {
      const { grillStart, grillConfirm } = makeDeps({ recommendationMode: 'conservative' })

      const first = (await grillStart.execute(
        { task: '只整理第一份内部周报，用中文输出，字段齐全即算完成', pending_recommendations: true },
        execCtx('agent-same-ms'),
      )) as Record<string, unknown>
      const second = (await grillStart.execute(
        { task: '只整理第二份内部周报，用中文输出，字段齐全即算完成', mode: 'drift-check', pending_recommendations: true },
        execCtx('agent-same-ms'),
      )) as Record<string, unknown>

      expect(typeof first.task_id).toBe('string')
      expect(typeof second.task_id).toBe('string')
      expect(second.task_id).not.toBe(first.task_id)

      const staleFirst = (await grillConfirm.execute(
        {
          requirements: DEFAULT_REQUIREMENTS,
          decision_mode: 'recommended',
          task_id: first.task_id,
          task_version: second.task_version,
          recommendations: [makeItem()],
        },
        execCtx('agent-same-ms'),
      )) as Record<string, unknown>
      expect(staleFirst.released).not.toBe(true)
      expect(staleFirst.reason).toBe('stale-decision')

      const validSecond = (await grillConfirm.execute(
        {
          requirements: DEFAULT_REQUIREMENTS,
          decision_mode: 'recommended',
          task_id: second.task_id,
          task_version: second.task_version,
          recommendations: [makeItem()],
        },
        execCtx('agent-same-ms'),
      )) as Record<string, unknown>
      expect(validSecond.released).toBe(true)
      expect(validSecond.task_id).toBe(second.task_id)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('AC-12：推荐结算回执完整，不写用户确认历史、项目背景或全局偏好', () => {
  it('返回 decision=recommended / released=true / confirmed=false / applied / summary，记忆文件零新增', async () => {
    const { grillStart, grillConfirm } = makeDeps({
      recommendationMode: 'standard',
      memoryEnabled: true,
    })

    const start = (await grillStart.execute(
      { task: '只起草一份新内部周报，用中文输出，字段齐全即算完成', pending_recommendations: true },
      execCtx(),
    )) as Record<string, unknown>

    const settled = (await grillConfirm.execute(
      {
        requirements: DEFAULT_REQUIREMENTS,
        decision_mode: 'recommended',
        task_id: start.task_id,
        task_version: start.task_version,
        recommendations: [
          makeItem(),
          makeItem({
            category: 'draft_wording',
            decision_type: 'draft_wording.title',
            options: [
              { id: 't1', label: '本周进展' },
              { id: 't2', label: '常规周报' },
            ],
            recommended_option_id: 't1',
            reason: '清晰点题',
          }),
        ],
        preferences_learned: ['不应被写入全局偏好的模型代选记录'],
      },
      execCtx(),
    )) as Record<string, unknown>

    expect(settled.decision).toBe('recommended')
    expect(settled.released).toBe(true)
    expect(settled.confirmed).toBe(false)
    expect(Array.isArray(settled.applied)).toBe(true)
    expect((settled.applied as unknown[]).length).toBe(2)
    expect(String(settled.summary)).toContain('表格')
    expect(String(settled.summary)).toContain('本周进展')

    const memory = await loadMemory(workspace, 'project')
    expect(memory.global.preferences).toEqual([])
    expect(memory.project.history).toEqual([])
    expect(memory.project.project_context).toEqual([])
    expect(await readdir(workspace).catch(() => [])).toEqual([])
    expect(await readdir(home).catch(() => [])).toEqual([])
  })

  it('P1-4：buildSafeAuditTokens 与 logger.warn 审计日志绝不泄漏自由文本草稿选项 ID 或草稿标题；错误消息不回显不可信参数/标签', async () => {
    const secretWordingOptionId = 'secret_salary_adjustment_opt_9x7z'
    const secretWordingTitle = '机密薪酬调整方案草稿_9x7z'
    const secretLabelOptionId = 'secret_merger_codename_opt_8y6w'
    const secretLabelTitle = '机密并购内部代号草稿_8y6w'

    // 1. 纯函数 buildSafeAuditTokens 断言
    const tokens = buildSafeAuditTokens([
      {
        id: 'r1',
        category: 'presentation',
        decision_type: 'presentation.report_layout',
        option_id: 'table',
        option_label: '表格',
        reason: '清晰对比',
        impact: '仅影响布局',
      },
      {
        id: 'r2',
        category: 'draft_wording',
        decision_type: 'draft_wording.title',
        option_id: secretWordingOptionId,
        option_label: secretWordingTitle,
        reason: '内部草稿标题',
        impact: '仅草稿标题',
      },
      {
        id: 'r3',
        category: 'draft_label',
        decision_type: 'draft_label.display_title',
        option_id: secretLabelOptionId,
        option_label: secretLabelTitle,
        reason: '内部展示名',
        impact: '仅草稿显示名',
      },
    ])
    const serializedTokens = Array.isArray(tokens) ? tokens.join(',') : String(tokens)
    expect(serializedTokens).toContain('presentation.report_layout:table')
    expect(serializedTokens).toContain('draft_wording.title')
    expect(serializedTokens).toContain('draft_label.display_title')
    expect(serializedTokens).not.toContain(secretWordingOptionId)
    expect(serializedTokens).not.toContain(secretWordingTitle)
    expect(serializedTokens).not.toContain(secretLabelOptionId)
    expect(serializedTokens).not.toContain(secretLabelTitle)

    // 2. 宿主 logger.warn 捕获断言（端到端推荐放行）
    const host = createHost({
      config: { gateMode: 'strict', recommendationMode: 'standard', memoryEnabled: false },
    })
    const start = (await host.callTool('grill_start', {
      task: '只起草一份新内部周报，用中文输出，字段齐全即算完成',
      pending_recommendations: true,
    })) as Record<string, unknown>

    const settled = (await host.callTool('grill_confirm', {
      requirements: DEFAULT_REQUIREMENTS,
      decision_mode: 'recommended',
      task_id: start.task_id,
      task_version: start.task_version,
      recommendations: [
        makeItem(),
        makeItem({
          category: 'draft_wording',
          decision_type: 'draft_wording.title',
          options: [
            { id: secretWordingOptionId, label: secretWordingTitle },
            { id: 'alt_wording_opt', label: '备选内部周报' },
          ],
          recommended_option_id: secretWordingOptionId,
          reason: '清晰概括内部进度',
        }),
        makeItem({
          category: 'draft_label',
          decision_type: 'draft_label.display_title',
          options: [
            { id: secretLabelOptionId, label: secretLabelTitle },
            { id: 'alt_label_opt', label: '备选内部草稿' },
          ],
          recommended_option_id: secretLabelOptionId,
          reason: '仅用于本轮新草稿展示',
        }),
      ],
    })) as Record<string, unknown>

    expect(settled.released).toBe(true)
    const auditText = host.warnLogs.join('\n')
    expect(auditText).toContain('decision=recommended')
    expect(auditText).toContain(String(start.task_id))
    expect(auditText).toContain('presentation.report_layout:table')
    expect(auditText).not.toContain(secretWordingOptionId)
    expect(auditText).not.toContain(secretWordingTitle)
    expect(auditText).not.toContain(secretLabelOptionId)
    expect(auditText).not.toContain(secretLabelTitle)

    // 3. 错误消息不回显不可信参数名、类别、决策类型或草稿标签文本
    const topSecretKey = 'untrustedTopArg_9x7z'
    const startForUnknownTop = (await host.callTool('grill_start', {
      task: '只起草一份新内部周报，用中文输出，字段齐全即算完成',
      pending_recommendations: true,
    })) as Record<string, unknown>
    const topRejected = (await host.callTool('grill_confirm', {
      requirements: DEFAULT_REQUIREMENTS,
      decision_mode: 'recommended',
      task_id: startForUnknownTop.task_id,
      task_version: startForUnknownTop.task_version,
      recommendations: [makeItem()],
      [topSecretKey]: 'secret_val_9x7z',
    })) as Record<string, unknown>
    expect(topRejected.released).not.toBe(true)
    expect(['policy-blocked', 'invalid-recommendation']).toContain(topRejected.reason)
    expect(String(topRejected.instructions ?? '')).not.toContain(topSecretKey)
    expect(String(topRejected.instructions ?? '')).not.toContain('secret_val_9x7z')

    const noEchoPayloads: Array<{ token: string; item: Record<string, unknown> }> = [
      { token: 'untrustedItemKey_9x7z', item: makeItem({ untrustedItemKey_9x7z: 1 }) },
      { token: 'untrustedCat_9x7z', item: makeItem({ category: 'untrustedCat_9x7z' }) },
      { token: 'untrustedDt_9x7z', item: makeItem({ decision_type: 'untrustedDt_9x7z' }) },
      {
        token: '删除机密客户名单_9x7z',
        item: makeItem({
          category: 'draft_wording',
          decision_type: 'draft_wording.title',
          options: [
            { id: 'act', label: '删除机密客户名单_9x7z' },
            { id: 'keep', label: '保留草稿' },
          ],
          recommended_option_id: 'act',
        }),
      },
      {
        token: 'src/secret_rename_9x7z.ts',
        item: makeItem({
          category: 'draft_label',
          decision_type: 'draft_label.display_title',
          options: [
            { id: 'r1', label: 'src/secret_rename_9x7z.ts' },
            { id: 'r2', label: '内部草稿' },
          ],
          recommended_option_id: 'r1',
        }),
      },
    ]
    for (const { token, item } of noEchoPayloads) {
      const checked = validateRecommendationBatch({
        items: [item],
        config: { recommendationMode: 'standard', recommendationCategories: [] },
        task: '只整理内部周报，用中文输出，字段齐全即算完成',
        requirements: DEFAULT_REQUIREMENTS,
      })
      expect(checked.ok, token).toBe(false)
      if (!checked.ok) {
        expect(checked.message, token).not.toContain(token)
      }
    }
  })
})

describe('协议提示词四档与 Schemastery 配置校验', () => {
  it('buildProtocolText 在 manual / conservative / standard / custom 四档下内容正确、含 pending_recommendations 与 recommendations-pending 分离且不超限', () => {
    const manual = buildProtocolText({
      ...DEFAULT_CONFIG,
      recommendationMode: 'manual',
      recommendationCategories: [],
    })
    const conservative = buildProtocolText({
      ...DEFAULT_CONFIG,
      recommendationMode: 'conservative',
      recommendationCategories: [],
    })
    const standard = buildProtocolText({
      ...DEFAULT_CONFIG,
      recommendationMode: 'standard',
      recommendationCategories: [],
    })
    const customPresent = buildProtocolText({
      ...DEFAULT_CONFIG,
      recommendationMode: 'custom',
      recommendationCategories: ['presentation'],
    })
    const customEmpty = buildProtocolText({
      ...DEFAULT_CONFIG,
      recommendationMode: 'custom',
      recommendationCategories: [],
    })

    for (const text of [manual, conservative, standard, customPresent, customEmpty]) {
      expect(protocolLength(text)).toBeLessThanOrEqual(PROTOCOL_CHAR_LIMIT)
      expect(text).toContain('grill_start')
      expect(text).toContain('grill_confirm')
      expect(text).toContain('ask_user_question')
      expect(text).toContain('drift-check')
    }

    // P1-5：启用推荐档位包含 pending_recommendations 指引且明确分离 recommendations-pending（不调 ask_user_question）
    for (const enabledText of [conservative, standard, customPresent]) {
      expect(enabledText).toContain('pending_recommendations')
      expect(enabledText).toContain('recommendations-pending')
    }

    expect(conservative).not.toBe(manual)
    expect(standard).not.toBe(conservative)
    expect(customPresent).not.toBe(customEmpty)

    // P1-5：传入 50 条超长 bypassKeywords 后协议总长仍不超过 PROTOCOL_CHAR_LIMIT
    const withManyKeywords = buildProtocolText({
      ...DEFAULT_CONFIG,
      intensity: 'grill',
      researchMode: 'always',
      recommendationMode: 'standard',
      bypassKeywords: Array.from({ length: 50 }, (_, idx) => `很长的跳过词_${idx}_${'跳过提问直接开工'.repeat(4)}`),
    })
    expect(protocolLength(withManyKeywords)).toBeLessThanOrEqual(PROTOCOL_CHAR_LIMIT)
    expect(withManyKeywords).toContain('pending_recommendations')
    expect(withManyKeywords).toContain('recommendations-pending')
  })

  it('Config Schemastery 默认值与合法/非法输入校验', () => {
    const defaults = Config({})
    expect(defaults.recommendationMode).toBe('manual')
    expect(defaults.recommendationCategories).toEqual([])

    expect(Config({ recommendationMode: 'conservative' }).recommendationMode).toBe('conservative')
    expect(Config({ recommendationMode: 'standard' }).recommendationMode).toBe('standard')
    expect(Config({ recommendationMode: 'autonomous' }).recommendationMode).toBe('autonomous')
    expect(
      Config({
        recommendationMode: 'custom',
        recommendationCategories: ['presentation', 'draft_wording'],
      }),
    ).toMatchObject({
      recommendationMode: 'custom',
      recommendationCategories: ['presentation', 'draft_wording'],
    })

    expect(() => Config({ recommendationMode: 'auto' as never })).toThrow()
    expect(() => Config({ recommendationCategories: ['unknown_category' as never] })).toThrow()
  })

  it('autonomous 全权自主模式：直接放行 grill_start / grill_confirm / strict 门禁（含 Sub 与 Team 派发）并可在设置页切换保存', async () => {
    const normalized = normalizeConfig({ recommendationMode: 'autonomous', gateMode: 'strict' })
    expect(normalized.recommendationMode).toBe('autonomous')
    expect(validateSettingsPatch({ recommendationMode: 'autonomous' })).toEqual({ recommendationMode: 'autonomous' })

    const protocol = buildProtocolText({
      maxRounds: 3,
      maxQuestionsPerRound: 3,
      bypassKeywords: ['直接做'],
      intensity: 'standard',
      recommendationMode: 'autonomous',
    })
    expect(protocolLength(protocol)).toBeLessThanOrEqual(PROTOCOL_CHAR_LIMIT)
    expect(protocol).toContain('全权自主')
    expect(protocol).toContain('开 Sub 或开 Team')

    const ask = vi.fn()
    const { grillStart, grillConfirm, gates } = makeDeps({ recommendationMode: 'autonomous', gateMode: 'strict' }, ask)
    const startRes = await grillStart.execute({ task: '帮我重构整个模块并决定要不要开子代理或团队' }, { agent: { id: 'root-auto' } })
    expect(startRes).toMatchObject({
      verdict: 'clear',
      skip: true,
      reason: 'autonomous-mode',
      gate_state: 'open',
      recommendation_mode: 'autonomous',
    })
    expect(gates.stateOf('root-auto')).toBe('open')
    expect(gates.releaseKindOf('root-auto')).toBe('autonomous')

    const confirmRes = await grillConfirm.execute(
      { requirements: '目标：直接重构' },
      { agent: { id: 'root-auto' } },
    )
    expect(confirmRes).toMatchObject({
      confirmed: false,
      released: true,
      skipped: true,
      decision: 'autonomous',
      reason: 'autonomous-mode',
      recommendation_mode: 'autonomous',
    })
    expect(ask).not.toHaveBeenCalled()

    // 即使 gateMode=strict，autonomous 模式下挂载门禁也不拦截写操作或 Sub / Team 派发工具。
    const host = createHost({ config: { gateMode: 'strict', recommendationMode: 'autonomous', memoryEnabled: false } })
    for (const toolName of ['write', 'pwsh', 'subagent', 'subagent_fork', 'spawn_teammate', 'sws_subagent', 'sws_team_dispatch', 'team_task_create']) {
      const decision = await host.preExecute(toolName, { id: 'root-1' })
      expect(decision, toolName).toEqual({ kind: 'allow' })
    }

    // 客户端设置页包含「全权自主」选项并正确展示说明
    const ui = mountClientSettings({ ...DEFAULT_CONFIG, recommendationMode: 'autonomous', recommendationCategories: [] })
    const tree = await ui.renderSettled()
    const select = ui.nodes(tree).find((n) => n.type === 'select' && n.props.id === 'gf-recommendation-mode')
    expect(select).toBeDefined()
    const optionValues = ui.nodes(select).filter((n) => n.type === 'option').map((n) => n.props.value)
    expect(optionValues).toContain('autonomous')
    expect(ui.textOf(tree)).toContain('全权自主（模型自行决定方案，可自由开 Sub / Team，不弹确认卡）')
  })
})
