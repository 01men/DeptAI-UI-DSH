/**
 * 委托令牌（exchangeDelegatedToken）单测（MCP 治理契约 §3，W1-T1，2026-10-22）。
 * 运行：node --test packages/plugin-authn/src/delegation.test.mjs
 *
 * 进程内构造最小 AuthnService 宿主（内存集合 + 桩 iam/总线），覆盖：
 * 人类→agent OBO 签发、机器+userId 换取、guard 缺席/拒绝（fail-closed）、aud 形态强校验、
 * scopes 三方交集收敛、TTL 默认/上限、act 链跳数上限、verify 侧 delegate: 二次夹紧不放大、
 * 用户冻结 → 委托令牌联动吊销。
 */
import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { PlatformEvents } from '../../platform-core/src/index.ts'
import { AuthnService, DelegationError } from './index.ts'

/** 内存集合（镜像 StorageService\Collection 契约的最小面）。 */
function makeCollection(name) {
  const rows = new Map()
  const listeners = new Set()
  const fire = (kind, record) => { for (const fn of listeners) fn({ kind, record }) }
  return {
    name,
    insert(record) {
      if (rows.has(record.id)) throw new Error(`唯一约束冲突：${name}#${record.id} 已存在`)
      rows.set(record.id, { ...record })
      fire('insert', rows.get(record.id))
      return rows.get(record.id)
    },
    get: (id) => (rows.has(id) ? { ...rows.get(id) } : undefined),
    update(id, patch) {
      const current = rows.get(id)
      if (!current) throw new Error(`记录不存在：${id}`)
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete current[key]
        else current[key] = value
      }
      fire('update', current)
      return { ...current }
    },
    remove(id) {
      const had = rows.delete(id)
      if (had) fire('remove', { id })
      return had
    },
    all: () => [...rows.values()].map((row) => ({ ...row })),
    find: (predicate) => [...rows.values()].filter((row) => predicate(row)).map((row) => ({ ...row })),
    findOne: (predicate) => {
      const hit = [...rows.values()].find((row) => predicate(row))
      return hit ? { ...hit } : undefined
    },
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    uniqueOn() { /* 单测无需引擎级唯一 */ },
    count: () => rows.size,
  }
}

/** 最小宿主：桩 iam（用户表 + 实时权限表）+ 可派发总线 + 内存集合。 */
function makeHost({ users = {}, permissions = {} } = {}) {
  const ctx = new Context()
  const dir = mkdtempSync(join(tmpdir(), 'authn-delegation-'))
  const collections = new Map()
  const handlers = new Map()
  const iamStub = {
    users: () => ({ get: (id) => users[id] }),
    userPermissions: (userId) => [...(permissions[userId] ?? [])],
    resolveRolePermissions: () => [],
    roles: () => ({ get: () => ({ name: 'stub' }) }),
  }
  ctx.platformBus = {
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name).add(fn)
      return () => handlers.get(name).delete(fn)
    },
    emit: (name, payload) => {
      for (const fn of handlers.get(name) ?? []) fn(payload)
    },
  }
  ctx.iam = iamStub
  ctx.opsStorage = {
    dataDirPath: dir,
    collection: (name2) => {
      if (!collections.has(name2)) collections.set(name2, makeCollection(name2))
      return collections.get(name2)
    },
  }
  const service = new AuthnService(ctx)
  return {
    service,
    bus: ctx.platformBus,
    iam: iamStub,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

let host
test.beforeEach(() => {
  host = makeHost({
    users: {
      u001: { id: 'u001', username: 'shenyl', displayName: '沈亦澜', status: 'active', orgId: 'org1' },
      u002: { id: 'u002', username: 'frozen', displayName: '冻结者', status: 'frozen', orgId: 'org1' },
    },
    permissions: { u001: ['console.login', 'nas.read', 'usage.write'] },
  })
  seedAgentPrincipal(host.service)
})
test.afterEach(() => host.cleanup())

/** 造一个已验证人类调用者（verify 走实时权限解析，与生产同路径）。 */
function humanCaller(service) {
  const principal = service.ensureHumanPrincipal('u001', '沈亦澜')
  const { token } = service.issueToken(principal.id, { kind: 'access', issuedBy: 'password:shenyl' })
  return service.verify(token)
}

/** 造一个已验证机器调用者（agent 主体，可选预置 act 链）。 */
function machineCaller(service, actChain = []) {
  const principal = seedAgentPrincipal(service)
  const { token } = service.issueToken(principal.id, { kind: 'machine', scopes: service.resolveMachineScopes(principal), actChain, issuedBy: 'client_credentials' })
  return service.verify(token)
}

/** 预置 agent 机器主体（幂等：目标 principal 必须先于交换存在）。 */
function seedAgentPrincipal(service) {
  const existing = service.principals().findOne((item) => item.refType === 'agent' && item.refId === 'agt_1')
  return existing ?? service.principals().insert({
    id: 'pri_agt', type: 'machine', refType: 'agent', refId: 'agt_1', name: '自测机器人', status: 'active',
    scopes: ['usage.write', 'nas.read', 'plugin:nas:read'],
  })
}

test('guard 未注入：一律拒绝（fail-closed DELEGATION_GUARD_UNAVAILABLE）', async () => {
  await assert.rejects(
    () => host.service.exchangeDelegatedToken({ caller: humanCaller(host.service), targetPrincipalId: 'pri_agt', audience: 'plugin:nas' }),
    (error) => error instanceof DelegationError && error.code === 'DELEGATION_GUARD_UNAVAILABLE',
  )
})

test('人类→agent OBO 签发：sub=用户、act=调用者+目标、scopes 三方交集、jti 落库', async () => {
  host.service.setDelegationGuard(() => true)
  const caller = humanCaller(host.service)
  const { token, record } = await host.service.exchangeDelegatedToken({
    caller,
    targetPrincipalId: 'pri_agt',
    audience: 'mcp:service:demo-svc',
    scopes: ['nas.read', 'iam.user.write'],
    ttlSeconds: 900,
  })
  assert.equal(record.principalId, caller.principal.id, 'sub=用户 principal')
  assert.equal(record.delegatedUserId, 'u001')
  assert.equal(record.delegationAudience, 'mcp:service:demo-svc')
  assert.equal(record.issuedBy, `delegate:${caller.principal.id}`)
  assert.deepEqual(record.actChain.map((entry) => [entry.type, entry.name]), [['human', '沈亦澜'], ['machine', '自测机器人']])
  assert.deepEqual(record.scopes, ['nas.read'], '请求 ∩ 调用者 ∩ 目标：iam.user.write 双双不在即剔除')
  assert.equal(host.service.tokens().get(record.jti)?.jti, record.jti, 'jti 落库')

  const verified = host.service.verify(token, { audience: 'mcp:service:demo-svc' })
  assert.deepEqual(verified.scopes, ['nas.read'], 'verify 带 aud 通过且 scopes 与签发一致')
  assert.equal(verified.principal.type, 'human')
  assert.equal(verified.actChain.length, 2)
})

test('机器+userId 换取：sub=该用户、act=调用者主体、目标 scopes=用户实时权限', async () => {
  host.service.setDelegationGuard(() => true)
  // plugin: 受众沿用既有命名空间收敛（issueToken）：请求 scope 必须落在 plugin:nas: 内
  host.iam.userPermissions = (userId) => userId === 'u001'
    ? ['console.login', 'nas.read', 'usage.write', 'plugin:nas:read']
    : []
  const caller = machineCaller(host.service)
  const { record, token } = await host.service.exchangeDelegatedToken({
    caller,
    userId: 'u001',
    audience: 'plugin:nas',
    scopes: ['plugin:nas:read'],
  })
  assert.equal(record.principalId, host.service.humanPrincipal('u001').id)
  assert.equal(record.delegatedUserId, 'u001')
  assert.deepEqual(record.actChain.map((entry) => entry.type), ['machine'])
  assert.deepEqual(record.scopes, ['plugin:nas:read'], '用户实时权限 ∩ 机器 scopes ∩ 请求')
  assert.equal(host.service.verify(token).principal.refId, 'u001')

  await assert.rejects(
    () => host.service.exchangeDelegatedToken({ caller, userId: 'u001', audience: 'plugin:nas', targetPrincipalId: 'pri_agt' }),
    (error) => error.code === 'DELEGATION_TARGET_NOT_ALLOWED',
  )
  // W4 CTO 裁决（2026-10-22，落实整改计划 §6.2「Agent 自身调用」）：机器调用者不带 userId
  // 不再拒绝，而是走自委托通道——sub=自身、act 链为空、audience 绑定目标服务；
  // 长期机器凭证不出域，授权面由 scopes 三方交集夹紧到自身实时权限。
  const selfScoped = await host.service.exchangeDelegatedToken({ caller, audience: 'plugin:nas', scopes: ['plugin:nas:read'] })
  assert.equal(selfScoped.record.principalId, caller.principal.id, '自委托：sub=调用者自身')
  assert.deepEqual(selfScoped.record.actChain, [], '自委托：act 链为空（未代他人）')
  assert.equal(selfScoped.record.delegatedUserId, undefined, '自委托：无委托用户（不随用户冻结联动吊销）')
  assert.ok(selfScoped.token, '自委托换牌成功')
  await assert.rejects(
    () => host.service.exchangeDelegatedToken({ caller, userId: 'u002', audience: 'plugin:nas' }),
    (error) => error.code === 'DELEGATION_USER_INACTIVE',
  )
  await assert.rejects(
    () => host.service.exchangeDelegatedToken({ caller, userId: 'ghost', audience: 'plugin:nas' }),
    (error) => error.code === 'DELEGATION_USER_NOT_FOUND',
  )
})

test('guard 拒绝：DELEGATION_DENIED；guard 收到结构化 input（userId/targetPrincipalId/caller）', async () => {
  const seen = []
  host.service.setDelegationGuard((input) => {
    seen.push(input)
    return false
  })
  const caller = humanCaller(host.service)
  await assert.rejects(
    () => host.service.exchangeDelegatedToken({ caller, targetPrincipalId: 'pri_agt', audience: 'mcp:service:x' }),
    (error) => error.code === 'DELEGATION_DENIED',
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].userId, 'u001')
  assert.equal(seen[0].targetPrincipalId, 'pri_agt')
  assert.deepEqual([seen[0].caller.kind, seen[0].caller.refType, seen[0].caller.refId], ['human', 'user', 'u001'])
})

test('audience 形态强校验：仅接受 mcp:service:<slug> / plugin:<id>', async () => {
  host.service.setDelegationGuard(() => true)
  const caller = humanCaller(host.service)
  for (const audience of ['https://evil.example', 'mcp:service:', 'plugin:', 'mcp:xxx', 'api://x']) {
    await assert.rejects(
      () => host.service.exchangeDelegatedToken({ caller, targetPrincipalId: 'pri_agt', audience }),
      (error) => error.code === 'DELEGATION_AUDIENCE_INVALID',
      `audience=${audience} 应被拒绝`,
    )
  }
})

test('TTL：缺省 900s、7200s 收敛到上限 3600s', async () => {
  host.service.setDelegationGuard(() => true)
  const caller = humanCaller(host.service)
  const def = await host.service.exchangeDelegatedToken({ caller, targetPrincipalId: 'pri_agt', audience: 'mcp:service:a' })
  const spanDefault = (new Date(def.record.expiresAt).getTime() - new Date(def.record.issuedAt).getTime()) / 1000
  assert.ok(Math.abs(spanDefault - 900) <= 1, `缺省 TTL=900s（实际 ${spanDefault}s）`)
  const capped = await host.service.exchangeDelegatedToken({ caller, targetPrincipalId: 'pri_agt', audience: 'mcp:service:a', ttlSeconds: 7200 })
  const spanCapped = (new Date(capped.record.expiresAt).getTime() - new Date(capped.record.issuedAt).getTime()) / 1000
  assert.ok(Math.abs(spanCapped - 3600) <= 1, `TTL 上限=3600s（实际 ${spanCapped}s）`)
})

test('act 链跳数上限：human 之后 >4 跳拒绝（DELEGATION_CHAIN_TOO_LONG）', async () => {
  host.service.setDelegationGuard(() => true)
  const longChain = ['m1', 'm2', 'm3', 'm4'].map((name) => ({ principalId: `pri_${name}`, name, type: 'machine' }))
  const caller = machineCaller(host.service, longChain)
  await assert.rejects(
    () => host.service.exchangeDelegatedToken({ caller, userId: 'u001', audience: 'mcp:service:a' }),
    (error) => error.code === 'DELEGATION_CHAIN_TOO_LONG',
  )
  // 恰 4 跳可过（链首 machine 全计：4 跳 = 上限内）
  const okChain = ['m1', 'm2', 'm3'].map((name) => ({ principalId: `pri_${name}`, name, type: 'machine' }))
  const okCaller = machineCaller(host.service, okChain)
  const { record } = await host.service.exchangeDelegatedToken({ caller: okCaller, userId: 'u001', audience: 'mcp:service:a' })
  assert.equal(record.actChain.length, 4)
})

test('verify 二次夹紧：主体权限放大后委托令牌不跟随放大（delegate: 前缀同 OBO 口径）', async () => {
  host.service.setDelegationGuard(() => true)
  const caller = humanCaller(host.service)
  const { token } = await host.service.exchangeDelegatedToken({
    caller, targetPrincipalId: 'pri_agt', audience: 'mcp:service:a', scopes: ['nas.read'],
  })
  assert.deepEqual(host.service.verify(token).scopes, ['nas.read'])
  // 实时权限表此后放大为 '*'：verify 实时解析得 ['*']，但 delegate: 夹紧回签发交集 ['nas.read']
  host.iam.userPermissions = () => ['*']
  assert.deepEqual(host.service.verify(token).scopes, ['nas.read'], '放大不越出签发交集')
})

test('用户冻结联动：sub=该用户的委托令牌即时吊销（reason=user-frozen-delegation）', async () => {
  host.service.setDelegationGuard(() => true)
  const caller = machineCaller(host.service)
  const { token, record } = await host.service.exchangeDelegatedToken({ caller, userId: 'u001', audience: 'mcp:service:a' })
  assert.equal(host.service.verify(token).principal.refId, 'u001')
  host.bus.emit(PlatformEvents.UserFrozen, { userId: 'u001', username: 'shenyl', reason: '违规' })
  const after = host.service.tokens().get(record.jti)
  assert.ok(after.revokedAt, '冻结后委托令牌已标记吊销')
  assert.equal(after.revokedReason, 'user-frozen-delegation')
  assert.throws(() => host.service.verify(token), /吊销/)
})

test('人类调用者缺目标 / 目标不是 agent/app 机器主体：结构化拒绝', async () => {
  host.service.setDelegationGuard(() => true)
  const caller = humanCaller(host.service)
  await assert.rejects(
    () => host.service.exchangeDelegatedToken({ caller, audience: 'mcp:service:a' }),
    (error) => error.code === 'DELEGATION_TARGET_REQUIRED',
  )
  await assert.rejects(
    () => host.service.exchangeDelegatedToken({ caller, targetPrincipalId: 'pri_ghost', audience: 'mcp:service:a' }),
    (error) => error.code === 'DELEGATION_TARGET_INVALID',
  )
})

test('setDelegationGuard(undefined)：恢复 fail-closed 拒绝态', async () => {
  host.service.setDelegationGuard(() => true)
  host.service.setDelegationGuard(undefined)
  await assert.rejects(
    () => host.service.exchangeDelegatedToken({ caller: humanCaller(host.service), targetPrincipalId: 'pri_agt', audience: 'plugin:nas' }),
    (error) => error.code === 'DELEGATION_GUARD_UNAVAILABLE',
  )
})
