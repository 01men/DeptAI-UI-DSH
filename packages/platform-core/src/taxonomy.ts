/**
 * 平台资产统一业务分类（2026-10-28 各资产板块对齐）。
 *
 * Skill 市场 / Agent 本体 / AI 应用 / MCP 服务 / A2A 协作目录共用同一套业务域分类，
 * 让业务成员按「我在哪个部门、要解决哪类问题」检索资产，而不是按技术形态。
 * 口径固定为 11 项：财务 / 行政 / 人事 / 销售 / 运营 / 战略 / 生产 / 研发 / 质量 / 制造 / 其他。
 *
 * 遗留分类（旧 Skill 市场的「办公提效/研发效能/…」、外部导入的「人力资源/合作方·…」等）
 * 经 LEGACY_CATEGORY_MAP 对齐到标准项；对齐时原分类值保留进 tags，不丢信息
 * （迁移脚本 scripts/align-asset-categories.mjs 与写入侧 normalize 共用本表）。
 */

export const ASSET_CATEGORIES = ['财务', '行政', '人事', '销售', '运营', '战略', '生产', '研发', '质量', '制造', '其他'] as const

export type AssetCategory = (typeof ASSET_CATEGORIES)[number]

/** 未声明 / 无法对齐时的兜底分类。 */
export const DEFAULT_ASSET_CATEGORY: AssetCategory = '其他'

/**
 * 遗留分类 → 标准分类对齐表。键为历史上出现过的分类原值（精确匹配，去首尾空白）；
 * 「合作方·xxx」等带前缀的伙伴分类按前缀规则统一落「其他」（见 normalizeAssetCategory）。
 */
export const LEGACY_CATEGORY_MAP: Readonly<Record<string, AssetCategory>> = {
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

/** 是否标准分类值。 */
export function isAssetCategory(value: unknown): value is AssetCategory {
  return typeof value === 'string' && (ASSET_CATEGORIES as readonly string[]).includes(value)
}

/**
 * 把任意分类输入对齐到标准分类：标准值原样返回；遗留值查表；「合作方·…」统一落「其他」；
 * 其余（空值 / 未知自定义值）回落 DEFAULT_ASSET_CATEGORY。
 */
export function normalizeAssetCategory(value: unknown): AssetCategory {
  const text = String(value ?? '').trim()
  if (!text) return DEFAULT_ASSET_CATEGORY
  if (isAssetCategory(text)) return text
  if (LEGACY_CATEGORY_MAP[text]) return LEGACY_CATEGORY_MAP[text]!
  if (text.startsWith('合作方')) return DEFAULT_ASSET_CATEGORY
  return DEFAULT_ASSET_CATEGORY
}

/**
 * 分类对齐（写入侧 / 迁移共用）：返回对齐后的分类，以及需要并入 tags 的原值
 * （仅当原值非空且不是标准分类时才保留，避免 tags 里出现与分类重复的词）。
 */
export function alignAssetCategory(value: unknown, tags: readonly string[] = []): { category: AssetCategory; tags: string[] } {
  const original = String(value ?? '').trim()
  const category = normalizeAssetCategory(original)
  const nextTags = [...tags]
  if (original && !isAssetCategory(original) && !nextTags.includes(original)) nextTags.push(original)
  return { category, tags: nextTags }
}

/** 标准分类列表（标准项在前）外加数据里仍存在的遗留值（保证旧记录在筛选条可见）。 */
export function withLegacyCategories(found: Iterable<unknown>): string[] {
  const extras: string[] = []
  for (const item of found) {
    const text = String(item ?? '').trim()
    if (!text || isAssetCategory(text) || extras.includes(text)) continue
    extras.push(text)
  }
  return [...ASSET_CATEGORIES, ...extras]
}
