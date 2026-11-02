/**
 * 前端 i18n 运行时（UI 全球化，2026-10-16 批次）——控制台与面板共用同一套引擎。
 *
 * 设计：
 *   - 语言偏好 localStorage `rq_lang`（'auto' 默认 = 跟随浏览器 Accept-Language 语义）；
 *   - 词典单请求取自 `GET <MOUNT>/locales/:locale`（服务端三层合并：服务端文案 + 控制台 SPA + 面板 SPA），
 *     **键 = 中文原文**；`zh-CN` 不取词典不跑翻译（原生界面零开销）；
 *   - DOM 级翻译引擎：MutationObserver 监听新增节点/文本变更，对文本节点与
 *     placeholder/title/aria-label 属性做**整词精确匹配**替换——SPA 任何渲染路径
 *     （含 API 返回的中文错误消息）无需逐点改造即被覆盖；模板里拼接出的动态文案
 *     由页面代码用 `rqI18n.t('共 {n} 条', { n })` 显式翻译；
 *   - 切换器注入顶栏（.topbar-right，缺顶栏的登录面退化为右下角浮球），切换即整页刷新；
 *   - 协议口径：rq_lang 为新增浏览器存储键（ASCII，登记协议键对照表）；其余契约不变。
 *
 * 该文件被 console 与 panel 两份 index.html 引用（拷贝部署，无构建步骤，保持零构建基线）。
 */

const PREF_KEY = 'rq_lang'
const SUPPORTED = ['zh-CN', 'en-US', 'ja-JP']
const NATIVE_NAMES = { 'zh-CN': '简体中文', 'en-US': 'English (US)', 'ja-JP': '日本語' }

/** 部署前缀推导（与 console api.js 同法；panel 拷贝版由下方 deriveMount 修正 /panel 段）。 */
function deriveMount() {
  let path = new URL('.', document.baseURI).pathname
  if (/\/panel\/?$/.test(path)) path = path.replace(/\/panel\/?$/, '/')
  return path.replace(/\/$/, '')
}

const MOUNT = deriveMount()

function prefOf() {
  try { return localStorage.getItem(PREF_KEY) || 'auto' } catch { return 'auto' }
}

function normalize(tag) {
  const lower = String(tag || '').toLowerCase()
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh-CN'
  if (lower === 'en' || lower.startsWith('en-')) return 'en-US'
  if (lower === 'ja' || lower.startsWith('ja-')) return 'ja-JP'
  return null
}

/** 生效语言：偏好 > 浏览器语言 > zh-CN。 */
function effectiveLocale() {
  const pref = prefOf()
  if (pref !== 'auto') return normalize(pref) || 'zh-CN'
  for (const tag of (navigator.languages || [navigator.language || 'zh'])) {
    const hit = normalize(tag)
    if (hit) return hit
  }
  return 'zh-CN'
}

const state = { locale: 'zh-CN', dict: {} }

function interpolate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/** 翻译一条文案（词典未命中回退中文原文；zh 语言恒原样）。 */
function t(zhText, params) {
  if (state.locale === 'zh-CN') return interpolate(zhText, params)
  const hit = state.dict[zhText]
  return interpolate(hit != null ? hit : zhText, params)
}

async function loadLocale(locale) {
  state.locale = locale
  if (locale === 'zh-CN') { state.dict = {}; return }
  try {
    const response = await fetch(`${MOUNT}/locales/${encodeURIComponent(locale)}`, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`locales ${response.status}`)
    const payload = await response.json()
    // 端点走标准信封 { ok, data: { locale, count, catalog } }——catalog 在 data 之下
    state.dict = (payload && payload.data && payload.data.catalog) || {}
  } catch {
    state.dict = {} // 词典获取失败=回退中文显示，不阻断页面
  }
}

// ------------------------------------------------------------------ DOM 翻译引擎

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'NOSCRIPT', 'SVG'])
const ATTRS = ['placeholder', 'title', 'aria-label']

function translateElementAttributes(el) {
  for (const name of ATTRS) {
    const value = el.getAttribute && el.getAttribute(name)
    if (!value) continue
    const key = value.trim()
    const hit = state.dict[key]
    if (hit != null && hit !== value) el.setAttribute(name, hit)
  }
}

function translateTextNode(node) {
  const text = node.nodeValue
  if (!text) return
  const key = text.trim()
  if (key === '') return
  const hit = state.dict[key]
  if (hit != null && hit !== text) node.nodeValue = hit
}

function translateSubtree(root) {
  if (state.locale === 'zh-CN') return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
      if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT
      return node.nodeType === Node.ELEMENT_NODE ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT
    },
  })
  // 先收集后处理（walker 过程中改 nodeValue 会干扰遍历）
  const texts = []
  const els = []
  let current = walker.nextNode()
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) texts.push(current)
    else els.push(current)
    current = walker.nextNode()
  }
  for (const node of texts) translateTextNode(node)
  for (const el of els) translateElementAttributes(el)
}

let pending = null
const observer = new MutationObserver((mutations) => {
  if (state.locale === 'zh-CN') return
  if (pending) return
  pending = queueMicrotask(() => {
    pending = null
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') translateTextNode(mutation.target)
      else for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) translateTextNode(node)
        else if (node.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(node.tagName)) {
          translateSubtree(node)
          translateElementAttributes(node)
        }
      }
    }
  })
})

function startObserver() {
  if (state.locale === 'zh-CN') return
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}

// ------------------------------------------------------------------ 语言切换器

const SWITCHER_STYLE = ''
  + '.rq-lang-select{height:28px;margin-right:6px;border:1px solid rgba(127,127,127,.35);'
  + 'border-radius:6px;background:transparent;color:inherit;font-size:12px;padding:0 4px;cursor:pointer}'
  + '.rq-lang-fab{position:fixed;right:14px;bottom:14px;z-index:99999;height:32px;'
  + 'border:1px solid rgba(127,127,127,.35);border-radius:16px;background:#fff;color:#1f2328;'
  + 'font-size:12px;padding:0 10px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15)}'

function buildSelect(className) {
  const select = document.createElement('select')
  select.className = className
  select.setAttribute('aria-label', 'Language / 语言')
  const current = prefOf()
  const options = [['auto', '语言 · Auto'], ['zh-CN', NATIVE_NAMES['zh-CN']], ['en-US', NATIVE_NAMES['en-US']], ['ja-JP', NATIVE_NAMES['ja-JP']]]
  for (const [value, label] of options) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    if (value === current) option.selected = true
    select.appendChild(option)
  }
  select.addEventListener('change', () => {
    try { localStorage.setItem(PREF_KEY, select.value) } catch { /* 隐私模式忽略 */ }
    window.location.reload()
  })
  return select
}

/** 顶栏挂载（每 400ms 重试至多 25 次，覆盖 SPA 异步渲染；失败退化右下角浮球）。 */
function mountSwitcher(attempt = 0) {
  const host = document.querySelector('.topbar-right') || document.querySelector('.ice-lang-host')
  const existing = document.getElementById('rq-lang-switcher')
  if (existing) {
    if (host && existing.parentElement !== host) {
      existing.className = 'rq-lang-select'
      host.insertBefore(existing, host.firstChild)
    }
    return
  }
  const select = buildSelect('rq-lang-select')
  select.id = 'rq-lang-switcher'
  if (host) {
    host.insertBefore(select, host.firstChild)
    return
  }
  if (attempt < 25) { setTimeout(() => mountSwitcher(attempt + 1), 400); return }
  select.className = 'rq-lang-fab'
  document.body.appendChild(select)
}

// ------------------------------------------------------------------ 启动

async function boot() {
  const style = document.createElement('style')
  style.textContent = SWITCHER_STYLE
  document.head.appendChild(style)

  state.locale = effectiveLocale()
  await loadLocale(state.locale)
  document.documentElement.lang = state.locale
  if (state.locale !== 'zh-CN') {
    const run = () => { translateSubtree(document.body); startObserver() }
    if (document.body) run()
    else document.addEventListener('DOMContentLoaded', run, { once: true })
  }
  const mount = () => mountSwitcher()
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
}

const api = { t, get lang() { return state.locale }, setLang(value) { try { localStorage.setItem(PREF_KEY, value) } catch {} window.location.reload() }, mountSwitcher() { mountSwitcher(25) }, supported: SUPPORTED, names: NATIVE_NAMES }
window.rqI18n = api
boot()
export default api
