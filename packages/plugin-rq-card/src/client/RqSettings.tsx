/**
 * 设置页「01门宿主」分区（M2）：连接状态丸 + 打开向导/工作台入口。
 *
 * 形态对齐 ui-auth 的 AccountSection（settings.section list 条目）：
 * 状态读取走同源 /gate01/rqcard/link（hostStatus.ts）。
 *
 * 【M5 动作口径】工作台已整页内嵌在 dsh 主界面（原生面板页），因此这里的按钮
 * 优先**切换到 dsh 原生面板**（layout.selectPanel），而不是把用户甩到独立路径；
 * 宿主未注册该面板键位（老宿主）时才回落独立窗口打开。未连接且未登录时
 * 工作台首屏即连接向导——向导与工作台同一入口，避免在注入面重复实现一份表单。
 */
import { useCallback, useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入 settings 壳的 SlotMap merge（settings.section 条目形态）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { fetchHostLink, type HostLinkView } from './hostStatus.ts'
import { PANEL_URL } from '../wire.ts'

/** 注入面：切换到 dsh 原生面板 / 打开独立窗口 / 刷新状态。 */
export interface RqSettingsInjected {
  /** 切换到 dsh 中央主面板的01门页；成功返回 true，老宿主（无键位）返回 false。 */
  select: () => boolean
  open: (url: string) => void
  refresh: () => Promise<HostLinkView | null>
}

/** 分区完整 props（list 条目标准组合）。 */
export type RqSettingsProps = PropsRuntime<'settings.section'>
  & InjectFace<RqSettingsInjected>
  & PropsLocale<'rq-card'>

/** 设置分区组件。 */
export function RqSettings({ select, open, refresh, t }: RqSettingsProps) {
  const [link, setLink] = useState<HostLinkView | null | undefined>(undefined)

  const reload = useCallback(async () => {
    setLink(await refresh())
  }, [refresh])

  useEffect(() => { void reload() }, [reload])

  const mode = link?.mode
  const modeText = mode === 'remote' ? t('settings.mode.remote')
    : mode === 'local' ? t('settings.mode.local')
      : mode === 'none' ? t('settings.mode.none') : '…'
  const probeText = link?.mode === 'remote'
    ? (link.probe?.reachable === true ? t('settings.probe.ok') : t('settings.probe.fail'))
    : null

  /** 进工作台：优先切 dsh 原生面板，失败回落独立窗口。 */
  const gotoWorkbench = useCallback(() => {
    if (select()) return
    open(PANEL_URL)
  }, [select, open])

  return <div className="rq-set">
    <div className="rq-set-row">
      <span className={`rq-set-mode rq-set-mode-${mode ?? 'unknown'}`}>{modeText}</span>
      {link?.mode === 'remote' && link.hubBase
        ? <span className="rq-set-hub">{String(link.hubBase)}{probeText ? ` · ${probeText}` : ''}</span>
        : null}
      <button type="button" className="rq-set-btn" onClick={() => void reload()}>{t('settings.refresh')}</button>
    </div>
    <p className="rq-set-hint">{t('settings.hint')}</p>
    <div className="rq-set-row">
      {mode === 'none'
        ? <button type="button" className="rq-set-btn rq-set-primary" onClick={gotoWorkbench}>{t('settings.open.wizard')}</button>
        : <button type="button" className="rq-set-btn rq-set-primary" onClick={gotoWorkbench}>{t('settings.open.panel')}</button>}
    </div>
  </div>
}
