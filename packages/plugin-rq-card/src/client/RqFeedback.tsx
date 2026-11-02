/**
 * 👍/👎 反馈条：`conversation.chat.assistant-actions` list 槽条目（WP-06 交付物 6）。
 *
 * 与 dsh 自带的 'feedback' 条目并存（id: 'rq-feedback'，order 20 排在其后）：
 * 自带条目把评价落 dsh 的 messageFeedback Remote；本条目把同一次评价经**同源
 * REST** 打到元冰可数据面 `POST /rq/api/usage/feedback`（WP-07 薄端点，落
 * usage.record 零价快照并按绑定身份归因）——两路并存，互不替代。
 *
 * 【失败静默】端点未上线/网络失败时控制器只 console 留痕，本组件不渲染任何
 * 错误（降级不打扰会话）。提交成功后短暂显示「已记录」确认。
 * @module @dsh-ops/plugin-rq-card/client/RqFeedback
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RqFeedbackProps } from './slots.ts'

/** 「已记录」确认的展示时长（毫秒）。 */
const DONE_HINT_MS = 1800

/** 注入面钩子的最小使用形态（框架标准 kit：hooks.{name} → use{Name}）。 */
type RqfbHook = (
  selector: (view: { items: ReadonlyMap<string, { score: string } | undefined> }) => { score: string } | undefined,
) => { score: string } | undefined

/**
 * 每条定稿 assistant 消息的 👍/👎 控件。
 * @param props - owner 的 messageId + 注入面（rqfb 钩子/rate 动词）+ 词典。
 */
export function RqFeedback(props: RqFeedbackProps) {
  const { messageId, rate, t } = props
  // 注入面 hooks.rqfb 展开为 useRqfb（框架标准 kit 的绑定惯例，对齐自带反馈条的 useFeedback）。
  const maybeHook = (props as { useRqfb?: unknown }).useRqfb
  const useRqfb = typeof maybeHook === 'function' ? (maybeHook as RqfbHook) : null
  const text = t as (key: string) => string

  // 乐观态订阅：优先用注入面钩子；形状不可用时视图退化为无钩子渲染（按钮仍可点，
  // 只是选中态不回显——降级优先于报错）。
  const item = useRqfb?.((view) => view.items.get(messageId))

  const [doneHint, setDoneHint] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const onRate = useCallback((score: 'up' | 'down') => {
    if (item?.score === score) return // 同分重复点击 no-op（控制器侧同样幂等）
    void rate(messageId, score).then(() => {
      if (alive.current) {
        setDoneHint(true)
        setTimeout(() => { if (alive.current) setDoneHint(false) }, DONE_HINT_MS)
      }
    })
  }, [item?.score, messageId, rate])

  const likeLabel = text('fb.like')
  const dislikeLabel = text('fb.dislike')

  return (
    <span className="rq-fb" data-rq-feedback="">
      <button
        type="button"
        className="rq-fb-btn"
        aria-label={likeLabel}
        title={likeLabel}
        aria-pressed={item?.score === 'up' || undefined}
        data-active={item?.score === 'up' || undefined}
        onClick={() => { onRate('up') }}
      >
        👍
      </button>
      <button
        type="button"
        className="rq-fb-btn"
        aria-label={dislikeLabel}
        title={dislikeLabel}
        aria-pressed={item?.score === 'down' || undefined}
        data-active={item?.score === 'down' || undefined}
        onClick={() => { onRate('down') }}
      >
        👎
      </button>
      {doneHint && <span className="rq-fb-done" role="status">{text('fb.done')}</span>}
    </span>
  )
}
