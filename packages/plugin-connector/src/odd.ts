/**
 * ODD（Operation Design Domain）运行时判定（OPT-P2-01，2026-09-12）。
 *
 * 连接器权限组可声明 odd 块（运营设计域）：provider 白名单 / 显式排除 action /
 * 目录数据新鲜度阈值 / 许可时间窗。`inOdd` 为纯函数——授权链在 admin 审批门之前插入域内判定，
 * 离域即拒绝并发 `connector.odd_exit`（走 OPT-P1-04 总线落审计）。
 * 边界从此可计算：目录外 action、陈旧目录、时间窗外调用不再依赖"admin 兜底"被动防御。
 */
import { t } from '../../platform-i18n/src/index.ts'

export interface OddDeclaration {
  /** provider（service）白名单：'*' 或显式列表；未声明=不限制。 */
  allowedServices?: string[] | '*'
  /** 显式排除 action id（目录外/危险动作点名排除）。 */
  excludedActions?: string[]
  /** 目录数据新鲜度阈值（分钟）：目录 syncedAt 距今超过阈值即离域（未声明=不限制）。 */
  dataFreshnessMinutes?: number
  /** 许可时间窗（本地时，24h 制）：如 { start: 9, end: 18 }；跨零点支持 start > end；未声明=全天。 */
  activeHours?: { start: number; end: number }
}

export interface OddActionRef {
  id: string
  service: string
}

export interface OddVerdict {
  in: boolean
  reasons: string[]
}

function inActiveHours(now: Date, window: { start: number; end: number }): boolean {
  const hour = now.getHours()
  const { start, end } = window
  if (start === end) return hour === start
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end // 跨零点：22→6
}

/**
 * 域内判定（纯函数）：全部约束命中即 in=true；任一离域给出 reasons（人可读，入审计）。
 */
export function inOdd(
  odd: OddDeclaration,
  action: OddActionRef,
  options: { now?: Date; catalogSyncedAt?: string } = {},
): OddVerdict {
  const reasons: string[] = []
  const now = options.now ?? new Date()

  if (Array.isArray(odd.allowedServices) && !odd.allowedServices.includes(action.service)) {
    reasons.push(t('provider {service} 不在 ODD 白名单（允许：{allowed}）', { service: action.service, allowed: odd.allowedServices.join('、') || t('空') }))
  }

  if (Array.isArray(odd.excludedActions) && odd.excludedActions.includes(action.id)) {
    reasons.push(t('action {action} 在 ODD 显式排除清单内', { action: action.id }))
  }

  if (typeof odd.dataFreshnessMinutes === 'number' && odd.dataFreshnessMinutes > 0) {
    const syncedAt = options.catalogSyncedAt ? Date.parse(options.catalogSyncedAt) : NaN
    if (Number.isNaN(syncedAt)) {
      reasons.push(t('目录缺少同步时间戳，无法证明数据新鲜度（fail-closed）'))
    } else {
      const ageMinutes = (now.getTime() - syncedAt) / 60_000
      if (ageMinutes > odd.dataFreshnessMinutes) {
        reasons.push(t('目录数据已陈旧：距上次同步 {age} 分钟，超过 ODD 阈值 {threshold} 分钟', { age: Math.floor(ageMinutes), threshold: odd.dataFreshnessMinutes }))
      }
    }
  }

  if (odd.activeHours && !inActiveHours(now, odd.activeHours)) {
    reasons.push(t('当前时间 {time} 在 ODD 许可时间窗（{start}:00–{end}:00）之外', {
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      start: odd.activeHours.start,
      end: odd.activeHours.end,
    }))
  }

  return { in: reasons.length === 0, reasons }
}

/**
 * 规范化入参声明：剔除未声明字段，防止部分赋值把 undefined 语义写进台账。
 * QA C-04：**非法声明一律抛错（fail-closed）**——此前 start=25 / 负新鲜度 / 字符串形态白名单
 * 等坏声明被静默剔除，运营以为域已生效实际裸奔（fail-open）。未声明（absent）仍返回 undefined。
 * 抛错沿权限组 upsert 面板以 400 呈现，运营当场修正。
 */
export function normalizeOdd(input: unknown): OddDeclaration | undefined {
  if (!input || typeof input !== 'object') return undefined
  const odd = input as OddDeclaration
  const normalized: OddDeclaration = {}
  if (odd.allowedServices !== undefined) {
    if (odd.allowedServices === '*') normalized.allowedServices = '*'
    else if (Array.isArray(odd.allowedServices) && odd.allowedServices.length > 0
      && odd.allowedServices.every((item) => typeof item === 'string' && item.trim() !== '')) {
      normalized.allowedServices = odd.allowedServices
    } else {
      throw new Error(t('ODD 声明非法：allowedServices 须为 \'*\' 或非空字符串数组（收到 {value}）', { value: JSON.stringify(odd.allowedServices) }))
    }
  }
  if (odd.excludedActions !== undefined) {
    if (Array.isArray(odd.excludedActions) && odd.excludedActions.every((item) => typeof item === 'string' && item.trim() !== '')) {
      if (odd.excludedActions.length > 0) normalized.excludedActions = [...odd.excludedActions]
    } else {
      throw new Error(t('ODD 声明非法：excludedActions 须为非空字符串数组（收到 {value}）', { value: JSON.stringify(odd.excludedActions) }))
    }
  }
  if (odd.dataFreshnessMinutes !== undefined) {
    if (typeof odd.dataFreshnessMinutes === 'number' && Number.isFinite(odd.dataFreshnessMinutes) && odd.dataFreshnessMinutes > 0) {
      normalized.dataFreshnessMinutes = odd.dataFreshnessMinutes
    } else {
      throw new Error(t('ODD 声明非法：dataFreshnessMinutes 须为正数（分钟），收到 {value}', { value: JSON.stringify(odd.dataFreshnessMinutes) }))
    }
  }
  if (odd.activeHours !== undefined) {
    const { start, end } = odd.activeHours ?? ({} as { start?: unknown; end?: unknown })
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23
    if (valid(start) && valid(end)) {
      normalized.activeHours = { start, end }
    } else {
      throw new Error(t('ODD 声明非法：activeHours.start/end 须为 0-23 的整数（本地时，24h 制），收到 {value}', { value: JSON.stringify(odd.activeHours) }))
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}
