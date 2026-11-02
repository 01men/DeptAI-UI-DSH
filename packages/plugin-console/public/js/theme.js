/** 界面风格偏好独立于业务平台 data-platform；不会影响权限与宿主连接。 */
import rqI18n from './i18n.js'

export const UI_THEME_KEY = 'ybk_console_ui_theme'
export const UI_THEMES = [
  { id: 'classic', label: '经典 · 原版' },
  { id: 'clear', label: '澄明 · 经营总览' },
  { id: 'graph', label: '星图 · 协作关系' },
  { id: 'night', label: '夜航 · 治理观察' },
  { id: 'crystal', label: '冰晶 · 协同全景' },
]

export function currentUiTheme() {
  const value = document.documentElement.dataset.uiTheme
  return UI_THEMES.some((theme) => theme.id === value) ? value : 'classic'
}

export function setUiTheme(value) {
  const theme = UI_THEMES.some((item) => item.id === value) ? value : 'classic'
  document.documentElement.dataset.uiTheme = theme
  try { localStorage.setItem(UI_THEME_KEY, theme) } catch { /* 隐私模式下保持当前页面有效 */ }
  const select = document.querySelector('#ui-theme-switcher')
  if (select) select.value = theme
  document.querySelectorAll('[data-ui-theme-choice]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.uiThemeChoice === theme))
  })
  document.dispatchEvent(new CustomEvent('ybk-ui-theme-change', { detail: { theme } }))
  return theme
}

/** 驾驶舱提供单击即生效的主题快捷入口；顶栏切换器在所有页面可用。 */
export function mountThemeQuickSwitcher(host) {
  if (!host) return
  host.className = 'ui-theme-quick'
  host.setAttribute('role', 'group')
  host.setAttribute('aria-label', rqI18n.t('切换界面主题'))
  const label = document.createElement('span')
  label.className = 'ui-theme-quick-label'
  label.textContent = rqI18n.t('界面主题')
  host.replaceChildren(label)
  for (const theme of UI_THEMES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ui-theme-choice'
    button.dataset.uiThemeChoice = theme.id
    button.setAttribute('aria-pressed', String(currentUiTheme() === theme.id))
    const dot = document.createElement('span')
    dot.className = 'ui-theme-swatch'
    dot.setAttribute('aria-hidden', 'true')
    button.append(dot, document.createTextNode(rqI18n.t(theme.label)))
    button.addEventListener('click', () => setUiTheme(theme.id))
    host.appendChild(button)
  }
}

export function replayUiTheme() {
  let stored = 'classic'
  try { stored = localStorage.getItem(UI_THEME_KEY) || stored } catch { /* 默认经典 */ }
  document.documentElement.dataset.uiTheme = UI_THEMES.some((item) => item.id === stored) ? stored : 'classic'
}

export function mountThemeSwitcher(host) {
  if (!host) return
  const select = document.createElement('select')
  select.id = 'ui-theme-switcher'
  select.className = 'ui-theme-switcher'
  select.setAttribute('aria-label', rqI18n.t('切换界面主题'))
  select.title = rqI18n.t('切换界面主题')
  for (const theme of UI_THEMES) {
    const option = document.createElement('option')
    option.value = theme.id
    option.textContent = rqI18n.t(theme.label)
    select.appendChild(option)
  }
  select.value = currentUiTheme()
  select.addEventListener('change', () => setUiTheme(select.value))
  host.replaceChildren(select)
}
