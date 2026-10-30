/**
 * reminders 模块及接入测试（node:test 标准测试套件）。
 *
 * 验证：
 * ① R1..R5 都含指定关键句（R2 含「四段」，R4 含「证据」，R3 含「升级」）；
 * ② buildDeliveryReminder() 同时含 R2 与 R4 文本；
 * ③ buildDispatchReminder() 含「通道理由」；
 * ④ buildEscalationReminder() 结构自查；
 * ⑤ grill_start / grill_confirm 提醒词接线与 v1.0.1 语义一致性。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  R1,
  R2,
  R3,
  R4,
  R5,
  REMINDERS,
  buildDispatchReminder,
  buildDeliveryReminder,
  buildEscalationReminder,
} from '../dist/prompt/reminders.js'
import { createGrillStartTool } from '../dist/tools/grillStart.js'
import { createGrillConfirmTool } from '../dist/tools/grillConfirm.js'
import { GateRegistry } from '../dist/gate/preExecute.js'
import { SessionRegistry } from '../dist/tools/sessions.js'

test('① R1..R5 都含指定关键句（R2 含「四段」，R4 含「证据」，R3 含「升级」）', () => {
  // R1–R5 存在性与类型
  assert.equal(typeof R1, 'string')
  assert.equal(typeof R2, 'string')
  assert.equal(typeof R3, 'string')
  assert.equal(typeof R4, 'string')
  assert.equal(typeof R5, 'string')

  // 指定关键句断言
  assert.ok(R2.includes('四段'), 'R2 必须含「四段」')
  assert.ok(R4.includes('证据'), 'R4 必须含「证据」')
  assert.ok(R3.includes('升级'), 'R3 必须含「升级」')

  // 其余 R1/R5 关键句验证
  assert.ok(R1.includes('通道理由'), 'R1 必须含「通道理由」')
  assert.ok(R5.includes('外部能力'), 'R5 必须含「外部能力」')

  // 导出对象结构验证
  assert.deepEqual(REMINDERS, { R1, R2, R3, R4, R5 })
})

test('② buildDeliveryReminder() 同时含 R2 与 R4 文本', () => {
  const delivery = buildDeliveryReminder()
  assert.ok(delivery.startsWith('【交付与收口口径】\n'), '前缀必须为【交付与收口口径】')
  assert.ok(delivery.includes(R2), '必须含 R2 全文')
  assert.ok(delivery.includes(R4), '必须含 R4 全文')
  assert.equal(delivery, `【交付与收口口径】\n${R2}\n${R4}`)
})

test('③ buildDispatchReminder() 含「通道理由」', () => {
  const dispatch = buildDispatchReminder()
  assert.ok(dispatch.startsWith('【派发前提醒】\n'), '前缀必须为【派发前提醒】')
  assert.ok(dispatch.includes('通道理由'), '必须含「通道理由」')
  assert.ok(dispatch.includes(R1), '必须含 R1 全文')
  assert.equal(dispatch, `【派发前提醒】\n${R1}`)
})

test('④ buildEscalationReminder() 结构自查', () => {
  const escalation = buildEscalationReminder()
  assert.ok(escalation.startsWith('【失败升级】\n'), '前缀必须为【失败升级】')
  assert.ok(escalation.includes(R3), '必须含 R3 全文')
  assert.equal(escalation, `【失败升级】\n${R3}`)
})

test('⑤ grillStart 接线测试：verdict=clear（直接放行）和 needs-clarification（主返回与达到上限）均附带 hint', async () => {
  const gates = new GateRegistry()
  const sessions = new SessionRegistry()

  const tool = createGrillStartTool({
    config: () => ({
      enabled: true,
      bypassKeywords: ['跳过'],
      intensity: 'standard',
      maxRounds: 2,
      maxQuestionsPerRound: 2,
      memoryEnabled: false,
    }),
    gates,
    sessions,
    workspaceRoot: () => 'E:/test',
  })

  // 分支 1：needs-clarification 主返回附带 hint
  const vague = await tool.execute({ task: '做个系统' }, { agent: { id: 'agent-1' } })
  assert.equal(vague.verdict, 'needs-clarification')
  assert.ok(vague.hint?.includes(buildDispatchReminder()))

  // 分支 2：max-rounds-reached 附带原有 hint + buildDispatchReminder()
  sessions.start({ agentId: 'agent-1', task: '做个系统', mode: 'new-task', startedAt: Date.now(), rounds: 2 })
  const maxReached = await tool.execute({ task: '做个系统', mode: 'continue', answer_summary: '范围确认', asked_dimensions: ['scope'] }, { agent: { id: 'agent-1' } })
  assert.equal(maxReached.verdict, 'needs-clarification')
  assert.equal(maxReached.reason, 'max-rounds-reached')
  assert.ok(maxReached.hint?.includes('停止追问'))
  assert.ok(maxReached.hint?.includes(buildDispatchReminder()))

  // 分支 3：judged clear 附带 hint
  const clear = await tool.execute({ task: '跳过' }, { agent: { id: 'agent-2' } })
  assert.equal(clear.verdict, 'clear')
  assert.equal(clear.hint, buildDispatchReminder())
})

test('⑥ grillConfirm 接线测试：accept 返回体附带 instructions: buildDeliveryReminder()', async () => {
  const gates = new GateRegistry()
  const sessions = new SessionRegistry()

  // 1. 结构化确认 (accept 通道 1)
  const structuredTool = createGrillConfirmTool({
    config: () => ({
      enabled: true,
      maxRounds: 2,
      memoryEnabled: false,
    }),
    gates,
    sessions,
    workspaceRoot: () => 'E:/test',
    questions: () => ({
      ask: async () => ({
        answers: [{ id: 'grill-confirm', selected: ['确认，按此开工'] }],
      }),
    }),
  })
  const structured = await structuredTool.execute({ requirements: '目标/范围/约束/验收' }, { agent: { id: 'agent-1' } })
  assert.equal(structured.confirmed, true)
  assert.equal(structured.instructions, buildDeliveryReminder())

  // 2. 兜底通道 (accept 通道 2: agent-declared fallback)
  const fallbackTool = createGrillConfirmTool({
    config: () => ({
      enabled: true,
      maxRounds: 2,
      memoryEnabled: false,
    }),
    gates,
    sessions,
    workspaceRoot: () => 'E:/test',
    questions: () => undefined,
  })
  // 第一步：无提问通道进入 fallback
  const fallbackPrompt = await fallbackTool.execute({ requirements: '目标/范围/约束/验收' }, { agent: { id: 'agent-2' } })
  assert.equal(fallbackPrompt.confirmed, false)
  assert.equal(fallbackPrompt.needs_user_confirmation, true)
  // 第二步：用户在外部问答确认后传 confirmed: true
  const agentDeclared = await fallbackTool.execute({ requirements: '目标/范围/约束/验收', confirmed: true }, { agent: { id: 'agent-2' } })
  assert.equal(agentDeclared.confirmed, true)
  assert.equal(agentDeclared.instructions, buildDeliveryReminder())

  // 3. 原有 instructions 分支不被覆盖：空 requirements
  const emptyReq = await structuredTool.execute({ requirements: '' }, { agent: { id: 'agent-1' } })
  assert.equal(emptyReq.confirmed, false)
  assert.ok(emptyReq.instructions?.includes('requirements 不能为空'))
})
