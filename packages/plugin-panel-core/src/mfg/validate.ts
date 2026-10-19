/**
 * 制造工具箱 —— 执行期输入/输出校验（自「制造业 AI 工具集」zod Schema 等价改写）。
 *
 * 为什么手写而不引 zod：01门随附包在安装形态下零 TS 装载、零构建依赖，dist 为
 * 预构建纯 JS 镜像（scripts/build-dist.mjs 逐文件转译，不做模块解析）——引入新运行期
 * 依赖会同时破坏装机闭包与 build-id 语义。本文件以等价语义覆盖源项目仅用的三个能力面：
 *   - 数值：有限、上下界；
 *   - 字符串：trim 后非空、长度上限；
 *   - 对象：strict（未知字段一律拒绝——源项目「拒绝多余参数」断言依赖此语义）。
 *
 * 错误一律走 MfgError（与源项目 ToolError 同形：code/message/status）。
 */

export class MfgError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'MfgError'
    this.code = code
    this.status = status
  }
}

export const fail = (code: string, message: string, status = 400): never => {
  throw new MfgError(code, message, status)
}

export const requireCondition = (ok: boolean, message: string, code = 'INVALID_INPUT'): void => {
  if (!ok) fail(code, message)
}

/** 字段值上限：与源项目一致（16k 字符，防超长文本灌入模型）。 */
export const TEXT_MAX = 16000

/** 数值字段校验：有限 + 上下界（缺省下界 0 由字段定义给出）。 */
export function checkNumber(value: unknown, label: string, min?: number, max?: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (typeof value === 'boolean' || value === null || value === undefined || value === '' || !Number.isFinite(num)) {
    fail('INVALID_INPUT', `${label}必须是有限数字`)
  }
  if (min !== undefined && num < min) fail('INVALID_INPUT', `${label}不能小于 ${min}`)
  if (max !== undefined && num > max) fail('INVALID_INPUT', `${label}不能大于 ${max}`)
  return num
}

/** 文本字段校验：trim 后非空 + 长度上限。 */
export function checkText(value: unknown, label: string, max = TEXT_MAX): string {
  if (typeof value !== 'string') fail('INVALID_INPUT', `${label}不能为空`)
  const text = value.trim()
  if (text === '') fail('INVALID_INPUT', `${label}不能为空`)
  if (text.length > max) fail('INVALID_INPUT', `${label}长度超过 ${max} 字符`)
  return text
}

/** 整数校验（安全整数域：跨字段运算不溢出）。 */
export function checkInteger(value: unknown, label: string): number {
  const num = checkNumber(value, label)
  if (!Number.isSafeInteger(num)) fail('INVALID_INPUT', `${label}须为安全范围内的整数`)
  return num
}

/**
 * strict 对象校验：未知字段一律拒绝（源项目「注入字段被拒」断言的语义基础）。
 * 返回按声明字段重建的干净对象——调用方拿不到原始对象，杜绝旁路字段透传。
 */
export function checkStrictObject<T extends Record<string, unknown>>(
  raw: unknown,
  keys: readonly string[],
  validate: (key: string, value: unknown) => unknown,
): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_INPUT', '输入必须是对象')
  const source = raw as Record<string, unknown>
  const allowed = new Set(keys)
  for (const key of Object.keys(source)) {
    if (!allowed.has(key) && key !== '_protocol') fail('INVALID_INPUT', `输入包含未知字段：${key}`)
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = validate(key, source[key])
  return out as T
}

// ---------------------------------------------------------------------------
// 模型输出协议校验（源项目 modelOutputSchema 等价改写）
// ---------------------------------------------------------------------------

export type ModelSection = { title: string; content: string; evidence: string[] }
export type ModelOutput = { sections: ModelSection[]; missingInformation: string[] }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * 校验模型返回的 JSON 结构。任一违规抛出 MfgError('QUALITY_SCHEMA')——
 * 与源项目一致：不合格输出按错误交付，绝不降级当成功结果。
 */
export function checkModelOutputSchema(raw: unknown): ModelOutput {
  if (!isPlainObject(raw)) fail('QUALITY_SCHEMA', '模型输出未通过结构校验，本次结果未交付。', 502)
  const sectionsRaw = raw.sections
  const missingRaw = raw.missingInformation
  if (!Array.isArray(sectionsRaw) || sectionsRaw.length < 1 || sectionsRaw.length > 12) {
    fail('QUALITY_SCHEMA', '模型输出未通过结构校验，本次结果未交付。', 502)
  }
  if (!Array.isArray(missingRaw) || missingRaw.length > 30) {
    fail('QUALITY_SCHEMA', '模型输出未通过结构校验，本次结果未交付。', 502)
  }
  const sections: ModelSection[] = sectionsRaw.map((item) => {
    if (!isPlainObject(item)) fail('QUALITY_SCHEMA', '模型输出未通过结构校验，本次结果未交付。', 502)
    const title = item.title
    const content = item.content
    const evidence = item.evidence
    if (typeof title !== 'string' || title.length < 1 || title.length > 100) fail('QUALITY_SCHEMA', '模型输出未通过结构校验，本次结果未交付。', 502)
    if (typeof content !== 'string' || content.length < 1 || content.length > 12000) fail('QUALITY_SCHEMA', '模型输出未通过结构校验，本次结果未交付。', 502)
    if (!Array.isArray(evidence) || evidence.length > 20) fail('QUALITY_SCHEMA', '模型输出未通过结构校验，本次结果未交付。', 502)
    const quotes: string[] = evidence.map((quote) => {
      if (typeof quote !== 'string' || quote.length < 1 || quote.length > 1000) fail('QUALITY_SCHEMA', '模型输出未通过结构校验，本次结果未交付。', 502)
      return quote
    })
    return { title, content, evidence: quotes }
  })
  const missingInformation: string[] = missingRaw.map((item) => {
    if (typeof item !== 'string' || item.length < 1 || item.length > 1000) fail('QUALITY_SCHEMA', '模型输出未通过结构校验，本次结果未交付。', 502)
    return item
  })
  return { sections, missingInformation }
}