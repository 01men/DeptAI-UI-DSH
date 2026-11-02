/**
 * App 域路由：AI 应用台账（机器身份读审计/凭证据点/拓扑/影响面/审计时间线/SSO 打通 owner 自助签发与机器环回自助）（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出，处理器逐字搬运（行为与迁出前一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../../platform-core/src/index.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import { CapabilityOwnerConflictError, AppCredentialMissingError, type AppCapabilityLink } from '../../../plugin-app/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'
import { scopedOrgFilterOf } from './iam.ts'

export interface AppRouteDeps extends ConsoleRouteDeps {
  requestOrigin: (exchange: HttpExchange) => string | undefined
  /** 分支权限判定（实现留 createRestGate，同 nas.ts 一端点多分支模式） */
  requirePermission: (exchange: HttpExchange, point: string) => boolean
  enrichTopology: (node: any) => any
  appSsoGuard: (exchange: HttpExchange, op: 'create' | 'update' | 'rotate' | 'enable' | 'disable', input?: { redirectUris?: string[]; postLogoutUris?: string[] }) => boolean
}

export function registerAppRoutes(ctx: Context, deps: AppRouteDeps): void {
  const { http, guarded, body, changeLog, caller, requestOrigin, requirePermission, enrichTopology, appSsoGuard } = deps
  // -- App ----------------------------------------------------------------
  // R11 多公司收口：非 `*` 管理员按本组织子树过滤应用台账（与 /api/agents 同口径）
  guarded('GET', '/api/apps', 'app.read', (exchange) => {
    const orgFilter = scopedOrgFilterOf(ctx, caller, exchange)
    return {
      apps: ctx.resourceCore.list('app')
        .filter((app) => (orgFilter ? orgFilter(app.orgId) : true))
        .map((app) => ({
          ...app,
          metrics: ctx.appRegistry.metrics(app.id),
          availableTransitions: ctx.resourceCore.availableTransitions('app', app.id),
        })),
      schema: ctx.resourceCore.typeSpec('app')?.schema,
      lifecycle: ctx.resourceCore.typeSpec('app')?.lifecycle,
    }
  })

  // 开发者选择器数据源（注册表单下拉/搜索用）：挂在 app.write 下——能注册应用即可枚举
  // 在编用户的瘦字段（id/姓名/账号/部门/钉钉 unionId 绑定），不经 iam.user.read；须注册在 /api/apps/:id 之前（路由先匹配先中）
  guarded('GET', '/api/apps/developer-options', 'app.write', () => ({
    options: ctx.iam.users().find((user) => user.status === 'active')
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'))
      .map((user) => ({
        id: user.id,
        name: user.displayName,
        username: user.username,
        orgName: ctx.iam.orgs().get(user.orgId)?.name ?? '',
        // 钉钉身份绑定 unionId：供外部推送方把表格人员字段的 unionId 解析成平台账号（开发者字段落 developerId + 真实姓名）
        unionIds: (user.bindings ?? []).filter((b) => b.provider === 'dingtalk').map((b) => b.unionId),
      })),
  }))

  /** 开发者字段解析（attrs 原地修改）：developerId 须为在编平台用户，developerName 以 IAM displayName 为准；
   *  空串语义：POST 时不落字段，PATCH（allowClear）时显式清除开发者。 */
  const resolveDeveloperAttrs = (attrs: Record<string, unknown>, { allowClear = false } = {}): void => {
    const raw = attrs['developerId']
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id) {
      const user = ctx.iam.users().get(id)
      if (!user) throw new Error(t('开发者不存在：{id}（developerId 须为平台用户 ID）', { id }))
      if (user.status !== 'active') throw new Error(t('开发者「{name}」非在编状态，不能登记为应用开发者', { name: user.displayName }))
      attrs['developerId'] = user.id
      attrs['developerName'] = user.displayName
      return
    }
    if (raw === undefined) return
    if (allowClear) {
      attrs['developerId'] = ''
      attrs['developerName'] = ''
    } else {
      delete attrs['developerId']
    }
  }

  guarded('GET', '/api/apps/:id', 'app.read', (exchange) => {
    const id = exchange.params['id']!
    const app = ctx.resourceCore.get('app', id)
    if (!app) throw new Error(t('应用不存在：{id}', { id }))
    // P1-02（安全审查 2026-10-31）：详情与列表同规的对象级组织校验（与 agents/:id 同口径）
    const orgFilter = scopedOrgFilterOf(ctx, caller, exchange)
    if (orgFilter && !orgFilter(app.orgId)) {
      exchange.fail(403, 'FORBIDDEN', t('目标应用不在你的组织子树内（组织隔离）'))
      return
    }
    // SSO 配置块（不含 secret；供详情页「SSO 配置」tab 与门禁提示使用）
    const ssoClients = ctx.oidc.clientsForApp(id)
    const ssoClient = ssoClients[0]
    const { clientSecretHash, ...ssoSafe } = ssoClient ?? {}
    void clientSecretHash
    return {
      ...app,
      metrics: ctx.appRegistry.metrics(id),
      topology: enrichTopology(ctx.appRegistry.topology(id)),
      cost: ctx.appRegistry.costBreakdown(id),
      impact: ctx.resourceCore.impact('app', id),
      availableTransitions: ctx.resourceCore.availableTransitions('app', id),
      audit: ctx.audit.query({ resourceType: 'app', resourceId: id, limit: 30 }).items,
      sso: ssoClient
        ? {
          ...ssoSafe,
          status: ssoSafe.status ?? 'active',
          clientType: ssoSafe.clientType ?? 'confidential',
          refAppName: ctx.resourceCore.get('app', ssoSafe.refId ?? '')?.name ?? undefined,
          discovery: {
            issuer: ctx.oidc.issuer(exchange),
            authorization_endpoint: `${ctx.oidc.issuer(exchange)}/oauth/authorize`,
            token_endpoint: `${ctx.oidc.issuer(exchange)}/oauth/token`,
            userinfo_endpoint: `${ctx.oidc.issuer(exchange)}/oauth/userinfo`,
          },
        }
        : null,
      ssoEnforceTypes: ((): string[] => {
        // 门禁形态提示（与 plugin-app 同源逻辑；动态 import 避免循环依赖）
        return String(process.env.APP_SSO_ENFORCE ?? 'web,h5').split(',').map((item) => item.trim()).filter(Boolean)
      })(),
    }
  })

  guarded('POST', '/api/apps', 'app.write', (exchange) => {
    const input = body<{ name: string; slug?: string; attrs?: Record<string, unknown>; agentIds?: string[] }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const attrs = { ...(input.attrs ?? {}) }
    resolveDeveloperAttrs(attrs)
    const result = ctx.appRegistry.register({
      ...input,
      attrs,
      ownerId: info.userId ?? info.principalId,
      ownerName: info.name,
      orgId: user?.orgId ?? ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
    })
    return { app: result.app, credential: result.credential ?? null }
  })

  /**
   * 应用写操作归属守卫（QA A-04）：PATCH/删除/指标上报/状态流转此前仅校验 app.write，
   * 任意 developer 可改写他人应用。平台管理员（'*'）、应用 owner、绑定本应用的机器主体
   * （refType=app 自助上报通道）之外一律 403 并落 audit.authz.denied。
   */
  const assertAppOwner = (exchange: HttpExchange, appId: string): boolean => {
    const info = caller(exchange)
    if (info.permissions.includes('*')) return true
    const app = ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(t('应用不存在：{id}', { id: appId }))
    const isOwner = info.kind === 'human' && info.userId !== undefined && app.ownerId === info.userId
    const isBoundMachine = info.kind === 'machine' && info.refType === 'app' && info.refId === appId
    if (isOwner || isBoundMachine) return true
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point: `app.write(owner:${appId})`,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', t('仅平台管理员与应用负责人可变更「{name}」（owner 校验，QA A-04）', { name: app.name }))
    return false
  }

  guarded('PATCH', '/api/apps/:id', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const input = body<{ name?: string; attrs?: Record<string, unknown> }>(exchange)
    const attrs = { ...(input.attrs ?? {}) }
    resolveDeveloperAttrs(attrs, { allowClear: true })
    const app = ctx.appRegistry.updateApp(exchange.params['id']!, { ...input, attrs })
    changeLog(exchange, 'app.update', 'app', app.id, app.name)
    return app
  })

  // 接入提示词（注册同款模板，平台侧生成）：rotate=true 轮换机器凭证 secret 并随提示词返回（旧值立即失效），
  // rotate=false 仅含 client_id（secret 丢失场景必须 rotate 才能拿到可用凭证）。控制台详情页按钮与外部推送方共用。
  guarded('POST', '/api/apps/:id/onboarding-prompt', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const { rotate } = body<{ rotate?: boolean }>(exchange)
    const id = exchange.params['id']!
    const result = ctx.appRegistry.buildOnboardingPrompt(id, requestOrigin(exchange) ?? 'http://127.0.0.1:7300', { rotate: rotate === true })
    changeLog(exchange, 'app.onboarding-prompt', 'app', id, result.appName, result.rotated ? t('轮换机器凭证并生成接入提示词（旧 secret 立即失效）') : t('生成接入提示词（未轮换，不含 secret）'))
    return result
  })

  /** 删除应用：草稿（从未上线）或已归档可删；级联清除依赖边、禁用 SSO 客户端与机器凭证（记录保留）。 */
  guarded('DELETE', '/api/apps/:id', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const app = ctx.resourceCore.get('app', id)
    if (!app) throw new Error(t('应用不存在：{id}', { id }))
    ctx.resourceCore.remove('app', id, { allowStates: ['draft', 'archived'] })
    ctx.appRegistry.purge(id)
    changeLog(exchange, 'app.delete', 'app', id, app.name)
    return { deleted: true }
  })

  // 应用指标主动上报（接入方 → 宿主推送通道；同日 DAU/UV 取最大、会话/PV 累加，可指定 date 补录）
  guarded('POST', '/api/apps/:id/metrics-report', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const input = body<{ dau?: number; sessions?: number; avgDepth?: number; retention7?: number; pv?: number; uv?: number; date?: string }>(exchange)
    ctx.appRegistry.recordUsage(id, input)
    const app = ctx.resourceCore.get('app', id)!
    changeLog(exchange, 'app.metrics.report', 'app', id, app.name, `pv=${input.pv ?? '-'} uv=${input.uv ?? '-'} dau=${input.dau ?? '-'} sessions=${input.sessions ?? '-'} date=${input.date ?? t('当日')}`)
    return ctx.appRegistry.metrics(id)
  })

  // 组织架构同步（应用自助复用平台组织模块）：绑定本应用的机器凭证/owner 拉平台组织树+在职成员，
  // 在应用内复刻平台组织架构功能；users[].id 即 SSO userinfo 的 sub。?ifNoneMatch=<version> 命中
  // 返回 {unchanged:true} 零载荷轮询。PII 最小化（无手机号/邮箱）；更全字段走 /api/iam/roster
  // （iam.roster.read，管理员追加）。批量组织数据出口，每次拉取记 invoke 审计（同 roster 口径）。
  guarded('GET', '/api/apps/:id/org-sync', 'app.read', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const ifNoneMatch = exchange.query.get('ifNoneMatch') ?? undefined
    const snapshot = ctx.appRegistry.orgSnapshot(id, { ...(ifNoneMatch ? { ifNoneMatch } : {}) })
    const info = caller(exchange)
    ctx.audit.record({
      type: 'invoke',
      actorType: info.kind === 'human' ? 'human' : 'machine',
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      action: 'app.org-sync.pull',
      resourceType: 'app',
      resourceId: id,
      resourceName: ctx.resourceCore.get('app', id)?.name ?? id,
      result: 'ok',
      detail: snapshot.unchanged
        ? `unchanged version=${snapshot.version}`
        : `orgs=${snapshot.orgs?.length ?? 0} users=${snapshot.users?.length ?? 0} version=${snapshot.version}`,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
    return snapshot
  })

  // 生命周期流转：按动作分支权限（启用目录点 app.offline，对齐 agent 域 offline 独立点口径）：
  // offline 守 app.offline，其余（submit_trial/retrial/online/archive）守 app.write。
  // 绕过 guarded() 的统一包装需自带 try/catch（业务异常转 400）；权限判定先于 owner 校验
  // （RBAC 探针语义：无权限一律 403，不得以「资源不存在」400 泄漏）。
  http.register('POST', '/api/apps/:id/transition', async (exchange) => {
    const { action, note } = body<{ action: string; note?: string }>(exchange)
    if (!requirePermission(exchange, action === 'offline' ? 'app.offline' : 'app.write')) return
    const info = caller(exchange)
    const id = exchange.params['id']!
    try {
      // owner 校验在 try 内（资源不存在的业务异常转 400 而非 500）；权限判定始终在最前（探针 403 语义）
      if (!assertAppOwner(exchange, id)) return
      let result: unknown
      if (action === 'online') {
        const approval = ctx.appRegistry.requestOnline(id, { id: info.userId ?? info.principalId, name: info.name })
        result = { approval, note: t('发布为 L4 操作，已创建审批单') }
      } else if (action === 'offline') {
        const approval = ctx.appRegistry.requestOffline(id, { id: info.userId ?? info.principalId, name: info.name }, note ?? '')
        result = { approval, note: t('下架为 L4 操作，已创建审批单') }
      } else if (action === 'submit_trial') {
        result = ctx.resourceCore.transition('app', id, 'submit_trial', info.name).entity
      } else if (action === 'retrial') {
        result = ctx.resourceCore.transition('app', id, 'retrial', info.name).entity
      } else if (action === 'archive') {
        result = ctx.appRegistry.archive(id, info.name)
      } else {
        throw new Error(t('未知操作：{action}', { action }))
      }
      // 裸 http.register 不经 guarded() 的 ok 包装：返回值必须自行写响应（否则客户端挂起到超时）
      if (!exchange.res.writableEnded) exchange.ok(result)
    } catch (error) {
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'app.write,app.offline' })

  // -- 应用能力绑定（W2-T4，MCP 治理契约 §10） ------------------------------
  // 服务摘要只投影非 headers 字段——headers 一概不回显：脱敏管道 maskServiceHeaders 定义于
  // plugin-console/index.ts（中间件层），无法传入本路由域；直接零回显比掩码更保守，
  // 满足同一红线「业务集合与任何 API 响应绝不出现凭证/敏感头」。
  const capabilityServiceSummary = (serviceId: string) => {
    const service = ctx.mcpRegistry.services().get(serviceId)
    if (!service) return null
    return {
      id: service.id,
      name: service.name,
      slug: service.slug,
      status: service.status,
      dataClass: service.dataClass,
      exposureMode: service.exposureMode,
      environment: service.environment,
      health: service.health,
      toolCount: service.tools.length,
      hasCredential: Boolean(service.credentialRef),
      ownerEntity: service.ownerEntity,
    }
  }

  // 能力列表（含逐条服务摘要）；owner 守卫同 assertAppOwner 既有口径，权限点按契约 §15 用 app.write
  guarded('GET', '/api/apps/:id/capabilities', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    return {
      capabilities: ctx.appRegistry.listCapabilities(id).map((link) => ({
        ...link,
        service: capabilityServiceSummary(link.serviceId),
      })),
    }
  })

  // 绑定能力服务 {serviceId, required?}：服务必须存在；绑定同步 ownerEntity 回写
  // （platform 占位可认领；已归属其他主体 409 OWNER_CONFLICT）；重复绑定幂等返回现态
  guarded('POST', '/api/apps/:id/capabilities', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const input = body<{ serviceId: string; required?: boolean }>(exchange)
    if (!input.serviceId?.trim()) throw new Error(t('serviceId 必填'))
    const info = caller(exchange)
    let result: { link: AppCapabilityLink; created: boolean }
    try {
      result = ctx.appRegistry.bindCapability(id, { serviceId: input.serviceId.trim(), required: input.required === true, boundBy: info.name })
    } catch (error) {
      if (error instanceof CapabilityOwnerConflictError) {
        exchange.fail(409, 'OWNER_CONFLICT', error.message)
        return
      }
      throw error
    }
    const app = ctx.resourceCore.get('app', id)
    changeLog(exchange, 'app.capability.bind', 'app', id, app?.name ?? id, result.created
      ? t('绑定能力服务 {serviceId}（required={required}；ownerEntity 回写 app 归属）', { serviceId: result.link.serviceId, required: result.link.required })
      : t('重复绑定幂等返回现态（serviceId={serviceId}）', { serviceId: result.link.serviceId }))
    return { ...result, service: capabilityServiceSummary(result.link.serviceId) }
  })

  // 解绑能力服务：删绑定记录与 capability 依赖边；服务归属若为本 app 联动还原 platform 占位
  guarded('DELETE', '/api/apps/:id/capabilities/:serviceId', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const serviceId = exchange.params['serviceId']!
    const result = ctx.appRegistry.unbindCapability(id, serviceId)
    const app = ctx.resourceCore.get('app', id)
    changeLog(exchange, 'app.capability.unbind', 'app', id, app?.name ?? id, result.removed
      ? t('解绑能力服务 {serviceId}{owner}', { serviceId, owner: result.ownerRestored ? t('；归属联动还原 platform 占位（解绑联动）') : '' })
      : t('绑定不存在，幂等返回（serviceId={serviceId}）', { serviceId }))
    return result
  })

  // -- 应用外部凭证托管（issue #19 方向 A 最小闭环，2026-10-31） ----------------
  // 数字员工/接入应用调用外部自研服务所需长期凭据的平台落点：登记即 AES-256-GCM 加密落
  // 密钥文件（0600），取值走独立权限点 app.credential.fetch + 对象级校验 + 逐次审计
  // （app.secret.access 事件 → audit app.credential.access），列表/登记响应只回掩码。
  // 登记/轮换/删除沿用 app.write + assertAppOwner（与能力绑定同口径）。
  const credentialApp = (exchange: HttpExchange): { id: string; name: string; ownerId: string } => {
    const app = ctx.resourceCore.get('app', exchange.params['id']!)
    if (!app) throw new Error(t('应用不存在：{id}', { id: exchange.params['id'] }))
    return { id: app.id, name: app.name, ownerId: app.ownerId }
  }

  /** 取值对象级守卫：机器凭证须绑定本应用（refType/refId 命中）或为登记 owner；human 须 owner 或平台管理员。 */
  const assertCredentialRead = (exchange: HttpExchange, appId: string): boolean => {
    const info = caller(exchange)
    const app = ctx.resourceCore.get('app', appId)
    if (!app) throw new Error(t('应用不存在：{id}', { id: appId }))
    const allowed = info.kind === 'machine'
      ? (info.refType === 'app' && info.refId === appId) || app.ownerId === info.principalId
      : app.ownerId === info.userId || info.permissions.includes('*')
    if (allowed) return true
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point: `app.credential.fetch(app:${appId})`,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', t('仅应用 owner、绑定本应用的机器凭证（或持有 {point} 的平台管理员）可取用「{name}」的外部凭证', { point: 'app.credential.fetch', name: app.name }))
    return false
  }

  // 掩码清单（含登记/轮换/删除）：值永不回显（masked + rotatedAt 元数据）
  guarded('GET', '/api/apps/:id/credentials', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    return { credentials: ctx.appCredentials.list(id) }
  })

  // 登记/轮换（同键再 put 即轮换）：{value, description?}；响应掩码，审计不含值
  guarded('PUT', '/api/apps/:id/credentials/:key', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const key = exchange.params['key']!
    const input = body<{ value: string; description?: string }>(exchange)
    const info = caller(exchange)
    const app = ctx.resourceCore.get('app', id)
    const existing = ctx.appCredentials.list(id).some((item) => item.key === key)
    const meta = ctx.appCredentials.put(id, { key, value: String(input.value ?? ''), description: input.description, rotatedBy: info.name })
    changeLog(exchange, existing ? 'app.credential.rotate' : 'app.credential.set', 'app', id, app?.name ?? id,
      t('凭证 {key}（AES-256-GCM 落密钥文件，值不入审计）', { key }))
    return { ...meta, rotated: existing }
  })

  // 删除单条：幂等
  guarded('DELETE', '/api/apps/:id/credentials/:key', 'app.write', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const key = exchange.params['key']!
    const removed = ctx.appCredentials.remove(id, key)
    const app = ctx.resourceCore.get('app', id)
    changeLog(exchange, 'app.credential.delete', 'app', id, app?.name ?? id, removed ? t('凭证 {key} 已删除', { key }) : t('凭证 {key} 不存在，幂等返回', { key }))
    return { removed }
  })

  // 接入方自检（一条命令确认「托管在哪/谁能读/最近谁读过」）：先于 :key/value 注册（路由先匹配先中）
  guarded('GET', '/api/apps/:id/credentials/self-check', 'app.read', (exchange) => {
    if (!assertAppOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const app = ctx.resourceCore.get('app', id)!
    const credentials = ctx.appCredentials.list(id)
    const boundPrincipals = ctx.authn.principals().find((item) => item.type === 'machine' && item.status === 'active'
      && item.scopes.includes('app.credential.fetch')
      && ((item.refType === 'app' && item.refId === id) || app.ownerId === item.id))
    const recentAccess = ctx.audit.query({ resourceType: 'app', resourceId: id, limit: 100 }).items
      .filter((item) => item.action === 'app.credential.access')
      .slice(0, 10)
      .map((item) => ({ at: item.createdAt, actorId: item.actorId, actorName: item.actorName, result: item.result, detail: item.detail }))
    return {
      storage: { kind: 'platform-managed', algorithm: 'AES-256-GCM', note: t('密钥文件 0600 / 目录 0700，主密钥独立文件；值不入业务集合与 API 响应') },
      entries: credentials.map((item) => ({ key: item.key, masked: item.masked, rotatedAt: item.rotatedAt })),
      whoCanRead: {
        permissionPoint: 'app.credential.fetch',
        machinePrincipals: boundPrincipals.map((item) => ({ id: item.id, name: item.name, clientId: item.clientId })),
        humanRule: t('应用 owner 或平台管理员（*）；独立权限点 app.credential.fetch 供角色/机器凭证按需授权'),
      },
      recentAccess,
    }
  })

  // 取值（拿到明文）：独立权限点 app.credential.fetch + 对象级校验；逐次 emit app.secret.access 落审计
  guarded('GET', '/api/apps/:id/credentials/:key/value', 'app.credential.fetch', (exchange) => {
    const id = exchange.params['id']!
    if (!assertCredentialRead(exchange, id)) return
    const key = exchange.params['key']!
    const info = caller(exchange)
    try {
      const value = ctx.appCredentials.resolve(id, key, { actor: info.userId ?? info.principalId, actorName: info.name })
      return { key, value, note: t('本次取用已落审计（app.credential.access）') }
    } catch (error) {
      if (error instanceof AppCredentialMissingError) {
        exchange.fail(404, 'CREDENTIAL_NOT_FOUND', error.message)
        return
      }
      throw error
    }
  })

  // -- 应用 ↔ SSO 打通（owner 自助签发 + 机器环回自助，口径见 ssoManageGuard） ----
  const ssoApp = (exchange: HttpExchange): { id: string; name: string; ownerId: string } => {
    const app = ctx.resourceCore.get('app', exchange.params['id']!)
    if (!app) throw new Error(t('应用不存在：{id}', { id: exchange.params['id'] }))
    return { id: app.id, name: app.name, ownerId: app.ownerId }
  }

  guarded('POST', '/api/apps/:id/sso-client', 'app.write', (exchange) => {
    const input = body<{ redirectUris: string[]; clientType?: 'confidential' | 'public'; consentRequired?: boolean; postLogoutUris?: string[]; description?: string }>(exchange)
    if (!appSsoGuard(exchange, 'create', { redirectUris: input.redirectUris, postLogoutUris: input.postLogoutUris })) return
    const app = ssoApp(exchange)
    const created = ctx.appRegistry.createSsoClient(app.id, input)
    changeLog(exchange, 'app.sso.create', 'oidc_client', created.client.id, created.client.name, t('应用 {name} 签发（{clientType}）', { name: app.name, clientType: input.clientType ?? 'confidential' }))
    return {
      clientId: created.client.clientId,
      clientSecret: created.clientSecret,
      redirectUris: created.client.redirectUris,
      note: created.client.clientType === 'public' ? t('public 客户端无 secret（强制 PKCE、不发 refresh）') : t('clientSecret 仅此一次返回'),
    }
  })

  guarded('PATCH', '/api/apps/:id/sso-client', 'app.write', (exchange) => {
    const input = body<{ redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }>(exchange)
    if (!appSsoGuard(exchange, 'update', { redirectUris: input.redirectUris, postLogoutUris: input.postLogoutUris })) return
    const app = ssoApp(exchange)
    const updated = ctx.appRegistry.updateSsoClient(app.id, input)
    changeLog(exchange, 'app.sso.update', 'oidc_client', updated.id, updated.name)
    return updated
  })

  guarded('POST', '/api/apps/:id/sso-client/rotate', 'app.write', (exchange) => {
    if (!appSsoGuard(exchange, 'rotate')) return
    const app = ssoApp(exchange)
    const rotated = ctx.appRegistry.rotateSsoSecret(app.id)
    changeLog(exchange, 'app.sso.rotate', 'oidc_client', rotated.client.id, rotated.client.name, t('旧 secret 立即失效'))
    return { clientId: rotated.client.clientId, clientSecret: rotated.clientSecret, note: t('新 clientSecret 仅此一次返回，旧值立即失效') }
  })

  for (const action of ['disable', 'enable'] as const) {
    guarded('POST', `/api/apps/:id/sso-client/${action}`, 'app.write', (exchange) => {
      if (!appSsoGuard(exchange, action)) return
      const app = ssoApp(exchange)
      const { reason } = body<{ reason?: string }>(exchange)
      const client = action === 'disable'
        ? ctx.appRegistry.disableSsoClient(app.id, reason ?? t('owner 手动禁用'))
        : ctx.appRegistry.enableSsoClient(app.id)
      changeLog(exchange, `app.sso.${action}`, 'oidc_client', client.id, client.name, reason ?? '')
      return client
    })
  }

}
