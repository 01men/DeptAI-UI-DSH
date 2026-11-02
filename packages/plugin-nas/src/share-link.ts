/**
 * NasShareLinkService —— NAS 签名分享链接（HMAC 签名 URL + 权限复核 + 可吊销）。
 *
 * 设计依据：docs-20260921「NAS 下载链接签名化」交接清单（产品侧已拍板决策 ①②③）：
 * - 替代 10 分钟硬编码票据：档位 1h / 24h（默认）/ 7d / 30d / 永久；
 * - 决策 ①（泛化到全部档位）：签名用**独立长期密钥**（`nas-share-link-secret`），
 *   与 authn 令牌密钥完全解耦——令牌轮换不打穿长链接；轮换后旧密钥进**永久退役集合**
 *   （`nas-share-link-secret-history.json`）持续用于验签，已发链接不因运维动作失效；
 * - 无状态签名（exp/sub/jti 全在载荷里，重启不失效）+ 有状态吊销（nas:shareLinks 落库）；
 * - 取流三关 fail-closed：签名 → 吊销 → 权限复核（nasAuthz.check op='download'，以签发者身份）。
 *
 * 密钥 fail-closed 语义（决策 ①）：密钥文件缺失（首启）→ 生成并落盘；
 * 存在但不可读/不可写 → 进入故障态，签发响亮报错（KEY_UNAVAILABLE），绝不静默换新密钥。
 */
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { generateSecret, newId, sha256Hex, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import { NasAuthzService, type ShareLinkPolicy } from './authz.ts'
import { normalizePath } from './authz/engine.ts'

// ---------------------------------------------------------------------------
// 数据模型与档位
// ---------------------------------------------------------------------------

/** 签发记录（nas:shareLinks，durable：吊销返回 200 后崩溃不得丢失）。id 即 jti。 */
export interface ShareLinkRecord extends RecordBase {
  nasId: string
  path: string
  /** 签发者 principal（审计主体；取流 actor 复用）。 */
  principalId: string
  /** 签发者 userId（权限复核身份）；机器身份不可签发，恒有值。 */
  userId: string
  userName: string
  mode: 'link'
  /** ISO 时间；永久链接存 null（UI/审计显式标注「永久」，不留歧义）。 */
  expiresAt: string | null
  /** 签发时使用的长期密钥标识（sha256(secret) 前 12 位；支撑轮换后定向定位受影响链接）。 */
  keyId: string
  note?: string
  revokedAt?: string
  revokedBy?: string
  revokeReason?: string
  lastUsedAt?: string
  useCount: number
}

export type ShareLinkTier = '1h' | '24h' | '7d' | '30d' | 'permanent' | 'custom'

/** 档位预设（决策 ②：默认 24h；30 天与永久属显式选择，不预选、不兜底）。 */
export const SHARE_LINK_TTL_PRESETS: Array<{ tier: ShareLinkTier; ttlSec: number; label: string }> = [
  { tier: '1h', ttlSec: 3600, label: '1 小时' },
  { tier: '24h', ttlSec: 86400, label: '24 小时' },
  { tier: '7d', ttlSec: 604800, label: '7 天' },
  { tier: '30d', ttlSec: 2592000, label: '30 天' },
]

/** 策略默认值（决策 ②③：上限 30 天；永久默认关，开启后限 permanentPermission 持有者）。 */
export const DEFAULT_SHARE_LINK_POLICY: ShareLinkPolicy = {
  maxTtlSec: 2592000,
  allowPermanent: false,
  permanentPermission: 'nas.authz.write',
}

/** 带语义的签发失败（REST 层按 httpStatus/code 透出，不吞成笼统 400）。 */
export class ShareLinkError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(code: string, message: string, httpStatus: number = 400) {
    super(message)
    this.name = 'ShareLinkError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export type ShareLinkVerdict =
  | { outcome: 'ok'; record: ShareLinkRecord }
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'forbidden'; reasons: string[] }

const EXPIRED_CLEANUP_DELAY_MS = 7 * 24 * 3600_000

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class NasShareLinkService extends Service {
  static readonly provide = 'nasShareLinks'

  /** nasAuthz 为同插件服务：经 Service.inject 声明（插件级 inject 不自引用，防装载期死锁）。 */
  static readonly inject = ['nasAuthz']

  private currentSecret: string | undefined
  private currentKeyId: string | undefined
  /** 密钥故障态（存在但不可读/不可写）：置位后签发响亮失败，验签同样 fail-closed。 */
  private keyError: string | undefined
  /** 永久退役密钥集合（决策 ① 拍板 (a)：轮换后旧密钥永久保留验签，已发链接不因轮换失效）。 */
  private retiredSecrets: Array<{ secret: string; keyId: string; retiredAt: number; note?: string }> = []
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context) {
    super(ctx, 'nasShareLinks')
    this.ctx.opsStorage.collection<ShareLinkRecord>('nas:shareLinks', { durability: 'durable' })
    this.loadKey()
    this.loadRetiredSecrets()
    this.cleanupExpired()
    // 过期记录滚动清理（参照 authn：过期 7 天后物理删除；永久/未过期记录不动）
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 3600_000)
    this.cleanupTimer.unref?.() // lint-timers：测试/嵌入形态允许进程自然退出
    ctx.effect(() => () => {
      if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    })
  }

  links(): Collection<ShareLinkRecord> {
    return this.ctx.opsStorage.collection<ShareLinkRecord>('nas:shareLinks')
  }

  private get nasAuthz(): NasAuthzService {
    return this.ctx.nasAuthz
  }

  // -- 独立长期密钥（决策 ①） -------------------------------------------------

  private keyFilePath(): string {
    return join(this.ctx.opsStorage.dataDirPath, 'nas-share-link-secret')
  }

  private historyFilePath(): string {
    return join(this.ctx.opsStorage.dataDirPath, 'nas-share-link-secret-history.json')
  }

  private keyIdOf(secret: string): string {
    return sha256Hex(secret).slice(0, 12)
  }

  /** 首启生成、幂等不覆盖；存在但不可读 → 故障态（不静默换新，否则既发链接全部失效）。 */
  private loadKey(): void {
    const file = this.keyFilePath()
    try {
      if (existsSync(file)) {
        const secret = readFileSync(file, 'utf8').trim()
        if (!secret) throw new Error(t('密钥文件为空'))
        this.currentSecret = secret
        this.currentKeyId = this.keyIdOf(secret)
        return
      }
      mkdirSync(this.ctx.opsStorage.dataDirPath, { recursive: true })
      const secret = generateSecret('nsl')
      writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 })
      this.currentSecret = secret
      this.currentKeyId = this.keyIdOf(secret)
    } catch (error) {
      this.keyError = error instanceof Error ? error.message : String(error)
      console.error(`[nasShareLinks] 分享链接签名密钥不可用（${this.keyError}）——签发已拒绝（fail-closed），既有链接验签同样拒绝；请修复 ${file} 后重启`, error)
    }
  }

  private loadRetiredSecrets(): void {
    try {
      const file = this.historyFilePath()
      if (!existsSync(file)) return
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Array<{ secret: string; keyId?: string; retiredAt: number; note?: string }>
      this.retiredSecrets = (Array.isArray(stored) ? stored : [])
        .filter((item) => typeof item?.secret === 'string' && item.secret)
        .map((item) => ({ secret: item.secret, keyId: item.keyId ?? this.keyIdOf(item.secret), retiredAt: Number(item.retiredAt ?? 0), ...(item.note ? { note: item.note } : {}) }))
    } catch (error) {
      // 历史文件损坏：不阻断启动，但响亮告警（旧密钥签发的链接将验签失败）
      console.error('[nasShareLinks] 退役密钥历史读取失败——旧密钥签发的既有链接将验签失败（401）', error)
    }
  }

  private saveRetiredSecrets(): void {
    try {
      writeFileSync(this.historyFilePath(), JSON.stringify(this.retiredSecrets, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.error('[nasShareLinks] 退役密钥历史落盘失败（轮换后旧密钥链接将验签失败）', error)
    }
  }

  /** 轮换独立长期密钥（显式运维动作）：新钥落盘，旧钥进永久退役集合继续用于验签。 */
  rotateSecret(note?: string): { keyId: string; retiredKeyId?: string; retiredCount: number } {
    mkdirSync(this.ctx.opsStorage.dataDirPath, { recursive: true })
    const secret = generateSecret('nsl')
    try {
      writeFileSync(this.keyFilePath(), secret, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      throw new ShareLinkError('KEY_ROTATE_FAILED', t('新密钥落盘失败（保持旧密钥不变）：{reason}', { reason: error instanceof Error ? error.message : String(error) }), 500)
    }
    const retiredKeyId = this.currentKeyId
    if (this.currentSecret && retiredKeyId) {
      this.retiredSecrets = [
        { secret: this.currentSecret, keyId: retiredKeyId, retiredAt: Date.now(), ...(note ? { note } : {}) },
        ...this.retiredSecrets,
      ]
      this.saveRetiredSecrets()
    }
    this.currentSecret = secret
    this.currentKeyId = this.keyIdOf(secret)
    this.keyError = undefined
    return { keyId: this.currentKeyId!, ...(retiredKeyId ? { retiredKeyId } : {}), retiredCount: this.retiredSecrets.length }
  }

  secretStatus(): { available: boolean; keyId?: string; error?: string; retiredCount: number } {
    return {
      available: !this.keyError && !!this.currentKeyId,
      ...(this.currentKeyId ? { keyId: this.currentKeyId } : {}),
      ...(this.keyError ? { error: this.keyError } : {}),
      retiredCount: this.retiredSecrets.length,
    }
  }

  /** 签发前密钥可用性闸（fail-closed，决策 ①）：故障态响亮报错，绝不静默换新密钥。 */
  private ensureKey(): void {
    if (!this.currentSecret || !this.currentKeyId || this.keyError) {
      throw new ShareLinkError('SHARE_LINK_KEY_UNAVAILABLE',
        t('分享链接签名密钥不可用（fail-closed 拒绝签发）：{reason}——请修复密钥文件后重启，或用 rotate 端点重建', { reason: this.keyError ?? t('密钥未加载') }), 500)
    }
  }

  private sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('base64url')
  }

  /** 签名比对：当前密钥优先，其后全部永久退役密钥（决策 ① (a)：老密钥签发的历史链接永久可验）。 */
  private signatureMatches(body: string, signature: string): boolean {
    if (this.currentSecret && this.sign(body, this.currentSecret) === signature) return true
    return this.retiredSecrets.some((item) => this.sign(body, item.secret) === signature)
  }

  // -- 档位策略（载体 = AuthzRulesRecord.shareLinkPolicy，与数据权限治理面同源） --

  policy(): ShareLinkPolicy {
    const stored = this.nasAuthz.getRules().shareLinkPolicy
    return {
      maxTtlSec: typeof stored?.maxTtlSec === 'number' && stored.maxTtlSec > 0 ? stored.maxTtlSec : DEFAULT_SHARE_LINK_POLICY.maxTtlSec,
      allowPermanent: stored?.allowPermanent === true,
      permanentPermission: stored?.permanentPermission || DEFAULT_SHARE_LINK_POLICY.permanentPermission,
    }
  }

  /** 更新策略（经 AuthzRules 乐观锁；ifVersion 缺省取当前版本，末写者胜——策略低频且有审计留痕）。 */
  updatePolicy(patch: Partial<ShareLinkPolicy>, ifVersion: number | undefined, actor: string): ShareLinkPolicy {
    if (patch.maxTtlSec !== undefined && (!Number.isInteger(patch.maxTtlSec) || patch.maxTtlSec <= 0)) {
      throw new ShareLinkError('INVALID_POLICY', t('maxTtlSec 须为正整数，收到 {value}', { value: patch.maxTtlSec }))
    }
    const current = this.policy()
    const merged: ShareLinkPolicy = {
      maxTtlSec: patch.maxTtlSec ?? current.maxTtlSec,
      allowPermanent: patch.allowPermanent ?? current.allowPermanent,
      permanentPermission: patch.permanentPermission?.trim() || current.permanentPermission,
    }
    const version = ifVersion ?? this.nasAuthz.getRules().version
    const saved = this.nasAuthz.updateRules({ shareLinkPolicy: merged }, version, actor)
    return saved.shareLinkPolicy ?? merged
  }

  // -- 签发 -------------------------------------------------------------------

  /**
   * 签发签名分享链接。校验序（服务端强制，与前端显隐无关，决策 ②）：
   * 机器身份拒绝 → permanent/ttlSec 互斥 → 永久策略开关（优先于权限点）→ 永久权限点 → TTL 上限。
   */
  issue(input: {
    nasId: string
    path: string
    issuer: { principalId: string; userId?: string; userName: string }
    ttlSec?: number
    permanent?: boolean
    note?: string
    hasPermanentPermission: boolean
  }): { record: ShareLinkRecord; exp: number; sub: string; sig: string; tier: ShareLinkTier; ttlLabel: string; ttlSec: number | null } {
    if (!input.issuer.userId) {
      throw new ShareLinkError('MACHINE_ISSUANCE_UNSUPPORTED', t('签名分享链接仅支持人工身份签发（机器链路请用一次性下载票据）'), 403)
    }
    let path: string
    try {
      path = normalizePath(input.path)
    } catch (error) {
      throw new ShareLinkError('INVALID_PATH', t('path 非法：{reason}', { reason: error instanceof Error ? error.message : String(error) }))
    }
    if (input.permanent === true && input.ttlSec !== undefined) {
      throw new ShareLinkError('PERMANENT_TTL_CONFLICT', t('permanent 与 ttlSec 互斥（语义歧义不猜测）：要永久请只传 permanent:true'))
    }
    const policy = this.policy()
    let expiresAt: string | null
    let exp: number
    let tier: ShareLinkTier
    let ttlLabel: string
    let ttlSec: number | null
    if (input.permanent === true) {
      // 决策 ③：策略开关优先于权限点——默认形态（allowPermanent=false）下不存在永久链接
      if (!policy.allowPermanent) {
        throw new ShareLinkError('PERMANENT_DISABLED_BY_POLICY', t('永久链接档位未开启（share-link-policy.allowPermanent=false，策略开关优先于权限点）'), 403)
      }
      if (!input.hasPermanentPermission) {
        throw new ShareLinkError('PERMANENT_REQUIRES_AUTHZ_WRITE', t('签发永久链接需要权限点 {permission}', { permission: policy.permanentPermission }), 403)
      }
      expiresAt = null
      exp = 0
      tier = 'permanent'
      ttlLabel = t('永久')
      ttlSec = null
    } else {
      ttlSec = input.ttlSec ?? 86400 // 决策 ②：缺省 24 小时
      if (!Number.isInteger(ttlSec) || ttlSec <= 0) {
        throw new ShareLinkError('INVALID_TTL', t('ttlSec 须为正整数（秒），收到 {value}', { value: String(input.ttlSec) }))
      }
      if (ttlSec > policy.maxTtlSec) {
        throw new ShareLinkError('TTL_EXCEEDS_POLICY', t('TTL_EXCEEDS_POLICY：ttlSec {value} 超过策略上限 {max}（明确拒绝，不回落到上限）', { value: ttlSec, max: policy.maxTtlSec }))
      }
      expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString()
      exp = Math.floor(Date.now() / 1000) + ttlSec
      const preset = SHARE_LINK_TTL_PRESETS.find((item) => item.ttlSec === ttlSec)
      tier = preset?.tier ?? 'custom'
      ttlLabel = preset ? t(preset.label) : (ttlSec % 3600 === 0 ? t('{n} 小时', { n: ttlSec / 3600 }) : t('{n} 分钟', { n: Math.round(ttlSec / 60) }))
    }
    this.ensureKey()
    const jti = newId('nsl')
    const sub = input.issuer.userId
    const sig = this.sign(`${path}|${input.nasId}|${exp}|${sub}|${jti}`, this.currentSecret!)
    const record = this.links().insert({
      id: jti,
      nasId: input.nasId,
      path,
      principalId: input.issuer.principalId,
      userId: sub,
      userName: input.issuer.userName,
      mode: 'link',
      expiresAt,
      keyId: this.currentKeyId!,
      useCount: 0,
      ...(input.note ? { note: input.note } : {}),
    })
    return { record, exp, sub, sig, tier, ttlLabel, ttlSec }
  }

  // -- 清单 / 吊销 ------------------------------------------------------------

  list(filter: { nasId?: string; userId?: string; path?: string; includeRevoked?: boolean }): Array<ShareLinkRecord & { status: 'active' | 'revoked' | 'expired'; remainingSec: number | null }> {
    return this.links().find((item) => {
      if (filter.nasId && item.nasId !== filter.nasId) return false
      if (filter.userId && item.userId !== filter.userId) return false
      if (filter.path) {
        try {
          if (item.path !== normalizePath(filter.path)) return false
        } catch {
          return false
        }
      }
      if (!filter.includeRevoked && item.revokedAt) return false
      return true
    })
      .map((item) => ({ ...item, ...this.describeStatus(item) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** 状态与剩余有效期（永久链接 remainingSec=null）。 */
  describeStatus(record: ShareLinkRecord): { status: 'active' | 'revoked' | 'expired'; remainingSec: number | null } {
    if (record.revokedAt) return { status: 'revoked', remainingSec: 0 }
    if (record.expiresAt !== null) {
      const remaining = Math.floor((Date.parse(record.expiresAt) - Date.now()) / 1000)
      if (remaining <= 0) return { status: 'expired', remainingSec: 0 }
      return { status: 'active', remainingSec: remaining }
    }
    return { status: 'active', remainingSec: null }
  }

  /** 吊销单条（幂等：已吊销再调返回既有状态，不报错）。 */
  revoke(jti: string, by: string, reason: string): { record: ShareLinkRecord; alreadyRevoked: boolean } {
    const record = this.links().get(jti)
    if (!record) throw new ShareLinkError('SHARE_LINK_NOT_FOUND', t('分享链接不存在：{id}', { id: jti }), 404)
    if (record.revokedAt) return { record, alreadyRevoked: true }
    const updated = this.links().update(jti, {
      revokedAt: new Date().toISOString(),
      revokedBy: by,
      ...(reason ? { revokeReason: reason } : {}),
    })
    return { record: updated, alreadyRevoked: false }
  }

  /** 批量吊销（按人/按路径/全部；「某人离职 → 一次性吊销其全部链接」是最高频场景）。 */
  revokeBatch(filter: { nasId?: string; userId?: string; path?: string; all?: boolean }, by: string, reason: string): { count: number } {
    if (!filter.userId && !filter.path && filter.all !== true) {
      throw new ShareLinkError('REVOKE_CRITERIA_REQUIRED', t('批量吊销须至少给出 userId、path 之一，或显式 all:true（防误伤全量）'))
    }
    let count = 0
    for (const item of this.links().find((link) => {
      if (filter.nasId && link.nasId !== filter.nasId) return false
      if (link.revokedAt) return false
      if (filter.userId && link.userId !== filter.userId) return false
      if (filter.path) {
        try {
          if (link.path !== normalizePath(filter.path)) return false
        } catch {
          return false
        }
      }
      return true
    })) {
      this.links().update(item.id, {
        revokedAt: new Date().toISOString(),
        revokedBy: by,
        ...(reason ? { revokeReason: reason } : {}),
      })
      count++
    }
    return { count }
  }

  // -- 取流三关（签名 → 吊销 → 权限复核；fail-closed，缺一不可） ------------------

  verifyStreamAccess(input: { nasId: string; path: string; exp: string; sub: string; jti: string; sig: string }): ShareLinkVerdict {
    const invalid = (reason: string): ShareLinkVerdict => ({ outcome: 'invalid', reason })
    if (!input.path || !input.exp || !input.sub || !input.jti || !input.sig) return invalid(t('参数缺失'))
    if (!/^\d+$/.test(input.exp)) return invalid(t('exp 非法'))
    const exp = Number(input.exp)
    // 关 1：签名（独立长期密钥，重启不失效）+ 过期判定（exp=0 为永久，跳过）
    if (!this.signatureMatches(`${input.path}|${input.nasId}|${input.exp}|${input.sub}|${input.jti}`, input.sig)) {
      return invalid(t('签名校验失败（链接被篡改或密钥不匹配）'))
    }
    if (exp !== 0 && exp * 1000 < Date.now()) return invalid(t('链接已过期'))
    // 关 2：吊销（jti 指向签发记录；记录不存在/已吊销/与载荷不一致 → 拒绝）
    const record = this.links().get(input.jti)
    if (!record) return invalid(t('链接记录不存在（伪造或已清理）'))
    if (record.revokedAt) return invalid(t('链接已被吊销（{by}）', { by: record.revokedBy ?? '-' }))
    if (record.nasId !== input.nasId || record.path !== input.path || record.userId !== input.sub) return invalid(t('链接记录与载荷不一致'))
    if (record.expiresAt !== null && Date.parse(record.expiresAt) < Date.now()) return invalid(t('链接已过期'))
    // 关 3：权限复核（核心增量）：以签发者身份实时判定，票据只是「身份+文件」的封装
    const decision = this.nasAuthz.check({
      nasId: input.nasId,
      userId: input.sub,
      paths: [input.path],
      op: 'download',
      caller: 'nas.share-link',
    })
    if (decision.decision !== 'allow') {
      return { outcome: 'forbidden', reasons: decision.reasons.length > 0 ? decision.reasons : [t('数据权限判定未放行')] }
    }
    return { outcome: 'ok', record }
  }

  /** 使用画像（取流成功后调用；支撑异常使用发现与「从未使用的失效链接」清理）。 */
  recordUse(jti: string): void {
    try {
      const record = this.links().get(jti)
      if (!record) return
      this.links().update(jti, { useCount: record.useCount + 1, lastUsedAt: new Date().toISOString() })
    } catch (error) {
      this.ctx.logger('nasShareLinks').warn('分享链接使用计数失败（不影响取流）', error)
    }
  }

  /** 过期记录滚动清理：过期 7 天后物理删除（取证窗口；审计另有 changeLog/decisions 留痕）。 */
  cleanupExpired(): number {
    const cutoff = Date.now() - EXPIRED_CLEANUP_DELAY_MS
    let removed = 0
    for (const record of this.links().all()) {
      if (record.expiresAt !== null && Date.parse(record.expiresAt) < cutoff) {
        if (this.links().remove(record.id)) removed++
      }
    }
    return removed
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    nasShareLinks: NasShareLinkService
  }
}
