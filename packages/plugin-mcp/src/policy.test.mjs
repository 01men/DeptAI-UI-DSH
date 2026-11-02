/**
 * W3-T5 统一策略与审计单测（MCP 治理契约 §11/§12/§13/§14）。
 *
 * 运行方式：node --test packages/plugin-mcp/src/policy.test.mjs
 *
 * 覆盖面：
 *   - org-constraint 三态：org 内放行 / 跨组织跨租户拒 ORG_SCOPE_DENIED /
 *     tenant 同租户放行（跨组织同租户）/ cross-org 无审批拒 + 有效审批引用放行；
 *   - 资源限定 scope 三形态第一层放行（mcp.invoke / mcp.service:* / mcp.tool:*），
 *     mcp. 前缀 scope 未覆盖本目标 fail-closed（SCOPE_DENIED），legacy scopes 不设防；
 *   - 策略模拟 dry-run 影响报告四维（newServices/writeTools/confidential/crossOrg）；
 *   - scope 模板生成（'*' → 服务级；白名单 → 工具级；readOnly 组不产出写工具 scope）；
 *   - 审计哈希链：record() 单点计算、prevHash 链式、重启续链、篡改可检出、附 traceId 检索；
 *   - 探活审计聚合：secret.access 按 dedupKey 窗口去重 + 窗口关闭随事件附 suppressedCount。
 */
import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { StorageService } from '../../platform-core/src/storage.ts'
import { McpService } from './index.ts'
import { SecretBroker } from './secret-broker.ts'
import { AuditService, auditHashOf } from '../../plugin-audit/src/index.ts'

const cleanup = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()()
})

/**
 * 策略面宿主：真实 McpService + 桩 iam（租户/用户）/ resourceCore / audit（审批簿）。
 * platformBus 桩记录事件供断言；usage 桩承接 recordCall 计量（demo 服务不触达）。
 */
function makeHarness(options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-policy-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  const events = []
  ctx.platformBus = {
    on: () => () => {},
    emit: (name, payload) => events.push({ name, payload }),
  }
  const storage = new StorageService(ctx, { dataDir })
  // iam 桩：org→tenant 映射可注入（org-constraint 跨租户判定面）；用户簿供 subjectUserOrg
  const tenantMap = options.tenantMap ?? {}
  const users = new Map(Object.entries(options.users ?? {}))
  ctx.iam = {
    users: () => ({ get: (id) => users.get(id) }),
    tenantOfOrg: (orgId) => tenantMap[orgId] ?? 't_default',
    resolveGroupMembers: () => [],
  }
  ctx.resourceCore = { get: () => undefined }
  // 审批簿桩：id → 审批单（cross-org 有效审批引用判定面）
  const approvals = new Map(Object.entries(options.approvals ?? {}))
  ctx.audit = { approvals: () => ({ get: (id) => approvals.get(id) }) }
  const registry = new McpService(ctx)
  return { ctx, registry, events, approvals, users }
}

/** 在线 demo 服务（确定性执行层免外呼）+ 权限组放行（'*' 全量）。 */
async function onlineService(registry, overrides = {}) {
  const service = registry.createService({
    name: '策略服务', slug: 'policy-svc', orgId: 'org-a', owner: 'tester', exec: 'demo',
    tools: [
      { name: 'policy_search', description: '检索', inputSchema: { type: 'object' }, riskLevel: 'read' },
      { name: 'policy_write', description: '写入', inputSchema: { type: 'object' }, riskLevel: 'write' },
      { name: 'policy_sync', description: '未登记风险', inputSchema: { type: 'object' }, riskLevel: 'unknown' },
    ],
    ...overrides,
  })
  await registry.deployService(service.id, { actor: 'tester' })
  registry.createPermGroup({
    name: '全放行组', description: '',
    policies: { [service.id]: { allowedTools: '*', constraints: {} } },
    subjects: [{ type: 'agent', id: 'agt-1' }],
  })
  return registry.services().get(service.id)
}

const agentCaller = (overrides = {}) => ({ type: 'agent', id: 'agt-1', name: '策略Agent', ...overrides })

// -- B（契约 §13）：org-constraint 三态 -------------------------------------------------------

test('org-constraint：org 内放行（caller.org == service.org）', async () => {
  const { registry } = makeHarness()
  const service = await onlineService(registry)
  const result = await registry.invoke(agentCaller({ orgId: 'org-a' }), service.id, 'policy_search', {})
  assert.equal(result.ok, true)
})

test('org-constraint：跨组织且跨租户 → 拒绝 ORG_SCOPE_DENIED（硬拦面）', async () => {
  const { registry } = makeHarness({ tenantMap: { 'org-a': 't-1', 'org-b': 't-2' } })
  const service = await onlineService(registry)
  const result = await registry.invoke(agentCaller({ orgId: 'org-b' }), service.id, 'policy_search', {})
  assert.equal(result.ok, false)
  assert.equal(result.status, 'denied')
  assert.equal(result.code, 'ORG_SCOPE_DENIED')
  assert.ok(result.decisionId?.startsWith('pd_'), '拒绝响应带决策 id')
  assert.ok(Array.isArray(result.decisionReasons) && result.decisionReasons.length > 0)
  // 落账：调用记录与 mcp.invoked 事件同带决策表达
  const call = registry.callLog({ serviceId: service.id, status: 'denied' }).items[0]
  assert.equal(call.code, 'ORG_SCOPE_DENIED')
  assert.equal(call.decisionId, result.decisionId)
})

test('org-constraint：跨组织同租户 + 权限组显式授权 → 放行（默认开放组织内口径）', async () => {
  const { registry } = makeHarness({ tenantMap: { 'org-a': 't-1', 'org-b': 't-1' } })
  const service = await onlineService(registry)
  const result = await registry.invoke(agentCaller({ orgId: 'org-b' }), service.id, 'policy_search', {})
  assert.equal(result.ok, true, '同租户跨组织经显式权限组授权放行（存量演示/自测数据零漂移）')
})

test('org-constraint：visibility=tenant 同租户放行、跨租户拒绝（不要求显式授权事实）', async () => {
  const { registry } = makeHarness({ tenantMap: { 'org-a': 't-1', 'org-b': 't-1', 'org-c': 't-2' } })
  const service = await onlineService(registry, { visibility: 'tenant' })
  // 跨组织同租户：tenant 三态直接放行（连权限组都不需要命中的主体也放行——这里仍给了权限组，等价面一致）
  const okResult = await registry.invoke(agentCaller({ orgId: 'org-b' }), service.id, 'policy_search', {})
  assert.equal(okResult.ok, true)
  // 跨租户：拒绝
  const denied = await registry.invoke(agentCaller({ orgId: 'org-c' }), service.id, 'policy_search', {})
  assert.equal(denied.code, 'ORG_SCOPE_DENIED')
})

test('org-constraint：visibility=cross-org 无审批拒、approved/executed 有效审批放行、过期审批拒', async () => {
  const now = Date.now()
  const { registry } = makeHarness({
    approvals: {
      'apr-ok': { id: 'apr-ok', status: 'executed', decidedAt: new Date(now - 3600_000).toISOString() },
      'apr-stale': { id: 'apr-stale', status: 'approved', decidedAt: new Date(now - 25 * 3600_000).toISOString() },
      'apr-pending': { id: 'apr-pending', status: 'pending', decidedAt: new Date(now - 60_000).toISOString() },
    },
  })
  const service = await onlineService(registry, { visibility: 'cross-org' })
  // 无审批引用：拒绝
  const noApproval = await registry.invoke(agentCaller({ orgId: 'org-b' }), service.id, 'policy_search', {})
  assert.equal(noApproval.code, 'ORG_SCOPE_DENIED')
  assert.ok(noApproval.error.includes('审批'))
  // 无效引用（pending / 过期 24h 窗外 / 不存在）：拒绝
  for (const approvalId of ['apr-pending', 'apr-stale', 'apr-none']) {
    const denied = await registry.invoke(agentCaller({ orgId: 'org-b', approvalId }), service.id, 'policy_search', {})
    assert.equal(denied.code, 'ORG_SCOPE_DENIED', `无效审批引用 ${approvalId} 必须拒绝`)
  }
  // 有效审批引用（executed 且 24h 窗内）：放行
  const okResult = await registry.invoke(agentCaller({ orgId: 'org-b', approvalId: 'apr-ok' }), service.id, 'policy_search', {})
  assert.equal(okResult.ok, true)
})

test('org-constraint：委托链 subjectUserId 的 org 与目标服务跨租户 → 同样拒绝', async () => {
  const { registry } = makeHarness({
    tenantMap: { 'org-a': 't-1', 'org-b': 't-2' },
    users: { 'u-delegate': { orgId: 'org-b' } },
  })
  const service = await onlineService(registry)
  // 调用者本身同 org 放行面，但委托链真实用户在另一租户 → 拒绝
  const result = await registry.invoke(agentCaller({ orgId: 'org-a', subjectUserId: 'u-delegate' }), service.id, 'policy_search', {})
  assert.equal(result.code, 'ORG_SCOPE_DENIED')
})

// -- C（契约 §12）：资源限定 scope 第一层 -----------------------------------------------------

test('iam-permission 第一层：unified scopes 三形态任一即放行（第二层权限组照旧强制）', async () => {
  const { registry } = makeHarness()
  const service = await onlineService(registry)
  for (const scopes of [
    ['mcp.invoke'],
    [`mcp.service:${service.slug}.invoke`],
    [`mcp.tool:${service.slug}:policy_search.invoke`],
    ['console.login', 'mcp.invoke'],
  ]) {
    const result = await registry.invoke(agentCaller({ scopes }), service.id, 'policy_search', {})
    assert.equal(result.ok, true, `scopes [${scopes.join(',')}] 应放行`)
  }
})

test('iam-permission 第一层：mcp. 前缀 scope 未覆盖本目标 → SCOPE_DENIED；legacy scopes 不设防', async () => {
  const { registry } = makeHarness()
  const service = await onlineService(registry)
  // 声明了 MCP scope 面（限定到别的服务）却调本服务：fail-closed
  const mismatch = await registry.invoke(agentCaller({ scopes: ['mcp.service:other-svc.invoke'] }), service.id, 'policy_search', {})
  assert.equal(mismatch.status, 'denied')
  assert.equal(mismatch.code, 'SCOPE_DENIED')
  // 工具级 scope 只放行对应工具
  const otherTool = await registry.invoke(agentCaller({ scopes: [`mcp.tool:${service.slug}:policy_write.invoke`] }), service.id, 'policy_search', {})
  assert.equal(otherTool.code, 'SCOPE_DENIED')
  // legacy scopes（无任何 mcp. 前缀）：第一层不设防，第二层权限组裁决 → 放行
  const legacy = await registry.invoke(agentCaller({ scopes: ['console.login'] }), service.id, 'policy_search', {})
  assert.equal(legacy.ok, true)
  // scopes 缺席（工具面 legacy 调用方）：同样不设防
  const absent = await registry.invoke(agentCaller(), service.id, 'policy_search', {})
  assert.equal(absent.ok, true)
})

test('iam-permission + 权限组双层：scope 放行不绕过权限组（无授权主体仍拒）', async () => {
  const harness = makeHarness()
  const { registry } = harness
  const service = await onlineService(registry)
  const outsider = harness && agentCaller({ id: 'agt-999', scopes: ['mcp.invoke'] })
  const result = await registry.invoke(outsider, service.id, 'policy_search', {})
  assert.equal(result.ok, false)
  assert.equal(result.status, 'denied')
  assert.ok(result.error.includes('未被任何 MCP 权限组授权'), '主因仍是权限组文案（模块序保持）')
  assert.equal(result.code, undefined, '权限组层拒绝不带新增领域码（既有口径）')
})

// -- C（契约 §14）：策略模拟 dry-run 影响报告 -------------------------------------------------

test('dry-run 影响报告：newServices/writeTools/confidential/crossOrg 四维 + subjects 原样展开（不落库）', async () => {
  const harness = makeHarness({ tenantMap: { 'org-a': 't-1', 'org-b': 't-2' } })
  const { registry } = harness
  // 主体可达 org：agent agt-1 归属 org-b（与覆盖服务 org-a 不同 → crossOrg）
  harness.ctx.resourceCore = { get: (kind, id) => (id === 'agt-1' ? { orgId: 'org-b' } : undefined) }
  const plain = await onlineService(registry)
  const confidential = registry.createService({
    name: '高敏服务', slug: 'conf-svc', orgId: 'org-a', owner: 'tester', exec: 'demo',
    dataClass: 'confidential',
    tools: [
      { name: 'conf_read', description: '读', inputSchema: { type: 'object' }, riskLevel: 'read' },
      { name: 'conf_admin', description: '管', inputSchema: { type: 'object' }, riskLevel: 'admin' },
    ],
  })
  const before = registry.permGroups().all().length
  const report = registry.dryRunPermGroup({
    name: '草稿权限组',
    policies: {
      [plain.id]: { allowedTools: ['policy_search', 'policy_write'], constraints: {} },
      [confidential.id]: { allowedTools: '*', constraints: { readOnly: true } },
      ['mcp-none']: { allowedTools: '*', constraints: {} },
    },
    subjects: [{ type: 'agent', id: 'agt-1', name: '策略Agent' }, { type: 'user_group', id: 'ug-1' }],
  })
  // newServices：覆盖已存在服务（不存在引用跳过）
  assert.deepEqual(report.newServices.map((item) => item.serviceId).sort(), [plain.id, confidential.id].sort())
  // writeTools：覆盖服务中 allowedTools 命中的 write/admin 工具（readOnly 约束不影响影响面口径——
  // 报告呈现「草稿触及哪些写能力」，约束语义由调用裁决面执行）
  assert.deepEqual(report.writeTools, [
    { serviceId: plain.id, slug: plain.slug, tool: 'policy_write' },
    { serviceId: confidential.id, slug: 'conf-svc', tool: 'conf_admin' },
  ])
  // confidential 维度
  assert.deepEqual(report.confidential, [{ serviceId: confidential.id, slug: 'conf-svc', dataClass: 'confidential' }])
  // crossOrg：主体可达 org（org-b）与覆盖服务 org（org-a）不一致 → true
  assert.equal(report.crossOrg, true)
  // affectedSubjects 原样展开
  assert.deepEqual(report.affectedSubjects, [
    { type: 'agent', id: 'agt-1', name: '策略Agent' },
    { type: 'user_group', id: 'ug-1' },
  ])
  // dry 语义：不落库
  assert.equal(registry.permGroups().all().length, before)
})

test('dry-run crossOrg：主体可达 org 与服务 org 一致 → false；org 不可判 → false（不计）', async () => {
  const harness = makeHarness()
  const { registry } = harness
  const service = await onlineService(registry)
  // 同 org 主体（resourceCore 返回 org-a）
  harness.ctx.resourceCore = { get: (kind, id) => (id === 'agt-1' ? { orgId: 'org-a' } : undefined) }
  const sameOrg = registry.dryRunPermGroup({
    policies: { [service.id]: { allowedTools: '*', constraints: {} } },
    subjects: [{ type: 'agent', id: 'agt-1' }],
  })
  assert.equal(sameOrg.crossOrg, false)
  // 主体解析不出 org：不计 crossOrg
  harness.ctx.resourceCore = { get: () => undefined }
  const unknownOrg = registry.dryRunPermGroup({
    policies: { [service.id]: { allowedTools: '*', constraints: {} } },
    subjects: [{ type: 'agent', id: 'agt-404' }],
  })
  assert.equal(unknownOrg.crossOrg, false)
})

// -- C（契约 §12）：scope 模板 -----------------------------------------------------------------

test('scope 模板：全量组产出服务级 scope；白名单组产出工具级 scope；readOnly 组不产出写工具 scope', async () => {
  const { registry } = makeHarness()
  const service = await onlineService(registry) // tools: search(read)/write(write)/sync(unknown)
  const wildcard = registry.createPermGroup({
    name: '全量组', description: '',
    policies: { [service.id]: { allowedTools: '*', constraints: {} } },
    subjects: [],
  })
  const full = registry.scopeTemplate(wildcard.id)
  assert.deepEqual(full.scopes, [`mcp.service:${service.slug}.invoke`])
  assert.deepEqual(full.byService, [{ serviceId: service.id, slug: service.slug, scopes: [`mcp.service:${service.slug}.invoke`] }])

  const readonly = registry.createPermGroup({
    name: '只读白名单组', description: '',
    policies: { [service.id]: { allowedTools: ['policy_search', 'policy_write', 'policy_sync'], constraints: { readOnly: true } } },
    subjects: [],
  })
  const scoped = registry.scopeTemplate(readonly.id)
  // readOnly 组：write 工具不产出 scope（模板=裁决面口径）；read/unknown 工具逐个产出
  assert.deepEqual(scoped.scopes, [
    `mcp.tool:${service.slug}:policy_search.invoke`,
    `mcp.tool:${service.slug}:policy_sync.invoke`,
  ])
  assert.equal(scoped.byService.length, 1)

  // 不存在的权限组：显式报错（dry 语义不打错对象）
  assert.throws(() => registry.scopeTemplate('mpg-none'), /权限组不存在/)
})

// -- D（契约 §14）：审计哈希链 -----------------------------------------------------------------

/** 构造最小审计宿主（桩总线 + usage 消费管道 + 真实 StorageService）。 */
function makeAuditHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-policy-audit-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.platformBus = { on: () => () => {}, emit: () => {} }
  ctx.usage = { consume: () => () => {}, project: () => {}, record: () => {} }
  new StorageService(ctx, { dataDir })
  return new AuditService(ctx)
}

const auditEntry = (n) => ({
  type: 'invoke', actorType: 'machine', actorId: `agt-${n}`, actorName: `Agent ${n}`,
  action: 'mcp.gateway.invoke', resourceType: 'mcp_service', resourceId: 'mcp-1', resourceName: '策略服务',
  result: 'ok', detail: `latency=${n}ms`,
})

test('审计哈希链：record() 单点计算、prevHash 链式相接、重算校验一致、链首 prevHash 为空串', () => {
  const audit = makeAuditHarness()
  const first = audit.record(auditEntry(1))
  assert.equal(first.prevHash, '')
  assert.match(first.hash, /^[0-9a-f]{64}$/)
  assert.equal(first.hash, auditHashOf(first, ''), '记录可按导出口径重算校验')
  const second = audit.record(auditEntry(2))
  assert.equal(second.prevHash, first.hash, '链式相接')
  assert.equal(second.hash, auditHashOf(second, second.prevHash))
  assert.equal(audit.chainTipHash(), second.hash)
  // 篡改可检出：改任一业务字段后重算不再命中
  const tampered = { ...second, detail: '被篡改' }
  assert.notEqual(auditHashOf(tampered, tampered.prevHash), tampered.hash)
})

test('审计哈希链：启动续链（链首重取集合最后一条 hash）与 traceId 精确检索', () => {
  const audit = makeAuditHarness()
  const withTrace = { ...auditEntry(1), traceId: 'a'.repeat(32) }
  const first = audit.record(withTrace)
  audit.record(auditEntry(2))
  // 模拟重启：链首状态复位后，record() 启动路径重取集合最后一条 hash 续链（重启不破链）
  audit.chainReady = false
  audit.chainTip = ''
  const third = audit.record(auditEntry(3))
  const lastHash = audit.logs().all().filter((item) => item.id !== third.id).at(-1).hash
  assert.equal(third.prevHash, lastHash, '启动续链取集合最后一条 hash')
  assert.equal(audit.chainTipHash(), third.hash)
  // traceId 精确检索（query 增量 filter）
  const hits = audit.query({ traceId: 'a'.repeat(32) })
  assert.equal(hits.total, 1)
  assert.equal(hits.items[0].id, first.id)
  assert.equal(audit.query({ traceId: 'b'.repeat(32) }).total, 0)
})

// -- D（契约 §14）：探活审计聚合（secret.access 窗口去重） -------------------------------------

function makeBrokerHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-policy-broker-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  const events = []
  ctx.platformBus = { on: () => () => {}, emit: (name, payload) => events.push({ name, payload }) }
  new StorageService(ctx, { dataDir })
  const broker = new SecretBroker(ctx)
  broker.probeDedupWindowMs = 30 // 窗口收窄供测试（窗口关闭可观测）
  return { broker, events }
}

test('探活审计聚合：同 dedupKey 窗口内只发一次；窗口关闭后首事件附 suppressedCount；不带键逐次留痕', async () => {
  const { broker, events } = makeBrokerHarness()
  broker.put({ serviceId: 'mcp-probe', headerName: 'Authorization', secret: 'probe-secret' })
  const accessEvents = () => events.filter((item) => item.name === 'mcp.secret.access')
  // 窗口内三次探活 resolve：只发一次
  broker.resolve('mcp-probe', { dedupKey: 'probe' })
  broker.resolve('mcp-probe', { dedupKey: 'probe' })
  broker.resolve('mcp-probe', { dedupKey: 'probe' })
  assert.equal(accessEvents().length, 1)
  // 窗口关闭（等窗口过）：下一次开窗事件附上一窗口聚合计数（2 次被抑制）
  await new Promise((resolve) => setTimeout(resolve, 45))
  broker.resolve('mcp-probe', { dedupKey: 'probe' })
  const closed = accessEvents()
  assert.equal(closed.length, 2)
  assert.equal(closed[1].payload.suppressedCount, 2)
  // 不带 dedupKey 的真实访问：逐次留痕（审计侧零改动）
  broker.resolve('mcp-probe')
  broker.resolve('mcp-probe')
  assert.equal(accessEvents().length, 4)
  // 事件 payload 恒无 secret 原文
  assert.ok(!JSON.stringify(accessEvents()).includes('probe-secret'))
})
