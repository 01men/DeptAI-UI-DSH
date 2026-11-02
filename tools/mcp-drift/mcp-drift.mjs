#!/usr/bin/env node
/**
 * mcp-drift — 把「这台机器现在跑什么 MCP、权限面被放宽到哪」导出成可 review 的快照，
 * 并检测与基线的漂移。
 *
 * 解决的问题（见 zhang-guo-wen/dsh-mcp-manager#2）：
 *   策略位只存在于本机 profile 的 cordis.patch.yml 里，三个人三台机器实际生效的
 *   MCP 权限面可能完全不同，而且没有任何一个人能看出这个差异。
 *
 * 零依赖，只用 Node 内置模块。Node >= 18。
 *
 * 用法：
 *   node mcp-drift.mjs snapshot  --config <cordis.patch.yml> [-o out.json]
 *   node mcp-drift.mjs diff      --baseline base.json --current cur.json
 *   node mcp-drift.mjs check     --config <cordis.patch.yml> --baseline base.json
 *
 * CI 用法：漂移时 exit 1，可直接做 pre-commit 或 GitHub Actions 的一步。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

const SEVERITY = { RISK: 3, GRANT: 2, CHANGE: 1 }
const rank = (s) => SEVERITY[s] ?? 0

/* ------------------------------------------------------------------ *
 * 极简 YAML 子集解析
 * 支持 dsh profile / cordis.patch.yml 实际用到的形状，块状与行内两种写法都要认：
 *
 *   - insert:
 *       - id: mcp-context7
 *         name: '@upstash/context7-mcp'
 *         config:
 *           command: npx            # 块状
 *           args: [-y, '@upstash/context7-mcp']
 *       - id: mcp-manager
 *         config: { loading: dynamic, tools: { 'global:context7': ['!delete_*'] } }   # 行内
 *
 * 多文档 / 锚点 / 复杂 flow 嵌套一律**报错**，不猜。宁可失败也不静默放过——
 * 对治理工具来说，「报错」比「报个假的干净结果」有价值得多。
 * ------------------------------------------------------------------ */

/** 一行有效内容：缩进宽度 + 去掉注释后的正文。 */
function scanLines(text) {
  const out = []
  const raw = text.split('\n')
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (/^---\s*$/.test(trimmed) || /^\.\.\.\s*$/.test(trimmed)) {
      throw new Error(`第 ${i + 1} 行出现 YAML 文档分隔符：本工具只处理单文档，不做合并。`)
    }
    if (/^[&*][A-Za-z]/.test(trimmed)) {
      throw new Error(`第 ${i + 1} 行出现锚点/别名（${trimmed.slice(0, 12)}…）：本工具不解析锚点，请展开后再用。`)
    }
    out.push({ indent: line.length - line.trimStart().length, text: stripComment(trimmed), line: i + 1 })
  }
  return out
}

/** 去掉行尾注释，但引号内的 `#` 不算注释。 */
function stripComment(s) {
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd()
  }
  return s
}

/** 把引号包裹的标量脱引号；未加引号则原样返回。 */
function unquote(s) {
  const t = s.trim()
  if (t.length >= 2 && ((t[0] === "'" && t.at(-1) === "'") || (t[0] === '"' && t.at(-1) === '"'))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * 标量值求值：null / bool / number / 行内映射 / 行内序列 / 字符串。
 * 行内映射与序列必须真解出来——把 `[a, b]` 留成字符串会让下游的数组判断失败，
 * 规则被当成「没配」，一项权限放宽就此漏报。
 */
function parseScalar(raw, where) {
  const t = raw.trim()
  if (t === '') return undefined
  if (t === '~' || t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+$/.test(t)) return Number(t)
  if (t.startsWith('{')) return parseInlineMap(t, where)
  if (t.startsWith('[')) return parseInlineSeq(t, where)
  if (t.startsWith('|') || t.startsWith('>')) {
    throw new Error(`${where} 使用了块标量（${t}），本工具不支持，请改成行内写法或单行字符串。`)
  }
  return unquote(t)
}

/** 行内 flow 结构切分：按顶层逗号切，尊重引号与嵌套括号。 */
function splitFlow(body, where) {
  const parts = []
  let depth = 0
  let quote = null
  let buf = ''
  for (const ch of body) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue }
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf.trim() !== '') parts.push(buf)
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

function parseInlineMap(t, where) {
  if (!t.endsWith('}')) throw new Error(`${where} 的行内映射没有闭合的花括号：${t.slice(0, 40)}`)
  const body = t.slice(1, -1).trim()
  const obj = {}
  if (body === '') return obj
  for (const seg of splitFlow(body, where)) {
    const colon = seg.indexOf(':')
    if (colon === -1) throw new Error(`${where} 的行内映射条目缺少冒号：${seg}`)
    const key = unquote(seg.slice(0, colon))
    if (key === '') throw new Error(`${where} 的行内映射出现空键`)
    if (Object.hasOwn(obj, key)) throw new Error(`${where} 的行内映射键重复：${key}`)
    obj[key] = parseScalar(seg.slice(colon + 1), `${where} → ${key}`)
  }
  return obj
}

function parseInlineSeq(t, where) {
  if (!t.endsWith(']')) throw new Error(`${where} 的行内序列没有闭合的方括号：${t.slice(0, 40)}`)
  const body = t.slice(1, -1).trim()
  if (body === '') return []
  return splitFlow(body, where).map((seg) => parseScalar(seg, where))
}

/**
 * 按缩进递归解析成 JS 值。
 * 调用方保证 lines[i].indent === indent。
 */
function parseBlock(lines, i, indent) {
  const first = lines[i]
  if (/^-(\s|$)/.test(first.text)) return parseSeq(lines, i, indent)
  return parseMap(lines, i, indent)
}

function parseSeq(lines, i, indent) {
  const arr = []
  while (i < lines.length) {
    const cur = lines[i]
    if (cur.indent < indent) break
    if (cur.indent > indent) throw new Error(`第 ${cur.line} 行缩进异常（期望 ${indent}）`)
    if (!/^-(\s|$)/.test(cur.text)) break
    const rest = cur.text.replace(/^-\s*/, '')
    const childIndent = indent + 2
    if (rest === '') {
      // `-` 后换行 → 下一行是该项内容
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [val, next] = parseBlock(lines, i + 1, lines[i + 1].indent)
        arr.push(val)
        i = next
        continue
      }
      arr.push(null)
      i++
      continue
    }
    if (/^[A-Za-z0-9_.\-$]+:(\s|$)/.test(rest) || /^'[^']*':(\s|$)/.test(rest) || /^"[^"]*":(\s|$)/.test(rest)) {
      // `- key: value` → 以该键开头的一个映射
      const obj = {}
      const shifted = [{ indent: childIndent, text: rest, line: cur.line }, ...lines.slice(i + 1)]
      let j = 0
      const colon = findTopColon(rest)
      const key = unquote(rest.slice(0, colon))
      const tail = rest.slice(colon + 1).trim()
      if (tail === '') {
        if (shifted.length > 1 && shifted[1].indent > childIndent) {
          const [val, next] = parseBlock(shifted, 1, shifted[1].indent)
          obj[key] = val
          j = next
        } else { obj[key] = null; j = 1 }
      } else { obj[key] = parseScalar(tail, `第 ${cur.line} 行 ${key}`); j = 1 }
      // 继续消费同一项的后续键
      while (j < shifted.length && shifted[j].indent === childIndent && !/^-(\s|$)/.test(shifted[j].text)) {
        const [more, next] = parseMap(shifted, j, childIndent)
        Object.assign(obj, more)
        j = next
        break
      }
      arr.push(obj)
      i = i + (j - 1) + 1
      continue
    }
    arr.push(parseScalar(rest, `第 ${cur.line} 行`))
    i++
  }
  return [arr, i]
}

/** 找到不在引号内的第一个冒号。 */
function findTopColon(s) {
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ':') return i
  }
  return -1
}

function parseMap(lines, i, indent) {
  const obj = {}
  while (i < lines.length) {
    const cur = lines[i]
    if (cur.indent < indent) break
    if (cur.indent > indent) throw new Error(`第 ${cur.line} 行缩进异常（期望 ${indent}）：${cur.text.slice(0, 40)}`)
    if (/^-(\s|$)/.test(cur.text)) break
    const colon = findTopColon(cur.text)
    if (colon === -1) throw new Error(`第 ${cur.line} 行不是合法的映射条目：${cur.text.slice(0, 40)}`)
    const key = unquote(cur.text.slice(0, colon))
    if (key === '') throw new Error(`第 ${cur.line} 行出现空键`)
    if (Object.hasOwn(obj, key)) throw new Error(`第 ${cur.line} 行键重复：${key}`)
    const tail = cur.text.slice(colon + 1).trim()
    if (tail === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [val, next] = parseBlock(lines, i + 1, lines[i + 1].indent)
        obj[key] = val
        i = next
        continue
      }
      obj[key] = null
      i++
      continue
    }
    obj[key] = parseScalar(tail, `第 ${cur.line} 行 ${key}`)
    i++
  }
  return [obj, i]
}

/** 解析整份 patch 文件为顶层值（通常是 `[{insert: [...]}]`）。 */
export function parsePatchYAML(text) {
  const lines = scanLines(text)
  if (!lines.length) return []
  const [val] = parseBlock(lines, 0, lines[0].indent)
  return val
}

/** 从顶层结构里取出所有 insert 条目（含嵌套在 patches / 多层 insert 下的）。 */
function collectEntries(node, out = []) {
  if (Array.isArray(node)) { for (const item of node) collectEntries(item, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node.insert)) {
    for (const entry of node.insert) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) out.push(entry)
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'insert') continue
    collectEntries(value, out)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 权限面提取
 *
 * 真实结构（dsh-mcp-manager 的 settings 命名空间，id 即 Loader 行 id
 * `mcp-manager`）：
 *
 *   config:
 *     loading: dynamic | eager | lazy      ← 全局，不分行
 *     descriptions: { '<rowKey>': '…' }    ← 按行
 *     tools:        { '<rowKey>': ['get_*', '!delete_*'] }   ← 按行的工具规则
 *     optimize:     { hideDestructive, annotations, search, … }  ← 全局策略
 *
 * rowKey = `global:<serverName>` 或 `preset:<presetId>:<serverName>`。
 *
 * MCP 行自己的 `config` 是**连接配置**（command / url / env / headers），
 * 不是策略位——策略位读错位置就等于整套检测失效，所以这里先定位 settings
 * 节点，定位不到就明确报「找不到策略面」，绝不假装跑出一份干净结果。
 * ------------------------------------------------------------------ */

const MCP_ROW_ID = /^(mcp[-_]|.*mcp[-_])/i
const SETTINGS_KEYS = ['loading', 'tools', 'descriptions', 'optimize']

/** 判定一个 entry 是否 MCP server 行（排除承载设置的那个 manager 行本身）。 */
function isMcpServerEntry(entry) {
  const id = String(entry.id ?? '')
  if (id === 'mcp-manager') return false
  if (MCP_ROW_ID.test(id)) return true
  const name = String(entry.name ?? '')
  return /mcp/i.test(name) || /-mcp\b|\bmcp-/.test(name)
}

/** 该 entry 的 config 是否是 mcp-manager 的设置文档（而不是 MCP 连接配置）。 */
function looksLikeSettings(cfg) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return false
  return SETTINGS_KEYS.some((k) => Object.hasOwn(cfg, k))
}

/**
 * 复刻 dsh-mcp-manager `serverNameFromCommand` 的命名规则（src/mcp-spec.ts）。
 *
 * 这不是可选项：rowKey 是 `global:<serverName>`，serverName 算错 → 规则匹配不到行
 * → 整份快照把「配了的策略」报成「没配」，一项权限收紧看起来像不存在。
 * 规则：去 scope、去尾部 `-mcp` / `-mcp-server` / `-server`、去版本、非字母数字转 `-`、截 32。
 */
function serverNameFromCommand(command) {
  const last = String(command).split(/[\\/]/).at(-1) ?? String(command)
  return last
    .replace(/\.(cmd|exe|ps1|js|mjs|cjs|py)$/i, '')
    .replace(/^@[^/]+\//, '')
    .replace(/-mcp(-server)?$/, '')
    .replace(/-server$/, '')
    .replace(/@[^@]*$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/** 只负责转发的启动器：`npx` 本身不是一个叫 npx 的 server。 */
const PACKAGE_RUNNERS = new Set([
  'bun', 'bunx', 'deno', 'dnx', 'node', 'npm', 'npx', 'pipx', 'pnpm', 'pnpx', 'python', 'python3', 'uv', 'uvx', 'yarn',
])

/** 只描述角色、不描述产品的域名标签。 */
const GENERIC_HOST_LABELS = new Set(['mcp', 'www', 'api', 'server', 'sse', 'http', 'https'])

/**
 * 从 MCP 行的连接配置推出 server name（与 mcp-manager 同名口径）。
 * stdio 取包参数（不是启动器），HTTP 取域名里最具体的那一段。
 */
function serverNameOf(entry) {
  const cfg = entry.config !== null && typeof entry.config === 'object' && !Array.isArray(entry.config)
    ? entry.config
    : {}
  if (typeof cfg.url === 'string') {
    try {
      const host = new URL(cfg.url).hostname
      if (host === '' || /^[\d.]+$/.test(host)) return ''
      const labels = host.split('.').filter((l) => l !== '')
      return serverNameFromCommand(labels.find((p) => !GENERIC_HOST_LABELS.has(p)) ?? labels[0] ?? '')
    } catch { return '' }
  }
  const command = typeof cfg.command === 'string' ? cfg.command : null
  if (command === null) return ''
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : []
  const pkg = args.find((a) => !a.startsWith('-'))
  if (pkg !== undefined && pkg !== '') return serverNameFromCommand(pkg)
  const program = (command.split(/[\\/]/).at(-1) ?? command).replace(/\.(cmd|exe|ps1|js|mjs|cjs|py)$/i, '')
  return PACKAGE_RUNNERS.has(program) ? '' : serverNameFromCommand(command)
}

/** 归一化工具规则：非空字符串、trim、保持顺序（`!` 前缀表示隐藏）。 */
function normalizeRules(value, where) {
  if (value === undefined || value === null) return { rules: [], malformed: null }
  if (typeof value === 'string') {
    const t = value.trim()
    return { rules: t === '' ? [] : [t], malformed: null }
  }
  if (!Array.isArray(value)) {
    return { rules: [], malformed: `${where} 不是数组也不是字符串（得到 ${typeof value}），规则无法读取` }
  }
  const rules = []
  for (const item of value) {
    if (typeof item !== 'string') {
      return { rules: [], malformed: `${where} 含非字符串条目（${JSON.stringify(item)}），规则无法可靠读取` }
    }
    const t = item.trim()
    if (t !== '') rules.push(t)
  }
  return { rules, malformed: null }
}

/**
 * 生成规范化快照。
 * @param {string} configText - cordis.patch.yml 全文
 */
export function snapshot(configText) {
  const entries = collectEntries(parsePatchYAML(configText))

  // 定位设置文档：id 为 mcp-manager 优先；否则取第一个「形状像设置」的 config。
  let settingsEntry = entries.find((e) => String(e.id ?? '') === 'mcp-manager')
  if (settingsEntry === undefined) {
    settingsEntry = entries.find((e) => looksLikeSettings(e.config))
  }
  const settings = settingsEntry?.config
  const haveSettings = settings !== null && typeof settings === 'object' && !Array.isArray(settings)

  const warnings = []
  if (!haveSettings) {
    warnings.push(
      '未在配置里找到 mcp-manager 的设置节点（`config` 含 loading/tools/descriptions/optimize）：'
      + '加载模式、工具过滤、破坏性工具策略全部读不到。本快照只含 server 名单，不代表权限面。',
    )
  }

  const loading = haveSettings && typeof settings.loading === 'string' ? settings.loading : null
  if (haveSettings && loading === null) {
    warnings.push('设置节点存在但没有 `loading` 字段：加载模式未知（不按默认值猜）。')
  }

  const optimize = haveSettings && settings.optimize !== null && typeof settings.optimize === 'object'
    && !Array.isArray(settings.optimize) ? settings.optimize : null
  if (haveSettings && settings.optimize !== undefined && optimize === null) {
    warnings.push(`\`optimize\` 不是映射（得到 ${typeof settings.optimize}）：全局策略读不到。`)
  }

  // 按行规则表：key 用 `global:<name>` / `preset:<id>:<name>`
  const ruleTable = (haveSettings && settings.tools !== null && typeof settings.tools === 'object'
    && !Array.isArray(settings.tools)) ? settings.tools : null
  if (haveSettings && settings.tools !== undefined && ruleTable === null) {
    warnings.push(`\`tools\` 不是映射（得到 ${typeof settings.tools}）：按行工具过滤读不到。`)
  }

  const rows = []
  for (const entry of entries) {
    if (!isMcpServerEntry(entry)) continue
    const id = String(entry.id ?? '')
    const name = String(entry.name ?? '')
    const cfg = entry.config
    if (cfg !== undefined && cfg !== null && (typeof cfg !== 'object' || Array.isArray(cfg))) {
      throw new Error(
        `行「${id}」的 config 不是映射（得到 ${typeof cfg}）。\n`
        + '这意味着该行的连接配置无法解析，快照里的 server 名单不可信——'
        + '请检查 YAML 写法是否在本工具支持范围内。',
      )
    }
    const serverName = serverNameOf(entry)
    // rowKey 的末段是**用户在名册里给 server 起的名字**，可能等于推断名、也可能就是
    // 行 id（导入时自动填的名字允许手改）。三者都认，否则一条真实存在的规则会被
    // 误报成「没有匹配到任何 server 行」——假阳性会把真问题淹掉。
    const aliases = new Set([serverName, id, id.replace(/^mcp[-_]/i, '')].filter((v) => v !== ''))
    const candidates = ruleTable === null
      ? []
      : Object.keys(ruleTable).filter((key) => {
          const suffix = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key
          return aliases.has(suffix)
        })
    // 同一 server 名在多个 preset 下各有一份规则时，全部取出、全排序，避免只看一份。
    const matchedRules = []
    const matchedKeys = []
    for (const key of candidates.sort()) {
      const { rules, malformed } = normalizeRules(ruleTable[key], `工具规则 \`${key}\``)
      if (malformed !== null) warnings.push(malformed)
      matchedRules.push(...rules)
      matchedKeys.push(key)
    }
    rows.push({
      id,
      name,
      serverName,
      enabled: entry.disabled !== true,
      description: (haveSettings && settings.descriptions !== null
        && typeof settings.descriptions === 'object'
        && typeof settings.descriptions[candidates[0]] === 'string')
        ? settings.descriptions[candidates[0]]
        : null,
      toolRules: matchedRules.sort(),
      ruleKeys: matchedKeys.sort(),
    })
  }
  rows.sort((a, b) => a.id.localeCompare(b.id))

  // 配了规则却匹配不到任何 server 行 = 改名/换 id 之后策略静默失效。
  // 这是治理面最典型的漏报来源，必须单列，不能沉在 warnings 里。
  const knownKeys = new Set(rows.flatMap((r) => r.ruleKeys))
  const orphanRuleKeys = ruleTable === null ? [] : Object.keys(ruleTable).filter((k) => !knownKeys.has(k)).sort()
  const orphanDescriptions = (haveSettings && settings.descriptions !== null
    && typeof settings.descriptions === 'object' && !Array.isArray(settings.descriptions))
    ? Object.keys(settings.descriptions).filter((k) => !knownKeys.has(k)).sort()
    : []

  const surfaceOf = (r) => `${r.id}:${r.enabled ? 'on' : 'off'}:${r.toolRules.join(',')}`
  const surface = [
    `loading=${loading ?? 'unknown'}`,
    `hideDestructive=${optimize?.hideDestructive === true}`,
    `annotations=${optimize?.annotations === true}`,
    ...rows.filter((r) => r.enabled).map(surfaceOf),
  ].join('|')

  return {
    $schema: 'https://ybkkasi.com/schemas/mcp-roster-snapshot/v2',
    source: settingsEntry === undefined ? null : String(settingsEntry.id ?? '(unnamed settings node)'),
    loading,
    optimize: optimize === null
      ? null
      : {
          hideDestructive: optimize.hideDestructive === true,
          annotations: optimize.annotations === true,
          search: optimize.search === true,
          namesOnly: optimize.namesOnly === true,
          pageSize: typeof optimize.pageSize === 'number' ? optimize.pageSize : null,
          maxTools: typeof optimize.maxTools === 'number' ? optimize.maxTools : null,
        },
    rows,
    orphanRuleKeys,
    orphanDescriptions,
    warnings,
    summary: {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      toolFiltered: rows.filter((r) => r.toolRules.length > 0).length,
      hideDestructiveOn: optimize?.hideDestructive === true,
      surfaceHash: createHash('sha256').update(surface).digest('hex').slice(0, 16),
    },
  }
}

/* ------------------------------------------------------------------ *
 * 漂移检测
 * 关键设计：**按风险分级**，让 code review 的人先看该看的。
 * ------------------------------------------------------------------ */
export function diff(base, cur) {
  const findings = []

  // 全局策略：破坏性工具过滤被关掉，是整台机器所有 server 一起放宽。
  if (base.optimize?.hideDestructive === true && cur.optimize?.hideDestructive !== true) {
    findings.push({
      severity: 'RISK', id: '(全局)', kind: 'DESTRUCTIVE_OFF',
      detail: '全局「隐藏破坏性工具」被关掉了 —— 所有 server 的 destructiveHint 工具重新可见可调',
    })
  }
  if (base.loading !== null && cur.loading !== null && base.loading !== cur.loading) {
    findings.push({
      severity: 'CHANGE', id: '(全局)', kind: 'LOADING_MODE',
      detail: `加载模式 ${base.loading} → ${cur.loading}`,
    })
  }
  if (base.optimize !== null && cur.optimize !== null) {
    for (const flag of ['annotations', 'search', 'namesOnly']) {
      if (base.optimize[flag] === true && cur.optimize[flag] !== true) {
        findings.push({
          severity: 'CHANGE', id: '(全局)', kind: `OPTIMIZE_${flag.toUpperCase()}_OFF`,
          detail: `全局开关 \`${flag}\` 被关掉`,
        })
      }
    }
    if (base.optimize.maxTools !== null && cur.optimize.maxTools === null) {
      findings.push({
        severity: 'GRANT', id: '(全局)', kind: 'MAXTOOLS_UNSET',
        detail: '`maxTools` 采集上限被移除 —— 超大 server 可以灌满一次请求',
      })
    }
  }

  const b = new Map(base.rows.map((r) => [r.id, r]))
  const c = new Map(cur.rows.map((r) => [r.id, r]))

  for (const [id, curRow] of c) {
    const baseRow = b.get(id)
    if (baseRow === undefined) {
      findings.push({
        severity: 'RISK', id, kind: 'ADDED',
        detail: `新增 MCP server「${id}」不在基线内${curRow.enabled ? '' : '（当前关闭）'}`,
      })
      continue
    }
    if (baseRow.enabled && !curRow.enabled) {
      findings.push({ severity: 'CHANGE', id, kind: 'DISABLED', detail: `「${id}」被关闭（能力下线，若是意外请确认）` })
    }
    if (!baseRow.enabled && curRow.enabled) {
      findings.push({ severity: 'RISK', id, kind: 'ENABLED', detail: `「${id}」被启用 —— 团队基线里它是关的` })
    }
    const lost = baseRow.toolRules.filter((t) => !curRow.toolRules.includes(t))
    if (lost.length) {
      findings.push({
        severity: 'GRANT', id, kind: 'TOOL_RULE_LOST',
        detail: `「${id}」少了工具规则：${lost.join(', ')}（规则变少 = 模型可见的工具变多）`,
      })
    }
    if (baseRow.serverName !== curRow.serverName) {
      findings.push({
        severity: 'CHANGE', id, kind: 'RENAMED',
        detail: `server 名 ${baseRow.serverName} → ${curRow.serverName} —— 按行规则可能已失配`,
      })
    }
  }
  for (const [id, baseRow] of b) {
    if (c.has(id)) continue
    findings.push({
      severity: baseRow.enabled ? 'RISK' : 'CHANGE', id, kind: 'REMOVED',
      detail: baseRow.enabled
        ? `基线里启用的「${id}」在本机不存在 —— 团队基线依赖的 server 已消失`
        : `基线里关闭的「${id}」在本机不存在`,
    })
  }

  // 规则表里存在、但没有任何 server 行认领的 key：改名后策略静默失效。
  const baseOrphans = new Set(base.orphanRuleKeys ?? [])
  for (const key of cur.orphanRuleKeys ?? []) {
    findings.push({
      severity: baseOrphans.has(key) ? 'CHANGE' : 'GRANT',
      id: key, kind: 'ORPHAN_RULE_KEY',
      detail: `工具规则 \`${key}\` 没有匹配到任何 server 行 —— 这条策略当前不生效`,
    })
  }

  findings.sort((a, z) => rank(z.severity) - rank(a.severity) || a.id.localeCompare(z.id))
  return findings
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */
const C = process.stdout.isTTY
  ? { R: '\x1b[31m', Y: '\x1b[33m', G: '\x1b[32m', D: '\x1b[2m', X: '\x1b[0m', B: '\x1b[1m' }
  : { R: '', Y: '', G: '', D: '', X: '', B: '' }

function renderDiff(findings, snap) {
  if (snap?.warnings?.length) {
    console.log(`${C.Y}!${C.X} ${snap.warnings.length} 项读取警告：`)
    for (const w of snap.warnings) console.log(`  · ${w}`)
    console.log('')
  }
  if (!findings.length) {
    console.log(`${C.G}✓ 无漂移${C.X} — 本机 MCP 权限面与基线一致（surface ${C.D}${snap?.summary?.surfaceHash ?? 'hash ok'}${C.X}）`)
    return 0
  }
  const bySev = { RISK: [], GRANT: [], CHANGE: [] }
  for (const f of findings) (bySev[f.severity] ||= []).push(f)

  console.log(`${C.B}MCP 权限面漂移检测${C.X}  共 ${findings.length} 项`)
  for (const sev of ['RISK', 'GRANT', 'CHANGE']) {
    const list = bySev[sev]
    if (!list?.length) continue
    const tag = { RISK: `${C.R}[风险]${C.X}`, GRANT: `${C.Y}[放宽]${C.X}`, CHANGE: `${C.D}[变更]${C.X}` }[sev]
    console.log(`\n${tag} ${list.length} 项`)
    for (const f of list) console.log(`  · ${f.detail}${C.D}  (${f.kind})${C.X}`)
  }
  const risky = bySev.RISK?.length ?? 0
  console.log(risky
    ? `\n${C.R}结论：有 ${risky} 项风险级漂移，需人工确认后再提交。${C.X}`
    : `\n${C.Y}结论：无风险级漂移，但有权限面变化，建议在 PR 描述里写明理由。${C.X}`)
  return 1
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v !== undefined && !v.startsWith('--')) { out[k] = v; i++ } else out[k] = true
      continue
    }
    if (/^-[a-zA-Z]$/.test(a)) {
      const k = { o: 'out', h: 'help', c: 'config', b: 'baseline' }[a.slice(1)]
      if (k === undefined) continue
      const v = argv[i + 1]
      if (v !== undefined && !v.startsWith('-')) { out[k] = v; i++ } else out[k] = true
      continue
    }
    out._.push(a)
  }
  return out
}

function loadSnapshot(path) {
  try {
    return snapshot(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`✗ ${e.message}`)
    process.exit(1)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  if (!cmd || args.help) {
    console.log(`mcp-drift — MCP 权限面快照与漂移检测（零依赖）

  snapshot  --config <cordis.patch.yml> [-o out.json]   导出规范化快照
  diff      --baseline base.json --current cur.json     比对两份快照
  check     --config <cordis.patch.yml> --baseline base.json [--ci]

退出码：0 = 无漂移，1 = 有漂移（含风险级），2 = 参数或解析错误。`)
    return 0
  }

  if (cmd === 'snapshot') {
    if (typeof args.config !== 'string') { console.error('✗ 需要 --config'); return 2 }
    if (!existsSync(args.config)) { console.error(`✗ 配置文件不存在：${args.config}`); return 2 }
    const snap = loadSnapshot(args.config)
    const json = JSON.stringify(snap, null, 2) + '\n'
    if (typeof args.out === 'string') {
      writeFileSync(args.out, json)
      console.log(`${C.G}✓${C.X} 快照已写入 ${args.out}（${snap.summary.total} 个 MCP server，surface ${C.D}${snap.summary.surfaceHash}${C.X}）`)
    } else process.stdout.write(json)
    if (snap.warnings.length) {
      for (const w of snap.warnings) console.error(`${C.Y}!${C.X} ${w}`)
      return 1
    }
    return 0
  }

  if (cmd === 'diff') {
    if (typeof args.baseline !== 'string' || typeof args.current !== 'string') {
      console.error('✗ 需要 --baseline 与 --current'); return 2
    }
    for (const p of [args.baseline, args.current]) {
      if (!existsSync(p)) { console.error(`✗ 文件不存在：${p}`); return 2 }
    }
    return renderDiff(
      diff(JSON.parse(readFileSync(args.baseline, 'utf8')), JSON.parse(readFileSync(args.current, 'utf8'))),
    )
  }

  if (cmd === 'check') {
    if (typeof args.config !== 'string' || typeof args.baseline !== 'string') {
      console.error('✗ 需要 --config 与 --baseline'); return 2
    }
    if (!existsSync(args.baseline)) {
      console.log(`${C.Y}!${C.X} 基线不存在：${args.baseline}\n  用 \`snapshot\` 生成后提交进仓库。基线缺失不算漂移。`)
      return 0
    }
    const cur = loadSnapshot(args.config)
    return renderDiff(diff(JSON.parse(readFileSync(args.baseline, 'utf8')), cur), cur)
  }

  console.error(`✗ 未知命令：${cmd}`)
  return 2
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main())
}