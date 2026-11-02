/**
 * SQLite 集合 → JSON 集合导出（ADR-0001 回滚工具）。
 *
 * 场景：以 PLATFORM_STORAGE=sqlite 运行一段时间后需要回退 JSON 后端时，
 * 把 collections.db 中的最新数据导出为 JSON 集合文件（覆盖同名旧回滚源），
 * 再以默认后端（json）重启即可无缝回退。
 *
 * 用法：
 *   node scripts/storage-export.mjs --data ./data            # 全部集合导出到同一数据目录
 *   node scripts/storage-export.mjs --data ./data --out ./data-json
 *   node scripts/storage-export.mjs --data ./data --only iam:users,authn:tokens
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
function argValue(flag, fallback) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}

const dataDir = resolve(argValue('--data', './data'))
const outDir = resolve(argValue('--out', dataDir))
const only = (argValue('--only', '') ?? '').split(',').map((item) => item.trim()).filter(Boolean)

const dbFile = join(dataDir, 'collections.db')
if (!existsSync(dbFile)) {
  console.error(`未找到 ${dbFile}——该数据目录未以 sqlite 后端运行过，无需导出。`)
  process.exit(1)
}

const db = new DatabaseSync(dbFile, { readOnly: true })
const names = db.prepare('SELECT name FROM collection_meta ORDER BY name').all().map((row) => row.name)
const selected = only.length > 0 ? names.filter((name) => only.includes(name)) : names

mkdirSync(outDir, { recursive: true })
let total = 0
for (const name of selected) {
  const rows = db.prepare('SELECT id, doc FROM collection_docs WHERE name = ? ORDER BY rowid').all(name)
  const file = join(outDir, `${name.replace(/[:*?"<>|]/g, '~')}.json`)
  // 已有同名 JSON（旧回滚源）先挪开，绝不无痕覆盖
  if (existsSync(file)) renameSync(file, `${file}.pre-export-${Date.now()}`)
  writeFileSync(file, JSON.stringify(rows.map((row) => JSON.parse(row.doc)), null, 2), 'utf8')
  console.log(`  ${name} → ${file}（${rows.length} 条）`)
  total += rows.length
}
console.log(`导出完成：${selected.length} 个集合，共 ${total} 条记录。以默认后端（json）重启即完成回退。`)
