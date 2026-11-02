/**
 * 四态执行卡：`tool.call.toolview` 键位槽条目（WP-06 泳道 C 的 C1/C2）。
 *
 * 注册形态与 dsh ui-tool 的原子 toolview 同构（spike §2.3 证据 C3、§4.3 伪代码）：
 * 为元冰可工具名逐一注册 key，未列名的工具自动回落 GenericToolCard（加法式，
 * 不抢占任何已有键位）。四态判定全部经 deriveExecutionState 纯函数（C2 表），
 * 本组件只做纯渲染：
 *   调用中   → 骨架 + 可取消占位（取消通道待宿主半接线，占位钮禁用并说明）
 *   执行中   → 进度脉冲；degraded 附「有点慢，已转后台处理」
 *   已完成   → 结果摘要 + /rq 控制台对应资源页外链（同源带登录态）+ 👍/👎（反馈条另注册）
 *   异常阻断 → 红边条 + 业务文案（原因码 = C3 js/errors.js 的键）+ 行动按钮
 *
 * 【降级防御】对 block/content 的运行时访问全部带形状守卫：上游快照结构变化时
 * 卡片宁可少渲染，也不抛错——slot 边界（reportEntryError）之外再叠一层自律。
 * @module @dsh-ops/plugin-rq-card/client/ExecutionCard
 */

import type { ExecutionState, ExecutionStateInput } from './state.ts'
import type { ExecutionCardProps, ToolCallBlockView } from './slots.ts'
import { CONSOLE_BASE } from '../wire.ts'

/** 工具名前缀 → /rq 控制台资源页（hash 路由；未列名前缀回落工作台）。 */
const ROUTE_FOR_TOOL_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  mcp: '#/mcp',
  nas: '#/nas',
  skill: '#/skills',
  app: '#/apps',
  agent: '#/agents',
  iam: '#/iam',
  authn: '#/authn',
  audit: '#/audit',
  connector: '#/connectors',
  billing: '#/platform',
  market: '#/assets',
  model: '#/platform',
  approval: '#/approvals',
})

/** 阻断原因码 → 行动按钮落地页（C3 文案模块的「行动按钮」列，同源带登录态）。 */
const ROUTE_FOR_REASON: Readonly<Record<string, string>> = Object.freeze({
  'nas-authz-deny': '#/nas-authz',
  'quota-exhausted': '#/approvals',
  'pdp-unreachable': '#/dashboard',
  'breaker-open': '#/mcp',
  down: '#/mcp',
  'binding-invalid': '#/connect',
  'invoke-error': '#/dashboard',
})

/** 按工具名取控制台资源页。 */
function routeForTool(toolName: string): string {
  const prefix = toolName.split('_', 1)[0] ?? ''
  return `${CONSOLE_BASE}${ROUTE_FOR_TOOL_PREFIX[prefix] ?? '#/dashboard'}`
}

/** 结果文本的截断上限（卡片是摘要，不是日志）。 */
const RESULT_TEXT_LIMIT = 600

/**
 * 从定稿结果块提取文本（形状守卫：content 块缺 text 字段时跳过）。
 */
function resultText(block: { content?: unknown }): string {
  const content = block.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const piece of content) {
    if (typeof piece === 'object' && piece !== null
      && 'text' in piece && typeof (piece as { text: unknown }).text === 'string') {
      parts.push((piece as { text: string }).text)
    }
  }
  const text = parts.join('\n').trim()
  return text.length > RESULT_TEXT_LIMIT
    ? `${text.slice(0, RESULT_TEXT_LIMIT)}…`
    : text
}

/** 卡片体（由状态派生部分 + t 词典渲染）。 */
function CardBody({ state, block, toolName, t }: {
  state: ExecutionState
  block: ToolCallBlockView
  toolName: string
  t: (key: never) => string
}) {
  // t 的键来自 rq-card 词典（编译期联合类型）；运行时直接以字符串取词。
  const text = t as (key: string) => string
  switch (state.state) {
    case 'calling':
      return (
        <div className="rq-ecard-skel" aria-busy="true">
          <div className="rq-ecard-skel-line" />
          <div className="rq-ecard-skel-line" />
          <div className="rq-ecard-skel-line" />
          <div className="rq-ecard-foot">
            <button type="button" className="rq-ecard-cancel" disabled title={text('card.cancel.hint')}>
              {text('card.cancel.button')}
            </button>
          </div>
        </div>
      )
    case 'executing':
      return (
        <div aria-busy="true">
          <div className="rq-ecard-pulse" />
          {state.degraded === true && <div className="rq-ecard-degraded">⏳ {text('card.degraded.hint')}</div>}
        </div>
      )
    case 'done': {
      const settled = block as { content?: unknown }
      const summary = resultText(settled)
      return (
        <div>
          {summary !== '' && <div className="rq-ecard-result">{summary}</div>}
          <div className="rq-ecard-foot">
            <a className="rq-ecard-link" href={routeForTool(toolName)} target="_blank" rel="noreferrer">
              {text('card.console.link')} ↗
            </a>
          </div>
        </div>
      )
    }
    case 'blocked': {
      const reason = state.reason ?? 'invoke-error'
      const settled = block as { content?: unknown }
      const summary = 'kind' in block ? resultText(settled) : ''
      return (
        <div>
          <div className="rq-ecard-reason">{text(`card.blocked.${reason}`)}</div>
          {summary !== '' && <div className="rq-ecard-result">{summary}</div>}
          <div className="rq-ecard-foot">
            <a className="rq-ecard-action" href={`${CONSOLE_BASE}${ROUTE_FOR_REASON[reason] ?? '#/dashboard'}`}>
              {text(`card.action.${reason}`)}
            </a>
          </div>
        </div>
      )
    }
    default:
      return null
  }
}

/**
 * 四态执行卡（键位条目组件）。
 * @param props - owner 共享（toolName/block）+ 注入面（deriveState/healthSnapshot）+ 词典。
 */
export function ExecutionCard(props: ExecutionCardProps) {
  const { toolName, block, deriveState, healthSnapshot, t } = props

  // ── 从调用块取生命周期素材（spike §2.5 证据 E3：运行中无 'kind'，定稿 kind:'tool-result'）──
  const hasResult = typeof block === 'object' && block !== null && 'kind' in block
  const resultIsError = hasResult === true
    && typeof (block as { isError: unknown }).isError === 'boolean'
    && (block as { isError: boolean }).isError
  const invokePhase: ExecutionStateInput['invokePhase'] = hasResult ? 'idle' : 'calling'

  // ── C2 表映射：调用生命周期素材 + 注入面健康快照（宿主半接线前为空）──
  const extra = healthSnapshot?.() ?? {}
  const state = deriveState({
    hasResult,
    resultIsError,
    invokePhase,
    ...extra,
  })

  const argsRaw = typeof block === 'object' && block !== null && 'argsRaw' in block
    ? String((block as { argsRaw: unknown }).argsRaw ?? '')
    : ''
  const text = t as (key: string) => string

  return (
    <div className="rq-ecard" data-state={state.state} data-tool={toolName}>
      <div className="rq-ecard-head">
        <span>{toolName}</span>
        <span className="rq-ecard-chip">{text(`card.state.${state.state}`)}</span>
      </div>
      {argsRaw !== '' && (state.state === 'calling' || state.state === 'executing') && (
        <div className="rq-ecard-args">{argsRaw}</div>
      )}
      <CardBody state={state} block={block} toolName={toolName} t={t} />
    </div>
  )
}
