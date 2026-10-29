/**
 * 原生全局面板页（M5，2026-10-29）：DSH 中央主面板整页 = 同源 iframe 内嵌「完整行业工作台」。
 *
 * 【形态决策（M5 取代 M4 手写简化版）】
 *   M4 曾在本页手写一套「概览/行业空间/战略看板/制造工具箱/宿主连接」的只读简化视图——
 *   功能与独立的 /gate01/panel/ 工作台严重重叠且长期漂移，用户反馈「功能不能藏着掖着」。
 *   M5 起本组件不再复制功能，改为在 DSH 中央主面板内**整页内嵌**同源完整工作台：
 *   ① 样式 100% 保留——内嵌的是面板自身那套「轻科技工业」设计系统（panel.css/iaw.css/mfg.css），
 *      iframe 天然隔离 CSS，宿主 `--dsw-*` token 不会污染面板，面板 reset 也不会污染 DSH；
 *   ② 功能 100% 完整——六个空间（协作/图谱/执行/能力/数据/制造）、连接向导、SSE 实时、
 *      钉钉桥、mfg 工具抽屉与导出，全部由面板自身提供，不在本页复制；
 *   ③ 嵌入形态（?embed=1）只隐藏「面板内再次内嵌 dsh」这一防递归入口（app.js:151），
 *      其余交互（含面板自带 Agent 对话）完整保留。
 *
 * 【为何用 iframe 而非把面板 DOM 搬进 React 树】
 *   面板是零框架的 innerHTML 实现（app.js 3065 行 + mfg.js + wizard.js 等），其 CSS 带
 *   全局 reset（panel.css:15 `*{margin:0;padding:0}`）与 body 级规则（panel.css:39），
 *   且面板脚本直接操作 document.body / window.location——直接挂进 DSH 页面会污染宿主
 *   DOM 与布局。iframe 是唯一既能「样式与功能零改造」又能「隔离副作用」的形态。
 *
 * 【宿主契约】
 *   - 槽位与 id 配对不变：`sidebar.panellist` list 条目 id = `main` keyed 槽 key = PANEL_ID
 *     （client/index.ts 第 ⑥ 项），DSH 点击侧栏行即整页切换中央面板；
 *   - 面板与宿主同源（/gate01/panel/ 由 plugin-dsh-bridge 挂在 /gate01 前缀下），
 *     因此 iframe 内的 rq_sid Cookie、/dsh-bridge/status 会话兑换、免登向导全部照常工作；
 *   - 失败可观测：iframe 的 onLoad 若拿到的是 DSH 壳页 SPA 兜底（标题非 01门），
 *     一律判为失败并给出「独立窗口打开」兜底，绝不静默白屏（历史踩坑：SPA 兜底假 200）。
 *
 * 【版式/token 纪律】外层工具条走 DSH `--dsw-*` token（与宿主同源），零字面量颜色；
 *   类名统一 rgp_ 前缀；样式经组件内 <style> 渲染（卸载即随组件移除，不全局注入）；
 *   全部文案走 t()（rq-card 词典），组件内零硬编码文案。
 * @module @ybkk/plugin-rq-card/client/GatePanelPage
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { PANEL_EMBED_URL, PANEL_URL } from '../wire.ts'

/** 页面完整 props（main keyed 条目：无 owner 契约，只用词典座位）。 */
export type GatePanelPageProps = PropsLocale<'rq-card'>

/** 面板就绪判定：内嵌文档标题含本工作台标识（DSH 壳页 SPA 兜底标题不同，据此判失败）。 */
const PANEL_TITLE_MARK = '01门'

/** 加载判定超时（毫秒）：面板 boot 链含多次串行取数，超时仅作兜底，不阻断正常路径。 */
const LOAD_TIMEOUT_MS = 25_000

// ── 页内样式（外层工具条走 DSH token；面板自身样式在 iframe 内，互不干扰） ────────

const CSS = `
.rgp-root{height:100%;min-width:0;display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.rgp-bar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:0 16px;height:40px;box-sizing:border-box;
  border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.rgp-bar-title{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;line-height:20px;
  font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rgp-bar-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rgp-bar-actions{display:flex;align-items:center;gap:8px;flex:none}
.rgp-btn{height:28px;padding:0 10px;border-radius:var(--dsw-radius-md);font-size:13px;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);transition:background-color .14s ease-out;
  display:inline-flex;align-items:center;gap:6px;text-decoration:none;white-space:nowrap}
.rgp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rgp-btn:active{transform:translateY(1px)}
.rgp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.rgp-frame-wrap{flex:1;min-height:0;position:relative;background:var(--dsw-alias-bg-base)}
.rgp-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-base)}
.rgp-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:12px;padding:24px;text-align:center;background:var(--dsw-alias-bg-base)}
.rgp-overlay-title{font-size:15px;line-height:22px;font-weight:500;margin:0;
  color:var(--dsw-alias-label-primary)}
.rgp-overlay-desc{font-size:13px;line-height:20px;margin:0;max-width:420px;
  color:var(--dsw-alias-label-secondary)}
.rgp-overlay-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:center}
.rgp-spinner{width:20px;height:20px;border-radius:50%;
  border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);
  animation:rgp-spin .8s linear infinite}
@keyframes rgp-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.rgp-spinner{animation:none}}
`

// ── 页面主体 ──────────────────────────────────────────────────────────────────

/** 内嵌相位：加载中 / 就绪 / 失败（失败必有可见信号 + 独立窗口兜底）。 */
type Phase = 'loading' | 'ready' | 'failed'

/**
 * 原生面板页组件（main keyed 槽 occupant）。
 * @param t - 词典绑定（rq-card 座位）。
 */
export function GatePanelPage({ t }: GatePanelPageProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [nonce, setNonce] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)

  /** 重载面板（iframe src 变更 = 全新文档，走完整 boot 链）。 */
  const reload = useCallback(() => {
    setPhase('loading')
    setNonce((value) => value + 1)
  }, [])

  /**
   * onLoad 判定：文档标题含工作台标识 = 面板真页就绪；否则是 DSH 壳页 SPA 兜底
   * （历史坑：壳页对任何路径都返 200，只看 HTTP 状态会假绿），判失败并给兜底出口。
   */
  const onFrameLoad = useCallback(() => {
    let ok = false
    try {
      const doc = frameRef.current?.contentDocument
      const title = doc?.title ?? ''
      ok = title.includes(PANEL_TITLE_MARK)
    } catch {
      ok = false // 跨文档访问受限（极端情况）：按失败处理，给兜底出口
    }
    setPhase(ok ? 'ready' : 'failed')
  }, [])

  // 超时兜底：面板 boot 链含多次串行取数，超时后转为可重试态（不永久卡在加载中）。
  useEffect(() => {
    const timer = setTimeout(() => {
      setPhase((current) => (current === 'loading' ? 'failed' : current))
    }, LOAD_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [nonce])

  const frameSrc = nonce === 0 ? PANEL_EMBED_URL : `${PANEL_EMBED_URL}&_r=${String(nonce)}`

  return (
    <div className="rgp-root">
      <style>{CSS}</style>
      <header className="rgp-bar">
        <div className="rgp-bar-title">
          <span>{t('page.title')}</span>
          <span className="rgp-bar-sub">{t('page.embed.note')}</span>
        </div>
        <div className="rgp-bar-actions">
          <button type="button" className="rgp-btn" onClick={reload}>{t('page.reload')}</button>
          <a className="rgp-btn" href={PANEL_URL} target="_blank" rel="noreferrer">
            {t('page.open.external')}
          </a>
        </div>
      </header>
      <div className="rgp-frame-wrap">
        <iframe
          ref={frameRef}
          className="rgp-frame"
          src={frameSrc}
          title={t('page.title')}
          referrerPolicy="same-origin"
          allow="popups"
          onLoad={onFrameLoad}
        />
        {phase === 'loading' ? (
          <div className="rgp-overlay" role="status">
            <span className="rgp-spinner" aria-hidden="true" />
            <p className="rgp-overlay-title">{t('page.loading')}</p>
            <p className="rgp-overlay-desc">{t('page.loading.hint')}</p>
          </div>
        ) : null}
        {phase === 'failed' ? (
          <div className="rgp-overlay" role="alert">
            <p className="rgp-overlay-title">{t('page.failed.title')}</p>
            <p className="rgp-overlay-desc">{t('page.failed.hint')}</p>
            <div className="rgp-overlay-actions">
              <button type="button" className="rgp-btn" onClick={reload}>{t('state.retry')}</button>
              <a className="rgp-btn" href={PANEL_URL} target="_blank" rel="noreferrer">
                {t('page.open.external')}
              </a>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
