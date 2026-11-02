/**
 * Authn 身份凭证域路由（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出——机器主体（ principals）签发/禁用/启停/改域/轮换密钥、
 * 令牌台账与吊销、签名密钥轮换、OIDC 客户端管理（模式 B：平台作为 IdP）与 JWKS 轮换。
 * 处理器逐字搬运（行为与迁出前一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { AppRegistryService } from '../../../plugin-app/src/index.ts'
import { DelegationError } from '../../../plugin-authn/src/index.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'
import type { HttpExchange } from '../../../platform-core/src/index.ts'

export interface AuthnRouteDeps extends ConsoleRouteDeps {
  /** 自助 MCP 配置的回调 URL 组装（实现留 index.ts，与 onboarding-prompt 同源） */
  requestOrigin: (exchange: HttpExchange) => string | undefined
}

export function registerAuthnRoutes(ctx: Context, deps: AuthnRouteDeps): void {
  const { http, guarded, body, changeLog, caller, requestOrigin } = deps
  // -- Authn --------------------------------------------------------------
  guarded('GET', '/api/authn/principals', 'authn.principal.read', () => ({
    principals: ctx.authn.principals().all().map((principal) => {
      // 脱敏：clientSecretHash 为签名级凭证哈希，一律不外发
      const { clientSecretHash, ...safe } = principal
      void clientSecretHash
      // 机器主体补充角色明细与解析后的生效权限（前端展示用）
      const roleNames = (principal.roleIds ?? [])
        .map((roleId) => ctx.iam.roles().get(roleId)?.name)
        .filter((name): name is string => Boolean(name))
      return {
        ...safe,
        roleNames,
        resolvedScopes: principal.type === 'machine' ? ctx.authn.resolveMachineScopes(principal) : safe.scopes,
        activeTokens: ctx.authn.activeTokenCount(principal.id),
      }
    }),
  }))

  /** 机器凭证可绑定的已注册资源（签发弹窗下拉/搜索用：选择后自动回填 refType/refId）。 */
  guarded('GET', '/api/authn/bindable-resources', 'authn.principal.read', () => ({
    agents: ctx.resourceCore.list('agent').map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
    apps: ctx.resourceCore.list('app').map((app) => ({ id: app.id, name: app.name, status: app.status })),
  }))

  guarded('POST', '/api/authn/principals', 'authn.principal.write', (exchange) => {
    const input = body<{ name: string; refType?: 'agent' | 'app' | 'external'; refId?: string; roleIds?: string[]; scopes: string[] }>(exchange)
    const created = ctx.authn.createMachineCredential(input)
    const summary = [input.roleIds?.length ? t('角色×{n}', { n: input.roleIds.length }) : '', input.scopes.length ? t('权限点×{n}', { n: input.scopes.length }) : ''].filter(Boolean).join(' + ')
    changeLog(exchange, 'authn.principal.create', 'principal', created.principal.id, input.name, input.refId ? t('绑定 {ref} · {summary}', { ref: `${input.refType}:${input.refId}`, summary }) : summary)
    return { principalId: created.principal.id, clientId: created.clientId, clientSecret: created.clientSecret, note: t('密钥仅此一次返回') }
  })

  guarded('POST', '/api/authn/principals/:id/disable', 'authn.principal.write', (exchange) => {
    const { reason } = body<{ reason?: string }>(exchange)
    const principal = ctx.authn.disablePrincipal(exchange.params['id']!, reason ?? t('手动禁用'))
    changeLog(exchange, 'authn.principal.disable', 'principal', principal.id, principal.name, reason ?? '')
    return principal
  })

  guarded('POST', '/api/authn/principals/:id/enable', 'authn.principal.write', (exchange) => {
    const principal = ctx.authn.enablePrincipal(exchange.params['id']!)
    changeLog(exchange, 'authn.principal.enable', 'principal', principal.id, principal.name)
    return principal
  })

  guarded('PATCH', '/api/authn/principals/:id', 'authn.principal.write', (exchange) => {
    const { roleIds, scopes } = body<{ roleIds?: string[]; scopes?: string[] }>(exchange)
    const hasRoles = Array.isArray(roleIds)
    const hasScopes = Array.isArray(scopes)
    if ((!hasRoles && !hasScopes) || (hasRoles && roleIds!.some((id) => typeof id !== 'string')) || (hasScopes && scopes!.some((scope) => typeof scope !== 'string'))) {
      exchange.fail(400, 'BAD_REQUEST', t('roleIds / scopes 至少提供一项（字符串数组）'))
      return
    }
    const principal = ctx.authn.updateMachineScopes(exchange.params['id']!, {
      ...(hasRoles ? { roleIds } : {}),
      ...(hasScopes ? { scopes } : {}),
    })
    changeLog(exchange, 'authn.principal.scopes', 'principal', principal.id, principal.name, [principal.roleIds?.length ? t('角色×{n}', { n: principal.roleIds.length }) : '', scopes?.length ? t('权限点×{n}', { n: scopes.length }) : ''].filter(Boolean).join(' + '))
    const { clientSecretHash, ...safe } = principal
    void clientSecretHash
    return safe
  })

  guarded('POST', '/api/authn/principals/:id/rotate-secret', 'authn.principal.write', (exchange) => {
    const rotated = ctx.authn.rotateMachineCredential(exchange.params['id']!)
    changeLog(exchange, 'authn.principal.rotate', 'principal', rotated.principal.id, rotated.principal.name, t('旧 secret 立即失效'))
    return { clientId: rotated.principal.clientId, clientSecret: rotated.clientSecret, note: t('新 clientSecret 仅此一次返回，旧值立即失效，存量令牌已全部吊销') }
  })

  guarded('GET', '/api/authn/tokens', 'authn.principal.read', (exchange) => {
    const principalId = exchange.query.get('principalId') ?? undefined
    const tokens = ctx.authn.tokens().find((token) => (principalId ? token.principalId === principalId : true))
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
    return {
      total: tokens.length,
      tokens: tokens.slice(0, 200).map((token) => {
        // 脱敏：refreshHash 为签名级敏感凭证哈希，sid/chainId 属会话内部标识，一律不外发
        const { refreshHash, sid, chainId, ...rest } = token
        void refreshHash; void sid; void chainId
        return {
          ...rest,
          principalName: ctx.authn.principals().get(token.principalId)?.name ?? '',
        }
      }),
    }
  })

  guarded('POST', '/api/authn/tokens', 'authn.token.issue', (exchange) => {
    const input = body<{ principalId: string; ttlHours?: number; reason?: string; audience?: string; scopes?: string[] }>(exchange)
    const principal = ctx.authn.principals().get(input.principalId)
    if (!principal) throw new Error(t('身份不存在：{id}', { id: input.principalId }))
    const { token, record } = ctx.authn.issueToken(input.principalId, {
      kind: 'access',
      ttlHours: input.ttlHours,
      scopes: input.scopes ?? principal.scopes,
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      issuedBy: `console:${caller(exchange).name}`,
    })
    changeLog(exchange, 'authn.token.issue', 'token', record.jti, record.jti, input.reason ?? '')
    return { token, jti: record.jti, expiresAt: record.expiresAt }
  })

  // -- 个人接入令牌（员工自助 MCP 调用配置，2026-11-02）--------------------------------
  // 员工为「自己」签发带备注的长效令牌，生成标准 MCP 客户端配置 JSON（一键复制）。
  // 权限对齐是构造性的：human 令牌在 verify 时实时按角色解析权限（plugin-authn verify），
  // 角色变更即时生效、吊销即时失效。守卫 console.login（全员自助，不新增权限点）；
  // 明文只返回一次（对齐 connect 接入码先例），列表恒掩码。
  const PAT_DEFAULT_TTL_HOURS = 720 // 30 天
  const PAT_MAX_TTL_HOURS = Math.max(1, Number(process.env.MCP_PAT_MAX_TTL_HOURS ?? 2160) || 2160) // 上限 90 天，env 可调
  const PAT_MAX_ACTIVE_PER_USER = 10

  guarded('POST', '/api/authn/mcp-tokens', 'console.login', (exchange) => {
    const info = caller(exchange)
    const input = body<{ label?: string; ttlHours?: number }>(exchange)
    const label = String(input.label ?? '').trim()
    if (label === '' || label.length > 100) throw new Error(t('label 必填（≤100 字，用于在令牌列表中识别用途）'))
    const activePats = ctx.authn.tokens().find((token) =>
      token.principalId === info.principalId && token.issuedBy === 'mcp-config' && !token.revokedAt && token.expiresAt > new Date().toISOString())
    if (activePats.length >= PAT_MAX_ACTIVE_PER_USER) {
      throw new Error(t('个人接入令牌已达上限（{max} 条），请先在「我的接入」吊销不再使用的令牌', { max: String(PAT_MAX_ACTIVE_PER_USER) }))
    }
    const requested = Number(input.ttlHours ?? PAT_DEFAULT_TTL_HOURS)
    if (!Number.isFinite(requested) || requested <= 0) throw new Error(t('ttlHours 必须为正数（小时）'))
    const ttlHours = Math.min(Math.floor(requested), PAT_MAX_TTL_HOURS)
    const { token, record } = ctx.authn.issueToken(info.principalId, {
      kind: 'access',
      ttlHours,
      issuedBy: 'mcp-config',
      label,
    })
    const origin = requestOrigin(exchange) ?? 'http://127.0.0.1:7300'
    changeLog(exchange, 'authn.mcp_token.issue', 'token', record.jti.slice(0, 8), label, `ttl=${ttlHours}h`)
    return {
      token,
      jti: record.jti,
      label,
      expiresAt: record.expiresAt,
      config: {
        mcpServers: {
          'ybk-aios': {
            type: 'http',
            url: `${origin}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
    }
  })

  // 列表守卫用 console.read（被 console.login 蕴含，真实用户零感知；属演示只读白名单基线点，
  // demo-route-audit 判定面）——访客仅能拿到自己主体下的空列表，无个人信息泄露面
  guarded('GET', '/api/authn/mcp-tokens', 'console.read', (exchange) => {
    const info = caller(exchange)
    const tokens = ctx.authn.tokens().find((token) => token.principalId === info.principalId && token.issuedBy === 'mcp-config')
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
    return {
      total: tokens.length,
      tokens: tokens.map((token) => ({
        // jti 全值返回本人（吊销操作凭据；与 admin 令牌列表 GET /api/authn/tokens 同等暴露面——
        // 仅持 jti 无令牌本体不具备任何调用能力），jtiMasked 仅展示用
        jti: token.jti,
        jtiMasked: `${token.jti.slice(0, 8)}…`,
        label: token.label ?? '',
        issuedAt: token.issuedAt,
        expiresAt: token.expiresAt,
        lastUsedAt: token.lastUsedAt ?? null,
        revokedAt: token.revokedAt ?? null,
      })),
    }
  })

  guarded('DELETE', '/api/authn/mcp-tokens/:jti', 'console.login', (exchange) => {
    const info = caller(exchange)
    const jti = exchange.params['jti']!
    const token = ctx.authn.tokens().get(jti)
    // 非本人的令牌按不存在处理（不泄露他人令牌存在性）；管理员吊销走既有 DELETE /api/authn/tokens/:jti
    if (!token || token.principalId !== info.principalId) {
      exchange.fail(404, 'NOT_FOUND', t('令牌不存在：{jti}', { jti: jti.slice(0, 8) }))
      return
    }
    ctx.authn.revokeToken(jti, t('员工自助吊销（我的接入）'))
    changeLog(exchange, 'authn.mcp_token.revoke', 'token', jti.slice(0, 8), token.label ?? '')
    return { revoked: true }
  })

  // 委托令牌交换（MCP 治理契约 §3，RFC 8693 风格）：公开路径 + 自带 Bearer 校验
  // （仿 /api/auth/client-credentials 的公开端点模式，白名单见 plugin-console/src/index.ts PUBLIC_PATHS）。
  // 授权事实校验由 console 装配处注入的 delegationGuard 承担（agent bindings / app owner / iam 管理员），
  // 未装配一律 fail-closed 拒绝。错误以 extra.reason 带稳定原因码（DELEGATION_*，文案面沿用 FORBIDDEN/BAD_REQUEST）。
  http.register('POST', '/api/authn/token/exchange', async (exchange) => {
    const header = String(exchange.headers['authorization'] ?? '')
    if (!header.startsWith('Bearer ')) {
      exchange.fail(401, 'UNAUTHORIZED', t('缺少 Bearer 令牌：令牌交换以调用者令牌为授权事实'))
      return
    }
    let caller
    try {
      caller = ctx.authn.verify(header.slice(7))
    } catch (error) {
      exchange.fail(401, 'TOKEN_INVALID', error instanceof Error ? error.message : String(error))
      return
    }
    const input = body<{ userId?: string; targetPrincipalId?: string; audience?: string; scopes?: string[]; ttlSeconds?: number }>(exchange)
    if (!input.audience) {
      exchange.fail(400, 'BAD_REQUEST', t('audience 必填（mcp:service:<slug> 或 plugin:<id>）'))
      return
    }
    try {
      const result = await ctx.authn.exchangeDelegatedToken({
        caller,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.targetPrincipalId !== undefined ? { targetPrincipalId: input.targetPrincipalId } : {}),
        audience: input.audience,
        ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
      })
      exchange.ok({
        access_token: result.token,
        token_type: 'Bearer',
        expires_in: Math.max(1, Math.round((new Date(result.record.expiresAt).getTime() - new Date(result.record.issuedAt).getTime()) / 1000)),
        scope: result.record.scopes.join(' '),
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof DelegationError ? error.code : 'DELEGATION_FAILED'
      const forbidden = code === 'DELEGATION_DENIED' || code === 'DELEGATION_GUARD_UNAVAILABLE'
      if (forbidden) exchange.fail(403, 'FORBIDDEN', message, { reason: code })
      else exchange.fail(400, 'BAD_REQUEST', message, { reason: code })
    }
  }, { access: 'public' })

  // 受众校验自检（令牌内省：验证 aud 收紧语义，供运维与联调使用）
  http.register('POST', '/api/authn/verify-audience', async (exchange) => {
    const info = caller(exchange)
    if (!info.permissions.includes('*') && !info.permissions.includes('authn.principal.read')) {
      exchange.fail(403, 'FORBIDDEN', t('缺少权限点 authn.principal.read'))
      return
    }
    const input = body<{ token: string; audience: string }>(exchange)
    if (!input.token || !input.audience) {
      exchange.fail(400, 'BAD_REQUEST', t('token 与 audience 必填'))
      return
    }
    try {
      const verified = ctx.authn.verify(input.token, { audience: input.audience })
      exchange.ok({ valid: true, principalId: verified.principal.id, scopes: verified.scopes })
    } catch (error) {
      exchange.ok({ valid: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }, { access: 'guarded', permission: 'authn.principal.read' })

  guarded('DELETE', '/api/authn/tokens/:jti', 'authn.token.revoke', (exchange) => {
    const { reason } = body<{ reason?: string }>(exchange)
    const record = ctx.authn.revokeToken(exchange.params['jti']!, reason ?? t('控制台吊销'))
    changeLog(exchange, 'authn.token.revoke', 'token', record.jti, record.jti, reason ?? '')
    return record
  })

  guarded('POST', '/api/authn/rotate-secret', 'authn.token.revoke', (exchange) => {
    const result = ctx.authn.rotateSigningSecret()
    changeLog(exchange, 'authn.secret.rotate', 'platform', 'signing-secret', '', t('签名密钥轮换（旧密钥 {hours}h 宽限期内仍可验签）', { hours: result.graceMs / 3600_000 }))
    return { rotated: true, graceHours: result.graceMs / 3600_000 }
  })

  // OIDC 客户端管理（模式 B：外部应用以平台为 IdP；管理员全局兜底面）
  guarded('GET', '/api/authn/oidc/clients', 'authn.oidc.read', (exchange) => ({
    clients: ctx.oidc.listClients().map((client) => ({
      ...client,
      status: client.status ?? 'active',
      clientType: client.clientType ?? 'confidential',
      discovery: {
        issuer: ctx.oidc.issuer(exchange),
        authorization_endpoint: `${ctx.oidc.issuer(exchange)}/oauth/authorize`,
        token_endpoint: `${ctx.oidc.issuer(exchange)}/oauth/token`,
        userinfo_endpoint: `${ctx.oidc.issuer(exchange)}/oauth/userinfo`,
      },
    })),
  }))

  guarded('POST', '/api/authn/oidc/clients', 'authn.oidc.write', (exchange) => {
    const input = body<{ name: string; redirectUris: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[]; clientType?: 'confidential' | 'public' }>(exchange)
    if (!input.name || !Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
      throw new Error(t('name 与 redirectUris（至少一个回调地址）必填'))
    }
    AppRegistryService.assertRedirectUris(input.redirectUris)
    const created = ctx.oidc.createClient({
      name: input.name,
      redirectUris: input.redirectUris,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.consentRequired !== undefined ? { consentRequired: input.consentRequired } : {}),
      ...(input.postLogoutUris !== undefined ? { postLogoutUris: input.postLogoutUris } : {}),
      ...(input.clientType !== undefined ? { clientType: input.clientType } : {}),
    })
    changeLog(exchange, 'authn.oidc.client.create', 'oidc_client', created.client.id, created.client.name, input.clientType === 'public' ? t('public 客户端（免 secret）') : '')
    return { clientId: created.client.clientId, clientSecret: created.clientSecret, redirectUris: created.client.redirectUris, note: created.client.clientType === 'public' ? t('public 客户端无 secret（强制 PKCE）') : t('clientSecret 仅此一次返回') }
  })

  guarded('PATCH', '/api/authn/oidc/clients/:id', 'authn.oidc.write', (exchange) => {
    const input = body<{ name?: string; redirectUris?: string[]; description?: string; consentRequired?: boolean; postLogoutUris?: string[] }>(exchange)
    const updated = ctx.oidc.updateClient(exchange.params['id']!, input)
    changeLog(exchange, 'authn.oidc.client.update', 'oidc_client', updated.id, updated.name)
    return updated
  })

  guarded('POST', '/api/authn/oidc/clients/:id/rotate', 'authn.oidc.write', (exchange) => {
    const rotated = ctx.oidc.rotateSecret(exchange.params['id']!)
    changeLog(exchange, 'authn.oidc.client.rotate', 'oidc_client', rotated.client.id, rotated.client.name, t('旧 secret 立即失效'))
    return { clientId: rotated.client.clientId, clientSecret: rotated.clientSecret, note: t('新 clientSecret 仅此一次返回，旧值立即失效') }
  })

  for (const [action, label] of [['disable', '禁用'], ['enable', '启用']] as const) {
    guarded('POST', `/api/authn/oidc/clients/:id/${action}`, 'authn.oidc.write', (exchange) => {
      const { reason } = body<{ reason?: string }>(exchange)
      const client = action === 'disable'
        ? ctx.oidc.disableClient(exchange.params['id']!, reason ?? t('控制台手动禁用'))
        : ctx.oidc.enableClient(exchange.params['id']!)
      changeLog(exchange, `authn.oidc.client.${action}`, 'oidc_client', client.id, client.name, reason ?? '')
      return client
    })
  }

  /** JWKS 签名密钥轮换：新 key 立即签名，旧 key 24h 验签宽限（在途令牌不掉线）。 */
  guarded('POST', '/api/authn/oidc/keys/rotate', 'authn.oidc.write', (exchange) => {
    const result = ctx.oidc.rotateKeys()
    changeLog(exchange, 'authn.oidc.keys.rotate', 'platform', 'oidc-keys', '', t('新 kid={kid}，旧 key {hours}h 宽限', { kid: result.kid, hours: result.graceHours }))
    return { rotated: true, kid: result.kid, graceHours: result.graceHours }
  })

  guarded('GET', '/api/authn/oidc/discovery', 'authn.principal.read', (exchange) => ctx.oidc.discovery(exchange))
}
