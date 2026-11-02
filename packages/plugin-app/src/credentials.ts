/**
 * 应用外部凭证托管（App Credential Vault，GitHub issue #19 方向 A 最小闭环）。
 *
 * 场景：数字员工 / AI 应用需要调用一个外部自研服务，该服务用长期固定凭据鉴权
 * （内部服务 token、第三方 API key、共享密钥——非 OAuth 可授权形态）。此前平台
 * 无任何可存取落点（/api/secrets、/api/vault 404；app attrs 白名单无 secret 字段；
 * connector 凭证保险库 write-only 且平台无回读），明文只能散落各机器本地文件，
 * 无归属、无法收敛轮换、审计断链。
 *
 * 设计（与 SecretBroker 同纪律，叠加静态加密）：
 *   - 存储：专用密钥文件 <dataDir>/secrets/app/<appId>.json（目录 0700 / 文件 0600），
 *     业务集合与任何 API 响应绝不出现明文；
 *   - 加密：AES-256-GCM 静态加密——主密钥 32 字节随机，首用生成落
 *     <dataDir>/secrets/app/.master.key（0600）；每条目独立 12 字节 IV + auth tag，
 *     密钥文件即使被读走，无主密钥不可解（平台全仓首个加密存储位）；
 *   - 授权：取值走独立权限点 app.credential.fetch（角色/机器凭证显式授权，缺省无任何
 *     内置角色持有）+ 对象级校验（机器凭证须绑定本应用，human 须 owner 或管理员）；
 *     登记/轮换/删除沿用 app.write + owner 守卫（与能力绑定同口径）；
 *   - 审计：每次取值 emit PlatformEvents.AppSecretAccess（payload 仅 appId/key/result
 *     等元数据，绝不带值），plugin-audit 订阅落 app.credential.access；
 *   - 回显：列表/详情只回 masked（长度≥8 保留末 4 位）+ lastRotatedAt 等元数据。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents } from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'

/** 凭证键名约束：URL 路径安全、1-64 位（如 kizuna-admin-token、github_api_key）。 */
const CREDENTIAL_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
/** 凭证值长度上限：长期凭据（token/api key/共享密钥）远小于此，防滥用性巨物落盘。 */
const VALUE_MAX_LENGTH = 8192
/** 单应用凭证条目上限（防异常膨胀；一个应用的外部依赖数远达不到）。 */
const ENTRIES_CAP = 100

/** 取值失败：键不存在（REST 层映射 404 CREDENTIAL_NOT_FOUND）。 */
export class AppCredentialMissingError extends Error {}

/** 掩码元数据（列表/登记响应共用）：永不带明文。 */
export interface AppCredentialMeta {
  key: string
  /** 掩码预览：长度≥8 保留末 4 位，否则全掩码。 */
  masked: string
  description?: string
  createdAt: string
  /** 最近轮换时间（同键再登记即轮换；与 createdAt 分离，轮换语义可审计）。 */
  rotatedAt: string
  rotatedBy: string
}

/** 单条密文条目（仅存在于密钥文件）。maskedPreview 为登记时算好的掩码（列表回显免解密）。 */
interface AppCredentialEntry {
  iv: string
  tag: string
  data: string
  maskedPreview: string
  createdAt: string
  rotatedAt: string
  rotatedBy: string
  description?: string
}

/** 密钥文件结构（version 供后续算法演进）。 */
interface AppCredentialFile {
  version: 1
  entries: Record<string, AppCredentialEntry>
  updatedAt: string
}

/** 掩码口径：短值全掩码（不给暴力猜测留末位锚点），长值保留末 4 位供人工比对轮换是否生效。 */
function maskValue(value: string): string {
  return value.length >= 8 ? `••••••••${value.slice(-4)}` : '••••••••'
}

function nowIso(): string {
  return new Date().toISOString()
}

function assertKeyName(key: string): void {
  if (!CREDENTIAL_KEY_RE.test(key)) {
    throw new Error(t('凭证键名非法：{key}（须为字母/数字开头，仅含字母数字._-，1-64 位）', { key }))
  }
}

function assertValue(value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(t('凭证值必填（非空字符串）'))
  if (value.length > VALUE_MAX_LENGTH) {
    throw new Error(t('凭证值过长：{len} 字符（上限 {max}）', { len: value.length, max: VALUE_MAX_LENGTH }))
  }
}

export class AppCredentialService extends Service {
  static readonly provide = 'appCredentials'

  constructor(ctx: Context) {
    super(ctx, 'appCredentials')
  }

  // -- 存储原语 -------------------------------------------------------------

  /** 数据目录：与 opsStorage 同源（SecretBroker 同款取法）；单测宿主缺席时显式报错。 */
  private dataDir(): string {
    try {
      const dir = (this.ctx as { opsStorage?: { dataDirPath?: string } }).opsStorage?.dataDirPath
      if (dir) return dir
    } catch { /* cordis 严格代理：服务未装配即抛 → 落下方统一报错 */ }
    throw new Error(t('应用凭证托管缺少数据目录（opsStorage 未装配）'))
  }

  /** 应用密钥文件路径（目录结构 <dataDir>/secrets/app/）。 */
  fileOf(appId: string): string {
    const safe = String(appId).replace(/[^a-zA-Z0-9._-]/g, '_')
    return join(this.dataDir(), 'secrets', 'app', `${safe}.json`)
  }

  /**
   * 主密钥（AES-256，32 字节）：首用生成、落 <dataDir>/secrets/app/.master.key（0600）。
   * 密钥与密文分文件：业务备份若误拷密钥文件集，无主密钥仍不可解。文件丢失即全部
   * 密文不可解（fail-closed：取值显式报错指引重新登记，绝不静默返回垃圾值）。
   */
  private masterKey(): Buffer {
    const dir = join(this.dataDir(), 'secrets', 'app')
    const file = join(dir, '.master.key')
    if (existsSync(file)) {
      const hex = readFileSync(file, 'utf8').trim()
      const key = Buffer.from(hex, 'hex')
      if (key.length === 32) return key
      // 主密钥文件损坏：密文不可解，显式报错（不静默重建——静默重建会让全部存量取值失败得更晚更难排查）
      throw new Error(t('应用凭证主密钥文件损坏（.master.key），存量密文不可解，请重新登记全部外部凭证'))
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const key = randomBytes(32)
    writeFileSync(file, key.toString('hex'), 'utf8')
    chmodSync(file, 0o600)
    return key
  }

  private read(appId: string): AppCredentialFile | null {
    const file = this.fileOf(appId)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as AppCredentialFile
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return null
      return parsed
    } catch {
      // 密钥文件损坏按「无凭证」处理（resolve 显式 miss，不炸调用链）；不静默改写，待人工处置
      return null
    }
  }

  private write(appId: string, content: AppCredentialFile): void {
    const file = this.fileOf(appId)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    chmodSync(dirname(file), 0o700) // 目录 0700（mkdir mode 受 umask 影响，显式收敛）
    writeFileSync(file, JSON.stringify(content, null, 2), 'utf8')
    chmodSync(file, 0o600) // 文件 0600：仅属主可读写
  }

  private metaOf(key: string, entry: AppCredentialEntry): AppCredentialMeta {
    return {
      key,
      masked: entry.maskedPreview,
      createdAt: entry.createdAt,
      rotatedAt: entry.rotatedAt,
      rotatedBy: entry.rotatedBy,
      ...(entry.description ? { description: entry.description } : {}),
    }
  }

  private encrypt(plain: string): { iv: string; tag: string; data: string; maskedPreview: string } {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.masterKey(), iv)
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), maskedPreview: maskValue(plain) }
  }

  private decrypt(entry: { iv: string; tag: string; data: string }): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.masterKey(), Buffer.from(entry.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      // 解密失败（主密钥不匹配/密文损坏/GCM 校验失败）：fail-closed 显式报错，绝不返回垃圾值
      throw new Error(t('凭证解密失败（密文校验不通过或主密钥不匹配），请重新登记该凭证'))
    }
  }

  // -- 对外 API -------------------------------------------------------------

  /**
   * 登记/轮换（同键再 put 即轮换）：值 AES-256-GCM 加密落密钥文件；返回掩码元数据。
   * 调用方必须已过 app.write + owner 守卫（本服务不重复校验调用者身份，与
   * resourceCore.create 等底座同位——授权在 REST/工具层收口）。
   */
  put(appId: string, input: { key: string; value: string; description?: string; rotatedBy: string }): AppCredentialMeta {
    assertKeyName(input.key)
    assertValue(input.value)
    const existing = this.read(appId)
    const entries: Record<string, AppCredentialEntry> = { ...(existing?.entries ?? {}) }
    const prior = entries[input.key]
    const at = nowIso()
    const entry: AppCredentialEntry = {
      ...this.encrypt(input.value),
      createdAt: prior?.createdAt ?? at,
      rotatedAt: at,
      rotatedBy: input.rotatedBy,
      ...(input.description?.trim() ? { description: input.description.trim().slice(0, 200) } : (prior?.description ? { description: prior.description } : {})),
    }
    if (!prior && Object.keys(entries).length >= ENTRIES_CAP) {
      throw new Error(t('凭证条目数已达上限（{max}），请清理不再使用的凭证', { max: ENTRIES_CAP }))
    }
    entries[input.key] = entry
    this.write(appId, { version: 1, entries, updatedAt: at })
    return this.metaOf(input.key, entry)
  }

  /** 掩码清单（列表/详情回显）：只有元数据，永不返回明文；无登记返回空数组。 */
  list(appId: string): AppCredentialMeta[] {
    const stored = this.read(appId)
    if (!stored) return []
    return Object.entries(stored.entries).map(([key, entry]) => this.metaOf(key, entry))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
  }

  /**
   * 取值（数字员工凭机器身份 + app.credential.fetch 权限点走 GET /api/apps/:id/credentials/:key/value）：
   * 命中返回明文并 emit AppSecretAccess（payload 仅元数据，audit 订阅逐次落账）；
   * 未命中抛 AppCredentialMissingError（REST 层映射 404）。解密失败按 fail-closed 抛错。
   */
  resolve(appId: string, key: string, caller?: { actor: string; actorName: string }): string {
    assertKeyName(key)
    const stored = this.read(appId)
    const entry = stored?.entries[key]
    if (!entry) {
      this.emitAccess(appId, key, 'missing', caller)
      throw Object.assign(new AppCredentialMissingError(t('凭证不存在：{key}（应用 {appId} 未登记或已删除）', { key, appId })), { code: 'CREDENTIAL_NOT_FOUND' })
    }
    let value: string
    try {
      value = this.decrypt(entry)
    } catch (error) {
      this.emitAccess(appId, key, 'error', caller)
      throw error
    }
    this.emitAccess(appId, key, 'ok', caller)
    return value
  }

  /** 删除单条（键不存在返回 false，幂等）。 */
  remove(appId: string, key: string): boolean {
    assertKeyName(key)
    const stored = this.read(appId)
    if (!stored?.entries[key]) return false
    const entries = { ...stored.entries }
    delete entries[key]
    this.write(appId, { version: 1, entries, updatedAt: nowIso() })
    return true
  }

  /**
   * 应用删除联动清库（AppRegistryService.purge 调用）：整个密钥文件删除——
   * 应用不存在则凭证无归属，绝不允许残留（安全：删除即销毁，非「禁用」）。
   */
  purge(appId: string): boolean {
    const file = this.fileOf(appId)
    if (!existsSync(file)) return false
    rmSync(file)
    return true
  }

  /** 取用留痕（每次 resolve emit；payload 绝不带值，plugin-audit 订阅落 app.credential.access）。 */
  private emitAccess(appId: string, key: string, result: 'ok' | 'missing' | 'error', caller?: { actor: string; actorName: string }): void {
    const appName = this.appName(appId)
    this.ctx.platformBus.emit(PlatformEvents.AppSecretAccess, {
      appId,
      key,
      result,
      at: nowIso(),
      actor: caller?.actor ?? 'unknown',
      actorName: caller?.actorName ?? 'unknown',
      type: 'app',
      id: appId,
      name: appName,
      note: result === 'ok'
        ? t('取用外部凭证 {key}（值不入事件与审计）', { key })
        : result === 'missing'
          ? t('取用外部凭证 {key}：未登记或已删除', { key })
          : t('取用外部凭证 {key}：解密失败', { key }),
    })
  }

  /** 应用名（审计回显用；resourceCore 缺席的极端宿主回退 appId，不炸主流程）。 */
  private appName(appId: string): string {
    try {
      return (this.ctx as { resourceCore?: { get?: (type: string, id: string) => { name?: string } | undefined } }).resourceCore?.get?.('app', appId)?.name ?? appId
    } catch {
      return appId
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    appCredentials: AppCredentialService
  }
}
