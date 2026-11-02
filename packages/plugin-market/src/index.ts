/**
 * @dsh-ops/plugin-market —— 第三方插件市场 + 开发者身份域（生态设计 v1.2 第 3/5/7 步）。
 *
 * 契约五面（L0 声明式，无任何可执行代码）：
 *   plugin.yaml                 元数据 + capabilities_request + sandbox + L0 内容（提示词包）
 *   manifest/permissions.yaml   权限声明（requested；安装时企业逐项审批 → approved）
 *   manifest/api.yaml           声明式提供面（L0 阶段仅登记描述）
 *   manifest/events.yaml        事件声明（订阅/发射均收敛在 plugin:<id>: 命名空间）
 *   manifest/billing.yaml       计量声明（兼容字段：仅 meter key/单位参与计量登记，金额侧一律零价快照）
 *
 * 市场准入门禁（硬性）：sandbox 仅受理 L0——L1 有码沙箱（第 10 步）交付前，
 * 任何有码插件提交直接拒绝，杜绝「内部信任」例外。
 *
 * 开发者身份域（M2）：独立于内部员工 iam 域；Ed25519 发布者密钥对验签提交。
 * 签名对象 = 五面文件内容指纹（按文件名排序拼接的 SHA-256）。
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, newId, parseYaml, sha256Hex, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
// M2 筑基：Ed25519 验签基建抽升 platform-core（plugin-update 发布清单验签共用同一套）；
// 此处按市场语境别名 re-export，dshctl 脚手架等既有引用不受影响。
import { generateEd25519KeyPair, isValidEd25519PublicKeyBase64, signEd25519, verifyEd25519 } from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
export { generateEd25519KeyPair as generateDeveloperKeyPair, signEd25519 as signFingerprint, verifyEd25519 as verifySignature }
import * as marketTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface DeveloperRecord extends RecordBase {
  username: string
  displayName: string
  email: string
  status: 'active' | 'suspended'
  passwordSalt: string
  passwordHash: string
  /** 发布者 Ed25519 公钥（SPKI DER → base64）。 */
  publicKey: string
  /** 插件 id 命名空间（NEW-E-01 轻量版）：com.<namespace>.* 归属段；缺省取注册账号品牌段。 */
  namespace?: string
  company?: string
  /** 收款账户登记（资金通道依赖清单就位前的登记位，v1.2 §六）。 */
  payoutAccount?: string
  principalId: string
}

/** 契约五面解析结果。 */
export interface PluginManifest {
  id: string
  version: string
  publisher: string
  depends: string[]
  capabilities_request: string[]
  sandbox: string
  permissions: { requested: string[] }
  api: { routes: Array<{ path: string; method: string; description: string }> }
  events: { subscribes: string[]; emits: string[] }
  billing: {
    model: string
    subscription?: { monthly: number }
    usage: Array<{ key: string; unit: string; price: number }>
    commission: string
  }
  content: {
    prompts: Array<{ name: string; description: string; template: string }>
  }
}

export type PluginStatus = 'scanning' | 'rejected' | 'pending_approval' | 'listed' | 'suspended' | 'deprecated'

export interface PluginSubmissionRecord extends RecordBase {
  pluginId: string
  version: string
  developerId: string
  developerName: string
  status: PluginStatus
  /** 五面原文（文件路径 → 内容）。 */
  files: Record<string, string>
  parsed: PluginManifest
  fingerprint: string
  signature: string
  /** L0 内容指纹：提示词/配置变更 = 行为变更，强制重走审批（M5）。 */
  contentHash: string
  reviewNote?: string
  reviewedBy?: string
  installs: number
}

export interface PluginInstallRecord extends RecordBase {
  pluginId: string
  version: string
  orgId: string
  tenantId: string
  /** 安装时企业审批通过的能力子集（approved ⊆ requested）。 */
  capabilities: string[]
  permissions: string[]
  status: 'running' | 'suspended' | 'uninstalled'
  installedBy: string
}

// ---------------------------------------------------------------------------
// 契约校验
// ---------------------------------------------------------------------------

export const REQUIRED_FILES = ['plugin.yaml', 'manifest/permissions.yaml', 'manifest/api.yaml', 'manifest/events.yaml', 'manifest/billing.yaml']

/** L0 内容静态扫描规则（复用 skillhub 治理模式；声明式内容变更=行为变更）。 */
const CONTENT_BLOCK_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-rf\s+\//i, reason: '疑似破坏性命令' },
  { pattern: /sk-[A-Za-z0-9]{16,}/, reason: '疑似明文密钥' },
  { pattern: /eval\s*\(|new\s+Function\s*\(/, reason: '疑似动态代码执行（L0 禁止可执行内容）' },
  { pattern: /require\s*\(|import\s*\(/, reason: '疑似模块加载（L0 禁止可执行内容）' },
]

export function fingerprintOf(files: Record<string, string>): string {
  const canonical = Object.keys(files).sort()
    .map((key) => `${key}\n${files[key] ?? ''}`)
    .join('\n---\n')
  return sha256Hex(canonical)
}

export function contentHashOf(manifest: PluginManifest): string {
  return sha256Hex(JSON.stringify(manifest.content))
}

/** 解析并校验契约五面（结构性校验 + 准入门禁）。 */
export function parseManifest(files: Record<string, string>): PluginManifest {
  for (const file of REQUIRED_FILES) {
    if (typeof files[file] !== 'string' || files[file]!.trim() === '') {
      throw new Error(t('契约五面缺少文件：{file}', { file }))
    }
  }
  let root: Record<string, unknown>
  let permissions: Record<string, unknown>
  let api: Record<string, unknown>
  let events: Record<string, unknown>
  let billing: Record<string, unknown>
  try {
    root = parseYaml(files['plugin.yaml']!) as Record<string, unknown>
    permissions = parseYaml(files['manifest/permissions.yaml']!) as Record<string, unknown>
    api = parseYaml(files['manifest/api.yaml']!) as Record<string, unknown>
    events = parseYaml(files['manifest/events.yaml']!) as Record<string, unknown>
    billing = parseYaml(files['manifest/billing.yaml']!) as Record<string, unknown>
  } catch (error) {
    throw new Error(t('YAML 解析失败：{reason}', { reason: error instanceof Error ? error.message : String(error) }))
  }
  if (typeof root.id !== 'string' || !/^[a-z0-9]+(\.[a-z0-9-]+){1,3}$/.test(root.id)) {
    throw new Error(t('plugin.yaml id 格式非法（应为反向域名如 com.vendor.name）：{value}', { value: String(root.id) }))
  }
  if (typeof root.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(root.version)) throw new Error(t('plugin.yaml version 必须为语义化版本 x.y.z'))
  if (root.sandbox !== 'L0') {
    throw new Error(t('市场准入门禁：当前仅受理 sandbox: L0（声明式插件），收到 {value}。L1 有码沙箱为第 10 步交付项，交付前不开放有码插件上架。', { value: String(root.sandbox) }))
  }
  const content = (root.content ?? {}) as PluginManifest['content']
  if (!Array.isArray(content.prompts) || content.prompts.length === 0) {
    throw new Error(t('L0 插件必须在 plugin.yaml content.prompts 声明至少一个提示词包（声明式内容的唯一载体）'))
  }
  for (const prompt of content.prompts) {
    if (typeof prompt.name !== 'string' || typeof prompt.template !== 'string' || prompt.template.trim() === '') {
      throw new Error(t('提示词包 {name} 缺少 name/template', { name: String(prompt.name) }))
    }
    for (const rule of CONTENT_BLOCK_RULES) {
      if (rule.pattern.test(prompt.template)) throw new Error(t('L0 内容扫描拦截（{reason}）：提示词包 {name}', { reason: t(rule.reason), name: prompt.name }))
    }
  }
  const manifest: PluginManifest = {
    id: root.id,
    version: root.version,
    publisher: typeof root.publisher === 'string' ? root.publisher : '',
    depends: Array.isArray(root.depends) ? root.depends.map(String) : [],
    capabilities_request: Array.isArray(root.capabilities_request) ? root.capabilities_request.map(String) : [],
    sandbox: String(root.sandbox),
    permissions: { requested: permissions.requested !== undefined ? (Array.isArray(permissions.requested) ? permissions.requested.map(String) : []) : [] },
    api: {
      routes: Array.isArray(api.routes)
        ? api.routes.map((route) => route as { path: string; method: string; description: string })
        : [],
    },
    events: {
      subscribes: Array.isArray(events.subscribes) ? events.subscribes.map(String) : [],
      emits: Array.isArray(events.emits) ? events.emits.map(String) : [],
    },
    billing: {
      model: typeof billing.model === 'string' ? billing.model : 'free',
      ...(billing.subscription !== undefined && billing.subscription !== null ? { subscription: billing.subscription as { monthly: number } } : {}),
      usage: Array.isArray(billing.usage) ? billing.usage as PluginManifest['billing']['usage'] : [],
      commission: typeof billing.commission === 'string' ? billing.commission : 'platform_default',
    },
    content,
  }
  for (const emit of manifest.events.emits) {
    if (!emit.startsWith(`plugin:${manifest.id}:`)) {
      throw new Error(t('events.yaml 发射事件必须收敛在 plugin:{id}: 命名空间：{event}', { id: manifest.id, event: emit }))
    }
  }
  return manifest
}

// Ed25519 验签/密钥/签名三件套已抽升 platform-core（M2 筑基，文件顶部 re-export），
// plugin-update 发布清单验签与市场五面验签共用同一套基建。

/** 能力 → 可消耗资源前缀（运行时对账 M5 的授权基线）。 */
const CAPABILITY_RESOURCE_MAP: Record<string, string> = {
  'model-gateway.invoke': 'model:*',
  'knowledgebase.read': 'kb:*',
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class MarketService extends Service {
  static readonly provide = 'market'

  constructor(ctx: Context) {
    super(ctx, 'market')
    // 自营种子须在服务构造器内做（插件 apply 里 ctx.market 未注入，cordis 红线）。
    // 仅在 DEMO_SEED=1 演示环境下注入自营商业插件，生产基线不写入任何计费价格簿/自营供给。
    if (process.env.DEMO_SEED === '1') {
      seedOfficialPlugins(this)
    }
  }

  developers(): Collection<DeveloperRecord> {
    const collection = this.ctx.opsStorage.collection<DeveloperRecord>('market:developers')
    collection.uniqueOn('developer_username', (dev) => dev.username)
    return collection
  }

  submissions(): Collection<PluginSubmissionRecord> {
    const collection = this.ctx.opsStorage.collection<PluginSubmissionRecord>('market:submissions')
    collection.uniqueOn('submission_plugin_version', (item) => `${item.pluginId}@${item.version}`)
    return collection
  }

  installs(): Collection<PluginInstallRecord> {
    return this.ctx.opsStorage.collection<PluginInstallRecord>('market:installs')
  }

  // -- 开发者身份域（M2：独立于内部员工 iam） --------------------------------

  registerDeveloper(input: { username: string; displayName: string; email: string; password: string; publicKey: string; company?: string; payoutAccount?: string; namespace?: string }): { developer: DeveloperRecord; token: string } {
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(input.username)) throw new Error(t('开发者账号格式非法（^[a-z][a-z0-9_-]{2,31}$）'))
    if (typeof input.displayName !== 'string' || input.displayName.trim() === '') throw new Error(t('开发者显示名（displayName）必填'))
    if (typeof input.email !== 'string' || input.email.trim() === '') throw new Error(t('开发者邮箱（email）必填'))
    if (typeof input.password !== 'string' || input.password.length < 8) throw new Error(t('密码至少 8 位'))
    if (!isValidEd25519PublicKeyBase64(input.publicKey)) {
      throw new Error(t('发布者公钥格式非法（应为 Ed25519 SPKI DER base64）'))
    }
    // NEW-E-01 轻量版：注册即绑定插件 id 命名空间（com.<namespace>.* 归属段）。
    // 缺省取注册账号的品牌段（'-' 前段，如 acme-dev → acme）；显式指定须为合法 id 段字符域
    //（品牌段含 id 非法字符——如下划线——时按原值入册：该账号提交 com.* 插件会被命名空间闸拦下）
    const namespace = input.namespace ?? input.username.split('-')[0]!
    if (input.namespace !== undefined && !/^[a-z0-9][a-z0-9-]{0,30}$/.test(namespace)) {
      throw new Error(t('插件 id 命名空间非法（^[a-z0-9][a-z0-9-]{0,30}$）：{namespace}', { namespace }))
    }
    const credential = this.ctx.authn.createMachineCredential({
      name: `developer:${input.username}`,
      refType: 'external',
      scopes: ['market.developer'],
    })
    const salt = randomBytes(16).toString('hex')
    const record = this.developers().insert({
      id: newId('dev'),
      username: input.username,
      displayName: input.displayName,
      email: input.email,
      status: 'active',
      passwordSalt: salt,
      passwordHash: sha256Hex(`${salt}:${input.password}`),
      publicKey: input.publicKey,
      namespace,
      ...(input.company !== undefined ? { company: input.company } : {}),
      ...(input.payoutAccount !== undefined ? { payoutAccount: input.payoutAccount } : {}),
      principalId: credential.principal.id,
    })
    this.ctx.authn.principals().update(credential.principal.id, { refId: record.id })
    // 开发者主体默认授予平台能力白名单（计量授权，运行时对账基线）
    this.ctx.usage.grantCapabilities(`developer:${record.id}`, ['plugin:*'], 'developer-register')
    return { developer: record, token: this.developerToken(record) }
  }

  loginDeveloper(username: string, password: string): { developer: DeveloperRecord; token: string } {
    const developer = this.developers().findOne((item) => item.username === username)
    if (!developer || developer.passwordHash !== sha256Hex(`${developer.passwordSalt}:${password}`)) {
      throw new Error(t('开发者账号或密码错误'))
    }
    if (developer.status !== 'active') throw new Error(t('开发者账号已停用'))
    return { developer, token: this.developerToken(developer) }
  }

  private developerToken(developer: DeveloperRecord): string {
    const { token } = this.ctx.authn.issueToken(developer.principalId, {
      kind: 'machine',
      ttlHours: 2,
      scopes: ['market.developer'],
      issuedBy: 'market-portal',
    })
    return token
  }

  /** 由令牌主体定位开发者（开发者路由鉴权）。 */
  developerOfPrincipal(principalId: string): DeveloperRecord | undefined {
    return this.developers().findOne((item) => item.principalId === principalId)
  }

  // -- 提交与审批 ------------------------------------------------------------

  submit(developer: DeveloperRecord, files: Record<string, string>, signature: string): PluginSubmissionRecord {
    const parsed = parseManifest(files)
    if (parsed.publisher !== developer.username) {
      throw new Error(t('plugin.yaml publisher 必须为提交者账号（{account}），收到 {value}', { account: developer.username, value: parsed.publisher }))
    }
    // NEW-E-01 轻量版：com.<x>.* 插件 id 的归属段必须与提交者命名空间一致，防 com.<品牌>.* 冒认。
    // 存量兼容：无 namespace 字段的存量开发者不做此检查（保持审批闸现状）
    if (parsed.id.startsWith('com.') && developer.namespace !== undefined) {
      const vendor = parsed.id.slice('com.'.length).split('.')[0] ?? ''
      if (vendor !== developer.namespace) {
        throw new Error(t('插件 id 命名空间越权：com.{vendor}.* 与开发者命名空间 com.{namespace}.* 不一致，不得提交他人品牌段下的插件 id', { vendor, namespace: developer.namespace }))
      }
    }
    const fingerprint = fingerprintOf(files)
    if (!verifyEd25519(developer.publicKey, fingerprint, signature)) {
      throw new Error(t('签名验签失败：五面指纹与发布者公钥签名不匹配'))
    }
    const duplicate = this.submissions().findOne((item) => item.pluginId === parsed.id && item.version === parsed.version)
    if (duplicate) throw new Error(t('版本不可变：{plugin}@{version} 已提交（{status}）', { plugin: parsed.id, version: parsed.version, status: duplicate.status }))
    const record = this.submissions().insert({
      id: newId('sub'),
      pluginId: parsed.id,
      version: parsed.version,
      developerId: developer.id,
      developerName: developer.displayName,
      status: 'pending_approval',
      files,
      parsed,
      fingerprint,
      signature,
      contentHash: contentHashOf(parsed),
      installs: 0,
    })
    this.ctx.platformBus.emit(PlatformEvents.PluginSubmitted, {
      pluginId: parsed.id, version: parsed.version, developer: developer.username, type: 'plugin', id: record.id,
    })
    return record
  }

  approve(id: string, approver: string, opinion: string): PluginSubmissionRecord {
    const record = this.requireSubmission(id)
    if (record.status !== 'pending_approval') throw new Error(t('当前状态 {status} 不允许审批', { status: record.status }))
    const updated = this.submissions().update(id, { status: 'listed', reviewNote: opinion, reviewedBy: approver })
    this.ctx.platformBus.emit(PlatformEvents.PluginListed, {
      pluginId: updated.pluginId, version: updated.version, approver, type: 'plugin', id: updated.id, name: updated.pluginId,
    })
    return updated
  }

  reject(id: string, approver: string, reason: string): PluginSubmissionRecord {
    const record = this.requireSubmission(id)
    if (record.status !== 'pending_approval') throw new Error(t('当前状态 {status} 不允许审批', { status: record.status }))
    return this.submissions().update(id, { status: 'rejected', reviewNote: reason, reviewedBy: approver })
  }

  /** 上架后内容变更（同版本内容指纹变化）→ 强制重走审批：旧版本 suspend 待迁移。 */
  suspend(id: string, reason: string): PluginSubmissionRecord {
    const record = this.requireSubmission(id)
    const updated = this.submissions().update(id, { status: 'suspended', reviewNote: reason })
    for (const install of this.installs().find((item) => item.pluginId === record.pluginId && item.status === 'running')) {
      this.installs().update(install.id, { status: 'suspended' })
    }
    return updated
  }

  listed(): PluginSubmissionRecord[] {
    return this.submissions().find((item) => item.status === 'listed')
  }

  // -- 安装（权限确认 + 能力固化 + 价格簿登记） ------------------------------

  install(input: {
    pluginId: string
    orgId: string
    tenantId: string
    approvedCapabilities: string[]
    approvedPermissions?: string[]
    installedBy: string
  }): PluginInstallRecord {
    const submission = this.submissions().findOne((item) => item.pluginId === input.pluginId && item.status === 'listed')
    if (!submission) throw new Error(t('插件未上架或已下架：{plugin}', { plugin: input.pluginId }))
    const existing = this.installs().findOne((item) => item.pluginId === input.pluginId && item.orgId === input.orgId && item.status !== 'uninstalled')
    if (existing) throw new Error(t('组织 {org} 已安装 {plugin}（{status}）', { org: input.orgId, plugin: input.pluginId, status: existing.status }))
    for (const cap of input.approvedCapabilities) {
      if (!submission.parsed.capabilities_request.includes(cap)) {
        throw new Error(t('能力 {cap} 不在插件请求清单内（approved ⊆ requested）', { cap }))
      }
    }
    // QA E-02：权限面同口径——approvedPermissions 未做 ⊆ requested 校验，可授予插件从未申请的权限点
    const requestedPermissions: string[] = submission.parsed.permissions.requested ?? []
    for (const point of input.approvedPermissions ?? []) {
      if (!requestedPermissions.includes(point)) {
        throw new Error(t('权限点 {point} 不在插件申请清单内（approved ⊆ requested，QA E-02）：请让开发者更新 manifest/permissions.yaml 后重新提交', { point }))
      }
    }
    const record = this.installs().insert({
      id: newId('ins'),
      pluginId: input.pluginId,
      version: submission.version,
      orgId: input.orgId,
      tenantId: input.tenantId,
      capabilities: input.approvedCapabilities,
      permissions: input.approvedPermissions ?? [],
      status: 'running',
      installedBy: input.installedBy,
    })
    // 能力固化：运行时对账基线（M5）——插件主体只许消耗获批能力对应的资源
    const grantedResources = [`plugin:${input.pluginId}`, ...input.approvedCapabilities.map((cap) => CAPABILITY_RESOURCE_MAP[cap] ?? cap)]
    this.ctx.usage.grantCapabilities(`plugin:${input.pluginId}`, grantedResources, `market-install:${record.id}`)
    // 计量登记（M0-3 收敛）：安装即写入价格簿，meter key 取 billing.usage[0] 声明
    //（L0 运行时计量 meterPromptUse 依赖该键过 record() 硬校验）；金额侧一律零价快照——
    // 第三方声明价不再入账（商业模式为私有化年费+治理包，无转售分成/代收）
    const usageEntry = submission.parsed.billing.usage[0]
    if (usageEntry) {
      this.ctx.usage.upsertPrice({
        pattern: `plugin:${input.pluginId}`,
        meter_key: usageEntry.key,
        list_cents_per_unit: 0,
        cost_cents_per_unit: 0,
        units_per_step: 1,
        tax_rate: 0.06,
        currency: 'CNY',
        rate_version: `plugin:${input.pluginId}:v${submission.version}`,
      })
    }
    this.submissions().update(submission.id, { installs: submission.installs + 1 })
    this.ctx.platformBus.emit(PlatformEvents.PluginInstalledEvent, {
      pluginId: input.pluginId, version: submission.version, orgId: input.orgId, tenantId: input.tenantId,
      capabilities: input.approvedCapabilities, installedBy: input.installedBy,
    })
    return record
  }

  uninstall(pluginId: string, orgId: string, actor: string): PluginInstallRecord {
    const record = this.installs().findOne((item) => item.pluginId === pluginId && item.orgId === orgId && item.status === 'running')
    if (!record) throw new Error(t('插件 {plugin} 未在该组织运行中', { plugin: pluginId }))
    const updated = this.installs().update(record.id, { status: 'uninstalled' })
    this.ctx.usage.grantCapabilities(`plugin:${pluginId}`, [], `market-uninstall:${actor}`)
    return updated
  }

  installedFor(orgId: string): PluginInstallRecord[] {
    return this.installs().find((item) => item.orgId === orgId && item.status === 'running')
  }

  /** L0 运行时：读取已安装插件的提示词包（Agent 消费面，纯声明式内容）。 */
  promptPacks(orgId: string): Array<{ pluginId: string; version: string; name: string; description: string; template: string }> {
    const packs: Array<{ pluginId: string; version: string; name: string; description: string; template: string }> = []
    for (const install of this.installedFor(orgId)) {
      const submission = this.submissions().findOne((item) => item.pluginId === install.pluginId && item.version === install.version)
      if (!submission) continue
      for (const prompt of submission.parsed.content.prompts) {
        packs.push({ pluginId: install.pluginId, version: install.version, name: prompt.name, description: prompt.description ?? '', template: prompt.template })
      }
    }
    return packs
  }

  /** L0 内容计量：Agent 每次取用提示词包 → usage 事件（L3 计费）。 */
  meterPromptUse(orgId: string, pluginId: string, promptName: string, subject: string): void {
    const install = this.installs().findOne((item) => item.pluginId === pluginId && item.orgId === orgId && item.status === 'running')
    if (!install) throw new Error(t('插件 {plugin} 未在组织 {org} 安装', { plugin: pluginId, org: orgId }))
    const submission = this.submissions().findOne((item) => item.pluginId === pluginId && item.version === install.version)
    if (!submission) throw new Error(t('插件版本记录缺失'))
    if (!submission.parsed.content.prompts.some((prompt) => prompt.name === promptName)) {
      throw new Error(t('提示词包不存在：{name}', { name: promptName }))
    }
    // 确定性幂等键：安装+主体+提示词包+UTC 分钟窗——同业务重试（meterPromptUse 无业务单据 ID
    // 可用）不重复计量，不同业务（不同安装/主体/提示词包/窗口）不互撞；分钟级去重窗口与
    // usage 自动幂等键（autoIdempotencyKey）同口径
    const dedupWindow = new Date().toISOString().slice(0, 16)
    this.ctx.usage.record({
      org: orgId,
      subject,
      principal: `plugin:${pluginId}`,
      resource: `plugin:${pluginId}`,
      tenant_id: install.tenantId,
      meters: [{ key: submission.parsed.billing.usage[0]?.key ?? 'prompts.used', value: 1, unit: submission.parsed.billing.usage[0]?.unit ?? '次' }],
      idempotency_key: `plugin-use:${install.id}:${subject}:${promptName}:${dedupWindow}`,
    })
  }

  private requireSubmission(id: string): PluginSubmissionRecord {
    const record = this.submissions().get(id)
    if (!record) throw new Error(t('提交记录不存在：{id}', { id }))
    return record
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    market: MarketService
  }
}

export const name = 'market'
export const inject = ['opsStorage', 'platformBus', 'authn', 'usage']

export function apply(ctx: Context) {
  ctx.plugin(MarketService)
  ctx.plugin(marketTools)
}

// ---------------------------------------------------------------------------
// 平台自营首批供给（M3 消解：L0 供给空窗 → 标杆场景演示包，零价快照计量）
// 走与第三方完全相同的提交/签名/审批流水线（吃自己的狗粮）。
// ---------------------------------------------------------------------------

const OFFICIAL_PLUGINS: Array<{ id: string; name: string; description: string; template: string; usageKey: string; unit: string }> = [
  {
    id: 'com.platform.contract-review', name: '合同审查提示词包', description: '按企业合同红线清单输出结构化审查意见',
    template: '你是合同审查专家。对输入合同执行：1) 标的主体与签署权限核验；2) 付款/违约/知识产权条款风险标注（高/中/低）；3) 输出结构化审查意见表。',
    usageKey: 'contract.docs', unit: '份',
  },
  {
    id: 'com.platform.weekly-report', name: '周报生成器', description: '把零散工作记录收敛为管理层周报',
    template: '你是周报整理助手。将输入的工作记录归纳为：本周进展（按优先级）/ 数据亮点 / 风险与求助 / 下周计划，保持事实忠实不夸大。',
    usageKey: 'report.count', unit: '次',
  },
  {
    id: 'com.platform.pii-mask', name: '数据脱敏模板', description: '对外输出前的 PII 脱敏规则包',
    template: '你是数据脱敏助手。按规则处理输入文本：手机号/身份证/银行卡保留前三后四；姓名保留姓；邮箱打码域名前部分；输出脱敏后文本与脱敏项清单。',
    usageKey: 'mask.count', unit: '次',
  },
]

function seedOfficialPlugins(market: MarketService): void {
  // ctx 必须取在 try 外：catch 也要用它记日志（曾因 ctx 定义在 try 内，种子一旦抛错
  // catch 自身 ReferenceError 并把错误升级为 MarketService 构造失败——console 的 inject
  // 随之缺失、插件被 cordis 静默挂起，实例 /api/health 404 且零日志，2026-09-16 M2 排障实证）
  const ctx = market.ctx
  try {
    if (market.submissions().count() > 0) return
    const keys = generateEd25519KeyPair()
    let official = market.developers().findOne((item) => item.username === 'platform-official')
    if (!official) {
      official = market.registerDeveloper({
        username: 'platform-official',
        displayName: '平台官方（自营）',
        email: 'official@platform.internal',
        password: randomBytes(24).toString('base64url'),
        publicKey: keys.publicKeyBase64,
        namespace: 'platform',
      }).developer
    }
    for (const spec of OFFICIAL_PLUGINS) {
      const files: Record<string, string> = {
        'plugin.yaml': [
          `id: ${spec.id}`,
          'version: 1.0.0',
          'publisher: platform-official',
          'depends:',
          '  - dsh-plugin-platform-core: ^1.0',
          'capabilities_request:',
          '  - knowledgebase.read',
          'sandbox: L0',
          'content:',
          '  prompts:',
          `    - name: main`,
          `      description: ${spec.description}`,
          '      template: |',
          `        ${spec.template}`,
          '',
        ].join('\n'),
        'manifest/permissions.yaml': 'requested:\n  - knowledgebase.read\n',
        'manifest/api.yaml': 'routes: []\n',
        'manifest/events.yaml': 'subscribes: []\nemits: []\n',
        'manifest/billing.yaml': [
          'model: free',
          'usage:',
          `  - key: ${spec.usageKey}`,
          `    unit: ${spec.unit}`,
          '    price: 0',
          '',
        ].join('\n'),
      }
      const signature = signEd25519(keys.privateKeyPem, fingerprintOf(files))
      const submission = market.submit(official, files, signature)
      market.approve(submission.id, 'platform-seed', '自营首批供给（M3：标杆场景打破供给空窗）')
    }
    ctx.logger('market').info(`自营首批供给已上架：${OFFICIAL_PLUGINS.length} 个 L0 插件`)
  } catch (error) {
    ctx.logger('market').warn('自营插件种子失败（跳过，不影响启动）', error)
  }
}
