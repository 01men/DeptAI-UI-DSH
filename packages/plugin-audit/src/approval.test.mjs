/**
 * 审批负载卫生与规则源自证（OPT-P2-02 配套测试，2026-09-12）。
 * 运行：node --test packages/plugin-audit/src/approval.test.mjs
 *
 * 覆盖面：敏感键扫描/深度掩码/规则源口径/createApproval 掩码入库 + reject 类拒绝/
 * executor 失败 → 补偿编排并回写（registerCompensation 注册表 5 例）。
 * 补偿用例以实例级桩件驱动 AuditService（approvals/record/platformBus 以纯对象替身注入）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AuditService, approvalKindRule } from './index.ts'
import { SENSITIVE_KEY_RE, scanSensitiveKeys, maskSensitivePayload } from '../../platform-core/src/index.ts'

test('敏感键扫描：嵌套对象/数组内命中并给出路径', () => {
  const paths = scanSensitiveKeys({ name: 'x', nested: { api_key: 'k', list: [{ password: 'p' }] }, note: 'token 帧=词' })
  assert.ok(paths.includes('nested.api_key'))
  assert.ok(paths.includes('nested.list[0].password'))
  assert.equal(paths.length, 2, '仅键名命中，值内容不算')
})

test('深度掩码：值替换为 ***，键名结构保留，inputHash 口径不受影响', () => {
  const { masked, maskedKeys } = maskSensitivePayload({ user: 'u', clientSecret: 's', arr: [{ token: 't' }] })
  assert.equal(masked.clientSecret, '***')
  assert.equal(masked.arr[0].token, '***')
  assert.equal(masked.user, 'u')
  assert.deepEqual(maskedKeys, ['clientSecret', 'arr[0].token'])
  assert.ok(SENSITIVE_KEY_RE.test('accessToken'))
})

test('规则源：admin 续调=reject，连接类=mask，未知 kind 缺省 mask', () => {
  assert.equal(approvalKindRule('connector.action.admin').sensitiveInputPolicy, 'reject')
  assert.equal(approvalKindRule('connector.offline').sensitiveInputPolicy, 'mask')
  assert.equal(approvalKindRule('unknown.kind').sensitiveInputPolicy, 'mask')
})

function makeStubAudit({ executorError } = {}) {
  const ctx = new Context()
  const events = []
  // 构造器会向总线订阅一批事件：注入桩总线（on 返回空注销函数）
  ctx.platformBus = {
    on: () => () => {},
    emit: (name, payload) => events.push({ name, payload }),
  }
  // 构造器还会向 usage 消费管道注册计量订阅
  ctx.usage = { consume: () => () => {} }
  const audit = new AuditService(ctx)
  const store = new Map()
  const calls = { compensations: [], executorRuns: 0 }
  audit.approvals = () => ({
    insert: (record) => (store.set(record.id, record), record),
    get: (id) => store.get(id),
    update: (id, patch) => Object.assign(store.get(id), patch),
    find: () => [...store.values()],
  })
  audit.record = () => {}
  audit.registerExecutor('kind.ok', async () => ({ runId: 'r1' }))
  audit.registerExecutor('kind.fail', async () => {
    calls.executorRuns++
    throw new Error('下游不可用')
  })
  audit.registerCompensation('kind.fail', async (payload, error) => {
    calls.compensations.push({ reason: error.message, ref: payload.ref })
    return { compensated: true }
  })
  void executorError
  return { audit, store, events, calls }
}

test('补偿注册表①：executor 失败 → 补偿被调用且结果回写审批单', async () => {
  const { audit, store, calls } = makeStubAudit()
  const approval = audit.createApproval({ kind: 'kind.fail', title: 't', payload: { ref: 'r-1' }, requesterId: 'u1', requesterName: 'u' })
  const decided = await audit.decideApproval(approval.id, 'approve', 'a1', '审批人')
  assert.equal(calls.executorRuns, 1)
  assert.equal(calls.compensations.length, 1)
  assert.equal(calls.compensations[0].ref, 'r-1')
  assert.ok(store.get(approval.id).execution.result.includes('已完成补偿'))
  assert.equal(decided.status, 'failed', '补偿不改变执行失败的既成事实')
})

test('补偿注册表②：executor 成功 → 不触发补偿', async () => {
  const { audit, calls } = makeStubAudit()
  const approval = audit.createApproval({ kind: 'kind.ok', title: 't', payload: {}, requesterId: 'u1', requesterName: 'u' })
  await audit.decideApproval(approval.id, 'approve', 'a1', '审批人')
  assert.equal(calls.compensations.length, 0)
})

test('补偿注册表③：未注册补偿的 kind 失败 → 仅记录失败（既有口径不变）', async () => {
  const { audit, store } = makeStubAudit()
  const approval = audit.createApproval({ kind: 'kind.fail', title: 't', payload: { ref: 'x' }, requesterId: 'u', requesterName: 'u' })
  audit.registerCompensation('kind.fail', async () => { throw new Error('never') })
  audit.compensations.delete('kind.fail')
  const decided = await audit.decideApproval(approval.id, 'approve', 'a1', '审批人')
  assert.equal(decided.status, 'failed')
  assert.ok(store.get(approval.id).execution.error.includes('下游不可用'))
})

test('补偿注册表④：补偿自身失败 → execution 显式标记需人工介入', async () => {
  const { audit, store } = makeStubAudit()
  const approval = audit.createApproval({ kind: 'kind.fail', title: 't', payload: {}, requesterId: 'u', requesterName: 'u' })
  audit.registerCompensation('kind.fail', async () => { throw new Error('补偿通道也挂了') })
  const decided = await audit.decideApproval(approval.id, 'approve', 'a1', '审批人')
  assert.equal(decided.status, 'failed')
  assert.ok(store.get(approval.id).execution.result.includes('需人工介入'))
  assert.ok(store.get(approval.id).execution.error.includes('补偿通道也挂了'))
})

test('补偿注册表⑤：createApproval 携敏感入参且规则为 reject → 直接拒绝开单', () => {
  const { audit } = makeStubAudit()
  assert.throws(() => audit.createApproval({
    kind: 'connector.action.admin', title: 't',
    payload: { actionId: 'a', input: { password: 'plain' } }, requesterId: 'u', requesterName: 'u',
  }), /敏感命名入参/)
})

test('补偿注册表⑥：mask 类 kind 携敏感入参 → 掩码入库且 maskedKeys 留痕', () => {
  const { audit, store } = makeStubAudit()
  const approval = audit.createApproval({
    kind: 'connector.offline', title: 't',
    payload: { connectionId: 'c', accessToken: 'should-not-persist' }, requesterId: 'u', requesterName: 'u',
  })
  const stored = store.get(approval.id)
  assert.equal(stored.payload.accessToken, '***')
  assert.deepEqual(stored.payload.maskedKeys, ['accessToken'])
})

// ---------------------------------------------------------------------------
// 同目标在途单收口（2026-11-02）：幂等复用 / 执行成功收口 / 失败不收口 / 启动期自愈 / SLA 口径
// 背景：人工提交 Agent 上线单后治理 Agent 又对同一 agentId 另开一张并批掉，人工那张永久挂 pending。
// ---------------------------------------------------------------------------

/** 带谓词的集合替身（基础桩的 find 忽略谓词，收口逻辑依赖谓词过滤，故另起一套）。 */
function makeTargetStubAudit() {
  const ctx = new Context()
  const events = []
  const records = []
  ctx.platformBus = { on: () => () => {}, emit: (name, payload) => events.push({ name, payload }) }
  ctx.usage = { consume: () => () => {} }
  const audit = new AuditService(ctx)
  const store = new Map()
  audit.approvals = () => ({
    insert: (record) => (store.set(record.id, record), record),
    get: (id) => store.get(id),
    update: (id, patch) => Object.assign(store.get(id), patch),
    all: () => [...store.values()],
    find: (pred) => [...store.values()].filter(pred),
    findOne: (pred) => [...store.values()].find(pred),
  })
  audit.record = (entry) => records.push(entry)
  audit.registerExecutor('agent.online', async (payload) => ({ onlined: payload.agentId }))
  const seed = (id, patch) => store.set(id, {
    id, kind: 'agent.online', title: 'Agent 上线：x', payload: { agentId: 'agt_1' },
    requesterId: 'usr_a', requesterName: '甲', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', ...patch,
  })
  return { audit, store, events, records, seed }
}

test('同目标收口①：同 agentId 在途单再次发起 → 幂等复用原单，不新增，留痕 approval.reuse', () => {
  const { audit, store, records } = makeTargetStubAudit()
  const first = audit.createApproval({ kind: 'agent.online', title: 't', payload: { agentId: 'agt_1', requesterId: 'usr_a' }, requesterId: 'usr_a', requesterName: '甲' })
  const again = audit.createApproval({ kind: 'agent.online', title: 't', payload: { agentId: 'agt_1', requesterId: 'pri_b' }, requesterId: 'pri_b', requesterName: '治理执行官' })
  assert.equal(again.id, first.id, '复用原单')
  assert.equal(store.size, 1, '不新增')
  const reuse = records.find((r) => r.action === 'approval.reuse')
  assert.ok(reuse && reuse.resourceId === first.id && reuse.actorType === 'machine', '复用留痕且机器主体按 pri_ 前缀识别')
})

test('同目标收口②：不同 agentId / 未登记 kind 互不影响（各自独立开单）', () => {
  const { audit, store } = makeTargetStubAudit()
  const a = audit.createApproval({ kind: 'agent.online', title: 't', payload: { agentId: 'agt_1' }, requesterId: 'u', requesterName: 'u' })
  const b = audit.createApproval({ kind: 'agent.online', title: 't', payload: { agentId: 'agt_2' }, requesterId: 'u', requesterName: 'u' })
  const c = audit.createApproval({ kind: 'kind.other', title: 't', payload: { agentId: 'agt_1' }, requesterId: 'u', requesterName: 'u' })
  const d = audit.createApproval({ kind: 'kind.other', title: 't', payload: { agentId: 'agt_1' }, requesterId: 'u', requesterName: 'u' })
  assert.notEqual(a.id, b.id)
  assert.notEqual(c.id, d.id, '未登记 kind 不参与去重')
  assert.equal(store.size, 4)
})

test('同目标收口③：某张执行成功 → 其余同目标 pending 单自动 superseded（引擎署名、依据可追溯、不发 ApprovalDecided）', async () => {
  const { audit, store, events, records, seed } = makeTargetStubAudit()
  seed('apr_human', { requesterId: 'usr_a', requesterName: '师圆圆' })
  seed('apr_agent', { requesterId: 'pri_op', requesterName: '治理执行官', createdAt: '2026-01-01T00:10:00.000Z' })
  seed('apr_other', { payload: { agentId: 'agt_9' } })
  const decided = await audit.decideApproval('apr_agent', 'approve', 'pri_rv', '治理评审官', '批准')
  assert.equal(decided.status, 'executed')
  const human = store.get('apr_human')
  assert.equal(human.status, 'superseded')
  assert.equal(human.supersededBy, 'apr_agent')
  assert.equal(human.approverName, '审批引擎')
  assert.ok(human.decidedAt && human.opinion.includes('apr_agent'))
  assert.equal(store.get('apr_other').status, 'pending', '不同目标不受影响')
  assert.equal(records.filter((r) => r.action === 'approval.superseded').length, 1)
  assert.equal(events.filter((e) => e.name === 'approval.decided').length, 1, '收口不发 ApprovalDecided（只有执行单那一次）')
})

test('同目标收口④：登记 kind 执行失败不收口（兄弟单保留重试面）', async () => {
  const { audit, store, seed } = makeTargetStubAudit()
  seed('apr_a')
  seed('apr_b', { createdAt: '2026-01-01T00:10:00.000Z' })
  audit.registerExecutor('agent.online', async () => { throw new Error('状态机拒绝') })
  const decided = await audit.decideApproval('apr_b', 'approve', 'pri_rv', '审批人')
  assert.equal(decided.status, 'failed')
  assert.equal(store.get('apr_a').status, 'pending')
})

test('同目标收口⑤：启动期自愈——执行前发起的孤儿单收口、执行后新开的合法单保留、幂等', () => {
  const { audit, store, seed } = makeTargetStubAudit()
  seed('apr_orphan', { createdAt: '2026-10-31T06:32:15.866Z' })
  seed('apr_done', { status: 'executed', createdAt: '2026-10-31T06:45:44.514Z', decidedAt: '2026-10-31T06:45:44.532Z', requesterId: 'pri_op' })
  seed('apr_later', { createdAt: '2026-11-01T00:00:00.000Z' })
  assert.equal(audit.reconcileSupersededApprovals(), 1)
  assert.equal(store.get('apr_orphan').status, 'superseded')
  assert.equal(store.get('apr_orphan').supersededBy, 'apr_done')
  assert.equal(store.get('apr_later').status, 'pending', '执行之后新开的同目标单是合法新诉求')
  assert.equal(audit.reconcileSupersededApprovals(), 0, '二次执行零写入')
})

test('同目标收口⑥：superseded 不计入 SLA 分母', async () => {
  const { audit, seed } = makeTargetStubAudit()
  const now = new Date().toISOString()
  seed('apr_a', { createdAt: now })
  seed('apr_b', { createdAt: now })
  await audit.decideApproval('apr_b', 'approve', 'pri_rv', '审批人')
  const sla = audit.slaReport(30)
  assert.equal(sla.decided, 1, '仅执行单计入已决')
  assert.equal(sla.total, 2)
})
