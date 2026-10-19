/**
 * 制造工具箱 —— 结果导出（自「制造业 AI 工具集」src/core/export.ts 并入，服务端化）。
 *
 * 源项目在浏览器侧用 Blob 下载；面板形态改为服务端产出文本、由浏览器落盘
 * （同一份渲染逻辑同时服务导出与「结果转上下文继续分析」，避免两处格式漂移）。
 * 支持面与源项目一致：JSON 与 Markdown 两种，不伪造未实现的办公格式导出。
 */
import type { ToolResult } from './types.ts'

/** ToolResult → Markdown（源项目 markdown() 等价，逐块渲染）。 */
export function toMarkdown(result: ToolResult): string {
  const body = result.blocks.map((block) => {
    switch (block.type) {
      case 'metrics':
        return block.items.map((item) => `- ${item.label}：${item.value} ${item.unit ?? ''}`).join('\n')
      case 'text':
        return `## ${block.title}\n\n${block.content}`
      case 'bars':
        return `## ${block.title}\n\n${block.items.map((item) => `- ${item.label}: ${item.value} ${block.unit ?? ''}`).join('\n')}`
      case 'table':
        return `## ${block.title}\n\n${[block.columns, block.columns.map(() => '---'), ...block.rows]
          .map((row) => `| ${row.map((cell) => String(cell).replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ')} |`)
          .join('\n')}`
      case 'scene':
        return `## ${block.title}\n\n${block.label}：${block.dimensions.join(' × ')} mm；数量 ${block.count}。`
      default:
        return ''
    }
  }).join('\n\n')
  const warnings = result.warnings.map((warning) => `> ${warning}`).join('\n')
  return `# ${result.title}\n\n${result.createdAt}\n\n${body}\n\n${warnings}\n\n运行编号：${result.runId}\n`
}

/** 导出文件名（带时间戳片段，便于多次运行区分）。 */
export function exportFileName(result: ToolResult, extension: 'json' | 'md'): string {
  const stamp = result.createdAt.replace(/[:.]/g, '-').slice(0, 19)
  return `${result.toolId}-${stamp}.${extension}`
}