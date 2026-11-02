/**
 * 统一 Principal Resolver 纯函数单测（MCP 治理契约 §2，W1-T1，2026-10-22）。
 * 运行：node --test packages/platform-core/src/principal.test.mjs
 *
 * 覆盖面：ActEntry→ActChainNode 映射（human/machine/反查失败/external）、subjectUserId 解析、
 * authMethod 前缀推导、toCallerInfo 与既有 console 中间件产物逐字兼容、humanDelegatorOf/
 * isDelegated 委托语义、toWorkCallerRef 与 rest-gate.workCallerOf 行为等价、lookupsFromHost 接线。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  authMethodOf, humanDelegatorOf, isDelegated, lookupsFromHost,
  resolveUnifiedPrincipal, toCallerInfo, toInvokeCaller, toWorkCallerRef, unifiedFromCaller,
} from './principal.ts'
import { workCallerOf } from './rest-gate.ts'

/** 内存反查表：principalId → 主体记录（users 按 userId 另表，镜像 console 的 iam/resourceCore 取法）。 */
function makeLookups(records = {}, users = {}) {
  const table = new Map(Object.entries(records))
  const userTable = new Map(Object.entries(users))
  return lookupsFromHost({
    principalsGet: (id) => table.get(id),
    iamUserGet: (id) => userTable.get(id),
    resourceGet: (kind, id) => table.get(id)?.orgId ? { orgId: table.get(id).orgId } : undefined,
    tenantOfOrg: (orgId) => orgId ? `t_${orgId}` : undefined,
  })
}

const HUMAN = {
  id: 'pri_u1', type: 'human', refType: 'user', refId: 'u001', name: '沈亦澜', orgId: 'org_root',
}
const AGENT = {
  id: 'pri_a1', type: 'machine', refType: 'agent', refId: 'agt_1', name: '自测机器人',
}
const EXTERNAL = {
  id: 'pri_x1', type: 'machine', refType: 'external', refId: 'svc-1', name: '外部服务',
}

test('act 链映射：human → user；machine agent 反查 → agent；数组首位为发起人', async () => {
  const vp = {
    principal: AGENT,
    token: { jti: 'jti-1', issuedBy: 'delegate:pri_u1' },
    scopes: ['nas.read'],
    actChain: [
      { principalId: 'pri_u1', name: '沈亦澜', type: 'human' },
      { principalId: 'pri_a1', name: '自测机器人', type: 'machine' },
    ],
  }
  const unified = await resolveUnifiedPrincipal(vp, makeLookups({ pri_u1: HUMAN, pri_a1: AGENT }))
  assert.deepEqual(unified.actChain, [
    { kind: 'user', id: 'pri_u1', name: '沈亦澜' },
    // W4 P0-3 演进：machine 条目随附 refId（该主体绑定的资源 id），供权限组主体按资源 id 匹配
    { kind: 'agent', id: 'pri_a1', name: '自测机器人', refId: 'agt_1' },
  ])
  assert.equal(unified.kind, 'agent')
  assert.equal(unified.agentId, 'agt_1')
  assert.equal(unified.subjectUserId, 'u001', '链首 human 条目的 refId 即 subjectUserId')
  assert.equal(unified.authMethod, 'token-exchange')
  assert.equal(unified.tokenId, 'jti-1')
})

test('act 链映射：machine external → platform-service；反查失败仅保留 id（不带 name）', async () => {
  const vp = {
    principal: AGENT,
    token: { jti: 'jti-2', issuedBy: 'obo:pri_x1' },
    scopes: [],
    actChain: [
      { principalId: 'pri_x1', name: '外部服务', type: 'machine' },
      { principalId: 'pri_ghost', name: '幽灵主体', type: 'machine' },
    ],
  }
  const unified = await resolveUnifiedPrincipal(vp, makeLookups({ pri_x1: EXTERNAL }))
  assert.deepEqual(unified.actChain, [
    { kind: 'platform-service', id: 'pri_x1', name: '外部服务', refId: 'svc-1' },
    { kind: 'platform-service', id: 'pri_ghost' },
  ])
  assert.equal(unified.authMethod, 'token-exchange', 'obo: 前缀 → token-exchange')
  assert.equal(unified.subjectUserId, undefined, '链内无 human 条目 → 无 subjectUserId')
})

test('顶层主体 kind 映射：human → human+userId；machine external → platform-service', async () => {
  const humanVp = {
    principal: HUMAN,
    token: { jti: 'jti-3', issuedBy: 'password:admin' },
    scopes: ['console.login'],
    actChain: [],
  }
  const human = await resolveUnifiedPrincipal(humanVp, makeLookups({ pri_u1: HUMAN }))
  assert.equal(human.kind, 'human')
  assert.equal(human.userId, 'u001')
  assert.equal(human.refType, 'user')
  assert.equal(human.subjectUserId, 'u001', 'human 主体即自身 subject')
  assert.equal(human.authMethod, 'session')

  const extVp = {
    principal: EXTERNAL,
    token: { jti: 'jti-4', issuedBy: 'client_credentials' },
    scopes: ['mcp.invoke'],
    actChain: [],
  }
  const ext = await resolveUnifiedPrincipal(extVp, makeLookups({ pri_x1: EXTERNAL }))
  assert.equal(ext.kind, 'platform-service')
  assert.equal(ext.refType, 'external')
  assert.equal(ext.authMethod, 'client-credentials')
})

test('authMethod 前缀推导：全部 issuedBy 形态 + 推导不出缺省 client-credentials', () => {
  assert.equal(authMethodOf('delegate:pri_u1'), 'token-exchange')
  assert.equal(authMethodOf('obo:pri_a1'), 'token-exchange')
  assert.equal(authMethodOf('client_credentials'), 'client-credentials')
  assert.equal(authMethodOf('entry-ticket:agent:agt_1'), 'entry-ticket')
  assert.equal(authMethodOf('sso:dingtalk'), 'oidc-code')
  assert.equal(authMethodOf('sso-bind:dingtalk'), 'oidc-code')
  assert.equal(authMethodOf('sso-register:dingtalk'), 'oidc-code')
  assert.equal(authMethodOf('password:admin'), 'session')
  assert.equal(authMethodOf('refresh-rotation'), 'session')
  assert.equal(authMethodOf('refresh-grace'), 'session')
  assert.equal(authMethodOf('demo'), 'demo')
  assert.equal(authMethodOf('console:沈亦澜'), 'client-credentials', '推导不出 → client-credentials')
  assert.equal(authMethodOf(undefined), 'client-credentials')
})

test('toCallerInfo：与既有 console 鉴权中间件产物逐字等价（human / machine 两形态）', async () => {
  const humanUnified = await resolveUnifiedPrincipal({
    principal: HUMAN,
    token: { jti: 'jti-5', issuedBy: 'password:admin' },
    scopes: ['console.login', 'nas.read'],
    actChain: [],
  }, makeLookups({ pri_u1: HUMAN }))
  assert.deepEqual(toCallerInfo(humanUnified), {
    kind: 'human',
    principalId: 'pri_u1',
    userId: 'u001',
    name: '沈亦澜',
    permissions: ['console.login', 'nas.read'],
    actChain: [],
  })

  const agentUnified = await resolveUnifiedPrincipal({
    principal: AGENT,
    token: { jti: 'jti-6', issuedBy: 'obo:pri_u1' },
    scopes: ['nas.read'],
    actChain: [{ principalId: 'pri_u1', name: '沈亦澜', type: 'human' }],
  }, makeLookups({ pri_u1: HUMAN, pri_a1: AGENT }))
  assert.deepEqual(toCallerInfo(agentUnified), {
    kind: 'machine',
    principalId: 'pri_a1',
    refType: 'agent',
    refId: 'agt_1',
    name: '自测机器人',
    permissions: ['nas.read'],
    actChain: [{ principalId: 'pri_u1', name: '沈亦澜', type: 'human' }],
  }, 'actChain 投影保持旧 ActEntry 形态（principalId/name/type，type 回投 human|machine）')
})

test('humanDelegatorOf / isDelegated：链首 human、人类本人无链、机器代人类主体三态', async () => {
  const lookups = makeLookups({ pri_u1: HUMAN, pri_a1: AGENT })
  const plain = await resolveUnifiedPrincipal({
    principal: HUMAN, token: { jti: 'a', issuedBy: 'password:x' }, scopes: [], actChain: [],
  }, lookups)
  assert.equal(isDelegated(plain), false)
  assert.equal(humanDelegatorOf(plain), null, '普通会话无委托链 → null')

  const obo = await resolveUnifiedPrincipal({
    principal: AGENT,
    token: { jti: 'b', issuedBy: 'obo:pri_u1' },
    scopes: [],
    actChain: [{ principalId: 'pri_u1', name: '沈亦澜', type: 'human' }],
  }, lookups)
  assert.equal(isDelegated(obo), true)
  assert.deepEqual(humanDelegatorOf(obo), { userId: 'u001', name: '沈亦澜' })

  const delegatedHuman = await resolveUnifiedPrincipal({
    principal: HUMAN,
    token: { jti: 'c', issuedBy: 'delegate:pri_a1' },
    scopes: [],
    actChain: [{ principalId: 'pri_a1', name: '自测机器人', type: 'machine' }],
  }, lookups)
  assert.deepEqual(humanDelegatorOf(delegatedHuman), { userId: 'u001', name: '沈亦澜' },
    '机器凭证代用户换取的委托令牌：主体本人即发起人')

  const lookupBroken = await resolveUnifiedPrincipal({
    principal: AGENT,
    token: { jti: 'd', issuedBy: 'obo:pri_u1' },
    scopes: [],
    actChain: [{ principalId: 'pri_u1', name: '沈亦澜', type: 'human' }],
  }, makeLookups({}))
  assert.equal(humanDelegatorOf(lookupBroken), null, '反查失败 fail-safe → null（回落既有事实源）')
})

test('toWorkCallerRef 与 rest-gate.workCallerOf 行为等价（含 unifiedFromCaller 回投）', async () => {
  const unified = await resolveUnifiedPrincipal({
    principal: AGENT,
    token: { jti: 'e', issuedBy: 'client_credentials' },
    scopes: ['nas.read'],
    actChain: [],
  }, makeLookups({ pri_a1: AGENT }))
  const expected = {
    kind: 'machine', principalId: 'pri_a1', refType: 'agent', refId: 'agt_1', name: '自测机器人',
  }
  assert.deepEqual(toWorkCallerRef(unified), expected)

  const callerInfo = toCallerInfo(unified)
  assert.deepEqual(workCallerOf(callerInfo), expected, 'rest-gate 委托 principal.ts 后对外行为不变')
  assert.deepEqual(workCallerOf({
    kind: 'human', principalId: 'pri_u1', userId: 'u001', name: '沈亦澜', permissions: ['*'], actChain: [],
  }), { kind: 'human', principalId: 'pri_u1', userId: 'u001', name: '沈亦澜' })
  assert.deepEqual(workCallerOf(unifiedFromCaller({
    kind: 'human', principalId: 'pri_u1', userId: 'u001', name: '沈亦澜', permissions: ['*'], actChain: [],
  })), { kind: 'human', principalId: 'pri_u1', userId: 'u001', name: '沈亦澜' })
})

test('toInvokeCaller：human → user；machine agent → agent + onBehalfOf 取链首', async () => {
  const unified = await resolveUnifiedPrincipal({
    principal: AGENT,
    token: { jti: 'f', issuedBy: 'obo:pri_u1' },
    scopes: [],
    actChain: [{ principalId: 'pri_u1', name: '沈亦澜', type: 'human' }],
  }, makeLookups({ pri_u1: HUMAN, pri_a1: AGENT }))
  const caller = toInvokeCaller(unified)
  assert.equal(caller.type, 'agent')
  assert.equal(caller.id, 'agt_1')
  assert.equal(caller.onBehalfOf, '沈亦澜')
  assert.deepEqual(caller.actChain, [{ name: '沈亦澜', type: 'human' }])

  const plainHuman = await resolveUnifiedPrincipal({
    principal: HUMAN, token: { jti: 'g', issuedBy: 'password:x' }, scopes: [], actChain: [],
  }, makeLookups({ pri_u1: HUMAN }))
  const invoke = toInvokeCaller(plainHuman)
  assert.deepEqual({ type: invoke.type, id: invoke.id }, { type: 'user', id: 'u001' })
  assert.equal(invoke.onBehalfOf, undefined, '非委托不产出 onBehalfOf')
})

test('lookupsFromHost：orgOf 按 user/agent/app 反查 orgId+tenantId，缺席返回 null', async () => {
  const lookups = makeLookups({ pri_a1: { ...AGENT, orgId: 'org_ai' }, agt_1: { ...AGENT, orgId: 'org_ai' } }, { u001: { orgId: 'org_root' } })
  assert.deepEqual(await lookups.orgOf({ kind: 'user', id: 'u001' }), { orgId: 'org_root', tenantId: 't_org_root' })
  assert.deepEqual(await lookups.orgOf({ kind: 'agent', id: 'agt_1' }), { orgId: 'org_ai', tenantId: 't_org_ai' })
  assert.equal(await lookups.orgOf({ kind: 'app', id: 'nope' }), null)
  assert.equal(await lookups.principalOf('pri_ghost'), null)
})
