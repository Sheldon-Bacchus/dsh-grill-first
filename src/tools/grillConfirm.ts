/**
 * `grill_confirm` 工具（R3/R5）：把整理好的需求清单交给用户确认，确认后才放行；
 * 在启用推荐模式且无未解阻塞时，也支持 `decision_mode: "recommended"` 的独立无卡推荐结算。
 *
 * 两条人工确认通道：
 * 1. 结构化提问（`ctx.userQuestions.ask`）——用户直接选"确认 / 要改"，最可靠；
 * 2. 兜底通道——`userQuestions` 不可用（或对子 agent 抛 DELEGATED_CALLER）时，
 *    返回 needs_user_confirmation，让模型改用内置 `ask_user_question` 问用户，
 *    用户同意后再调用 `grill_confirm(confirmed:true)`。
 *
 * R3 红线：需求清单只进记忆的 history 字段，绝不写任何需求文件；推荐结算绝不写用户确认记忆。
 */
import type { GrillConfig, MemoryScope, RecommendationMode } from '../config.js'
import type { GateRegistry } from '../gate/preExecute.js'
import { judgeTask } from '../judge/heuristics.js'
import { saveHistory, savePreference, saveProjectContext } from '../memory/store.js'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  GrillAgent,
  ToolDefinition,
  ToolRunContext,
  UserQuestionsService,
} from '../types.js'
import { buildDeliveryReminder } from '../prompt/reminders.js'
import {
  buildSafeAuditTokens,
  hasManualReviewSignal,
  validateRecommendationBatch,
  type AppliedRecommendation,
  type RecommendationItem,
} from '../recommendation.js'
import { textOutput } from './grillStart.js'
import type { SessionRegistry } from './sessions.js'

/** 工具依赖（由 index.ts 装配注入）。 */
export interface GrillConfirmDeps {
  config: () => GrillConfig
  gates: GateRegistry
  sessions: SessionRegistry
  /** 解析当前会话的工作区根目录（项目层记忆落点）。 */
  workspaceRoot: (agent?: GrillAgent) => string
  /** 项目层记忆落在工作区还是插件家目录（memoryScope 配置）。 */
  memoryScope?: () => MemoryScope
  /** 结构化提问服务（可能不存在）。 */
  questions: () => UserQuestionsService | undefined
  logger?: { warn(message: string): void }
}

/** grill_confirm 的返回体。 */
export interface GrillConfirmResult {
  confirmed: boolean
  released?: boolean
  decision?: 'manual' | 'recommended' | 'autonomous'
  task_id?: string
  recommendation_mode?: RecommendationMode
  applied?: AppliedRecommendation[]
  summary?: string
  final_requirements?: string
  feedback?: string
  requirements?: string
  needs_user_confirmation?: boolean
  instructions?: string
  user_note?: string
  skipped?: boolean
  reason?: string
  error?: string
  /** 已追问轮数 / 剩余轮数（选"要改"时给出，供模型判断还要不要继续问）。 */
  rounds_used?: number
  rounds_left?: number
  saved?: { history: boolean; preferences: number; project_context: boolean }
}

/** grill_confirm 的参数 schema。 */
const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    requirements: {
      type: 'string',
      description:
        '四段式中文需求清单全文（目标 / 范围 / 约束 / 验收标准）。会原样展示给用户确认，不会写进任何文件。',
    },
    preferences_learned: {
      type: 'array',
      items: { type: 'string' },
      description: '本次对话里用户表露的通用偏好（例如"注释一律用中文"），确认后写入全局记忆。',
    },
    confirmed: {
      type: 'boolean',
      description:
        '仅用于兜底通道：已经用 ask_user_question 向用户展示过该清单并得到明确同意时传 true，直接开工；正常情况下不要传，让用户在本工具的确认卡片里选。',
    },
    decision_mode: {
      type: 'string',
      enum: ['manual', 'recommended'],
      description: '默认 manual（人工确认卡片）；recommended 表示按当前推荐策略独立结算低风险项（不弹卡、不写用户确认记忆）。',
    },
    task_id: {
      type: 'string',
      description: '当前待结算任务的 task_id（推荐结算必填）。',
    },
    task_version: {
      type: 'number',
      description: 'grill_start 返回的 task_version（门禁版本，推荐结算必填，用于防过期请求）。',
    },
    recommendations: {
      type: 'array',
      description: '封闭决策类型的待采用推荐项列表（推荐结算必填）。',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string' },
          decision_type: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
          },
          recommended_option_id: { type: 'string' },
          reason: { type: 'string' },
          impact: { type: 'string' },
        },
        required: ['id', 'category', 'decision_type', 'options', 'recommended_option_id', 'reason', 'impact'],
        additionalProperties: false,
      },
    },
  },
  required: ['requirements'],
  additionalProperties: false,
}

/** grill_confirm 的返回 schema。 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    confirmed: { type: 'boolean' },
    released: { type: 'boolean' },
    decision: { type: 'string', enum: ['manual', 'recommended', 'autonomous'] },
    task_id: { type: 'string' },
    recommendation_mode: { type: 'string' },
    applied: { type: 'array' },
    summary: { type: 'string' },
    final_requirements: { type: 'string' },
    feedback: { type: 'string', description: '用户选择"要改"时的修改意见' },
    needs_user_confirmation: { type: 'boolean' },
    instructions: { type: 'string' },
    skipped: { type: 'boolean' },
    reason: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
}

/** 项目背景写入时截断的长度。 */
const PROJECT_CONTEXT_LIMIT = 300

/**
 * 确认卡片标题（`question` 字段）的长度上限。
 *
 * 卡片高度被固定在 `min(60vh, 520px)`，而标题所在的 header 是 `flex-shrink: 0` 且**不滚动**：
 * 标题一旦长到几百字，就会把唯一可收缩的正文区（选项按钮、自定义输入框都在里面）压成 0 高，
 * 用户"选择不到开工选项"，只能关掉卡片手动打字。所以标题必须短，长清单一律走 `detail`。
 */
const CARD_TITLE_LIMIT = 60

/** 确认卡片正文（`detail` 字段）的长度上限：正文在可滚动区里渲染，超长必须拒绝并要求摘要。 */
const CARD_DETAIL_LIMIT = 6000

/** `grill_confirm` 推荐分支合法顶层参数键集合（防透传 `lowRisk` / `blockers` / `path` / `confirmed` 等字段）。 */
const ALLOWED_RECOMMENDED_ARG_KEYS = new Set([
  'requirements',
  'preferences_learned',
  'decision_mode',
  'task_id',
  'task_version',
  'recommendations',
])

/** 卡片正文末尾的使用提示。 */
const CARD_DETAIL_HINT = '确认后我才会开工；选择"要改"时请在最下面的输入框里写清要改哪里。'

/** 取首行作为任务摘要。 */
function firstLine(text: string): string {
  const line = text.split('\n').map((t) => t.trim()).find((t) => t !== '')
  return line ?? text.trim()
}

/** 压平空白（含换行）并截断，得到一行以内的卡片标题。 */
function cardTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > CARD_TITLE_LIMIT ? `${flat.slice(0, CARD_TITLE_LIMIT)}…` : flat
}

/** 卡片正文：完整清单（超长已在入口拒绝）+ 使用提示。 */
function cardDetail(requirements: string): string {
  return `${requirements}\n\n---\n\n${CARD_DETAIL_HINT}`
}

/**
 * 创建 `grill_confirm` 工具定义。
 * @param deps 配置读取、门禁表、会话表、工作区根目录、结构化提问服务。
 */
export function createGrillConfirmTool(deps: GrillConfirmDeps): ToolDefinition {
  const fallback = new Map<string, { session: unknown; revision: string; gateRevision: number; requirements: string }>()
  return {
    name: 'grill_confirm',
    description:
      '把整理好的中文需求清单交给用户确认（grill-first 插件）。用户确认后本次任务放行，并把确认过的内容写入两层记忆；用户选"要改"时返回 feedback，据此修订后再次调用。启用推荐模式且符合条件时，可通过 decision_mode="recommended" 独立结算低风险项（不弹卡、不写用户确认记忆）。',
    parameters: PARAMETERS,
    output: textOutput(OUTPUT_SCHEMA),
    isConcurrencySafe: () => false,
    async execute(rawArgs: unknown, exec: ToolRunContext): Promise<GrillConfirmResult> {
      const args = (rawArgs ?? {}) as {
        requirements?: unknown
        preferences_learned?: unknown
        confirmed?: unknown
        decision_mode?: unknown
        task_id?: unknown
        task_version?: unknown
        recommendations?: unknown
      }
      const config = deps.config()
      const agentId = exec?.agent?.id ?? ''
      const requirements = typeof args.requirements === 'string' ? args.requirements.trim() : ''
      const preferences = Array.isArray(args.preferences_learned)
        ? args.preferences_learned.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : []

      if (!config.enabled) {
        return { confirmed: true, skipped: true, reason: 'disabled' }
      }
      if (config.recommendationMode === 'autonomous') {
        deps.sessions.end(agentId)
        deps.gates.open(agentId, 'autonomous')
        return {
          confirmed: false,
          released: true,
          skipped: true,
          decision: 'autonomous',
          reason: 'autonomous-mode',
          recommendation_mode: 'autonomous',
          ...(requirements !== '' ? { final_requirements: requirements } : {}),
          instructions: '当前为全权自主模式（autonomous），已直接放行，无需等待用户确认；可直接执行或自由开 Sub / Team。',
        }
      }

      if (args.decision_mode === 'recommended' || args.recommendations !== undefined) {
        if (args.decision_mode !== 'recommended') {
          return {
            confirmed: false,
            released: false,
            reason: 'invalid-recommendation',
            instructions: '推荐结算必须显式传入 decision_mode: "recommended"。',
          }
        }
        if (args.confirmed === true) {
          return {
            confirmed: false,
            released: false,
            reason: 'policy-blocked',
            instructions: '推荐结算包含不支持或受限的顶层参数，已拒绝。',
          }
        }
        if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
          for (const key of Object.keys(rawArgs as Record<string, unknown>)) {
            if (!ALLOWED_RECOMMENDED_ARG_KEYS.has(key)) {
              return {
                confirmed: false,
                released: false,
                reason: 'policy-blocked',
                instructions: '推荐结算包含不支持或受限的顶层参数，已拒绝。',
              }
            }
          }
        }
        if (exec?.signal?.aborted) {
          return { confirmed: false, released: false, reason: 'confirmation-cancelled' }
        }
        if (requirements === '') {
          return {
            confirmed: false,
            released: false,
            reason: 'empty-requirements',
            instructions: 'requirements 不能为空：请把四段式需求清单全文放进 requirements 参数，再调用一次。',
          }
        }
        if (requirements.length > CARD_DETAIL_LIMIT) {
          return {
            confirmed: false,
            released: false,
            reason: 'requirements-too-long',
            instructions: `清单超过 ${CARD_DETAIL_LIMIT} 字，未展示也未授权。请先分段整理摘要，保留全部约束和验收条件，再提交完整四段清单确认。`,
          }
        }

        // 先读取当前门禁版本与会话，避免在校验过期前改动门禁或覆盖已有人工放行结果。
        const currentGateRevision = deps.gates.revisionOf(agentId)
        const session = deps.sessions.get(agentId)
        const reqTaskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
        if (reqTaskId === '') {
          return {
            confirmed: false,
            released: false,
            reason: 'stale-decision',
            instructions: '推荐结算缺少当前 task_id。',
          }
        }
        if (deps.sessions.getSettled(agentId, reqTaskId)) {
          return {
            confirmed: false,
            released: false,
            reason: 'stale-decision',
            instructions: '该任务版本已结算，拒绝重复或过期推荐请求。',
          }
        }
        const sessionTaskId = session ? (session.taskId ?? `${agentId}:${session.startedAt}`) : ''
        if (!session || sessionTaskId !== reqTaskId) {
          return {
            confirmed: false,
            released: false,
            reason: 'stale-decision',
            instructions: '任务已变更或不存在，旧推荐已作废。',
          }
        }
        if (
          typeof args.task_version !== 'number'
          || !Number.isFinite(args.task_version)
          || args.task_version !== currentGateRevision
        ) {
          return {
            confirmed: false,
            released: false,
            reason: 'stale-decision',
            instructions: '推荐结算缺少有效的 task_version 或任务门禁版本已变化，旧推荐已作废。',
          }
        }
        if (session.gateRevision !== undefined && session.gateRevision !== currentGateRevision) {
          return {
            confirmed: false,
            released: false,
            reason: 'stale-decision',
            instructions: '任务状态已变更，旧推荐已作废。',
          }
        }

        const keepGateClosed = (): void => {
          if (deps.gates.stateOf(agentId) !== 'closed') deps.gates.close(agentId)
        }

        const clarificationAnswers = (session.history ?? []).map((round) => round.answer)
        if (
          session.manualRequired
          || hasManualReviewSignal(session.task)
          || hasManualReviewSignal(requirements)
          || clarificationAnswers.some((entry) => hasManualReviewSignal(entry))
        ) {
          keepGateClosed()
          return {
            confirmed: false,
            released: false,
            reason: 'manual-confirmation-required',
            instructions: '用户要求人工确认或先看方案，不得按推荐自动放行。',
          }
        }

        if (!session.pendingRecommendations || !session.recommendationReady) {
          keepGateClosed()
          return {
            confirmed: false,
            released: false,
            reason: 'needs-clarification',
            instructions: '当前任务尚未经 grill_start 进入待评估推荐就绪态，不能直接推荐结算。',
          }
        }

        const combined = [session.task, ...clarificationAnswers].join('\n')
        const evaluated = judgeTask({ text: combined, mode: 'new-task', intensity: config.intensity, bypassKeywords: [] })
        if (evaluated.verdict !== 'clear') {
          keepGateClosed()
          return {
            confirmed: false,
            released: false,
            reason: 'needs-clarification',
            instructions: '任务仍缺关键事实，请先只问阻塞项，不能靠推荐跳过澄清。',
          }
        }

        if (!Array.isArray(args.recommendations)) {
          keepGateClosed()
          return {
            confirmed: false,
            released: false,
            reason: 'invalid-recommendation',
            instructions: 'recommendations 必须是非空推荐项数组。',
          }
        }

        const validation = validateRecommendationBatch({
          items: args.recommendations as RecommendationItem[],
          config,
          task: session.task,
          requirements,
          clarificationAnswers,
        })
        if (!validation.ok) {
          keepGateClosed()
          return {
            confirmed: false,
            released: false,
            reason: validation.reason,
            instructions: validation.message,
          }
        }

        deps.sessions.markSettled(agentId, reqTaskId, 'recommended')
        deps.sessions.end(agentId)
        deps.gates.open(agentId, 'recommended')
        const decisions = buildSafeAuditTokens(validation.applied).join(',')
        deps.logger?.warn?.(
          `[grill-first] 需求门禁已按推荐放行（decision=recommended, task_id=${reqTaskId}, mode=${config.recommendationMode}, decisions=${decisions}, agent=${agentId}）`,
        )
        return {
          confirmed: false,
          released: true,
          decision: 'recommended',
          task_id: reqTaskId,
          recommendation_mode: config.recommendationMode,
          applied: validation.applied,
          summary: validation.summary,
          final_requirements: requirements,
          instructions: buildDeliveryReminder(),
        }
      }

      if (args.decision_mode !== undefined && args.decision_mode !== 'manual') {
        return {
          confirmed: false,
          released: false,
          reason: 'invalid-recommendation',
          instructions: '不支持的 decision_mode，仅支持 manual 或 recommended。',
        }
      }

      const previousGateRevision = deps.gates.revisionOf(agentId)
      deps.gates.close(agentId)
      if (!deps.sessions.get(agentId)) {
        deps.sessions.start({ agentId, task: firstLine(requirements) || '待确认需求', mode: 'new-task', startedAt: Date.now() })
      }
      if (requirements.length > CARD_DETAIL_LIMIT) {
        return { confirmed: false, reason: 'requirements-too-long', instructions: `清单超过 ${CARD_DETAIL_LIMIT} 字，未展示也未授权。请先分段整理摘要，保留全部约束和验收条件，再提交完整四段清单确认。` }
      }
      if (exec?.signal?.aborted) return { confirmed: false, reason: 'confirmation-cancelled' }
      if (requirements === '') {
        return {
          confirmed: false,
          reason: 'empty-requirements',
          instructions: 'requirements 不能为空：请把四段式需求清单全文放进 requirements 参数，再调用一次。',
        }
      }

      const session = deps.sessions.get(agentId)
      const task = session?.task ?? firstLine(requirements)
      const sessionRevision = JSON.stringify(session)
      const gateRevision = deps.gates.revisionOf(agentId)
      const isCurrent = () => deps.gates.revisionOf(agentId) === gateRevision && deps.sessions.get(agentId) === session && JSON.stringify(session) === sessionRevision
      const stale = (): GrillConfirmResult => ({ confirmed: false, reason: 'stale-confirmation', instructions: '任务已经变化，请展示当前任务的清单重新确认。' })

      /** 确认后的原子结算与落库动作：先同步校验并结算放行，再落库历史 + 全局偏好 + 项目背景。 */
      const accept = async (channel: string): Promise<GrillConfirmResult> => {
        if (!isCurrent()) return stale()
        if (exec?.signal?.aborted) return { confirmed: false, reason: 'confirmation-cancelled' }
        const currentTaskId = session ? (session.taskId ?? `${agentId}:${session.startedAt}`) : ''
        if (currentTaskId) deps.sessions.markSettled(agentId, currentTaskId, 'manual')
        deps.sessions.end(agentId)
        deps.gates.open(agentId, 'manual')
        deps.logger?.warn?.(`[grill-first] 需求已确认（通道=${channel}，agent=${agentId}）`)

        const saved = { history: false, preferences: 0, project_context: false }
        if (config.memoryEnabled) {
          const root = deps.workspaceRoot(exec?.agent)
          try {
            const scope = deps.memoryScope?.() ?? 'project'
            await saveHistory(task, requirements, root, scope)
            saved.history = true
            for (const preference of preferences) {
              await savePreference(preference, ['用户确认'], root)
              saved.preferences += 1
            }
            const context = requirements.replace(/\s+/g, ' ').slice(0, PROJECT_CONTEXT_LIMIT)
            await saveProjectContext(context, root, scope)
            saved.project_context = true
          } catch (error) {
            deps.logger?.warn(
              `[grill-first] 写入记忆失败：${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        return { confirmed: true, final_requirements: requirements, instructions: buildDeliveryReminder(), saved }
      }

      // 兜底声明只在本任务的同一清单确实进入兜底流程后有效。
      const issued = fallback.get(agentId)
      if (args.confirmed === true && issued && issued.session === session && issued.revision === sessionRevision && issued.gateRevision === previousGateRevision && issued.requirements === requirements) {
        fallback.delete(agentId)
        return accept('agent-declared-fallback')
      }
      const issueFallback = () => fallback.set(agentId, { session, revision: sessionRevision, gateRevision, requirements })
      const questions = deps.questions()
      if (!questions || typeof questions.ask !== 'function') {
        issueFallback()
        return {
          confirmed: false,
          needs_user_confirmation: true,
          requirements,
          instructions:
            '当前没有可用的结构化提问通道：请用 ask_user_question 把需求清单展示给用户——question 只写一句 60 字以内的短标题（确认卡片标题栏不滚动，标题一长就会把选项区压得点不到），完整四段清单放进 detail 字段；得到明确同意后再调用 grill_confirm(confirmed:true)；用户要改则按意见修订后重新确认。',
        }
      }

      const request: AskUserQuestionRequest = {
        questions: [
          {
            id: 'grill-confirm',
            header: '需求确认',
            // 标题只放一句短说明，完整清单走 detail：标题在固定头部（不可滚动），长了会挤掉选项区。
            question: cardTitle(task),
            detail: cardDetail(requirements),
            options: [
              { label: '确认，按此开工', description: '按上面的清单开始执行' },
              { label: '要改', description: '我会说明需要修改的地方' },
            ],
            multiSelect: false,
          },
        ],
        ...(exec?.agent ? { agent: exec.agent } : {}),
        ...(exec?.signal ? { signal: exec.signal } : {}),
        ...(exec?.callId ? { wait: { callId: exec.callId } } : {}),
      }

      let answer: AskUserQuestionAnswer
      try {
        answer = await questions.ask(request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!isCurrent()) return stale()
        if (exec?.signal?.aborted) return { confirmed: false, reason: 'confirmation-cancelled' }
        issueFallback()
        return {
          confirmed: false,
          needs_user_confirmation: true,
          requirements,
          error: message,
          instructions:
            '结构化提问失败：请改用 ask_user_question 展示需求清单并请用户确认（同样要求：question 用 60 字以内的短标题，完整清单放 detail），用户同意后再调用 grill_confirm(confirmed:true)。',
        }
      }

      if (!isCurrent()) return stale()
      const item = answer?.answers?.find((entry) => entry.id === 'grill-confirm')
      const selected = Array.isArray(item?.selected) ? item.selected : []
      const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
      if (exec?.signal?.aborted) return { confirmed: false, reason: 'confirmation-cancelled' }
      const userConfirmed = answer?.answers?.length === 1 && selected.length === 1 && selected[0] === '确认，按此开工'

      if (userConfirmed) {
        const result = await accept('structured-question')
        return custom === '' ? result : { ...result, user_note: custom }
      }
      if (selected.length !== 1 || selected[0] !== '要改') {
        return { confirmed: false, reason: 'confirmation-not-received', needs_user_confirmation: true, requirements, instructions: '未收到有效确认，请重新展示完整清单并等待明确选择。' }
      }
      if (session) {
        session.gateRevision = gateRevision
        session.recommendationReady = false
      }
      const rounds = deps.sessions.get(agentId)?.rounds ?? 0
      const maxRounds = config.maxRounds
      const roundsLeft = Math.max(0, maxRounds - rounds)
      return {
        confirmed: false,
        requirements,
        feedback:
          custom !== ''
            ? custom
            : '用户选择了"要改"，但没有写明改哪里：请追问具体修改点，修订需求清单后再次调用 grill_confirm。',
        rounds_used: rounds,
        rounds_left: roundsLeft,
        ...(roundsLeft === 0
          ? {
              instructions: `已达追问轮数上限（${maxRounds} 轮）：按修改意见修订清单并标出假设，再调用 grill_confirm；确认前不得开工。`,
            }
          : {}),
      }
    },
  }
}
