/**
 * 设置界面用的配置 schema（7 个配置项，工作表 3.7）。
 *
 * Schemastery 由 DSH 宿主提供：这里声明为 `peerDependencies`（与已装插件 dsh-univer-office 一致——
 * 它的入口 `lib/index.js` 顶部就是 `import z from "@deepseek-ai/schemastery"`）。
 * 开发期从 npm 安装同版本（`@deepseek-ai/schemastery@3.18.4`）以拿到真实类型，不再手写占位声明。
 * 故意与 `config.ts` 分开：本文件是唯一依赖宿主的模块，单测只引 `config.ts`。
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BYPASS_KEYWORDS } from './judge/heuristics.js'

/** 门禁档位 schema。 */
const gateModeSchema = z
  .union([z.const('off'), z.const('warn'), z.const('strict'), z.const('ask')])
  .default('warn')

/** 追问力度 schema。 */
const intensitySchema = z.union([z.const('gentle'), z.const('standard'), z.const('grill')]).default('standard')

/** 开工决策推荐模式 schema。 */
const recommendationModeSchema = z
  .union([z.const('manual'), z.const('conservative'), z.const('standard'), z.const('custom'), z.const('autonomous')])
  .default('manual')

/** 开工决策推荐类别 schema。 */
const recommendationCategorySchema = z.union([
  z.const('presentation'),
  z.const('draft_wording'),
  z.const('draft_label'),
])

/** 插件配置 schema：改了这里，设置界面与 cordis.yml 校验同时生效。 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关闭后任何任务都不再追问，也不拦截工具。'),
  gateMode: gateModeSchema.description(
    '门禁档位：off 不拦截 / warn 只记录 / strict 未确认需求前拦截写类工具 / ask 拦截前先弹卡片问一句。',
  ),
  maxQuestionsPerRound: z
    .natural()
    .max(6)
    .default(3)
    .description('每轮最多问几个问题（1-6）。'),
  maxRounds: z.natural().max(10).default(3).description('最多追问几轮（1-10）。'),
  intensity: intensitySchema.description('追问力度：gentle 快速（关键歧义）/ standard 标准（主流程与验收）/ grill 深入（重要边界与异常）。'),
  bypassKeywords: z
    .array(z.string())
    .default([...DEFAULT_BYPASS_KEYWORDS])
    .description('跳过关键词：用户消息里出现这些词就不再追问，直接开工。'),
  researchMode: z.union([z.const('off'), z.const('auto'), z.const('always')]).default('auto')
    .description('GitHub 调研：off 关闭 / auto 按软件任务需要 / always 对适用任务主动调研；不会自动安装候选库。'),
  researchDepth: z.union([z.const('quick'), z.const('deep')]).default('quick')
    .description('调研深度：quick 快速比较 / deep 补充 README、许可证与版本证据。'),
  memoryEnabled: z.boolean().default(true).description('是否启用两层记忆（全局偏好 + 项目背景/历史）。'),
  memoryScope: z
    .union([z.const('project'), z.const('global')])
    .default('project')
    .description('项目层记忆落点：project 写进当前工作区的 .dsh/grill-first/，global 写进插件家目录。'),
  recommendationMode: recommendationModeSchema.description(
    '开工决策：manual 手动 / conservative 保守（排版与格式）/ standard 标准（排版与格式、非公开草稿措辞、非公开草稿显示名称）/ custom 自定义（仅选中的类别；全不勾选就不代选）/ autonomous 全权自主（由模型直接决定方案并自由开 Sub/Team，不弹确认卡）。',
  ),
  recommendationCategories: z
    .array(recommendationCategorySchema)
    .default([])
    .description(
      '自定义允许代选类别（仅自定义模式生效，默认全不选）：presentation 排版与格式 / draft_wording 非公开草稿措辞 / draft_label 非公开草稿显示名称。',
    ),
})
