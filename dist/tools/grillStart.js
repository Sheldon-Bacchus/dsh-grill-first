/**
 * `grill_start` 工具（R1/R2/R4/R6）：开工前判定任务是否已经说清楚。
 *
 * - clear：放行（门禁置 open），模型直接开工；
 * - needs-clarification：门禁置 closed，并返回记忆摘要、追问方向与轮次上限。
 */
import { RECOMMENDATION_CATEGORIES, resolveEffectiveRecommendationCategories, } from '../config.js';
import { buildFocusHints, detectDimensions, judgeTask } from '../judge/heuristics.js';
import { loadMemory, summarize } from '../memory/store.js';
import { buildDispatchReminder } from '../prompt/reminders.js';
import { hasManualReviewSignal } from '../recommendation.js';
import { PLUGIN_VERSION } from '../version.js';
/** 把对象包成"回灌给模型的文本块"。 */
export function textOutput(schema) {
    return {
        schema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    };
}
/** grill_start 的参数 schema。 */
const PARAMETERS = {
    type: 'object',
    properties: {
        task: {
            type: 'string',
            description: '新任务/变更时传用户任务原文；continue 时传当前任务原文，上一轮答案另放 answer_summary。',
        },
        mode: {
            type: 'string',
            enum: ['new-task', 'drift-check', 'continue'],
            description: 'new-task（默认）开始独立任务；drift-check 重置变更后的任务；continue 记录当前任务一轮问答并重新评估。',
        },
        answer_summary: { type: 'string', maxLength: 4000, description: 'continue 时填写上一轮用户答案摘要，与 asked_dimensions 同传；不要把假设写成用户答案。' },
        asked_dimensions: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['goal', 'scope', 'constraint', 'acceptance'] }, description: '上一轮实际问过的维度；仅与非空 answer_summary 一起提交才计一轮。' },
        pending_recommendations: { type: 'boolean', description: '存在属于低风险表达层且待评估的推荐决定时传 true；启用推荐模式时会保持任务与关闭的门禁，供 grill_confirm 独立推荐结算。' },
    },
    required: ['task'],
    additionalProperties: false,
};
/** grill_start 的返回 schema（宽松描述，host 只做展示与校验兜底）。 */
const OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: ['clear', 'needs-clarification'] },
        skip: { type: 'boolean', description: 'true=无需提问，直接开工' },
        reason: { type: 'string' },
        score: { type: 'number', description: '需求完整度打分（0-100）' },
        memory_context: { type: 'string', description: '两层记忆的紧凑摘要，可先向用户呈现' },
        focus_hints: { type: 'array', items: { type: 'string' }, description: '建议的追问方向' },
        gate_state: { type: 'string', enum: ['open', 'closed'] },
        max_rounds: { type: 'number' },
        max_questions_per_round: { type: 'number' },
        intensity: { type: 'string' },
        mode: { type: 'string' },
        task_id: { type: 'string' },
        task_version: { type: 'number' },
        recommendation_mode: { type: 'string' },
        effective_recommendation_categories: { type: 'array', items: { type: 'string' } },
        recommendation_eligible: { type: 'boolean' },
        previous_task: { type: 'string' },
        hint: { type: 'string' },
        rounds_used: { type: 'number', description: '已经追问过的轮数' },
        version: { type: 'string', description: '运行中的插件版本；若缺失说明宿主加载的是旧版代码，需重启 DSH' },
    },
    additionalProperties: true,
};
/**
 * 创建 `grill_start` 工具定义。
 * @param deps 配置读取、门禁表、会话表、工作区根目录。
 */
export function createGrillStartTool(deps) {
    return {
        name: 'grill_start',
        description: '开工前的需求判定（grill-first 插件）。任何新任务开始前先调用一次，把任务原文传进来：返回 verdict=clear 就直接开工；返回 needs-clarification 就按 focus_hints 用 ask_user_question 多轮追问，问清后用 grill_confirm 请用户确认。',
        parameters: PARAMETERS,
        output: textOutput(OUTPUT_SCHEMA),
        isConcurrencySafe: () => false,
        async execute(rawArgs, exec) {
            const args = (rawArgs ?? {});
            const config = deps.config();
            const agentId = exec?.agent?.id ?? '';
            const task = typeof args.task === 'string' ? args.task.trim() : '';
            const mode = args.mode === 'continue' ? 'continue' : args.mode === 'drift-check' ? 'drift-check' : 'new-task';
            if (!config.enabled) {
                return { verdict: 'clear', skip: true, reason: 'disabled', version: PLUGIN_VERSION };
            }
            if (config.recommendationMode === 'autonomous') {
                deps.sessions.end(agentId);
                deps.gates.open(agentId, 'autonomous');
                return {
                    verdict: 'clear',
                    skip: true,
                    reason: 'autonomous-mode',
                    gate_state: 'open',
                    mode,
                    recommendation_mode: 'autonomous',
                    effective_recommendation_categories: [...RECOMMENDATION_CATEGORIES],
                    recommendation_eligible: true,
                    hint: '当前为全权自主模式（autonomous）：无需追问或弹确认卡，由你直接决定方案并自由选择直接执行、开 Sub 或开 Team。',
                    version: PLUGIN_VERSION,
                };
            }
            if (task === '') {
                return {
                    verdict: 'needs-clarification',
                    skip: false,
                    reason: 'empty-task',
                    focus_hints: ['task 为空：请把用户的原话或任务摘要原样传进来，再调用一次 grill_start。'],
                    hint: '缺少 task 参数。',
                    version: PLUGIN_VERSION,
                };
            }
            const effectiveCategories = [...resolveEffectiveRecommendationCategories(config)];
            const judged = judgeTask({
                text: mode === 'continue' && typeof args.answer_summary === 'string' ? `${task}\n${args.answer_summary}` : task,
                mode: mode === 'continue' ? 'new-task' : mode,
                bypassKeywords: config.bypassKeywords,
                intensity: config.intensity,
            });
            const previous = deps.sessions.get(agentId);
            // drift-check 是用户显式切换任务：必须重置会话，不能被 inquiry/follow-up 判定保留旧任务。
            const preserving = !!previous && mode !== 'drift-check' && (mode === 'continue' || judged.reason === 'follow-up' || judged.reason === 'inquiry');
            if (mode === 'continue') {
                if (!previous) {
                    if (deps.gates.stateOf(agentId) !== 'closed')
                        deps.gates.close(agentId);
                    return {
                        verdict: 'needs-clarification',
                        skip: false,
                        reason: 'no-active-task',
                        gate_state: 'closed',
                        hint: '没有待澄清任务，请用 new-task 提交任务原文。',
                        version: PLUGIN_VERSION,
                    };
                }
                if (previous.gateRevision !== undefined && deps.gates.revisionOf(agentId) !== previous.gateRevision) {
                    deps.sessions.end(agentId);
                    if (deps.gates.stateOf(agentId) !== 'closed')
                        deps.gates.close(agentId);
                    return {
                        verdict: 'needs-clarification',
                        skip: false,
                        reason: 'stale-task',
                        gate_state: 'closed',
                        hint: '原任务已被新消息或变更打断，旧澄清已作废；请用 mode:"new-task" 或 "drift-check" 重新开始。',
                        version: PLUGIN_VERSION,
                    };
                }
            }
            const pendingRecommendations = args.pending_recommendations === true
                ? true
                : args.pending_recommendations === false
                    ? false
                    : (preserving && Boolean(previous?.pendingRecommendations));
            const manualRequired = hasManualReviewSignal(task)
                || (mode === 'continue' && typeof args.answer_summary === 'string' && hasManualReviewSignal(args.answer_summary))
                || (preserving && Boolean(previous?.manualRequired))
                || (preserving && (previous?.history ?? []).some((round) => hasManualReviewSignal(round.answer)));
            const manualGateRequired = manualRequired
                && judged.reason !== 'bypass-keyword'
                && judged.reason !== 'inquiry'
                && judged.reason !== 'follow-up';
            const recommendationActive = pendingRecommendations
                && config.recommendationMode !== 'manual'
                && effectiveCategories.length > 0
                && judged.reason !== 'bypass-keyword'
                && judged.reason !== 'inquiry'
                && judged.reason !== 'follow-up';
            if (!recommendationActive && !manualGateRequired && judged.verdict === 'clear' && (!preserving || judged.reason === 'bypass-keyword')) {
                deps.sessions.end(agentId);
                deps.gates.open(agentId, 'clear');
                return {
                    verdict: 'clear',
                    skip: true,
                    reason: judged.reason,
                    score: judged.score,
                    gate_state: 'open',
                    mode,
                    recommendation_mode: config.recommendationMode,
                    effective_recommendation_categories: effectiveCategories,
                    recommendation_eligible: false,
                    hint: buildDispatchReminder(),
                    version: PLUGIN_VERSION,
                };
            }
            const startedAt = preserving ? previous.startedAt : Date.now();
            let activeSession = preserving ? previous : undefined;
            if (!preserving) {
                activeSession = deps.sessions.start({
                    agentId,
                    task,
                    mode: mode === 'drift-check' ? mode : 'new-task',
                    startedAt,
                    rounds: 0,
                    pendingRecommendations,
                    recommendationReady: false,
                    manualRequired,
                });
                deps.gates.close(agentId);
            }
            else if (deps.gates.stateOf(agentId) !== 'closed') {
                deps.gates.close(agentId);
            }
            const answer = typeof args.answer_summary === 'string' ? args.answer_summary.trim() : '';
            const keys = ['goal', 'scope', 'constraint', 'acceptance'];
            const asked = Array.isArray(args.asked_dimensions)
                ? keys.filter((key) => args.asked_dimensions instanceof Array && args.asked_dimensions.includes(key)) : [];
            if (mode === 'continue' && (answer.length > 4000 || (!!answer !== (asked.length > 0)))) {
                const currentRevision = deps.gates.revisionOf(agentId);
                if (previous) {
                    previous.gateRevision = currentRevision;
                    previous.recommendationReady = false;
                }
                return {
                    verdict: 'needs-clarification',
                    skip: false,
                    reason: 'invalid-continuation',
                    gate_state: 'closed',
                    task_id: previous?.taskId ?? `${agentId}:${startedAt}`,
                    task_version: currentRevision,
                    recommendation_mode: config.recommendationMode,
                    effective_recommendation_categories: effectiveCategories,
                    recommendation_eligible: false,
                    hint: '答案摘要须不超过4000字，并与上一轮实际提问维度同时提供；未记录本轮。',
                    version: PLUGIN_VERSION,
                };
            }
            if (mode === 'continue')
                deps.sessions.recordAnswer(agentId, answer, asked, config.maxRounds);
            const gateRevision = deps.gates.revisionOf(agentId);
            const session = deps.sessions.get(agentId);
            if (session) {
                session.pendingRecommendations = pendingRecommendations;
                session.manualRequired = manualRequired;
                session.gateRevision = gateRevision;
                session.recommendationReady = false;
            }
            const roundsUsed = session?.rounds ?? 0;
            const combined = [session?.task ?? task, ...(session?.history ?? []).map((round) => round.answer)].join('\n');
            const evaluated = judgeTask({ text: combined, mode: 'new-task', intensity: config.intensity, bypassKeywords: [] });
            const atLimit = roundsUsed >= config.maxRounds;
            const unresolvedBlocker = evaluated.verdict !== 'clear' || (judged.verdict !== 'clear' && mode !== 'continue');
            const ready = (preserving && evaluated.verdict === 'clear') || (manualGateRequired && !unresolvedBlocker);
            const recommendationEligible = recommendationActive && !unresolvedBlocker && !manualRequired;
            const dimensions = detectDimensions(combined);
            const focus = (recommendationActive ? (!unresolvedBlocker || atLimit) : (atLimit || ready))
                ? []
                : buildFocusHints(dimensions, [], session?.task ?? task);
            const revBeforeAwait = deps.gates.revisionOf(agentId);
            const sessionBeforeAwait = session;
            let memoryContext = '';
            if (config.memoryEnabled) {
                try {
                    memoryContext = summarize(await loadMemory(deps.workspaceRoot(exec?.agent), (deps.memoryScope?.() ?? 'project')));
                }
                catch (error) {
                    deps.logger?.warn(`[grill-first] 读取记忆失败：${error instanceof Error ? error.message : String(error)}`);
                    memoryContext = '';
                }
            }
            const currentGateRevision = deps.gates.revisionOf(agentId);
            if (currentGateRevision !== revBeforeAwait || deps.sessions.get(agentId) !== sessionBeforeAwait) {
                if (sessionBeforeAwait)
                    sessionBeforeAwait.recommendationReady = false;
                return {
                    verdict: 'needs-clarification',
                    skip: false,
                    reason: 'stale-task',
                    gate_state: deps.gates.stateOf(agentId),
                    recommendation_mode: config.recommendationMode,
                    effective_recommendation_categories: effectiveCategories,
                    recommendation_eligible: false,
                    hint: '读取记忆期间任务已变更或被新消息打断，本次判定已作废；请针对当前任务重新调用 grill_start。',
                    version: PLUGIN_VERSION,
                };
            }
            if (session) {
                session.recommendationReady = recommendationEligible;
            }
            let reason;
            let bodyHint;
            let confirmationRequired = true;
            if (recommendationActive) {
                if (unresolvedBlocker) {
                    if (atLimit) {
                        reason = 'max-rounds-reached';
                        bodyHint = '停止追问，把需求及尚未验证的假设整理成四段清单，调用 grill_confirm；确认前不得开工。';
                    }
                    else {
                        reason = mode === 'drift-check' ? judged.reason : evaluated.reason;
                        bodyHint = '只问缺关键事实的阻塞项，不要对已启用的低风险类别重复提问，不要把推荐写进 answer_summary。结合已知偏好和已有答案，只问仍影响方案的歧义；问题数是上限，不必凑数。每轮回答后用 continue 记录答案摘要与实际问过的维度。';
                    }
                }
                else if (manualRequired) {
                    reason = 'confirmation-required';
                    bodyHint = '用户要求人工确认或先看方案，不得按推荐自动放行；请整理目标/范围/约束/验收标准四段清单并调用人工 grill_confirm（不要传 decision_mode:"recommended"）。';
                }
                else {
                    reason = 'recommendations-pending';
                    bodyHint = '当前任务无未解阻塞且存在待评估推荐决定，请直接调用 grill_confirm(decision_mode:"recommended", task_id, task_version, requirements, recommendations) 进行无卡推荐结算；不要把推荐写进 answer_summary。若存在超出已启用类别或无法满足封闭决策校验的决定，请改为人工 grill_confirm。';
                    confirmationRequired = false;
                }
            }
            else {
                reason = atLimit
                    ? 'max-rounds-reached'
                    : ready
                        ? 'confirmation-required'
                        : preserving
                            ? 'clarification-pending'
                            : judged.reason;
                bodyHint = judged.reason === 'inquiry' && preserving
                    ? '先回答当前咨询，再回到待确认任务；咨询不代表同意开工。'
                    : manualGateRequired && !unresolvedBlocker
                        ? '用户要求人工确认或先看方案，请整理目标/范围/约束/验收标准四段清单并调用人工 grill_confirm；确认前不得开工。'
                        : atLimit || ready || focus.length === 0
                            ? '停止追问，把需求及尚未验证的假设整理成四段清单，调用 grill_confirm；确认前不得开工。'
                            : '结合已知偏好和已有答案，只问仍影响方案的歧义；问题数是上限，不必凑数。每轮回答后用 continue 记录答案摘要与实际问过的维度。';
            }
            const taskId = session?.taskId ?? activeSession?.taskId ?? `${agentId}:${startedAt}`;
            return {
                verdict: 'needs-clarification',
                skip: false,
                reason,
                score: evaluated.score,
                memory_context: memoryContext,
                focus_hints: focus,
                hint: `${bodyHint}\n\n${buildDispatchReminder()}`,
                gate_state: 'closed',
                max_rounds: config.maxRounds,
                max_questions_per_round: config.maxQuestionsPerRound,
                intensity: config.intensity,
                mode,
                task_id: taskId,
                task_version: currentGateRevision,
                recommendation_mode: config.recommendationMode,
                effective_recommendation_categories: effectiveCategories,
                recommendation_eligible: recommendationEligible,
                rounds_used: roundsUsed,
                clarification_history: session?.history ?? [],
                confirmation_required: confirmationRequired,
                version: PLUGIN_VERSION,
                ...(previous?.task ? { previous_task: previous.task } : {}),
            };
        },
    };
}
