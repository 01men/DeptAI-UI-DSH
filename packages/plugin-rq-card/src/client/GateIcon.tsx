/**
 * 原生面板页（M4）图标集：侧栏入口图标 + 左列导航行内图标。
 *
 * 【硬约束】纯 SVG：width/height 跟随 owner 的 size、viewBox 0 0 20 20、
 * stroke="currentColor"、strokeWidth 1.5、fill="none"——不写死颜色，
 * 浅/深主题随宿主 token 自动适配；装饰性图标一律 aria-hidden。
 * @module @ybkk/plugin-rq-card/client/GateIcon
 */

/** 图标公共属性：线宽/端点风格全量统一。 */
const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/**
 * 侧栏入口图标（「01门」＝一扇打开的门：门框 + 门缝 + 把手点）。
 * props 对齐 sidebar.panellist 条目的 owner 契约（SidebarPanelIconOwnerProps）。
 */
export function GatePanelIcon({ size, active }: { size: number; active: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      {...strokeProps}
      opacity={active ? 1 : 0.9}
    >
      {/* 门框（右侧开口的门洞） */}
      <path d="M14.5 17.5h-9a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h9" />
      {/* 门板（沿门缝开启） */}
      <path d="M10 2.5v15" />
      {/* 把手 */}
      <circle cx="12.4" cy="10" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 导航行图标：统一 16px 线性小图标，按 nav key 分发。 */
export function GateNavIcon({ kind }: { kind: 'overview' | 'industries' | 'board' | 'mfg' | 'host' }) {
  const common = { width: 16, height: 16, viewBox: '0 0 20 20', 'aria-hidden': true, ...strokeProps } as const
  switch (kind) {
    case 'overview':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="6" height="6" rx="1.2" />
          <rect x="11" y="3" width="6" height="6" rx="1.2" />
          <rect x="3" y="11" width="6" height="6" rx="1.2" />
          <rect x="11" y="11" width="6" height="6" rx="1.2" />
        </svg>
      )
    case 'industries':
      return (
        <svg {...common}>
          <path d="M10 3l7 3.5-7 3.5-7-3.5L10 3z" />
          <path d="M3 10.5l7 3.5 7-3.5" />
          <path d="M3 14.5L10 18l7-3.5" />
        </svg>
      )
    case 'board':
      return (
        <svg {...common}>
          <path d="M3.5 17h13" />
          <path d="M6 17v-6" />
          <path d="M10 17V6" />
          <path d="M14 17v-8.5" />
        </svg>
      )
    case 'mfg':
      return (
        <svg {...common}>
          <path d="M3 17V8.5l4.5 3V8.5l4.5 3V6.5L16.5 4v13H3z" />
          <path d="M6.5 13.5h.01M10 13.5h.01M13.5 13.5h.01" strokeWidth={2} />
        </svg>
      )
    case 'host':
      return (
        <svg {...common}>
          <path d="M7.5 12.5l5-5" />
          <path d="M9.5 5.5l1.6-1.6a2.8 2.8 0 0 1 4 4L13.5 9.5" />
          <path d="M10.5 14.5l-1.6 1.6a2.8 2.8 0 0 1-4-4L6.5 10.5" />
        </svg>
      )
  }
}
