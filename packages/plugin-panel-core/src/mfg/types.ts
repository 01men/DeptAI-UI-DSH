/**
 * 制造工具箱 —— 结果与工具定义协议（自「制造业 AI 工具集」并入，2026-10-19 融合决策）。
 *
 * 协议保持源项目 v1.0 形状不变（ToolResult/Block 判别联合）——并入方只换承载面
 * （Express+React → 01门 面板数据面与零构建 SPA），不动数据契约，使既有金标断言、
 * 导出格式与前端渲染语义零改写：融合成本落在接线，不落在业务。
 */

export type Category =
  | '生产运营'
  | '质量工程'
  | '研发设计'
  | '供应链'
  | '设备运维'
  | '经营财务'
  | '知识与文档'

/** 表单字段：由同一份定义生成网页表单、导入模板与执行期校验（单一事实源）。 */
export type Field = {
  key: string
  label: string
  type: 'number' | 'text' | 'textarea'
  unit?: string
  min?: number
  max?: number
  default: string | number
  help?: string
}

export type Metric = { label: string; value: string | number; unit?: string; tone?: 'good' | 'warn' | 'neutral' }

/** 结果块判别联合：仅此五类，模型不能发任意 HTML/JS（渲染面白名单）。 */
export type Block =
  | { type: 'metrics'; items: Metric[] }
  | { type: 'text'; title: string; content: string }
  | { type: 'table'; title: string; columns: string[]; rows: (string | number)[][] }
  | { type: 'bars'; title: string; items: { label: string; value: number }[]; unit?: string }
  | { type: 'scene'; title: string; dimensions: [number, number, number]; count: number; label: string }

export type ToolResult = {
  version: '1.0'
  runId: string
  toolId: string
  title: string
  createdAt: string
  durationMs: number
  mode: 'calculation' | 'model'
  blocks: Block[]
  warnings: string[]
  input: Record<string, unknown>
}

export type ToolDefinition = {
  id: string
  title: string
  subtitle: string
  category: Category
  icon: string
  color: string
  mode: 'calculation' | 'model'
  tags: string[]
  fields: Field[]
  /** AI 工具的内核标识（对应 quality.ts 的 skills 注册键）。 */
  skill?: string
  accepts?: string[]
}

/** 工具箱目录元信息（模型面按平台网关现状动态求值，不在此静态声明）。 */
export type CatalogMeta = {
  tools: ToolDefinition[]
  targetCount: number
  catalogStatus: string
}