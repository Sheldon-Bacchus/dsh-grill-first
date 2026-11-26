import { resolveEffectiveRecommendationCategories, } from '../config.js';
export const PROTOCOL_SECTION_NAME = 'dsh-grill-first:protocol';
export const PROTOCOL_SECTION_ORDER = 60;
export const PROTOCOL_CHAR_LIMIT = 900;
const INTENSITY_HINT = {
    gentle: '快速：只问影响执行的关键歧义。',
    standard: '标准：问清目标、范围、约束和验收。',
    grill: '深入：再核对边界、异常与取舍；不问无关细节。',
};
const RECOMMENDATION_MODE_LABEL = {
    manual: '手动',
    conservative: '保守',
    standard: '标准',
    custom: '自定义',
    autonomous: '全权自主',
};
const RECOMMENDATION_CATEGORY_LABEL = {
    presentation: '排版与格式',
    draft_wording: '非公开草稿措辞',
    draft_label: '非公开草稿显示名称',
};
export function protocolLength(text) { return text.replace(/\s+/g, '').length; }
const MAX_BYPASS_DISPLAY_ITEMS = 6;
const MAX_BYPASS_DISPLAY_CHARS = 36;
function formatBypassKeywords(keywords, maxChars = MAX_BYPASS_DISPLAY_CHARS) {
    const cleaned = [];
    const seen = new Set();
    for (const raw of keywords) {
        const trimmed = typeof raw === 'string' ? raw.trim() : '';
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        cleaned.push(trimmed);
    }
    if (cleaned.length === 0)
        return '直接做';
    const cap = Math.max(4, maxChars);
    const picked = [];
    let truncated = false;
    for (const word of cleaned) {
        if (picked.length >= MAX_BYPASS_DISPLAY_ITEMS) {
            truncated = true;
            break;
        }
        const candidate = [...picked, word].join('、');
        const hasMore = cleaned.length > picked.length + 1;
        const limit = hasMore ? cap - 1 : cap;
        if (protocolLength(candidate) <= limit) {
            picked.push(word);
        }
        else {
            if (picked.length === 0) {
                const sliceLen = Math.max(1, cap - 2);
                picked.push(`${word.slice(0, sliceLen)}…`);
            }
            truncated = true;
            break;
        }
    }
    return truncated ? `${picked.join('、')}等` : picked.join('、');
}
function buildRecommendationSection(mode, categories) {
    const effective = resolveEffectiveRecommendationCategories({
        recommendationMode: mode,
        recommendationCategories: [...categories],
    });
    if (effective.length === 0)
        return '';
    const modeLabel = RECOMMENDATION_MODE_LABEL[mode] ?? mode;
    const categoryText = effective
        .map((category) => RECOMMENDATION_CATEGORY_LABEL[category] ?? category)
        .join('、');
    return [
        `【推荐决策（${modeLabel}/${mode}；类别：${categoryText}）】`,
        '- 含低风险表达层待决项时调 grill_start(..., pending_recommendations: true)；用户要求人工优先人工；缺事实只问阻塞项，不把推荐写进 answer_summary。',
        '- 返回 reason:"recommendations-pending" 时（区别于普通 needs-clarification），不要调 ask_user_question，直接调 grill_confirm(decision_mode:"recommended", task_id, task_version, requirements, recommendations) 结算放行。',
        '- 交付时一句说明自动采用项；无则不加；不替代工具审批或 Team/Sub 派发确认。',
    ].join('\n');
}
function trimToProtocolLimit(text, limit) {
    if (protocolLength(text) <= limit)
        return text;
    let nonWs = 0;
    let cut = text.length;
    for (let i = 0; i < text.length; i += 1) {
        if (!/\s/.test(text[i])) {
            nonWs += 1;
            if (nonWs >= limit) {
                cut = i + 1;
                break;
            }
        }
    }
    return text.slice(0, cut).trimEnd();
}
export function buildProtocolText(options) {
    if (options.recommendationMode === 'autonomous') {
        return [
            '【开工决策（全权自主/autonomous）】',
            '1. 用户已授权由你全权自主决定执行方案，无需先调 grill_start/grill_confirm，也无需为方案、排版或派发停下追问或弹确认卡。',
            '2. 你可自主决定直接执行、开 Sub 或开 Team，按任务复杂度自行决策并直接推进。',
            '3. 仅当缺少无法从上下文推断的外部信息（如未知凭据、外部收件人），或用户本轮明确要求“先给方案等我确认”时，再简短询问。',
        ].join('\n');
    }
    const research = options.researchMode === 'off' ? '' : options.researchMode === 'always'
        ? '7. 需求确认后调用 grill_research 获取调研指引，调研后再建议；不可用时说明限制。'
        : '7. 需求确认后，涉及外部事实或选型时按需调用 grill_research 获取调研指引，再给建议；不可用时说明限制。';
    const recommendation = buildRecommendationSection(options.recommendationMode ?? 'manual', options.recommendationCategories ?? []);
    const compose = (bypass) => [
        '【开工前提问协议（grill-first）】',
        '1. 新任务先调 grill_start；clear 可开工。纯咨询先直接回答；咨询与“继续”不等于确认待办任务。',
        `2. needs-clarification 时用 ask_user_question，结合 memory_context 与已有答案，只问尚不明确且影响方案的问题；不重复询问已知偏好。每轮最多 ${options.maxQuestionsPerRound} 问，最多 ${options.maxRounds} 轮，不凑数。${INTENSITY_HINT[options.intensity]}`,
        '3. 每轮回答后调 grill_start(mode:"continue")，提交 answer_summary 与 asked_dimensions 记录实际问答，再根据答案收敛。',
        '4. 问清或达到上限就停止追问，整理目标/范围/约束/验收标准四段，标明假设并调用 grill_confirm。要改就修订再确认，不计追问轮数；失败、取消、无回答均不放行。',
        '5. 未确认前不动文件或运行变更命令。清单过长先分段摘要，不得截断后授权。',
        `6. 用户明确要求「${bypass}」时停止提问并开工；新任务用 new-task，目标/范围大改用 drift-check，轮数重置。`,
        research,
        recommendation,
    ].filter(Boolean).join('\n');
    const remainingForBypass = PROTOCOL_CHAR_LIMIT - protocolLength(compose(''));
    const bypassBudget = Math.max(4, Math.min(MAX_BYPASS_DISPLAY_CHARS, remainingForBypass));
    const bypass = formatBypassKeywords(options.bypassKeywords, bypassBudget);
    return trimToProtocolLimit(compose(bypass), PROTOCOL_CHAR_LIMIT);
}
