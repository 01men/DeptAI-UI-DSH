/**
 * 资产使用凭证（2026-10-31）：Agent 使用平台资产（skill/MCP）后主动提报的使用事实。
 *
 * 定位（与计量事件的关系，接入指引 §4.4/§4.7 口径）：
 *   - usage_events 是计费管道（价格簿/成本口径）：经平台网关的调用由平台自动计量，禁止重复推送；
 *   - 本凭证是「使用事实」：skill.zip 下载到本地执行等平台无感知的使用，由 Agent 逐次提报，
 *     作为资产经营侧的使用凭证（台账 usageReports30d / 审计逐次落账）。
 *
 * 授权闭环（不新建授权原语，校验建立在既有「获取记录」上）：
 *   - skill：install 依赖边（resourceCore，agent→skill）∪ download 流水（skill~downloads.json，
 *     机器主体按 principalId 匹配——download 路由对机器调用者登记的就是 principalId）；
 *   - mcp：与数据面同口径——权限组 subjects 含该 agent 且 policies 覆盖目标服务。
 * 机器主体未获取先提报 → 403（先走获取链路）；human 持 usage.write 可代报（归因 human）。
 *
 * 依赖方向：本模块只经 ctx 运行时访问 skillHub/mcpRegistry/resourceCore（不做插件级 inject）——
 * skillhub/mcp/agent 均注入 usage，UsageService 反向依赖会成环；REST 路由与 MCP 工具共用本编排。
 */
import { t } from '../../platform-i18n/src/index.ts'
import type { CallerInfo, Collection, RecordBase } from '../../platform-core/src/index.ts'

/** 提报的资产域（v1：skill/MCP；additive 扩展新类型不改既有字段语义）。 */
export type AssetUsageAssetType = 'skill' | 'mcp'

/** 凭证流水记录（usage:assetReports 集合，只追加；幂等键唯一）。 */
export interface AssetUsageReportRecord extends RecordBase {
  assetType: AssetUsageAssetType
  /** 提报时的资产引用原样留存（id 或 slug）。 */
  assetRef: string
  /** 与台账 key 同键（skill:<id> / mcp:<slug>）——台账行与凭证流水直接互查。 */
  assetKey: string
  assetName: string
  assetVersion?: string
  action: string
  occurredAt: string
  outcome: 'success' | 'failure'
  durationMs?: number
  tokens?: number
  taskId?: string
  note?: string
  /** 全局唯一幂等键（约定 <agent标识>:<业务单号>，同键同内容重放安全、同键异容拒绝）。 */
  idempotencyKey: string
  /** occurredAt 是否为调用方显式提供（隐式服务端生成的时间不参与幂等指纹，保证无 occurredAt 的重试重放安全）。 */
  occurredAtExplicit?: boolean
  reporterType: 'machine' | 'human'
  reporterPrincipalId: string
  reporterName: string
  /** machine 且 refType=agent 时回填（经营侧按 Agent 归因）。 */
  agentId?: string
  /** human 代报时回填。 */
  userId?: string
}

/** REST/工具入参（全部可选字段由 prepare 校验补全）。 */
export interface AssetUsageReportInput {
  assetType?: string
  assetRef?: string
  assetVersion?: string
  action?: string
  occurredAt?: string
  outcome?: string
  durationMs?: number
  tokens?: number
  taskId?: string
  note?: string
  idempotencyKey?: string
}

/** prepare 编排所需的最小跨域访问面（运行时经 ctx 传入，不做插件级 inject——防循环依赖）。 */
export interface AssetUsageCheckCtx {
  skillHub: {
    skills(): Collection<{ id: string; slug: string; name: string; currentVersion: string }>
    downloads(): Collection<{ skillId: string; version: string; userId: string }>
  }
  mcpRegistry: {
    services(): Collection<{ id: string; slug: string; name: string; currentVersion: string }>
    permGroups(): Collection<{ id: string; policies: Record<string, unknown>; subjects: Array<{ type: string; id: string }> }>
  }
  resourceCore: {
    dependencies(): Collection<{ kind: string; fromType: string; fromId: string; toType: string; toId: string }>
  }
}

/** 带状态码的提报错误：REST 路由按 status exchange.fail，工具面按 message 透出。 */
export class AssetUsageError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 补录窗口：凭证是使用事实，只允许补录近 30 天（防海量回填稀释经营口径）。 */
const BACKFILL_WINDOW_MS = 30 * 86_400_000
/** occurredAt 允许的少量时钟偏移（未来 5 分钟内视为时钟漂移，不再严格拒绝）。 */
const CLOCK_SKEW_MS = 5 * 60_000
/** action 白名单形态：小写字母开头，小写字母/数字/下划线，≤32 字符。 */
const ACTION_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

/** 幂等指纹：语义字段归一化后比较（同键同内容重放 → deduped；同键异容 → 409）。
 *  occurredAt 只在调用方显式提供时参与——隐式「服务端当时时间」在重试时必然不同，
 *  计入指纹会让无 occurredAt 的合法重放被误判为异容（违背重放安全承诺）。 */
export function reportFingerprint(report: Pick<AssetUsageReportRecord, 'assetType' | 'assetKey' | 'assetVersion' | 'action' | 'occurredAt' | 'occurredAtExplicit' | 'outcome' | 'durationMs' | 'tokens' | 'taskId' | 'note'>): string {
  return JSON.stringify([
    report.assetType, report.assetKey, report.assetVersion ?? '', report.action,
    report.occurredAtExplicit ? report.occurredAt : '', report.outcome, report.durationMs ?? -1, report.tokens ?? -1,
    report.taskId ?? '', report.note ?? '',
  ])
}

/**
 * 提报编排：字段校验 → 资产存在性（防编造）→ 授权关系（获取闭环）→ 归一化。
 * 通过后返回可直接落库的记录载荷（不含 id/createdAt/updatedAt——由 submitAssetUsageReport 落集合时补）。
 */
export function prepareAssetUsageReport(ctx: AssetUsageCheckCtx, input: AssetUsageReportInput, caller: CallerInfo): Omit<AssetUsageReportRecord, 'id' | 'createdAt' | 'updatedAt'> {
  // -- 1. 字段校验 -----------------------------------------------------------
  const assetType = input.assetType
  if (assetType !== 'skill' && assetType !== 'mcp') {
    throw new AssetUsageError(400, 'INVALID_ASSET_TYPE', t('assetType 必须是 skill 或 mcp（收到：{value}）', { value: String(assetType ?? '') }))
  }
  const assetRef = String(input.assetRef ?? '').trim()
  if (assetRef === '' || assetRef.length > 200) {
    throw new AssetUsageError(400, 'INVALID_ASSET_REF', t('assetRef 必填（skill 的 id 或 slug / mcp 的 slug），长度 1~200'))
  }
  const action = input.action === undefined || String(input.action).trim() === '' ? 'invoke' : String(input.action).trim()
  if (!ACTION_PATTERN.test(action)) {
    throw new AssetUsageError(400, 'INVALID_ACTION', t('action 只允许小写字母开头、字母/数字/下划线且 ≤32 字符（收到：{value}）', { value: action }))
  }
  const occurredAtExplicit = !(input.occurredAt === undefined || String(input.occurredAt).trim() === '')
  const occurredAt = occurredAtExplicit ? String(input.occurredAt).trim() : new Date().toISOString()
  const occurred = Date.parse(occurredAt)
  if (Number.isNaN(occurred)) {
    throw new AssetUsageError(400, 'INVALID_OCCURRED_AT', t('occurredAt 必须是 ISO8601 时间（收到：{value}）', { value: occurredAt }))
  }
  const now = Date.now()
  if (occurred > now + CLOCK_SKEW_MS) {
    throw new AssetUsageError(400, 'OCCURRED_AT_IN_FUTURE', t('occurredAt 不允许晚于当前时间（收到：{value}）', { value: occurredAt }))
  }
  if (now - occurred > BACKFILL_WINDOW_MS) {
    throw new AssetUsageError(400, 'OCCURRED_AT_OUT_OF_WINDOW', t('occurredAt 超出补录窗口（仅允许近 30 天，收到：{value}）', { value: occurredAt }))
  }
  const outcome = input.outcome === undefined || String(input.outcome).trim() === '' ? 'success' : String(input.outcome).trim()
  if (outcome !== 'success' && outcome !== 'failure') {
    throw new AssetUsageError(400, 'INVALID_OUTCOME', t('outcome 只允许 success 或 failure（收到：{value}）', { value: outcome }))
  }
  for (const [field, value] of [['durationMs', input.durationMs], ['tokens', input.tokens]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)) {
      throw new AssetUsageError(400, `INVALID_${field.toUpperCase()}`, t('{field} 必须是非负整数（收到：{value}）', { field, value: String(value) }))
    }
  }
  const idempotencyKey = String(input.idempotencyKey ?? '').trim()
  if (idempotencyKey === '' || idempotencyKey.length > 200) {
    throw new AssetUsageError(400, 'INVALID_IDEMPOTENCY_KEY', t('idempotencyKey 必填（约定 <agent标识>:<业务单号>），长度 1~200'))
  }
  const textOf = (value: string | undefined, field: string, max: number): string | undefined => {
    if (value === undefined) return undefined
    const trimmed = String(value).trim()
    if (trimmed === '') return undefined
    if (trimmed.length > max) throw new AssetUsageError(400, `INVALID_${field.toUpperCase()}`, t('{field} 长度不得超过 {max}', { field, max: String(max) }))
    return trimmed
  }
  const assetVersion = textOf(input.assetVersion, 'assetVersion', 64)
  const taskId = textOf(input.taskId, 'taskId', 200)
  const note = textOf(input.note, 'note', 500)

  // -- 2. 资产存在性（不存在的资产不得提报，防编造凭证） -----------------------
  let assetKey: string
  let assetName: string
  let skillId: string | undefined
  let mcpSlug: string | undefined
  if (assetType === 'skill') {
    const skill = ctx.skillHub.skills().all().find((item) => item.id === assetRef || item.slug === assetRef)
    if (!skill) throw new AssetUsageError(404, 'ASSET_NOT_FOUND', t('Skill 不存在：{ref}（先在 Skill 市场确认资产已上架，再走获取链路）', { ref: assetRef }))
    // skill 计量与台账 key 一律用 ID（slug 含非 ASCII，见 plugin-skillhub meterSkillUsage 注释）
    assetKey = `skill:${skill.id}`
    assetName = skill.name
    skillId = skill.id
  } else {
    const service = ctx.mcpRegistry.services().all().find((item) => item.id === assetRef || item.slug === assetRef)
    if (!service) throw new AssetUsageError(404, 'ASSET_NOT_FOUND', t('MCP 服务不存在：{ref}（先确认服务已纳管，再走获取链路）', { ref: assetRef }))
    assetKey = `mcp:${service.slug}`
    assetName = service.name
    mcpSlug = service.slug
  }

  // -- 3. 授权关系（机器主体必须已获取该资产；human 持 usage.write 代报免校验） -----
  const base = {
    assetType, assetRef, assetKey, assetName,
    ...(assetVersion !== undefined ? { assetVersion } : {}),
    action,
    occurredAt: new Date(occurred).toISOString(),
    ...(occurredAtExplicit ? { occurredAtExplicit: true } : {}),
    outcome: outcome as 'success' | 'failure',
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(note !== undefined ? { note } : {}),
    idempotencyKey,
  }
  if (caller.kind !== 'machine') {
    return { ...base, reporterType: 'human', reporterPrincipalId: caller.principalId, reporterName: caller.name, ...(caller.userId !== undefined ? { userId: caller.userId } : {}) }
  }
  if (caller.refType !== 'agent' || !caller.refId) {
    throw new AssetUsageError(403, 'NO_GRANT', t('机器主体（{refType}）暂不支持凭证提报：本能力面向 Agent 机器身份（refType=agent）', { refType: caller.refType ?? 'unknown' }))
  }
  const agentId = caller.refId
  const granted = assetType === 'skill'
    ? skillGranted(ctx, skillId!, agentId, caller.principalId)
    : mcpGranted(ctx, mcpSlug!, agentId)
  if (!granted) {
    throw new AssetUsageError(403, 'NO_GRANT', t('本 Agent 尚未获取该资产，使用凭证被拒：先完成获取（skill 走 install/download；MCP 走权限组绑定），再提报'))
  }
  return { ...base, reporterType: 'machine', reporterPrincipalId: caller.principalId, reporterName: caller.name, agentId }
}

/** skill 授权：install 依赖边（agent→skill）∪ download 流水（机器主体按 principalId 匹配）。 */
function skillGranted(ctx: AssetUsageCheckCtx, skillId: string, agentId: string, principalId: string): boolean {
  const installed = ctx.resourceCore.dependencies().all().some((edge) =>
    edge.kind === 'skill' && edge.fromType === 'agent' && edge.fromId === agentId && edge.toId === skillId)
  if (installed) return true
  return ctx.skillHub.downloads().all().some((record) => record.skillId === skillId && record.userId === principalId)
}

/** mcp 授权：与数据面同口径——存在权限组其 subjects 含该 agent 且 policies 覆盖目标服务。
 *  注意不读 attrs.mcpPermGroupIds（冗余展示字段，可与 subjects 漂移；网关判定也只认 subjects）。 */
function mcpGranted(ctx: AssetUsageCheckCtx, slug: string, agentId: string): boolean {
  const service = ctx.mcpRegistry.services().all().find((item) => item.slug === slug)
  if (!service) return false
  return ctx.mcpRegistry.permGroups().all().some((group) =>
    group.subjects.some((subject) => subject.type === 'agent' && subject.id === agentId)
    && Object.keys(group.policies).includes(service.id))
}
