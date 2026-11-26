/**
 * 推荐自动采用校验与摘要生成（纯函数模块，无宿主依赖）。
 *
 * 严格执行 fail-closed 原则：未知键、未启用类别、非封闭排版枚举、越权动作、
 * 任务/清单高风险上下文、语义越界或人工确认信号一律拒绝放行；
 * 错误文案与审计令牌不回显或泄漏不可信输入与草稿内容。
 */
import {
  isKnownRecommendationCategory,
  resolveEffectiveRecommendationCategories,
  type GrillConfig,
  type RecommendationCategory,
} from './config.js'

/** 封闭的推荐决策类型。 */
export type RecommendationDecisionType =
  | 'presentation.report_layout'
  | 'presentation.field_arrangement'
  | 'presentation.section_format'
  | 'draft_wording.title'
  | 'draft_wording.heading'
  | 'draft_wording.phrasing'
  | 'draft_label.display_title'
  | 'draft_label.draft_name'

/** 每个 decision_type 唯一映射到所属类别。 */
export const DECISION_TYPE_CATEGORY: Record<RecommendationDecisionType, RecommendationCategory> = {
  'presentation.report_layout': 'presentation',
  'presentation.field_arrangement': 'presentation',
  'presentation.section_format': 'presentation',
  'draft_wording.title': 'draft_wording',
  'draft_wording.heading': 'draft_wording',
  'draft_wording.phrasing': 'draft_wording',
  'draft_label.display_title': 'draft_label',
  'draft_label.draft_name': 'draft_label',
}

/** 排版类决策允许的封闭选项 ID 集合（禁止自由文本选项 ID）。 */
export const CLOSED_PRESENTATION_OPTIONS: Partial<Record<RecommendationDecisionType, ReadonlySet<string>>> = {
  'presentation.report_layout': new Set(['table', 'list', 'outline', 'cards', 'sections']),
  'presentation.field_arrangement': new Set(['grouped', 'flat', 'priority', 'chronological', 'key_value']),
  'presentation.section_format': new Set(['headings', 'bullets', 'numbered', 'summary_first', 'detail_first']),
}

/** 推荐可选项。 */
export interface RecommendationOption {
  id: string
  label: string
}

/** 单条推荐决策输入项。 */
export interface RecommendationItem {
  id: string
  category: string
  decision_type: string
  options: RecommendationOption[]
  recommended_option_id: string
  reason: string
  impact: string
}

/** 校验通过后已采纳的推荐项。 */
export interface AppliedRecommendation {
  id: string
  category: RecommendationCategory
  decision_type: RecommendationDecisionType
  option_id: string
  option_label: string
  reason: string
  impact: string
}

/** 推荐批次校验结果。 */
export type RecommendationValidationResult =
  | { ok: true; applied: AppliedRecommendation[]; summary: string }
  | {
      ok: false
      reason:
        | 'recommendation-mode-disabled'
        | 'category-not-enabled'
        | 'unknown-category'
        | 'invalid-decision-type'
        | 'invalid-recommendation'
        | 'policy-blocked'
        | 'manual-confirmation-required'
      message: string
    }

const MAX_BATCH_ITEMS = 10
const MAX_OPTIONS_PER_ITEM = 20
const MAX_ID_LENGTH = 128
const MAX_OPTION_LABEL_LENGTH = 120
const MAX_TEXT_LENGTH = 1000

const ALLOWED_ITEM_KEYS = new Set([
  'id',
  'category',
  'decision_type',
  'options',
  'recommended_option_id',
  'reason',
  'impact',
])

const ALLOWED_OPTION_KEYS = new Set(['id', 'label'])

const POLICY_ESCAPE_KEYS = new Set([
  'path',
  'filepath',
  'file_path',
  'command',
  'cmd',
  'tool',
  'tools',
  'permission',
  'permissions',
  'lowrisk',
  'low_risk',
  'blockers',
  'action',
  'exec',
  'script',
  'url',
  'target',
  'cwd',
  'workspace',
  'recipient',
  'recipients',
  'confirm',
  'confirmed',
  'approve',
  'approved',
  'autoapprove',
  'auto_approve',
])

const MANUAL_REVIEW_PATTERNS: readonly RegExp[] = [
  /先看方案/,
  /逐项确认/,
  /逐个确认/,
  /一一确认/,
  /手动确认/,
  /人工确认/,
  /弹窗确认/,
  /弹卡确认/,
  /(?:不要|别|不用|禁止|请勿)代选/,
  /(?:不要|别|不用)自动选/,
  /(?:不要|别|不用)替我选/,
  /(?:我要|让我|由我|我)自己选/,
  /给我确认/,
  /先(?:让|给)我看/,
  /确认后再/,
  /\breview\s+first\b/i,
  /\bconfirm\s+each\b/i,
  /\bmanual(?:ly)?\s+confirm(?:ation)?\b/i,
  /\b(?:do\s+not|don't)\s+auto[- ]?select\b/i,
  /\blet\s+me\s+choose\b/i,
  /\bchoose\s+(?:it\s+)?myself\b/i,
  /\bask\s+me\s+first\b/i,
]

const NEGATED_CONFIRM_PATTERN = /(?:无需|不必|不用|不需要|非)(?:手动确认|人工确认|逐项确认|逐个确认)/g

const GENERAL_POLICY_PATTERNS: readonly RegExp[] = [
  // 删除 / 覆盖已有数据
  /删除|删掉|清空|移除|覆盖已有|覆盖原|覆盖现有|覆盖旧|表结构覆盖|\bdelete\b|\bremove\s+existing\b|\boverwrite\b|\btruncate\b|\bdrop\s+table\b/i,
  // 权限变更
  /权限变更|修改(?:[^\s，,。；;]{0,6})?权限|变更(?:[^\s，,。；;]{0,6})?权限|提权|开放权限|授予.*权限|\bchmod\b|\bsudo\b|\bgrant\s+permission\b|\bescalate\b|\badmin\s+access\b/i,
  // 付费 / 支付
  /付费|支付|付款|扣费|充值|购买|下单|转账|结算费用|\bpayment\b|\bbilling\b|\bpurchase\b/i,
  // 外发 / 发布 / 发送邮件 / 发通知（排除“研发邮件组”/“开发邮件”等名词误伤）
  /外发|对外发布|公开发布|发布到|发送邮件|(?<!研|开)发邮件|群发|(?<!研|开)发通知|发送通知|推送通知|\bsend\s*[_ ]?email\b|\bpublish\b|\bbroadcast\b/i,
  // 不可逆动作
  /不可逆|无法撤回|无法恢复|不可恢复|永久(?:修改|删除|生效)|\birreversible\b|\bcannot\s+undo\b/i,
  // Team/Sub 派发
  /\bsws_team_dispatch\b|\bsws_subagent\b|\bteam_task_update\b|\bteam_task_create\b|\bspawn_teammate\b|\bsubagent\b|\bteam_task\b|team\s*\/\s*sub|派发子|派生子|拉起团队|组建团队|\binvoke_subagent\b|\bswarm\b/i,
]

const NEGATED_SAFE_DISCLAIMER_PATTERN =
  /(?:不|未|无|无需|不会|不得|禁止|不涉及|不改变|不影响|非)(?:会|得|能|要|涉及|改变|改动|修改|改|影响|执行|触发)?(?:删除|覆盖已有|覆盖原|覆盖现有|修改(?:[^\s，,。；;]{0,6})?权限|变更(?:[^\s，,。；;]{0,6})?权限|付费|支付|外发|对外发布|发布|发送邮件|发通知|丢弃字段|改变数据含义|违反(?:指定)?模板|改交付文件类型|改变文件类型|定稿|对外声明|法律|合同|金额|承诺|路径和既有文件|路径或既有文件|既有文件名|既有文件重命名|既有文件|路径|重命名|改名)/g

const DRAFT_LABEL_TEXT_PATTERNS: readonly RegExp[] = [
  // 常见文件后缀（排除版本号如 v1.0.1）
  /(?<![0-9])\.[a-zA-Z][a-zA-Z0-9]{0,7}\b/,
  // 路径特征
  /(?:^|[\s'"(:])(?:\.{1,2}[/\\]|[a-zA-Z]:[/\\]|[\w.-]+[/\\][\w.-]+)/,
  // 既有文件重命名 / 公开名称 / API 标识 / 被引用符号名
  /重命名|改名|既有文件|已有文件|现有文件|原文件|公开名称|公开名|对外名称|包名|模块名|类名|函数名|变量名|接口名|字段名|导出名|被引用|引用名|\bAPI\b|\bsymbol\b|\bidentifier\b|\brename\b|\bexisting\s+file\b|\bpublic\s+name\b|\bexport\b/i,
]

const DRAFT_LABEL_CONTEXT_RENAME_PATTERNS: readonly RegExp[] = [
  /重命名|改名|\brename\b/i,
  /(?:把|将|对|修改|更改|改动)\s*(?:既有文件|已有文件|现有文件|原文件|文件路径)/,
  /(?:既有文件|已有文件|现有文件|原文件)[^\n，,。；;]{0,24}(?:改为|改成|替换|迁移)/,
]

const DRAFT_LABEL_OPTION_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /[/\\]/,
  /`[^`]+`/,
  /\(\)/,
  /::|->/,
  /^[a-z]+[A-Z][a-zA-Z0-9]*$/,
  /^[A-Z][a-z]+[A-Z][a-zA-Z0-9]*$/,
  /^[a-zA-Z_][a-zA-Z0-9_]*_[a-zA-Z0-9_]+$/,
]

const DRAFT_WORDING_PATTERNS: readonly RegExp[] = [
  /定稿|终稿|对外声明|官方声明|正式公告|公关稿|新闻稿|免责声明|\bpress\s+release\b|\bofficial\s+statement\b|\bpublic\s+announcement\b|\bfinalized\b/i,
  /法律|法务|合同|协议条款|违约|赔付|赔偿|金额|报价|价格|预算|经费|费用|人民币|美元|[¥￥$]|\b\d+\s*(?:万元|亿元|元)\b|承诺|保证|担保|交付日期|截止日期|\bSLA\b|\blegal\b|\bcontract\b|\bclause\b|\bamount\b|\bprice\b|\bbudget\b|\bcommitment\b|\bguarantee\b|\bliability\b/i,
]

const PRESENTATION_KEEP_FORMAT_PATTERN =
  /(?:保持|维持|沿用|保留)\s*\.?(?:pdf|docx?|xlsx?|csv|json|html?|md|word|excel|markdown)\s*(?:文件)?(?:格式|类型)?(?:不变|原样)?/gi

const PRESENTATION_PATTERNS: readonly RegExp[] = [
  /改交付文件类型|更改文件类型|改变文件类型|更改交付格式|(?:改为|改成|换成|转为|转成|导出为|输出为|保存为|切换为)\s*\.?(?:pdf|docx?|xlsx?|csv|json|html?|md|word|excel|markdown)\b|\bchange\s+file\s+type\b|\bconvert\s+to\b|\bexport\s+(?:as|to)\s+\.?(?:pdf|docx?|xlsx?|csv|json|html?|md)\b/i,
  /丢弃字段|删除字段|移除字段|去掉字段|省略字段|隐藏字段|\bdrop\s+field\b|\bremove\s+field\b|\bomit\s+field\b|\bdiscard\s+field\b/i,
  /改变数据含义|更改数据含义|修改数值|修改统计口径|改变口径|\balter\s+meaning\b|\bchange\s+data\s+meaning\b/i,
  /违反(?:指定)?模板|忽略(?:指定)?模板|跳过(?:指定)?模板|覆盖(?:指定)?模板|打破(?:指定)?模板|\bviolate\s+template\b|\bignore\s+template\b|\boverride\s+template\b/i,
]

const PRESENTATION_LABEL_EXT_PATTERN = /^\.?(?:pdf|docx?|xlsx?|csv|json|html?|md)$/i

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isNonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength
}

function isKnownDecisionType(value: unknown): value is RecommendationDecisionType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DECISION_TYPE_CATEGORY, value)
}

function fail(
  reason: Extract<RecommendationValidationResult, { ok: false }>['reason'],
  message: string,
): RecommendationValidationResult {
  return { ok: false, reason, message }
}

function findUnexpectedKey(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): { kind: 'policy' | 'invalid'; key: string } | null {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue
    if (POLICY_ESCAPE_KEYS.has(key.toLowerCase())) {
      return { kind: 'policy', key }
    }
    return { kind: 'invalid', key }
  }
  return null
}

function stripNegatedDisclaimers(text: string): string {
  return text.replace(NEGATED_SAFE_DISCLAIMER_PATTERN, ' ')
}

function stripKeepFormatPhrases(text: string): string {
  return text.replace(PRESENTATION_KEEP_FORMAT_PATTERN, ' ')
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasExplicitConflictingUserChoice(
  texts: readonly string[],
  options: readonly { id: string; label: string }[],
  recommendedOptionId: string,
): boolean {
  const nonEmptyTexts = texts.filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
  if (nonEmptyTexts.length === 0) return false

  for (const option of options) {
    if (option.id === recommendedOptionId) continue
    const label = option.label.trim()
    const core = label.replace(/(?:排版|格式|展示|风格|标题|名称)$/, '').trim() || label

    const patterns: RegExp[] = []
    if (core.length >= 2) {
      patterns.push(
        new RegExp(
          `(?:^|[\\s，,。；;、]|排版(?:请)?)(?:明确指定(?:使用|采用|用)?|指定(?:使用|采用|用)?|要求(?:使用|采用|用)|必须(?:使用|采用|用)|固定(?:使用|采用|用)|只(?:使用|采用|用)|请(?:使用|采用|用)|使用|采用|用)\\s*${escapeRegExp(core)}(?!\\s*(?:还是|或者|或|/|\\?|？))`,
          'i',
        ),
      )
    }

    const asciiTokens = new Set<string>()
    if (/^[a-zA-Z][a-zA-Z0-9_-]{2,}$/.test(option.id)) {
      asciiTokens.add(option.id)
    }
    if (/^[a-zA-Z][a-zA-Z0-9 _-]{2,}$/.test(core)) {
      asciiTokens.add(core)
    }
    for (const token of asciiTokens) {
      patterns.push(
        new RegExp(
          `(?:^|[\\s,.;:!?()'"，。；;、]|排版(?:请)?)(?:use|using|prefer|choose|pick|select|keep|stick\\s+with|go\\s+with|in|as|with|format(?:\\s+as)?|请?使用|请?采用|请?用|改为)\\s*(?:a\\s+|an\\s+|the\\s+)?${escapeRegExp(token)}(?:\\s+(?:format|layout|view|style|mode))?(?!\\s*(?:or|/|\\?|还是|或者|或))(?=$|[\\s,.;:!?()'"，。；;、])`,
          'i',
        ),
      )
    }

    if (patterns.some((pattern) => nonEmptyTexts.some((text) => pattern.test(text)))) {
      return true
    }
  }
  return false
}

function checkContextPolicySafety(
  categories: ReadonlySet<RecommendationCategory>,
  task: string,
  requirements: string,
  clarificationAnswers: readonly string[],
): string | null {
  const contexts = [task, requirements, ...clarificationAnswers]
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    .map((text) => stripNegatedDisclaimers(text))

  for (const text of contexts) {
    if (matchesAny(text, GENERAL_POLICY_PATTERNS)) {
      return '任务或需求清单涉及受限高风险动作，不能通过推荐路径自动放行'
    }
  }

  if (categories.has('draft_label')) {
    for (const text of contexts) {
      if (matchesAny(text, DRAFT_LABEL_CONTEXT_RENAME_PATTERNS)) {
        return '任务或需求清单涉及既有文件重命名或路径修改，禁止通过草稿名称推荐放行'
      }
    }
  }

  return null
}

function checkItemPolicySafety(
  category: RecommendationCategory,
  item: {
    id: string
    options: { id: string; label: string }[]
    recommended_option_id: string
    reason: string
    impact: string
  },
): string | null {
  const optionLabels = item.options.map((opt) => opt.label.trim())
  const rationaleTexts = [stripNegatedDisclaimers(item.reason), stripNegatedDisclaimers(item.impact)]

  // 1. 通用高风险边界：任何类别均不可代选删除/覆盖、权限变更、付费、外发/发布、不可逆动作、Team/Sub 派发
  for (const label of optionLabels) {
    if (matchesAny(label, GENERAL_POLICY_PATTERNS)) {
      return '推荐选项涉及受限动作，不能通过推荐路径自动采用'
    }
  }
  for (const text of rationaleTexts) {
    if (matchesAny(text, GENERAL_POLICY_PATTERNS)) {
      return '推荐说明涉及受限动作或不可逆影响，必须保留人工确认或独立审批'
    }
  }

  // 2. 类别专属边界
  if (category === 'draft_label') {
    for (const label of optionLabels) {
      if (matchesAny(label, DRAFT_LABEL_TEXT_PATTERNS) || matchesAny(label, DRAFT_LABEL_OPTION_IDENTIFIER_PATTERNS)) {
        return '草稿名称选项疑似路径、后缀、既有文件或代码标识，禁止自动改名'
      }
    }
    for (const text of rationaleTexts) {
      if (matchesAny(text, DRAFT_LABEL_TEXT_PATTERNS)) {
        return 'draft_label 仅允许用于本轮新草稿的可改显示名称，禁止涉及既有文件、路径或公开标识'
      }
    }
  } else if (category === 'draft_wording') {
    for (const label of optionLabels) {
      if (matchesAny(label, DRAFT_WORDING_PATTERNS)) {
        return '草稿措辞选项涉及定稿对外声明、法律、合同、金额或承诺，禁止自动采用'
      }
    }
    for (const text of rationaleTexts) {
      if (matchesAny(text, DRAFT_WORDING_PATTERNS)) {
        return 'draft_wording 不得涉及定稿对外声明、法律/合同/金额或承诺变更'
      }
    }
  } else if (category === 'presentation') {
    for (const label of optionLabels) {
      const cleanedLabel = stripKeepFormatPhrases(label)
      if (PRESENTATION_LABEL_EXT_PATTERN.test(label) || matchesAny(cleanedLabel, PRESENTATION_PATTERNS)) {
        return '排版选项涉及文件类型、字段或数据含义变更，禁止自动采用'
      }
    }
    for (const text of rationaleTexts) {
      const cleanedText = stripKeepFormatPhrases(text)
      if (matchesAny(cleanedText, PRESENTATION_PATTERNS)) {
        return 'presentation 仅限不改数据含义与交付类型的表达层排版，禁止丢弃字段或违反模板'
      }
    }
  }

  return null
}

/** 识别用户是否显式要求人工确认、先看方案或不要代选。 */
export function hasManualReviewSignal(text: string): boolean {
  if (typeof text !== 'string' || !text.trim()) return false
  const cleaned = text.replace(NEGATED_CONFIRM_PATTERN, ' ')
  return MANUAL_REVIEW_PATTERNS.some((pattern) => pattern.test(cleaned))
}

/** 将已自动采用的推荐项格式化为简洁中文说明；空数组返回空串。 */
export function formatAppliedSummary(applied: readonly AppliedRecommendation[]): string {
  if (applied.length === 0) return ''
  const labels = applied.map((item) => `‘${item.option_label}’`)
  if (labels.length === 1) {
    return `已按推荐采用${labels[0]}。`
  }
  const head = labels.slice(0, -1).join('、')
  const tail = labels[labels.length - 1]
  return `已按推荐采用${head}和${tail}。`
}

/**
 * 构造不泄漏自由文本草稿内容的安全审计令牌：
 * 仅对处于封闭枚举内的 presentation 选项输出 `decision_type:option_id`，
 * 其余草稿类别仅记录封闭的 `decision_type`。
 */
export function buildSafeAuditTokens(applied: readonly AppliedRecommendation[]): string[] {
  return applied.map((item) => {
    const closedSet = CLOSED_PRESENTATION_OPTIONS[item.decision_type]
    if (item.category === 'presentation' && closedSet?.has(item.option_id)) {
      return `${item.decision_type}:${item.option_id}`
    }
    return item.decision_type
  })
}

/** 校验一批推荐项是否满足配置、结构、闭集与安全策略，全部通过才放行。 */
export function validateRecommendationBatch(input: {
  items: unknown
  config: Pick<GrillConfig, 'recommendationMode' | 'recommendationCategories'>
  task: string
  requirements: string
  clarificationAnswers?: readonly string[]
}): RecommendationValidationResult {
  const clarificationAnswers = Array.isArray(input.clarificationAnswers)
    ? input.clarificationAnswers.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []

  if (
    hasManualReviewSignal(input.task) ||
    hasManualReviewSignal(input.requirements) ||
    clarificationAnswers.some((entry) => hasManualReviewSignal(entry))
  ) {
    return fail('manual-confirmation-required', '用户已要求人工确认或先看方案，保留原确认流程')
  }

  const mode = input.config.recommendationMode
  if (mode !== 'conservative' && mode !== 'standard' && mode !== 'custom') {
    return fail('recommendation-mode-disabled', '当前开工决策处于手动或未启用状态，不允许自动采用推荐')
  }

  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_BATCH_ITEMS) {
    return fail('invalid-recommendation', `推荐列表必须为 1 至 ${MAX_BATCH_ITEMS} 项非空数组`)
  }

  const effectiveCategories = resolveEffectiveRecommendationCategories(input.config)
  const seenItemIds = new Set<string>()
  const batchCategories = new Set<RecommendationCategory>()
  const applied: AppliedRecommendation[] = []
  const userChoiceTexts = [input.task, ...clarificationAnswers]

  for (const rawItem of input.items) {
    if (!isPlainObject(rawItem)) {
      return fail('invalid-recommendation', '推荐项必须是纯对象')
    }

    const unexpectedItemKey = findUnexpectedKey(rawItem, ALLOWED_ITEM_KEYS)
    if (unexpectedItemKey) {
      if (unexpectedItemKey.kind === 'policy') {
        return fail('policy-blocked', '推荐项包含受限字段，已拒绝')
      }
      return fail('invalid-recommendation', '推荐项包含不支持的字段')
    }

    // a) id 非空且批内唯一
    if (!isNonEmptyText(rawItem.id, MAX_ID_LENGTH)) {
      return fail('invalid-recommendation', '推荐项 id 必须为非空字符串')
    }
    const itemId = rawItem.id.trim()
    if (seenItemIds.has(itemId)) {
      return fail('invalid-recommendation', '推荐批次中存在重复的推荐项 id')
    }
    seenItemIds.add(itemId)

    // b) category 必须是已知类别
    if (!isKnownRecommendationCategory(rawItem.category)) {
      return fail('unknown-category', '存在未知的推荐类别')
    }
    const category = rawItem.category

    // c) decision_type 必须在封闭表内且与 category 严格一致
    if (!isKnownDecisionType(rawItem.decision_type) || DECISION_TYPE_CATEGORY[rawItem.decision_type] !== category) {
      return fail('invalid-decision-type', '存在无效或与类别不匹配的决策类型')
    }
    const decisionType = rawItem.decision_type

    // d) options 至少 2 个不同选项，recommended_option_id 精准命中且仅命中 1 个选项
    if (
      !Array.isArray(rawItem.options) ||
      rawItem.options.length < 2 ||
      rawItem.options.length > MAX_OPTIONS_PER_ITEM
    ) {
      return fail('invalid-recommendation', `推荐项必须包含 2 至 ${MAX_OPTIONS_PER_ITEM} 个可选项`)
    }

    const closedPresentationSet = CLOSED_PRESENTATION_OPTIONS[decisionType]
    const seenOptionIds = new Set<string>()
    const seenOptionLabels = new Set<string>()
    const normalizedOptions: { id: string; label: string }[] = []

    for (const rawOpt of rawItem.options) {
      if (!isPlainObject(rawOpt)) {
        return fail('invalid-recommendation', '推荐选项必须是纯对象')
      }
      const unexpectedOptKey = findUnexpectedKey(rawOpt, ALLOWED_OPTION_KEYS)
      if (unexpectedOptKey) {
        if (unexpectedOptKey.kind === 'policy') {
          return fail('policy-blocked', '推荐选项包含受限字段，已拒绝')
        }
        return fail('invalid-recommendation', '推荐选项包含不支持的字段')
      }
      if (!isNonEmptyText(rawOpt.id, MAX_ID_LENGTH)) {
        return fail('invalid-recommendation', '推荐选项缺少非空 id')
      }
      if (!isNonEmptyText(rawOpt.label, MAX_OPTION_LABEL_LENGTH)) {
        return fail('invalid-recommendation', '推荐选项 label 无效或过长')
      }
      const optId = rawOpt.id.trim()
      const optLabel = rawOpt.label.trim()
      if (closedPresentationSet && !closedPresentationSet.has(optId)) {
        return fail('invalid-recommendation', '排版决策选项不在允许的封闭枚举范围内')
      }
      if (seenOptionIds.has(optId)) {
        return fail('invalid-recommendation', '推荐项存在重复的选项 id')
      }
      if (seenOptionLabels.has(optLabel)) {
        return fail('invalid-recommendation', '推荐项存在重复的选项 label')
      }
      seenOptionIds.add(optId)
      seenOptionLabels.add(optLabel)
      normalizedOptions.push({ id: optId, label: optLabel })
    }

    if (!isNonEmptyText(rawItem.recommended_option_id, MAX_ID_LENGTH)) {
      return fail('invalid-recommendation', '推荐项缺少唯一的 recommended_option_id')
    }
    const recommendedOptionId = rawItem.recommended_option_id.trim()
    if (closedPresentationSet && !closedPresentationSet.has(recommendedOptionId)) {
      return fail('invalid-recommendation', '排版推荐选项不在允许的封闭枚举范围内')
    }
    const matchedOptions = normalizedOptions.filter((opt) => opt.id === recommendedOptionId)
    if (matchedOptions.length !== 1 || !matchedOptions[0]) {
      return fail('invalid-recommendation', '推荐项的 recommended_option_id 未精准命中唯一选项')
    }
    const recommendedOption = matchedOptions[0]

    // e) reason 与 impact 均非空字符串
    if (!isNonEmptyText(rawItem.reason, MAX_TEXT_LENGTH) || !isNonEmptyText(rawItem.impact, MAX_TEXT_LENGTH)) {
      return fail('invalid-recommendation', '推荐项的 reason 与 impact 均不能为空')
    }
    const reason = rawItem.reason.trim()
    const impact = rawItem.impact.trim()

    // f) 用户任务或澄清答复中若明确指定了非推荐选项，必须优先尊重用户并回到人工流程
    if (hasExplicitConflictingUserChoice(userChoiceTexts, normalizedOptions, recommendedOptionId)) {
      return fail('manual-confirmation-required', '用户已明确指定其他选项，禁止以推荐覆盖用户指示')
    }

    // g) 单项语义安全边界校验（fail-closed）
    const policyViolation = checkItemPolicySafety(category, {
      id: itemId,
      options: normalizedOptions,
      recommended_option_id: recommendedOptionId,
      reason,
      impact,
    })
    if (policyViolation) {
      return fail('policy-blocked', policyViolation)
    }

    // h) 校验 category 是否已在当前生效配置中启用
    if (!effectiveCategories.includes(category)) {
      return fail('category-not-enabled', '存在未在当前设置中启用的推荐类别')
    }

    batchCategories.add(category)
    applied.push({
      id: itemId,
      category,
      decision_type: decisionType,
      option_id: recommendedOption.id,
      option_label: recommendedOption.label,
      reason,
      impact,
    })
  }

  // i) 任务与需求清单上下文高风险校验（防止无害推荐项为高风险任务开绿灯）
  const contextViolation = checkContextPolicySafety(
    batchCategories,
    input.task,
    input.requirements,
    clarificationAnswers,
  )
  if (contextViolation) {
    return fail('policy-blocked', contextViolation)
  }

  return {
    ok: true,
    applied,
    summary: formatAppliedSummary(applied),
  }
}
