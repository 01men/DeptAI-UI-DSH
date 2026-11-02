/**
 * riskLevel 启发式映射（计划书 §2.4 P2 修正⑭）+ 声明式风险目录覆盖（R6，
 * 吸收 paperclip app-definitions 声明式目录模式）：
 * open-connector action 本体无 risk 字段——优先采用 catalog/risk-overrides.json
 * 声明目录（gen-connector-catalog.mjs 生成 RISK_OVERRIDES 常量），
 * 无声明时按 requiredScopes/providerPermissions + action 名称启发式映射；
 * 无法判定的默认 admin 兜底 fail-closed。
 */

import { RISK_OVERRIDES } from './risk-overrides.generated.ts'

export type RiskLevel = 'read' | 'write' | 'admin'

/** provider 分层（对齐 paperclip S2 分层）：本迭代仅声明与展示，S2 审批联动后续迭代。 */
export type RiskTier = 'S1' | 'S2'

/** 声明式目录单 provider 条目（risk-overrides.json 生成物的元素类型）。 */
export interface RiskOverrideEntry {
  /** 未在 actions 中显式声明的 action 的回落风险级（必填）。 */
  defaultRisk: RiskLevel
  /** S1=低风险常规连接（只读为主）；S2=高敏连接（写/管理面、资金/权限/组织变更类）。 */
  riskTier: RiskTier
  actions: Record<string, RiskLevel>
}

/** 声明式风险目录：service → 覆盖声明。 */
export type RiskOverrides = Record<string, RiskOverrideEntry>

export const RISK_RANK: Record<RiskLevel, number> = { read: 0, write: 1, admin: 2 }

export function rankOf(level: RiskLevel): number {
  return RISK_RANK[level]
}

const READ_SCOPE = /(^|[:.])(read|readonly|profile|userinfo|email|public|view)([:.]|$)/i
const ADMIN_SCOPE = /(admin|delete|destroy|revoke|invite|permission|role|org|webhook.*(write|admin)|token)/i

const READ_NAME = /(^|[._])(list|get|search|fetch|query|top|read|find|browse)[._]?|get[A-Z_]/
const ADMIN_NAME = /(delete|remove|destroy|revoke|suspend|ban|invite|permission|role|owner|transfer|admin)/i
const WRITE_NAME = /(create|update|write|send|post|edit|add|merge|deploy|assign|close|reopen|run|trigger|upload|star|watch|pin)/i

interface RiskInputLike {
  id?: string
  name?: string
  description?: string
  requiredScopes?: Array<unknown>
  providerPermissions?: Array<unknown>
  service?: unknown
}

function scopeStrings(input: RiskInputLike): string[] {
  return [
    ...(Array.isArray(input.requiredScopes) ? input.requiredScopes : []),
    ...(Array.isArray(input.providerPermissions) ? input.providerPermissions : []),
  ].map((item) => String(item))
}

/** 目录同步与授权链共用的风险分级入口。显式 riskLevel 存在时直接采信（前向兼容上游加字段）。 */
export function heuristicRiskLevel(action: RiskInputLike): RiskLevel {
  if ((action as { riskLevel?: unknown }).riskLevel === 'read' || (action as { riskLevel?: unknown }).riskLevel === 'write' || (action as { riskLevel?: unknown }).riskLevel === 'admin') {
    return (action as { riskLevel: RiskLevel }).riskLevel
  }
  const scopes = scopeStrings(action)
  if (scopes.length > 0) {
    if (scopes.every((scope) => READ_SCOPE.test(scope))) return 'read'
    if (scopes.some((scope) => ADMIN_SCOPE.test(scope))) return 'admin'
    if (scopes.some((scope) => !READ_SCOPE.test(scope))) return 'write'
  }
  const text = `${action.id ?? ''} ${action.name ?? ''}`
  if (ADMIN_NAME.test(text)) return 'admin'
  if (READ_NAME.test(text)) return 'read'
  if (WRITE_NAME.test(text)) return 'write'
  if ((action.description ?? '').length > 0 && WRITE_NAME.test(action.description!)) return 'write'
  return 'admin'
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === 'read' || value === 'write' || value === 'admin'
}

/**
 * 风险分级统一入口（R6 声明式目录）。优先级：
 *   action 显式 riskLevel > 声明目录 actions 级 > 声明目录 provider defaultRisk
 *   > heuristicRiskLevel 启发式（含 admin 兜底）。
 * service 取参（显式入参优先于 action.service）；声明命中后不再走启发式——声明即口径。
 */
export function resolveRiskLevel(action: RiskInputLike, service?: string): RiskLevel {
  if (isRiskLevel((action as { riskLevel?: unknown }).riskLevel)) {
    return (action as { riskLevel: RiskLevel }).riskLevel
  }
  const svc = String(service ?? action.service ?? '').trim()
  const override = svc ? RISK_OVERRIDES[svc] : undefined
  if (override) {
    const declared = action.id !== undefined ? override.actions[String(action.id)] : undefined
    if (isRiskLevel(declared)) return declared
    return override.defaultRisk
  }
  return heuristicRiskLevel(action)
}

/** provider 风险分层读取（声明目录命中时返回 S1/S2，否则 undefined）。 */
export function riskTierOf(service: unknown): RiskTier | undefined {
  const svc = String(service ?? '').trim()
  return svc ? RISK_OVERRIDES[svc]?.riskTier : undefined
}
