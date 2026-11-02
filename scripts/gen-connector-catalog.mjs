/**
 * 连接器风险目录生成与校验（R6：声明式化，吸收 paperclip app-definitions 模式）。
 *
 * 事实源：packages/plugin-connector/catalog/risk-overrides.json（声明式目录）
 * 生成物：packages/plugin-connector/src/risk-overrides.generated.ts（入库，勿手改）
 *
 * 流程：读声明 → 校验 schema → 键排序生成 TS 常量（幂等：重复跑输出字节级稳定）。
 * 校验规则：
 *   - 风险值 ∈ {read,write,admin}；tier ∈ {S1,S2}
 *   - provider 名满足 [a-z0-9-]+；action id 非空
 *   - defaultRisk 必填
 *   - actions 声明与 defaultRisk 相同值 → 警告不挡（无意义重复）
 *
 * 用法：node scripts/gen-connector-catalog.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DECL_PATH = join(ROOT, 'packages', 'plugin-connector', 'catalog', 'risk-overrides.json')
const OUT_PATH = join(ROOT, 'packages', 'plugin-connector', 'src', 'risk-overrides.generated.ts')

const RISK_LEVELS = new Set(['read', 'write', 'admin'])
const RISK_TIERS = new Set(['S1', 'S2'])
const PROVIDER_NAME = /^[a-z0-9-]+$/
const ACTION_ID = /^.+$/

const errors = []
const warnings = []
const fail = (message) => errors.push(message)
const warn = (message) => warnings.push(message)

// -- 读取与顶层结构 -----------------------------------------------------------

let declaration
try {
  declaration = JSON.parse(readFileSync(DECL_PATH, 'utf8'))
} catch (error) {
  console.error(`读取/解析声明失败：${DECL_PATH}\n${error}`)
  process.exit(1)
}
if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
  console.error('声明顶层必须是对象')
  process.exit(1)
}
if (typeof declaration.$comment !== 'string' || declaration.$comment.length === 0) {
  fail('顶层 $comment 必须是非空字符串（riskTier 语义与审批联动边界写明于此）')
}
const providers = declaration.providers
if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
  fail('顶层 providers 必须是对象')
}

// -- 逐 provider / action 校验 ------------------------------------------------

if (typeof providers === 'object' && providers !== null) {
  for (const [service, entry] of Object.entries(providers)) {
    if (!PROVIDER_NAME.test(service)) fail(`provider 名非法（须满足 ${PROVIDER_NAME.source}）：${service}`)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`providers.${service} 必须是对象`)
      continue
    }
    const { defaultRisk, riskTier, actions } = entry
    if (!RISK_LEVELS.has(defaultRisk)) fail(`providers.${service}.defaultRisk 非法（read|write|admin 且必填）：${JSON.stringify(defaultRisk)}`)
    if (!RISK_TIERS.has(riskTier)) fail(`providers.${service}.riskTier 非法（S1|S2 且必填）：${JSON.stringify(riskTier)}`)
    if (actions === undefined) {
      warn(`providers.${service} 无 actions 声明（仅 defaultRisk 兜底，若有意可为空对象显式声明）`)
      continue
    }
    if (typeof actions !== 'object' || actions === null || Array.isArray(actions)) {
      fail(`providers.${service}.actions 必须是对象`)
      continue
    }
    for (const [actionId, level] of Object.entries(actions)) {
      if (typeof actionId !== 'string' || !ACTION_ID.test(actionId)) fail(`providers.${service}.actions 存在空 action id：${JSON.stringify(actionId)}`)
      if (!RISK_LEVELS.has(level)) fail(`providers.${service}.actions.${actionId} 风险级非法（read|write|admin）：${JSON.stringify(level)}`)
      if (level === defaultRisk) warn(`providers.${service}.actions.${actionId} 与 defaultRisk 同值（无意义重复，可删除该条）：${level}`)
    }
  }
}

if (errors.length > 0) {
  console.error(`声明校验失败（${errors.length} 项）：`)
  for (const message of errors) console.error(`  ✗ ${message}`)
  process.exit(1)
}
for (const message of warnings) console.warn(`  ⚠ ${message}`)

// -- 排序序列化（幂等：键全序排序，输出字节级稳定） -------------------------------

const sorted = (object) => {
  if (Array.isArray(object)) return object.map(sorted)
  if (typeof object === 'object' && object !== null) {
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sorted(object[key])]))
  }
  return object
}

const providerCount = Object.keys(providers).length
const actionCount = Object.values(providers).reduce((sum, entry) => sum + Object.keys(entry.actions ?? {}).length, 0)
const body = JSON.stringify(sorted(providers), null, 2)
const output = `/**
 * 连接器风险目录覆盖常量（R6 声明式化——吸收 paperclip app-definitions 声明式目录模式）。
 *
 * ⚠️ 本文件由 scripts/gen-connector-catalog.mjs 自动生成，勿手改——
 *    事实源：packages/plugin-connector/catalog/risk-overrides.json
 *    重新生成：node scripts/gen-connector-catalog.mjs
 *
 * 优先级（resolveRiskLevel）：action 自带 riskLevel > 本目录 actions 声明 >
 * provider defaultRisk > heuristicRiskLevel 启发式兜底（fail-closed 默认 admin）。
 * riskTier（S1/S2）本迭代仅作声明与展示，审批联动后续迭代。
 */
import type { RiskOverrides } from './risk.ts'

export const RISK_OVERRIDES: RiskOverrides = ${body}
`

writeFileSync(OUT_PATH, output, 'utf8')
console.log(`risk-overrides ✓ providers=${providerCount} actions=${actionCount} → ${OUT_PATH.replace(ROOT + '/', '')}${warnings.length > 0 ? `（警告 ${warnings.length} 项）` : ''}`)
