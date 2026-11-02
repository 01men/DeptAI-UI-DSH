/**
 * IAM 域路由（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出——组织/账号/角色 CRUD、场景级授权（角色×场景 ABAC）、
 * 用户组（静态/动态 + 快照重算）、三方连接器配置与同步、全员名册、同步冲突处置。
 * 处理器逐字搬运（行为与迁出前一致）；manageActor（QA A-03 操作者上下文）与
 * decorateUser（账号回显脱敏）为本域专用，随迁。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../../platform-core/src/index.ts'
import { OrgScopeDeniedError, PermissionCatalog, type UserManageActor } from '../../../plugin-iam/src/index.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'

/**
 * R11 多公司清单收口（2026-10-14）：非 `*` 管理员的可见组织子树集合（null=全量豁免）。
 * 人类主体按自身 orgId 收敛（无组织=fail-closed 空集）；机器主体解析其归属 Agent 的
 * orgId（refType=agent）。agents/apps/approvals 等清单路由 import 复用。
 */
export function scopedOrgIdsOf(
  ctx: Context,
  caller: ConsoleRouteDeps['caller'],
  exchange: HttpExchange,
): string[] | null {
  const info = caller(exchange)
  if (info.permissions.includes('*')) return null
  let orgId = info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined
  if (!orgId && info.kind === 'machine' && info.refType === 'agent' && info.refId) {
    orgId = ctx.resourceCore.collection('agent').get(info.refId)?.orgId
  }
  return orgId ? ctx.iam.orgSubtreeIds(orgId) : []
}

/** scopedOrgIdsOf 的过滤形态：返回谓词（null=全量豁免）；空子树=fail-closed 仅可见无归属记录。 */
export function scopedOrgFilterOf(
  ctx: Context,
  caller: ConsoleRouteDeps['caller'],
  exchange: HttpExchange,
): ((orgId: string | undefined) => boolean) | null {
  const scope = scopedOrgIdsOf(ctx, caller, exchange)
  if (scope === null) return null
  const allow = new Set(scope)
  return (orgId) => !orgId || allow.has(orgId)
}

export function registerIamRoutes(ctx: Context, deps: ConsoleRouteDeps): void {
  const { guarded, body, changeLog, caller } = deps

  /** 账号管理操作者上下文（QA A-03）：传给 iam 服务层做组织归属校验（非平台管理员限本组织子树）。 */
  const manageActor = (exchange: HttpExchange): UserManageActor => {
    const info = caller(exchange)
    return { userId: info.userId, permissions: info.permissions }
  }

  /** 权限点目录展示视图：Catalog 常量为中文数据（t() 的键），回显处按请求语言即时翻译。 */
  const permissionCatalogView = () => PermissionCatalog.map((item) => ({ ...item, label: t(item.label), group: t(item.group) }))

  /**
   * 管理面处理器包扎（N4）：跨组织拒绝（iam 服务层 OrgScopeDeniedError）在此回写 403 FORBIDDEN——
   * guarded 兜底把裸 Error 一律落 400 BAD_REQUEST，而跨组织拒绝是鉴权语义而非请求格式错误；
   * 其余错误原样上抛走既有 400 兜底。包扎形态保持 guarded( 字面量注册，契约 linter 提取不受影响。
   */
  const manageScope = (handler: (exchange: HttpExchange) => unknown): ((exchange: HttpExchange) => Promise<unknown>) => {
    return async (exchange) => {
      try {
        return await handler(exchange)
      } catch (error) {
        if (error instanceof OrgScopeDeniedError) {
          exchange.fail(403, 'FORBIDDEN', error.message)
          return
        }
        throw error
      }
    }
  }

  /**
   * R11 多公司清单收口（见模块级 scopedOrgFilter 导出）：组织清单/树按调用者子树收敛。
   */
  const scopedOrgIds = (exchange: HttpExchange): string[] | null => scopedOrgIdsOf(ctx, caller, exchange)

  // -- IAM ----------------------------------------------------------------
  // R11：组织清单/树按调用者子树收敛（`*` 豁免全量）——「一个部署跑多家公司」的读面隔离
  guarded('GET', '/api/iam/orgs/tree', 'iam.org.read', (exchange) => {
    const scope = scopedOrgIds(exchange)
    if (scope === null) return ctx.iam.orgTree()
    const rootId = scope[0]
    if (!rootId) return []
    const findIn = (nodes: ReturnType<typeof ctx.iam.orgTree>, id: string): ReturnType<typeof ctx.iam.orgTree> | null => {
      for (const node of nodes) {
        if (node.id === id) return [node]
        const hit = findIn(node.children ?? [], id)
        if (hit) return hit
      }
      return null
    }
    return rootId ? (findIn(ctx.iam.orgTree(), rootId) ?? []) : []
  })

  guarded('GET', '/api/iam/orgs', 'iam.org.read', (exchange) => {
    const scope = scopedOrgIds(exchange)
    if (scope === null) return ctx.iam.orgs().all()
    const allow = new Set(scope)
    return ctx.iam.orgs().all().filter((org) => allow.has(org.id))
  })

  guarded('POST', '/api/iam/orgs', 'iam.org.write', manageScope((exchange) => {
    const input = body<{ name: string; parentId?: string | null; order?: number }>(exchange)
    const org = ctx.iam.createOrg(input, manageActor(exchange))
    changeLog(exchange, 'iam.org.create', 'org', org.id, org.name)
    return org
  }))

  guarded('PATCH', '/api/iam/orgs/:id', 'iam.org.write', manageScope((exchange) => {
    const input = body<{ name?: string; parentId?: string | null; leaderUserIds?: string[] }>(exchange)
    const actor = manageActor(exchange)
    if (input.name !== undefined) {
      const org = ctx.iam.renameOrg(exchange.params['id']!, input.name, actor)
      changeLog(exchange, 'iam.org.rename', 'org', org.id, org.name)
    }
    if (input.parentId !== undefined) {
      ctx.iam.moveOrg(exchange.params['id']!, input.parentId, actor)
      changeLog(exchange, 'iam.org.move', 'org', exchange.params['id']!, input.parentId)
    }
    if (Array.isArray(input.leaderUserIds)) {
      const org = ctx.iam.setOrgLeaders(exchange.params['id']!, input.leaderUserIds)
      changeLog(exchange, 'iam.org.leaders', 'org', org.id, org.name, t('负责人：{leaders}', { leaders: input.leaderUserIds.join(',') || t('（清空）') }))
    }
    return ctx.iam.orgs().get(exchange.params['id']!)
  }))

  guarded('DELETE', '/api/iam/orgs/:id', 'iam.org.write', manageScope((exchange) => {
    const input = body<{ cascade?: boolean }>(exchange)
    const result = ctx.iam.deleteOrg(exchange.params['id']!, { cascade: input.cascade === true }, manageActor(exchange))
    changeLog(exchange, 'iam.org.delete', 'org', exchange.params['id']!, '',
      input.cascade ? t('级联一键删除：移除组织 {orgs} 个，账号上移 {users} 人', { orgs: result.removedOrgs, users: result.movedUsers }) : '')
    return result
  }))

  // N3：非平台级管理员的账号清单自动收敛到管辖组织子树（含子组织）；显式 ?orgId= 落在子树外
  // 显式 403（对齐 /api/agents?org= 越界不静默收窄的先例），平台超管（'*'）不受限
  guarded('GET', '/api/iam/users', 'iam.user.read', (exchange) => {
    const orgId = exchange.query.get('orgId') ?? undefined
    const status = exchange.query.get('status') ?? undefined
    const q = exchange.query.get('q') ?? undefined
    const scope = scopedOrgIds(exchange)
    if (orgId && scope !== null && !scope.includes(orgId)) {
      exchange.fail(403, 'FORBIDDEN', t('查询组织超出调用者的组织子树（组织隔离）'))
      return
    }
    // 分页（测试 §9）：page/pageSize 可选，缺省返回全量保持旧客户端兼容
    const pageParam = Number(exchange.query.get('page') ?? 0)
    const sizeParam = Number(exchange.query.get('pageSize') ?? 0)
    const paginated = Number.isInteger(pageParam) && pageParam > 0 && Number.isInteger(sizeParam) && sizeParam > 0
    const page = paginated ? pageParam : 0
    const pageSize = paginated ? Math.min(500, sizeParam) : 0
    const users = ctx.iam.listUsers({
      ...(orgId ? { orgId } : {}),
      ...(status ? { status } : {}),
      ...(q ? { q } : {}),
      ...(scope !== null ? { scopeOrgIds: scope } : {}),
    })
    const sliced = page > 0 && pageSize > 0 ? users.slice((page - 1) * pageSize, page * pageSize) : users
    return {
      total: users.length,
      ...(page > 0 && pageSize > 0 ? { page, pageSize } : {}),
      users: sliced.map((user) => decorateUser(ctx, user)),
    }
  })

  guarded('POST', '/api/iam/users', 'iam.user.write', manageScope((exchange) => {
    const input = body<{ username: string; displayName: string; orgId: string; title?: string; email?: string; phone?: string; roleIds?: string[]; password?: string }>(exchange)
    const actor = manageActor(exchange)
    const { user, initialPassword } = ctx.iam.createUser(input, actor)
    if (input.roleIds?.length) ctx.iam.assignRoles(user.id, input.roleIds, actor)
    ctx.iam.activateUser(user.id, actor)
    changeLog(exchange, 'iam.user.create', 'user', user.id, user.displayName)
    return { ...decorateUser(ctx, ctx.iam.users().get(user.id)!), ...(initialPassword ? { initialPassword } : {}) }
  }))

  guarded('POST', '/api/iam/users/:id/reset-password', 'iam.user.write', manageScope((exchange) => {
    const { password } = body<{ password?: string }>(exchange)
    const { user, initialPassword } = ctx.iam.resetPassword(exchange.params['id']!, password, manageActor(exchange))
    changeLog(exchange, 'iam.user.reset_password', 'user', user.id, user.displayName, password ? t('设置为指定口令') : t('重置为随机初始口令'))
    return { id: user.id, username: user.username, initialPassword }
  }))

  guarded('POST', '/api/iam/users/import', 'iam.user.write', manageScope((exchange) => {
    const { items } = body<{ items: Array<{ username: string; displayName: string; orgId: string; title?: string; email?: string }> }>(exchange)
    const result = ctx.iam.importUsers(items ?? [], manageActor(exchange))
    changeLog(exchange, 'iam.user.import', 'user', '', '', t('新建 {created}，跳过 {skipped}', { created: result.created.length, skipped: result.skipped.length }))
    return { created: result.created.map((user) => decorateUser(ctx, user)), skipped: result.skipped }
  }))

  guarded('PATCH', '/api/iam/users/:id', 'iam.user.write', manageScope((exchange) => {
    const input = body<{ displayName?: string; email?: string; phone?: string; title?: string; orgId?: string; roleIds?: string[]; accountType?: 'internal' | 'external' | 'suspended-review'; primaryOrgId?: string }>(exchange)
    const actor = manageActor(exchange)
    const { roleIds, ...patch } = input
    const user = ctx.iam.updateUser(exchange.params['id']!, patch, actor)
    if (roleIds) ctx.iam.assignRoles(user.id, roleIds, actor)
    changeLog(exchange, 'iam.user.update', 'user', user.id, user.displayName)
    return decorateUser(ctx, ctx.iam.users().get(user.id)!)
  }))

  for (const [action, permission] of [
    ['activate', 'iam.user.write'],
    ['freeze', 'iam.user.freeze'],
    ['unfreeze', 'iam.user.freeze'],
    ['deactivate', 'iam.user.freeze'],
  ] as const) {
    guarded('POST', `/api/iam/users/:id/${action}`, permission, manageScope((exchange) => {
      const { reason } = body<{ reason?: string }>(exchange)
      const id = exchange.params['id']!
      const actor = manageActor(exchange)
      const user = action === 'activate' ? ctx.iam.activateUser(id, actor)
        : action === 'freeze' ? ctx.iam.freezeUser(id, reason ?? '', actor)
          : action === 'unfreeze' ? ctx.iam.unfreezeUser(id, actor)
            : ctx.iam.deactivateUser(id, reason ?? '', actor)
      changeLog(exchange, `iam.user.${action}`, 'user', user.id, user.displayName, reason ?? '')
      return decorateUser(ctx, user)
    }))
  }

  guarded('POST', '/api/iam/users/:id/bindings', 'iam.user.write', manageScope((exchange) => {
    const input = body<{ provider: 'dingtalk' | 'feishu' | 'wecom'; unionId: string; displayName?: string; verifyCode?: string; corpId?: string }>(exchange)
    const user = ctx.iam.bindThirdParty(exchange.params['id']!, { ...input, displayName: input.displayName ?? input.unionId }, manageActor(exchange))
    changeLog(exchange, 'iam.user.bind', 'user', user.id, user.displayName, input.provider)
    return decorateUser(ctx, user)
  }))

  // 解绑三方身份：`?corpId=` 限定到单一主体（多主体部署下只解绑该企业），缺省=该 provider 全部。
  // 解绑会写入 bindingExemptions（连接器同步不再自动补回），并在审计 detail 里写明主体与豁免事实。
  guarded('DELETE', '/api/iam/users/:id/bindings/:provider', 'iam.user.write', manageScope(async (exchange) => {
    const { verifyCode } = body<{ verifyCode: string }>(exchange)
    const provider = exchange.params['provider']! as 'dingtalk' | 'feishu' | 'wecom'
    const corpId = exchange.query.get('corpId') ?? undefined
    const before = ctx.iam.users().get(exchange.params['id']!)
    if (!before) {
      exchange.fail(404, 'NOT_FOUND', t('账号不存在：{id}', { id: exchange.params['id']! }))
      return
    }
    // 解绑前快照被移除的身份，用于审计可追溯（解绑后投影已重建，无法反查）
    const removed = ctx.iam.identityLinks().find((link) => link.userId === before.id
      && link.provider === provider
      && (corpId === undefined || (link.corpId ?? '') === corpId))
      .map((link) => `${link.providerUserId}@${link.corpId || '-'}`)
    const user = ctx.iam.unbindThirdParty(before.id, provider, verifyCode, manageActor(exchange), corpId)
    changeLog(exchange, 'iam.user.unbind', 'user', user.id, user.displayName,
      t('{provider}｜主体 {corp}｜移除 {links}｜已豁免同步自动补绑', {
        provider,
        corp: corpId ?? t('全部主体'),
        links: removed.join(', ') || '—',
      }))
    return decorateUser(ctx, user)
  }))

  /**
   * 更换三方身份：解绑既有（写入豁免）→ 返回绑定入口所需上下文。
   * 不直接在同一请求里完成「先解后绑」——绑定必须走扫码授权（拿到的 unionId 只有 IdP 能给），
   * 服务端提前解绑会让用户在授权失败时白丢已有绑定。前端拿到本响应后立刻发起扫码授权，
   * 授权成功由 bindThirdParty/linkIdentity 清豁免并建立新链（旧链已解，一人一号不会被自己挡住）。
   */
  guarded('POST', '/api/iam/users/:id/bindings/:provider/replace', 'iam.user.write', manageScope(async (exchange) => {
    const { verifyCode, corpId } = body<{ verifyCode: string; corpId?: string }>(exchange)
    const provider = exchange.params['provider']! as 'dingtalk' | 'feishu' | 'wecom'
    const before = ctx.iam.users().get(exchange.params['id']!)
    if (!before) {
      exchange.fail(404, 'NOT_FOUND', t('账号不存在：{id}', { id: exchange.params['id']! }))
      return
    }
    const removed = ctx.iam.identityLinks().find((link) => link.userId === before.id
      && link.provider === provider
      && (corpId === undefined || (link.corpId ?? '') === corpId))
      .map((link) => `${link.providerUserId}@${link.corpId || '-'}`)
    if (removed.length === 0) {
      exchange.fail(400, 'BAD_REQUEST', t('该账号未绑定{provider}身份，无需更换', { provider }))
      return
    }
    const user = ctx.iam.unbindThirdParty(before.id, provider, verifyCode, manageActor(exchange), corpId)
    changeLog(exchange, 'iam.user.unbind', 'user', user.id, user.displayName,
      t('更换前置解绑：{provider}｜主体 {corp}｜移除 {links}', { provider, corp: corpId ?? t('全部主体'), links: removed.join(', ') }))
    return { user: decorateUser(ctx, user), removed, bindPath: '/api/auth/sso/bind/authorize' }
  }))

  // R4 删除面：物理删除仅限已注销账号（deactivate 软删除先行，双保险防误删在职账号）
  guarded('DELETE', '/api/iam/users/:id', 'iam.user.freeze', manageScope((exchange) => {
    const id = exchange.params['id']!
    const target = ctx.iam.users().get(id)
    if (!target) {
      exchange.fail(404, 'NOT_FOUND', t('账号不存在：{id}', { id }))
      return
    }
    if (target.status !== 'deactivated') {
      exchange.fail(400, 'BAD_REQUEST', t('仅已注销账号可物理删除（当前状态 {status}；请先执行 deactivate）', { status: target.status }))
      return
    }
    ctx.iam.deleteUser(id, manageActor(exchange))
    changeLog(exchange, 'iam.user.delete', 'user', id, target.displayName, t('物理删除（已注销账号）'))
    return { deleted: true }
  }))

  guarded('GET', '/api/iam/roles', 'iam.org.read', () => ({
    roles: ctx.iam.roles().all(),
    catalog: permissionCatalogView(),
  }))

  guarded('GET', '/api/iam/permissions', 'iam.org.read', () => {
    return { catalog: permissionCatalogView() }
  })

  guarded('POST', '/api/iam/roles', 'iam.role.write', manageScope((exchange) => {
    const input = body<{ code: string; name: string; description?: string; permissions: string[] }>(exchange)
    // P0-02：角色创建/编辑携带可归因操作者，服务层做可授权上限与持有人作用域裁决
    const role = ctx.iam.createRole(input, manageActor(exchange))
    changeLog(exchange, 'iam.role.create', 'role', role.id, role.name)
    return role
  }))

  guarded('PATCH', '/api/iam/roles/:id', 'iam.role.write', manageScope((exchange) => {
    const input = body<{ name?: string; description?: string; permissions?: string[] }>(exchange)
    const role = ctx.iam.updateRole(exchange.params['id']!, input, manageActor(exchange))
    changeLog(exchange, 'iam.role.update', 'role', role.id, role.name)
    return role
  }))

  // R4 删除面：自定义角色删除（内置角色与仍被挂载角色由服务层护栏拒绝）
  guarded('DELETE', '/api/iam/roles/:id', 'iam.role.write', manageScope((exchange) => {
    const id = exchange.params['id']!
    const role = ctx.iam.roles().get(id)
    // P0-02：删除同样携带操作者（组织子树外挂载的角色由服务层拒绝，防跨组织治理干扰）
    ctx.iam.deleteRole(id, manageActor(exchange))
    changeLog(exchange, 'iam.role.delete', 'role', id, role?.name ?? '', '')
    return { deleted: true }
  }))

  // -- 场景级授权（IAW 交接 6-1：角色 × 场景 ABAC） ------------------------------
  // 策略治理走 iam.org.read/iam.scene.write；自检 checkScene 对 panel.read 持有者开放（面板选择器用）。
  guarded('GET', '/api/iam/scene-policies', 'iam.org.read', (exchange) => ({
    policies: ctx.iam.scenePolicies().all()
      .filter((policy) => (exchange.query.get('sceneCode') ? policy.sceneCode === exchange.query.get('sceneCode') : true)),
  }))

  guarded('PUT', '/api/iam/scene-policies', 'iam.scene.write', (exchange) => {
    const input = body<{ sceneCode: string; orgId?: string; entries: Array<{ principalType: 'role' | 'user'; principalId: string; actions: string[]; effect: 'allow' | 'deny' }>; note?: string; expectedVersion?: number }>(exchange)
    const policy = ctx.iam.upsertScenePolicy({
      sceneCode: input.sceneCode,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      entries: input.entries ?? [],
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    })
    changeLog(exchange, 'iam.scene_policy.upsert', 'scene_policy', policy.id, policy.sceneCode, t('{n} 条，v{version}', { n: policy.entries.length, version: policy.version }))
    return policy
  })

  guarded('DELETE', '/api/iam/scene-policies/:id', 'iam.scene.write', (exchange) => {
    const result = ctx.iam.deleteScenePolicy(exchange.params['id']!)
    changeLog(exchange, 'iam.scene_policy.delete', 'scene_policy', exchange.params['id']!, exchange.query.get('sceneCode') ?? '')
    return result
  })

  /**
   * 场景访问自检（iam.check(scene, action) 的 HTTP 面）：panel.read 持有者查自己的场景判定。
   * userId 参数仅 iam.user.read 持有者可代查（治理面排障）；其余主体强制自查。
   */
  guarded('POST', '/api/iam/scene-authz/check', 'panel.read', (exchange) => {
    const info = caller(exchange)
    const input = body<{ sceneCode: string; action: string; userId?: string }>(exchange)
    if (!input.sceneCode?.trim() || !input.action?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', t('sceneCode 与 action 必填'))
      return
    }
    let targetUserId = info.userId ?? ''
    if (input.userId && input.userId !== info.userId) {
      if (!info.permissions.includes('*') && !info.permissions.includes('iam.user.read')) {
        exchange.fail(403, 'FORBIDDEN', t('代查他人场景判定需要 iam.user.read'))
        return
      }
      targetUserId = input.userId
    }
    if (!targetUserId) {
      exchange.fail(403, 'FORBIDDEN', t('机器主体请携带 userId 参数且调用方需持有 iam.user.read'))
      return
    }
    const decision = ctx.iam.checkScene(targetUserId, input.sceneCode, input.action)
    changeLog(exchange, 'iam.scene_policy.check', 'scene_policy', input.sceneCode, input.action, t('{decision}（{userId}）', { decision: decision.decision, userId: targetUserId }))
    return { ...decision, checkedUser: targetUserId }
  })

  guarded('GET', '/api/iam/groups', 'iam.user.read', () => ({
    groups: ctx.iam.groups().all().map((group) => ({
      ...group,
      resolvedMembers: ctx.iam.resolveGroupMembers(group.id).map((user) => ({ id: user.id, displayName: user.displayName, title: user.title })),
    })),
  }))

  guarded('POST', '/api/iam/groups', 'iam.user.write', (exchange) => {
    const input = body<{ name: string; type: 'static' | 'dynamic'; rule?: { orgIds?: string[]; title?: string }; memberIds?: string[]; description?: string }>(exchange)
    const group = ctx.iam.createGroup(input)
    changeLog(exchange, 'iam.group.create', 'user_group', group.id, group.name)
    return group
  })

  guarded('PATCH', '/api/iam/groups/:id', 'iam.user.write', (exchange) => {
    const group = ctx.iam.updateGroup(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'iam.group.update', 'user_group', group.id, group.name)
    return group
  })

  guarded('DELETE', '/api/iam/groups/:id', 'iam.user.write', (exchange) => {
    ctx.iam.deleteGroup(exchange.params['id']!)
    changeLog(exchange, 'iam.group.delete', 'user_group', exchange.params['id']!, '')
    return { deleted: true }
  })

  /** 动态用户组重算快照 + 漂移告警（dev-plan-nas-authz §2.2；连接器同步收尾亦自动执行）。 */
  guarded('POST', '/api/iam/groups/refresh-snapshots', 'iam.user.write', (exchange) => {
    const drifts = ctx.iam.refreshGroupSnapshots(caller(exchange).name)
    changeLog(exchange, 'iam.group.refresh_snapshots', 'user_group', '', '', t('漂移 {n} 组', { n: drifts.length }))
    return { drifts }
  })

  // 三方连接器
  guarded('GET', '/api/iam/connectors', 'iam.org.read', () => ({
    providers: ctx.iam.connectorProviders(),
    configs: ctx.iam.connectorConfigs().all().map(({ secretActual, ...config }) => {
      void secretActual
      return config
    }),
  }))

  // 新增接入主体：同一 provider 可接入多家企业（多套 corpId/appKey/appSecret），各自独立配置/同步/登录
  guarded('POST', '/api/iam/connectors', 'iam.connector.write', (exchange) => {
    const input = body<{ provider: 'dingtalk' | 'feishu' | 'wecom'; name: string; corpId: string; appKey: string; appSecret?: string; enabled?: boolean; syncOrgRoot?: string; intervalMinutes?: number; callbackUrl?: string; loginEnabled?: boolean; conflictStrategy?: 'third_party_wins' | 'platform_wins' | 'manual'; mode?: 'real' | 'mock'; apiBase?: string; oapiBase?: string; targetOrgId?: string }>(exchange)
    if (!input.provider || !input.name || !input.corpId || !input.appKey) {
      exchange.fail(400, 'BAD_REQUEST', t('provider、name、corpId、appKey 必填'))
      return
    }
    const config = ctx.iam.createConnectorConfig(input)
    changeLog(exchange, 'iam.connector.create', 'connector', config.id, config.name ?? config.provider)
    const { secretActual, ...safe } = config
    void secretActual
    return safe
  })

  // 参数语义 idOrProvider：先按配置 id / provider 解析已有配置（命中按 id 更新）；
  // 未命中且 param 为平台类型时维持旧行为（按 provider 第一条更新，无则新建）
  guarded('PUT', '/api/iam/connectors/:param', 'iam.connector.write', (exchange) => {
    const param = exchange.params['param']!
    const input = body<{ name?: string; corpId: string; appKey: string; appSecret?: string; enabled?: boolean; syncOrgRoot?: string; intervalMinutes?: number; callbackUrl?: string; loginEnabled?: boolean; conflictStrategy?: 'third_party_wins' | 'platform_wins' | 'manual'; mode?: 'real' | 'mock'; apiBase?: string; oapiBase?: string; targetOrgId?: string }>(exchange)
    const existing = ctx.iam.resolveConnectorConfig(param)
    if (!existing && !['dingtalk', 'feishu', 'wecom'].includes(param)) {
      exchange.fail(400, 'BAD_REQUEST', t('连接器配置不存在：{param}', { param }))
      return
    }
    const config = existing
      ? ctx.iam.upsertConnectorConfig({ id: existing.id, provider: existing.provider, ...input })
      : ctx.iam.upsertConnectorConfig({ provider: param as 'dingtalk', ...input })
    changeLog(exchange, 'iam.connector.update', 'connector', config.id, config.name ?? config.provider)
    const { secretActual, ...safe } = config
    void secretActual
    return safe
  })

  guarded('DELETE', '/api/iam/connectors/:id', 'iam.connector.write', (exchange) => {
    const config = ctx.iam.connectorConfigById(exchange.params['id']!)
    if (!config) {
      exchange.fail(400, 'BAD_REQUEST', t('连接器配置不存在：{param}', { param: exchange.params['id'] }))
      return
    }
    ctx.iam.deleteConnectorConfig(config.id)
    changeLog(exchange, 'iam.connector.delete', 'connector', config.id, config.name ?? config.provider)
    return { deleted: true }
  })

  guarded('POST', '/api/iam/connectors/:param/test', 'iam.connector.write', async (exchange) => {
    return await ctx.iam.testConnector(exchange.params['param']!)
  })

  guarded('POST', '/api/iam/connectors/:param/sync', 'iam.connector.write', async (exchange) => {
    const info = caller(exchange)
    const param = exchange.params['param']!
    const result = await ctx.iam.syncConnector(param, info.userId ?? info.principalId)
    const config = ctx.iam.resolveConnectorConfig(param)
    changeLog(exchange, 'iam.connector.sync', 'connector', config?.id ?? param, config?.name ?? config?.provider ?? param, result.message)
    return result
  })

  // 连接器自动同步的手动触发口：立即巡检全部到期配置（定时器每分钟自动跑同一逻辑，
  // IAM_CONNECTOR_AUTO_SYNC=off 停用定时器后可改由外部调度调本端点）。
  guarded('POST', '/api/iam/connectors/auto-sync', 'iam.connector.write', async (exchange) => {
    const results = await ctx.iam.runDueAutoSyncs()
    changeLog(exchange, 'iam.connector.auto-sync', 'connector', 'auto-sync', t('连接器到期巡检'), t('处理 {total} 条（{ok} 成功）', { total: results.length, ok: results.filter((item) => item.ok).length }))
    return { processed: results.length, results }
  })

  // 全员名册（组织数据通道）：接入应用（人事/绩效等）以机器凭证批量拉取在职账号与组织树。
  // 授权=iam.roster.read（应用注册凭证经「统一认证中心」追加 scope；org_admin 经 iam.* 通配自带）；
  // 批量 PII 出口，每次拉取记 invoke 审计（谁在何时拉了多少）。
  guarded('GET', '/api/iam/roster', 'iam.roster.read', (exchange) => {
    const info = caller(exchange)
    const roster = ctx.iam.roster()
    ctx.audit.record({
      type: 'invoke',
      actorType: info.kind === 'human' ? 'human' : 'machine',
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      action: 'iam.roster.pull',
      resourceType: 'roster',
      resourceId: 'roster',
      resourceName: t('全员名册'),
      result: 'ok',
      detail: `orgs=${roster.orgs.length} users=${roster.users.length}`,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
    return roster
  })

  guarded('GET', '/api/iam/conflicts', 'iam.org.read', (exchange) => ({
    conflicts: ctx.iam.conflicts().find((item) => item.status === (exchange.query.get('status') ?? 'pending')),
  }))

  guarded('POST', '/api/iam/conflicts/:id/resolve', 'iam.user.write', (exchange) => {
    const { keep } = body<{ keep: 'third_party' | 'platform' }>(exchange)
    const info = caller(exchange)
    const conflict = ctx.iam.resolveConflict(exchange.params['id']!, keep, info.userId ?? info.principalId)
    changeLog(exchange, 'iam.conflict.resolve', 'sync_conflict', conflict.id, '', t('保留 {keep}', { keep }))
    return conflict
  })
}

function decorateUser(ctx: Context, user: any) {
  const { passwordHash, passwordSalt, ...safe } = user
  void passwordHash
  void passwordSalt
  return {
    ...safe,
    orgName: ctx.iam.orgs().get(user.orgId)?.name ?? '',
    roles: user.roleIds.map((roleId: string) => ctx.iam.roles().get(roleId)).filter(Boolean),
  }
}
