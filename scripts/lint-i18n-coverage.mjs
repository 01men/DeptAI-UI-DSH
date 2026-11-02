/**
 * 前端文案三语覆盖率门禁（QA 2026-10-21 P2-05：a2a.js 缺 7 条 = 93.5%，无门禁可守）。
 *
 * 口径：
 *   - 扫描 packages/plugin-console/public/js 下全部页面与组件（pages/**、components/**），
 *     提取 `rqI18n.t('…')` 字面量键（与运行时整词匹配口径一致：键 = 中文原文）；
 *   - 对每个语言包（en-US / ja-JP，zh-CN 为原文不参与）统计缺失键；
 *   - **文件级门槛 ≥95%**：任一文件低于阈值即红（不允许「整体 99% 但新页面 60%」）；
 *   - 同时校验模板占位符一致（{n}/{time} 等插值名不得在译文中丢失或改名）——
 *     缺占位符会让翻译分支静默吞掉变量，比缺键更难被发现。
 *
 * 用法：
 *   node scripts/lint-i18n-coverage.mjs            # 门禁模式（低于阈值 exit 1）
 *   node scripts/lint-i18n-coverage.mjs --report   # 仅报告（exit 0）
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JS_ROOT = join(ROOT, 'packages', 'plugin-console', 'public', 'js')
const LOCALE_ROOT = join(ROOT, 'packages', 'plugin-console', 'public', 'locales')
const LOCALES = ['en-US', 'ja-JP']
/** 文件级覆盖率门槛（QA 反馈：95% 是放行线）。 */
const THRESHOLD = 0.95

const reportOnly = process.argv.includes('--report')

/** 递归列出目录下 .js（跳过 *.test.mjs 与 realtime 等纯逻辑模块）。 */
async function listJs(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await listJs(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

/** 提取 rqI18n.t('literal') 键（含转义，排除模板串与变量键）。 */
function extractKeys(source) {
  const keys = new Set()
  const re = /rqI18n\.t\(\s*'((?:[^'\\]|\\.)*)'/g
  let match
  while ((match = re.exec(source)) !== null) keys.add(match[1].replace(/\\'/g, "'"))
  return keys
}

/** 占位符集合（{name} 形式）。 */
function placeholders(text) {
  return new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
}

async function loadLocale(locale) {
  const merged = {}
  for (const file of (await readdir(join(LOCALE_ROOT, locale))).filter((f) => f.endsWith('.json')).sort()) {
    Object.assign(merged, JSON.parse(await readFile(join(LOCALE_ROOT, locale, file), 'utf8')))
  }
  return merged
}

const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (locale) => [locale, await loadLocale(locale)])))

const targets = [
  ...await listJs(join(JS_ROOT, 'pages')),
  ...await listJs(join(JS_ROOT, 'components')),
].filter((file) => !file.endsWith('.test.mjs'))

let filesChecked = 0
let missingTotal = 0
const failures = []

for (const file of targets) {
  const keys = extractKeys(await readFile(file, 'utf8'))
  if (keys.size === 0) continue
  filesChecked++
  const rel = relative(ROOT, file)
  for (const locale of LOCALES) {
    const catalog = catalogs[locale]
    const missing = [...keys].filter((key) => catalog[key] === undefined).sort()
    const badPlaceholders = [...keys]
      .filter((key) => catalog[key] !== undefined)
      .filter((key) => {
        const want = placeholders(key)
        const got = placeholders(String(catalog[key]))
        return want.size !== got.size || [...want].some((name) => !got.has(name))
      })
      .sort()
    if (missing.length > 0 || badPlaceholders.length > 0) {
      const covered = keys.size - missing.length
      const ratio = covered / keys.size
      const lines = []
      if (missing.length) lines.push(`缺 ${missing.length} 条：${missing.slice(0, 8).join(' / ')}${missing.length > 8 ? ' …' : ''}`)
      if (badPlaceholders.length) lines.push(`占位符不一致 ${badPlaceholders.length} 条：${badPlaceholders.slice(0, 5).join(' / ')}`)
      const line = `${rel} [${locale}] 覆盖 ${(ratio * 100).toFixed(1)}%（${covered}/${keys.size}）· ${lines.join('；')}`
      missingTotal += missing.length + badPlaceholders.length
      if (ratio < THRESHOLD || badPlaceholders.length > 0) failures.push(line)
      else console.log(`  ⚠ ${line}`)
    }
  }
}

console.log(`\n三语文案覆盖：${filesChecked} 个前端文件，缺失/不一致 ${missingTotal} 处（门槛 ${(THRESHOLD * 100).toFixed(0)}%）`)
for (const line of failures) console.error(`  ✘ ${line}`)
if (failures.length > 0) {
  if (reportOnly) {
    console.log('（--report 模式：仅报告，不阻断）')
    process.exit(0)
  }
  console.error('存在低于门槛的文件：补词典后再放行')
  process.exit(1)
}
console.log('全部通过 ✔')