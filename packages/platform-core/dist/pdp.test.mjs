/**
 * Policy Decision Point 单元测试（W3-T5，MCP 治理契约 §11）。
 *
 * 运行方式：node --test packages/platform-core/src/pdp.test.mjs
 *
 * 覆盖面：模块聚合（reasons/obligations 全量拼接）/ deny 优先（任一 deny 即整体拒绝、
 * 首个 deny 模块理由即主因）/ decisionId 形态（pd_ 前缀、逐次不同）/ 异步模块与模块
 * 异常 fail-closed / wrapPolicyDecision 统一决策表达。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PolicyDecisionPoint, wrapPolicyDecision, moduleDecision, newId } from './index.ts'

/** 桩主体（UnifiedPrincipal 最小形态）。 */
const subject = {
  principalId: 'pri-1',
  kind: 'human',
  authMethod: 'session',
  tokenId: 'jti-1',
  scopes: ['console.login'],
  actChain: [],
  name: '测试者',
  permissions: ['console.login'],
}

const request = (overrides = {}) => ({
  subject,
  action: 'mcp.invoke:demo:tool',
  resource: { type: 'mcp_service', id: 'mcp-1' },
  tool: { name: 'tool', risk: 'read' },
  context: {},
  ...overrides,
})

const allow = (reason, obligations = []) => ({ allow: true, reasons: [reason], decisionId: newId('pd'), obligations })
const deny = (reason, obligations = []) => ({ allow: false, reasons: [reason], decisionId: newId('pd'), obligations })

test('模块聚合：全部放行时 allow、reasons/obligations 按模块序全量拼接', async () => {
  const pdp = new PolicyDecisionPoint()
  pdp.register({ id: 'a', decide: () => allow('A 通过', [{ type: 'read-only' }]) })
  pdp.register({ id: 'b', decide: () => allow('B 通过') })
  const decision = await pdp.decide(request())
  assert.equal(decision.allow, true)
  assert.deepEqual(decision.reasons, ['A 通过', 'B 通过'])
  assert.deepEqual(decision.obligations, [{ type: 'read-only' }])
})

test('deny 优先：任一模块拒绝即整体拒绝，首个 deny 模块理由即主因（deny 理由前置聚合）', async () => {
  const pdp = new PolicyDecisionPoint()
  pdp.register({ id: 'a', decide: () => allow('A 通过') })
  pdp.register({ id: 'b', decide: () => deny('B 拒绝', [{ type: 'deny-code', code: 'ORG_SCOPE_DENIED' }]) })
  pdp.register({ id: 'c', decide: () => deny('C 拒绝') })
  pdp.register({ id: 'd', decide: () => allow('D 通过') })
  const decision = await pdp.decide(request())
  assert.equal(decision.allow, false)
  assert.equal(decision.reasons[0], 'B 拒绝', '首个 deny 模块的理由即主因')
  assert.deepEqual(decision.reasons, ['B 拒绝', 'C 拒绝', 'A 通过', 'D 通过'], 'deny 理由前置、allow 理由跟后在案')
  assert.deepEqual(decision.obligations, [{ type: 'deny-code', code: 'ORG_SCOPE_DENIED' }])
})

test('decisionId 形态：pd_ 前缀 + 逐次不同（进程内唯一可排序）', async () => {
  const pdp = new PolicyDecisionPoint()
  pdp.register({ id: 'a', decide: () => allow('ok') })
  const first = await pdp.decide(request())
  const second = await pdp.decide(request())
  assert.ok(first.decisionId.startsWith('pd_'))
  assert.ok(second.decisionId.startsWith('pd_'))
  assert.notEqual(first.decisionId, second.decisionId)
})

test('异步模块（Promise decide）与注册序裁决', async () => {
  const pdp = new PolicyDecisionPoint()
  pdp.register({ id: 'async', decide: async (req) => req.context.hit ? allow('异步通过') : deny('异步拒绝') })
  assert.equal((await pdp.decide(request({ context: { hit: true } }))).allow, true)
  assert.equal((await pdp.decide(request())).allow, false)
})

test('模块异常 fail-closed：抛错按该模块 deny 处理且不阻断其余模块', async () => {
  const pdp = new PolicyDecisionPoint()
  pdp.register({ id: 'boom', decide: () => { throw new Error('下游爆炸') } })
  pdp.register({ id: 'after', decide: () => allow('后续模块仍裁决') })
  const decision = await pdp.decide(request())
  assert.equal(decision.allow, false, '模块崩溃绝不静默放行')
  assert.ok(decision.reasons[0].includes('模块 boom 裁决异常'))
  assert.ok(decision.reasons.includes('后续模块仍裁决'))
})

test('wrapPolicyDecision：既有裁决出口统一决策表达（decisionId 形态一致）', () => {
  const decision = wrapPolicyDecision(false, ['引擎拒绝理由'])
  assert.equal(decision.allow, false)
  assert.deepEqual(decision.reasons, ['引擎拒绝理由'])
  assert.ok(decision.decisionId.startsWith('pd_'))
  assert.deepEqual(decision.obligations, [])
})

test('moduleDecision：模块级便捷构造保证 decisionId 形态一致', () => {
  const decision = moduleDecision(true, ['ok'], [{ type: 'read-only' }])
  assert.equal(decision.allow, true)
  assert.deepEqual(decision.obligations, [{ type: 'read-only' }])
  assert.ok(decision.decisionId.startsWith('pd_'))
})
