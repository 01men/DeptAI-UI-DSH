/** `rq-card` 命名空间词典（执行卡 + 反馈条的全部文案）。 */

/** 简体中文词典（键集的权威来源）。 */
export const zh = {
  // ── 执行卡：状态徽标 ──
  'card.state.calling': '调用中',
  'card.state.executing': '执行中',
  'card.state.done': '已完成',
  'card.state.blocked': '已受阻',
  'card.state.idle': '等待中',

  // ── 执行卡：通用 ──
  'card.args.summary': '调用参数',
  'card.result.title': '执行结果',
  'card.result.truncated': '（内容过长，已截断）',
  'card.console.link': '到控制台查看',

  // ── 执行卡：调用中（骨架 + 可取消占位）──
  'card.cancel.button': '取消',
  'card.cancel.hint': '取消通道待宿主半接线后启用',

  // ── 执行卡：执行中（进度脉冲）──
  'card.degraded.hint': '有点慢，已转后台处理',

  // ── 执行卡：异常阻断（业务文案，原因码 = C3 js/errors.js 的键）──
  'card.blocked.nas-authz-deny': '没有访问权限，请先申请授权',
  'card.blocked.quota-exhausted': '钱包额度已耗尽，请申请追加',
  'card.blocked.pdp-unreachable': '策略决策点暂不可达，已保护性暂停',
  'card.blocked.breaker-open': '熔断保护生效中，待服务恢复后重试',
  'card.blocked.down': '服务暂不可用，恢复后即可重试',
  'card.blocked.binding-invalid': '身份绑定已失效，请重新绑定',
  'card.blocked.invoke-error': '执行出错，详见结果信息',

  // ── 执行卡：阻断行动按钮（跳 /gate01 控制台对应页，同源带登录态）──
  'card.action.nas-authz-deny': '申请访问',
  'card.action.quota-exhausted': '申请额度',
  'card.action.pdp-unreachable': '查看平台状态',
  'card.action.breaker-open': '查看服务状态',
  'card.action.down': '查看服务状态',
  'card.action.binding-invalid': '重新绑定',
  'card.action.invoke-error': '查看平台状态',

  // ── 反馈条 ──
  'fb.like': '有帮助',
  'fb.dislike': '没帮助',
  'fb.done': '已记录，感谢反馈',

  // ── 设置分区「01门宿主」（M2）──
  'settings.nav': '01门宿主',
  'settings.mode.local': '本机即宿主',
  'settings.mode.remote': '已连接远端宿主',
  'settings.mode.none': '未连接宿主',
  'settings.probe.ok': '可达',
  'settings.probe.fail': '不可达',
  'settings.refresh': '刷新状态',
  'settings.open.wizard': '打开连接向导',
  'settings.open.panel': '打开行业 AI 工作台',
  'settings.hint': '连接宿主（选择 IP）并在工作台完成钉钉/账号登录；工作台已内嵌于 dsh 主界面。',

  // ── 会话视图 Tab「01门工作台」（M3）──
  'view.workbench': '行业 AI 工作台',
  'view.open.external': '在浏览器打开',

  // ── 未连接角标（M3，shell.overlay）──
  'overlay.unlinked': '01门：未连接宿主，点击打开向导',

  // ── 原生面板页（M5：侧栏入口 + main 整页内嵌完整工作台，2026-10-29）──
  'panel': '01门',
  'page.title': '01门 · 行业 AI 工作台',
  'page.intro': 'AI 代理与人类的协作前台——行业空间、战略看板与制造工具箱。',
  'page.open.external': '在浏览器打开',
  'page.embed.note': '已内嵌于 dsh 主界面',
  'page.reload': '重新加载',
  'page.loading': '正在加载行业 AI 工作台…',
  'page.loading.hint': '首次进入需完成工作台初始化，通常数秒内完成。',
  'page.failed.title': '工作台加载失败',
  'page.failed.hint': '内嵌视图未能载入（数据面未挂载或初始化异常）。可重新加载，或在独立窗口打开完整工作台。',
  'state.loading': '加载中…',
  'state.error': '加载失败',
  'state.retry': '重试',
  'state.empty': '暂无内容',
} satisfies Record<string, string>

/** `rq-card` 命名空间键联合。 */
export type RqCardKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 01门执行卡与反馈条的文案。 */
    'rq-card': RqCardKey
  }
}

/** 英文词典，与 zh 键集逐键核对。 */
export const en = {
  'card.state.calling': 'Calling',
  'card.state.executing': 'Running',
  'card.state.done': 'Done',
  'card.state.blocked': 'Blocked',
  'card.state.idle': 'Waiting',

  'card.args.summary': 'Arguments',
  'card.result.title': 'Result',
  'card.result.truncated': '(truncated)',
  'card.console.link': 'Open in console',

  'card.cancel.button': 'Cancel',
  'card.cancel.hint': 'Cancellation becomes available once the host channel is wired',

  'card.degraded.hint': 'Slow — moved to background',

  'card.blocked.nas-authz-deny': 'No access permission — request authorization first',
  'card.blocked.quota-exhausted': 'Wallet quota exhausted — request a top-up',
  'card.blocked.pdp-unreachable': 'Policy decision point unreachable — paused protectively',
  'card.blocked.breaker-open': 'Circuit breaker is open — retry after recovery',
  'card.blocked.down': 'Service is down — retry once it recovers',
  'card.blocked.binding-invalid': 'Identity binding expired — please re-bind',
  'card.blocked.invoke-error': 'Execution failed — see result details',

  'card.action.nas-authz-deny': 'Request access',
  'card.action.quota-exhausted': 'Request quota',
  'card.action.pdp-unreachable': 'Platform status',
  'card.action.breaker-open': 'Service status',
  'card.action.down': 'Service status',
  'card.action.binding-invalid': 'Re-bind',
  'card.action.invoke-error': 'Platform status',

  'fb.like': 'Helpful',
  'fb.dislike': 'Not helpful',
  'fb.done': 'Recorded — thanks for the feedback',

  'settings.nav': 'Yuanbingke host',
  'settings.mode.local': 'This machine is the host',
  'settings.mode.remote': 'Connected to remote host',
  'settings.mode.none': 'Host not linked',
  'settings.probe.ok': 'reachable',
  'settings.probe.fail': 'unreachable',
  'settings.refresh': 'Refresh',
  'settings.open.wizard': 'Open connect wizard',
  'settings.open.panel': 'Open Industry AI Workbench',
  'settings.hint': 'Link a host (pick an IP) and sign in with DingTalk/account on the workbench; the workbench is embedded in the dsh main view.',

  'view.workbench': 'Industry AI Workbench',
  'view.open.external': 'Open in browser',

  'overlay.unlinked': 'Yuanbingke: host not linked — click to open the wizard',

  'panel': 'Gate 01',
  'page.title': 'Gate 01 · Industry AI Workbench',
  'page.intro': 'The collaboration front stage for AI agents and humans — industry spaces, strategy board and manufacturing toolbox.',
  'page.open.external': 'Open in browser',
  'page.embed.note': 'Embedded in the dsh main view',
  'page.reload': 'Reload',
  'page.loading': 'Loading the Industry AI Workbench…',
  'page.loading.hint': 'First entry runs the workbench bootstrap — usually a few seconds.',
  'page.failed.title': 'Workbench failed to load',
  'page.failed.hint': 'The embedded view could not be loaded (data plane not mounted, or bootstrap failed). Reload, or open the full workbench in its own window.',
  'state.loading': 'Loading…',
  'state.error': 'Failed to load',
  'state.retry': 'Retry',
  'state.empty': 'Nothing here yet',
} satisfies Record<RqCardKey, string>
