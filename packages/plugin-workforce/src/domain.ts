/**
 * 数字员工域纯策略层（domain）—— 无 IO、无时钟副作用、无数据库。
 *
 * 分层纪律与 plugin-exec-hub/src/domain.ts 同源（Paperclip 决策/IO 分离）：
 *   - 这里只放状态机转换表、密级策略、规范化摘要、stepKey 校验与最小 JSON Schema 校验器；
 *   - 任何「读库 / 读时钟 / 发事件」一律留在服务层（employee/appointment/identity），
 *     把事实（facts）算好再喂进来；
 *   - 本文件供全部工作组消费（准入、permit、调用账本、交付验收均可复用），不 import 本插件任何服务。
 *
 * 蓝本依据：《数字员工与平台资源调用-技术关联与施工实施路径》2026-10-15
 *   §D.4（任用授权生效状态机）、§9.3（stepKey 与参数摘要）、§D14（统一业务密级）、§11.5（幂等规则）。
 */
import { sha256Hex } from '../../platform-core/src/ids.ts'
import { WORK_DATA_CLASS_ORDER, type WorkDataClass } from '../../platform-core/src/workforce-port.ts'
import { STEP_KEY_PATTERN, WorkforceError } from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type {
  AppointmentRecord,
  AppointmentStatus,
  DeliverableStatus,
  EmployeeStatus,
  GrantStatus,
  InvocationStatus,
  PermitStatus,
  ResourceGrantSpec,
} from './contract.ts'

// ---------------------------------------------------------------------------
// 统一业务密级（D14）：全平台工作面唯一口径，到旧协议的映射必须显式完成
// ---------------------------------------------------------------------------

/** 业务密级全集（自 workforce-port 的序表派生，避免两处清单漂移）。 */
export const WORK_DATA_CLASS_VALUES = Object.keys(WORK_DATA_CLASS_ORDER) as WorkDataClass[]

/** 校验并归一业务密级（任用登记 / 请求参数口用）。非法值抛中文错误。 */
export function validateWorkDataClass(value: unknown): WorkDataClass {
  if (typeof value === 'string' && Object.hasOwn(WORK_DATA_CLASS_ORDER, value)) return value as WorkDataClass
  throw new Error(t('数据密级不合法：{value}（允许：{allowed}）', { value: String(value), allowed: WORK_DATA_CLASS_VALUES.join('/') }))
}

/**
 * 生效密级 = max(请求方声明的密级, 任用冻结的密级上限)（§4.1 改造点：
 * 密级从可信任务/数据策略推导，不信任运行时自行降低 dataClass）。
 * 未声明时回落任用冻结值——「未声明」不等于「公开」。
 */
export function effectiveDataClass(requested: WorkDataClass | undefined, appointment: WorkDataClass): WorkDataClass {
  if (requested === undefined) return appointment
  return WORK_DATA_CLASS_ORDER[requested] >= WORK_DATA_CLASS_ORDER[appointment] ? requested : appointment
}

/** 绝密禁止数字员工处理：模型/资源调用前直接拒绝（禁止映射成可用高等级渠道，D14）。 */
export function assertAgentAllowedDataClass(dataClass: WorkDataClass): void {
  if (dataClass === 'topsecret') {
    throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('绝密数据禁止数字员工处理'))
  }
}

/**
 * 业务密级 → modelgw 渠道分级标签（显式映射表，禁止静默回落 internal）。
 *
 * modelgw 的 DataClass 只有 public/internal/secret 三级（plugin-modelgw/src/index.ts）：
 *   - public/internal/secret 与本口径同名同级（本口径 secret=「秘密」，与 modelgw secret 一致）；
 *   - confidential（机密）：Agent 处理需审批，渠道分级无法表达 → 返回 null 由调用方拒绝；
 *   - topsecret（绝密）：本就不允许 Agent 处理（assertAgentAllowedDataClass 已挡）→ 返回 null。
 * 映射不到返回 null，由调用方显式拒绝——绝不悄悄降级为 internal（验收 V14/蓝本 §4.1）。
 */
export function mapWorkDataClassToChannel(dataClass: WorkDataClass): 'public' | 'internal' | 'secret' | null {
  const table: Record<WorkDataClass, 'public' | 'internal' | 'secret' | null> = {
    public: 'public',
    internal: 'internal',
    secret: 'secret',
    confidential: null, // 机密：Agent 处理需审批，modelgw 渠道分级无此级，映射不到＝拒绝
    topsecret: null, // 绝密：禁止 Agent 处理，不映射
  }
  return table[dataClass] ?? null
}

// ---------------------------------------------------------------------------
// 状态机（§D.4 / §11.6）：显式转换表 + 断言函数（非法流转抛中文错误）
// ---------------------------------------------------------------------------

export const EMPLOYEE_STATUS_LABELS: Record<EmployeeStatus, string> = { active: '在岗', suspended: '停职', offboarded: '离岗' }
export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  preparing: '准备中', effective: '生效', revoking: '撤销中', revoked: '已撤销', failed: '配置失败',
}
export const GRANT_STATUS_LABELS: Record<GrantStatus, string> = APPOINTMENT_STATUS_LABELS
export const PERMIT_STATUS_LABELS: Record<PermitStatus, string> = { active: '有效', revoked: '已撤销', expired: '已过期' }
export const INVOCATION_STATUS_LABELS: Record<InvocationStatus, string> = {
  reserved: '已预留', completed: '已完成', denied: '已拒绝', approval_required: '待审批',
  rate_limited: '命中限流', failed: '失败', outcome_unknown: '结果未知', cancelled: '已取消',
}
export const DELIVERABLE_STATUS_LABELS: Record<DeliverableStatus, string> = { submitted: '已提交', accepted: '已验收', rejected: '已退回' }

/** 员工状态：active→suspended/offboarded；suspended→active（复岗）/offboarded；offboarded 终态。 */
export const EMPLOYEE_TRANSITIONS: Record<EmployeeStatus, EmployeeStatus[]> = {
  active: ['suspended', 'offboarded'],
  suspended: ['active', 'offboarded'],
  offboarded: [],
}

/**
 * 任用状态（§D.4）：preparing→effective（探针全过）/revoked（未生效直接撤）/failed（显式判失败）；
 * effective→revoking→revoked；revoking 是唯一可续办的中间态（部分撤权失败留此重试，D.4 第 5 条）；
 * failed 为终态（修正后开新版本，不改写历史）。
 */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  preparing: ['effective', 'revoked', 'failed'],
  effective: ['revoking'],
  revoking: ['revoked'],
  revoked: [],
  failed: [],
}

/** 资源授权状态：与任用同构；failed→preparing 允许重试激活（探针缺席/失败修复后重跑）。 */
export const GRANT_TRANSITIONS: Record<GrantStatus, GrantStatus[]> = {
  preparing: ['effective', 'failed', 'revoked'],
  effective: ['revoking'],
  revoking: ['revoked'],
  revoked: [],
  failed: ['preparing'],
}

/** 工作授权：active→revoked/expired；撤销/过期均终态（旧 permit 一律不复活，V07）。 */
export const PERMIT_TRANSITIONS: Record<PermitStatus, PermitStatus[]> = {
  active: ['revoked', 'expired'],
  revoked: [],
  expired: [],
}

/**
 * 调用状态（§9.3）：reserved 为唯一起点；approval_required/rate_limited/outcome_unknown
 * 是可收敛中间态（审批回写/重试收敛/人工核验回写）；其余为终态。
 * outcome_unknown 只允许 →completed/failed（reconcile 人工核验后），禁止直接重试写入（§11.5 第 4 条）。
 */
export const INVOCATION_TRANSITIONS: Record<InvocationStatus, InvocationStatus[]> = {
  reserved: ['completed', 'denied', 'approval_required', 'rate_limited', 'failed', 'outcome_unknown', 'cancelled'],
  approval_required: ['completed', 'denied', 'failed', 'cancelled'],
  rate_limited: ['completed', 'failed', 'cancelled'],
  outcome_unknown: ['completed', 'failed'],
  completed: [],
  denied: [],
  failed: [],
  cancelled: [],
}

/** 交付物：submitted→accepted/rejected；rejected 终态（退回重做＝新版本新记录，§8.2 版本不合并）。 */
export const DELIVERABLE_TRANSITIONS: Record<DeliverableStatus, DeliverableStatus[]> = {
  submitted: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
}

function assertTransition(labels: Record<string, string>, table: Record<string, string[]>, from: string, to: string, subject: string): void {
  const fromLabel = t(labels[from] ?? from)
  const toLabel = t(labels[to] ?? to)
  if (from === to) throw new Error(t('{subject}状态未变化（当前已是「{current}」），无需重复操作', { subject, current: fromLabel }))
  const allowed = table[from] ?? []
  if (!allowed.includes(to)) {
    const hint = allowed.length > 0
      ? t('（允许：{allowed}）', { allowed: allowed.map((s) => t(labels[s] ?? s)).join('/') })
      : t('（终态，不可再流转）')
    throw new Error(t('{subject}状态不允许从「{from}」变更为「{to}」{hint}', { subject, from: fromLabel, to: toLabel, hint }))
  }
}

/** 员工状态流转断言：非法流转抛中文错误（由路由层 400）。 */
export function employeeStatusTransition(from: EmployeeStatus, to: EmployeeStatus): void {
  assertTransition(EMPLOYEE_STATUS_LABELS, EMPLOYEE_TRANSITIONS, from, to, t('员工'))
}

/** 任用状态流转断言。 */
export function appointmentStatusTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  assertTransition(APPOINTMENT_STATUS_LABELS, APPOINTMENT_TRANSITIONS, from, to, t('任用'))
}

/** 资源授权状态流转断言。 */
export function grantStatusTransition(from: GrantStatus, to: GrantStatus): void {
  assertTransition(GRANT_STATUS_LABELS, GRANT_TRANSITIONS, from, to, t('资源授权'))
}

/** 工作授权（permit）状态流转断言。 */
export function permitStatusTransition(from: PermitStatus, to: PermitStatus): void {
  assertTransition(PERMIT_STATUS_LABELS, PERMIT_TRANSITIONS, from, to, t('工作授权'))
}

/** 调用账本状态流转断言。 */
export function invocationStatusTransition(from: InvocationStatus, to: InvocationStatus): void {
  assertTransition(INVOCATION_STATUS_LABELS, INVOCATION_TRANSITIONS, from, to, t('工作调用'))
}

/** 交付物状态流转断言。 */
export function deliverableStatusTransition(from: DeliverableStatus, to: DeliverableStatus): void {
  assertTransition(DELIVERABLE_STATUS_LABELS, DELIVERABLE_TRANSITIONS, from, to, t('交付物'))
}

// ---------------------------------------------------------------------------
// 任用有效期窗口（appointmentInEffect）
// ---------------------------------------------------------------------------

function toMs(input: string | number | Date): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.getTime()
  const parsed = Date.parse(input)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * 任用是否处于生效窗口：status=effective 且 effectiveFrom ≤ now ≤ effectiveUntil（空串＝长期）。
 * 时间解析失败的窗口按「不生效」处理（fail-closed，诚实缺位）。
 */
export function appointmentInEffect(
  appt: Pick<AppointmentRecord, 'status' | 'effectiveFrom' | 'effectiveUntil'>,
  now: string | number | Date = new Date(),
): boolean {
  if (appt.status !== 'effective') return false
  const nowMs = toMs(now)
  if (nowMs === null) return false
  const fromMs = toMs(appt.effectiveFrom)
  if (fromMs === null || nowMs < fromMs) return false
  if (appt.effectiveUntil) {
    const untilMs = toMs(appt.effectiveUntil)
    if (untilMs === null || nowMs > untilMs) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 规范化 JSON 与参数摘要（§9.3 / §11.5）：键排序稳定序列化
// ---------------------------------------------------------------------------

/**
 * 规范化 JSON：对象键按字典序排序、剔除 undefined 值、定界符无空白——
 * 同一参数对象无论键序如何，摘要一致；不同参数摘要必不同（步骤冲突判定的基础）。
 * 仅接受 JSON 可表达数据（string/number/boolean/null/array/object），
 * function/symbol/bigint 等抛中文错误（参数摘要不可伪造确定性）。
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(',')}}`
  }
  throw new Error(t('参数含不可规范化数据（{type}），无法计算稳定摘要', { type: typeof value }))
}

/** 参数摘要：sha256(canonicalJson)。相同 stepKey 不同参数 → 摘要不同 → STEP_ARGUMENT_CONFLICT。 */
export function argsHashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

// ---------------------------------------------------------------------------
// stepKey 校验（§9.3）：调用方提出的业务步骤引用，不是可信身份
// ---------------------------------------------------------------------------

/**
 * stepKey 合法性：契约 STEP_KEY_PATTERN（1-96 位，字母开头，允许数字/点/下划线/连字符）。
 * 不合法抛 WorkforceError('ARGUMENT_SCOPE_DENIED')（与参数 Schema 校验不过同码，路由层映射 400）。
 */
export function assertValidStepKey(stepKey: string): void {
  if (typeof stepKey !== 'string' || !STEP_KEY_PATTERN.test(stepKey)) {
    throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('步骤键 stepKey 不合法：须为 1-96 位、字母开头，仅含字母/数字/点/下划线/连字符'))
  }
}

// ---------------------------------------------------------------------------
// 资源授权期望（ResourceGrantSpec）校验：任用登记口与适配器共用的最小结构约束
// ---------------------------------------------------------------------------

export const GRANT_KINDS = ['mcp', 'connector', 'model', 'skill', 'nas', 'app'] as const
export const GRANT_RISKS = ['read', 'write', 'admin'] as const

/** 校验并归一授权期望：kind/registryId/actions/risk 必备；写动作必须显式列入 actions（附录 A 决策 5）。 */
export function validateGrantSpec(input: unknown): ResourceGrantSpec {
  if (!input || typeof input !== 'object') throw new Error(t('资源授权项不合法：须为对象（kind/registryId/actions/risk）'))
  const spec = input as Record<string, unknown>
  const kind = spec['kind']
  if (typeof kind !== 'string' || !(GRANT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(t('资源授权项 kind 不合法：{kind}（允许：{allowed}）', { kind: String(kind), allowed: GRANT_KINDS.join('/') }))
  }
  const registryId = spec['registryId']
  if (typeof registryId !== 'string' || registryId.trim() === '') {
    throw new Error(t('资源授权项 registryId 不合法：须为非空资源登记 ID（mcp 服务/connector provider/模型 slug 等）'))
  }
  const rawActions = spec['actions']
  if (!Array.isArray(rawActions) || rawActions.length === 0 || rawActions.some((a) => typeof a !== 'string' || a.trim() === '')) {
    throw new Error(t('资源授权项 actions 不合法：须为非空动作数组（写动作必须显式列出，未知风险工具不得默认开放）'))
  }
  const risk = spec['risk']
  if (typeof risk !== 'string' || !(GRANT_RISKS as readonly string[]).includes(risk)) {
    throw new Error(t('资源授权项 risk 不合法：{risk}（允许：{allowed}）', { risk: String(risk), allowed: GRANT_RISKS.join('/') }))
  }
  const constraints = spec['constraints']
  if (constraints !== undefined && (typeof constraints !== 'object' || constraints === null || Array.isArray(constraints))) {
    throw new Error(t('资源授权项 constraints 不合法：须为对象（factoryIds/pathPrefixes/maxRows 等）'))
  }
  return {
    kind: kind as ResourceGrantSpec['kind'],
    registryId,
    actions: (rawActions as string[]).map((a) => a.trim()),
    risk: risk as ResourceGrantSpec['risk'],
    ...(constraints !== undefined ? { constraints: constraints as Record<string, unknown> } : {}),
  }
}

// ---------------------------------------------------------------------------
// 最小 JSON Schema 校验器（§9.2：服务端参数约束，校验不过＝ARGUMENT_SCOPE_DENIED）
// ---------------------------------------------------------------------------

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return jsonTypeOf(value) === 'object'
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false // 未知类型关键字一律不匹配（fail-closed）
  }
}

/**
 * 最小 JSON Schema 校验器（够用即可）：支持
 *   type（含数组）/ required / properties / additionalProperties:false / enum /
 *   items / maxRows（数组行数上限，契约 constraints 示例口径）/ minLength / maxLength / minimum / maximum。
 * 校验通过返回 null；不通过返回首条中文错误消息（带参数路径）。
 * 不支持的 Schema 关键字静默忽略——本函数只做「声明过的约束」，不冒充完整 JSON Schema。
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = '$',
): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null

  const type = schema['type']
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]
    if (!types.some((t) => matchesType(value, String(t)))) {
      return t('{path} 类型应为 {types}（实际为 {actual}）', { path, types: types.map(String).join(t(' 或 ')), actual: jsonTypeOf(value) })
    }
  }

  const allowedValues = schema['enum']
  if (Array.isArray(allowedValues)) {
    let matched = false
    try {
      const actual = canonicalJson(value)
      matched = allowedValues.some((candidate) => canonicalJson(candidate) === actual)
    } catch {
      matched = false
    }
    if (!matched) return t('{path} 取值不在允许范围内（{allowed}）', { path, allowed: allowedValues.map((v) => JSON.stringify(v)).join('/') })
  }

  if (jsonTypeOf(value) === 'object') {
    const obj = value as Record<string, unknown>
    const required = schema['required']
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in obj)) return t('{path} 缺少必填参数「{key}」', { path, key })
      }
    }
    const properties = schema['properties']
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      const propSchemas = properties as Record<string, Record<string, unknown>>
      if (schema['additionalProperties'] === false) {
        const unknownKey = Object.keys(obj).find((key) => !(key in propSchemas))
        if (unknownKey !== undefined) return t('{path} 不允许传入未声明的参数「{key}」', { path, key: unknownKey })
      }
      for (const [key, propSchema] of Object.entries(propSchemas)) {
        if (!(key in obj)) continue
        const error = validateAgainstSchema(obj[key], propSchema ?? {}, `${path}.${key}`)
        if (error) return error
      }
    }
  }

  if (Array.isArray(value)) {
    const items = schema['items']
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      for (let index = 0; index < value.length; index++) {
        const error = validateAgainstSchema(value[index], items as Record<string, unknown>, `${path}[${index}]`)
        if (error) return error
      }
    }
    const maxRows = schema['maxRows']
    if (typeof maxRows === 'number' && value.length > maxRows) {
      return t('{path} 行数 {count} 超出上限 {max}', { path, count: value.length, max: maxRows })
    }
  }

  if (typeof value === 'string') {
    const minLength = schema['minLength']
    if (typeof minLength === 'number' && value.length < minLength) return t('{path} 长度不得少于 {min}', { path, min: minLength })
    const maxLength = schema['maxLength']
    if (typeof maxLength === 'number' && value.length > maxLength) return t('{path} 长度不得超过 {max}', { path, max: maxLength })
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const minimum = schema['minimum']
    if (typeof minimum === 'number' && value < minimum) return t('{path} 不得小于 {min}', { path, min: minimum })
    const maximum = schema['maximum']
    if (typeof maximum === 'number' && value > maximum) return t('{path} 不得大于 {max}', { path, max: maximum })
  }

  return null
}
