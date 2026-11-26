/**
 * 需求门禁（R3/R4 的执行层）：未确认需求前拦住"实质变更类"工具。
 *
 * 三点设计约束（阶段 1 实测）：
 * 1. `tools/pre-execute` 是 waterfall：不拦截时必须显式 `return next()`；
 * 2. 只有"能跟人对话的根 agent"才纳入门禁——子 agent/teammate 由父 agent 派生，
 *    它们没有人类对话方（`userQuestions.ask` 对它们会抛 DELEGATED_CALLER），
 *    若一并拦截会把正常的委派工作流卡死；
 * 3. warn 模式只记录不拦截（pre-execute 没有"放行 + 附带提示"这种返回形态）。
 */
import type { AgentsService, GrillAgent, GrillContext, PreToolDecision, ToolRunContext } from '../types.js'

/** 门禁档位：ask 档在拦截前先弹一张"要不要继续"的卡片，交给人决定（0.1.4 新增）。 */
export type GateMode = 'off' | 'warn' | 'strict' | 'ask'

/** 门禁状态：open = 已确认或无需确认；closed = 尚未确认。 */
export type GateState = 'open' | 'closed'

/** 门禁放行来源：区分未放行、判定明确放行、人工确认放行、低风险推荐放行、全权自主放行。 */
export type GateReleaseKind = 'none' | 'clear' | 'manual' | 'recommended' | 'autonomous'

/** 变更类工具名单（宁松勿紧）。 */
export const MUTATING_TOOLS: readonly string[] = [
  'write',
  'edit',
  'ops_replace',
  'ops_bash',
  'bash',
  'pwsh',
  'present',
  // 注：job_kill 属于"收尾/止损"操作，不纳入门禁，避免卡住正在跑的后台任务。
  'spawn_teammate',
  'subagent',
  'subagent_fork',
  'workflow',
  'team_task_create',
  // 2026-11-24 SWS × grill-first 门禁补丁：补齐 SWS 派发与团队任务变更工具。
  'sws_team_dispatch',
  'sws_subagent',
  'team_task_update',
  // 注：plugin_manager 会改动 profile（装/卸插件），同属"动手"范畴，一并纳入。
  'plugin_manager',
]

/** 派发与高风险特权工具名单：推荐放行（recommended）不得授权此类工具。 */
export const DELEGATION_AND_PRIVILEGED_TOOLS: readonly string[] = [
  'spawn_teammate',
  'subagent',
  'subagent_fork',
  'workflow',
  'team_task_create',
  'team_task_update',
  'sws_team_dispatch',
  'sws_subagent',
  'plugin_manager',
]

/** 只读工具白名单：即使名字落在 univer_/ops_ 前缀里也一律放行。 */
export const READ_ONLY_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'grep',
  'glob',
  'ops_grep',
  'ops_glob',
  'ops_inspect_local_file',
  'ops_read_files',
  'ops_read_pdf',
  'ops_result',
  'ops_discover_tools',
  'grill_research',
  'search_context',
  'decompress',
  'acp_status',
  'acp_cache',
  'web_search',
  'web_fetch',
  'find_dsh_plugins',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'univer_status',
  'univer_inspect',
  'univer_screenshot',
  'univer_lint',
  'univer_api',
  'univer_resources',
  'ask_user_question',
  'todo_write',
  'list_agents',
  'wait_agent',
  'send_message',
  'get_goal',
  'create_goal',
  'update_goal',
  'grill_start',
  'grill_confirm',
]

/** 拦截时给模型看的拒绝文案（工作表 3.6 原文）。 */
export const GATE_DENY_REASON =
  "需求尚未确认：请先调用 grill_confirm 完成需求确认，或让用户说'直接做'跳过。"

/** ask 档弹给用户看的说明（宿主用 displayReason 渲染卡片正文）。 */
export const GATE_ASK_REASON = '这次任务的需求还没确认，要照现在的理解直接动手吗？'

/** 推荐放行拦截派发/高风险工具时的拒绝文案。 */
export const GATE_RECOMMENDED_DENY_REASON =
  '推荐放行仅适用于低风险表达层，不授权 Team/Sub 派发或高风险工具；请走人工 grill_confirm 或独立授权。'

const READ_ONLY_SET = new Set(READ_ONLY_TOOLS.map((n) => n.toLowerCase()))
const MUTATING_SET = new Set(MUTATING_TOOLS.map((n) => n.toLowerCase()))
const DELEGATION_AND_PRIVILEGED_SET = new Set(DELEGATION_AND_PRIVILEGED_TOOLS.map((n) => n.toLowerCase()))
/** univer_* 里只有这几个是只读的，其余按写类处理。 */
const UNIVER_READ_ONLY = new Set(['univer_status', 'univer_inspect', 'univer_screenshot', 'univer_lint', 'univer_api', 'univer_resources'])

/**
 * 判断某个工具名是否属于"派发或高风险特权工具"（推荐放行不得授权）。
 * @param name 工具名。
 */
export function isDelegationOrPrivilegedTool(name: string): boolean {
  if (typeof name !== 'string' || name.trim() === '') return false
  return DELEGATION_AND_PRIVILEGED_SET.has(name.trim().toLowerCase())
}

/**
 * 判断某个工具名是否属于"会真正改动工作区/交付物"的变更类工具。
 * @param name 工具名。
 */
export function isMutatingTool(name: string): boolean {
  if (typeof name !== 'string' || name.trim() === '') return false
  const tool = name.trim().toLowerCase()
  if (READ_ONLY_SET.has(tool)) return false
  if (MUTATING_SET.has(tool)) return true
  if (tool.startsWith('univer_')) return !UNIVER_READ_ONLY.has(tool)
  if (tool.startsWith('ops_')) return true
  return false
}

/** 门禁判定结果：ask = 弹卡片问用户后由其决定（宿主 PreToolDecision 支持）。 */
export interface GateDecision {
  action: 'allow' | 'deny' | 'ask'
  reason?: string
}

/**
 * 门禁核心判定（纯函数，可单测）。
 * @param input 工具名 + 当前门禁状态 + 档位 + 可选放行来源。
 */
export function decideGate(input: {
  toolName: string
  state: GateState
  mode: GateMode
  releaseKind?: GateReleaseKind
}): GateDecision {
  // off / warn 只记录不拦截（warn 的提示在 registerGate 里单独打日志）。
  if (input.mode === 'off' || input.mode === 'warn') return { action: 'allow' }
  if (input.state === 'open') {
    if (input.releaseKind === 'recommended' && isDelegationOrPrivilegedTool(input.toolName)) {
      if (input.mode === 'ask') return { action: 'ask', reason: GATE_RECOMMENDED_DENY_REASON }
      return { action: 'deny', reason: GATE_RECOMMENDED_DENY_REASON }
    }
    return { action: 'allow' }
  }
  if (!isMutatingTool(input.toolName)) return { action: 'allow' }
  if (input.mode === 'ask') return { action: 'ask', reason: GATE_DENY_REASON }
  return { action: 'deny', reason: GATE_DENY_REASON }
}

/**
 * 从宿主的 inbox 负载里尽量捞出用户消息文本。
 *
 * 不同宿主版本的字段名不统一（text / content / parts），取不到时返回空串；
 * 空串表示"不知道用户说了什么"，此时保持旧行为（关门禁）最安全。
 * @param payload `agent/inbox/inserted` 的事件负载。
 */
function extractMessageText(payload: unknown): string {
  const message = (payload as { message?: unknown } | null | undefined)?.message
  if (typeof message === 'string') return message.trim()
  if (!message || typeof message !== 'object') return ''
  const record = message as Record<string, unknown>
  for (const key of ['text', 'content', 'body', 'prompt', 'parts']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (!Array.isArray(value)) continue
    const joined = value
      .map((part) => (typeof part === 'string' ? part : (part as { text?: unknown } | null)?.text))
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .join('\n')
    if (joined.trim() !== '') return joined.trim()
  }
  return ''
}

/** 每个 agent 的门禁状态表（agent 级隔离）。 */
export class GateRegistry {
  private readonly states = new Map<string, GateState>()
  private readonly revisions = new Map<string, number>()
  private readonly releaseKinds = new Map<string, GateReleaseKind>()

  revisionOf(agentId: string): number {
    return this.revisions.get(agentId) ?? 0
  }

  /** 读取当前放行来源；未放行或未登记时默认 'none'。 */
  releaseKindOf(agentId: string): GateReleaseKind {
    return this.releaseKinds.get(agentId) ?? 'none'
  }

  /** 读取状态；未登记的 agent 默认 closed（新会话即"未确认"）。 */
  stateOf(agentId: string): GateState {
    return this.states.get(agentId) ?? 'closed'
  }

  /** 放行该 agent，并记录放行来源（默认 'manual' 保持向后兼容）。 */
  open(agentId: string, kind: Exclude<GateReleaseKind, 'none'> = 'manual'): void {
    if (agentId) {
      this.states.set(agentId, 'open')
      this.releaseKinds.set(agentId, kind)
    }
  }

  /** 拦截该 agent（新用户消息到达时重置状态与放行来源，并推进代次）。 */
  close(agentId: string): void {
    if (agentId) {
      this.states.set(agentId, 'closed')
      this.releaseKinds.set(agentId, 'none')
      this.revisions.set(agentId, this.revisionOf(agentId) + 1)
    }
  }

  /** 仅推进该 agent 的门禁代次，不改变当前 open/closed 状态。 */
  bumpRevision(agentId: string): number {
    if (!agentId) return 0
    const next = this.revisionOf(agentId) + 1
    this.revisions.set(agentId, next)
    return next
  }

  /** 清空（插件卸载时调用）。 */
  clear(): void {
    this.states.clear()
    this.revisions.clear()
    this.releaseKinds.clear()
  }
}

/**
 * 判断某个 agent 是否是派生出来的子代理（不依赖 parentSession，因为普通 fork 也可能保留 parentSession）。
 */
export function isDelegatedAgent(agent?: GrillAgent): boolean {
  const header = agent?.session?.header
  if (!header) return false
  if (header.origin === 'subagent') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/**
 * 判断某个 agent 是否是"根 agent"（能直接跟人对话）。
 * 优先适配真实 DSH 0.2.2-rc.5 的 `agents.get(id)`，再回退兼容旧版/测试桩的 `roots()` 与仅有 `list()` 的实现。
 * agents 服务不可用或抛异常时返回 false —— 门禁退化为不拦截，避免误伤子 agent。
 */
export function isRootAgent(ctx: GrillContext, agentId: string, eventAgent?: GrillAgent): boolean {
  if (!agentId) return false
  if (isDelegatedAgent(eventAgent)) return false
  try {
    const agents = ctx.get('agents') as AgentsService | undefined
    if (!agents) return false
    if (typeof agents.get === 'function') {
      const found = agents.get(agentId)
      if (!found) return false
      return !isDelegatedAgent(found)
    }
    if (typeof agents.roots === 'function') {
      return agents.roots().some((agent) => agent?.id === agentId && !isDelegatedAgent(agent))
    }
    if (typeof agents.list === 'function') {
      const found = agents.list().find((agent) => agent?.id === agentId)
      return Boolean(found) && !isDelegatedAgent(found)
    }
    return false
  } catch {
    return false
  }
}

/** 注册门禁所需的回调。 */
export interface GateOptions {
  mode: GateMode
  /** warn 模式下的提示回调（默认写日志）。 */
  onWarning?: (toolName: string, agentId: string) => void
  /**
   * 新用户消息到达时，是否把门禁重置为 closed。
   *
   * 0.1.4 修：以前每条用户消息都关门禁，导致"刚确认完、用户回一句继续"又被拦。
   * 现在由判定器看一眼消息内容——追问/询问之类不关门禁。
   * 返回 true 才关门；未提供该回调时保持旧行为（一律关）。
   */
  shouldResetOnMessage?: (text: string) => boolean
}

/**
 * 把门禁挂到宿主事件上：`tools/pre-execute` 拦截 + `agent/inbox/inserted` 重置。
 * @param ctx 插件上下文。
 * @param gates 门禁状态表。
 * @param options 档位与提示回调。
 */
export function registerGate(ctx: GrillContext, gates: GateRegistry, options: GateOptions): void {
  ctx.on('tools/pre-execute', async (exec: ToolRunContext, next: () => Promise<PreToolDecision>) => {
    const agentId = exec?.agent?.id ?? ''
    if (options.mode !== 'off' && agentId !== '' && isRootAgent(ctx, agentId, exec?.agent)) {
      const toolName = exec?.name ?? ''
      const state = gates.stateOf(agentId)
      const releaseKind = gates.releaseKindOf(agentId)
      const decision = decideGate({ toolName, state, mode: options.mode, releaseKind })
      if (decision.action === 'deny') {
        const isRecommendedBlock = decision.reason === GATE_RECOMMENDED_DENY_REASON
        ctx.logger?.info?.(
          isRecommendedBlock
            ? `[grill-first] 拦截 ${exec.name}（推荐放行不授权高风险/派发工具，agent=${agentId}）`
            : `[grill-first] 拦截 ${exec.name}（需求未确认，agent=${agentId}）`,
        )
        return { kind: 'deny', reason: decision.reason ?? GATE_DENY_REASON } satisfies PreToolDecision
      }
      if (decision.action === 'ask') {
        const isRecommendedBlock = decision.reason === GATE_RECOMMENDED_DENY_REASON
        // ask 仅请求当前工具的审批；任务放行仍由 grill_confirm 或显式跳过完成。
        ctx.logger?.info?.(
          isRecommendedBlock
            ? `[grill-first] 询问 ${exec.name}（推荐放行不授权高风险/派发工具，agent=${agentId}）`
            : `[grill-first] 询问 ${exec.name}（需求未确认，agent=${agentId}）`,
        )
        // 单次工具审批结果不能代替整个任务的需求确认，拒绝或取消后仍保持关闭。
        return {
          kind: 'ask',
          reason: decision.reason ?? GATE_DENY_REASON,
          displayReason: isRecommendedBlock ? GATE_RECOMMENDED_DENY_REASON : GATE_ASK_REASON,
        } satisfies PreToolDecision
      }
      if (
        options.mode === 'warn' &&
        ((state === 'closed' && isMutatingTool(toolName)) ||
          (releaseKind === 'recommended' && isDelegationOrPrivilegedTool(toolName)))
      ) {
        options.onWarning?.(exec.name, agentId)
      }
    }
    return next()
  })

  // 新用户消息到达 → 该 agent 的任务门禁重置为 closed 并推进代次（R1/R6 的入口）。
  // 不按 gateMode='off' 短路：off 下 decideGate 永远放行，但代次必须持续递增，确保旧推荐/旧确认作废。
  ctx.on('agent/inbox/inserted', (payload: { agent?: GrillAgent; message?: { role?: string } }) => {
    if (payload?.message?.role !== 'user') return
    const agentId = payload?.agent?.id ?? ''
    if (agentId === '' || !isRootAgent(ctx, agentId, payload?.agent)) return
    const text = extractMessageText(payload)
    if (text !== '' && options.shouldResetOnMessage && !options.shouldResetOnMessage(text)) return
    gates.close(agentId)
  })
}
