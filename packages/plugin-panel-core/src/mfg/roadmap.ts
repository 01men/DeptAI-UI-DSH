/**
 * 制造工具箱 —— 100 项选题清单（自「制造业 AI 工具集」src/core/roadmap.json 并入）。
 *
 * 数据来源与口径（源项目 docs/architecture.md，并入后不改写）：
 *   - PMO Excel 工作表 `19_AI原生组织建设_场景清单` 第 2–296 行（295 条记录）；
 *   - PDF《场景化、图谱化推进重点行业数字化转型的参考指引（2025版）》62 页，第 2–6 页框架、
 *     第 37–39 页行业图谱；
 *   - 100 项为「基于原场景的产品拆分建议」，**不是原文逐项列出的 100 个工具**；
 *     原表项目「已完成」状态不继承为本项目交付状态。
 *
 * 诚实边界的机器可读化：本文件只读，不做任何「规划中 → 已实现」的自动推断；
 * 条目的 implemented-calculation / model-validation-pending / planned 状态逐条来自数据本身。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type RoadmapSource = {
  kind: string
  sheet: string
  row: number
  department: string
  originalScenario: string
  originalStatus: string
}

export type RoadmapItem = {
  id: string
  title: string
  group: string
  priority: string
  kernel: string
  renderer: string
  inputContract: string
  workflow: string
  acceptance: string
  status: 'implemented-calculation' | 'model-validation-pending' | 'planned'
  implementation?: string
  sources: RoadmapSource[]
  pdfReferences: Array<{ page: number; relation: string }>
  deliveryBoundary: string
  caveat: string
}

export type Roadmap = {
  version: string
  sourceWorkbook: string
  sourceSheet: string
  sourceRows: number
  sourceStatusCounts: Record<string, number>
  pdfSource: string
  pdfPages: number
  frameworkPages: number[]
  industryPages: number[]
  tools: RoadmapItem[]
}

let cached: Roadmap | undefined

/** 加载选题清单（JSON 与随附包同目录，经 import.meta 解析——与 seed/demo-content.json 同规）。 */
export function loadRoadmap(): Roadmap {
  if (cached) return cached
  const path = fileURLToPath(new URL('./roadmap.json', import.meta.url))
  cached = JSON.parse(readFileSync(path, 'utf8')) as Roadmap
  return cached
}

/** 分组清单（图谱页按业务场景浏览用；保持数据内出现顺序）。 */
export function roadmapGroups(roadmap: Roadmap): string[] {
  return [...new Set(roadmap.tools.map((item) => item.group))]
}

/** 状态中文标签（展示层单一事实源；未知状态原样返回，不吞错）。 */
export const ROADMAP_STATUS_LABELS: Record<string, string> = {
  'implemented-calculation': '计算内核已实现',
  'model-validation-pending': '待模型验收',
  planned: '规划中',
}