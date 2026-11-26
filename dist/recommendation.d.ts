/**
 * 推荐自动采用校验与摘要生成（纯函数模块，无宿主依赖）。
 *
 * 严格执行 fail-closed 原则：未知键、未启用类别、非封闭排版枚举、越权动作、
 * 任务/清单高风险上下文、语义越界或人工确认信号一律拒绝放行；
 * 错误文案与审计令牌不回显或泄漏不可信输入与草稿内容。
 */
import { type GrillConfig, type RecommendationCategory } from './config.js';
/** 封闭的推荐决策类型。 */
export type RecommendationDecisionType = 'presentation.report_layout' | 'presentation.field_arrangement' | 'presentation.section_format' | 'draft_wording.title' | 'draft_wording.heading' | 'draft_wording.phrasing' | 'draft_label.display_title' | 'draft_label.draft_name';
/** 每个 decision_type 唯一映射到所属类别。 */
export declare const DECISION_TYPE_CATEGORY: Record<RecommendationDecisionType, RecommendationCategory>;
/** 排版类决策允许的封闭选项 ID 集合（禁止自由文本选项 ID）。 */
export declare const CLOSED_PRESENTATION_OPTIONS: Partial<Record<RecommendationDecisionType, ReadonlySet<string>>>;
/** 推荐可选项。 */
export interface RecommendationOption {
    id: string;
    label: string;
}
/** 单条推荐决策输入项。 */
export interface RecommendationItem {
    id: string;
    category: string;
    decision_type: string;
    options: RecommendationOption[];
    recommended_option_id: string;
    reason: string;
    impact: string;
}
/** 校验通过后已采纳的推荐项。 */
export interface AppliedRecommendation {
    id: string;
    category: RecommendationCategory;
    decision_type: RecommendationDecisionType;
    option_id: string;
    option_label: string;
    reason: string;
    impact: string;
}
/** 推荐批次校验结果。 */
export type RecommendationValidationResult = {
    ok: true;
    applied: AppliedRecommendation[];
    summary: string;
} | {
    ok: false;
    reason: 'recommendation-mode-disabled' | 'category-not-enabled' | 'unknown-category' | 'invalid-decision-type' | 'invalid-recommendation' | 'policy-blocked' | 'manual-confirmation-required';
    message: string;
};
/** 识别用户是否显式要求人工确认、先看方案或不要代选。 */
export declare function hasManualReviewSignal(text: string): boolean;
/** 将已自动采用的推荐项格式化为简洁中文说明；空数组返回空串。 */
export declare function formatAppliedSummary(applied: readonly AppliedRecommendation[]): string;
/**
 * 构造不泄漏自由文本草稿内容的安全审计令牌：
 * 仅对处于封闭枚举内的 presentation 选项输出 `decision_type:option_id`，
 * 其余草稿类别仅记录封闭的 `decision_type`。
 */
export declare function buildSafeAuditTokens(applied: readonly AppliedRecommendation[]): string[];
/** 校验一批推荐项是否满足配置、结构、闭集与安全策略，全部通过才放行。 */
export declare function validateRecommendationBatch(input: {
    items: unknown;
    config: Pick<GrillConfig, 'recommendationMode' | 'recommendationCategories'>;
    task: string;
    requirements: string;
    clarificationAnswers?: readonly string[];
}): RecommendationValidationResult;
