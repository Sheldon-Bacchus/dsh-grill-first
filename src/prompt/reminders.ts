/**
 * R1–R5 提醒词常量及组装方法。
 *
 * 用于在任务派发、交付收口、失败升级时向模型注入标准口径提醒。
 */

export const R1 =
  '拆分前自查：目标 / 范围 / 约束 / 验收齐了吗？不齐先补或问。每张卡必须写通道理由：为什么 Team（要判断/要担责/共享写范围）、为什么 Sub（可独立、产物是文件）。没有理由的卡不许派。'

export const R2 =
  '只回四段：结论 / 证据 / 风险 / 建议下一步。不要回过程，不要贴日志，不要把“已派出”说成“已完成”。'

export const R3 =
  '同一任务第 N 次失败。按 L0→L3 升级：重试 ≤2 → 重拆 → 上报 Lead → BLOCKED。每次升级写一行理由：谁升的、为什么、代价是什么。禁止静默重试。'

export const R4 =
  '完成前必须拿出可执行证据（文件路径 / 命令输出）。没有证据不得说完成；子会话仍在运行时不得结案。'

export const R5 =
  '需要外部能力（浏览器 / 搜索 / 文件 / MCP）时，作为任务参数写进任务包：给谁、用来干什么、边界在哪。不全局裸挂。'

export const REMINDERS = {
  R1,
  R2,
  R3,
  R4,
  R5,
} as const

/** 派发前提醒：R1 原文前加前缀。 */
export function buildDispatchReminder(): string {
  return `【派发前提醒】\n${R1}`
}

/** 交付与收口口径：R2 + 换行 + R4 前加前缀。 */
export function buildDeliveryReminder(): string {
  return `【交付与收口口径】\n${R2}\n${R4}`
}

/** 失败升级口径：R3 前加前缀。 */
export function buildEscalationReminder(): string {
  return `【失败升级】\n${R3}`
}
