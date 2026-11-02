/**
 * Secret Broker（W1-T2，MCP 治理契约 §6）：下游凭证引用的本地保管者。
 *
 * 目标：下游认证凭证的明文只落本 Broker 的专用密钥文件（<dataDir>/secrets/mcp/<serviceId>.json，
 * 文件 0600 / 目录 0700），业务集合（mcp:services 等）与任何 API 响应绝不出现 secret 原文。
 *
 * credentialRef 形态（引用而非明文）：
 *   - local:<serviceId>  —— 取本 Broker 内部存储（secrets 条目按 headerName 注入）；
 *   - env:VAR            —— 取进程环境变量 VAR（缺失时 resolve 返回 null 并留一次访问审计）；
 *   - vault:/external:/其他 —— 本期一律抛 CREDENTIAL_BROKER_UNSUPPORTED（留接口，fail-closed）。
 *
 * 每次成功 resolve emit PlatformEvents.McpSecretAccess（'mcp.secret.access'），
 * payload 只含 serviceId/credentialRef/at 等元数据，绝不带值（plugin-audit 订阅落审计）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents } from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'

/** 敏感头判定口径（契约 §6）：与 console maskServiceHeaders 完全一致。 */
export const SENSITIVE_HEADER_RE = /authorization|token|secret|key/i

/**
 * env: 凭证引用白名单（安全审查 P1-04，2026-10-31）：MCP_ENV_SECRET_ALLOWLIST（逗号分隔
 * 变量名）。持有 mcp.service.write 的用户可同时指定服务地址与 env: 引用——若进程环境变量
 * 任取，密钥代理会把任意进程密钥注入对该服务的外呼头（外呼地址可指向攻击者服务器），
 * 构成「借服务外呼窃取进程密钥」链路。现收敛为：env: 引用仅允许显式登记的变量名，
 * 白名单缺省为空（fail-closed，全部拒绝）；部署方按需在环境里登记，如
 * MCP_ENV_SECRET_ALLOWLIST=TICKET_MCP_TOKEN,GITHUB_TOKEN。
 */
export function envSecretAllowlist(): Set<string> {
  return new Set(String(process.env.MCP_ENV_SECRET_ALLOWLIST ?? '')
    .split(',').map((item) => item.trim()).filter(Boolean))
}

export function envSecretAllowed(varName: string): boolean {
  return envSecretAllowlist().has(varName)
}

/** 服务记录 headers 中的敏感键清单（migrate 扫描与治理待办 plainHeaderServices 共用）。 */
export function sensitiveHeaderKeys(headers?: Record<string, string>): string[] {
  if (!headers) return []
  return Object.keys(headers).filter((key) => SENSITIVE_HEADER_RE.test(key))
}

/**
 * 明文敏感头写入门禁（契约 §6）：返回命中的敏感键；env MCP_ALLOW_PLAIN_HEADERS=1
 * 为迁移期全局逃生门（默认关）——打开后返回空数组放行，仅限存量明文尚未迁完的过渡期使用。
 * REST create/update 服务写路径据此返回 400 SENSITIVE_HEADERS_FORBIDDEN，引导走 credential API。
 */
export function plainSensitiveHeaderViolation(headers?: Record<string, string>): string[] {
  if (process.env.MCP_ALLOW_PLAIN_HEADERS === '1') return []
  return sensitiveHeaderKeys(headers)
}

/** 单条凭证条目（headerName → secret；仅存在于 Broker 密钥文件与 resolve 结果，绝不入业务集合）。 */
export interface McpCredentialEntry {
  headerName: string
  secret: string
}

/** 密钥文件内容（简化契约 §6：按服务存多条目；credentialRef 多条目时统一挂在文件级/第一条）。 */
export interface McpCredentialFile {
  credentialRef: string
  secrets: McpCredentialEntry[]
  updatedAt: string
}

/** 对外描述形态（describe/REST 回显共用）：只有元数据，永不返回 secret 原文。 */
export interface McpCredentialDescription {
  credentialRef?: string
  headerNames: string[]
  updatedAt?: string
}

function unsupportedError(credentialRef: string): Error {
  const prefix = credentialRef.includes(':') ? credentialRef.slice(0, credentialRef.indexOf(':') + 1) : credentialRef
  return Object.assign(
    new Error(t('凭证形态 {prefix}… 本期不支持（CREDENTIAL_BROKER_UNSUPPORTED）：仅支持 local:/env: 前缀，vault:/external: 留待后续接入', { prefix })),
    { code: 'CREDENTIAL_BROKER_UNSUPPORTED' },
  )
}

function nowIso(): string {
  return new Date().toISOString()
}

export class SecretBroker extends Service {
  static readonly provide = 'secretBroker'

  /** 探活访问留痕去重窗口时长（W3-T5 §14）：同 key（serviceId+credentialRef+dedupKey）窗口内只发一次事件。 */
  protected probeDedupWindowMs = 10 * 60_000
  /** 去重窗口簿：key → { windowStart, count（窗口内 resolve 次数）, suppressed（本窗口已被聚合的重复次数） }。 */
  private accessWindows = new Map<string, { windowStart: number; count: number; suppressed: number }>()

  constructor(ctx: Context) {
    super(ctx, 'secretBroker')
  }

  // -- 存储原语 -------------------------------------------------------------

  /** 数据目录：与 opsStorage 同源（平台级密钥等文件同存放处）；单测宿主缺席时显式报错。 */
  private dataDir(): string {
    try {
      const dir = (this.ctx as { opsStorage?: { dataDirPath?: string } }).opsStorage?.dataDirPath
      if (dir) return dir
    } catch { /* cordis 严格代理：服务未装配即抛 → 落下方统一报错 */ }
    throw new Error(t('SecretBroker 缺少数据目录（opsStorage 未装配）'))
  }

  /** 密钥文件路径（serviceId 做文件名安全化；目录结构 <dataDir>/secrets/mcp/）。 */
  private fileOf(serviceId: string): string {
    const safe = String(serviceId).replace(/[^a-zA-Z0-9._-]/g, '_')
    return join(this.dataDir(), 'secrets', 'mcp', `${safe}.json`)
  }

  private read(serviceId: string): McpCredentialFile | null {
    const file = this.fileOf(serviceId)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as McpCredentialFile
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.secrets)) return null
      return parsed
    } catch {
      // 密钥文件损坏按「无凭证」处理（resolve 自然 miss，不炸调用链）；不静默改写，待人工处置
      return null
    }
  }

  private write(serviceId: string, content: McpCredentialFile): void {
    const file = this.fileOf(serviceId)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    chmodSync(dirname(file), 0o700) // 目录 0700（mkdir mode 受 umask 影响，显式收敛）
    writeFileSync(file, JSON.stringify(content, null, 2), 'utf8')
    chmodSync(file, 0o600) // 文件 0600：仅属主可读写
  }

  // -- 对外 API -------------------------------------------------------------

  /**
   * 登记凭证（同名 headerName 再 put 即轮换）：
   *   - local:/缺省：必须携带 secret 明文，落密钥文件；credentialRef 缺省 local:<serviceId>；
   *   - env:VAR：不落明文（secret 必须缺省），取值在 resolve 时读进程环境变量；
   *   - vault:/external:/其他：抛 CREDENTIAL_BROKER_UNSUPPORTED（登记期即 fail-closed）。
   */
  put(input: { serviceId: string; credentialRef?: string; headerName?: string; secret?: string }): McpCredentialDescription {
    const serviceId = String(input.serviceId ?? '').trim()
    if (!serviceId) throw new Error(t('serviceId 必填'))
    const headerName = input.headerName?.trim() || 'Authorization'
    const existing = this.read(serviceId)
    const credentialRef = input.credentialRef?.trim() || existing?.credentialRef || `local:${serviceId}`
    if (credentialRef.startsWith('env:')) {
      if (input.secret) {
        throw new Error(t('env: 形态凭证不落明文：secret 必须缺省，取值来自进程环境变量 {name}', { name: credentialRef.slice(4).trim() }))
      }
    } else if (credentialRef.startsWith('local:')) {
      if (!input.secret) throw new Error(t('local: 形态凭证必须提供 secret 明文'))
    } else {
      throw unsupportedError(credentialRef)
    }
    const secrets = [...(existing?.secrets ?? [])]
    const entry: McpCredentialEntry = { headerName, secret: credentialRef.startsWith('env:') ? '' : input.secret! }
    const hit = secrets.findIndex((item) => item.headerName === headerName)
    if (hit >= 0) secrets[hit] = entry // 同名再 put 即轮换（rotate）
    else secrets.push(entry)
    this.write(serviceId, { credentialRef, secrets, updatedAt: nowIso() })
    return this.describe(serviceId)!
  }

  /**
   * 取值（调用/探活/工具发现透传前注入）：返回按 headerName 注入的条目清单；
   * 无登记返回 null（调用链回落存量 headers）；env 变量缺失返回 null 并留一次访问审计。
   * vault:/external:/未知前缀抛 CREDENTIAL_BROKER_UNSUPPORTED（fail-closed，由调用链既有
   * try/catch 呈现为调用失败/探活失败——配了不支持的凭证形态就不该静默裸奔）。
   *
   * options.dedupKey（W3-T5 §14 探活审计聚合，T2 遗留）：探活等周期性 resolve 场景传入
   * 固定键（如 'probe'）——同 serviceId+credentialRef+dedupKey 在窗口内只发一次
   * mcp.secret.access 事件，窗口内计数在窗口关闭（下一次开窗）时随事件附 suppressedCount；
   * 不传键（调用/工具发现等真实访问）保持逐次留痕，审计侧零改动。
   */
  resolve(serviceId: string, options: { dedupKey?: string } = {}): McpCredentialEntry[] | null {
    const stored = this.read(serviceId)
    if (!stored) return null
    const credentialRef = stored.credentialRef || `local:${serviceId}`
    const isLocal = credentialRef.startsWith('local:')
    const isEnv = credentialRef.startsWith('env:')
    if (!isLocal && !isEnv) throw unsupportedError(credentialRef)
    const deduped = typeof options.dedupKey === 'string'
    const emit = (result: 'ok' | 'missing' | 'empty'): void => {
      if (!deduped) {
        this.emitAccess(serviceId, credentialRef, result)
        return
      }
      // 窗口去重：同 key 窗口内只发一次；窗口关闭后首事件附带上一窗口的聚合计数
      const key = `${serviceId}|${credentialRef}|${options.dedupKey}`
      const nowMs = Date.now()
      const window = this.accessWindows.get(key)
      if (window && nowMs - window.windowStart < this.probeDedupWindowMs) {
        window.count++
        window.suppressed++
        return
      }
      const suppressedCount = window ? window.suppressed : 0
      this.accessWindows.set(key, { windowStart: nowMs, count: 1, suppressed: 0 })
      this.emitAccess(serviceId, credentialRef, result, suppressedCount > 0 ? suppressedCount : undefined)
    }
    if (isEnv) {
      const varName = credentialRef.slice(4).trim()
      // P1-04：白名单外的 env: 引用按「凭证缺失」处理（fail-closed 不注入），留访问审计
      if (!varName || !envSecretAllowed(varName)) {
        this.ctx.logger('mcp-secret-broker').warn(`env: 凭证引用未登记白名单（MCP_ENV_SECRET_ALLOWLIST），拒绝注入：service=${serviceId} ref=${credentialRef}`)
        emit('missing')
        return null
      }
      const value = process.env[varName]
      if (!value) {
        emit('missing')
        return null
      }
      emit('ok')
      const entries = stored.secrets.filter((item) => item.headerName)
      return entries.length > 0
        ? entries.map((item) => ({ headerName: item.headerName, secret: value }))
        : [{ headerName: 'Authorization', secret: value }]
    }
    const entries = stored.secrets.filter((item) => item.headerName && item.secret)
    if (entries.length === 0) {
      emit('empty')
      return null
    }
    emit('ok')
    return entries.map((item) => ({ headerName: item.headerName, secret: item.secret }))
  }

  /** 描述（REST GET 回显/治理面）：只有元数据，永不返回 secret 原文；无登记返回 null。 */
  describe(serviceId: string): McpCredentialDescription | null {
    const stored = this.read(serviceId)
    if (!stored) return null
    return {
      credentialRef: stored.credentialRef,
      headerNames: stored.secrets.map((item) => item.headerName),
      updatedAt: stored.updatedAt,
    }
  }

  /** 删除（服务删除联动/凭证清空）：文件不存在返回 false。 */
  delete(serviceId: string): boolean {
    const file = this.fileOf(serviceId)
    if (!existsSync(file)) return false
    rmSync(file)
    return true
  }

  /** 访问留痕（契约 §6：每次 resolve emit；payload 绝不带 secret 值，audit 订阅落 mcp.credential.access）。
   *  suppressedCount（W3-T5 §14，additive）：探活去重窗口关闭时，上一窗口被聚合的重复读取次数。 */
  private emitAccess(serviceId: string, credentialRef: string, result: 'ok' | 'missing' | 'empty', suppressedCount?: number): void {
    this.ctx.platformBus.emit(PlatformEvents.McpSecretAccess, {
      serviceId,
      credentialRef,
      result,
      at: nowIso(),
      actor: 'mcp-gateway',
      actorName: 'Secret Broker',
      type: 'mcp_service',
      ...(suppressedCount !== undefined ? { suppressedCount } : {}),
      note: result === 'ok'
        ? t('凭证读取成功（值不入事件与审计）')
        : result === 'missing'
          ? t('env 变量缺失，凭证未取到')
          : t('凭证登记存在但无有效条目'),
    })
  }
}
