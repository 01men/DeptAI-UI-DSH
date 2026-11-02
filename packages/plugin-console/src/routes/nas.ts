/**
 * NAS 域路由：FS 文件存储类资产（NAS 台账/文件浏览/上传/票据下载）+ HMAC 签名分享链接（档位/吊销/权限复核三关）+ NAS 数据权限（nasAuthz 五步判定/申请审批/所有权跟踪）（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出，处理器逐字搬运（行为与迁出前一致）。
 */
import { extname } from 'node:path'
import { createReadStream } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { CallerInfo, HttpExchange, UnifiedPrincipal } from '../../../platform-core/src/index.ts'
import { humanDelegatorOf, newId } from '../../../platform-core/src/index.ts'
import { ShareLinkError, SHARE_LINK_TTL_PRESETS } from '../../../plugin-nas/src/share-link.ts'
import { RulesVersionConflictError } from '../../../plugin-nas/src/authz.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'

export interface NasRouteDeps extends ConsoleRouteDeps {
  /** 权限判定（share-link 等取流自校验通道内的复核点，实现留 createRestGate） */
  requirePermission: (exchange: HttpExchange, point: string) => boolean
  /** 对外基址推导（反代场景 x-forwarded-* 优先；定义留 index.ts 中间件层） */
  requestOrigin: (exchange: HttpExchange) => string | undefined
}

const NAS_DOWNLOAD_MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword',
  '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
}

function maskNasEntity<T extends { attrs?: Record<string, unknown> }>(nas: T): T {
  if (!nas.attrs || nas.attrs['accessToken'] === undefined) return nas
  const token = String(nas.attrs['accessToken'])
  return { ...nas, attrs: { ...nas.attrs, accessToken: token.length > 8 ? `${token.slice(0, 6)}…` : '****' } }
}

interface NasImportEntry {
  name: string
  url: string
  token: string
  nasIp: string
  error?: string
}

/**
 * 解析面向 NAS 纳管的 mcpServers JSON（synology-filestation-mcp 形态）：
 * url + headers.Authorization（Bearer 令牌）+ headers["X-NAS-IP"]（设备路由）。
 * 与 plugin-mcp 的通用导入不同，此处要求认证头与设备路由头齐备（NAS 域契约）。
 */
function parseNasMcpServersConfig(raw: string | object): NasImportEntry[] {
  let config: unknown
  if (typeof raw === 'string') {
    try {
      config = JSON.parse(raw)
    } catch {
      throw new Error(t('配置不是合法 JSON，请粘贴完整的 mcpServers 配置文本'))
    }
  } else {
    config = raw
  }
  const obj = config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : null
  if (!obj) throw new Error(t('配置须为 JSON 对象'))
  const map = (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
    ? obj.mcpServers
    : obj) as Record<string, unknown>
  const entries = Object.entries(map).filter(([, value]) => value && typeof value === 'object')
  if (entries.length === 0) throw new Error(t('未识别出任何服务条目：需要 {"mcpServers": {"名称": {"url": "…", "headers": {"Authorization": "Bearer …", "X-NAS-IP": "…"}}}}'))
  return entries.map(([name, server]) => {
    const record = server as Record<string, unknown>
    const headers = (record.headers && typeof record.headers === 'object' ? record.headers : {}) as Record<string, string>
    const authHeader = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? ''
    const nasIp = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-nas-ip')?.[1] ?? ''
    const url = typeof record.url === 'string' ? record.url.trim() : ''
    const base = { name, url, token: authHeader.replace(/^Bearer\s+/i, '').trim(), nasIp: String(nasIp).trim() }
    if (!url) return { ...base, error: t('缺少 url 字段') }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ...base, error: t('仅支持 http(s) 地址，收到 {protocol}', { protocol: parsed.protocol }) }
    } catch {
      return { ...base, error: t('url 不是合法地址：{url}', { url }) }
    }
    if (!base.token) return { ...base, error: t('缺少 headers.Authorization（Bearer 网关令牌）') }
    if (!base.nasIp) return { ...base, error: t('缺少 headers["X-NAS-IP"]（NAS 设备路由）') }
    return base
  })
}

export function registerNasRoutes(ctx: Context, deps: NasRouteDeps): void {
  const { http, guarded, body, changeLog, caller, requirePermission, requestOrigin } = deps
  // -- NAS 存储（FS 文件存储类资产） ----------------------------------------
  guarded('GET', '/api/nas', 'nas.read', (exchange) => ({
    items: ctx.nasRegistry.list({
      status: exchange.query.get('status') ?? undefined,
      q: exchange.query.get('q') ?? undefined,
    }).map((nas) => ({
      ...maskNasEntity(nas),
      health: ctx.nasRegistry.healthOf(nas.id),
      gatewayToolCount: ctx.nasRegistry.toolsOf(nas.id).length,
      availableTransitions: ctx.resourceCore.availableTransitions('nas', nas.id),
    })),
    schema: ctx.resourceCore.typeSpec('nas')?.schema,
    lifecycle: ctx.resourceCore.typeSpec('nas')?.lifecycle,
  }))

  guarded('GET', '/api/nas/:id', 'nas.read', (exchange) => {
    const nas = ctx.nasRegistry.get(exchange.params['id']!)
    if (!nas) throw new Error(t('NAS 资产不存在：{id}', { id: exchange.params['id'] }))
    return {
      ...maskNasEntity(nas),
      health: ctx.nasRegistry.healthOf(nas.id),
      gatewayTools: ctx.nasRegistry.toolsOf(nas.id),
      availableTransitions: ctx.resourceCore.availableTransitions('nas', nas.id),
      audit: ctx.audit.query({ resourceType: 'nas', resourceId: nas.id, limit: 30 }).items,
    }
  })

  guarded('POST', '/api/nas', 'nas.write', (exchange) => {
    const input = body<{ name: string; slug?: string; attrs?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const nas = ctx.nasRegistry.register({
      ...input,
      ownerId: info.userId ?? info.principalId,
      orgId: user?.orgId ?? ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
    })
    changeLog(exchange, 'nas.create', 'nas', nas.id, nas.name)
    return maskNasEntity(nas)
  })

  guarded('PATCH', '/api/nas/:id', 'nas.write', (exchange) => {
    const input = body<{ name?: string; attrs?: Record<string, unknown> }>(exchange)
    // 接入属性表单回显的是脱敏令牌（**** / 前 6 位+…）：原样保存会打穿真实令牌导致网关 401，丢弃之
    const token = input.attrs?.['accessToken']
    if (typeof token === 'string' && (/^\*+$/.test(token) || token.includes('…'))) delete input.attrs!['accessToken']
    const nas = ctx.nasRegistry.update(exchange.params['id']!, input)
    changeLog(exchange, 'nas.update', 'nas', nas.id, nas.name)
    return maskNasEntity(nas)
  })

  /** 删除 NAS 资产：草稿（从未上线）或已归档可删；被 Skill 包存储后端引用时拒绝。 */
  guarded('DELETE', '/api/nas/:id', 'nas.write', (exchange) => {
    const id = exchange.params['id']!
    const nas = ctx.nasRegistry.get(id)
    if (!nas) throw new Error(t('NAS 资产不存在：{id}', { id }))
    const storage = ctx.nasRegistry.getSkillStorage()
    if (storage.mode === 'nas' && storage.nasId === id) {
      throw new Error(t('该 NAS 正作为 Skill 包存储后端，请先在「Skill 包存储」切换为 local 或其他 NAS'))
    }
    ctx.resourceCore.remove('nas', id, { allowStates: ['draft', 'archived'] })
    ctx.nasRegistry.purge(id)
    changeLog(exchange, 'nas.delete', 'nas', id, nas.name)
    return { deleted: true }
  })

  guarded('POST', '/api/nas/:id/transition', 'nas.write', async (exchange) => {
    const { action, note } = body<{ action: string; note?: string }>(exchange)
    const info = caller(exchange)
    const id = exchange.params['id']!
    if (action === 'online') {
      const nas = await ctx.nasRegistry.online(id, info.name)
      changeLog(exchange, 'nas.online', 'nas', id, nas.name)
      return maskNasEntity(nas)
    }
    if (action === 'offline') {
      if (!note?.trim()) throw new Error(t('下线必须填写原因（护栏要求）'))
      const nas = ctx.nasRegistry.offline(id, info.name, note)
      changeLog(exchange, 'nas.offline', 'nas', id, nas.name, note)
      return maskNasEntity(nas)
    }
    if (action === 'archive') {
      const nas = ctx.nasRegistry.archive(id, info.name)
      changeLog(exchange, 'nas.archive', 'nas', id, nas.name)
      return maskNasEntity(nas)
    }
    throw new Error(t('未知操作：{action}', { action }))
  })

  guarded('POST', '/api/nas/:id/health', 'nas.read', async (exchange) => {
    return await ctx.nasRegistry.probe(exchange.params['id']!)
  })

  guarded('POST', '/api/nas/:id/sync-tools', 'nas.write', async (exchange) => {
    const tools = await ctx.nasRegistry.discoverTools(exchange.params['id']!)
    return { tools: tools.map((tool) => tool.name), count: tools.length }
  })

  /**
   * mcpServers JSON 一键纳管 NAS（synology-filestation 形态）：
   * {"mcpServers":{"synology-filestation":{"url":"http://gw:3000/mcp","headers":{"Authorization":"Bearer …","X-NAS-IP":"192.168.0.196"}}}}
   * 解析 url + 认证头 + 设备路由头 → 创建资产 → 探活 → 上线 → 工具发现。
   */
  guarded('POST', '/api/nas/import', 'nas.write', async (exchange) => {
    const input = body<{ config: string | object; name?: string; description?: string }>(exchange)
    const info = caller(exchange)
    const entries = parseNasMcpServersConfig(input.config)
    const results: Array<{ name: string; ok: boolean; nasId?: string; reachable?: boolean; tools?: number; status?: string; error?: string }> = []
    for (const entry of entries) {
      if (entry.error) {
        results.push({ name: entry.name, ok: false, error: entry.error })
        continue
      }
      try {
        const nas = ctx.nasRegistry.register({
          name: input.name && entries.length === 1 ? input.name : entry.name,
          attrs: {
            description: input.description ?? t('mcpServers JSON 导入（网关 {url}）', { url: entry.url }),
            gatewayUrl: entry.url,
            accessToken: entry.token,
            nasIp: entry.nasIp,
            rootPath: '/',
            dataClass: 'internal',
            tags: ['mcp-import'],
          },
          ownerId: info.userId ?? info.principalId,
          orgId: ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
        })
        let reachable = false
        let tools = 0
        try {
          const health = await ctx.nasRegistry.probe(nas.id)
          reachable = health.status !== 'down'
        } catch { reachable = false }
        if (reachable) {
          tools = (await ctx.nasRegistry.discoverTools(nas.id).catch(() => [])).length
        }
        let status = nas.status
        if (reachable) {
          const onlined = await ctx.nasRegistry.online(nas.id, info.name)
          status = onlined.status
        }
        changeLog(exchange, 'nas.import', 'nas', nas.id, nas.name, `reachable=${reachable}`)
        results.push({ name: entry.name, ok: true, nasId: nas.id, reachable, tools, status, ...(reachable ? {} : { error: t('网关不可达：资产保留草稿，请检查地址/令牌/网络后重试上线') }) })
      } catch (error) {
        results.push({ name: entry.name, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported: results.filter((item) => item.ok).length, results }
  })

  guarded('GET', '/api/nas/:id/fs', 'nas.read', async (exchange) => {
    const id = exchange.params['id']!
    const path = exchange.query.get('path')
    const info = caller(exchange)
    const actor = { id: info.userId ?? info.principalId, name: info.name }
    return path === null || path === '' ? await ctx.nasRegistry.listShares(id, actor) : await ctx.nasRegistry.listFiles(id, path, actor)
  })

  guarded('GET', '/api/nas/:id/fs/info', 'nas.read', async (exchange) => {
    const path = exchange.query.get('path')
    if (!path) throw new Error(t('缺少 path 查询参数'))
    const info = caller(exchange)
    return await ctx.nasRegistry.getInfo(exchange.params['id']!, path, { id: info.userId ?? info.principalId, name: info.name })
  })

  guarded('POST', '/api/nas/:id/fs/search', 'nas.read', async (exchange) => {
    const { pattern, path } = body<{ pattern: string; path?: string }>(exchange)
    if (!pattern) throw new Error(t('缺少 pattern'))
    const info = caller(exchange)
    return await ctx.nasRegistry.search(exchange.params['id']!, pattern, path ?? '/', { id: info.userId ?? info.principalId, name: info.name })
  })

  guarded('POST', '/api/nas/:id/fs/mkdir', 'nas.write', async (exchange) => {
    const { path } = body<{ path: string }>(exchange)
    const info = caller(exchange)
    const result = await ctx.nasRegistry.mkdir(exchange.params['id']!, path, { id: info.userId ?? info.principalId, name: info.name })
    return result
  })

  guarded('POST', '/api/nas/:id/fs/rename', 'nas.write', async (exchange) => {
    const { path, newName } = body<{ path: string; newName: string }>(exchange)
    const info = caller(exchange)
    const result = await ctx.nasRegistry.rename(exchange.params['id']!, path, newName, { id: info.userId ?? info.principalId, name: info.name })
    // 所有权随重命名改写（含子树前缀）。
    try {
      const parent = path.split('/').filter(Boolean).slice(0, -1)
      if (info.userId) ctx.nasAuthz.rewriteOwnershipFor(exchange.params['id']!, path, `/${[...parent, newName].filter(Boolean).join('/')}`)
    } catch (error) {
      ctx.logger('console').warn('文件所有权改写失败（不影响重命名）', error)
    }
    return result
  })

  guarded('POST', '/api/nas/:id/fs/delete', 'nas.write', async (exchange) => {
    const { paths } = body<{ paths: string[] }>(exchange)
    const info = caller(exchange)
    const result = await ctx.nasRegistry.delete(exchange.params['id']!, Array.isArray(paths) ? paths : [paths], { id: info.userId ?? info.principalId, name: info.name })
    // 所有权随删除移除（含子树）。
    try {
      if (info.userId) ctx.nasAuthz.removeOwnershipFor(exchange.params['id']!, Array.isArray(paths) ? paths : [paths])
    } catch (error) {
      ctx.logger('console').warn('文件所有权移除失败（不影响删除）', error)
    }
    return result
  })

  guarded('POST', '/api/nas/:id/fs/upload', 'nas.write', async (exchange) => {
    // 安全审查 P0-04：HTTP 面不再接受 localFile（服务器本地路径）——该形态让 NAS 写权限
    // 持有者驱动平台进程读取任意本地文件并外传。REST 面只收内容（contentBase64）；
    // 服务层 localFile 保留给平台内部链路（受 assertLocalFileInScope 边界约束）。
    const input = body<{ localFile?: string; contentBase64?: string; destPath: string }>(exchange)
    if (input.localFile) throw new Error(t('HTTP 上传不接受 localFile（服务器本地路径），请改用 contentBase64 传内容'))
    if (!input.contentBase64) throw new Error(t('缺少 contentBase64'))
    const info = caller(exchange)
    const buffer = Buffer.from(input.contentBase64, 'base64')
    const result = await ctx.nasRegistry.uploadFile(exchange.params['id']!, {
      buffer,
      destPath: input.destPath,
      actor: { id: info.userId ?? info.principalId, name: info.name },
    })
    // 文件所有权（2026-09-17 新增）：上传成功即登记上传者（上传者对自有文档默认全权）。
    try {
      if (info.userId) ctx.nasAuthz.recordOwnership({ nasId: exchange.params['id']!, path: input.destPath, userId: info.userId, source: 'upload' })
    } catch (error) {
      ctx.logger('console').warn('文件所有权登记失败（不影响上传）', error)
    }
    return result
  })

  guarded('POST', '/api/nas/:id/fs/download', 'nas.read', async (exchange) => {
    const { path } = body<{ path: string }>(exchange)
    const info = caller(exchange)
    return await ctx.nasRegistry.downloadFile(exchange.params['id']!, path, { id: info.userId ?? info.principalId, name: info.name })
  })

  /**
   * 下载票据：mode=once（默认，15 秒一次性）——浏览器 <a> 原生下载无需带 Bearer 头，大文件免内存 blob；
   * mode=link（10 分钟内可重复使用）——遗留通道（2026-09-21 起前端「复制下载链接」切换到
   * POST /fs/share-link 签名链接，档位可选；本端点行为不变，过渡期并存，自测断言不回归）。
   */
  const LINK_TICKET_TTL_SEC = 600
  const downloadTickets = new Map<string, { nasId: string; path: string; userId?: string; principalId: string; userName: string; expiresAt: number; once: boolean }>()
  guarded('POST', '/api/nas/:id/fs/download-ticket', 'nas.read', (exchange) => {
    const { path, mode } = body<{ path: string; mode?: 'once' | 'link' }>(exchange)
    if (!path) throw new Error(t('缺少 path'))
    const info = caller(exchange)
    const once = mode !== 'link'
    const ttlSec = once ? 15 : LINK_TICKET_TTL_SEC
    const ticket = `nastk_${newId('t')}`
    downloadTickets.set(ticket, {
      nasId: exchange.params['id']!,
      path: String(path),
      ...(info.kind === 'human' && info.userId ? { userId: info.userId } : {}),
      principalId: info.principalId,
      userName: info.name,
      expiresAt: Date.now() + ttlSec * 1000,
      once,
    })
    // 清理过期票据
    for (const [key, value] of downloadTickets) if (value.expiresAt < Date.now()) downloadTickets.delete(key)
    changeLog(exchange, 'nas.fs.download_ticket', 'nas', exchange.params['id']!, '', t('{path}（{mode}）', { path, mode: once ? t('一次性票据') : t('分享链接票据，{minutes} 分钟有效', { minutes: LINK_TICKET_TTL_SEC / 60 }) }))
    return { ticket, expiresInSec: ttlSec }
  })

  // -- NAS 签名分享链接（docs-20260921 设计清单：HMAC 长效/永久 + 权限复核 + 可吊销）----------
  // 档位 1h / 24h（默认）/ 7d / 30d / 永久；签名用独立长期密钥（不随令牌密钥轮换），
  // 重启不失效；取流三关 = 签名 → 吊销 → 权限复核（见 GET /fs/file 的 ?sig= 分支）。
  http.register('POST', '/api/nas/:id/fs/share-link', async (exchange) => {
    if (!requirePermission(exchange, 'nas.write')) return
    const input = body<{ path?: string; ttlSec?: number; permanent?: boolean; note?: string }>(exchange)
    if (!input.path) {
      exchange.fail(400, 'BAD_REQUEST', t('缺少 path'))
      return
    }
    const info = caller(exchange)
    try {
      const issued = ctx.nasShareLinks.issue({
        nasId: exchange.params['id']!,
        path: String(input.path),
        issuer: { principalId: info.principalId, ...(info.userId ? { userId: info.userId } : {}), userName: info.name },
        ...(input.ttlSec !== undefined ? { ttlSec: Number(input.ttlSec) } : {}),
        ...(input.permanent !== undefined ? { permanent: input.permanent === true } : {}),
        ...(input.note ? { note: String(input.note) } : {}),
        hasPermanentPermission: info.permissions.includes('*') || info.permissions.includes('nas.authz.write'),
      })
      const permanent = issued.record.expiresAt === null
      const query = `path=${encodeURIComponent(issued.record.path)}&exp=${issued.exp}&sub=${encodeURIComponent(issued.sub)}&jti=${encodeURIComponent(issued.record.id)}&sig=${encodeURIComponent(issued.sig)}`
      const url = `${requestOrigin(exchange) ?? ''}/api/nas/${exchange.params['id']}/fs/file?${query}`
      // 永久链接必须在审计 detail 写「永久」（决策 ②：显式可审，不留歧义）
      changeLog(exchange, 'nas.fs.share_link', 'nas', exchange.params['id']!, '', `${issued.record.path}（${issued.ttlLabel}）`)
      exchange.ok({
        url,
        jti: issued.record.id,
        expiresAt: issued.record.expiresAt,
        expiresInSec: issued.ttlSec,
        tier: issued.tier,
        ttlLabel: issued.ttlLabel,
        permanent,
      })
    } catch (error) {
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.write' })

  guarded('GET', '/api/nas/:id/fs/share-links', 'nas.authz.read', (exchange) => {
    const userId = exchange.query.get('userId') ?? undefined
    const path = exchange.query.get('path') ?? undefined
    const includeRevoked = exchange.query.get('includeRevoked') === '1'
    return { items: ctx.nasShareLinks.list({ nasId: exchange.params['id']!, ...(userId ? { userId } : {}), ...(path ? { path } : {}), includeRevoked }) }
  })

  http.register('POST', '/api/nas/:id/fs/share-links/:jti/revoke', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const reason = String(body<{ reason?: string }>(exchange).reason ?? '')
    try {
      const result = ctx.nasShareLinks.revoke(exchange.params['jti']!, caller(exchange).name, reason)
      changeLog(exchange, 'nas.fs.share_link_revoke', 'nas', exchange.params['id']!, '',
        t('{path}（{detail}）', { path: result.record.path, detail: result.alreadyRevoked ? t('已是吊销态，幂等返回') : t('吊销人 {name}{reason}', { name: caller(exchange).name, reason: reason ? t('，事由：{reason}', { reason }) : '' }) }))
      exchange.ok({ ...result.record, alreadyRevoked: result.alreadyRevoked })
    } catch (error) {
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  http.register('POST', '/api/nas/:id/fs/share-links/revoke', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const input = body<{ userId?: string; path?: string; all?: boolean; reason?: string }>(exchange)
    try {
      const result = ctx.nasShareLinks.revokeBatch({
        nasId: exchange.params['id']!,
        ...(input.userId ? { userId: String(input.userId) } : {}),
        ...(input.path ? { path: String(input.path) } : {}),
        ...(input.all !== undefined ? { all: input.all === true } : {}),
      }, caller(exchange).name, String(input.reason ?? ''))
      const scope = input.all === true ? t('全部链接') : input.userId ? t('签发者 {userId}', { userId: input.userId }) : t('路径 {path}', { path: input.path })
      changeLog(exchange, 'nas.fs.share_link_revoke', 'nas', exchange.params['id']!, '', t('批量吊销 {scope}：{n} 条', { scope, n: result.count }))
      exchange.ok({ revoked: result.count })
    } catch (error) {
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  guarded('GET', '/api/nas/authz/share-link-policy', 'nas.authz.read', () => {
    const rules = ctx.nasAuthz.getRules()
    return {
      ...ctx.nasShareLinks.policy(),
      version: rules.version,
      presets: SHARE_LINK_TTL_PRESETS,
      secret: ctx.nasShareLinks.secretStatus(),
    }
  })

  http.register('PUT', '/api/nas/authz/share-link-policy', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const input = body<{ maxTtlSec?: number; allowPermanent?: boolean; permanentPermission?: string; ifVersion?: number }>(exchange)
    try {
      const saved = ctx.nasShareLinks.updatePolicy({
        ...(input.maxTtlSec !== undefined ? { maxTtlSec: Number(input.maxTtlSec) } : {}),
        ...(input.allowPermanent !== undefined ? { allowPermanent: input.allowPermanent === true } : {}),
        ...(input.permanentPermission !== undefined ? { permanentPermission: String(input.permanentPermission) } : {}),
      }, input.ifVersion !== undefined ? Number(input.ifVersion) : undefined, caller(exchange).name)
      // 放权动作显式留痕（决策 ③：allowPermanent 的翻转属授权升级，必须可审）
      changeLog(exchange, 'nas.authz.share_link_policy', 'nas_authz_rules', 'singleton', t('NAS 分享链接档位策略'),
        `maxTtlSec=${saved.maxTtlSec} allowPermanent=${saved.allowPermanent} permanentPermission=${saved.permanentPermission}`)
      exchange.ok(saved)
    } catch (error) {
      if (error instanceof RulesVersionConflictError) {
        exchange.fail(409, 'VERSION_CONFLICT', error.message, { currentVersion: error.currentVersion })
        return
      }
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  http.register('POST', '/api/nas/authz/share-link-secret/rotate', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const note = String(body<{ note?: string }>(exchange).note ?? '')
    try {
      const result = ctx.nasShareLinks.rotateSecret(note || undefined)
      changeLog(exchange, 'nas.authz.share_link_secret_rotate', 'nas_authz_rules', 'singleton', t('NAS 分享链接签名密钥'),
        t('新密钥 {keyId}；退役 {retired}（永久保留验签，已发链接不失效）', { keyId: result.keyId, retired: result.retiredKeyId ?? '-' }))
      exchange.ok(result)
    } catch (error) {
      if (error instanceof ShareLinkError) {
        exchange.fail(error.httpStatus, error.code, error.message)
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  /**
   * 流式文件下载（浏览器端真正拿到文件）：先调 downloadFile 让网关落盘到 staging，
   * 再以 attachment 头 + content-disposition 触发浏览器保存。
   * 鉴权三通道：Bearer 令牌 / 一次性票据 ?ticket= / 签名分享链接 ?sig=（exp/sub/jti/sig）。
   * query: path=/share/file, inline=1 表示预览（inline）而非下载（attachment）。
   */
  http.register('GET', '/api/nas/:id/fs/file', async (exchange) => {
    let info: CallerInfo | undefined
    const header = String(exchange.headers['authorization'] ?? '')
    if (header.startsWith('Bearer ')) {
      try {
        const verified = ctx.authn.verify(header.slice(7))
        info = {
          kind: verified.principal.type,
          principalId: verified.principal.id,
          ...(verified.principal.type === 'human' && verified.principal.refId ? { userId: verified.principal.refId } : {}),
          name: verified.principal.name,
          permissions: verified.scopes,
          actChain: verified.actChain,
        }
      } catch { /* 无效令牌走 401 */ }
      if (!info || (!info.permissions.includes('*') && !info.permissions.includes('nas.read'))) {
        ctx.platformBus.emit('audit.authz.denied', {
          actorId: info?.userId ?? info?.principalId ?? '-',
          actorName: info?.name ?? '-',
          point: 'nas.read',
          path: exchange.path,
        })
        exchange.fail(403, 'FORBIDDEN', t('缺少权限点 nas.read'))
        return
      }
    } else if (exchange.query.get('sig')) {
      // 签名分享链接（docs-20260921 设计清单 §2.2）：三关 fail-closed——
      // ① 签名关（独立长期密钥 + exp 过期判定，exp=0 为永久）；
      // ② 吊销关（jti 指向 nas:shareLinks 签发记录，已吊销/记录缺失即拒）；
      // ③ 权限复核关（以签发者身份实时 nasAuthz.check op='download'，票据只是「身份+文件」封装）。
      // 复核失败不消耗链接（可重复尝试），每次判定由 nasAuthz 自带留痕（deny 全量落痕）。
      const verdict = ctx.nasShareLinks.verifyStreamAccess({
        nasId: exchange.params['id']!,
        path: exchange.query.get('path') ?? '',
        exp: exchange.query.get('exp') ?? '',
        sub: exchange.query.get('sub') ?? '',
        jti: exchange.query.get('jti') ?? '',
        sig: String(exchange.query.get('sig')),
      })
      if (verdict.outcome === 'invalid') {
        exchange.fail(401, 'SHARE_LINK_INVALID', t('下载链接无效：{reason}（请重新获取分享链接）', { reason: verdict.reason }))
        return
      }
      if (verdict.outcome === 'forbidden') {
        exchange.fail(403, 'FORBIDDEN', t('下载链接权限复核未通过：{reasons}', { reasons: verdict.reasons.join('；') }))
        return
      }
      ctx.nasShareLinks.recordUse(verdict.record.id)
      info = {
        kind: 'human',
        principalId: verdict.record.principalId,
        userId: verdict.record.userId,
        name: verdict.record.userName,
        permissions: ['nas.read'],
        actChain: [],
      }
    } else {
      const ticketStr = exchange.query.get('ticket') ?? ''
      const ticket = downloadTickets.get(ticketStr)
      if (!ticket || ticket.expiresAt < Date.now()) {
        downloadTickets.delete(ticketStr)
        exchange.fail(401, 'TICKET_INVALID', t('下载票据缺失/过期（请重新发起下载）'))
        return
      }
      if (ticket.once) downloadTickets.delete(ticketStr) // 一次性票据即领即废；分享链接票据在 TTL 内可反复使用
      if (ticket.nasId !== exchange.params['id']!) {
        exchange.fail(403, 'FORBIDDEN', t('下载票据与资产不匹配'))
        return
      }
      if ((exchange.query.get('path') ?? '') !== ticket.path) {
        exchange.fail(403, 'FORBIDDEN', t('下载票据与路径不匹配'))
        return
      }
      info = {
        kind: 'human',
        principalId: ticket.principalId,
        ...(ticket.userId ? { userId: ticket.userId } : {}),
        name: ticket.userName,
        permissions: ['nas.read'],
        actChain: [],
      }
    }
    const id = exchange.params['id']!
    const filePath = exchange.query.get('path')
    const inline = exchange.query.get('inline') === '1'
    if (!filePath) {
      exchange.fail(400, 'BAD_REQUEST', t('缺少 path 查询参数'))
      return
    }
    let resolved: { localFile: string; bytes: number }
    try {
      // 先经网关 fs_download 落盘到平台 staging，再解析本地文件（网关回执 saved_to 已在
      // 服务层做 realpath staging 边界校验，越界/符号链接逃逸的路径一律不采信，P0-04）
      const downloaded = await ctx.nasRegistry.downloadFile(id, filePath, { id: info.userId ?? info.principalId, name: info.name })
      const fresh = await import('node:fs/promises').then((m) => m.stat(downloaded.localFile).catch(() => null))
      if (!fresh?.isFile()) throw new Error(t('下载后仍无法读取落盘文件：{file}', { file: downloaded.localFile }))
      resolved = { localFile: downloaded.localFile, bytes: fresh.size }
    } catch (error) {
      exchange.fail(502, 'DOWNLOAD_FAILED', error instanceof Error ? error.message : String(error))
      return
    }
    const filename = filePath.split('/').filter(Boolean).pop() || 'file'
    const ext = extname(filename).toLowerCase()
    // P1-01（安全审查 2026-10-31）：HTML/SVG/XML/脚本等主动内容一律强制附件下载——
    // 以平台同源 inline 打开时，其中的脚本将以平台身份执行（存储型 XSS）。预览（inline）
    // 仅保留静态安全类型（图片/文本/PDF/Office/压缩包/音视频）。
    const ACTIVE_CONTENT_EXTS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml', '.xht', '.shtml', '.js', '.mjs', '.css'])
    const effectiveInline = inline && !ACTIVE_CONTENT_EXTS.has(ext)
    const type = ACTIVE_CONTENT_EXTS.has(ext) ? 'application/octet-stream' : (NAS_DOWNLOAD_MIME[ext] ?? 'application/octet-stream')
    const disposition = `${effectiveInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`
    exchange.res.writeHead(200, {
      'content-type': type,
      'content-length': String(resolved.bytes),
      'content-disposition': disposition,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    createReadStream(resolved.localFile).pipe(exchange.res)
  }, { access: 'public', selfValidated: true })

  /** 批量上传（保留目录结构）：files = [{ relativePath, contentBase64 }]，destDir=目标目录。 */
  guarded('POST', '/api/nas/:id/fs/upload-many', 'nas.write', async (exchange) => {
    const input = body<{ files: Array<{ relativePath: string; contentBase64: string }>; destDir: string }>(exchange)
    if (!Array.isArray(input.files) || input.files.length === 0) throw new Error(t('files 不能为空'))
    if (!input.destDir) throw new Error(t('缺少 destDir'))
    const info = caller(exchange)
    const result = await ctx.nasRegistry.uploadMany(exchange.params['id']!, input.files.map((f) => ({
      relativePath: String(f.relativePath ?? '').replace(/^\/+/, ''),
      contentBase64: String(f.contentBase64 ?? ''),
    })), String(input.destDir).replace(/^\/+|\/+$/g, ''), { id: info.userId ?? info.principalId, name: info.name })
    changeLog(exchange, 'nas.fs.upload_many', 'nas', exchange.params['id']!, '', t('成功 {ok} / 失败 {failed} → {destDir}', { ok: result.uploaded.length, failed: result.failed.length, destDir: input.destDir }))
    return result
  })

  // -- NAS 数据权限（plugin-nas/nasAuthz，dev-plan-nas-authz §2.3）------------------------
  // 身份永不进模型工具参数（P0-2 教训）。
  //
  // OBO 授权事实降级（MCP 治理契约 §4，2026-10-22）：授权身份优先取令牌统一 principal 的
  // 委托链（unified.humanDelegatorOf，source='token'）；无委托链才回落 X-On-Behalf-User 头
  // （source='header-legacy'，迁移期兼容，网关/hermes 存量调用方零感知）。
  // X-On-Behalf-User 头自此只是「降级来源的身份声明」，不再是权威授权事实——伪造头不能越过
  // 令牌委托链（有链时头被忽略）；env NAS_OBO_HEADER_STRICT=1 可整体关闭 header 通道（纯 header
  // 请求 403，默认关闭）。delegationSource 随响应/审计 detail 附注，供迁移观测。
  type OnBehalfIdentity = { userId: string; source: 'token' | 'header-legacy' } | { blocked: true }
  const onBehalfIdentity = (exchange: HttpExchange): OnBehalfIdentity | undefined => {
    const info = caller(exchange) as CallerInfo & { unified?: UnifiedPrincipal }
    const delegator = info.unified ? humanDelegatorOf(info.unified) : null
    if (delegator?.userId) return { userId: delegator.userId, source: 'token' }
    const header = exchange.headers['x-on-behalf-user']
    const value = Array.isArray(header) ? header[0] : header
    const raw = value && String(value).trim() !== '' ? String(value).trim() : undefined
    if (!raw) return undefined
    if (process.env['NAS_OBO_HEADER_STRICT'] === '1') return { blocked: true }
    return { userId: raw, source: 'header-legacy' }
  }

  guarded('POST', '/api/nas/authz/check', 'nas.authz.check', async (exchange) => {
    const input = body<{ nasId: string; userId?: string; paths: string[] | string; op: string; override?: boolean }>(exchange)
    if (!input.nasId) throw new Error(t('缺少 nasId'))
    const obo = onBehalfIdentity(exchange)
    if (obo && 'blocked' in obo) {
      exchange.fail(403, 'FORBIDDEN', t('X-On-Behalf-User 头通道已关闭（NAS_OBO_HEADER_STRICT=1）：请改用委托令牌'))
      return
    }
    const userId = obo?.userId ?? input.userId
    if (!userId) throw new Error(t('缺少 userId（或 X-On-Behalf-User 头）'))
    const info = caller(exchange)
    if (input.override === true) {
      // 破窗：仅持 nas.authz.write 的运维可强制 P 判定（强制留痕在 nasAuthz 内完成）
      if (!requirePermission(exchange, 'nas.authz.write')) return
    }
    return {
      ...await ctx.nasAuthz.check({
        nasId: String(input.nasId), userId: String(userId),
        paths: Array.isArray(input.paths) ? input.paths : [String(input.paths ?? '')],
        op: String(input.op) as never,
        ...(input.override !== undefined ? { override: input.override === true } : {}),
        caller: info.name,
      }),
      // 契约 §4 迁移观测：身份事实来源随判定结果附注（token=令牌委托链；header-legacy=降级头）
      ...(obo ? { delegationSource: obo.source, onBehalfUserId: userId } : {}),
    }
  })

  guarded('GET', '/api/nas/authz/scope', 'nas.authz.check', async (exchange) => {
    const nasId = exchange.query.get('nasId')
    const obo = onBehalfIdentity(exchange)
    if (obo && 'blocked' in obo) {
      exchange.fail(403, 'FORBIDDEN', t('X-On-Behalf-User 头通道已关闭（NAS_OBO_HEADER_STRICT=1）：请改用委托令牌'))
      return
    }
    const userId = obo?.userId ?? exchange.query.get('userId') ?? ''
    if (!nasId || !userId) throw new Error(t('缺少 nasId 或 userId 查询参数'))
    return {
      ...await ctx.nasAuthz.scopeOf(nasId, userId),
      // 契约 §4 迁移观测：数据范围身份事实来源（token=令牌委托链；header-legacy=降级头）
      ...(obo ? { delegationSource: obo.source, onBehalfUserId: userId } : {}),
    }
  })

  guarded('GET', '/api/nas/authz/rules', 'nas.authz.read', () => ctx.nasAuthz.getRules())

  http.register('PUT', '/api/nas/authz/rules', async (exchange) => {
    if (!requirePermission(exchange, 'nas.authz.write')) return
    const input = body<{ ifVersion: number; matrixOverrides?: Record<string, Record<string, boolean>>; exceptions?: unknown[]; cGroups?: string[]; externalReadPaths?: Array<{ nasId: string; path: string }>; observeOnly?: boolean; degradeAllToReadonly?: boolean }>(exchange)
    try {
      const saved = ctx.nasAuthz.updateRules({
        ...(input.matrixOverrides !== undefined ? { matrixOverrides: input.matrixOverrides as never } : {}),
        ...(input.exceptions !== undefined ? { exceptions: input.exceptions as never } : {}),
        ...(input.cGroups !== undefined ? { cGroups: input.cGroups } : {}),
        ...(input.externalReadPaths !== undefined ? { externalReadPaths: input.externalReadPaths } : {}),
        ...(input.observeOnly !== undefined ? { observeOnly: input.observeOnly } : {}),
        ...(input.degradeAllToReadonly !== undefined ? { degradeAllToReadonly: input.degradeAllToReadonly } : {}),
      }, Number(input.ifVersion), caller(exchange).name)
      changeLog(exchange, 'nas.authz.rules_update', 'nas_authz_rules', 'singleton', t('NAS 数据权限规则'), `version → ${saved.version}`)
      exchange.ok(saved)
    } catch (error) {
      if (error instanceof RulesVersionConflictError) {
        exchange.fail(409, 'VERSION_CONFLICT', error.message, { currentVersion: error.currentVersion })
        return
      }
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write' })

  guarded('POST', '/api/nas/authz/rules/import', 'nas.authz.write', (exchange) => {
    const seed = body<Record<string, unknown>>(exchange)
    const result = ctx.nasAuthz.importRules(seed as never, caller(exchange).name)
    changeLog(exchange, 'nas.authz.rules_import', 'nas_authz_rules', 'singleton', t('NAS 数据权限规则'),
      `${result.changed ? `version → ${result.version}` : t('内容一致（幂等跳过）')}${result.unresolvedGroups.length > 0 ? t('；未解析组：{groups}', { groups: result.unresolvedGroups.join(',') }) : ''}`)
    return result
  })

  guarded('GET', '/api/nas/authz/exceptions', 'nas.authz.read', () => ({ exceptions: ctx.nasAuthz.listExceptions() }))

  /**
   * 例外端点（双模式，dev-plan-nas-authz §2.3/§2.7）：
   * - status='pending'：share 申请入口（hermes/成员，需 nas.authz.check）→ 自动生成审批单，审批人沿组织链自动路由；
   * - effect='allow'/'deny'：运维直写资源级例外（需 nas.authz.write）。
   */
  http.register('POST', '/api/nas/authz/exceptions', async (exchange) => {
    const input = body<{ status?: string; nasId?: string; userId?: string; path?: string; reason?: string; effect?: 'allow' | 'deny'; ops?: string[]; expiresAt?: string; note?: string }>(exchange)
    if (input.status === 'pending') {
      if (!requirePermission(exchange, 'nas.authz.check')) return
      if (!input.nasId || !input.path) {
        exchange.fail(400, 'BAD_REQUEST', t('share 申请缺少 nasId/path'))
        return
      }
      const obo = onBehalfIdentity(exchange)
      if (obo && 'blocked' in obo) {
        exchange.fail(403, 'FORBIDDEN', t('X-On-Behalf-User 头通道已关闭（NAS_OBO_HEADER_STRICT=1）：请改用委托令牌'))
        return
      }
      const userId = obo?.userId ?? input.userId
      if (!userId) {
        exchange.fail(400, 'BAD_REQUEST', t('缺少 userId（或 X-On-Behalf-User 头）'))
        return
      }
      try {
        const request = await ctx.nasAuthz.requestShareApproval({
          nasId: String(input.nasId), userId: String(userId), path: String(input.path),
          ...(input.reason !== undefined ? { reason: String(input.reason) } : {}),
        })
        changeLog(exchange, 'nas.authz.share_request', 'nas_authz_rules', request.approvalId, t('share 分享申请'),
          t('审批人路由：{approver}', { approver: request.escalated ? t('resource_admin 兜底') : request.approverSuggestion.orgName ?? '' })
            + (obo ? t('；身份来源：{source}', { source: obo.source }) : ''))
        exchange.ok({ kind: 'approval', ...request })
      } catch (error) {
        exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (!requirePermission(exchange, 'nas.authz.write')) return
    if (!input.effect || !input.nasId || !input.path || !Array.isArray(input.ops)) {
      exchange.fail(400, 'BAD_REQUEST', t('例外直写需要 effect/nasId/path/ops'))
      return
    }
    try {
      const exception = ctx.nasAuthz.addException({
        effect: input.effect, nasId: String(input.nasId), path: String(input.path),
        ops: input.ops as never[],
        ...(input.userId ? { userIds: [String(input.userId)] } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        ...(input.note ? { note: input.note } : {}),
      }, caller(exchange).name)
      changeLog(exchange, 'nas.authz.exception_add', 'nas_authz_rules', exception.id, t('NAS 数据权限例外'), `${input.effect} ${input.path} [${input.ops.join(',')}]`)
      exchange.ok(exception)
    } catch (error) {
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.authz.write,nas.authz.check' })

  /**
   * 文件所有权登记（2026-09-17 新增，上传者对自有文档默认全权）：
   * - POST /record：网关写类操作（fs_upload/fs_delete/fs_rename/fs_copy_move）成功后的登记/维护上报，
   *   供 hermes/直连 MCP 客户端的操作同步所有权（控制台链路由 nasRegistry 原生维护，双路上报幂等）；
   * - GET：排查/审计查询。
   */
  http.register('POST', '/api/nas/authz/ownership/record', async (exchange) => {
    if (!requirePermission(exchange, 'nas.ownership.write')) return
    const input = body<{ nasId: string; userId: string; tool: string; args?: { path?: string | string[]; folder_path?: string | string[]; dest_path?: string; local_file?: string; name?: string | string[]; dest_folder_path?: string; remove_src?: boolean } }>(exchange)
    if (!input.nasId || !input.userId || !input.tool) {
      exchange.fail(400, 'BAD_REQUEST', t('缺少 nasId/userId/tool'))
      return
    }
    const listOf = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [String(v)] : []).map(String).filter(Boolean)
    const joinPosix = (dir: string, name: string): string => `/${[...dir.split('/'), ...name.split('/')].filter(Boolean).join('/')}`
    try {
      const args = input.args ?? {}
      let result: unknown = { ignored: true, tool: input.tool }
      if (input.tool === 'fs_upload' && args.dest_path && args.local_file) {
        const filename = String(args.local_file).split('/').filter(Boolean).pop() ?? ''
        result = ctx.nasAuthz.recordOwnership({ nasId: String(input.nasId), path: joinPosix(String(args.dest_path), filename), userId: String(input.userId), source: 'gateway:upload' })
      } else if (input.tool === 'fs_delete') {
        result = { removed: ctx.nasAuthz.removeOwnershipFor(String(input.nasId), listOf(args.path)) }
      } else if (input.tool === 'fs_rename' && listOf(args.path).length > 0) {
        const paths = listOf(args.path)
        const names = listOf(args.name)
        result = { rewritten: paths.map((p, i) => ctx.nasAuthz.rewriteOwnershipFor(String(input.nasId), p, joinPosix(p.split('/').slice(0, -1).join('/'), names[i] ?? ''))).reduce((a, b) => a + b, 0) }
      } else if (input.tool === 'fs_copy_move' && args.dest_folder_path) {
        const moving = args.remove_src === true
        let touched = 0
        for (const p of listOf(args.path)) {
          const dest = joinPosix(String(args.dest_folder_path), p.split('/').filter(Boolean).pop() ?? '')
          if (moving) touched += ctx.nasAuthz.rewriteOwnershipFor(String(input.nasId), p, dest)
          else if (ctx.nasAuthz.recordOwnership({ nasId: String(input.nasId), path: dest, userId: String(input.userId), source: 'gateway:copy' })) touched++
        }
        result = { touched }
      }
      exchange.ok(result)
    } catch (error) {
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'nas.ownership.write' })

  guarded('GET', '/api/nas/authz/ownership', 'nas.authz.read', (exchange) => {
    const nasId = exchange.query.get('nasId') ?? undefined
    const userId = exchange.query.get('userId') ?? undefined
    const path = exchange.query.get('path') ?? undefined
    return { items: ctx.nasAuthz.listOwnership({ ...(nasId ? { nasId } : {}), ...(userId ? { userId } : {}), ...(path ? { path } : {}) }) }
  })

  guarded('GET', '/api/nas/authz/decisions', 'nas.authz.read', (exchange) => {    const limit = Math.min(500, Number(exchange.query.get('limit') ?? 100))
    const decision = exchange.query.get('decision')
    const nasId = exchange.query.get('nasId')
    const userId = exchange.query.get('userId')
    const items = ctx.nasAuthz.decisions().find((record) => {
      if (decision && record.decision !== decision) return false
      if (nasId && record.nasId !== nasId) return false
      if (userId && record.userId !== userId) return false
      return true
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { total: items.length, items: items.slice(0, limit) }
  })

  guarded('POST', '/api/nas/authz/reconcile', 'nas.authz.read', async (exchange) => {
    const report = await ctx.nasAuthz.dailyReconcile()
    changeLog(exchange, 'nas.authz.reconcile', 'nas_authz_rules', '', t('组织目录对账'), t('{n} 台在线 NAS', { n: report.length }))
    return { report }
  })

  guarded('POST', '/api/nas/authz/leader-vacancy-scan', 'nas.authz.read', (exchange) => {
    const vacant = ctx.nasAuthz.scanLeaderVacancy()
    changeLog(exchange, 'nas.authz.leader_vacancy_scan', 'nas_authz_rules', '', t('负责人悬空扫描'), t('悬空 {n} 个组织', { n: vacant.length }))
    return { vacant }
  })

}
