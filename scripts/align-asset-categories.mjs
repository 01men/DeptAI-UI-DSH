#!/usr/bin/env node
/**
 * 资产分类对齐迁移（2026-10-28 各资产板块标签分类统一）：
 * 把 skill~skills.json 里遗留分类（办公提效/研发效能/通用/合作方·…等）对齐到平台
 * 标准 11 项（财务/行政/人事/销售/运营/战略/生产/研发/质量/制造/其他），
 * 原分类值保留进 tags（不丢信息）。
 *
 * 口径与 platform-core/src/taxonomy.ts 的 alignAssetCategory 一致（此处内联同表，
 * 因运行脚本为纯 Node 无法直接 import TS；改表时两处同步）。
 *
 * 用法：node scripts/align-asset-categories.mjs [dataDir ...]（缺省 data data-demo）
 * 幂等：已是标准分类的记录原样跳过；重复执行无副作用。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ASSET_CATEGORIES = ['财务', '行政', '人事', '销售', '运营', '战略', '生产', '研发', '质量', '制造', '其他']

const LEGACY_CATEGORY_MAP = {
  // 旧 Skill 市场内置分类
  '办公提效': '行政',
  '研发效能': '研发',
  '客户服务': '销售',
  '数据分析': '运营',
  '人事行政': '人事',
  '市场情报': '销售',
  '法务合规': '行政',
  '通用': '其他',
  // 外部 Skill 目录导入分类
  '人力资源': '人事',
  'HR': '人事',
  '组织建设': '人事',
  '法务': '行政',
  '合规': '行政',
  '效率': '行政',
  '办公': '行政',
  '市场': '销售',
  '营销': '销售',
  '客户支持': '销售',
  '客服': '销售',
  '数据': '运营',
  '经营分析': '运营',
  '产品管理': '研发',
  '产品': '研发',
  '设计': '研发',
  '工程': '研发',
  '技术': '研发',
  '生物研究': '研发',
  '科研': '研发',
  '质检': '质量',
  '品控': '质量',
  '供应链': '生产',
  '采购': '生产',
  '企业检索': '其他',
  '插件管理': '其他',
  'PDF 工具': '其他',
  '小微企业': '其他',
  '会计': '财务',
  '税务': '财务',
}

/** 与 normalizeAssetCategory 同口径：标准值原样；遗留值查表；合作方前缀/未知值落「其他」。 */
function normalizeCategory(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return '其他'
  if (ASSET_CATEGORIES.includes(text)) return text
  if (LEGACY_CATEGORY_MAP[text]) return LEGACY_CATEGORY_MAP[text]
  if (text.startsWith('合作方')) return '其他'
  return '其他'
}

function alignSkillsFile(file) {
  const raw = readFileSync(file, 'utf8')
  const payload = JSON.parse(raw)
  const records = Array.isArray(payload) ? payload : payload.items
  if (!Array.isArray(records)) {
    console.log(`  跳过 ${file}（非记录数组）`)
    return
  }
  let changed = 0
  const mappingSeen = new Map()
  for (const record of records) {
    const original = String(record.category ?? '').trim()
    const next = normalizeCategory(original)
    if (original && original !== next) {
      mappingSeen.set(original, next)
      record.category = next
      const tags = Array.isArray(record.tags) ? record.tags : []
      if (!tags.includes(original)) tags.push(original)
      record.tags = tags
      changed++
    }
  }
  if (changed > 0) {
    writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  }
  console.log(`  ${file}：对齐 ${changed}/${records.length} 条`)
  for (const [from, to] of [...mappingSeen.entries()].sort()) console.log(`    ${from} → ${to}`)
}

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['data', 'data-demo']
for (const dir of dirs) {
  // Skill：遗留分类 → 标准分类（原值保留进 tags）
  const file = join(resolve(dir), 'skill~skills.json')
  try {
    readFileSync(file)
  } catch {
    console.log(`  跳过 ${file}（不存在）`)
    continue
  }
  alignSkillsFile(file)

  // MCP 服务：存量记录无 category 字段 → 补「其他」（记录显式化，读侧不再依赖兜底）
  const mcpFile = join(resolve(dir), 'mcp~services.json')
  try {
    const payload = JSON.parse(readFileSync(mcpFile, 'utf8'))
    const records = Array.isArray(payload) ? payload : payload.items
    if (Array.isArray(records)) {
      let patched = 0
      for (const record of records) {
        if (record.category === undefined) {
          record.category = normalizeCategory(record.category)
          patched++
        }
      }
      if (patched > 0) writeFileSync(mcpFile, JSON.stringify(payload, null, 2) + '\n')
      console.log(`  ${mcpFile}：补缺省分类 ${patched}/${records.length} 条`)
    }
  } catch {
    console.log(`  跳过 ${mcpFile}（不存在或非 JSON）`)
  }
}
console.log('分类对齐迁移完成。')
