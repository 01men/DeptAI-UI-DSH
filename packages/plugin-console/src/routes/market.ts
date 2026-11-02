/**
 * 第三方插件市场路由（OPT-P1-01 首段迁移，2026-09-12）：
 * 自 plugin-console/index.ts 拆出——开发者自助注册/登录（公开）、提交与两级审批、
 * 安装/卸载、提示词包、沙箱边界自检。helpers（guarded/body/changeLog/caller）经依赖注入，
 * 行为与迁出前逐字一致（契约 lint 双向比对护航）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../../platform-core/src/index.ts'
import { createPluginContext } from '../../../platform-core/src/index.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'

export function registerMarketRoutes(ctx: Context, deps: ConsoleRouteDeps): void {
  const { http, guarded, body, changeLog, caller } = deps
  // 开发者自助注册（独立身份域，M2）：Ed25519 公钥 + 密码
  http.register('POST', '/api/market/developers/register', async (exchange) => {
    const input = body<{ username: string; displayName: string; email: string; password: string; publicKey: string; company?: string; payoutAccount?: string }>(exchange)
    try {
      const result = ctx.market.registerDeveloper(input)
      const { passwordHash, passwordSalt, ...safe } = result.developer
      void passwordHash
      void passwordSalt
      exchange.ok({ developer: safe, token: result.token })
    } catch (error) {
      exchange.fail(400, 'DEVELOPER_REGISTER_FAILED', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'public' })

  http.register('POST', '/api/market/developers/login', async (exchange) => {
    const input = body<{ username: string; password: string }>(exchange)
    try {
      const result = ctx.market.loginDeveloper(input.username, input.password)
      exchange.ok({ developer: { id: result.developer.id, username: result.developer.username, displayName: result.developer.displayName }, token: result.token })
    } catch (error) {
      exchange.fail(401, 'DEVELOPER_LOGIN_FAILED', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'public' })

  /** 开发者身份解析：机器主体 refId=developerId（独立身份域，与 iam 员工域分离）。 */
  const developerCaller = (exchange: HttpExchange) => {
    const info = caller(exchange)
    if (info.permissions.includes('*')) return undefined // 管理员走管理路由
    const developer = ctx.market.developerOfPrincipal(info.principalId)
    if (!developer) throw new Error(t('当前令牌不是开发者身份（请用 /api/market/developers/login）'))
    return developer
  }

  http.register('POST', '/api/market/submit', async (exchange) => {
    try {
      const developer = developerCaller(exchange)
      if (!developer) {
        exchange.fail(403, 'FORBIDDEN', t('插件提交仅限开发者身份'))
        return
      }
      const input = body<{ files: Record<string, string>; signature: string }>(exchange)
      const record = ctx.market.submit(developer, input.files ?? {}, input.signature ?? '')
      changeLog(exchange, 'market.plugin.submit', 'plugin_submission', record.id, `${record.pluginId}@${record.version}`)
      const { files, parsed, ...safe } = record
      void files
      void parsed
      exchange.ok(safe)
    } catch (error) {
      exchange.fail(400, 'MARKET_SUBMIT_FAILED', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'authenticated' })

  guarded('GET', '/api/market/submissions/mine', 'market.developer', (exchange) => {
    const developer = developerCaller(exchange)
    return { submissions: ctx.market.submissions().find((item) => item.developerId === developer?.id) }
  })

  guarded('GET', '/api/market/submissions', 'market.approve', (exchange) => ({
    submissions: ctx.market.submissions().find((item) =>
      exchange.query.get('status') ? item.status === exchange.query.get('status') : true),
  }))

  guarded('POST', '/api/market/submissions/:id/approve', 'market.approve', (exchange) => {
    const info = caller(exchange)
    const { opinion } = body<{ opinion?: string }>(exchange)
    const record = ctx.market.approve(exchange.params['id']!, info.name, opinion ?? t('审核通过'))
    changeLog(exchange, 'market.plugin.approve', 'plugin_submission', record.id, `${record.pluginId}@${record.version}`)
    return record
  })

  guarded('POST', '/api/market/submissions/:id/reject', 'market.approve', (exchange) => {
    const info = caller(exchange)
    const { reason } = body<{ reason?: string }>(exchange)
    return ctx.market.reject(exchange.params['id']!, info.name, reason ?? t('不通过'))
  })

  guarded('GET', '/api/market/plugins', 'market.read', () => ({
    plugins: ctx.market.listed().map((item) => ({
      id: item.id, pluginId: item.pluginId, version: item.version, developer: item.developerName,
      capabilities: item.parsed.capabilities_request, permissions: item.parsed.permissions.requested,
      metering: { usageKey: item.parsed.billing.usage[0]?.key ?? null, unit: item.parsed.billing.usage[0]?.unit ?? null },
      installs: item.installs, contentHash: item.contentHash,
    })),
  }))

  guarded('POST', '/api/market/plugins/:pluginId/install', 'market.install', (exchange) => {
    const info = caller(exchange)
    const input = body<{ orgId: string; tenantId?: string; approvedCapabilities: string[]; approvedPermissions?: string[] }>(exchange)
    const org = ctx.iam.orgs().get(input.orgId)
    if (!org) throw new Error(t('组织不存在：{id}', { id: input.orgId }))
    const tenantId = input.tenantId ?? org.tenantId ?? 't_default'
    const record = ctx.market.install({
      pluginId: exchange.params['pluginId']!,
      orgId: input.orgId,
      tenantId,
      approvedCapabilities: input.approvedCapabilities ?? [],
      approvedPermissions: input.approvedPermissions ?? [],
      installedBy: info.name,
    })
    changeLog(exchange, 'market.plugin.install', 'plugin_install', record.id, record.pluginId, t('能力审批：{capabilities}', { capabilities: record.capabilities.join(',') }))
    return record
  })

  guarded('GET', '/api/market/installed', 'market.read', (exchange) => ({
    installs: ctx.market.installs().find((item) => {
      const orgId = exchange.query.get('orgId')
      return orgId ? item.orgId === orgId : true
    }),
  }))

  guarded('POST', '/api/market/plugins/:pluginId/uninstall', 'market.install', (exchange) => {
    const info = caller(exchange)
    const { orgId } = body<{ orgId: string }>(exchange)
    const record = ctx.market.uninstall(exchange.params['pluginId']!, orgId, info.name)
    changeLog(exchange, 'market.plugin.uninstall', 'plugin_install', record.id, record.pluginId)
    return record
  })

  guarded('GET', '/api/market/prompts', 'market.read', (exchange) => {
    const orgId = exchange.query.get('orgId') ?? ''
    return { prompts: ctx.market.promptPacks(orgId) }
  })

  guarded('POST', '/api/market/prompts/use', 'market.read', (exchange) => {
    const info = caller(exchange)
    const input = body<{ orgId: string; pluginId: string; promptName: string }>(exchange)
    ctx.market.meterPromptUse(input.orgId, input.pluginId, input.promptName, info.kind === 'human' ? `user:${info.userId ?? info.principalId}` : `app:${info.principalId}`)
    return { metered: true }
  })

  // 沙箱边界自检：轻量代理 ctx + 总线 source 校验的强制语义（插件开发者联调用）
  guarded('POST', '/api/market/sandbox-check', 'market.read', (exchange) => {
    const input = body<{ pluginId?: string; capabilities?: string[] }>(exchange)
    const pluginId = input.pluginId ?? 'com.selftest.probe'
    const capabilities = input.capabilities ?? ['knowledgebase.read']
    const results: Record<string, string> = {}
    const pctx = createPluginContext(ctx, { pluginId, capabilities })
    try { pctx.platformBus.emit(`plugin:${pluginId}:probe`, { check: true }); results.emitOwnNamespace = 'ok' } catch (error) { results.emitOwnNamespace = `blocked:${error instanceof Error ? error.message : String(error)}` }
    try { pctx.platformBus.emit('iam.user.frozen', { check: true }); results.emitPlatformViaProxy = 'UNEXPECTEDLY_ALLOWED' } catch { results.emitPlatformViaProxy = 'blocked' }
    try { ctx.platformBus.emit('iam.user.frozen', { check: true }, { source: `plugin:${pluginId}` }); results.directEmitReserved = 'UNEXPECTEDLY_ALLOWED' } catch { results.directEmitReserved = 'blocked' }
    try { ctx.platformBus.emit(`plugin:${pluginId}:forged`, { check: true }); results.pluginEventWithoutSource = 'UNEXPECTEDLY_ALLOWED' } catch { results.pluginEventWithoutSource = 'blocked' }
    try { pctx.service('usage'); results.serviceWithoutCapability = 'UNEXPECTEDLY_ALLOWED' } catch { results.serviceWithoutCapability = 'blocked' }
    const pctxGranted = createPluginContext(ctx, { pluginId, capabilities: [...capabilities, 'usage.meter'] })
    try { pctxGranted.service('usage'); results.serviceWithCapability = 'ok' } catch (error) { results.serviceWithCapability = `blocked:${error instanceof Error ? error.message : String(error)}` }
    return { pluginId, capabilities, results }
  })
}
