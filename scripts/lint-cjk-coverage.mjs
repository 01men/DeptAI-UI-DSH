/**
 * 表现层汉化覆盖清点（R11，REFACTOR-2026-10-13，2026-10-13）。
 *
 * 目标：量化「用户可见面」的英文残留，建立汉化工作底册（阶段 2 逐项消灭，
 * 出口为命中数 0——白名单豁免项须登记销账条件）。
 *
 * 扫描面（阶段 0 口径）：
 *   - packages 下各插件的 public 目录内 .js 与 .html（console / panel-core / rq-card 前端）；
 *   - cli/dshctl.mjs（CLI 输出面）；
 *   - 通知/审批/邮件模板散布于各插件 TS 源码，全量扫误报率高，留待阶段 2
 *     按 R1 清单定向清点（取舍记录于 docs/internal/重构基线-阶段0-20261013.md）。
 *
 * 判定模型（三层过滤，只留「疑似用户可见英文」）：
 *   1. 字符串字面量（'…"…`…`）且所在行非注释；模板插值 ${…} 剥离后判定；
 *   2. 含中文 → 合格；纯标识符形态（无空格的 kebab/snake/camel、路径、
 *      URL、文件名、MIME 等）→ 按词白名单判定；
 *   3. 句式形态（含空格的英文短语）或白名单外 ≥4 字母英文词 → 命中。
 *   HTML 文件只扫标签间文本节点与 title/alt/placeholder/aria-label 属性。
 *
 * 白名单分两层：
 *   - 内置词表（本文件 TOKEN_WHITELIST）：协议词/品牌词/单位词/技术缩写/
 *     状态枚举（协议层保留 ASCII，阶段 2 补 labelZh 中文伴随字段）；
 *   - 豁免登记 scripts/lint-cjk-coverage.exemptions.json（kind::key 机制，
 *     key = 「文件::字面量」；每条必须写明销账条件，阶段 2 消灭后移除）。
 *
 * 用法：
 *   node scripts/lint-cjk-coverage.mjs            # 报告模式（exit 0，产出底册）
 *   node scripts/lint-cjk-coverage.mjs --strict   # 门禁模式（存在未豁免命中即 exit 1）
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * 内置词白名单：这些英文词允许出现在用户可见面（协议/品牌/单位/技术缩写/枚举）。
 * 阶段 2 收紧口径时从本表移除并改造为中文伴随字段。
 */
const TOKEN_WHITELIST = new Set([
  // HTTP / 协议
  'HTTP', 'HTTPS', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  'content', 'type', 'application', 'json', 'text', 'plain', 'Bearer', 'Authorization',
  'token', 'Token', 'refresh', 'session', 'cookie', 'multipart', 'form', 'data',
  'charset', 'utf', 'localhost', 'origin', 'referer', 'scheme', 'query', 'fragment',
  // 格式 / 缩写
  'API', 'URL', 'URI', 'JSON', 'CSV', 'HTML', 'CSS', 'DOM', 'SDK', 'CLI', 'UI', 'UX',
  'MIME', 'BASE64', 'HMAC', 'SHA', 'MD5', 'UUID', 'QPS', 'SLA', 'CSV', 'YAML',
  'OpenAPI', 'OAuth', 'OIDC', 'SAML', 'SSO', 'JWT', 'JWKS', 'SSE', 'WebSocket',
  // 品牌与生态专名
  'MCP', 'NAS', 'dsh', 'DSH', 'RQ', 'ACL', 'OK', 'OKTA', 'Keycloak', 'DingTalk',
  'WeChat', 'GitHub', 'GitLab', 'Google', 'Microsoft', 'Apple', 'Linux', 'Windows',
  'macOS', 'Node', 'npm', 'pnpm', 'Ed25519', 'SQLite', 'Cordis', 'cordis',
  'YUANBINGKE', 'Ybk',
  // 领域名词（产品口径保留英文的品牌化称呼；阶段 2 复核）
  'Agent', 'Agents', 'Skill', 'Skills', 'Tool', 'Tools', 'Model', 'Models',
  'Connector', 'Connectors', 'Webhook', 'Webhooks', 'Dashboard', 'Marketplace',
  'Client', 'Clients', 'Secret', 'Scope', 'Scopes', 'Issuer', 'Endpoint', 'Endpoints',
  'Owner', 'Admin', 'Reader', 'Writer', ' Upstream', 'Downstream', 'Fallback',
  // 状态枚举（协议层保留 ASCII，UI 展示需配中文伴随——阶段 2 消化）
  'Active', 'Inactive', 'Pending', 'Running', 'Failed', 'Success', 'Cancelled',
  'Canceled', 'Enabled', 'Disabled', 'Draft', 'Published', 'Offline', 'Online',
  'Degraded', 'Unknown', 'Ready', 'Bound', 'Expired', 'Frozen', 'Approved',
  'Rejected', 'Reviewing', 'Processing', 'Completed', 'Skipped', 'Error',
  // 布尔 / 空 / 单位
  'true', 'false', 'null', 'undefined', 'none', 'None', 'NaN', 'ms', 'qps',
  'KB', 'MB', 'GB', 'TB', 'KiB', 'MiB', 'GiB', 'TiB', 'bytes', 'min', 'hour',
  // 编码/密钥格式（协议层）
  'base64', 'base64url', 'pkcs8', 'spki', 'pem', 'hex', 'utf8',
  // 前端技术标识符常见词（类名/键名拼料）
  'grid', 'flex', 'auto', 'none', 'hidden', 'block', 'inline', 'wrap', 'items',
  'center', 'start', 'dark', 'light', 'primary', 'danger', 'warning', 'info',
  'badge', 'card', 'panel', 'modal', 'toast', 'table', 'page', 'size', 'small',
  // UI 语义 tone / 类名 token（CSS 语义色与样式族，协议层保留 ASCII）
  'success', 'warning', 'danger', 'info', 'primary', 'default', 'secondary', 'ghost',
  'btn', 'icon', 'tab', 'tabs', 'nav', 'row', 'col', 'wrap', 'gap', 'pill', 'dot',
  'kbd', 'chart', 'terminal', 'ticket', 'globe', 'file', 'files', 'download', 'link',
  'focus', 'hover', 'active', 'disabled', 'checked', 'selected', 'expanded',
  'medium', 'large', 'full', 'half', 'left', 'right', 'middle', 'top', 'bottom',
  'collapse', 'expand', 'search', 'filter', 'sort', 'reset', 'submit', 'cancel',
  'close', 'open', 'copy', 'copied', 'edit', 'delete', 'create', 'update', 'view',
  'detail', 'list', 'item', 'items', 'label', 'value', 'name', 'title', 'desc',
  'status', 'level', 'index', 'total', 'count', 'limit', 'offset', 'cursor',
].map((word) => word.trim()))

const IDENTIFIER_RE = /^[A-Za-z0-9_$./:#&?=,-]+$/

/** 剥离模板插值 ${…}，返回静态部分 */
export function stripInterpolation(literal) {
  return literal.replace(/\$\{[^}]*\}/g, ' ')
}

/** 提取字符串中全部英文词（≥minLen 字母），camelCase 不拆（保持协议字段词形） */
export function extractWords(text, minLen) {
  return text.match(new RegExp(`[A-Za-z]{${minLen},}`, 'g')) ?? []
}

/** 判定一个字符串字面量是否疑似英文残留；返回 true=命中 */
export function isSuspectLiteral(raw) {
  const s = stripInterpolation(raw).trim()
  if (!s || /[\u4e00-\u9fff]/.test(s)) return false
  if (!/\s/.test(s)) {
    // 无空格（单词/标识符形态）：
    // 路径 / URL / 文件名 / MIME（含 / . : 之一）→ 协议面，合格
    if (/[/./:]/.test(s)) return false
    // snake_case / kebab-case 协议键（多词连接）→ 协议面，合格
    if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(s)) return false
    // 其余单词（如 deactivated）：白名单外 ≥4 字母 → 命中（展示残留）
    const words = extractWords(s, 4)
    return words.length > 0 && words.some((w) => !TOKEN_WHITELIST.has(w))
  }
  // 句式形态（含空格的英文短语）→ 高置信用户可见文案：白名单外 ≥3 字母词命中
  const words = extractWords(s, 3)
  return words.length > 0 && words.some((w) => !TOKEN_WHITELIST.has(w))
}

/** HTML → 待检文本数组：标签间文本节点 + title/alt/placeholder/aria-label 属性值 */
export function extractHtmlVisibleTexts(html) {
  const texts = []
  const noScripts = html.replace(/<(script|style)[\s\S]*?<\/(script|style)>/g, ' ')
  for (const m of noScripts.matchAll(/(?:^|>)([^<>]*\S[^<>]*)(?:<|$)/g)) {
    const text = m[1].replace(/&[a-z]+;/g, ' ').trim()
    if (text) texts.push(text)
  }
  for (const m of noScripts.matchAll(/\b(?:title|alt|placeholder|aria-label)\s*=\s*["']([^"']*)["']/g)) {
    if (m[1].trim()) texts.push(m[1])
  }
  return texts
}

/** 值为代码料（非用户文案）的对象元数据键：这些键后的字符串值不判定 */
const METADATA_KEY_RE = /(?:icon|badge|perm|path|ext|landing|type|key|field|ref|view|tab|mode|size|tone|color|src|slot|align|shape|variant|scope|role|format|category|group|tags?|code|prop|attr|event|signal|channel|source|target|driver|adapter|strategy|slot)\s*:\s*$/

/** DOM / 代码料调用上下文：字符串紧随这些调用形式出现 → 不判定 */
const DOM_CALL_RE = /(?:\$|\bicon|\besc|\bcls|\bh|querySelectorAll|querySelector|getElementById|closest|createElement|addEventListener|removeEventListener|classList(?:\.[a-z]+)?|setAttribute|getAttribute|insertAdjacentHTML|dataset\.[a-zA-Z]+)\(\s*$/

/** HTML 片段 → 标签间文本节点数组（类名/属性被自然剥除） */
export function extractTemplateTextNodes(fragment) {
  const texts = []
  for (const m of fragment.matchAll(/>([^<>]*\S[^<>]*)</g)) {
    const text = m[1].replace(/&[a-z]+;/g, ' ').trim()
    if (text) texts.push(text)
  }
  return texts
}

/** 判定模板字面量内容（CLI 脚手架输出常为 YAML 结构，属协议内容不判定） */
export function isYamlStructureLine(line) {
  return /^\s*-?\s*[\w."'-]+\s*:(\s|$)/.test(line) || /^\s*- /.test(line)
}

/**
 * 全文字符级字面量提取：顺序消费字符——模板字面量整体吞掉（内部引号不外泄、
 * 跨行正确），插值 ${…} 内部跳过（代码料），行注释跳过。
 * 返回 [{ quote, value, index }]（模板字面量 quote='`'）。
 */
export function parseLiterals(text) {
  const out = []
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === '`') {
      let j = i + 1
      let depth = 0
      const start = i
      while (j < n) {
        const c = text[j]
        if (c === '\\') { j += 2; continue }
        if (depth === 0 && c === '`') break
        if (c === '$' && text[j + 1] === '{') { depth++; j += 2; continue }
        if (depth > 0) {
          if (c === '{') depth++
          else if (c === '}') depth--
          j++
          continue
        }
        j++
      }
      // 插值已剥离的静态内容
      let value = ''
      let k = i + 1
      let d = 0
      while (k < j) {
        const c = text[k]
        if (c === '\\') { k += 2; continue }
        if (d === 0 && c === '`') break
        if (c === '$' && text[k + 1] === '{') { d++; k += 2; continue }
        if (d > 0) {
          if (c === '{') d++
          else if (c === '}') d--
          k++
          continue
        }
        value += c
        k++
      }
      out.push({ quote: '`', value, index: start })
      i = j + 1
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      let value = ''
      while (j < n) {
        const c = text[j]
        if (c === '\\') { value += text[j + 1] ?? ''; j += 2; continue }
        if (c === ch || c === '\n') break
        value += c
        j++
      }
      out.push({ quote: ch, value, index: i })
      i = j + 1
      continue
    }
    i++
  }
  return out
}

/** index → 行号 */
function makeLineLookup(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return (index) => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** 扫描单个 JS 文件（含 .mjs CLI），返回命中数组 [{ file, line, literal }] */
export function scanJsFile(file, text) {
  const hits = []
  const lineOf = makeLineLookup(text)
  const lineStart = (index) => {
    let i = index
    while (i > 0 && text[i - 1] !== '\n') i--
    return i
  }
  for (const lit of parseLiterals(text)) {
    const before = text.slice(lineStart(lit.index), lit.index)
    // 对象键位置（字面量后紧跟冒号）→ 代码料
    const after = text.slice(lit.index + 1 + lit.value.length + 1, lit.index + 1 + lit.value.length + 3)
    if (/^\s*:/.test(after)) continue
    // 元数据键值语义（icon: 'x' / badge: 'y' 等）→ 代码料
    if (METADATA_KEY_RE.test(before)) continue
    // DOM / 代码料调用上下文 → 代码料
    if (DOM_CALL_RE.test(before)) continue
    // 比较操作右侧（e.key === 'Escape'、status === 'warn'）与默认值右侧（params.get('tab') ?? 'catalog'）→ 枚举判定，代码料
    if (/[=!]==?\s*$/.test(before) || /\?\?\s*$/.test(before) || /\|\|\s*$/.test(before)) continue
    // CSS 值料（渐变/颜色函数）：样式非文案
    if (lit.quote !== '`' && /(linear|radial)-gradient\(|rgba?\(|#[0-9a-fA-F]{3,8}\b/.test(lit.value) && !lit.value.includes(' ')) continue
    // SVG 图形字符串（path/rect/circle 等绘图元素）：无用户可见文本，整串跳过
    if (lit.quote !== '`' && /<(svg|path|rect|circle|line|polyline|polygon|g)[\s/>]/.test(lit.value)) continue
    // 普通字符串内嵌 HTML / SVG 片段：走文本节点提取（需闭合标签；SVG 无文本节点自然零命中）
    if (lit.quote !== '`' && lit.value.includes('<') && lit.value.includes('>') && /<\/[a-zA-Z]/.test(lit.value)) {
      for (const node of extractTemplateTextNodes(lit.value)) {
        if (isSuspectLiteral(node)) hits.push({ file, line: lineOf(lit.index), literal: node })
      }
      continue
    }
    if (lit.quote === '`') {
      // 模板字面量：HTML 片段取文本节点；YAML 脚手架结构行跳过；其余按行判定。
      // HTML 判定需存在闭合标签（CLI usage 的 <占位符> 无闭合，走按行判定）
      if (lit.value.includes('<') && lit.value.includes('>') && /<\/[a-zA-Z]/.test(lit.value)) {
        for (const node of extractTemplateTextNodes(lit.value)) {
          if (isSuspectLiteral(node)) hits.push({ file, line: lineOf(lit.index), literal: node })
        }
        continue
      }
      for (const line of lit.value.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || isYamlStructureLine(trimmed)) continue
        // CLI usage 语法行（含 ≥2 个 --flag 或含命令管道 |）：接口语法契约非文案；真实文案行含 CJK 早已放行
        if (isUsageSyntaxLine(trimmed)) continue
        if (isSuspectLiteral(trimmed)) hits.push({ file, line: lineOf(lit.index), literal: trimmed })
      }
      continue
    }
    // CLI flag/option 语法 token（--user / --orgId= / -n）：接口语法契约，非文案
    if (isFlagToken(lit.value)) continue
    // CLI 域纯标识符字面量（字段键/枚举值如 pluginId、createdAt、online）：协议层保留 ASCII，
    // 用户可见表头/枚举经 HEADER_ZH / zhEnum 中文伴随映射展示；句式（含空格）不受此规则豁免
    if (/(^|[\\/])cli[\\/]/.test(file) && /^[a-z][a-zA-Z0-9_]{1,19}$/.test(lit.value)) continue
    // YAML/JSON 结构行（脚手架模板、manifest 片段）：协议内容非文案（CLI 域放宽——脚手架为逐行字符串数组）
    if (isYamlStructureLine(lit.value) && (/[\[\]{}:|]/.test(lit.value) || /(^|[\\/])cli[\\/]/.test(file))) continue
    // URL 查询串模板（?path= / ?q=&kind=）：协议内容非文案
    if (/^\?[\w=&%-]*$/.test(lit.value.trim())) continue
    if (isSuspectLiteral(lit.value)) hits.push({ file, line: lineOf(lit.index), literal: lit.value })
  }
  return hits
}

/** CLI usage 语法行：≥2 个 --flag 记号，或含命令管道分隔（真实文案不会命中） */
export function isUsageSyntaxLine(line) {
  if (/[一-鿿]/.test(line)) return false
  const flagCount = (line.match(/--[\w-]+=?/g) ?? []).length
  return flagCount >= 2 || /^\|\s/.test(line) || / \| /.test(line)
}

/** CLI flag/option 语法 token：--flag / --flag= / -f / --flag=value 形态 */
export function isFlagToken(token) {
  const t = token.trim()
  return /^--?[a-zA-Z][\w-]*(=.{0,40})?$/.test(t) && t.length <= 44
}

/** 扫描单个 HTML 文件（文本节点与可见属性） */
export function scanHtmlFile(file, text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  const lineStarts = [0]
  for (const ch of text) lineStarts.push(lineStarts[lineStarts.length - 1] + ch.length + 1)
  const lineOf = (pos) => lineStarts.findIndex((start, idx) => start <= pos && (idx === lineStarts.length - 1 || lineStarts[idx + 1] > pos)) + 1
  for (const visible of extractHtmlVisibleTexts(text)) {
    if (isSuspectLiteral(visible)) {
      const pos = text.indexOf(visible)
      hits.push({ file, line: pos >= 0 ? lineOf(pos) : 0, literal: visible })
    }
  }
  return hits
}

async function walkTargets(packagesDir) {
  const targets = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (/\.(js|html)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) targets.push(p)
    }
  }
  for (const pkg of await readdir(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    await walk(join(packagesDir, pkg.name, 'public'))
  }
  return targets
}

export async function loadExemptions(root) {
  const parsed = JSON.parse(await readFile(join(root, 'scripts', 'lint-cjk-coverage.exemptions.json'), 'utf8'))
  return new Map((parsed.exemptions ?? []).map((item) => [`${item.kind}::${item.key}`, item]))
}

/**
 * 主入口：扫描全部目标文件，返回 { hits, exempted, stats }。
 * hits 为未豁免命中；exempted 为已登记豁免的命中（透明展示）。
 */
export async function runCjkCoverageScan(root, options = {}) {
  const strict = options.strict ?? false
  const targets = await walkTargets(join(root, 'packages'))
  targets.push(join(root, 'cli', 'dshctl.mjs'))
  const exemptions = await loadExemptions(root)

  const hits = []
  const exempted = []
  for (const file of targets) {
    const text = await readFile(file, 'utf8')
    const found = file.endsWith('.html') ? scanHtmlFile(file, text) : scanJsFile(file, text)
    const rel = relative(root, file).replace(/\\/g, '/')
    for (const hit of found) {
      const key = `literal::${rel}::${hit.literal.slice(0, 80)}`
      const entry = { ...hit, file: rel }
      if (exemptions.has(key)) exempted.push(entry)
      else hits.push(entry)
    }
  }

  const byFile = new Map()
  for (const hit of hits) byFile.set(hit.file, (byFile.get(hit.file) ?? 0) + 1)

  const stats = {
    fileCount: targets.length,
    rawHitCount: hits.length + exempted.length,
    hitCount: hits.length,
    exemptCount: exempted.length,
    byFile: [...byFile.entries()].sort((a, b) => b[1] - a[1]),
  }
  return { ok: !strict || hits.length === 0, hits, exempted, stats, exemptions }
}

// -- CLI 入口 --
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/lint-cjk-coverage.mjs')) {
  const strict = process.argv.includes('--strict')
  const root = process.cwd()
  const { ok, hits, exempted, stats, exemptions } = await runCjkCoverageScan(root, { strict })
  console.log('━━ 表现层汉化覆盖清点（R11，REFACTOR-2026-10-13）━━')
  console.log(`  扫描面：${stats.fileCount} 文件（packages/*/public/**.js|html + cli/dshctl.mjs）`)
  console.log(`  命中：${stats.hitCount} 处疑似英文残留（豁免 ${stats.exemptCount} 处）${strict ? '【门禁模式】' : '【报告模式——阶段 2 逐项消灭】'}`)
  for (const [file, count] of stats.byFile) console.log(`    ${String(count).padStart(4)}  ${file}`)
  console.log('  —— 命中明细（前 60 条）——')
  for (const hit of hits.slice(0, 60)) {
    console.log(`    ${hit.file}:${hit.line}  «${hit.literal.slice(0, 90)}»`)
  }
  if (hits.length > 60) console.log(`    …（其余 ${hits.length - 60} 处略，--strict 门禁模式外不逐条展开）`)
  if (exempted.length > 0) {
    console.log(`  —— 豁免命中 ${exempted.length} 处 ——`)
    for (const hit of exempted.slice(0, 10)) console.log(`    ${hit.file}:${hit.line}  «${hit.literal.slice(0, 70)}»`)
  }
  console.log(`  结果：${stats.hitCount} 命中 ${ok ? '✔' : '✘'}`)
  process.exit(ok ? 0 : 1)
}
