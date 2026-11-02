/**
 * platform-i18n —— 平台多语言内核（UI 全球化，2026-10-16 批次）。
 *
 * 职责（单一，可被任何插件 / CLI / 前端词典管线复用）：
 *   - locale 解析与降级链：请求 ?lang= > Cookie rq_lang > Accept-Language > PLATFORM_LOCALE > zh-CN
 *   - 词典加载：locales/<locale>/*.json 按文件名序浅合并（多团队分文件并行维护，互不覆盖）；
 *     I18N_EXTRA_DIR/<locale>/*.json 为企业定制覆盖层（同键后者胜），支持私有化部署本地化话术
 *   - t()：以**中文原文为键**的翻译查询（zh-CN 原样返回 ⇒ 既有 selftest 断言零影响）；
 *     未命中词典降级回中文原文（词典可增量补齐，运行永不因缺翻译而炸）
 *   - {name} 插值 + Intl 日期/数字本地化
 *
 * 协议口径（R10 兼容）：新增 ASCII 协议键——?lang= 查询参数、Cookie rq_lang、
 * 环境变量 PLATFORM_LOCALE / DSHCTL_LANG / I18N_EXTRA_DIR；事件名、权限点、错误原因码、
 * API 信封字段（ok/data/error）一律不变。协议键中文释义见 docs/协议键中文对照总表.md。
 *
 * 线程模型：HTTP 分发层（platform-core/src/http.ts dispatch）以 AsyncLocalStorage
 * 为每个请求建立 locale 上下文，任意深度的路由/服务代码直接调 t() 即得当前请求语言；
 * 非 HTTP 上下文（定时任务/事件消费/CLI）取 PLATFORM_LOCALE（CLI 另有 DSHCTL_LANG）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'

/** 支持的语言（UI 全球化第一批：简体中文默认 + 英语 + 日语；扩展新语言 = 加目录 + 加映射）。 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US', 'ja-JP'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** 各语言的 Intl tag 与展示名（切换器直接消费，避免前端再维护一份）。 */
export const LOCALE_DISPLAY_NAMES: Record<Locale, { native: string; en: string; intl: string }> = {
  'zh-CN': { native: '简体中文', en: 'Simplified Chinese', intl: 'zh-CN' },
  'en-US': { native: 'English (US)', en: 'English (US)', intl: 'en-US' },
  'ja-JP': { native: '日本語', en: 'Japanese', intl: 'ja-JP' },
}

const LANG_PREFIX_MAP: Array<{ prefix: string; locale: Locale }> = [
  { prefix: 'zh', locale: 'zh-CN' },
  { prefix: 'en', locale: 'en-US' },
  { prefix: 'ja', locale: 'ja-JP' },
]

/** BCP47 宽容归一：'en'/'en-GB' → en-US，'ja' → ja-JP，'zh'/'zh-SG' → zh-CN；不支持返回 null。 */
export function normalizeLocale(input?: string | null): Locale | null {
  if (!input) return null
  const lower = String(input).trim().toLowerCase()
  if (lower === '') return null
  for (const { prefix, locale } of LANG_PREFIX_MAP) {
    if (lower === prefix || lower.startsWith(`${prefix}-`)) return locale
  }
  return null
}

/** Cookie 头解析（IncomingMessage.headers.cookie 可能为 string | string[] | undefined）。 */
export function parseCookieHeader(header?: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const pair of String(raw).split(';')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq).trim()
    if (key !== '') out[key] = decodeURIComponent(pair.slice(eq + 1).trim())
  }
  return out
}

/** Accept-Language 头解析：按 q 值降序返回语言标签（非法片段忽略）。 */
export function parseAcceptLanguage(header?: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : header
  if (!raw) return []
  return String(raw)
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';')
      let q = 1
      for (const param of params) {
        const match = /q\s*=\s*([\d.]+)/.exec(param)
        if (match) q = Number(match[1])
      }
      return { tag: (tag ?? '').trim(), q: Number.isFinite(q) ? q : 0 }
    })
    .filter((item) => item.tag !== '' && item.tag !== '*')
    .sort((a, b) => b.q - a.q)
    .map((item) => item.tag)
}

export interface ResolveLocaleInput {
  query?: string | null
  cookie?: string | null
  acceptLanguage?: string | null
  env?: string | null
}

/**
 * locale 决议（纯函数，selftest 直测）。优先级：显式 query > 用户 Cookie >
 * 浏览器语言 > 安装级环境变量 > zh-CN。任何一级不支持即落入下一级。
 */
export function resolveRequestLocale(input: ResolveLocaleInput): Locale {
  return normalizeLocale(input.query)
    ?? normalizeLocale(input.cookie)
    ?? parseAcceptLanguage(input.acceptLanguage)
      .map((tag) => normalizeLocale(tag))
      .find((locale): locale is Locale => locale !== null)
    ?? normalizeLocale(input.env)
    ?? DEFAULT_LOCALE
}

// ------------------------------------------------------------------ 词典加载

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 词典缓存：locale → 合并视图（进程内一次性加载；I18N_EXTRA_DIR 变更需重启，与其它 env 同口径）。 */
const catalogCache = new Map<Locale, Record<string, string>>()

/** 读取单个词典目录（<dir>/*.json 按文件名序浅合并）。控制台 /locales 合并端点与 CLI 复用。 */
export function readCatalogDir(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {}
  const merged: Record<string, string> = {}
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  for (const name of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') merged[key] = value
      }
    } catch {
      // 单个词典文件损坏不拖垮启动：跳过（fail-soft，等价缺翻译降级中文）
    }
  }
  return merged
}

/** 合并指定 locale 的全部词典层：内核目录（多文件按名序）+ 企业定制覆盖层（I18N_EXTRA_DIR）。 */
export function localeCatalog(locale: Locale): Record<string, string> {
  const cached = catalogCache.get(locale)
  if (cached) return cached
  const merged = readCatalogDir(join(PACKAGE_ROOT, 'locales', locale))
  const extraRoot = process.env.I18N_EXTRA_DIR ?? ''
  if (extraRoot !== '') Object.assign(merged, readCatalogDir(join(extraRoot, locale)))
  catalogCache.set(locale, merged)
  return merged
}

// ------------------------------------------------------------------ 请求级 locale 上下文

const requestLocaleStorage = new AsyncLocalStorage<Locale>()

/** 安装级默认语言（PLATFORM_LOCALE，默认 zh-CN）：非 HTTP 上下文（定时任务/事件消费）的 t() 语言。 */
export function installLocale(): Locale {
  return normalizeLocale(process.env.PLATFORM_LOCALE) ?? DEFAULT_LOCALE
}

/** 当前生效语言：请求上下文 > PLATFORM_LOCALE > zh-CN。 */
export function currentLocale(): Locale {
  return requestLocaleStorage.getStore() ?? installLocale()
}

/** 在指定语言上下文中执行 fn（HTTP 分发层包裹整个中间件+处理器链；测试亦直接使用）。 */
export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return requestLocaleStorage.run(locale, fn)
}

// ------------------------------------------------------------------ t() 与插值

const INTERP = /\{(\w+)\}/g

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(INTERP, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/**
 * 翻译当前上下文的一条文案：中文原文为键，命中词典返回译文，未命中原样返回中文
 * （词典增量补齐，运行永不因缺翻译失败）；两种语言都执行 {name} 插值。
 */
export function t(zhText: string, params?: Record<string, string | number>): string {
  const locale = currentLocale()
  if (locale === DEFAULT_LOCALE) return interpolate(zhText, params)
  const translated = localeCatalog(locale)[zhText]
  return interpolate(translated ?? zhText, params)
}

/** 显式指定语言的 t()（事件消费侧按「事件产生时语言」或收件人偏好回放文案时使用）。 */
export function tIn(locale: Locale, zhText: string, params?: Record<string, string | number>): string {
  if (locale === DEFAULT_LOCALE) return interpolate(zhText, params)
  const translated = localeCatalog(locale)[zhText]
  return interpolate(translated ?? zhText, params)
}

// ------------------------------------------------------------------ Intl 本地化

/** 日期时间本地化（默认 medium 日期 + medium 时间；技术上下文请继续用 ISO 8601 原文）。 */
export function formatDateValue(value: string | number | Date, locale?: Locale, opts?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const tag = LOCALE_DISPLAY_NAMES[locale ?? currentLocale()].intl
  return new Intl.DateTimeFormat(tag, opts ?? { dateStyle: 'medium', timeStyle: 'medium' }).format(date)
}

/** 数字本地化（千分位/小数点随语言；百分比/金额语义由调用方给 Intl opts）。 */
export function formatNumberValue(value: number, locale?: Locale, opts?: Intl.NumberFormatOptions): string {
  const tag = LOCALE_DISPLAY_NAMES[locale ?? currentLocale()].intl
  return new Intl.NumberFormat(tag, opts).format(value)
}
