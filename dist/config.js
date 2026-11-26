/**
 * 插件配置的类型定义与归一化。
 *
 * 这里刻意不 import Schemastery：单测可以直接引用本模块，
 * 只有 `configSchema.ts`（设置界面用的 schema）才依赖宿主提供的 `@deepseek-ai/schemastery`。
 */
import { DEFAULT_BYPASS_KEYWORDS } from './judge/heuristics.js';
/** 合法的开工决策模式列表。 */
export const RECOMMENDATION_MODES = ['manual', 'conservative', 'standard', 'custom', 'autonomous'];
/** 合法的推荐类别列表。 */
export const RECOMMENDATION_CATEGORIES = [
    'presentation',
    'draft_wording',
    'draft_label',
];
/** 默认配置（与工作表 3.7 的默认值一致）。 */
export const DEFAULT_CONFIG = {
    enabled: true,
    gateMode: 'warn',
    maxQuestionsPerRound: 3,
    maxRounds: 3,
    intensity: 'standard',
    bypassKeywords: [...DEFAULT_BYPASS_KEYWORDS],
    memoryEnabled: true,
    memoryScope: 'project',
    researchMode: 'auto',
    researchDepth: 'quick',
    recommendationMode: 'manual',
    recommendationCategories: [],
};
/** 取整并夹到 [min, max]；非法值返回 fallback。 */
function clampInt(value, min, max, fallback) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || !Number.isInteger(num))
        return fallback;
    return Math.min(max, Math.max(min, num));
}
/** 读布尔；非布尔返回 fallback。 */
function pickBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/** 读枚举；不在白名单内返回 fallback。 */
function pickEnum(value, allowed, fallback) {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}
/** 读字符串数组；接受单个字符串；非法返回 fallback。 */
function pickStringList(value, fallback) {
    if (typeof value === 'string') {
        const parts = value
            .split(/[,，\n]/)
            .map((item) => item.trim())
            .filter((item) => item !== '');
        return parts.length > 0 ? parts : [...fallback];
    }
    if (Array.isArray(value)) {
        const parts = value.filter((item) => typeof item === 'string' && item.trim() !== '');
        return parts.length > 0 ? parts : [...fallback];
    }
    return [...fallback];
}
/** 判断值是否为已知的推荐自动采用类别。 */
export function isKnownRecommendationCategory(value) {
    return typeof value === 'string' && RECOMMENDATION_CATEGORIES.includes(value);
}
/** 归一化推荐类别列表：仅保留已知类别、去重保序，非数组或缺失返回空数组。 */
function pickRecommendationCategories(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    for (const item of value) {
        if (isKnownRecommendationCategory(item)) {
            seen.add(item);
        }
    }
    return [...seen];
}
/**
 * 解析当前配置下实际生效的推荐类别列表。
 * 未知模式一律按空列表处理（fail-closed）。
 */
export function resolveEffectiveRecommendationCategories(config) {
    switch (config.recommendationMode) {
        case 'manual':
            return [];
        case 'conservative':
            return ['presentation'];
        case 'standard':
        case 'autonomous':
            return [...RECOMMENDATION_CATEGORIES];
        case 'custom':
            return pickRecommendationCategories(config.recommendationCategories);
        default:
            return [];
    }
}
/**
 * 把任意来源的配置归一化成合法配置（脏数据一律退回默认值，不抛错）。
 * @param raw 来自 cordis.yml / 设置界面的原始配置。
 */
export function normalizeConfig(raw) {
    const input = (raw ?? {});
    return {
        enabled: pickBoolean(input.enabled, DEFAULT_CONFIG.enabled),
        gateMode: pickEnum(input.gateMode, ['off', 'warn', 'strict', 'ask'], DEFAULT_CONFIG.gateMode),
        maxQuestionsPerRound: clampInt(input.maxQuestionsPerRound, 1, 6, DEFAULT_CONFIG.maxQuestionsPerRound),
        maxRounds: clampInt(input.maxRounds, 1, 10, DEFAULT_CONFIG.maxRounds),
        intensity: pickEnum(input.intensity, ['gentle', 'standard', 'grill'], DEFAULT_CONFIG.intensity),
        bypassKeywords: pickStringList(input.bypassKeywords, DEFAULT_CONFIG.bypassKeywords),
        memoryEnabled: pickBoolean(input.memoryEnabled, DEFAULT_CONFIG.memoryEnabled),
        memoryScope: pickEnum(input.memoryScope, ['project', 'global'], DEFAULT_CONFIG.memoryScope),
        researchMode: pickEnum(input.researchMode, ['off', 'auto', 'always'], DEFAULT_CONFIG.researchMode),
        researchDepth: pickEnum(input.researchDepth, ['quick', 'deep'], DEFAULT_CONFIG.researchDepth),
        recommendationMode: pickEnum(input.recommendationMode, RECOMMENDATION_MODES, DEFAULT_CONFIG.recommendationMode),
        recommendationCategories: pickRecommendationCategories(input.recommendationCategories),
    };
}
