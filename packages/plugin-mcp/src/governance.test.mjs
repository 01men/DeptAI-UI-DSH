/**
 * MCP 治理字段与 Secret Broker 单元测试（W1-T2，契约 §5/§6）。
 *
 * 运行方式（Node 直接加载，进程内构造，参照 approval.test.mjs 桩件风格）：
 *
 *     node packages/plugin-mcp/src/governance.test.mjs
 *
 * 覆盖面：
 *   - 存量迁移幂等（ensureGovernanceMigration 跑两遍结果一致）与字段默认值；
 *   - 治理字段枚举校验（非法值显式报错）与 updateService 白名单收敛；
 *   - 明文敏感头门禁（plainSensitiveHeaderViolation + MCP_ALLOW_PLAIN_HEADERS 逃生门）；
 *   - SecretBroker put/resolve/rotate/delete、文件权限 0600、审计事件零明文；
 *   - env: 形态读取与缺失回落、vault:/external: 不支持前缀 fail-closed；
 *   - 明文敏感头迁移（migratePlainHeaders dryRun 预检 + 执行后 headers 清键 + broker 命中）；
 *   - resolveCallHeaders 注入顺序（本地 echo 服务端到端：存量非敏感头保留 + 凭证覆盖同名键）。
 */
import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { StorageService } from '../../platform-core/src/storage.ts'
import { McpService, normalizeGovernanceInput } from './index.ts'
import { SecretBroker, plainSensitiveHeaderViolation, sensitiveHeaderKeys } from './secret-broker.ts'

// -- 进程内构造宿主（桩总线 + 真实 StorageService + 临时数据目录） ----------------------------

const cleanup = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()()
})

function makeHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcp-governance-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  const events = []
  // 桩总线：记录 emit 供审计断言（on 返回空注销函数）
  ctx.platformBus = {
    on: () => () => {},
    emit: (name, payload) => events.push({ name, payload }),
  }
  new StorageService(ctx, { dataDir })
  const registry = new McpService(ctx)
  const broker = new SecretBroker(ctx)
  registry.attachSecretBroker(broker)
  return { ctx, registry, broker, events, dataDir }
}

/** 直插一条「存量无治理字段」的服务记录（模拟迁移前的旧库形态）。 */
function insertLegacyService(registry, overrides = {}) {
  return registry.services().insert({
    id: 'mcp-legacy-1',
    name: '存量服务',
    slug: 'legacy-svc',
    description: '',
    icon: 'mcp',
    endpoint: '',
    transport: 'http',
    mode: 'hosted',
    orgId: 'org-1',
    owner: 'someone',
    status: 'draft',
    grayPercent: 0,
    currentVersion: '0.1.0',
    versions: [],
    tools: [],
    health: { status: 'unknown', consecutiveFails: 0, breakerOpen: false },
    stability: 0.9,
    rateLimitPerMin: 60,
    exec: 'demo',
    ...overrides,
  })
}

// -- §5 治理字段：默认值 / 校验 / 迁移幂等 -------------------------------------------------

test('治理字段默认值：createService 缺省补 ownerEntity=platform/gateway/internal/prod/org', () => {
  const { registry } = makeHarness()
  const service = registry.createService({ name: '默认治理', orgId: 'org-1', owner: 'u1' })
  assert.deepEqual(service.ownerEntity, { type: 'platform' })
  assert.equal(service.exposureMode, 'gateway')
  assert.equal(service.dataClass, 'internal')
  assert.equal(service.environment, 'prod')
  assert.equal(service.visibility, 'org')
})

test('治理字段校验：枚举非法值显式报错（dataClass/exposureMode/ownerEntity.type/visibility）', () => {
  const { registry } = makeHarness()
  assert.throws(() => registry.createService({ name: 'x', orgId: 'o', owner: 'u', dataClass: 'topsecret' }), /dataClass/)
  assert.throws(() => registry.createService({ name: 'x', orgId: 'o', owner: 'u', exposureMode: 'tunnel' }), /exposureMode/)
  assert.throws(() => registry.createService({ name: 'x', orgId: 'o', owner: 'u', ownerEntity: { type: 'team' } }), /ownerEntity/)
  assert.throws(() => registry.createService({ name: 'x', orgId: 'o', owner: 'u', visibility: 'world' }), /visibility/)
  const service = registry.createService({ name: 'x', orgId: 'o', owner: 'u' })
  assert.throws(() => registry.updateService(service.id, { environment: 'lab' }), /environment/)
  // 合法值可写入
  const updated = registry.updateService(service.id, { environment: 'staging', dataClass: 'confidential' })
  assert.equal(updated.environment, 'staging')
  assert.equal(updated.dataClass, 'confidential')
})

test('normalizeGovernanceInput：ownerEntity.id 空白归一为仅 type（治理待办按缺 id 判 unowned）', () => {
  assert.deepEqual(normalizeGovernanceInput({ ownerEntity: { type: 'app', id: '  ' } }).ownerEntity, { type: 'app' })
  assert.deepEqual(normalizeGovernanceInput({ ownerEntity: { type: 'app', id: ' app-9 ' } }).ownerEntity, { type: 'app', id: 'app-9' })
})

test('存量迁移幂等：跑两遍结果一致（第二遍零写入、marker 只落一条）', () => {
  const { registry } = makeHarness()
  const legacy = insertLegacyService(registry)
  const first = registry.ensureGovernanceMigration()
  assert.equal(first.applied, true)
  assert.ok(first.touched.includes(legacy.id))
  const afterFirst = registry.services().get(legacy.id)
  assert.deepEqual(afterFirst.ownerEntity, { type: 'platform' })
  assert.equal(afterFirst.exposureMode, 'gateway')
  assert.equal(afterFirst.dataClass, 'internal')
  assert.equal(afterFirst.environment, 'prod')
  assert.equal(afterFirst.visibility, 'org')
  // 幂等重跑：零写入、applied=false、迁移 marker 唯一
  const second = registry.ensureGovernanceMigration()
  assert.deepEqual(second.touched, [])
  assert.equal(second.applied, false)
  assert.equal(registry.ctx.opsStorage.collection('mcp:migrations').find((item) => item.key === 'mcp-governance-v1').length, 1)
  // 两遍之后记录的治理字段完全一致
  assert.deepEqual(
    (({ ownerEntity, exposureMode, dataClass, environment, visibility }) => ({ ownerEntity, exposureMode, dataClass, environment, visibility }))(registry.services().get(legacy.id)),
    (({ ownerEntity, exposureMode, dataClass, environment, visibility }) => ({ ownerEntity, exposureMode, dataClass, environment, visibility }))(afterFirst),
  )
})

test('治理待办摘要：unowned / plainHeaderServices / nonGateway 分组与总量', () => {
  const { registry } = makeHarness()
  registry.createService({ name: '待指派', slug: 'unowned-svc', orgId: 'o', owner: 'u' })
  registry.createService({
    name: '已指派直连', slug: 'assigned-direct', orgId: 'o', owner: 'u',
    ownerEntity: { type: 'app', id: 'app-1' }, exposureMode: 'direct',
  })
  registry.createService({ name: '带明文头', slug: 'plain-header', orgId: 'o', owner: 'u', headers: { 'X-API-Key': 'k-1', Note: 'safe' } })
  const summary = registry.governanceSummary()
  assert.ok(summary.unowned.some((item) => item.serviceId.includes('unowned') || item.serviceName === '待指派'))
  assert.ok(!summary.unowned.some((item) => item.serviceName === '已指派直连'))
  assert.equal(summary.plainHeaderServices.length, 1)
  assert.deepEqual(summary.plainHeaderServices[0].keys, ['X-API-Key'])
  assert.equal(summary.nonGateway.length, 1)
  assert.equal(summary.nonGateway[0].exposureMode, 'direct')
  assert.equal(summary.totals.services, 3)
  assert.equal(summary.totals.plainHeader, 1)
})

// -- §6 门禁：敏感头口径与逃生门 ------------------------------------------------------------

test('敏感头口径：与 maskServiceHeaders 同判（authorization/token/secret/key 不分大小写与位置）', () => {
  assert.deepEqual(sensitiveHeaderKeys({ Authorization: 'a', 'X-API-Key': 'b', 'client-secret': 'c', 'X-Token': 'd', Note: 'e' }),
    ['Authorization', 'X-API-Key', 'client-secret', 'X-Token'])
  assert.deepEqual(sensitiveHeaderKeys(undefined), [])
  assert.deepEqual(sensitiveHeaderKeys({ 'X-App-Id': 'a' }), [])
})

test('明文敏感头门禁：默认拒绝、MCP_ALLOW_PLAIN_HEADERS=1 逃生门放行', () => {
  const headers = { Authorization: 'Bearer tk-1', 'X-App-Id': 'keep' }
  assert.deepEqual(plainSensitiveHeaderViolation(headers), ['Authorization'])
  try {
    process.env.MCP_ALLOW_PLAIN_HEADERS = '1'
    assert.deepEqual(plainSensitiveHeaderViolation(headers), [])
    assert.deepEqual(plainSensitiveHeaderViolation({ Authorization: 'x' }), [])
  } finally {
    delete process.env.MCP_ALLOW_PLAIN_HEADERS
  }
  assert.deepEqual(plainSensitiveHeaderViolation(headers), ['Authorization'], '逃生门关闭后恢复拒绝')
})

// -- §6 SecretBroker：put/resolve/rotate/delete/审计零明文 ---------------------------------

test('SecretBroker put/resolve/rotate/delete：同名再 put 即轮换，describe 永不返回原文', () => {
  const { registry, broker, events } = makeHarness()
  const first = broker.put({ serviceId: 'mcp-x1', headerName: 'X-API-Key', secret: 'secret-value-1' })
  assert.deepEqual(first.headerNames, ['X-API-Key'])
  assert.equal(broker.resolve('mcp-x1')[0].secret, 'secret-value-1')
  // 轮换（rotate）
  broker.put({ serviceId: 'mcp-x1', headerName: 'X-API-Key', secret: 'secret-value-2' })
  const rotated = broker.resolve('mcp-x1')
  assert.equal(rotated.length, 1)
  assert.equal(rotated[0].secret, 'secret-value-2')
  // describe 零原文
  const description = broker.describe('mcp-x1')
  assert.ok(!JSON.stringify(description).includes('secret-value'))
  assert.equal(description.credentialRef, 'local:mcp-x1')
  // 未登记 resolve miss
  assert.equal(broker.resolve('mcp-none'), null)
  // 删除
  assert.equal(broker.delete('mcp-x1'), true)
  assert.equal(broker.resolve('mcp-x1'), null)
  assert.equal(broker.delete('mcp-x1'), false)
  // 审计事件存在且 payload 绝无 secret 原文
  const accesses = events.filter((item) => item.name === 'mcp.secret.access')
  assert.ok(accesses.length >= 2)
  for (const item of accesses) {
    const text = JSON.stringify(item.payload)
    assert.ok(!text.includes('secret-value-1') && !text.includes('secret-value-2'), `审计事件不得携带值：${text}`)
    assert.ok(item.payload.serviceId === 'mcp-x1' && item.payload.credentialRef)
  }
})

test('SecretBroker 密钥文件权限：目录 0700 / 文件 0600；业务集合零密钥', () => {
  const { registry, broker, dataDir } = makeHarness()
  broker.put({ serviceId: 'mcp-x2', headerName: 'Authorization', secret: 'bearer-secret-9' })
  const file = join(dataDir, 'secrets', 'mcp', 'mcp-x2.json')
  assert.ok(existsSync(file))
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(dataDir, 'secrets', 'mcp')).mode & 0o777, 0o700)
  // 业务集合（内存与落盘 JSON）零密钥
  assert.ok(!JSON.stringify(registry.services().all()).includes('bearer-secret-9'))
  mkdirSync(dataDir, { recursive: true })
  const raw = readFileSync(file, 'utf8')
  assert.ok(raw.includes('bearer-secret-9'), '密钥只落 broker 专用文件')
})

test('SecretBroker env: 形态：取进程环境变量；缺失 resolve 返回 null 并留一次审计；拒绝携明文', () => {
  const { broker, events } = makeHarness()
  assert.throws(() => broker.put({ serviceId: 'mcp-e1', credentialRef: 'env:MCP_TEST_GOV_TOKEN', headerName: 'Authorization', secret: 'should-fail' }), /不落明文/)
  broker.put({ serviceId: 'mcp-e1', credentialRef: 'env:MCP_TEST_GOV_TOKEN', headerName: 'Authorization' })
  process.env.MCP_TEST_GOV_TOKEN = 'env-resolved-7'
  assert.equal(broker.resolve('mcp-e1')[0].secret, 'env-resolved-7')
  delete process.env.MCP_TEST_GOV_TOKEN
  assert.equal(broker.resolve('mcp-e1'), null)
  const missing = events.filter((item) => item.name === 'mcp.secret.access' && item.payload.result === 'missing')
  assert.equal(missing.length, 1, 'env 缺失记一次访问审计')
  assert.ok(!JSON.stringify(missing[0].payload).includes('env-resolved-7'))
})

test('SecretBroker unsupported 前缀：vault:/external: 登记与取值均抛 CREDENTIAL_BROKER_UNSUPPORTED', () => {
  const { broker, dataDir } = makeHarness()
  assert.throws(() => broker.put({ serviceId: 'mcp-v1', credentialRef: 'vault:kv/data/x', secret: 'v' }), /CREDENTIAL_BROKER_UNSUPPORTED/)
  assert.throws(() => broker.put({ serviceId: 'mcp-v2', credentialRef: 'external:http://x', secret: 'v' }), /CREDENTIAL_BROKER_UNSUPPORTED/)
  // 存量手写文件形态（迁移期可能落盘）resolve 同样 fail-closed
  const file = join(dataDir, 'secrets', 'mcp', 'mcp-v3.json')
  mkdirSync(join(dataDir, 'secrets', 'mcp'), { recursive: true })
  writeFileSync(file, JSON.stringify({ credentialRef: 'vault:prod', secrets: [{ headerName: 'Authorization', secret: 'v' }], updatedAt: new Date().toISOString() }), 'utf8')
  assert.throws(() => broker.resolve('mcp-v3'), /CREDENTIAL_BROKER_UNSUPPORTED/)
})

// -- §6 明文敏感头迁移 ----------------------------------------------------------------------

test('migratePlainHeaders：dryRun 预检 → 执行后 headers 清敏感键、broker 命中、credentialRef 回写', () => {
  const { registry, broker } = makeHarness()
  const service = registry.createService({
    name: '带明文头服务', slug: 'plain-auth', orgId: 'o', owner: 'u', mode: 'external',
    endpoint: 'https://plain.example.com/mcp',
    headers: { Authorization: 'Bearer migrate-me', 'X-App-Id': 'keep-app', 'x-api-secret': 'also-sensitive' },
  })
  const dry = registry.migratePlainHeaders({ dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.candidates, [{ serviceId: service.id, serviceName: '带明文头服务', keys: ['Authorization', 'x-api-secret'] }])
  // dryRun 不改数据
  assert.equal(registry.services().get(service.id).headers.Authorization, 'Bearer migrate-me')
  const result = registry.migratePlainHeaders()
  assert.equal(result.dryRun, false)
  assert.equal(result.migrated, 1)
  const migrated = registry.services().get(service.id)
  assert.equal(migrated.headers.Authorization, undefined)
  assert.equal(migrated.headers['x-api-secret'], undefined)
  assert.equal(migrated.headers['X-App-Id'], 'keep-app', '非敏感头保留')
  assert.equal(migrated.credentialRef, `local:${service.id}`)
  const resolved = broker.resolve(service.id)
  assert.deepEqual(resolved.map((item) => item.headerName).sort(), ['Authorization', 'x-api-secret'])
  assert.ok(resolved.find((item) => item.headerName === 'Authorization').secret, 'Bearer migrate-me')
  // 再跑：无候选（幂等，不重复迁移）
  assert.deepEqual(registry.migratePlainHeaders({ dryRun: true }).candidates, [])
  assert.equal(registry.migratePlainHeaders().migrated, 0)
})

// -- §6 注入点：resolveCallHeaders 组装顺序（经 syncTools 端到端打本地 echo 服务端） ------------

test('resolveCallHeaders：存量非敏感头保留 + 凭证覆盖同名键 + Authorization 注入（端到端）', async () => {
  const { registry, broker } = makeHarness()
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const message = JSON.parse(body)
      seen.push({ path: request.url, method: message.method, headers: request.headers })
      response.setHeader('content-type', 'application/json')
      if (message.method === 'initialize') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }))
        return
      }
      if (message.method === 'tools/list') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo_tool', description: 'x', inputSchema: { type: 'object' } }] } }))
        return
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => server.close())
  const port = server.address().port
  const service = registry.createService({
    name: 'echo', slug: 'echo-inject', orgId: 'o', owner: 'u', mode: 'external', exec: 'real',
    endpoint: `http://127.0.0.1:${port}/mcp`,
    headers: { 'X-App-Id': 'from-record' },
    tools: [],
  })
  broker.put({ serviceId: service.id, headerName: 'Authorization', secret: 'from-broker' })
  broker.put({ serviceId: service.id, headerName: 'X-App-Id', secret: 'broker-overrides' })
  const updated = await registry.syncTools(service.id)
  assert.equal(updated.tools.length, 1)
  assert.equal(updated.tools[0].name, 'echo_tool')
  assert.ok(seen.length >= 2, 'initialize + tools/list 两个外呼都应带凭证')
  for (const request of seen) {
    assert.equal(request.headers['authorization'], 'from-broker', 'broker 凭证按 headerName 注入')
    assert.equal(request.headers['x-app-id'], 'broker-overrides', '同名键凭证覆盖存量明文头')
  }
})

test('purgeService 连带清除 Broker 密钥文件（不落孤儿密钥）', () => {
  const { registry, broker, dataDir } = makeHarness()
  const service = registry.createService({ name: '待删', slug: 'to-purge', orgId: 'o', owner: 'u' })
  registry.offlineService(service.id, 'tester', '清理')
  broker.put({ serviceId: service.id, headerName: 'Authorization', secret: 'do-not-orphan' })
  const file = join(dataDir, 'secrets', 'mcp', `${service.id}.json`)
  assert.ok(existsSync(file))
  registry.purgeService(service.id)
  assert.equal(existsSync(file), false)
  assert.equal(broker.describe(service.id), null)
})

test('setOwnerEntity：归属指派落库（资源存在性校验在 REST 层经 resourceCore）', () => {
  const { registry } = makeHarness()
  const service = registry.createService({ name: '指派目标', slug: 'assign-me', orgId: 'o', owner: 'u' })
  const updated = registry.setOwnerEntity(service.id, { type: 'app', id: ' app-77 ' })
  assert.deepEqual(updated.ownerEntity, { type: 'app', id: 'app-77' })
  assert.throws(() => registry.setOwnerEntity(service.id, { type: 'department' }), /ownerEntity/)
  // 治理摘要随之摘除 unowned
  const summary = registry.governanceSummary()
  assert.ok(!summary.unowned.some((item) => item.serviceId === service.id))
})
