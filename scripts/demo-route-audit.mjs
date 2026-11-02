/**
 * 演示只读面审计（2026-10-17 演示模式批次）。
 *
 * 静态枚举全仓 `guarded(` 路由声明，对「GET/HEAD 路由 → 所需权限点」与演示只读白名单
 * DEMO_READONLY_PERMISSIONS（plugin-console/src/demo-mode.ts）求差集：
 *   - 差集点属只读语义（`.read` 结尾 / console.login 登录点）→ 判红：
 *     演示态访客打开对应页面将 403，须评审补白名单或改路由声明点；
 *   - 差集点属写语义（.write/.approve/.invoke/.admin 等）→ 预期行为（演示态 403），不判红。
 * 同时复核白名单自身卫生：findWritePermissionLeaks 必须为空（无写点混入）。
 *
 * 用法：node scripts/demo-route-audit.mjs（selftest 亦拉起本脚本，退出码非 0 即红）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEMO_READONLY_PERMISSIONS, findWritePermissionLeaks } from '../packages/plugin-console/src/demo-mode.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')

function* walkTs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkTs(path)
    else if (entry.name.endsWith('.ts')) yield path
  }
}

// 字面量三元组（method, path, permission）；换行/空白宽容。变量形态调用无法静态解析，
// 计入 unmatched 清单供人工复核（不判红——动态注册须走代码评审）。
const callRe = /\bguarded\(\s*['"]([A-Z]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/

const routes = []
const unmatched = []
let totalCalls = 0
for (const file of walkTs(packagesDir)) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  totalCalls += (text.match(/\bguarded\(/g) ?? []).length
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(callRe)
    if (match) routes.push({ file: relative(root, file), line: i + 1, method: match[1], path: match[2], point: match[3] })
  }
}
const matchedCount = routes.length
// guarded( 也出现在类型声明/注释中（rest-gate.ts 接口、注释示例），按行过滤后不相等属正常；
// 只对「含 guarded( 调用但零匹配」的文件提示人工复核
const filesWithCalls = new Set()
for (const file of walkTs(packagesDir)) {
  const text = readFileSync(file, 'utf8')
  if (/\bguarded\(\s*['"]/.test(text)) filesWithCalls.add(file)
}
const filesMatched = new Set(routes.map((route) => join(root, route.file)))
for (const file of filesWithCalls) {
  if (!filesMatched.has(file)) unmatched.push(relative(root, file))
}

const whitelist = new Set(DEMO_READONLY_PERMISSIONS)
const isReadSemantic = (point) => point === 'console.read' || point.endsWith('.read') || point.endsWith('.read-v1')

const readOnly = routes.filter((route) => ['GET', 'HEAD'].includes(route.method))
const gaps = readOnly.filter((route) => !whitelist.has(route.point) && (isReadSemantic(route.point) || route.point === 'console.login'))
const writeGated = readOnly.filter((route) => !whitelist.has(route.point) && !isReadSemantic(route.point) && route.point !== 'console.login')
const covered = readOnly.filter((route) => whitelist.has(route.point))
const leaks = findWritePermissionLeaks()

console.log(`路由声明扫描：guarded( 字面量路由 ${matchedCount} 条（GET/HEAD ${readOnly.length} · 其中演示白名单直接覆盖 ${covered.length}）`)
if (unmatched.length > 0) console.log(`人工复核（文件含 guarded 调用但零字面量匹配）：${unmatched.join('、')}`)
console.log(`写语义 GET 路由（演示态 403，预期行为）：${writeGated.length} 条`)

let failed = false
if (leaks.length > 0) {
  failed = true
  console.error(`✘ 演示白名单混入写/审批/调用类权限点：${leaks.join('、')}`)
}
if (gaps.length > 0) {
  failed = true
  for (const gap of gaps) console.error(`✘ 演示态只读缺口：${gap.method} ${gap.path} → ${gap.point}（${gap.file}:${gap.line}）`)
}
if (matchedCount === 0) {
  failed = true
  console.error('✘ 未扫描到任何 guarded( 字面量路由——扫描器失效或路由注册方式变更，须人工核对')
}
if (failed) process.exit(1)
console.log('✔ 演示只读面审计通过：白名单无写点泄漏，GET/HEAD 路由无只读缺口')
