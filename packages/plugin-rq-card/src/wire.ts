/**
 * @ybkk/plugin-rq-card —— 通道常量与载荷类型（wire 层）。
 *
 * 【浏览器安全】本文件被宿主半与浏览器半共同消费：只允许常量与纯类型，
 * 零 Node 内建、零包依赖——可被任意一侧（含浏览器 bundle）内联而不泄漏
 * 运行时身份（对齐 dsh tsdown.client.ts 的 INLINE_SAFE 判据）。
 *
 * 【数据回流选型（spike §4.3 二选一）】走同源 REST：浏览器直接 fetch 到
 * plugin-dsh-bridge 已挂在 /gate01 前缀的01门数据面，复用01门自身鉴权（rq_sid
 * Cookie）与审计；不新增宿主 RPC 通道（connection.rpc 的 loopback 判定在
 * 反代/远端访问场景有不确定性，spike 风险 R6）。
 */

/** 01门数据面对外前缀（plugin-dsh-bridge mountPath，单进程单入口）。 */
export const CONSOLE_BASE = '/gate01'

/** 👍/👎 反馈薄端点（同源 REST 相对路径）。端点本体由 WP-07 实现
 * （POST → usage.record 零价快照，主体经绑定身份归因）；端点未上线期间
 * 前端调用会得到 404，控制器按「失败静默」处理，不打扰会话。 */
export const FEEDBACK_ENDPOINT = `${CONSOLE_BASE}/api/usage/feedback`

/** 反馈评分（WP-07 契约：score 只有两值）。 */
export type FeedbackScore = 'up' | 'down'

/** POST /gate01/api/usage/feedback 请求体（note 可选；不传即纯评分）。 */
export interface FeedbackPayload {
  messageId: string
  score: FeedbackScore
  note?: string
}

/** 反馈端点的最小应答形态（薄端点允许空体：空体按成功解释）。 */
export interface FeedbackReply {
  ok?: boolean
}

/** 反馈提交结果：传输层失败不抛出，折叠为 ok:false（调用方静默降级）。 */
export type FeedbackResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** 本插件注册的 slot 名（与 dsh rc.7 SlotMap 对齐，spike §3.2 名录）。 */
export const SLOT_TOOLVIEW = 'tool.call.toolview' as const
export const SLOT_ASSISTANT_ACTIONS = 'conversation.chat.assistant-actions' as const
export const SLOT_OVERLAY = 'shell.overlay' as const
/** M2：设置页「01门宿主」分区（ui-auth 的 AccountSection 同款挂载位）。 */
export const SLOT_SETTINGS = 'settings.section' as const
/** M3：会话视图 Tab 环（ui-trajectory 同款挂载位）——「01门工作台」整页内嵌面板。 */
export const SLOT_VIEW = 'conversation.view' as const
/** M4：原生全局面板——侧栏入口（list）+ 中央主面板（keyed），同 id 配对（2026-10-27）。 */
export const SLOT_MAIN = 'main' as const
export const SLOT_PANELLIST = 'sidebar.panellist' as const

/** 宿主连接状态端点（同源根绝对：/gate01 挂载之下的免登向导命名空间）。 */
export const LINK_ENDPOINT = `${CONSOLE_BASE}/rqcard/link` as const

/** 01门面板入口（同源；?embed=1 = 被 dsh 视图 Tab 内嵌形态，面板侧据此做嵌套防护）。 */
export const PANEL_URL = `${CONSOLE_BASE}/panel/` as const
export const PANEL_EMBED_URL = `${PANEL_URL}?embed=1` as const

/**
 * 原生面板页 id（M4）：sidebar.panellist 条目 id 与 main 槽 key 必须同值——宿主据此
 * 在点击侧栏行时切换中央主面板。取 'rq-gate01'，避开保留键 conversation 与官方
 * 面板（plugins / schedule）。
 */
export const PANEL_ID = 'rq-gate01' as const

/** 侧栏行位次：官方入口 插件=0、定时任务=10，插件页从 20 起（规范约定 ≥20）。 */
export const PANEL_SIDEBAR_ORDER = 20 as const

/** 向导端点调用头（服务端 CSRF 防线，hostlink.ts 文件头第 1 条）。 */
export const RQCARD_CALL_HEADER = 'x-rqcard-call' as const

/** 反馈条在 assistant-actions list 槽的条目 id：与 dsh 自带 'feedback'（order 10）并存。 */
export const FEEDBACK_ENTRY_ID = 'rq-feedback' as const

/** 执行卡在 tool.call.toolview 键位槽的条目 id 前缀（实际条目 id = 前缀 + 工具名）。 */
export const TOOLVIEW_ENTRY_PREFIX = 'rq-tool-' as const

/** 降级角标在 shell.overlay list 槽的条目 id（spike §5 第 6 条）。 */
export const DEGRADED_BADGE_ID = 'rq-card-degraded' as const

/** 未连接宿主角标在 shell.overlay list 槽的条目 id（M3「主动连接」提醒）。 */
export const UNLINKED_BADGE_ID = 'rq-card-unlinked' as const
