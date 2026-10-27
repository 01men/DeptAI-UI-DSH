/**
 * 原生全局面板页（M4，2026-10-27）：DSH 中央主面板整页 + 左列导航（240px）+ 右列内容。
 *
 * 【形态硬约束】不得 iframe：整页 React 组件，数据走同源 REST（/gate01/api/*，演示态
 * demoAuth 只读放行）——与工作台 iframe 内嵌（RqWorkbench）并存的两种形态，本页是
 * 「和插件管理页同级」的原生页面（sidebar.panellist 行 + main keyed 面板）。
 *
 * 【版式/token 纪律】全部颜色/圆角/焦点环走 dsw alias token（白名单），零字面量颜色；
 * 类名统一 rgp_ 前缀；样式经组件内 <style> 渲染（卸载即随组件移除，不全局注入）；
 * 全部文案走 t()（rq-card 词典），组件内零硬编码文案。
 *
 * 【可访问性】左列 role=tablist/role=tab + aria-selected，↑/↓/Home/End 换位、Enter 生效；
 * 焦点环 :focus-visible；prefers-reduced-motion 时关闭过渡；切换导航保持滚动位置。
 * @module @ybkk/plugin-rq-card/client/GatePanelPage
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { KeyboardEvent, ReactNode } from 'react'
import { CONSOLE_BASE, PANEL_URL } from '../wire.ts'
import { fetchHostLink, type HostLinkView } from './hostStatus.ts'
import { GateNavIcon } from './GateIcon.tsx'

/** 页面完整 props（main keyed 条目：无 owner 契约，只用词典座位）。 */
export type GatePanelPageProps = PropsLocale<'rq-card'>

// ── 数据形状（同源 REST 响应的 data 字段，均为防御式可选） ─────────────────────

interface IndustryItem {
  code: string
  name: string
  sub?: string
  state: 'active' | 'pending' | 'locked'
  graphLoaded?: boolean
}

interface BoardCard { id: string; title: string; description?: string; badge?: string }

interface BoardData {
  platform?: string
  availablePlatforms?: string[]
  totalPacks?: number
  cards?: BoardCard[]
  assets?: { appsOnline?: number; agentsOnline?: number; skillsPublished?: number; mcpServing?: number }
  funnel?: { exposed?: number; clicked?: number; invoked?: number; completed?: number }
}

interface MfgCatalog {
  tools?: Array<{ id: string; title: string; subtitle?: string; category?: string; mode?: string; released?: boolean }>
  modelReady?: boolean
  model?: string
  status?: string
}

type HostView = HostLinkView | null

// ── 取数层（{ok,data} 包装解包；失败抛 Error(message)，视图转错误态） ────────────

async function fetchPanelData<T>(path: string): Promise<T> {
  const response = await fetch(`${CONSOLE_BASE}${path}`)
  const payload: { ok?: boolean; data?: T; error?: { message?: string } } | null = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
  }
  return payload.data as T
}

/**
 * 单页数据的加载态机：loading / ready / error + 手动重试。
 * deps 变化（如看板平台切换）自动重取；loader 本体不必引用稳定。
 */
function usePanelResource<T>(loader: () => Promise<T>, deps: readonly unknown[]): {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    loader().then(
      (next) => { if (alive) { setData(next); setLoading(false) } },
      (cause) => { if (alive) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false) } },
    )
    return () => { alive = false }
    // deps 为空数组的调用点：组件级一次取数；loader 内联重建不影响（不在依赖里）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps])
  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { data, error, loading, reload }
}

// ── 页内样式（全部 token 化；rgp_ 前缀隔离） ──────────────────────────────────

const CSS = `
.rgp-root{height:100%;overflow:auto;box-sizing:border-box;display:flex;flex-direction:column;
  gap:32px;padding:0 clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary)}
.rgp-root>*{width:100%;max-width:960px;margin:0 auto}
.rgp-head{padding-top:28px;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));
  display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.rgp-title{font-size:20px;line-height:28px;font-weight:500;margin:0}
.rgp-subtitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:4px 0 0}
.rgp-head-actions{display:flex;gap:16px;align-items:center}
.rgp-btn{height:32px;padding:0 12px;border-radius:var(--dsw-radius-md);font-size:13px;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);transition:background-color .14s ease-out}
.rgp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rgp-btn:active{transform:translateY(1px)}
.rgp-btn-primary{background:var(--dsw-alias-state-business-primary);
  color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.rgp-chip{font-size:12px;line-height:18px;padding:3px 10px;border-radius:999px;white-space:nowrap;
  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.rgp-chip-ok{color:var(--dsw-alias-state-success-primary)}
.rgp-chip-warn{color:var(--dsw-alias-state-warn-primary)}
.rgp-chip-off{color:var(--dsw-alias-state-error-primary)}
.rgp-body{display:grid;grid-template-columns:240px minmax(0,1fr);gap:24px;align-items:start}
.rgp-nav{position:sticky;top:28px;display:flex;flex-direction:column;gap:2px}
.rgp-nav-group{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);
  padding:8px 10px 4px;margin:0}
.rgp-nav-item{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:none;
  border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;text-align:left;
  font-size:14px;line-height:20px;color:var(--dsw-alias-label-secondary);width:100%;
  transition:background-color .14s ease-out}
.rgp-nav-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rgp-nav-item[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:500;
  background:var(--dsw-alias-bg-layer-3)}
.rgp-content{min-width:0;display:flex;flex-direction:column;gap:24px}
.rgp-section{margin:0}
.rgp-section-title{font-size:14px;line-height:20px;font-weight:500;margin:0 0 8px;
  color:var(--dsw-alias-label-primary)}
.rgp-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.rgp-row{display:flex;align-items:center;gap:14px;padding:8px;min-height:56px;
  border-radius:var(--dsw-radius-xl);transition:background-color .14s ease-out}
.rgp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rgp-row + .rgp-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.rgp-row-icon{width:48px;height:48px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
  border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font-size:16px;font-weight:500}
.rgp-row-main{min-width:0;flex:1}
.rgp-row-title{font-size:14px;line-height:20px;font-weight:500;margin:0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rgp-row-desc{font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:2px 0 0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rgp-row-side{display:flex;gap:8px;align-items:center;flex-shrink:0}
.rgp-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.rgp-stat{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);
  padding:14px 16px;background:var(--dsw-alias-bg-layer-2)}
.rgp-stat-label{font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}
.rgp-stat-value{font-size:22px;line-height:30px;font-weight:500;margin:4px 0 0;
  color:var(--dsw-alias-label-primary)}
.rgp-stat-note{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:2px 0 0}
.rgp-error{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);margin:0;
  display:flex;gap:12px;align-items:center}
.rgp-empty{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);margin:0}
.rgp-skel{height:12px;border-radius:6px;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-3));
  animation:rgp-breathe 1.4s ease-in-out infinite}
.rgp-skel-row{display:flex;flex-direction:column;gap:8px;padding:8px 0}
.rgp-seg{display:flex;gap:4px;flex-wrap:wrap}
.rgp-seg-item{height:28px;padding:0 10px;border-radius:var(--dsw-radius-md);font-size:13px;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary)}
.rgp-seg-item[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);font-weight:500}
.rgp-kv{display:flex;gap:8px;font-size:13px;line-height:20px;margin:0;flex-wrap:wrap}
.rgp-kv dt{color:var(--dsw-alias-label-tertiary)}
.rgp-kv dd{margin:0;color:var(--dsw-alias-label-primary)}
.rgp-hint{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);margin:0}
.rgp-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.rgp-btn:focus-visible,.rgp-nav-item:focus-visible,.rgp-seg-item:focus-visible{
  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px}
@media (max-width:1080px){
  .rgp-body{grid-template-columns:minmax(0,1fr)}
  .rgp-nav{position:static;flex-direction:row;overflow-x:auto;gap:4px;padding-bottom:4px}
  .rgp-nav-group{display:none}
  .rgp-nav-item{width:auto;flex-shrink:0}
}
@keyframes rgp-breathe{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){
  .rgp-skel{animation:none;opacity:.7}
  .rgp-btn,.rgp-nav-item,.rgp-row{transition:none}
}
`

// ── 通用小视图 ────────────────────────────────────────────────────────────────

/** 打开完整面板（新标签页；弹窗被拦截时静默）。 */
function openPanel(): void {
  try { window.open(PANEL_URL, '_blank', 'noopener') } catch { /* 静默 */ }
}

/** 三态取数视图骨架：加载（骨架条）/错误（一句话 + 重试）/就绪（render）。 */
function ResourceView<T>({ res, render, empty, t }: {
  res: { data: T | null; error: string | null; loading: boolean; reload: () => void }
  render: (data: T) => ReactNode
  empty?: boolean
  t: GatePanelPageProps['t']
}) {
  if (res.loading) {
    return (
      <div className="rgp-skel-row" role="status">
        <div className="rgp-skel" style={{ width: '62%' }} />
        <div className="rgp-skel" style={{ width: '88%' }} />
        <div className="rgp-skel" style={{ width: '44%' }} />
        <span className="rgp-hint">{t('state.loading')}</span>
      </div>
    )
  }
  if (res.error !== null) {
    return (
      <p className="rgp-error" role="alert">
        <span>{t('state.error')}：{res.error}</span>
        <button type="button" className="rgp-btn" onClick={res.reload}>{t('state.retry')}</button>
      </p>
    )
  }
  if (empty) return <p className="rgp-empty">{t('state.empty')}</p>
  return res.data === null ? null : render(res.data)
}

// ── 各导航页 ──────────────────────────────────────────────────────────────────

function OverviewPage({ t }: GatePanelPageProps) {
  const industries = usePanelResource(
    async () => (await fetchPanelData<{ industries?: IndustryItem[] }>('/api/panel/industries')).industries ?? [],
    [],
  )
  const board = usePanelResource(() => fetchPanelData<BoardData>('/api/panel/board'), [])
  const mfg = usePanelResource(async () => {
    const response = await fetch(`${CONSOLE_BASE}/api/panel/mfg/catalog`)
    if (response.status === 404) return null // 远端旧版宿主无 mfg 模块：诚实缺席而非报错
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
    return payload.data as MfgCatalog
  }, [])
  const host = usePanelResource(() => fetchHostLink(), [])
  const industryList = industries.data ?? []
  const cards = board.data?.cards ?? []
  const tools = mfg.data?.tools ?? []
  return (
    <>
      <div className="rgp-stats">
        <div className="rgp-stat">
          <p className="rgp-stat-label">{t('overview.stat.registered')}</p>
          <p className="rgp-stat-value">{industries.loading ? '…' : String(industryList.length)}</p>
          <p className="rgp-stat-note">
            {`${t('overview.stat.active')} ${String(industryList.filter((item) => item.state === 'active').length)}`}
          </p>
        </div>
        <div className="rgp-stat">
          <p className="rgp-stat-label">{t('overview.stat.cards')}</p>
          <p className="rgp-stat-value">{board.loading ? '…' : String(cards.length)}</p>
          <p className="rgp-stat-note">{`${t('overview.stat.platforms')} ${String(board.data?.availablePlatforms?.length ?? 0)}`}</p>
        </div>
        <div className="rgp-stat">
          <p className="rgp-stat-label">{t('overview.stat.tools')}</p>
          <p className="rgp-stat-value">{mfg.loading ? '…' : mfg.data === null ? '—' : String(tools.length)}</p>
          <p className="rgp-stat-note">{`${t('overview.stat.model')} ${
            mfg.data === null ? '—' : mfg.data.modelReady ? t('overview.stat.on') : t('overview.stat.off')}`}</p>
        </div>
        <div className="rgp-stat">
          <p className="rgp-stat-label">{t('overview.host.title')}</p>
          <p className="rgp-stat-value">
            {host.loading ? '…'
              : host.data?.mode === 'remote' ? t('settings.mode.remote')
              : host.data?.mode === 'local' ? t('settings.mode.local')
              : t('settings.mode.none')}
          </p>
        </div>
      </div>
      <ul className="rgp-list">
        {(['industries', 'board', 'mfg', 'host'] as const).map((key) => (
          <li className="rgp-row" key={key}>
            <span className="rgp-row-icon"><GateNavIcon kind={key} /></span>
            <div className="rgp-row-main">
              <p className="rgp-row-title">{t(`overview.${key}.title`)}</p>
              <p className="rgp-row-desc">{t(`overview.${key}.desc`)}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="rgp-actions">
        <button type="button" className="rgp-btn rgp-btn-primary" onClick={openPanel}>
          {t('overview.open.panel')}
        </button>
      </div>
    </>
  )
}

function IndustriesPage({ t }: GatePanelPageProps) {
  const res = usePanelResource(
    async () => (await fetchPanelData<{ industries?: IndustryItem[] }>('/api/panel/industries')).industries ?? [],
    [],
  )
  const list = res.data ?? []
  return (
    <ResourceView
      res={res}
      empty={list.length === 0}
      t={t}
      render={(data) => (
        <ul className="rgp-list">
          {data.map((item) => (
            <li className="rgp-row" key={item.code}>
              <span className="rgp-row-icon" aria-hidden="true">{item.name.slice(0, 1)}</span>
              <div className="rgp-row-main">
                <p className="rgp-row-title">{item.name}</p>
                <p className="rgp-row-desc">{item.sub ?? item.code}</p>
              </div>
              <div className="rgp-row-side">
                <span className={`rgp-chip ${item.state === 'active' ? 'rgp-chip-ok' : item.state === 'pending' ? 'rgp-chip-warn' : ''}`}>
                  {t(`industries.state.${item.state}`)}
                </span>
                <span className="rgp-chip">{item.graphLoaded ? t('industries.graph.loaded') : t('industries.graph.missing')}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    />
  )
}

function BoardPage({ t }: GatePanelPageProps) {
  const [platform, setPlatform] = useState<string | null>(null)
  const res = usePanelResource(
    () => fetchPanelData<BoardData>(`/api/panel/board${platform === null ? '' : `?platform=${encodeURIComponent(platform)}`}`),
    [platform],
  )
  const assets = res.data?.assets ?? {}
  const funnel = res.data?.funnel ?? {}
  const cards = res.data?.cards ?? []
  return (
    <ResourceView
      res={res}
      empty={cards.length === 0}
      t={t}
      render={(view) => (
        <>
          {(view.availablePlatforms?.length ?? 0) > 1 ? (
            <div className="rgp-seg" role="group" aria-label={t('board.platform')}>
              {(view.availablePlatforms ?? []).map((code) => (
                <button key={code} type="button" className="rgp-seg-item"
                  aria-pressed={code === view.platform}
                  onClick={() => { setPlatform(code) }}>
                  {code}
                </button>
              ))}
            </div>
          ) : null}
          <section className="rgp-section">
            <h3 className="rgp-section-title">{t('board.assets.title')}</h3>
            <div className="rgp-stats">
              <div className="rgp-stat"><p className="rgp-stat-label">{t('board.assets.apps')}</p><p className="rgp-stat-value">{String(assets.appsOnline ?? 0)}</p></div>
              <div className="rgp-stat"><p className="rgp-stat-label">{t('board.assets.agents')}</p><p className="rgp-stat-value">{String(assets.agentsOnline ?? 0)}</p></div>
              <div className="rgp-stat"><p className="rgp-stat-label">{t('board.assets.skills')}</p><p className="rgp-stat-value">{String(assets.skillsPublished ?? 0)}</p></div>
              <div className="rgp-stat"><p className="rgp-stat-label">{t('board.assets.mcp')}</p><p className="rgp-stat-value">{String(assets.mcpServing ?? 0)}</p></div>
            </div>
          </section>
          <section className="rgp-section">
            <h3 className="rgp-section-title">{t('board.funnel.title')}</h3>
            <div className="rgp-stats">
              <div className="rgp-stat"><p className="rgp-stat-label">{t('board.funnel.exposed')}</p><p className="rgp-stat-value">{String(funnel.exposed ?? 0)}</p></div>
              <div className="rgp-stat"><p className="rgp-stat-label">{t('board.funnel.clicked')}</p><p className="rgp-stat-value">{String(funnel.clicked ?? 0)}</p></div>
              <div className="rgp-stat"><p className="rgp-stat-label">{t('board.funnel.invoked')}</p><p className="rgp-stat-value">{String(funnel.invoked ?? 0)}</p></div>
              <div className="rgp-stat"><p className="rgp-stat-label">{t('board.funnel.completed')}</p><p className="rgp-stat-value">{String(funnel.completed ?? 0)}</p></div>
            </div>
          </section>
          <section className="rgp-section">
            <h3 className="rgp-section-title">{`${t('board.cards.title')}（${String(cards.length)}）`}</h3>
            <ul className="rgp-list">
              {cards.slice(0, 12).map((card) => (
                <li className="rgp-row" key={card.id}>
                  <span className="rgp-row-icon" aria-hidden="true">{card.title.slice(0, 1)}</span>
                  <div className="rgp-row-main">
                    <p className="rgp-row-title">{card.title}</p>
                    <p className="rgp-row-desc">{card.description ?? ''}</p>
                  </div>
                  {card.badge ? <div className="rgp-row-side"><span className="rgp-chip">{card.badge}</span></div> : null}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    />
  )
}

function MfgPage({ t }: GatePanelPageProps) {
  const res = usePanelResource(async () => {
    const response = await fetch(`${CONSOLE_BASE}/api/panel/mfg/catalog`)
    if (response.status === 404) throw new Error('HTTP 404') // 远端旧版宿主：mfg 模块未并入
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
    return payload.data as MfgCatalog
  }, [])
  const tools = res.data?.tools ?? []
  return (
    <ResourceView
      res={res}
      empty={tools.length === 0}
      t={t}
      render={(data) => (
        <>
          <div className="rgp-stats">
            <div className="rgp-stat">
              <p className="rgp-stat-label">{t('mfg.status.title')}</p>
              <p className="rgp-stat-value">{String(tools.length)}</p>
              <p className="rgp-stat-note">{data.status ?? ''}</p>
            </div>
            <div className="rgp-stat">
              <p className="rgp-stat-label">{t('overview.stat.model')}</p>
              <p className="rgp-stat-value">{data.modelReady ? t('mfg.model.ready') : t('mfg.model.missing')}</p>
              {data.model ? <p className="rgp-stat-note">{data.model}</p> : null}
            </div>
          </div>
          <section className="rgp-section">
            <h3 className="rgp-section-title">{t('mfg.tools.title')}</h3>
            <ul className="rgp-list">
              {tools.map((tool) => (
                <li className="rgp-row" key={tool.id}>
                  <span className="rgp-row-icon" aria-hidden="true">{tool.title.slice(0, 1)}</span>
                  <div className="rgp-row-main">
                    <p className="rgp-row-title">{tool.title}</p>
                    <p className="rgp-row-desc">{[tool.category, tool.subtitle].filter(Boolean).join(' · ')}</p>
                  </div>
                  <div className="rgp-row-side">
                    <span className="rgp-chip">{tool.mode === 'calculation' ? t('mfg.tool.calculation') : t('mfg.tool.ai')}</span>
                    <span className={`rgp-chip ${tool.released ? 'rgp-chip-ok' : 'rgp-chip-warn'}`}>
                      {tool.released ? t('mfg.tool.released') : t('mfg.tool.unreleased')}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    />
  )
}

function HostPage({ t }: GatePanelPageProps) {
  const [link, setLink] = useState<HostView>(null)
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    setLoading(true)
    setLink(await fetchHostLink())
    setLoading(false)
  }, [])
  useEffect(() => { void reload() }, [reload])
  const mode = link?.mode
  const probe = link?.probe?.reachable === true ? t('host.probe.ok') : link?.probe?.reachable === false ? t('host.probe.fail') : null
  return (
    <>
      {loading ? (
        <div className="rgp-skel-row" role="status">
          <div className="rgp-skel" style={{ width: '52%' }} />
          <span className="rgp-hint">{t('state.loading')}</span>
        </div>
      ) : (
        <section className="rgp-section">
          <h3 className="rgp-section-title">{t('nav.host')}</h3>
          <dl className="rgp-kv">
            <dt>{t('host.mode.title')}</dt>
            <dd>
              <span className={`rgp-chip ${mode === 'none' ? 'rgp-chip-off' : 'rgp-chip-ok'}`}>
                {mode === 'remote' ? t('settings.mode.remote') : mode === 'local' ? t('settings.mode.local') : t('settings.mode.none')}
              </span>
            </dd>
            {mode === 'remote' && link?.hubBase ? (
              <>
                <dt>{t('host.hub.title')}</dt>
                <dd>{String(link.hubBase)}</dd>
              </>
            ) : null}
            {probe !== null ? (
              <>
                <dt>{t('host.probe.title')}</dt>
                <dd>{probe}</dd>
              </>
            ) : null}
          </dl>
        </section>
      )}
      <p className="rgp-hint">{t('host.hint')}</p>
      <div className="rgp-actions">
        <button type="button" className="rgp-btn" onClick={() => { void reload() }}>{t('host.refresh')}</button>
        <button type="button" className="rgp-btn rgp-btn-primary" onClick={openPanel}>
          {mode === 'none' ? t('host.open.wizard') : t('page.open.external')}
        </button>
      </div>
    </>
  )
}

// ── 页面主体 ──────────────────────────────────────────────────────────────────

type NavKey = 'overview' | 'industries' | 'board' | 'mfg' | 'host'

const NAV_GROUPS: Array<{ titleKey: 'nav.group.workbench' | 'nav.group.host'; items: readonly NavKey[] }> = [
  { titleKey: 'nav.group.workbench', items: ['overview', 'industries', 'board', 'mfg'] },
  { titleKey: 'nav.group.host', items: ['host'] },
]

const NAV_KEYS: readonly NavKey[] = NAV_GROUPS.flatMap((group) => group.items)

/** 原生面板页组件（main keyed 槽 occupant）。 */
export function GatePanelPage({ t }: GatePanelPageProps) {
  const [tab, setTab] = useState<NavKey>('overview')
  const rootRef = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)
  const itemRefs = useRef(new Map<NavKey, HTMLButtonElement>())

  // 切换导航不丢滚动位置（规范 §5）：换位前存 scrollTop，渲染后还原。
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root !== null) root.scrollTop = savedScroll.current
  }, [tab])

  const selectTab = useCallback((next: NavKey) => {
    const root = rootRef.current
    if (root !== null) savedScroll.current = root.scrollTop
    setTab(next)
  }, [])

  // ↑/↓/Home/End 换位并把焦点跟到新选中行（Enter/Space 是按钮原生行为）。
  const onNavKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const index = NAV_KEYS.indexOf(tab)
    let next = -1
    if (event.key === 'ArrowDown') next = (index + 1) % NAV_KEYS.length
    else if (event.key === 'ArrowUp') next = (index - 1 + NAV_KEYS.length) % NAV_KEYS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = NAV_KEYS.length - 1
    if (next < 0) return
    event.preventDefault()
    const nextKey = NAV_KEYS[next]!
    selectTab(nextKey)
    itemRefs.current.get(nextKey)?.focus()
  }, [tab, selectTab])

  const registerItem = useCallback((key: NavKey, node: HTMLButtonElement | null) => {
    if (node === null) itemRefs.current.delete(key)
    else itemRefs.current.set(key, node)
  }, [])

  return (
    <div className="rgp-root" ref={rootRef}>
      <style>{CSS}</style>
      <header className="rgp-head">
        <div>
          <h1 className="rgp-title">{t('page.title')}</h1>
          <p className="rgp-subtitle">{t('page.intro')}</p>
        </div>
        <div className="rgp-head-actions">
          <button type="button" className="rgp-btn" onClick={openPanel}>
            {t('page.open.external')}
          </button>
        </div>
      </header>
      <div className="rgp-body">
        <nav className="rgp-nav" role="tablist" aria-label={t('nav.aria')} onKeyDown={onNavKeyDown}>
          {NAV_GROUPS.map((group) => (
            <div key={group.titleKey} role="presentation">
              <p className="rgp-nav-group">{t(group.titleKey)}</p>
              {group.items.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className="rgp-nav-item"
                  ref={(node) => { registerItem(key, node) }}
                  onClick={() => { selectTab(key) }}
                >
                  <GateNavIcon kind={key} />
                  <span>{t(`nav.${key}`)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <section className="rgp-content" role="tabpanel" aria-label={t('content.aria')}>
          {tab === 'overview' ? <OverviewPage t={t} />
            : tab === 'industries' ? <IndustriesPage t={t} />
            : tab === 'board' ? <BoardPage t={t} />
            : tab === 'mfg' ? <MfgPage t={t} />
            : <HostPage t={t} />}
        </section>
      </div>
    </div>
  )
}
