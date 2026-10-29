/**
 * 浏览器半：slot 注册 + 降级探测（WP-06 交付物 1/3，spike §4.3 伪代码落地；M2/M3 扩展）。
 *
 * 【注入面】
 *   ① 四态执行卡：为01门工具名（RQ_TOOL_NAMES）逐一注册 `tool.call.toolview`
 *      键位条目——加法式，未列名的工具回落 dsh 的 GenericToolCard；
 *   ② 👍/👎 反馈条：`conversation.chat.assistant-actions` list 条目
 *      （id 'rq-feedback'，与 dsh 自带 'feedback' 并存，order 20 排其后）；
 *   ③ 设置分区「01门宿主」（M2）：`settings.section` list 条目（id 'rq-hostlink'，
 *      ui-auth 同款挂载位）——连接状态丸 + 打开向导/工作台；
 *   ④ 会话视图 Tab「01门工作台」（M3）：`conversation.view` list 条目
 *      （id 'rq-workbench'，ui-trajectory 同款挂载位）——整页内嵌 /rq/panel/；
 *   ⑤ 未连接宿主角标（M3「主动连接」）：宿主连接为 none 时 `shell.overlay`
 *      挂可点击提醒，点击 selectPanel 到原生面板页（未连接且未登录时面板首屏即连接向导）；
 *   ⑥ 原生全局面板（M4，2026-10-27）：`sidebar.panellist` 侧栏入口行 + `main` keyed
 *      中央面板（同 id 配对，宿主原生页面模型）——整页左右分栏行业工作台，插件管理页同款。
 *
 * 【降级预案（spike §5 的 1-4 条，本 apply 逐条落实）】
 *   1. 声明依赖全部走 ctx.slots.inject：目标槽未声明时回调挂起、属主包声明提交即同步
 *      触发（纪元机制）——上游改名/删槽 = 卡片静默消失，不崩宿主（机制天然兜底）；
 *   2. kind 校验在注入回调内执行（QA BUG-G-01 根因修复 / 交接清单 H1）：其一，rc.7 客户端
 *      服务面的 spec 查询 API 是 `spec(key)`，旧 bundle 探测用的 `specDynamic` 只存在于
 *      pure core——服务面上永远 undefined，五处 probe 必然全数落空（确定性根因）；其二，
 *      spec 查询是点时刻语义，apply 时属主包尚未声明槽也返回 undefined（时序根因，条目
 *      并发创建、激活序不作保证）。现 apply 一律无条件 inject；回调触发即声明已在场，此时
 *      校验 spec.kind 才有意义；任一不满足 → 置降级标志（DEGRADED 数组）+ 记
 *      __RQ_CARD_DIAG__ 台账（attempts[].stage 可定性）；
 *   3. boot 面探测：window.__DSH_BOOT__ / bundle 404 属于「机制整体不存在」，
 *      该场景下本 bundle 根本不会执行，无需代码面处理（见 spike §5 第 3 条）；
 *   4. apply 全体 try/catch：任何抛错吞掉并置降级标志；slot 边界另有
 *      reportEntryError 让位机制（单卡崩溃只让出单元格）——双保险；
 *   5.（兜底在宿主工具侧）工具结果文本始终携带 markdown 摘要 + /rq 链接，
 *      见 src/index.ts 的 summarizeForToolResult 契约；
 *   6. 降级标志在场时经 shell.overlay 挂「卡片插件未生效」角标（槽在才挂）。
 * @module @ybkk/plugin-rq-card/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only：拉入 ui-conversation 的 SlotMap merge（assistant-actions 条目）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only：拉入 locale 插件的 Context merge（ctx.locale）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createElement } from 'react'
import { deriveExecutionState } from './state.ts'
import { RqFeedbackController } from './controller.ts'
import { ExecutionCard } from './ExecutionCard.tsx'
import { RqFeedback } from './RqFeedback.tsx'
import { RqSettings } from './RqSettings.tsx'
import { RqWorkbench } from './RqWorkbench.tsx'
import { GatePanelPage } from './GatePanelPage.tsx'
import { GatePanelIcon } from './GateIcon.tsx'
import { fetchHostLink } from './hostStatus.ts'
import type { RqFeedbackInjected, RqToolviewInjected } from './slots.ts'
import { en, zh } from './locales.ts'
import { ensureStyles } from './styles.ts'
import {
  DEGRADED_BADGE_ID, FEEDBACK_ENTRY_ID, PANEL_ID, PANEL_SIDEBAR_ORDER, PANEL_URL, SLOT_ASSISTANT_ACTIONS,
  SLOT_MAIN, SLOT_OVERLAY, SLOT_PANELLIST, SLOT_SETTINGS, SLOT_TOOLVIEW, SLOT_VIEW,
  TOOLVIEW_ENTRY_PREFIX, UNLINKED_BADGE_ID,
} from '../wire.ts'

export type { ExecutionState, ExecutionStateInput, BlockedReason } from './state.ts'
export type { RqFeedbackView, RqToolviewInjected, RqFeedbackInjected } from './slots.ts'
export { deriveExecutionState } from './state.ts'

/** 词典命名空间（locales.ts 的 LocaleNamespaceMap 座位名）。 */
const NS = 'rq-card'

/** 插件 id（浏览器半装载 id = 宿主 boot 图行 id；issue #1 修复后 = 根包名 @ybkk/gate-01）。 */
const PLUGIN_ID = '@ybkk/gate-01'

/**
 * 01门工具名名录（各插件包 tools.ts 的登记清单，截至 WP-06）。
 * 四态执行卡为这些工具注册键位；新增工具不自动获得卡片（回落 GenericToolCard），
 * 在此追加一行即可覆盖。核心主角是 mcp_invoke（资产调运四态主战场）。
 */
const RQ_TOOL_NAMES: readonly string[] = [
  // 资产调运（四态主战场）
  'mcp_invoke', 'mcp_service_list', 'mcp_health_check', 'mcp_metrics', 'mcp_deploy', 'mcp_offline',
  // NAS（文件/知识目录）
  'nas_list', 'nas_get', 'nas_health_check', 'nas_fs_list', 'nas_fs_search', 'nas_fs_upload', 'nas_fs_mkdir', 'nas_fs_delete',
  // 技能
  'skill_search', 'skill_submit', 'skill_approve', 'skill_publish', 'skill_install', 'skill_deprecate',
  // 应用
  'app_list', 'app_metrics', 'app_cost_breakdown', 'app_topology', 'app_metrics_report',
  // Agent
  'agent_list', 'agent_get', 'agent_bind_user', 'agent_metrics', 'agent_metrics_report', 'agent_offline',
  // 身份与访问
  'iam_user_list', 'iam_user_create', 'iam_user_freeze', 'iam_user_reset_password', 'iam_org_tree',
  'iam_org_create', 'iam_org_update', 'iam_role_list', 'iam_sync_run', 'iam_conflict_list',
  'authn_token_issue', 'authn_token_list', 'authn_token_revoke', 'authn_credential_create',
  'authn_credential_rotate', 'authn_credential_scopes',
  // 连接器 / 模型 / 计费 / 审计 / 市场 / 审批
  'connector_catalog_search', 'connector_connection_list', 'connector_execute', 'connector_run_list', 'connector_perm_group_list',
  'model_list', 'billing_wallet_balance', 'audit_logs', 'audit_alerts_list', 'audit_alerts_read_all',
  'audit_cost_report', 'market_plugin_list', 'approval_decide',
  // 面板（部门工作台 + 战略看板）
  'panel_agents_list', 'panel_msg_send', 'panel_task_create', 'panel_task_transition',
  'panel_scene_diag', 'panel_widget_data', 'panel_agent_invoke', 'panel_board_digest',
  // 宿主连接（M2）
  'rq_host_status',
]

/** 降级原因台账（spike §5 第 2/4 条的「降级标志」）。 */
const DEGRADED: string[] = []

/** 记一条降级原因（console 留痕，便于运维发现；绝不抛出）。 */
function markDegraded(what: string, error?: unknown): void {
  DEGRADED.push(what)
  console.warn(`[rq-card] degraded (${what}):`, error ?? 'target slot unavailable')
}

/** 同一原因只记一次（toolview 键位批量注册下 kind 失配会 N 连击，台账去噪）。 */
const DEGRADED_SEEN = new Set<string>()
function markDegradedOnce(what: string, error?: unknown): void {
  if (DEGRADED_SEEN.has(what)) return
  DEGRADED_SEEN.add(what)
  markDegraded(what, error)
}

/**
 * __RQ_CARD_DIAG__ 台账补记（QA BUG-G-01 复测取证 / 交接清单 H1）：banner 闭包记录装载
 * 半（installed / materialize-missing 等），这里补注入半——apply 时槽未声明记
 * `inject-pending:<key>`（挂起等声明）、回调触发记 `inject-materialized:<key>`、kind 失配记
 * `inject-kind-mismatch:<key>`。复测定性：attempts 停在 inject-pending = 声明永不到来
 * （属主包改名/未装载）；停在 materialized 但 UI 缺失 = 注册后被宿主消费链丢弃。
 * 台账不可用（无 banner 的直跑环境）时静默跳过，绝不影响主流程。
 */
const DIAG_SEEN = new Set<string>()
function diagNote(stage: string): void {
  if (DIAG_SEEN.has(stage)) return
  DIAG_SEEN.add(stage)
  try {
    const diag = (globalThis as { __RQ_CARD_DIAG__?: { attempts: unknown[] } }).__RQ_CARD_DIAG__
    diag?.attempts.push({ at: new Date().toISOString(), stage })
  } catch { /* 诊断台账不可用：忽略 */ }
}

/** 安全执行一段注入动作；抛错吞掉并记降级（spike §5 第 4 条）。 */
function safely(what: string, action: () => void): void {
  try {
    action()
  } catch (error) {
    markDegraded(what, error)
  }
}

/**
 * 注入回调体全保护：回调可能在声明波次内（属主包 register 调用栈中）执行，宿主对
 * 延迟路径的回调抛错经 queueMicrotask 重抛——未捕获异常会污染宿主页面。回调内一切
 * 异常（kind 校验之外的 register 校验失败等）必须在此折叠为降级记录，绝不外逃。
 */
function injectBody(what: string, body: () => (() => void) | undefined): () => void {
  try {
    return body() ?? (() => {})
  } catch (error) {
    markDegraded(what, error)
    return () => {}
  }
}

/**
 * 槽 spec 探测的安全封装（API 不存在/抛错都折叠为 undefined）。
 *
 * 【H1 确定性根因（QA BUG-G-01）】rc.7 客户端 SlotRegistry 服务面暴露的查询 API 是
 * `spec(key)`（runtime/src/client/slots.ts 的 SlotsService），`specDynamic` 只存在于
 * pure core（ui-slots SlotCore）——旧 bundle 对服务面 `specDynamic?.()` 探测永远
 * undefined，五处槽 probe 必然全数落空、全部静默降级。现优先走 `spec`（探测仅发生在
 * 注入回调内=声明已提交，结果可信），并兼容 `specDynamic` 以容忍 dsh 版本差异。
 */
function probeSpec(ctx: ClientContext, slot: string): { kind?: string } | undefined {
  try {
    const face = ctx.slots as {
      spec?: (name: string) => { kind?: string } | undefined
      specDynamic?: (name: string) => { kind?: string } | undefined
    }
    const spec = typeof face.spec === 'function' ? face.spec(slot) : face.specDynamic?.(slot)
    return typeof spec === 'object' && spec !== null ? spec : undefined
  } catch {
    return undefined
  }
}

/** 必需服务：slot 注册表 + 词典 + 面板导航（M4 原生面板页 selectPanel）。 */
export const inject = ['slots', 'locale', 'layout']

/** 降级角标的 DOM 直挂兜底（不依赖 slots；QA BUG-G-01/T-14：失效必须有用户可见信号）。 */
function mountDegradedDomBadge(): void {
  safely('degraded-dom-badge', () => {
    if (typeof document === 'undefined') return
    if (document.querySelector('.rq-card-dom-badge')) return
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'rq-card-dom-badge'
    el.textContent = '01门卡片未生效（部分能力不可用）'
    el.title = `降级原因：${DEGRADED.join('；')}（点击刷新重试；详情见控制台 [rq-card] 日志）`
    el.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:6px 12px;border-radius:14px;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;font-size:12px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.12)')
    el.onclick = () => { location.reload() }
    document.body.appendChild(el)
  })
}

/**
 * 客户端插件体。
 * @param ctx - 客户端根 context。
 */
export function apply(ctx: ClientContext): void {
  // 样式表先落（幂等；无 document 环境自动跳过）。
  safely('styles', () => { ensureStyles() })

  // 词典注册。
  safely('locale', () => {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rq-card: dictionaries')
  })

  // ── ① 四态执行卡：无条件 inject + 回调内 kind 校验（纪元机制，见头注第 2 条）──
  for (const tool of RQ_TOOL_NAMES) {
    safely(`toolview:${tool}`, () => {
      ctx.slots.inject(SLOT_TOOLVIEW, () => injectBody(`toolview:${tool}`, () => {
        const spec = probeSpec(ctx, SLOT_TOOLVIEW)
        if (spec?.kind !== 'keyed') {
          markDegradedOnce(`${SLOT_TOOLVIEW} spec missing or not keyed`, spec)
          diagNote('inject-kind-mismatch:' + SLOT_TOOLVIEW)
          return undefined
        }
        diagNote('inject-materialized:' + SLOT_TOOLVIEW)
        return ctx.slots.register({
          name: SLOT_TOOLVIEW,
          key: tool,
          id: `${TOOLVIEW_ENTRY_PREFIX}${tool}`,
          locale: NS,
          inject: (): RqToolviewInjected => ({
            // C2 表映射的唯一入口；healthSnapshot 为宿主半后续接线点。
            deriveState: deriveExecutionState,
          }),
        }, ExecutionCard)
      }))
      // inject 返回后 spec 仍缺席 = 回调已挂起等声明（reconcile 只在声明在场时同步触发）
      if (probeSpec(ctx, SLOT_TOOLVIEW) === undefined) diagNote('inject-pending:' + SLOT_TOOLVIEW)
    })
  }

  // ── ② 👍/👎 反馈条：list 条目，与 dsh 自带 'feedback' 并存 ──
  safely('assistant-actions', () => {
    ctx.slots.inject(SLOT_ASSISTANT_ACTIONS, () => injectBody('assistant-actions', () => {
      const spec = probeSpec(ctx, SLOT_ASSISTANT_ACTIONS)
      if (spec?.kind !== 'list') {
        markDegraded(`${SLOT_ASSISTANT_ACTIONS} spec missing or not list`, spec)
        diagNote('inject-kind-mismatch:' + SLOT_ASSISTANT_ACTIONS)
        return undefined
      }
      diagNote('inject-materialized:' + SLOT_ASSISTANT_ACTIONS)
      const controllers = new Map<SessionId, RqFeedbackController>()
      const controllerFor = (sessionId: SessionId): RqFeedbackController => {
        let controller = controllers.get(sessionId)
        if (controller === undefined) {
          controller = new RqFeedbackController()
          controllers.set(sessionId, controller)
        }
        return controller
      }
      const dispose = ctx.slots.register({
        name: SLOT_ASSISTANT_ACTIONS,
        id: FEEDBACK_ENTRY_ID,
        order: 20,
        locale: NS,
        inject: (sessionId): RqFeedbackInjected => {
          const controller = controllerFor(sessionId)
          return {
            hooks: { rqfb: controller },
            rate: (messageId, score, note) => controller.rate(messageId, score, note),
          }
        },
      }, RqFeedback)
      return () => {
        dispose()
        controllers.clear()
      }
    }))
    if (probeSpec(ctx, SLOT_ASSISTANT_ACTIONS) === undefined) diagNote('inject-pending:' + SLOT_ASSISTANT_ACTIONS)
  })

  // ── ③ 降级角标：无条件注入 overlay 条目，组件渲染期读 DEGRADED 决定显隐（spike §5 第 6 条）──
  // QA BUG-G-01/T-14：注入失效必须有用户可见信号，绝不静默消失——真实 dsh web 曾四项能力全失
  // 且无任何提示。降级原因在 boot 声明波次内落账、角标组件在其后渲染，渲染期读取即为终值；
  // overlay 槽 kind 失配或整批声明永不到来时走 DOM 直挂兜底（下方 mountDegradedDomBadge）。
  let overlayMaterialized = false
  safely('overlay-badge', () => {
    ctx.slots.inject(SLOT_OVERLAY, () => injectBody('overlay-badge', () => {
      const spec = probeSpec(ctx, SLOT_OVERLAY)
      if (spec?.kind !== 'list') {
        markDegraded(`${SLOT_OVERLAY} spec missing or not list`, spec)
        diagNote('inject-kind-mismatch:' + SLOT_OVERLAY)
        mountDegradedDomBadge()
        return undefined
      }
      overlayMaterialized = true
      diagNote('inject-materialized:' + SLOT_OVERLAY)
      return ctx.slots.register({
        name: SLOT_OVERLAY,
        id: DEGRADED_BADGE_ID,
        order: 90,
      }, function RqCardDegradedBadge() {
        // 无 props 依赖：任何 slot 契约变化都只会让角标空白，不会抛错。
        // 本文件是 .ts（非 tsx），故用 createElement 而非 JSX 字面量。
        if (DEGRADED.length === 0) return null
        return createElement('span', { className: 'rq-badge', title: `降级原因：${DEGRADED.join('；')}` }, '01门卡片未生效（纯文本模式）')
      })
    }))
    if (probeSpec(ctx, SLOT_OVERLAY) === undefined) diagNote('inject-pending:' + SLOT_OVERLAY)
  })
  // 终局兜底：apply 后 10s overlay 注入仍未落地且确有降级原因（属主包整批未声明/改名）
  // → 不等 slots，直接挂 DOM 角标。
  const fallbackTimer = setTimeout(() => {
    if (!overlayMaterialized && DEGRADED.length > 0) {
      diagNote('degraded-dom-badge-fallback')
      mountDegradedDomBadge()
    }
  }, 10_000)
  ;(fallbackTimer as { unref?: () => void }).unref?.()

  // ── ④ 设置分区「01门宿主」（M2）：状态丸 + 打开向导/工作台（ui-auth 同款挂载位）──
  const t = (() => { try { return ctx.locale.bind(NS) } catch { return undefined } })()
  safely('settings-section', () => {
    ctx.slots.inject(SLOT_SETTINGS, () => injectBody('settings-section', () => {
      const spec = probeSpec(ctx, SLOT_SETTINGS)
      if (spec?.kind !== 'list') {
        markDegraded(`${SLOT_SETTINGS} spec missing or not list`, spec)
        diagNote('inject-kind-mismatch:' + SLOT_SETTINGS)
        return undefined
      }
      diagNote('inject-materialized:' + SLOT_SETTINGS)
      return ctx.slots.register({
        name: SLOT_SETTINGS,
        id: 'rq-hostlink',
        order: 30,
        ...(t ? { label: () => t('settings.nav') } : {}),
        locale: NS,
        inject: (): object => ({
          // M5：工作台已整页内嵌在 dsh 主界面，设置分区按钮直接切换原生面板；
          // 宿主未注册该面板键位（老宿主）时返回 false，由组件回落独立窗口打开。
          select: (): boolean => {
            try {
              const layout = (ctx as { layout?: { selectPanel?: (id: string) => void } }).layout
              if (typeof layout?.selectPanel !== 'function') return false
              layout.selectPanel(PANEL_ID)
              return true
            } catch {
              return false
            }
          },
          open: (url: string) => { try { window.open(url, '_blank', 'noopener') } catch { /* 拦截弹窗时静默 */ } },
          refresh: () => fetchHostLink(),
        }),
      }, RqSettings)
    }))
    if (probeSpec(ctx, SLOT_SETTINGS) === undefined) diagNote('inject-pending:' + SLOT_SETTINGS)
  })

  // ── ⑤ 会话视图 Tab「01门工作台」（M3）：整页内嵌 /rq/panel/（ui-trajectory 同款挂载位）──
  safely('workbench-view', () => {
    ctx.slots.inject(SLOT_VIEW, () => injectBody('workbench-view', () => {
      const spec = probeSpec(ctx, SLOT_VIEW)
      if (spec?.kind !== 'list') {
        markDegraded(`${SLOT_VIEW} spec missing or not list`, spec)
        diagNote('inject-kind-mismatch:' + SLOT_VIEW)
        return undefined
      }
      diagNote('inject-materialized:' + SLOT_VIEW)
      return ctx.slots.register({
        name: SLOT_VIEW,
        id: 'rq-workbench',
        order: 20,
        ...(t ? { label: () => t('view.workbench') } : {}),
        locale: NS,
        inject: (): object => ({}),
      }, RqWorkbench)
    }))
    if (probeSpec(ctx, SLOT_VIEW) === undefined) diagNote('inject-pending:' + SLOT_VIEW)
  })

  // ── ⑥ 原生全局面板（M4，2026-10-27）：侧栏入口 + 中央主面板，同 id 配对 ──
  // DSH 原生页面模型（插件管理页同款）：sidebar.panellist list 条目渲染侧栏行，
  // main keyed 槽的 key = 同一 PANEL_ID——宿主点击侧栏行即整页切换中央面板；
  // 程序化跳转走 ctx.layout.selectPanel(PANEL_ID)，不自己造路由、不监听侧栏点击。
  safely('main-panel', () => {
    ctx.slots.inject(SLOT_MAIN, () => injectBody('main-panel', () => {
      const spec = probeSpec(ctx, SLOT_MAIN)
      if (spec?.kind !== 'keyed') {
        markDegraded(`${SLOT_MAIN} spec missing or not keyed`, spec)
        diagNote('inject-kind-mismatch:' + SLOT_MAIN)
        return undefined
      }
      diagNote('inject-materialized:' + SLOT_MAIN)
      return ctx.slots.register({
        name: SLOT_MAIN,
        key: PANEL_ID,
        locale: NS,
      }, GatePanelPage)
    }))
    if (probeSpec(ctx, SLOT_MAIN) === undefined) diagNote('inject-pending:' + SLOT_MAIN)
  })
  safely('sidebar-panel-entry', () => {
    ctx.slots.inject(SLOT_PANELLIST, () => injectBody('sidebar-panel-entry', () => {
      const spec = probeSpec(ctx, SLOT_PANELLIST)
      if (spec?.kind !== 'list') {
        markDegraded(`${SLOT_PANELLIST} spec missing or not list`, spec)
        diagNote('inject-kind-mismatch:' + SLOT_PANELLIST)
        return undefined
      }
      diagNote('inject-materialized:' + SLOT_PANELLIST)
      return ctx.slots.register({
        name: SLOT_PANELLIST,
        id: PANEL_ID,
        order: PANEL_SIDEBAR_ORDER,
        ...(t ? { label: () => t('panel') } : {}),
        locale: NS,
      }, GatePanelIcon)
    }))
    if (probeSpec(ctx, SLOT_PANELLIST) === undefined) diagNote('inject-pending:' + SLOT_PANELLIST)
  })

  // ── ⑦ 未连接角标（M3「主动连接」）：宿主连接为 none 时在全局浮层提醒，点击进向导 ──
  safely('unlinked-badge', () => {
    ctx.slots.inject(SLOT_OVERLAY, () => injectBody('unlinked-badge', () => {
      const spec = probeSpec(ctx, SLOT_OVERLAY)
      if (spec?.kind !== 'list') return undefined
      let disposed = false
      void fetchHostLink().then((link) => {
        if (disposed || link?.mode !== 'none') return
        ctx.slots.register({
          name: SLOT_OVERLAY,
          id: UNLINKED_BADGE_ID,
          order: 80,
        }, function RqUnlinkedBadge() {
          return createElement('button', {
            type: 'button',
            className: 'rq-unlinked',
            // 首选整页切换到本插件面板（未连接时面板首屏即连接向导）；
            // main 键位未注册（老宿主）时回落新开浏览器页。
            onClick: () => {
              try {
                const layout = (ctx as { layout?: { selectPanel?: (id: string) => void } }).layout
                if (typeof layout?.selectPanel === 'function') {
                  layout.selectPanel(PANEL_ID)
                  return
                }
              } catch { /* 键位缺席/服务不可用：回落 window.open */ }
              try { window.open(PANEL_URL, '_blank', 'noopener') } catch { /* 静默 */ }
            },
          }, '01门：未连接宿主，点击打开向导')
        })
      })
      return () => { disposed = true }
    }))
  })

  // 【冒烟自证（spike 风险 R8 的首个联调里程碑）】boot 后可在控制台确认：
  //   window.__DSH_BOOT__ 含 { id: '@ybkk/gate-01', ... } 图行，
  //   且本日志出现——两件事齐了，说明「空插件上链」成立。
  console.info('[rq-card] client plugin applied:', PLUGIN_ID)
}
