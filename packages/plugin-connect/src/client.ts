/**
 * 接入客户端服务：远程 dsh 运行时（插件市场安装形态）连接宿主平台服务的客户端半部。
 *
 * 职责：
 *   - 持久化宿主连接配置（<dataDir>/connect-client.json，0600，机器凭证仅本机明文）
 *   - 凭证三通道：接入码换机器凭证（enroll）/ 直接配置已有凭证 / 断开重置
 *   - 机器令牌缓存（client-credentials 换 2h machine token，失效自动重换，401 单次重试）
 *   - 工具远程代理：forward() 把平台 37 个运维工具的执行转发到宿主 /api/tools/execute
 */
import { existsSync } from 'node:fs'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { t } from '../../platform-i18n/src/index.ts'

/** 本机持久化的宿主连接配置（机器凭证等价于口令，文件权限收紧到 0600）。 */
export interface ConnectClientConfig {
  hubUrl: string
  clientId: string
  clientSecret: string
  clientName: string
  template: string
  principalId: string
  enrolledAt: string
  /** 最近一次转发失败信息（诊断用）。 */
  lastError?: string
}

interface CachedToken {
  token: string
  expiresAt: number
}

const CONNECT_TOOLS_PREFIX = 'connect_'

export class ConnectClientService extends Service {
  static readonly provide = 'connectClient'

  private configFile: string
  private config: ConnectClientConfig | null = null
  private cached: CachedToken | null = null
  /** 远程代理降级状态（OPT-P1-03）：安装失败时记录原因，connect_status 显式透出。 */
  private degradedReason: string | undefined
  private degradedDetail: string | undefined
  /** 转发失败告警节流（OPT-P1-03）：60s 内至多发一次 connect.degraded，避免重试风暴刷屏审计。 */
  private lastForwardFailureEmitAt = 0

  constructor(ctx: Context, options: { dataDir?: string } = {}) {
    super(ctx, 'connectClient')
    this.configFile = join(options.dataDir ?? ctx.opsStorage.dataDirPath, 'connect-client.json')
    this.config = this.load()
  }

  /** 是否已配置宿主（决定工具代理走远程还是本地）。 */
  hasHub(): boolean {
    return this.config !== null && this.config.hubUrl !== ''
  }

  getConfig(): Readonly<ConnectClientConfig> | null {
    return this.config
  }

  // ---------------------------------------------------------------- 凭证三通道

  /**
   * 接入码换机器凭证（Agent 一键申请口令的主通道）：
   * 向宿主 POST /api/connect/enroll，成功后落盘 clientId/clientSecret。
   */
  async enroll(input: { hubUrl: string; enrollmentCode: string; clientName?: string }): Promise<ConnectClientConfig> {
    const hubUrl = normalizeBaseUrl(input.hubUrl)
    const clientName = input.clientName?.trim() || defaultClientName()
    const payload = await this.hubCall(hubUrl, 'POST', '/api/connect/enroll', {
      enrollmentCode: input.enrollmentCode.trim(),
      clientName,
      meta: { hostname: hostname(), platform: process.platform, node: process.version },
    })
    const credential = payload as { clientId: string; clientSecret: string; principalId: string; template: string }
    if (!credential?.clientId || !credential?.clientSecret) throw new Error(t('宿主返回的接入凭证不完整'))
    this.config = {
      hubUrl,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      clientName,
      template: credential.template ?? 'readonly',
      principalId: credential.principalId ?? '',
      enrolledAt: new Date().toISOString(),
    }
    this.cached = null
    this.save()
    return this.config
  }

  /** 直接配置已有机器凭证（管理员在宿主控制台手工签发后分发）。 */
  async loginWithCredential(input: { hubUrl: string; clientId: string; clientSecret: string; clientName?: string }): Promise<ConnectClientConfig> {
    const hubUrl = normalizeBaseUrl(input.hubUrl)
    if (!input.clientId || !input.clientSecret) throw new Error(t('clientId 与 clientSecret 必填'))
    this.config = {
      hubUrl,
      clientId: input.clientId.trim(),
      clientSecret: input.clientSecret.trim(),
      clientName: input.clientName?.trim() || defaultClientName(),
      template: '',
      principalId: '',
      enrolledAt: new Date().toISOString(),
    }
    this.cached = null
    // 立即验证凭证可用性（失败不落盘，避免写入坏配置）
    const probe = await this.machineToken()
    void probe
    this.save()
    return this.config
  }

  /** 断开：清除本机凭证与令牌缓存（不影响宿主侧，吊销请在宿主控制台操作）。 */
  reset(): void {
    this.config = null
    this.cached = null
    try {
      if (existsSync(this.configFile)) writeFileSync(this.configFile, JSON.stringify({ configured: false }, null, 2), 'utf8')
    } catch { /* 清理失败不阻断断开 */ }
  }

  /** 更新内存态错误信息（供 status 诊断）。 */
  noteError(message: string): void {
    if (this.config) this.config = { ...this.config, lastError: message }
  }

  // ---------------------------------------------------------------- 令牌与转发

  /** 获取机器令牌（缓存 + 提前 60s 过期；失效自动走 client-credentials 重换）。 */
  async machineToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.token
    if (!this.config) throw new Error(t('尚未配置宿主服务，请先完成接入（connect_setup 或本地配置页）'))
    const config = this.config
    try {
      const payload = await this.hubCall(config.hubUrl, 'POST', '/api/auth/client-credentials', {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      }) as { token: string; expiresAt: string }
      if (!payload?.token) throw new Error(t('宿主未返回机器令牌'))
      this.cached = { token: payload.token, expiresAt: new Date(payload.expiresAt).getTime() || Date.now() + 110 * 60_000 }
      return this.cached.token
    } catch (error) {
      if (error instanceof HubUnauthorizedError) {
        // 机器凭证被吊销/禁用：重换无意义，直接给出可行动的诊断
        throw new Error(t('机器凭证无效或已在宿主侧吊销，请重新接入（connect_setup）或联系宿主管理员'))
      }
      throw error
    }
  }

  /**
   * 工具远程代理：把一次工具调用转发到宿主工具桥。
   * 宿主返回 { isError, value, error } —— 错误就地抛出，由本机 ToolRuntime 统一包装。
   * 401（机器令牌过期/宿主密钥轮换）时重换令牌重试一次；凭证级失败不重试。
   */
  async forward(toolName: string, args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<unknown> {
    if (!this.config) throw new Error(t('尚未配置宿主服务，本工具需要远程执行，请先完成接入'))
    const hubUrl = this.config.hubUrl
    const executeOnce = async (): Promise<{ isError?: boolean; value?: unknown; error?: { message?: string } }> => {
      const token = await this.machineToken()
      return await this.hubCall(hubUrl, 'POST', '/api/tools/execute', {
        name: toolName,
        args,
        // 节点身份 ≠ 员工执行身份（D13/§10.4）：转发请求 additive 携带自身已验证主体绑定信封，
        // 仅供宿主工具桥侧（/api/tools/execute）日志/归因观测。硬性边界：
        //   1. 信封只随转发透传自身凭证绑定，不含任何可提升权限的声明；
        //   2. 宿主鉴权仍以 Bearer 机器令牌独立验证，本字段绝不参与授权判定；
        //   3. 不携带也不接受任何「平台内部请求」免验标记（§10.5：内部动作必须由受信任内部路径发起）。
        meta: {
          principal: {
            kind: 'machine' as const,
            principalId: this.config.principalId,
            clientId: this.config.clientId,
            clientName: this.config.clientName,
          },
        },
      }, {
        authorization: `Bearer ${token}`,
        signal: exec?.signal ?? AbortSignal.timeout(60_000),
      }) as { isError?: boolean; value?: unknown; error?: { message?: string } }
    }
    try {
      let result
      try {
        result = await executeOnce()
      } catch (error) {
        if (error instanceof HubUnauthorizedError) {
          this.cached = null
          result = await executeOnce()
        } else {
          throw error
        }
      }
      if (this.config?.lastError) {
        const { lastError: _cleared, ...rest } = this.config
        void _cleared
        this.config = rest as ConnectClientConfig
      }
      if (result && result.isError) throw new Error(result.error?.message ?? t('宿主工具执行失败'))
      return result?.value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.noteError(`${toolName}: ${message}`)
      throw error
    }
  }

  // ------------------------------------------------- 降级可观测（OPT-P1-03）

  /** 安装级降级（扩展点缺失等）：状态持久记录，connect_status 显式透出。 */
  noteDegraded(reason: string, detail?: string): void {
    this.degradedReason = reason
    this.degradedDetail = detail
  }

  /**
   * 转发失败告警（OPT-P1-03 fail-closed）：调用侧已显式抛错不落本地，
   * 此处补发 connect.degraded 事件（60s 节流）供总线/审计侧观测「以为在管远端其实在管本机」类语义漂移。
   */
  noteForwardFailure(toolName: string, error: unknown): void {
    const now = Date.now()
    if (now - this.lastForwardFailureEmitAt < 60_000) return
    this.lastForwardFailureEmitAt = now
    const message = error instanceof Error ? error.message : String(error)
    try {
      this.ctx.platformBus?.emit('connect.degraded', { reason: 'forward_failed', tool: toolName, detail: message, at: new Date().toISOString() })
    } catch { /* 总线未就绪：lastError 已由 noteError 记录 */ }
  }

  // ---------------------------------------------------------------- 状态探测

  /**
   * 心跳上报（接入方 → 宿主主动推送）：POST /api/connect/heartbeat，
   * 携带运行元信息（工具数 / 运行版本 / uptime），宿主侧「平台接入」可见最近心跳。
   * 未配置宿主时静默跳过；失败由调用方记录（noteError），不抛出阻断定时器。
   */
  async heartbeat(meta: { tools?: number; version?: string; uptimeSec?: number } = {}): Promise<void> {
    if (!this.config) return
    const token = await this.machineToken()
    await this.hubCall(this.config.hubUrl, 'POST', '/api/connect/heartbeat', meta, {
      authorization: `Bearer ${token}`,
    })
  }

  /** 连通性探测（不要求已配置凭证）：宿主健康 + 平台信息。 */
  async probeHub(hubUrl?: string): Promise<{ reachable: boolean; health?: unknown; platform?: { name: string; version: string; tools: number }; error?: string }> {
    const base = normalizeBaseUrl(hubUrl ?? this.config?.hubUrl ?? '')
    if (!base) return { reachable: false, error: t('未指定宿主地址') }
    try {
      const health = await this.hubCall(base, 'GET', '/api/health') as { status?: string }
      const token = await this.machineToken().catch(() => null)
      let platform: { name: string; version: string; tools: number } | undefined
      if (token) {
        const info = await this.hubCall(base, 'GET', '/api/platform/info', undefined, { authorization: `Bearer ${token}` }) as { name?: string; version?: string; tools?: unknown[] }
        platform = { name: info?.name ?? '', version: info?.version ?? '', tools: Array.isArray(info?.tools) ? info.tools.length : 0 }
      }
      return { reachable: health?.status === 'ok', health, platform }
    } catch (error) {
      return { reachable: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 面向 Agent/配置页的状态快照。 */
  async status(): Promise<Record<string, unknown>> {
    const config = this.config
    const base = {
      configured: config !== null,
      toolProxy: config ? t('remote（转发宿主执行）') : t('local（本地数据）'),
      ...(this.degradedReason ? { proxyDegraded: this.degradedReason, ...(this.degradedDetail ? { degradedDetail: this.degradedDetail } : {}) } : {}),
    }
    if (!config) return { ...base, hint: t('尚未接入宿主服务：调用 connect_setup（接入码）或 connect_login（已有凭证）完成配置') }
    const probe = await this.probeHub().catch((error: unknown) => ({ reachable: false, error: error instanceof Error ? error.message : String(error) }))
    let tokenState = t('未知')
    try {
      await this.machineToken()
      tokenState = t('有效')
    } catch (error) {
      tokenState = t('异常：{reason}', { reason: error instanceof Error ? error.message : String(error) })
    }
    return {
      ...base,
      hubUrl: config.hubUrl,
      clientName: config.clientName,
      template: config.template || t('（手工配置凭证，未走接入码）'),
      principalId: config.principalId,
      enrolledAt: config.enrolledAt,
      hubReachable: (probe as { reachable?: boolean }).reachable === true,
      tokenState,
      lastError: config.lastError ?? '',
    }
  }

  // ---------------------------------------------------------------- 内部工具

  private load(): ConnectClientConfig | null {
    try {
      if (!existsSync(this.configFile)) return null
      const parsed = JSON.parse(readFileSync(this.configFile, 'utf8')) as Partial<ConnectClientConfig>
      if (!parsed?.hubUrl || !parsed?.clientId || !parsed?.clientSecret) return null
      return {
        hubUrl: parsed.hubUrl,
        clientId: parsed.clientId,
        clientSecret: parsed.clientSecret,
        clientName: parsed.clientName ?? defaultClientName(),
        template: parsed.template ?? '',
        principalId: parsed.principalId ?? '',
        enrolledAt: parsed.enrolledAt ?? new Date().toISOString(),
        ...(parsed.lastError !== undefined ? { lastError: parsed.lastError } : {}),
      }
    } catch {
      return null
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.configFile), { recursive: true })
      writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(this.configFile, 0o600) } catch { /* Windows 无 chmod */ }
    } catch (error) {
      console.error('[connect] 客户端配置落盘失败', error)
    }
  }

  private async hubCall(base: string, method: string, path: string, body?: unknown, extra?: { authorization?: string; signal?: AbortSignal }): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(extra?.authorization !== undefined ? { authorization: extra.authorization } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: extra?.signal ?? AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new Error(t('宿主服务不可达（{url}）：{reason}', { url: base, reason: error instanceof Error ? error.message : String(error) }))
    })
    const payload = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } } | null
    if (response.status === 401) throw new HubUnauthorizedError(payload?.error?.message ?? t('令牌无效或已过期'))
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error?.message ?? t('宿主请求失败：HTTP {status}', { status: response.status }))
    }
    return payload?.data
  }
}

class HubUnauthorizedError extends Error {}

/** 判定一个工具是否应被远程代理（connect_* 自身工具始终本地执行）。 */
export function isProxiedTool(name: string): boolean {
  return !name.startsWith(CONNECT_TOOLS_PREFIX)
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = (input ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (!/^https?:\/\//.test(trimmed)) return `http://${trimmed}`
  return trimmed
}

export function defaultClientName(): string {
  return `dsh-${hostname()}`.slice(0, 60)
}
