/** 门禁档位：off=不拦截、warn=只记录、strict=拦截变更类工具、ask=先弹卡片问用户。 */
export type GateMode = 'off' | 'warn' | 'strict' | 'ask';
/** 项目层记忆的落点：project=跟着当前工作区走、global=全局共享一份。 */
export type MemoryScope = 'project' | 'global';
/** 追问力度。 */
export type Intensity = 'gentle' | 'standard' | 'grill';
/** 开工决策的推荐自动采用模式：manual=全人工、conservative=仅排版、standard=排版+草稿措辞/名称、custom=自定义类别、autonomous=全权自主（含自由开 Sub/Team）。 */
export type RecommendationMode = 'manual' | 'conservative' | 'standard' | 'custom' | 'autonomous';
/** 允许配置自动采用推荐的封闭类别。 */
export type RecommendationCategory = 'presentation' | 'draft_wording' | 'draft_label';
/** 合法的开工决策模式列表。 */
export declare const RECOMMENDATION_MODES: readonly RecommendationMode[];
/** 合法的推荐类别列表。 */
export declare const RECOMMENDATION_CATEGORIES: readonly RecommendationCategory[];
/** 归一化后的插件配置。 */
export interface GrillConfig {
    /** 总开关（R4）：false 时任何任务都不触发提问，也不拦截。 */
    enabled: boolean;
    /** 门禁档位。 */
    gateMode: GateMode;
    /** 每轮最多问几个问题（R2）。 */
    maxQuestionsPerRound: number;
    /** 最多追问几轮（R2）。 */
    maxRounds: number;
    /** 追问力度。 */
    intensity: Intensity;
    /** 跳过关键词（R4）。 */
    bypassKeywords: string[];
    /** 是否启用两层记忆（R5）。 */
    memoryEnabled: boolean;
    /** 项目层记忆落在哪里（0.1.4 新增：有些项目不想被写进 .dsh/）。 */
    memoryScope: MemoryScope;
    researchMode: 'off' | 'auto' | 'always';
    researchDepth: 'quick' | 'deep';
    /** 开工决策推荐模式（默认 manual，未知值回退 manual）。 */
    recommendationMode: RecommendationMode;
    /** 自定义模式下允许自动采用推荐的类别列表（仅 custom 模式生效）。 */
    recommendationCategories: RecommendationCategory[];
}
/** 默认配置（与工作表 3.7 的默认值一致）。 */
export declare const DEFAULT_CONFIG: GrillConfig;
/** 判断值是否为已知的推荐自动采用类别。 */
export declare function isKnownRecommendationCategory(value: unknown): value is RecommendationCategory;
/**
 * 解析当前配置下实际生效的推荐类别列表。
 * 未知模式一律按空列表处理（fail-closed）。
 */
export declare function resolveEffectiveRecommendationCategories(config: Pick<GrillConfig, 'recommendationMode' | 'recommendationCategories'>): RecommendationCategory[];
/**
 * 把任意来源的配置归一化成合法配置（脏数据一律退回默认值，不抛错）。
 * @param raw 来自 cordis.yml / 设置界面的原始配置。
 */
export declare function normalizeConfig(raw: unknown): GrillConfig;
