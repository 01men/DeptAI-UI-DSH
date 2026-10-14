/**
 * 接入宿主端点：远程 dsh 运行时（插件市场安装形态）向本平台申请凭证的管理面。
 *
 * 流程（对应 docs/deploy-enterprise.md 形态 C）：
 *   1. 管理员在控制台/CLI 创建一次性接入码（TTL + 权限模板）
 *   2. 远程电脑 dsh 安装插件后，Agent 调 connect_setup 或打开本地配置页，
 *      以接入码调 POST /api/connect/enroll 换取机器凭证（clientId/clientSecret）
 *   3. 客户端以机器凭证走 client-credentials 换机器令牌，工具调用全部经
 *      /api/tools/execute 在宿主侧执行（权限按模板快照收敛）
 *
 * 安全基线：接入码只存哈希（创建时一次性展示）、一次性消费、TTL 默认 15 分钟、
 * 按 来源 IP 接入宿主既有失败锁定（15 分钟窗口 5 次锁定）、全程审计。
 */
import type { Context } from '@deepseek-ai/cordis'
import { generateSecret, mask, newId, sha256Hex, PlatformEvents, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import { PermissionCatalog } from '../../plugin-iam/src/index.ts'
import { defineTool } from '../../platform-core/src/index.ts'

/** 接入码记录（code 仅存哈希，创建时一次性返回明文）。 */
export interface EnrollCodeRecord extends RecordBase {
  codeHash: string
  codeMask: string
  template: TemplateName
  remark: string
  createdBy: string
  createdAt: string
  expiresAt: string
  usedAt?: string
  usedBy?: string
  revokedAt?: string
}

/** 已接入客户端登记（principalId 关联 authn 机器身份）。 */
export interface ConnectClientRecord extends RecordBase {
  principalId: string
  clientId: string
  name: string
  template: TemplateName
  hostname: string
  platform: string
  enrolledBy: string
  enrolledAt: string
  status: 'active' | 'disabled'
  /** 最近一次心跳时间（客户端接入后周期性主动上报，宿主侧做接入资产存活监测）。 */
  lastHeartbeatAt?: string
  /** 心跳携带的运行元信息（客户端自报，未校验口径，仅作观测展示）。 */
  heartbeat?: { tools?: number; version?: string; uptimeSec?: number }
}

export type TemplateName = 'readonly' | 'operator' | 'full'

export interface TemplateSpec {
  name: TemplateName
  label: string
  description: string
  scopes: string[]
}

const DEFAULT_TTL_MINUTES = 15
const MAX_TTL_MINUTES = 24 * 60

/** 权限模板：接入码创建时快照语义，enroll 时按当前权限目录解析为具体权限点。 */
export function connectTemplates(): Array<Omit<TemplateSpec, 'scopes'>> {
  return [
    { name: 'readonly', label: '只读运维', description: '全部查询类权限点（list/get/metrics/logs），适合只读巡检 Agent' },
    { name: 'operator', label: '运维（读 + 资源变更）', description: '只读 + MCP/Skill/Agent/应用运维与审批决策；不含账号与凭证管理' },
    { name: 'full', label: '全部权限（*）', description: '等价平台管理员，仅可信环境使用' },
  ]
}

export function templateScopes(template: TemplateName): string[] {
  if (template === 'full') return ['*']
  const readPoints = PermissionCatalog.filter((item) => item.point.endsWith('.read') || item.point === 'console.login').map((item) => item.point)
  if (template === 'readonly') return readPoints
  const operatorExtra = [
    'mcp.service.write', 'mcp.service.deploy', 'mcp.service.offline', 'mcp.permgroup.write', 'mcp.invoke',
    'skill.submit', 'skill.install', 'agent.write', 'agent.offline', 'app.write', 'app.offline',
    'approval.decide', 'usage.write', 'audit.rule.write',
  ]
  return [...new Set([...readPoints, ...operatorExtra])]
}

export function codesCollection(ctx: Context): Collection<EnrollCodeRecord> {
  const collection = ctx.opsStorage.collection<EnrollCodeRecord>('connect:codes')
  collection.uniqueOn('connect_code_hash', (record) => record.codeHash)
  return collection
}

export function clientsCollection(ctx: Context): Collection<ConnectClientRecord> {
  const collection = ctx.opsStorage.collection<ConnectClientRecord>('connect:clients')
  collection.uniqueOn('connect_client_principal', (record) => record.principalId)
  return collection
}

// ---------------------------------------------------------------------------
// REST 装配（挂载在宿主 httpServer 上；除 enroll 外均由 console 鉴权中间件保护）
// ---------------------------------------------------------------------------

/** 客户端定位：登记记录 ID 或机器凭证 clientId（mc- 开头）均可。 */
function findClient(ctx: Context, key: string): ConnectClientRecord | undefined {
  const clients = clientsCollection(ctx)
  return clients.get(key) ?? clients.findOne((item) => item.clientId === key)
}

export interface ConnectHostApiConfig {
  /** enroll 端点对外的展示信息。 */
  hubName?: string
  hubVersion?: string
}

export const connectHostApi = {
  name: 'connect-host-api',
  inject: ['httpServer', 'opsStorage', 'platformBus', 'authn', 'iam', 'audit'],
  apply(ctx: Context, config: ConnectHostApiConfig = {}) {
    const http = ctx.httpServer

    const requireManage = (exchange: { principal?: unknown; fail: (status: number, code: string, message: string, extra?: Record<string, unknown>) => void; path: string }): boolean => {
      const info = exchange.principal as { permissions?: string[]; principalId?: string; userId?: string; name?: string } | undefined
      const permissions = info?.permissions ?? []
      if (permissions.includes('*') || permissions.includes('connect.manage')) return true
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info?.userId ?? info?.principalId ?? 'anonymous',
        actorName: info?.name ?? 'anonymous',
        point: 'connect.manage',
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', '缺少权限点 connect.manage，请联系平台管理员', { permission: 'connect.manage' })
      return false
    }

    // -- 接入码换机器凭证（公开端点，接入码本身即凭证；按 IP 失败锁定） ---------
    http.register('POST', '/api/connect/enroll', async (exchange) => {
      const input = (exchange.body ?? {}) as { enrollmentCode?: string; clientName?: string; meta?: { hostname?: string; platform?: string; node?: string } }
      const code = (input.enrollmentCode ?? '').trim()
      const ip = exchange.raw.socket.remoteAddress ?? 'unknown'
      const throttleKey = `connect-enroll:${ip}`
      const failEnroll = (message: string): void => {
        ctx.authn.recordLoginFailure(throttleKey)
        ctx.audit.record({
          type: 'auth', actorType: 'machine', actorId: ip, actorName: input.clientName ?? 'unknown-client',
          action: 'connect.enroll', resourceType: 'connect', resourceId: '-', resourceName: '接入申请',
          result: 'denied', detail: message,
        })
        exchange.fail(401, 'ENROLL_FAILED', message)
      }
      try {
        ctx.authn.assertNotLocked(throttleKey)
      } catch (error) {
        exchange.fail(429, 'LOCKED', error instanceof Error ? error.message : String(error))
        return
      }
      if (!code) { failEnroll('接入码必填：请在宿主控制台「平台接入」创建'); return }
      const record = codesCollection(ctx).findOne((item) => item.codeHash === sha256Hex(code))
      if (!record) { failEnroll('接入码无效（不存在或已输入错误）'); return }
      if (record.revokedAt) { failEnroll('接入码已作废，请联系管理员重新签发'); return }
      if (record.usedAt) { failEnroll('接入码已被使用（一次性消费，防重放），请申请新码'); return }
      if (new Date(record.expiresAt).getTime() < Date.now()) { failEnroll('接入码已过期，请申请新码'); return }

      ctx.authn.recordLoginSuccess(throttleKey)
      codesCollection(ctx).update(record.id, { usedAt: new Date().toISOString(), usedBy: input.clientName ?? 'unnamed' })
      const scopes = templateScopes(record.template)
      const credential = ctx.authn.createMachineCredential({
        name: input.clientName?.trim() || 'dsh-client',
        refType: 'external',
        scopes,
      })
      clientsCollection(ctx).insert({
        id: newId('ccl'),
        principalId: credential.principal.id,
        clientId: credential.clientId,
        name: input.clientName?.trim() || 'dsh-client',
        template: record.template,
        hostname: input.meta?.hostname ?? '',
        platform: [input.meta?.platform, input.meta?.node].filter(Boolean).join('/') || '',
        enrolledBy: `code:${record.codeMask}`,
        enrolledAt: new Date().toISOString(),
        status: 'active',
      })
      ctx.audit.record({
        type: 'auth', actorType: 'machine', actorId: credential.principal.id, actorName: credential.principal.name,
        action: 'connect.enroll', resourceType: 'connect', resourceId: credential.clientId,
        resourceName: credential.principal.name, result: 'ok',
        detail: `接入码 ${record.codeMask}（模板 ${record.template}）换取机器凭证`,
      })
      ctx.platformBus.emit(PlatformEvents.ConnectClientEnrolled, {
        principalId: credential.principal.id, name: credential.principal.name, template: record.template, hostname: input.meta?.hostname ?? '',
      })
      exchange.ok({
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        principalId: credential.principal.id,
        template: record.template,
        hub: { name: config.hubName ?? '元冰可|企业AI资源管理平台', version: config.hubVersion ?? '1.0.0' },
        notice: '机器凭证仅本次返回，请妥善保存；后续用它在 /api/auth/client-credentials 换取机器令牌',
      })
    }, { access: 'public', selfValidated: true })

    // -- 客户端心跳（接入方主动推送存活/运行元信息；高频不入审计，避免刷爆日志） ----
    http.register('POST', '/api/connect/heartbeat', (exchange) => {
      const info = exchange.principal as { principalId?: string } | undefined
      if (!info?.principalId) { exchange.fail(401, 'UNAUTHORIZED', '缺少 Bearer 令牌'); return }
      const client = clientsCollection(ctx).findOne((item) => item.principalId === info.principalId)
      if (!client) { exchange.fail(404, 'NOT_FOUND', '该身份未登记为接入客户端（仅远程 dsh 客户端可上报心跳）'); return }
      const input = (exchange.body ?? {}) as { tools?: number; version?: string; uptimeSec?: number }
      clientsCollection(ctx).update(client.id, {
        lastHeartbeatAt: new Date().toISOString(),
        heartbeat: {
          ...(typeof input.tools === 'number' ? { tools: Math.max(0, Math.floor(input.tools)) } : {}),
          ...(typeof input.version === 'string' ? { version: input.version.slice(0, 40) } : {}),
          ...(typeof input.uptimeSec === 'number' ? { uptimeSec: Math.max(0, Math.floor(input.uptimeSec)) } : {}),
        },
      })
      exchange.ok({ ok: true, clientId: client.clientId, template: client.template })
    }, { access: 'authenticated' })

    // -- 接入码管理 ----------------------------------------------------------
    http.register('POST', '/api/connect/codes', (exchange) => {
      if (!requireManage(exchange)) return
      const input = (exchange.body ?? {}) as { template?: string; ttlMinutes?: number; remark?: string }
      const template = (['readonly', 'operator', 'full'] as const).includes(input.template as TemplateName) ? input.template as TemplateName : 'readonly'
      const ttlMinutes = Math.min(Math.max(Math.floor(Number(input.ttlMinutes) || DEFAULT_TTL_MINUTES), 1), MAX_TTL_MINUTES)
      const code = generateSecret('enr')
      const info = exchange.principal as { userId?: string; principalId?: string; name?: string }
      const record = codesCollection(ctx).insert({
        id: newId('enc'),
        codeHash: sha256Hex(code),
        codeMask: mask(code, 6),
        template,
        remark: (input.remark ?? '').slice(0, 120),
        createdBy: info?.name ?? 'api',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      })
      ctx.audit.record({
        type: 'change', actorType: 'human', actorId: info?.userId ?? info?.principalId ?? 'api', actorName: info?.name ?? 'api',
        action: 'connect.code.create', resourceType: 'connect', resourceId: record.id,
        resourceName: record.codeMask, result: 'ok',
        detail: `模板 ${template}，有效期 ${ttlMinutes} 分钟`,
      })
      ctx.platformBus.emit(PlatformEvents.ConnectCodeCreated, { id: record.id, template, ttlMinutes })
      exchange.ok({ id: record.id, code, codeMask: record.codeMask, template, ttlMinutes, expiresAt: record.expiresAt, notice: '接入码仅本次返回且一次性消费，请立即复制分发' })
    }, { access: 'guarded', permission: 'connect.manage' })

    http.register('GET', '/api/connect/codes', (exchange) => {
      if (!requireManage(exchange)) return
      const now = Date.now()
      exchange.ok({
        codes: codesCollection(ctx).all()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((record) => ({
            ...record,
            status: record.revokedAt ? 'revoked' : record.usedAt ? 'used' : new Date(record.expiresAt).getTime() < now ? 'expired' : 'active',
          })),
      })
    }, { access: 'guarded', permission: 'connect.manage' })

    http.register('DELETE', '/api/connect/codes/:id', (exchange) => {
      if (!requireManage(exchange)) return
      const record = codesCollection(ctx).get(exchange.params['id']!)
      if (!record) { exchange.fail(404, 'NOT_FOUND', '接入码不存在'); return }
      if (record.usedAt) { exchange.fail(400, 'BAD_REQUEST', '接入码已被使用，无法作废；如需回收请直接禁用对应客户端'); return }
      codesCollection(ctx).update(record.id, { revokedAt: new Date().toISOString() })
      const info = exchange.principal as { userId?: string; principalId?: string; name?: string }
      ctx.audit.record({
        type: 'change', actorType: 'human', actorId: info?.userId ?? info?.principalId ?? 'api', actorName: info?.name ?? 'api',
        action: 'connect.code.revoke', resourceType: 'connect', resourceId: record.id,
        resourceName: record.codeMask, result: 'ok', detail: '作废未使用接入码',
      })
      exchange.ok({ id: record.id, status: 'revoked' })
    }, { access: 'guarded', permission: 'connect.manage' })

    // -- 已接入客户端管理 -----------------------------------------------------
    http.register('GET', '/api/connect/clients', (exchange) => {
      if (!requireManage(exchange)) return
      const clients = clientsCollection(ctx).all()
        .sort((a, b) => b.enrolledAt.localeCompare(a.enrolledAt))
        .map((client) => {
          const principal = ctx.authn.principals().get(client.principalId)
          const activeTokens = ctx.authn.activeTokenCount(client.principalId)
          const tokens = ctx.authn.tokens().find((item) => item.principalId === client.principalId)
          const lastUsedAt = tokens
            .map((token) => token.lastUsedAt ?? '')
            .filter(Boolean)
            .sort()
            .at(-1) ?? ''
          return {
            ...client,
            scopes: principal?.scopes ?? [],
            principalStatus: principal?.status ?? 'disabled',
            activeTokens,
            lastUsedAt,
          }
        })
      exchange.ok({ clients, templates: connectTemplates() })
    }, { access: 'guarded', permission: 'connect.manage' })

    http.register('POST', '/api/connect/clients/:id/disable', (exchange) => {
      if (!requireManage(exchange)) return
      const input = (exchange.body ?? {}) as { reason?: string }
      const reason = (input.reason ?? '').trim()
      if (!reason) { exchange.fail(400, 'BAD_REQUEST', '禁用原因必填（留痕要求）'); return }
      const client = findClient(ctx, exchange.params["id"]!)
      if (!client) { exchange.fail(404, 'NOT_FOUND', '客户端不存在'); return }
      ctx.authn.disablePrincipal(client.principalId, `接入客户端禁用：${reason}`)
      clientsCollection(ctx).update(client.id, { status: 'disabled' })
      const info = exchange.principal as { userId?: string; principalId?: string; name?: string }
      ctx.audit.record({
        type: 'change', actorType: 'human', actorId: info?.userId ?? info?.principalId ?? 'api', actorName: info?.name ?? 'api',
        action: 'connect.client.disable', resourceType: 'connect', resourceId: client.id,
        resourceName: client.name, result: 'ok', detail: `原因：${reason}（联动吊销全部令牌）`,
      })
      ctx.platformBus.emit(PlatformEvents.ConnectClientDisabled, { principalId: client.principalId, name: client.name, reason })
      exchange.ok({ id: client.id, status: 'disabled' })
    }, { access: 'guarded', permission: 'connect.manage' })

    http.register('POST', '/api/connect/clients/:id/enable', (exchange) => {
      if (!requireManage(exchange)) return
      const client = findClient(ctx, exchange.params["id"]!)
      if (!client) { exchange.fail(404, 'NOT_FOUND', '客户端不存在'); return }
      ctx.authn.enablePrincipal(client.principalId)
      clientsCollection(ctx).update(client.id, { status: 'active' })
      const info = exchange.principal as { userId?: string; principalId?: string; name?: string }
      ctx.audit.record({
        type: 'change', actorType: 'human', actorId: info?.userId ?? info?.principalId ?? 'api', actorName: info?.name ?? 'api',
        action: 'connect.client.enable', resourceType: 'connect', resourceId: client.id,
        resourceName: client.name, result: 'ok', detail: '恢复接入客户端',
      })
      exchange.ok({ id: client.id, status: 'active' })
    }, { access: 'guarded', permission: 'connect.manage' })
  },
}

// ---------------------------------------------------------------------------
// 宿主侧对模型暴露的工具（dsh Agent 在宿主侧用自然语言管理接入）
// ---------------------------------------------------------------------------

export const connectHostTools = {
  name: 'connect-host-tools',
  inject: ['tools', 'authn', 'audit', 'platformBus'],
  apply(ctx: Context) {
    const t = ctx.tools

    t.register(defineTool({
      name: 'connect_code_create',
      description: '创建一次性接入码（远程 dsh/Agent 凭此向本平台申请机器凭证）。默认只读模板、15 分钟有效。',
      permission: 'connect.manage',
      parameters: {
        template: { type: 'string', enum: ['readonly', 'operator', 'full'], description: '权限模板：readonly 只读 / operator 运维（读+资源变更）/ full 全权限' },
        ttlMinutes: { type: 'integer', description: '有效分钟数（1-1440，默认 15）' },
        remark: { type: 'string', description: '用途备注（留痕）' },
      },
      output: { type: 'object', additionalProperties: true },
      async execute(args) {
        const code = generateSecret('enr')
        const template = (args.template ?? 'readonly') as TemplateName
        const ttlMinutes = Math.min(Math.max(Math.floor(Number(args.ttlMinutes) || 15), 1), MAX_TTL_MINUTES)
        const record = codesCollection(ctx).insert({
          id: newId('enc'),
          codeHash: sha256Hex(code),
          codeMask: mask(code, 6),
          template,
          remark: String(args.remark ?? '').slice(0, 120),
          createdBy: 'tool:connect_code_create',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
        })
        return {
          code, codeMask: record.codeMask, template, ttlMinutes, expiresAt: record.expiresAt,
          notice: '接入码仅本次返回、一次性消费：交给远程电脑执行 connect_setup { hubUrl, enrollmentCode } 即完成接入',
        }
      },
    }))

    t.register(defineTool({
      name: 'connect_codes',
      description: '列出接入码（含使用状态：active 已用/过期/作废）。',
      permission: 'connect.manage',
      parameters: {},
      output: { type: 'object', additionalProperties: true },
      async execute() {
        const now = Date.now()
        const codes = codesCollection(ctx).all().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        return {
          total: codes.length,
          codes: codes.map((record) => ({
            codeMask: record.codeMask, template: record.template, remark: record.remark,
            createdBy: record.createdBy, createdAt: record.createdAt, expiresAt: record.expiresAt,
            usedAt: record.usedAt ?? '', usedBy: record.usedBy ?? '',
            status: record.revokedAt ? 'revoked' : record.usedAt ? 'used' : new Date(record.expiresAt).getTime() < now ? 'expired' : 'active',
          })),
        }
      },
    }))

    t.register(defineTool({
      name: 'connect_clients',
      description: '列出已接入的远程 dsh/Agent 客户端（含权限模板、最近使用、最近心跳、令牌数）。',
      permission: 'connect.manage',
      parameters: {},
      output: { type: 'object', additionalProperties: true },
      async execute() {
        const clients = clientsCollection(ctx).all().sort((a, b) => b.enrolledAt.localeCompare(a.enrolledAt))
        return {
          total: clients.length,
          clients: clients.map((client) => ({
            name: client.name, clientId: client.clientId, template: client.template,
            hostname: client.hostname, platform: client.platform,
            enrolledAt: client.enrolledAt, status: client.status,
            lastHeartbeatAt: client.lastHeartbeatAt ?? '', heartbeat: client.heartbeat ?? {},
            activeTokens: ctx.authn.activeTokenCount(client.principalId),
          })),
        }
      },
    }))

    t.register(defineTool({
      name: 'connect_client_disable',
      description: '禁用接入客户端（联动吊销其全部令牌，远程工具调用立即失效）。必须给出 reason。',
      permission: 'connect.manage',
      parameters: {
        clientId: { type: 'string', required: true, description: '客户端 clientId（mc- 开头）' },
        reason: { type: 'string', required: true, description: '禁用原因（永久留痕）' },
      },
      output: { type: 'object', additionalProperties: true },
      async execute(args) {
        const client = clientsCollection(ctx).findOne((item) => item.clientId === String(args.clientId))
        if (!client) throw new Error(`接入客户端不存在：${args.clientId}`)
        ctx.authn.disablePrincipal(client.principalId, `接入客户端禁用：${args.reason}`)
        clientsCollection(ctx).update(client.id, { status: 'disabled' })
        ctx.audit.record({
          type: 'change', actorType: 'machine', actorId: 'tool:connect_client_disable', actorName: 'dsh Agent',
          action: 'connect.client.disable', resourceType: 'connect', resourceId: client.id,
          resourceName: client.name, result: 'ok', detail: `原因：${args.reason}`,
        })
        ctx.platformBus.emit(PlatformEvents.ConnectClientDisabled, { principalId: client.principalId, name: client.name, reason: String(args.reason) })
        return { id: client.id, name: client.name, status: 'disabled', note: '已联动吊销全部令牌' }
      },
    }))
  },
}
