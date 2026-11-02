/** #17：真实面板服务 → 模型服务 → usage 回执；仅上游 HTTP 使用隔离模拟。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PanelService } from './service.ts'
import { ModelGatewayService } from '../../plugin-modelgw/src/index.ts'

function fixture(t, { deptOrg = 'rd', assetOrg = 'ops', noOrgs = false } = {}) {
  const events = [],
    orgs = noOrgs
      ? []
      : [
          { id: 'root', parentId: null },
          { id: 'rd', parentId: 'root' },
          { id: 'ops', parentId: 'root' },
        ]
  const model = {
    slug: 'test',
    endpoint: 'https://model.invalid',
    apiKey: '',
    status: 'online',
  }
  const agent = {
    id: 'a',
    slug: 'writer',
    name: '执行官',
    orgId: assetOrg,
    attrs: { model: 'test' },
  }
  const dept = {
    id: 'rd',
    label: '研发',
    orgId: deptOrg,
    agents: [{ name: '执行官', agentRef: 'agent:a', desc: '研究' }],
  }
  const skills = [
    {
      id: 's',
      slug: 'research',
      name: '研究技能',
      orgId: 'ops',
      summary: 'research',
      status: 'published',
      visibility: 'all',
      targetOrgs: [],
      currentVersion: '1',
      versions: [
        { version: '1', status: 'published', content: 'Summarize sources.' },
      ],
      stats: { downloads: 1 },
    },
    {
      id: 'private',
      slug: 'restricted',
      name: '受限技能',
      orgId: 'root',
      summary: 'private',
      status: 'published',
      visibility: 'orgs',
      targetOrgs: ['root'],
      currentVersion: '1',
      versions: [{ version: '1', status: 'published', content: 'Restricted material' }],
      stats: { downloads: 0 },
    },
  ]
  let upstream = 0
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => {
    upstream++
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    }
  }
  t.after(() => {
    globalThis.fetch = oldFetch
  })
  const ctx = {
    iam: {
      users: () => ({
        get: (id) => (id === 'u' ? { orgId: 'ops' } : id === 'r' ? { orgId: 'root' } : undefined),
      }),
      orgs: () => ({
        all: () => orgs,
        get: (id) => orgs.find((o) => o.id === id),
      }),
    },
    resourceCore: { list: () => [agent] },
    skillHub: {
      skills: () => ({
        all: () => skills,
        get: (id) => skills.find((s) => s.id === id),
      }),
    },
    usage: {
      priceOfResource: () => ({ cost_cents_per_unit: 0 }),
      record: (event) => {
        assert.ok(event.org.trim())
        events.push(event)
        return { event_id: `e${events.length}`, pricing: { cost_cents: 0 } }
      },
    },
    platformBus: { emit() {} },
  }
  // 面板架构统一（2026-10-29）后服务端经 ctx.reflect 软读可选宿主服务——夹具同步接线。
  ctx.reflect = { get: (key) => ctx[key] }
  const gateway = Object.create(ModelGatewayService.prototype)
  Object.defineProperty(gateway, 'ctx', { value: ctx })
  gateway.recordTelemetry = () => {}
  ctx.modelGateway = {
    models: () => ({ all: () => [model] }),
    invoke: (input) => gateway.invokeTracked(model, input, 1000, false),
  }
  const panel = Object.create(PanelService.prototype)
  Object.defineProperty(panel, 'ctx', { value: ctx })
  panel.dept = () => dept
  panel.sceneSummaryForDept = () => ''
  panel.managedWorkforceOf = async () => undefined
  panel.auditSafe = () => {}
  panel.meterResource = () => 'panel:rd'
  return { panel, gateway, model, events, upstream: () => upstream }
}

test('机器主体 Agent 调用继承部门组织，用户组织仍优先 #17', async (t) => {
  const f = fixture(t)
  assert.equal((await f.panel.askAgent('rd', '执行官', 'OK')).ok, true)
  assert.equal(f.events.find((e) => e.resource === 'model:test').org, 'rd')
  assert.deepEqual(
    f.events[0].meters.map((m) => m.value),
    [5, 3],
  )
  assert.equal(
    (await f.panel.askAgent('rd', '执行官', 'OK', { userId: 'u' })).ok,
    true,
  )
  assert.equal(
    f.events.filter((e) => e.resource === 'model:test').at(-1).org,
    'ops',
  )
  assert.equal(f.upstream(), 2)
})
test('无部门归属时回落平台根组织 #17', async (t) => {
  const f = fixture(t, { deptOrg: undefined })
  // 参数缺省会使用 fixture 默认值，此处明确覆盖服务端部门记录。
  f.panel.dept = () => ({
    id: 'rd',
    label: '研发',
    agents: [{ name: '执行官', agentRef: 'agent:a' }],
  })
  assert.equal((await f.panel.askAgent('rd', '执行官', 'OK')).ok, true)
  assert.equal(f.events[0].org, 'root')
})
test('技能计量归属回落不改变可见性边界 #17', async (t) => {
  const f = fixture(t)
  const result = await f.panel.invokeSkill('研究技能', 'OK')
  assert.equal(result.ok, true)
  assert.equal(f.events[0].org, 'root')
  assert.equal(f.events.filter((e) => e.resource === 'model:test').length, 1)
  const denied = await f.panel.invokeSkill('受限技能', 'OK')
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /未对当前用户组织开放/)
  assert.equal(
    f.upstream(),
    1,
    '根组织计量兜底不能授权机器主体读取根组织私有技能',
  )
  const permitted = await f.panel.invokeSkill('受限技能', 'OK', { userId: 'r' })
  assert.equal(permitted.ok, true, '有真实根组织归属的用户仍可调用根组织技能')
  assert.equal(f.upstream(), 2)
})
test('无法解析组织时在上游请求之前失败 #17', async (t) => {
  const f = fixture(t, { noOrgs: true })
  f.panel.dept = () => ({ id: 'rd', label: '研发', agents: [{ name: '执行官', agentRef: 'agent:a' }] })
  const result = await f.panel.askAgent('rd', '执行官', 'OK')
  assert.equal(result.ok, false)
  assert.match(result.reason, /模型调用缺少组织归属/)
  assert.equal(f.upstream(), 0)
  assert.equal(f.events.length, 0)
  await assert.rejects(
    f.gateway.invokeTracked(
      f.model,
      { orgId: '  ', subject: 'machine:test', messages: [] },
      1000,
      false,
    ),
    /模型调用缺少组织归属/,
  )
  assert.equal(f.upstream(), 0)
})
