/** 门禁判定的单测（覆盖工作表 3.6、P0-1/P0-2/P0-3 与真实 DSH 0.2.2-rc.5 宿主接口）。 */
import { describe, expect, it, vi } from 'vitest'
import {
  DELEGATION_AND_PRIVILEGED_TOOLS,
  GATE_ASK_REASON,
  GATE_DENY_REASON,
  GATE_RECOMMENDED_DENY_REASON,
  GateRegistry,
  MUTATING_TOOLS,
  decideGate,
  isDelegationOrPrivilegedTool,
  isMutatingTool,
  isRootAgent,
  registerGate,
} from '../dist/gate/preExecute.js'

describe('isMutatingTool：变更类工具名单', () => {
  it('写类工具命中', () => {
    for (const tool of ['write', 'edit', 'ops_replace', 'ops_bash', 'pwsh', 'present', 'univer_execute', 'univer_import']) {
      expect(isMutatingTool(tool), tool).toBe(true)
    }
  })

  it('委派与装配类工具同样命中（含 sws_team_dispatch / sws_subagent / team_task_update，堵住绕行）', () => {
    expect(MUTATING_TOOLS).toEqual(
      expect.arrayContaining(['sws_team_dispatch', 'sws_subagent', 'team_task_update']),
    )
    for (const tool of [
      'spawn_teammate',
      'subagent',
      'subagent_fork',
      'workflow',
      'team_task_create',
      'team_task_update',
      'sws_team_dispatch',
      'sws_subagent',
      'plugin_manager',
      'ops_write',
    ]) {
      expect(isMutatingTool(tool), tool).toBe(true)
    }
  })

  it('DELEGATION_AND_PRIVILEGED_TOOLS 与 isDelegationOrPrivilegedTool 准确识别高权限/委派工具', () => {
    const privileged = ['sws_team_dispatch', 'sws_subagent', 'spawn_teammate', 'subagent', 'plugin_manager']
    expect(Array.from(DELEGATION_AND_PRIVILEGED_TOOLS)).toEqual(expect.arrayContaining(privileged))
    for (const tool of privileged) {
      expect(isDelegationOrPrivilegedTool(tool), tool).toBe(true)
    }
    for (const normal of ['write', 'edit', 'read', 'grep', 'grill_confirm', '']) {
      expect(isDelegationOrPrivilegedTool(normal), normal).toBe(false)
    }
  })

  it('只读工具放行', () => {
    for (const tool of [
      'read',
      'grep',
      'glob',
      'ops_grep',
      'ops_inspect_local_file',
      'search_context',
      'web_search',
      'univer_status',
      'univer_inspect',
      'ask_user_question',
      'grill_start',
      'grill_confirm',
    ]) {
      expect(isMutatingTool(tool), tool).toBe(false)
    }
  })

  it('未知工具与空名不拦截', () => {
    expect(isMutatingTool('some_unknown_tool')).toBe(false)
    expect(isMutatingTool('')).toBe(false)
  })
})

describe('decideGate：三种档位', () => {
  it('strict + 未确认 + 变更类工具 → 拒绝，文案与工作表一致', () => {
    const decision = decideGate({ toolName: 'write', state: 'closed', mode: 'strict' })
    expect(decision.action).toBe('deny')
    expect(decision.reason).toBe(GATE_DENY_REASON)
    expect(decision.reason).toContain('grill_confirm')
  })

  it('strict + 未确认 + 只读工具 → 放行', () => {
    expect(decideGate({ toolName: 'read', state: 'closed', mode: 'strict' }).action).toBe('allow')
  })

  it('strict + 已确认 → 全部放行', () => {
    expect(decideGate({ toolName: 'write', state: 'open', mode: 'strict' }).action).toBe('allow')
  })

  it('warn 档位不拦截', () => {
    expect(decideGate({ toolName: 'write', state: 'closed', mode: 'warn' }).action).toBe('allow')
  })

  it('off 档位不拦截', () => {
    expect(decideGate({ toolName: 'write', state: 'closed', mode: 'off' }).action).toBe('allow')
  })
})

describe('decideGate：ask 档位（0.1.4 新增，用宿主原生确认卡片）', () => {
  it('ask + 未确认 + 变更类工具 → action=ask，不直接拒绝', () => {
    const decision = decideGate({ toolName: 'write', state: 'closed', mode: 'ask' })
    expect(decision.action).toBe('ask')
    expect(decision.reason).toBe(GATE_DENY_REASON)
    // 卡片的展示文案走宿主的 displayReason，措辞要能给用户二选一
    expect(GATE_ASK_REASON).toContain('需求还没确认')
  })

  it('ask + 已确认 → 放行', () => {
    expect(decideGate({ toolName: 'write', state: 'open', mode: 'ask' }).action).toBe('allow')
  })

  it('ask + 只读工具 → 放行（问问题不该弹卡片）', () => {
    expect(decideGate({ toolName: 'read', state: 'closed', mode: 'ask' }).action).toBe('allow')
    expect(decideGate({ toolName: 'web_search', state: 'closed', mode: 'ask' }).action).toBe('allow')
  })
})

describe('decideGate：recommended 放行边界（P0-3，不授权委派与高权限工具）', () => {
  const blockedOnRecommended = ['sws_team_dispatch', 'sws_subagent', 'spawn_teammate', 'subagent', 'plugin_manager']

  it('state=open 且 releaseKind=recommended：普通 write 放行，委派/高权限工具在 strict 下仍 deny、ask 下仍 ask', () => {
    expect(GATE_RECOMMENDED_DENY_REASON.trim().length).toBeGreaterThan(0)

    expect(
      decideGate({ toolName: 'write', state: 'open', mode: 'strict', releaseKind: 'recommended' }).action,
    ).toBe('allow')
    expect(
      decideGate({ toolName: 'write', state: 'open', mode: 'ask', releaseKind: 'recommended' }).action,
    ).toBe('allow')
    expect(
      decideGate({ toolName: 'read', state: 'open', mode: 'strict', releaseKind: 'recommended' }).action,
    ).toBe('allow')

    for (const toolName of blockedOnRecommended) {
      const strictDecision = decideGate({ toolName, state: 'open', mode: 'strict', releaseKind: 'recommended' })
      expect(strictDecision.action, `strict:${toolName}`).toBe('deny')
      expect(strictDecision.reason, `strict:${toolName}`).toBe(GATE_RECOMMENDED_DENY_REASON)

      const askDecision = decideGate({ toolName, state: 'open', mode: 'ask', releaseKind: 'recommended' })
      expect(askDecision.action, `ask:${toolName}`).toBe('ask')
      expect(askDecision.reason, `ask:${toolName}`).toBe(GATE_RECOMMENDED_DENY_REASON)

      expect(
        decideGate({ toolName, state: 'open', mode: 'warn', releaseKind: 'recommended' }).action,
        `warn:${toolName}`,
      ).toBe('allow')
      expect(
        decideGate({ toolName, state: 'open', mode: 'off', releaseKind: 'recommended' }).action,
        `off:${toolName}`,
      ).toBe('allow')
    }
  })

  it('releaseKind=manual 或 clear 时，委派与高权限工具在 strict/ask 下正常放行', () => {
    for (const releaseKind of ['manual', 'clear'] as const) {
      for (const toolName of blockedOnRecommended) {
        expect(
          decideGate({ toolName, state: 'open', mode: 'strict', releaseKind }).action,
          `${releaseKind}:strict:${toolName}`,
        ).toBe('allow')
        expect(
          decideGate({ toolName, state: 'open', mode: 'ask', releaseKind }).action,
          `${releaseKind}:ask:${toolName}`,
        ).toBe('allow')
      }
    }
  })
})

describe('GateRegistry：agent 级状态与放行类型', () => {
  it('未登记的 agent 默认未确认且无放行类型', () => {
    const gates = new GateRegistry()
    expect(gates.stateOf('a1')).toBe('closed')
    expect(gates.releaseKindOf('a1')).toBe('none')
  })

  it('open(id, kind)/close/clear 生效且互不干扰，close 递增 revision 并清空 releaseKind', () => {
    const gates = new GateRegistry()
    gates.open('a1', 'recommended')
    expect(gates.stateOf('a1')).toBe('open')
    expect(gates.releaseKindOf('a1')).toBe('recommended')
    expect(gates.stateOf('a2')).toBe('closed')
    expect(gates.releaseKindOf('a2')).toBe('none')

    gates.open('a1', 'manual')
    expect(gates.releaseKindOf('a1')).toBe('manual')

    gates.open('a1', 'clear')
    expect(gates.releaseKindOf('a1')).toBe('clear')

    const revBeforeClose = gates.revisionOf('a1')
    gates.close('a1')
    expect(gates.stateOf('a1')).toBe('closed')
    expect(gates.releaseKindOf('a1')).toBe('none')
    expect(gates.revisionOf('a1')).toBe(revBeforeClose + 1)

    gates.open('a1', 'recommended')
    gates.clear()
    expect(gates.stateOf('a1')).toBe('closed')
    expect(gates.releaseKindOf('a1')).toBe('none')
  })
})

describe('isRootAgent 与 registerGate：真实 DSH 0.2.2-rc.5 agents: { get, list }（无 roots）', () => {
  type Handler = (...args: never[]) => unknown

  function createDsh022Context() {
    const rootAgent = { id: 'root-1', session: { header: { cwd: '/workspace' } } }
    const forkRootAgent = {
      id: 'fork-root-1',
      session: { header: { cwd: '/workspace', parentSession: 'root-1' } },
    }
    const subByOrigin = {
      id: 'sub-origin-1',
      session: { header: { cwd: '/workspace', origin: 'subagent' as const, parentSession: 'root-1' } },
    }
    const subByDepth = {
      id: 'sub-depth-1',
      session: { header: { cwd: '/workspace', delegationDepth: 1, parentSession: 'root-1' } },
    }

    const agentMap = new Map<string, Record<string, unknown>>([
      [rootAgent.id, rootAgent],
      [forkRootAgent.id, forkRootAgent],
      [subByOrigin.id, subByOrigin],
      [subByDepth.id, subByDepth],
    ])
    const listeners = new Map<string, Handler[]>()

    // 真实 DSH 0.2.2-rc.5 仅提供 get(id) 与 list()，不存在 roots()
    const agentsService = {
      get: (id: string) => agentMap.get(id),
      list: () => [...agentMap.values()],
    }

    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      get: (service: string) => (service === 'agents' ? agentsService : undefined),
      on: (event: string, handler: Handler) => {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {}
      },
      effect: (fn: () => unknown) => fn(),
      inject: () => {},
    }

    return {
      ctx,
      agentsService,
      rootAgent,
      forkRootAgent,
      subByOrigin,
      subByDepth,
      async preExecute(toolName: string, agent: Record<string, unknown>) {
        const handlers = listeners.get('tools/pre-execute') ?? []
        const exec = { callId: 'call-gate', name: toolName, agent }
        const run = async (index: number): Promise<{ kind: string; reason?: string; displayReason?: string }> => {
          if (index >= handlers.length) return { kind: 'allow' }
          return (await handlers[index]!(exec as never, (() => run(index + 1)) as never)) as {
            kind: string
            reason?: string
            displayReason?: string
          }
        }
        return run(0)
      },
      inbox(agent: Record<string, unknown>, role: string, text: string) {
        for (const handler of listeners.get('agent/inbox/inserted') ?? []) {
          handler({ agent, message: { role, text } } as never)
        }
      },
    }
  }

  it('isRootAgent 在无 roots() 的宿主上准确区分根会话、普通 fork 根会话与委派子会话', () => {
    const env = createDsh022Context()
    expect('roots' in env.agentsService).toBe(false)

    expect(isRootAgent(env.ctx as never, env.rootAgent.id)).toBe(true)
    expect(isRootAgent(env.ctx as never, env.forkRootAgent.id)).toBe(true)
    expect(isRootAgent(env.ctx as never, env.subByOrigin.id)).toBe(false)
    expect(isRootAgent(env.ctx as never, env.subByDepth.id)).toBe(false)
    expect(isRootAgent(env.ctx as never, 'non-existent-agent')).toBe(false)
    expect(isRootAgent(env.ctx as never, '')).toBe(false)

    // 透传 eventAgent 时：已登记普通 fork 根会话为 true；未在 agents.get 中登记的伪造/离线对象按 fail-closed 返回 false；委派子会话为 false
    expect(isRootAgent(env.ctx as never, env.forkRootAgent.id, env.forkRootAgent as never)).toBe(true)
    expect(isRootAgent(env.ctx as never, 'inline-root', { id: 'inline-root', session: { header: { parentSession: 'root-1' } } } as never)).toBe(false)
    expect(
      isRootAgent(
        env.ctx as never,
        env.rootAgent.id,
        { id: env.rootAgent.id, session: { header: { origin: 'subagent' } } } as never,
      ),
    ).toBe(false)
    expect(
      isRootAgent(
        env.ctx as never,
        env.rootAgent.id,
        { id: env.rootAgent.id, session: { header: { delegationDepth: 2 } } } as never,
      ),
    ).toBe(false)
  })

  it('registerGate strict 档位：拦根会话与普通 fork，放行子会话；recommended 放行后仍拦委派/高权限工具', async () => {
    const env = createDsh022Context()
    const gates = new GateRegistry()
    registerGate(env.ctx as never, gates, { mode: 'strict' })

    expect((await env.preExecute('write', env.rootAgent)).kind).toBe('deny')
    expect((await env.preExecute('write', env.forkRootAgent)).kind).toBe('deny')
    expect((await env.preExecute('read', env.rootAgent)).kind).toBe('allow')
    expect((await env.preExecute('write', env.subByOrigin)).kind).toBe('allow')
    expect((await env.preExecute('write', env.subByDepth)).kind).toBe('allow')

    // recommended 放行仅放行普通写，不授权委派/高权限工具
    gates.open(env.rootAgent.id, 'recommended')
    expect((await env.preExecute('write', env.rootAgent)).kind).toBe('allow')
    for (const tool of ['sws_team_dispatch', 'sws_subagent', 'spawn_teammate', 'subagent', 'plugin_manager']) {
      const decision = await env.preExecute(tool, env.rootAgent)
      expect(decision.kind, tool).toBe('deny')
      expect(decision.reason, tool).toBe(GATE_RECOMMENDED_DENY_REASON)
    }

    // manual 放行后允许委派与高权限工具
    gates.open(env.rootAgent.id, 'manual')
    expect((await env.preExecute('sws_team_dispatch', env.rootAgent)).kind).toBe('allow')

    // 新用户消息到达根会话会重置门禁并推进 revision；子会话消息不干扰根会话
    const revBeforeSub = gates.revisionOf(env.rootAgent.id)
    env.inbox(env.subByOrigin, 'user', '子会话内部消息')
    expect(gates.stateOf(env.rootAgent.id)).toBe('open')
    expect(gates.revisionOf(env.rootAgent.id)).toBe(revBeforeSub)

    env.inbox(env.rootAgent, 'user', '换个新需求实现导出')
    expect(gates.stateOf(env.rootAgent.id)).toBe('closed')
    expect(gates.revisionOf(env.rootAgent.id)).toBeGreaterThan(revBeforeSub)
  })

  it('registerGate ask / warn / off 三档行为，且 off 档位下新用户消息仍推进 gateRevision', async () => {
    // ask 档位
    const askEnv = createDsh022Context()
    const askGates = new GateRegistry()
    registerGate(askEnv.ctx as never, askGates, { mode: 'ask' })
    expect(await askEnv.preExecute('write', askEnv.rootAgent)).toMatchObject({
      kind: 'ask',
      displayReason: GATE_ASK_REASON,
    })
    expect((await askEnv.preExecute('write', askEnv.subByOrigin)).kind).toBe('allow')
    askGates.open(askEnv.rootAgent.id, 'recommended')
    expect((await askEnv.preExecute('write', askEnv.rootAgent)).kind).toBe('allow')
    expect(await askEnv.preExecute('sws_team_dispatch', askEnv.rootAgent)).toMatchObject({
      kind: 'ask',
      reason: GATE_RECOMMENDED_DENY_REASON,
    })

    // warn 档位
    const warnEnv = createDsh022Context()
    const warnGates = new GateRegistry()
    const onWarning = vi.fn()
    registerGate(warnEnv.ctx as never, warnGates, { mode: 'warn', onWarning })
    expect((await warnEnv.preExecute('write', warnEnv.rootAgent)).kind).toBe('allow')
    expect(onWarning).toHaveBeenCalledWith('write', warnEnv.rootAgent.id)
    expect((await warnEnv.preExecute('write', warnEnv.subByDepth)).kind).toBe('allow')
    expect(onWarning).toHaveBeenCalledTimes(1)

    // off 档位：不拦截工具，但新用户消息仍推进 gateRevision 使旧推荐作废
    const offEnv = createDsh022Context()
    const offGates = new GateRegistry()
    registerGate(offEnv.ctx as never, offGates, {
      mode: 'off',
      shouldResetOnMessage: (text) => text !== '继续',
    })
    expect((await offEnv.preExecute('write', offEnv.rootAgent)).kind).toBe('allow')

    const rev0 = offGates.revisionOf(offEnv.rootAgent.id)
    offEnv.inbox(offEnv.rootAgent, 'assistant', '助手回复不推进版本')
    expect(offGates.revisionOf(offEnv.rootAgent.id)).toBe(rev0)

    offEnv.inbox(offEnv.rootAgent, 'user', '继续')
    expect(offGates.revisionOf(offEnv.rootAgent.id)).toBe(rev0)

    offEnv.inbox(offEnv.rootAgent, 'user', '改成重构支付模块')
    expect(offGates.revisionOf(offEnv.rootAgent.id)).toBeGreaterThan(rev0)
  })
})
