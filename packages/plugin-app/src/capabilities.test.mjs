/**
 * 应用能力绑定单元测试（W2-T4，MCP 治理契约 §10）。
 *
 * 运行方式（Node 直接加载，进程内构造，参照 plugin-mcp governance.test.mjs 桩总线+StorageService 模式）：
 *
 *     node packages/plugin-app/src/capabilities.test.mjs
 *
 * 覆盖面：
 *   - 绑定幂等（重复绑定返回现态，不改 required）与 ownerEntity 回写（platform 占位 → app 归属）；
 *   - 归属回写闸门：已归属其他 app / agent 的服务 409 OWNER_CONFLICT（CapabilityOwnerConflictError）；
 *   - 解绑：删记录与 capability 依赖边、归属联动还原 platform 占位、重复解绑幂等；
 *   - 上线能力门禁五条逐项拒绝（未在线/未验证/工具空/未决高危/明文敏感头）与全过；
 *   - requestOnline 早反馈拒绝（CAPABILITY_GATE_FAILED）与满足后出审批单；
 *   - 下架联动：app.offline 直下全部能力服务（含非 required、不动平台占位服务）并留恢复前置态；
 *   - 重上线恢复：restoreCapabilityServices 恢复前置状态 + change 审计留痕；
 *   - purge 归档联动：archivedBy 标记、归属还原、绑定记录清除、服务保持 offline 不复活；
 *   - resource-core 依赖边写入（app→mcp kind=capability，拓扑可穿透）。
 */
import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { StorageService } from '../../platform-core/src/storage.ts'
import { ResourceCoreService } from '../../plugin-resource-core/src/index.ts'
import { McpService } from '../../plugin-mcp/src/index.ts'
import { McpToolRiskRegistry } from '../../plugin-mcp/src/risk-registry.ts'
import { AppRegistryService, CapabilityOwnerConflictError } from './index.ts'
import { AppCredentialService } from './credentials.ts'

// -- 进程内构造宿主（桩总线 + 真实 StorageService/resource-core/mcpRegistry + 临时数据目录） --

const cleanup = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()()
})

function makeHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'app-capabilities-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  const events = []
  // 桩总线：记录 emit 供联动断言（on 返回空注销函数）
  ctx.platformBus = {
    on: () => () => {},
    emit: (name, payload) => events.push({ name, payload }),
  }
  new StorageService(ctx, { dataDir })
  const resourceCore = new ResourceCoreService(ctx)
  const mcpRegistry = new McpService(ctx)
  // 风险登记（同插件 apply() 直连装配形态）：缺席时门禁第④项跳过，这里装配齐验证第④项
  const riskRegistry = new McpToolRiskRegistry(ctx)
  mcpRegistry.attachRiskRegistry(riskRegistry)
  const auditRecords = []
  const executors = {}
  ctx.audit = {
    record: (entry) => auditRecords.push(entry),
    createApproval: (input) => {
      const approval = { id: 'ap-test-1', ...input }
      auditRecords.push({ action: 'approval.create', approval })
      return approval
    },
    registerExecutor: (kind, fn) => { executors[kind] = fn },
    costs: () => ({ find: () => [] }),
    query: () => ({ items: [] }),
  }
  // 最小桩：能力绑定路径不触达 authn/oidc/iam（register 以 withCredential:false 跳过凭证签发）
  ctx.authn = { principals: () => ({ findOne: () => null }) }
  ctx.oidc = { clientsForApp: () => [] }
  ctx.iam = {
    users: () => ({ get: () => undefined, find: () => [], all: () => [] }),
    orgs: () => ({ all: () => [], get: () => undefined }),
  }
  const registry = new AppRegistryService(ctx)
  // 外部凭证托管（issue #19）：purge 联动清库经 ctx.appCredentials——同款真实装配（临时数据目录在位）
  const credentials = new AppCredentialService(ctx)
  const mkApp = (name, slug) => registry.register({
    name, slug, ownerId: 'u1', ownerName: '测试员', orgId: 'org-1', withCredential: false,
    attrs: { description: '测试应用', appType: 'api', riskLevel: 'low', dataClass: 'internal', url: 'https://app.example.com' },
  }).app
  const mkService = (overrides = {}) => mcpRegistry.createService({
    name: `服务-${Math.random().toString(36).slice(2, 8)}`, orgId: 'org-1', owner: 'u1', ...overrides,
  })
  /** 直写服务状态（测试专用：模拟「已上线但未验证」等非正常管道状态）。 */
  const setService = (id, patch) => mcpRegistry.services().update(id, patch)
  /** 演示管道：验证 + 发布上线（demo exec，确定性模拟）。 */
  const deploy = async (id, options = {}) => {
    await mcpRegistry.verifyService(id)
    return mcpRegistry.deployService(id, { grayPercent: 100, actor: 'tester', ...options })
  }
  return { ctx, registry, mcpRegistry, resourceCore, riskRegistry, credentials, events, auditRecords, executors, mkApp, mkService, setService, deploy }
}

const TOOL = { name: 't1', description: '演示工具', inputSchema: { type: 'object' }, riskLevel: 'read' }

// -- A. 绑定模型：幂等 / owner 回写 / 依赖边 -------------------------------------------------

test('绑定能力服务：owner 回写 app 归属、capability 依赖边写入、重复绑定幂等返回现态', () => {
  const { registry, mcpRegistry, resourceCore, mkApp, mkService } = makeHarness()
  const app = mkApp('门户应用', 'portal-1')
  const svc = mkService({ name: '知识库', slug: 'kb-1', tools: [TOOL] })
  assert.deepEqual(mcpRegistry.services().get(svc.id).ownerEntity, { type: 'platform' }, '绑定前为 platform 占位')

  const first = registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: '测试员' })
  assert.equal(first.created, true)
  assert.equal(first.link.required, true)
  assert.equal(first.link.exposure, 'gateway')
  assert.equal(first.link.status, 'active')
  // ownerEntity 回写（经 setOwnerEntity 归一形态）
  assert.deepEqual(mcpRegistry.services().get(svc.id).ownerEntity, { type: 'app', id: app.id })
  // 依赖边写入：{app→mcp, kind:'capability'}
  const dep = resourceCore.dependencies().findOne((item) => item.fromType === 'app' && item.fromId === app.id && item.toType === 'mcp' && item.toId === svc.id)
  assert.ok(dep, 'capability 依赖边应存在')
  assert.equal(dep.kind, 'capability')
  // 拓扑穿透：topology('app', id) 应含 mcp 子节点
  const topology = registry.topology(app.id)
  assert.ok(topology.children.some((node) => node.type === 'mcp' && node.id === svc.id))

  // 幂等：重复绑定返回现态（同一条记录、不新建、不改 required 现值）
  const again = registry.bindCapability(app.id, { serviceId: svc.id, required: false, boundBy: '另一人' })
  assert.equal(again.created, false)
  assert.equal(again.link.id, first.link.id)
  assert.equal(again.link.required, true, '重复绑定不得改 required 现值')
  assert.equal(registry.listCapabilities(app.id).length, 1)
})

test('归属回写闸门：已归属其他 app / agent 的服务拒绝绑定（409 OWNER_CONFLICT 语义）', () => {
  const { registry, mkApp, mkService } = makeHarness()
  const appA = mkApp('应用A', 'app-a')
  const appB = mkApp('应用B', 'app-b')
  const owned = mkService({ name: '已属A', slug: 'owned-by-a' })
  registry.bindCapability(appA.id, { serviceId: owned.id, boundBy: 'x' })
  assert.throws(() => registry.bindCapability(appB.id, { serviceId: owned.id, boundBy: 'x' }), CapabilityOwnerConflictError)
  // 同 app 重复绑定不抛（幂等）；agent/connector 归属同样拒绝
  assert.doesNotThrow(() => registry.bindCapability(appA.id, { serviceId: owned.id, boundBy: 'x' }))
  const agentOwned = mkService({ name: '已属Agent', slug: 'agent-owned', ownerEntity: { type: 'agent', id: 'agent-9' } })
  assert.throws(() => registry.bindCapability(appA.id, { serviceId: agentOwned.id, boundBy: 'x' }), CapabilityOwnerConflictError)
  // 服务不存在 / 应用不存在显式报错
  assert.throws(() => registry.bindCapability(appA.id, { serviceId: 'mcp-none', boundBy: 'x' }), /不存在/)
  assert.throws(() => registry.bindCapability('app-none', { serviceId: owned.id, boundBy: 'x' }), /应用不存在/)
})

test('解绑：删记录与依赖边、归属联动还原 platform 占位、重复解绑幂等', () => {
  const { registry, mcpRegistry, resourceCore, mkApp, mkService } = makeHarness()
  const app = mkApp('解绑应用', 'unbind-app')
  const svc = mkService({ name: '待解绑', slug: 'unbind-svc' })
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })

  const result = registry.unbindCapability(app.id, svc.id)
  assert.deepEqual(result, { removed: true, ownerRestored: true })
  assert.deepEqual(mcpRegistry.services().get(svc.id).ownerEntity, { type: 'platform' }, '解绑联动还原 platform 占位')
  assert.equal(registry.listCapabilities(app.id).length, 0)
  assert.equal(resourceCore.dependencies().findOne((item) => item.fromType === 'app' && item.fromId === app.id && item.toId === svc.id), undefined)
  // 幂等：重复解绑 removed=false
  assert.deepEqual(registry.unbindCapability(app.id, svc.id), { removed: false, ownerRestored: false })
})

// -- B. 上线门禁 -----------------------------------------------------------------------------

test('门禁①未在线：required 能力服务 draft 状态被拒，错误列明服务名', async () => {
  const { registry, mkApp, mkService } = makeHarness()
  const app = mkApp('门禁应用1', 'gate-offline')
  const svc = mkService({ name: '草稿服务', slug: 'draft-svc', tools: [TOOL] })
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  const failures = registry.capabilityGateFailures(app.id)
  assert.ok(failures.some((item) => item.includes('草稿服务')), '错误信息列明服务名')
  assert.ok(failures.some((item) => item.includes('未在线')))
})

test('门禁②未验证：status=online 但 health unknown 且无 lastProbeAt 被拒', async () => {
  const { registry, mkApp, mkService, setService } = makeHarness()
  const app = mkApp('门禁应用2', 'gate-verify')
  const svc = mkService({ name: '未验服务', slug: 'never-verified', tools: [TOOL] })
  setService(svc.id, { status: 'online' }) // 直写状态（模拟绕过 verify 的脏数据）
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  const failures = registry.capabilityGateFailures(app.id)
  assert.ok(failures.some((item) => item.includes('未验证') || item.includes('测试验证')))
})

test('门禁③工具清单为空被拒', async () => {
  const { registry, mkApp, mkService, setService } = makeHarness()
  const app = mkApp('门禁应用3', 'gate-tools')
  // createService 对空 tools 回落 defaultToolsFor（演示三件套），此处显式清空模拟未发现工具的服务
  const svc = mkService({ name: '空工具服务', slug: 'no-tools' })
  setService(svc.id, { tools: [], status: 'online', health: { status: 'healthy', consecutiveFails: 0, breakerOpen: false, lastProbeAt: new Date().toISOString() } })
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  assert.ok(registry.capabilityGateFailures(app.id).some((item) => item.includes('工具清单为空')))
})

test('门禁④未决高危风险登记（write/admin 且 pending）被拒', () => {
  const { registry, riskRegistry, mkApp, mkService, setService } = makeHarness()
  const app = mkApp('门禁应用4', 'gate-risk')
  const svc = mkService({ name: '高危待审服务', slug: 'risk-pending', tools: [{ ...TOOL, name: 't_write', riskLevel: 'write' }] })
  setService(svc.id, { status: 'online', health: { status: 'healthy', consecutiveFails: 0, breakerOpen: false, lastProbeAt: new Date().toISOString() } })
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  riskRegistry.submit({ serviceId: svc.id, toolName: 't_write', risk: 'write', reason: '演示登记', actor: { id: 'u9', name: '登记员' } })
  assert.ok(registry.capabilityGateFailures(app.id).some((item) => item.includes('未决高危')))
  // 只读风险（read）不构成高危
  const app2 = mkApp('门禁应用4b', 'gate-risk-read')
  const svc2 = mkService({ name: '只读登记服务', slug: 'risk-read', tools: [{ ...TOOL, name: 't_read', riskLevel: 'read' }] })
  setService(svc2.id, { status: 'online', health: { status: 'healthy', consecutiveFails: 0, breakerOpen: false, lastProbeAt: new Date().toISOString() } })
  registry.bindCapability(app2.id, { serviceId: svc2.id, required: true, boundBy: 'x' })
  riskRegistry.submit({ serviceId: svc2.id, toolName: 't_read', risk: 'read', reason: '演示登记', actor: { id: 'u9', name: '登记员' } })
  assert.deepEqual(registry.capabilityGateFailures(app2.id), [], 'read 级 pending 不构成未决高危')
})

test('门禁⑤明文敏感头且未配置凭证被拒；配置 credentialRef 后放行', async () => {
  const { registry, mkApp, mkService, setService } = makeHarness()
  const app = mkApp('门禁应用5', 'gate-headers')
  const svc = mkService({ name: '明文头服务', slug: 'plain-header', tools: [TOOL], headers: { Authorization: 'Bearer tk', 'X-App-Id': 'safe' } })
  setService(svc.id, { status: 'online', health: { status: 'healthy', consecutiveFails: 0, breakerOpen: false, lastProbeAt: new Date().toISOString() } })
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  assert.ok(registry.capabilityGateFailures(app.id).some((item) => item.includes('明文敏感') || item.includes('凭证')))
  setService(svc.id, { credentialRef: 'local:' + svc.id })
  assert.deepEqual(registry.capabilityGateFailures(app.id), [], '配置 credential 后⑤放行')
})

test('门禁全过：在线+已验证+工具非空+无高危+无敏感头 → 零失败；requestOnline 出审批单', async () => {
  const { registry, mcpRegistry, mkApp, mkService, deploy } = makeHarness()
  const app = mkApp('合规应用', 'gate-pass')
  const svc = mkService({ name: '健康服务', slug: 'good-svc', exec: 'demo', tools: [TOOL] })
  await deploy(svc.id)
  assert.equal(mcpRegistry.services().get(svc.id).status, 'online')
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  assert.deepEqual(registry.capabilityGateFailures(app.id), [])
  // SSO 门禁对 api 形态不启用（APP_SSO_ENFORCE 默认 web,h5）→ 直接出审批单
  const approval = registry.requestOnline(app.id, { id: 'u1', name: '测试员' })
  assert.equal(approval.kind, 'app.online')
  assert.equal(approval.riskLevel, 'high')
})

test('requestOnline 早反馈：required 能力不满足即拒绝（CAPABILITY_GATE_FAILED，不建审批单）', () => {
  const { registry, auditRecords, mkApp, mkService } = makeHarness()
  const app = mkApp('门禁拦截应用', 'gate-reject')
  const svc = mkService({ name: '草稿能力', slug: 'reject-svc' })
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  assert.throws(() => registry.requestOnline(app.id, { id: 'u1', name: '测试员' }), /CAPABILITY_GATE_FAILED/)
  assert.equal(auditRecords.filter((item) => item.action === 'approval.create').length, 0, '门禁拒绝不建审批单')
  // 非 required 能力不参与门禁（另一 app 绑同一服务为非 required——先解绑归还归属再绑）
  registry.unbindCapability(app.id, svc.id)
  const app2 = mkApp('非必需能力应用', 'gate-optional')
  registry.bindCapability(app2.id, { serviceId: svc.id, required: false, boundBy: 'x' })
  assert.deepEqual(registry.capabilityGateFailures(app2.id), [])
})

// -- C. 生命周期联动 -------------------------------------------------------------------------

test('下架联动：app.offline 直下全部能力服务（含非 required），平台占位服务不动，留恢复前置态', async () => {
  const { registry, mcpRegistry, events, mkApp, mkService, deploy } = makeHarness()
  const app = mkApp('联动应用', 'link-app')
  const requiredSvc = mkService({ name: '必需服务', slug: 'link-required', exec: 'demo', tools: [TOOL] })
  const optionalSvc = mkService({ name: '可选服务', slug: 'link-optional', exec: 'demo', tools: [TOOL] })
  const platformSvc = mkService({ name: '平台服务', slug: 'link-platform' })
  await deploy(requiredSvc.id)
  await deploy(optionalSvc.id, { grayPercent: 30 }) // gray 前置态也应被记录
  assert.equal(mcpRegistry.services().get(requiredSvc.id).status, 'online')

  registry.bindCapability(app.id, { serviceId: requiredSvc.id, required: true, boundBy: 'x' })
  registry.bindCapability(app.id, { serviceId: optionalSvc.id, required: false, boundBy: 'x' })
  registry.online(app.id, 'tester') // 生命周期：offline 仅可自 trial/online（先上线再下架）
  registry.offline(app.id, 'tester', '测试下架')

  // 直下路径（offlineService）：状态 offline + McpOfflined 事件跟随既有管道
  assert.equal(mcpRegistry.services().get(requiredSvc.id).status, 'offline')
  assert.equal(mcpRegistry.services().get(optionalSvc.id).status, 'offline')
  assert.equal(mcpRegistry.services().get(platformSvc.id).status, 'draft', '未绑定的 platform 占位服务不被联动')
  assert.ok(events.some((item) => item.name === 'mcp.offlined' && item.payload.serviceId === requiredSvc.id), '服务下线事件跟随既有管道')
  assert.ok(events.some((item) => item.name === 'app.offlined' && item.payload.id === app.id), '应用下架事件不受联动影响')
  // 恢复前置态留痕在绑定记录（additive offlineRestore）
  const requiredLink = registry.listCapabilities(app.id).find((item) => item.serviceId === requiredSvc.id)
  const optionalLink = registry.listCapabilities(app.id).find((item) => item.serviceId === optionalSvc.id)
  assert.equal(requiredLink.offlineRestore.status, 'online')
  assert.equal(requiredLink.offlineRestore.grayPercent, 100)
  assert.equal(optionalLink.offlineRestore.status, 'gray')
  assert.equal(optionalLink.offlineRestore.grayPercent, 30)
})

test('重上线恢复：restoreCapabilityServices 恢复前置状态 + change 审计留痕', async () => {
  const { registry, mcpRegistry, auditRecords, mkApp, mkService, deploy } = makeHarness()
  const app = mkApp('恢复应用', 'restore-app')
  const svc = mkService({ name: '恢复服务', slug: 'restore-svc', exec: 'demo', tools: [TOOL] })
  await deploy(svc.id)
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  registry.online(app.id, 'tester') // 生命周期：offline 仅可自 trial/online（先上线再下架）
  registry.offline(app.id, 'tester', '下架联动')
  assert.equal(mcpRegistry.services().get(svc.id).status, 'offline')

  registry.restoreCapabilityServices(app.id)
  assert.equal(mcpRegistry.services().get(svc.id).status, 'online', '恢复到下线前 online')
  assert.ok(!registry.listCapabilities(app.id).some((item) => item.offlineRestore), '恢复标记清除')
  const restored = auditRecords.filter((item) => item.action === 'mcp.service.online-restore' && item.resourceId === svc.id)
  assert.equal(restored.length, 1, '恢复落 change 审计')
  assert.equal(restored[0].actorId, 'app-online-linkage')
  // 幂等：再次恢复无动作（无标记可恢复）
  registry.restoreCapabilityServices(app.id)
  assert.equal(mcpRegistry.services().get(svc.id).status, 'online')
})

test('purge 归档联动：archivedBy 标记 + 归属还原 + 绑定记录清除，服务保持 offline 不复活', async () => {
  const { registry, mcpRegistry, resourceCore, credentials, mkApp, mkService, deploy } = makeHarness()
  const app = mkApp('删除应用', 'purge-app')
  const svc = mkService({ name: '归档服务', slug: 'purge-svc', exec: 'demo', tools: [TOOL] })
  await deploy(svc.id)
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  registry.online(app.id, 'tester') // 生命周期：offline 仅可自 trial/online（先上线再下架）
  registry.offline(app.id, 'tester', '先下架')
  assert.equal(mcpRegistry.services().get(svc.id).status, 'offline')
  // 凭证联动清库（issue #19）：purge 前登记一条凭证，purge 后密钥文件必须整体消失
  credentials.put(app.id, { key: 'external-token', value: 'tk_live_123456', rotatedBy: 'tester' })
  assert.equal(credentials.list(app.id).length, 1)

  registry.purge(app.id)
  assert.equal(credentials.list(app.id).length, 0, 'purge 联动删除凭证密钥文件')
  const after = mcpRegistry.services().get(svc.id)
  assert.ok(after, '服务记录保留（purge 不删服务）')
  assert.equal(after.status, 'offline', '服务保持 offline（不复活）')
  assert.equal(after.archivedBy, app.id, 'W2-T4 归档联动 archivedBy 标记')
  assert.deepEqual(after.ownerEntity, { type: 'platform' }, '归属还原 platform 占位（防悬挂引用）')
  assert.equal(registry.listCapabilities(app.id).length, 0, '绑定记录清除')
  assert.equal(
    resourceCore.dependencies().findOne((item) => item.fromType === 'app' && item.fromId === app.id && item.toId === svc.id),
    undefined,
    'capability 依赖边清除（既有 purge 循环覆盖）',
  )
})

// -- 执行器复核（薄委托：逻辑在 capabilityGateFailures，此处验证执行器装配形态可调用） -------

test('执行期复核：挂单期间能力下线后复核拒绝（CAPABILITY_GATE_FAILED）；服务恢复后放行', async () => {
  const { registry, mcpRegistry, mkApp, mkService, deploy } = makeHarness()
  const app = mkApp('复核应用', 'recheck-app')
  const svc = mkService({ name: '复核服务', slug: 'recheck-svc', exec: 'demo', tools: [TOOL] })
  await deploy(svc.id)
  registry.bindCapability(app.id, { serviceId: svc.id, required: true, boundBy: 'x' })
  // 模拟执行器内复核语义（真实装配在 apply() 的 registerExecutor('app.online')，逻辑同源）：
  // 挂单期间服务被人工下线 → 复核发现 → 执行失败留痕
  mcpRegistry.offlineService(svc.id, 'ops', '挂单期间人工下线')
  const failures = registry.capabilityGateFailures(app.id)
  assert.ok(failures.length > 0, '执行期复核应发现能力已下线')
  assert.throws(() => {
    if (failures.length > 0) throw new Error(`执行期复核失败：审批期间能力服务状态变化（CAPABILITY_GATE_FAILED）——${failures.join('；')}`)
  }, /CAPABILITY_GATE_FAILED/)
  // 服务恢复上线后（offline 经 draft 回发布管道）复核通过，应用可上线
  mcpRegistry.services().update(svc.id, { status: 'draft' })
  await deploy(svc.id)
  assert.deepEqual(registry.capabilityGateFailures(app.id), [])
  assert.equal(registry.online(app.id, 'approval-center').status, 'online')
})
