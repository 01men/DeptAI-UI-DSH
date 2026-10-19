/**
 * 制造工具箱空间（MFG Toolkit Space）—— 自「制造业 AI 工具集」并入的视图层（2026-10-19）。
 *
 * 融合口径（docs/plan-mfg-toolkit-fusion-20261019.md）：
 *   - 交互框架=本项目：五空间信息壳、视图路由、api.js 单一请求出口、ui.js 组件通道、
 *     showModal/openDrawer/toast、远程代理与演示态语义、SSE/轮询降级——一律沿用，不另起炉灶；
 *   - UI 风格=源项目：卡片广场（网格/列表切换、收藏、搜索 ⌘K、分类页签、排序）、
 *     三步工作流（准备输入 → 执行 → 查看与复用）、结果工作区（可视化/JSON 双页签）、
 *     场景图谱（分组探索 + 条目展开 + 来源追溯）——其信息架构与版式语义在此保留；
 *   - 落地为 mfg-* 前缀类名 + .mfg-scope 作用域样式，与 iaw-* / panel.css 共存不互染。
 *
 * 数据面：全部来自 /api/panel/mfg/*（服务端零密钥、放行制、严格校验），前端零裸 fetch
 * （经 api.js——与面板其余视图同规，RBAC/代理/作用域语义一致）。
 * 3D 预览：源项目用 three.js；本仓零构建无打包链，改为等轴测 SVG 线框（同一工程语义：
 * 尺寸比例真实、可旋转提示、不支持 WebGL 时同样降级），不引入运行期依赖。
 */
import { api } from './api.js'
import { icon } from './icons.js'

// ---------------------------------------------------------------------------
// 作用域内的小工具
// ---------------------------------------------------------------------------

const esc = (text) => String(text ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

/** 源项目图标名 → 本仓图标集（同语义映射，缺省 box）。 */
const ICON_MAP = {
  gauge: 'activity', chart: 'chart', timer: 'clock', bars: 'chart', boxes: 'box', box: 'box',
  shield: 'shield', trend: 'trending', file: 'file', sparkles: 'sparkles', layers: 'layers',
}
const iconFor = (name, size = 18) => icon(ICON_MAP[name] ?? 'box', size)

/** 本地存储（收藏 / 记录开关 / 排序偏好）——与源项目同名键语义保留，前缀 mfg- 防串台。 */
function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`mfg-${key}`) ?? 'null') ?? fallback } catch { return fallback }
}
function writeStore(key, value) {
  try { localStorage.setItem(`mfg-${key}`, JSON.stringify(value)); return true } catch { return false }
}

/** 数值格式化（千分位 + 有效小数位，源项目展示口径）。 */
const fmtNum = (value) => {
  if (typeof value !== 'number') return String(value ?? '')
  if (Number.isInteger(value)) return value.toLocaleString('zh-CN')
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

// ---------------------------------------------------------------------------
// 状态（模块级：与 app.js 的 state 分离，随空间重组而重置）
// ---------------------------------------------------------------------------

const mfg = {
  loaded: false,
  catalog: null,
  roadmap: null,
  error: '',
  category: '全部工具',
  search: '',
  sort: 'default',
  layout: 'grid',
  favorites: readStore('favorites', []),
  history: readStore('history', []),
  remember: readStore('remember', false),
  selected: null,
  inputs: {},
  result: null,
  running: false,
  runError: '',
  resultTab: 'view',
  detailId: null,
  graphGroup: '全部场景',
  graphFilter: 'all',
  graphExpanded: null,
}

/** 数据装载（幂等；失败显式提示不白屏）。 */
async function ensureLoaded() {
  if (mfg.loaded) return
  try {
    const [catalog, roadmap] = await Promise.all([
      api.get('/api/panel/mfg/catalog'),
      api.get('/api/panel/mfg/roadmap'),
    ])
    mfg.catalog = catalog
    mfg.roadmap = roadmap
    mfg.loaded = true
    mfg.error = ''
  } catch (error) {
    mfg.error = error?.message ?? '无法连接制造工具箱数据面'
    throw error
  }
}

const mfgTools = () => mfg.catalog?.tools ?? []
const mfgCategories = () => mfg.catalog?.categories ?? []
const releasedSkills = () => new Set((mfg.catalog?.skills ?? []).filter((skill) => skill.released).map((skill) => skill.skillId))

// ---------------------------------------------------------------------------
// 过滤与排序
// ---------------------------------------------------------------------------

function visibleTools(view) {
  const term = mfg.search.trim().toLowerCase()
  const found = mfgTools().filter((tool) =>
    (view !== 'favorites' || mfg.favorites.includes(tool.id))
    && (mfg.category === '全部工具' || tool.category === mfg.category)
    && (`${tool.title} ${tool.subtitle} ${tool.tags.join(' ')} ${tool.id}`.toLowerCase().includes(term)))
  const sorted = [...found]
  if (mfg.sort === 'name') sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
  if (mfg.sort === 'calc') sorted.sort((a, b) => a.mode.localeCompare(b.mode))
  return sorted
}

// ---------------------------------------------------------------------------
// 视图：工具广场 / 我的收藏
// ---------------------------------------------------------------------------

const HERO = {
  plaza: ['把专业的事，做得更简单。', '为制造业而生的 AI 工具集。从一个问题出发，抵达可用的结果。'],
  favorites: ['常用工具，随时就位。', '收藏适合你的工具，建立自己的高效工作台。'],
  graph: ['从业务场景，找到标准能力。', '100 个工具选题的来源、内核、表现与验收标准，一处查看。'],
  history: ['每一次探索，都有迹可循。', '选择保存在本机的运行记录，查看结果或调整参数再次执行。'],
}

function viewHeader(view, count) {
  const [title, sub] = HERO[view] ?? HERO.plaza
  return `<div class="iaw-page-head mfg-head">
    <div><div class="mfg-eyebrow">MFG TOOLKIT · 制造工具箱</div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
    <div class="mfg-head-stats">
      <span class="mfg-stat"><b>${mfgTools().length || '—'}</b>已实现</span>
      <span class="mfg-stat"><b>100</b>选题规划</span>
      <span class="mfg-stat"><b>${(mfg.catalog?.skills ?? []).filter((s) => s.released).length}</b>AI 已放行</span>
    </div>
  </div>`
}

function viewPlaza(view) {
  const list = visibleTools(view)
  const skills = releasedSkills()
  let h = `<div class="iaw-view mfg-scope">${viewHeader(view, list.length)}`

  if (view === 'plaza') {
    h += `<div class="mfg-summary">
      <div><span class="mfg-sum-icon blue">${iconFor('gauge', 18)}</span><span><b>${mfgTools().filter((t) => t.mode === 'calculation').length}</b><small>计算内核已实现</small></span></div>
      <div><span class="mfg-sum-icon purple">${icon('sparkles', 18)}</span><span><b>${mfgTools().filter((t) => t.mode === 'model').length}<em>个</em></b><small>AI 工具待验收</small></span></div>
      <div><span class="mfg-sum-icon teal">${icon('flow', 18)}</span><span><b>一套<em>协议</em></b><small>网页 / 工具面共用</small></span></div>
      <div class="mfg-sum-target"><span>${icon('plus', 15)}</span><span><strong>100 个场景工具已规划</strong><button class="mfg-link" data-mfgview="graph">查看来源与共享能力 →</button></span></div>
    </div>`
  }

  h += `<div class="mfg-toolbar">
    <div class="mfg-search">${icon('search', 16)}
      <input id="mfgSearch" placeholder="搜索工具、场景或关键词…" aria-label="搜索工具" value="${esc(mfg.search)}"/>
      ${mfg.search ? `<button class="mfg-clear" id="mfgSearchClear" aria-label="清空搜索">${icon('x', 14)}</button>` : ''}
    </div>
    <label class="mfg-select">${icon('filter', 14)}
      <select id="mfgSort" aria-label="工具排序">
        <option value="default"${mfg.sort === 'default' ? ' selected' : ''}>推荐排序</option>
        <option value="name"${mfg.sort === 'name' ? ' selected' : ''}>名称排序</option>
        <option value="calc"${mfg.sort === 'calc' ? ' selected' : ''}>计算工具优先</option>
      </select>
    </label>
    <div class="mfg-toggle">
      <button class="${mfg.layout === 'grid' ? 'on' : ''}" data-mfglayout="grid" aria-label="网格视图">${icon('dashboard', 16)}</button>
      <button class="${mfg.layout === 'list' ? 'on' : ''}" data-mfglayout="list" aria-label="列表视图">${icon('layers', 16)}</button>
    </div>
  </div>`

  h += `<div class="mfg-tabs" role="tablist" aria-label="工具分类">${['全部工具', ...mfgCategories()].map((cat) =>
    `<button role="tab" aria-selected="${mfg.category === cat}" class="${mfg.category === cat ? 'on' : ''}" data-mfgcat="${esc(cat)}">${esc(cat)}${cat === '全部工具' ? `<span>${mfgTools().length}</span>` : ''}</button>`).join('')}</div>`

  if (mfg.error) {
    h += `<div class="iaw-empty">${esc(mfg.error)}<br/><button class="iaw-btn" data-mfgretry>重试连接</button></div>`
  } else if (!mfg.loaded) {
    h += `<div class="iaw-empty">正在加载制造工具箱…</div>`
  } else if (list.length === 0) {
    h += `<div class="iaw-empty">${view === 'favorites' && !mfg.favorites.length ? '收藏你的第一个工具：点击卡片右上角星标。' : '没有找到匹配的工具，换一个关键词或查看全部分类。'}</div>`
  } else {
    h += `<div class="mfg-grid ${mfg.layout === 'list' ? 'is-list' : ''}">${list.map((tool) => {
      const fav = mfg.favorites.includes(tool.id)
      const locked = tool.mode === 'model' && !skills.has(tool.skill)
      return `<article class="mfg-card">
        <div class="mfg-card-top">
          <span class="mfg-card-icon ${esc(tool.color)}">${iconFor(tool.icon, 21)}</span>
          <div class="mfg-card-badges">
            ${locked ? '<span class="mfg-badge warn">待验收</span>' : ''}
            ${tool.tags.includes('3D 预览') ? '<span class="mfg-badge">3D</span>' : ''}
            <button class="mfg-fav ${fav ? 'on' : ''}" data-mfgfav="${esc(tool.id)}" aria-label="${fav ? '取消收藏' : '收藏'}${esc(tool.title)}" aria-pressed="${fav}">${icon('star', 16)}</button>
          </div>
        </div>
        <button class="mfg-card-main" data-mfgtool="${esc(tool.id)}">
          <h3>${esc(tool.title)}</h3><p>${esc(tool.subtitle)}</p>
        </button>
        <div class="mfg-card-foot">
          <span>${esc(tool.category)}</span><i></i>
          <span>${tool.mode === 'model' ? `${icon('sparkles', 11)}AI + Skill` : '即开即用'}</span>
          <button data-mfgtool="${esc(tool.id)}" aria-label="打开${esc(tool.title)}">${icon('chevronRight', 15)}</button>
        </div>
      </article>`
    }).join('')}</div>`
  }
  return `${h}</div>`
}

// ---------------------------------------------------------------------------
// 视图：场景图谱（100 项选题，来源可追溯）
// ---------------------------------------------------------------------------

const STATUS_LABEL = { 'implemented-calculation': '计算内核已实现', 'model-validation-pending': '待模型验收', planned: '规划中' }

function viewGraph() {
  const roadmap = mfg.roadmap
  if (!roadmap) return `<div class="iaw-view mfg-scope">${viewHeader('graph', 0)}<div class="iaw-empty">选题清单未装载。</div></div>`
  const { tools, groups, statusLabels } = roadmap
  const labels = statusLabels ?? STATUS_LABEL
  const term = mfg.search.trim().toLowerCase()
  const filtered = tools.filter((item) =>
    (mfg.graphGroup === '全部场景' || item.group === mfg.graphGroup)
    && (mfg.graphFilter === 'all' || item.status === mfg.graphFilter)
    && (!term || `${item.title} ${item.kernel} ${item.sources.map((s) => s.department).join(' ')} ${item.id}`.toLowerCase().includes(term)))
  const counts = {
    implemented: tools.filter((item) => item.status === 'implemented-calculation').length,
    pending: tools.filter((item) => item.status === 'model-validation-pending').length,
    planned: tools.filter((item) => item.status === 'planned').length,
  }
  let h = `<div class="iaw-view mfg-scope">${viewHeader('graph', filtered.length)}
  <div class="mfg-graph-intro">
    <div><span class="mfg-eyebrow">SCENARIO → CAPABILITY → APPLICATION</span><h2>100 个应用，共用能力生长。</h2>
      <p>依据「一图四清单」框架与 PMO 场景清单拆解。原始业务系统继续承担业务闭环，工具集聚焦明确输入、明确成果的单次任务。</p></div>
    <div class="mfg-graph-total">100<span>工具选题 / ${groups.length} 类场景</span></div>
  </div>
  <div class="mfg-graph-stats">
    <div><b>${counts.implemented}</b><span>计算内核已实现</span></div>
    <div><b>${counts.pending}</b><span>AI 待真实模型验收</span></div>
    <div><b>${counts.planned}</b><span>规划工具</span></div>
    <div><b>${roadmap.sourceRows ?? 295}</b><span>原始场景记录</span></div>
  </div>
  <div class="mfg-graph-map">
    <div class="mfg-graph-map-h"><h3>按业务场景探索</h3><span>点击场景，查看工具与能力复用</span></div>
    <div class="mfg-groups">${groups.map((name, index) =>
      `<button class="${mfg.graphGroup === name ? 'on' : ''}" data-mfggroup="${esc(name)}"><span>${String(index + 1).padStart(2, '0')}</span><strong>${esc(name)}</strong><small>${tools.filter((item) => item.group === name).length} 个工具</small>${icon('chevronRight', 13)}</button>`).join('')}</div>
    <div class="mfg-kernels"><span>共享能力层</span>${['解析与抽取', '字段标准化', '规则与计算', '模型 + Skill', '结构与证据校验', '统一渲染与导出'].map((item) => `<small>${item}</small>`).join('')}</div>
  </div>
  <div class="mfg-toolbar">
    <div class="mfg-search">${icon('search', 16)}<input id="mfgSearch" placeholder="搜索工具、部门或共享内核…" aria-label="搜索选题" value="${esc(mfg.search)}"/>${mfg.search ? `<button class="mfg-clear" id="mfgSearchClear">${icon('x', 14)}</button>` : ''}</div>
    <label class="mfg-select">${icon('filter', 14)}<select id="mfgGraphFilter" aria-label="规划状态">
      <option value="all"${mfg.graphFilter === 'all' ? ' selected' : ''}>全部状态</option>
      ${Object.entries(labels).map(([value, title]) => `<option value="${esc(value)}"${mfg.graphFilter === value ? ' selected' : ''}>${esc(title)}</option>`).join('')}
    </select></label>
    <button class="mfg-link mfg-reset" data-mfggraphreset>重置筛选</button>
  </div>
  <div class="mfg-rows">`
  h += filtered.map((item) => {
    const open = mfg.graphExpanded === item.id
    const tool = item.implementation ? mfgTools().find((candidate) => candidate.id === item.implementation) : null
    return `<article class="mfg-row ${open ? 'open' : ''}">
      <button class="mfg-row-head" data-mfgexpand="${esc(item.id)}" aria-expanded="${open}">
        <span class="mfg-row-id">${esc(item.id)}</span>
        <strong>${esc(item.title)}<small>${esc(item.group)} · ${esc(item.kernel)}</small></strong>
        <span class="mfg-prio ${esc(String(item.priority).toLowerCase())}">${esc(item.priority)}</span>
        <span class="mfg-state ${esc(item.status)}">${esc(labels[item.status] ?? item.status)}</span>
        ${icon('chevronDown', 14)}
      </button>
      ${open ? `<div class="mfg-row-body">
        <div><label>输入契约</label><p>${esc(item.inputContract)}</p></div>
        <div><label>执行方法</label><p>${esc(item.workflow)}</p></div>
        <div><label>结果表现</label><p>${esc(item.renderer)}</p></div>
        <div><label>验收标准</label><p>${esc(item.acceptance)}</p></div>
        <div class="full"><label>来源追溯</label>${item.sources.map((source) =>
          `<p>PMO 第 ${source.row} 行 · ${esc(source.department)} · ${esc(source.originalScenario)}<span class="mfg-src-state">原状态：${esc(source.originalStatus)}</span></p>`).join('')}
          ${item.pdfReferences?.[0] ? `<p>PDF 第 ${item.pdfReferences[0].page} 页：相关行业框架映射；工具粒度与边界为本项目设计。</p>` : ''}</div>
        <div class="full"><label>交付边界</label><p>${esc(item.deliveryBoundary)}</p>${item.caveat ? `<p class="mfg-caveat">${esc(item.caveat)}</p>` : ''}</div>
        ${tool ? `<button class="iaw-btn iaw-btn-primary iaw-btn-sm" data-mfgtool="${esc(tool.id)}">${tool.mode === 'model' ? '查看待验收工具' : '打开工具'}${icon('chevronRight', 13)}</button>` : ''}
        ${item.implementation && !tool ? '<p class="mfg-caveat">该选题的实现内核尚未并入本空间。</p>' : ''}
      </div>` : ''}
    </article>`
  }).join('')
  h += `</div>
  <p class="mfg-disclaimer">P0 / P1 / P2 为初步实施优先级建议。原 Excel 中的「已完成」仅表示原业务项目状态，不表示本工具集已实现；计划中的渲染形式亦不代表已交付。</p></div>`
  return h
}

// ---------------------------------------------------------------------------
// 视图：运行记录
// ---------------------------------------------------------------------------

function viewHistory() {
  let h = `<div class="iaw-view mfg-scope">${viewHeader('history', mfg.history.length)}
  <div class="mfg-sect-h"><h2>运行记录 <span>${mfg.history.length}</span></h2>
    <button class="mfg-link" data-mfgclearhistory>清空本机记录</button></div>
  <div class="mfg-notice">${mfg.remember
    ? '已开启本机保存，最多保留最近 20 次结果。'
    : '本机保存默认关闭。可在工具箱设置中开启；关闭后不会保存新的输入和结果。'}</div>`
  if (mfg.history.length) {
    h += mfg.history.map((entry, index) => `<button class="mfg-hrow" data-mfghistory="${index}">
      <span class="mfg-card-icon blue">${icon('clock', 19)}</span>
      <span><strong>${esc(entry.result.title)}</strong><small>${new Date(entry.result.createdAt).toLocaleString('zh-CN')}</small></span>
      <span class="mfg-hrow-ok">${icon('check', 13)}已完成</span>${icon('chevronRight', 15)}
    </button>`).join('')
  } else {
    h += `<div class="iaw-empty">还没有保存的运行记录。开启本机保存后，你的下一次运行会出现在这里。</div>`
  }
  return `${h}</div>`
}

// ---------------------------------------------------------------------------
// 结果渲染（源项目 Results.tsx 的等价实现）
// ---------------------------------------------------------------------------

/** 等轴测线框（源项目 three.js 场景的零依赖降级：比例真实的尺寸语义可视化）。 */
function renderScene(block) {
  const [l, w, hgt] = block.dimensions
  const max = Math.max(l, w, hgt, 1)
  const sx = 150 * (l / max), sy = 96 * (w / max), sz = 110 * (hgt / max)
  const ox = 210, oy = 175
  const p = (dx, dy, dz) => `${(ox + (dx - dy) * 0.866).toFixed(1)},${(oy + (dx + dy) * 0.5 - dz).toFixed(1)}`
  const A = p(0, 0, 0), B = p(sx, 0, 0), C = p(sx, sy, 0), D = p(0, sy, 0)
  const A2 = p(0, 0, sz), B2 = p(sx, 0, sz), C2 = p(sx, sy, sz), D2 = p(0, sy, sz)
  return `<section class="mfg-block">
    <h4>${esc(block.title)}</h4>
    <div class="mfg-scene">
      <svg viewBox="0 0 420 260" role="img" aria-label="${esc(block.label)}等轴测线框：${block.dimensions.join(' × ')} mm">
        <g class="mfg-scene-grid">${Array.from({ length: 9 }, (_, i) => `<line x1="${60 + i * 38}" y1="196" x2="${24 + i * 38}" y2="214"/>`).join('')}${Array.from({ length: 5 }, (_, i) => `<line x1="${60 - i * 4}" y1="${196 + i * 6}" x2="${364 - i * 4}" y2="${196 + i * 6}"/>`).join('')}</g>
        <g class="mfg-scene-box">
          <path d="M${A} L${B} L${C} L${D} Z" class="face"/>
          <path d="M${A2} L${B2} L${C2} L${D2} Z" class="face top"/>
          <path d="M${A} L${A2} M${B} L${B2} M${C} L${C2} M${D} L${D2}" class="edges"/>
          <path d="M${A} L${B} L${C} L${D} Z M${A2} L${B2} L${C2} L${D2} Z" class="outline"/>
        </g>
      </svg>
      <span class="mfg-scene-hint">${esc(block.label)} · ${block.dimensions.join(' × ')} mm · 数量 ${block.count}</span>
    </div>
  </section>`
}

function renderBlock(block) {
  switch (block.type) {
    case 'metrics':
      return `<div class="mfg-metrics">${block.items.map((item) =>
        `<div class="mfg-metric ${item.tone ?? ''}"><span>${esc(item.label)}</span><strong>${esc(fmtNum(item.value))}<small>${esc(item.unit ?? '')}</small></strong></div>`).join('')}</div>`
    case 'text':
      return `<section class="mfg-block"><h4>${esc(block.title)}</h4><p class="mfg-text">${esc(block.content)}</p></section>`
    case 'table':
      return `<section class="mfg-block"><h4>${esc(block.title)}</h4><div class="mfg-scroll"><table>
        <thead><tr>${block.columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead>
        <tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div></section>`
    case 'bars': {
      const max = Math.max(1, ...block.items.map((item) => Math.abs(item.value)))
      return `<section class="mfg-block"><h4>${esc(block.title)}</h4><div class="mfg-bars">${block.items.map((item, index) =>
        `<div class="mfg-bar"><span>${esc(item.label)}</span><div class="mfg-bar-track"><div style="width:${Math.max(0, item.value) / max * 100}%;opacity:${1 - Math.min(index, 8) * 0.07}"></div></div><b>${esc(fmtNum(item.value))}<small>${esc(block.unit ?? '')}</small></b></div>`).join('')}</div></section>`
    }
    case 'scene': return renderScene(block)
    default: return ''
  }
}

function renderResultPanel() {
  if (mfg.runError) return `<div class="mfg-error" role="alert">${esc(mfg.runError)}</div>`
  if (mfg.running) return `<div class="mfg-output-empty"><div class="mfg-orbit is-running">${icon('sparkles', 28)}</div><h3>专业方法，正在执行</h3><p>结果将以统一格式呈现。</p></div>`
  if (!mfg.result) return `<div class="mfg-output-empty"><div class="mfg-orbit">${icon('chart', 28)}</div><h3>让数据，变成下一步行动</h3><p>填写左侧参数并运行工具，结果将在这里以适合的方式呈现。</p><div class="mfg-caps"><span>${icon('chart', 14)}图表</span><span>${icon('box', 14)}三维</span><span>${icon('terminal', 14)}结构化数据</span></div></div>`
  const result = mfg.result
  const body = mfg.resultTab === 'view'
    ? `${result.warnings.map((warning) => `<div class="mfg-notice warn">${esc(warning)}</div>`).join('')}${result.blocks.map(renderBlock).join('')}`
    : `<pre class="mfg-json">${esc(JSON.stringify(result, null, 2))}</pre>`
  return `<div class="mfg-result-status">${icon('check', 14)}执行完成<span>${esc(result.durationMs)} ms · ${result.mode === 'model' ? '模型 + Skill' : '确定性计算'}</span></div>
  <div class="mfg-result-tabs">
    <button class="${mfg.resultTab === 'view' ? 'on' : ''}" data-mfgtab="view">可视化</button>
    <button class="${mfg.resultTab === 'json' ? 'on' : ''}" data-mfgtab="json">JSON</button>
  </div>
  ${body}
  <div class="mfg-result-actions">
    <button class="iaw-btn" data-mfgexport="json">${icon('download', 14)}JSON</button>
    <button class="iaw-btn" data-mfgexport="md">${icon('file', 14)}Markdown</button>
    <button class="iaw-btn iaw-btn-primary" data-mfgcontinue>${icon('flow', 14)}继续分析${icon('chevronRight', 13)}</button>
  </div>
  <p class="mfg-run-meta">运行编号 ${esc(result.runId)} · ${new Date(result.createdAt).toLocaleString('zh-CN')}</p>`
}

// ---------------------------------------------------------------------------
// 工具工作区（右侧抽屉：三步工作流）
// ---------------------------------------------------------------------------

function openTool(toolId) {
  const tool = mfgTools().find((candidate) => candidate.id === toolId)
  if (!tool) return
  mfg.selected = tool
  mfg.inputs = Object.fromEntries(tool.fields.map((field) => [field.key, String(field.default ?? '')]))
  mfg.result = null
  mfg.runError = ''
  mfg.resultTab = 'view'
  renderToolDrawer()
}

function renderToolDrawer() {
  const tool = mfg.selected
  if (!tool) return
  const skills = releasedSkills()
  const locked = tool.mode === 'model' && !skills.has(tool.skill)
  const skillInfo = (mfg.catalog?.skills ?? []).find((item) => item.skillId === tool.skill)
  const modelReady = Boolean(mfg.catalog?.modelReady)

  const root = document.getElementById('mfgDrawer')
  if (!root) return
  root.innerHTML = `<div class="mfg-scrim" data-mfgclose></div>
  <aside class="mfg-drawer" role="dialog" aria-modal="true" aria-label="${esc(tool.title)}">
    <header class="mfg-dr-head">
      <span class="mfg-card-icon ${esc(tool.color)}">${iconFor(tool.icon, 19)}</span>
      <div><h2>${esc(tool.title)}</h2><p>${esc(tool.subtitle)}</p></div>
      <span class="mfg-mode">${tool.mode === 'model' ? '模型 + Skill' : '确定性计算'}</span>
      <button class="mfg-x" data-mfgclose aria-label="关闭">${icon('x', 18)}</button>
    </header>
    <div class="mfg-steps"><span class="on"><b>01</b>准备输入</span><i></i><span class="${mfg.running || mfg.result ? 'on' : ''}"><b>02</b>执行工具</span><i></i><span class="${mfg.result ? 'on' : ''}"><b>03</b>查看与复用</span></div>
    <div class="mfg-work">
      <form class="mfg-inputs" id="mfgForm">
        <div class="mfg-panel-h"><h3>输入参数</h3><button type="button" class="mfg-link" data-mfgreset ${mfg.running ? 'disabled' : ''}>恢复示例</button></div>
        <div class="mfg-import">
          <button type="button" data-mfgimport>${icon('download', 14)}导入数据</button>
          <button type="button" data-mfgtemplate>${icon('file', 14)}输入模板</button>
          <input type="file" id="mfgFile" accept=".json,.csv,.txt" hidden/>
        </div>
        ${tool.fields.map((field) => `<label class="mfg-field">
          <span>${esc(field.label)}${field.unit ? `<small>${esc(field.unit)}</small>` : ''}</span>
          ${field.type === 'textarea'
            ? `<textarea data-mfgfield="${esc(field.key)}" maxlength="16000" ${mfg.running ? 'disabled' : ''}>${esc(mfg.inputs[field.key] ?? '')}</textarea>`
            : `<input type="${field.type === 'number' ? 'number' : 'text'}" step="any" data-mfgfield="${esc(field.key)}" value="${esc(mfg.inputs[field.key] ?? '')}" ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${mfg.running ? 'disabled' : ''}/>`}
        </label>`).join('')}
        ${tool.mode === 'model' && !modelReady ? `<div class="mfg-notice">平台尚未配置可用模型。请在 dsh 侧配置默认模型，或在模型网关登记渠道；面板不接收密钥。</div>` : ''}
        ${tool.mode === 'model' && modelReady && locked ? `<div class="mfg-notice">此 Skill 尚未放行：${esc(skillInfo?.reason ?? '需先完成真实模型评估与领域审阅')}。</div>` : ''}
        <button type="submit" class="mfg-run" ${mfg.running || locked || (tool.mode === 'model' && !modelReady) ? 'disabled' : ''}>
          ${mfg.running ? icon('refresh', 15) : icon('play', 15)}${mfg.running ? '正在执行…' : '运行工具'}<span>${mfg.running ? 'PROCESSING' : 'RUN'}</span>
        </button>
        <p class="mfg-foot-note">${icon('shield', 12)}${mfg.remember ? '已开启本机保存；服务端不持久化输入' : '当前未开启本机记录保存'}</p>
      </form>
      <div class="mfg-output">${renderResultPanel()}</div>
    </div>
  </aside>`
  wireDrawer()
}

function closeTool() {
  mfg.selected = null
  mfg.running = false
  const root = document.getElementById('mfgDrawer')
  if (root) root.innerHTML = ''
}

// ---------------------------------------------------------------------------
// 执行与导出
// ---------------------------------------------------------------------------

async function runTool() {
  const tool = mfg.selected
  if (!tool || mfg.running) return
  const payload = {}
  for (const field of tool.fields) {
    const raw = String(mfg.inputs[field.key] ?? '').trim()
    if (!raw) {
      mfg.runError = `请填写${field.label}`
      renderToolDrawer()
      return
    }
    payload[field.key] = field.type === 'number' ? Number(raw) : raw
  }
  mfg.running = true
  mfg.runError = ''
  mfg.result = null
  renderToolDrawer()
  try {
    const result = await api.post(`/api/panel/mfg/tools/${tool.id}/run`, payload)
    mfg.result = result
    mfg.resultTab = 'view'
    if (mfg.remember) {
      const updated = [{ result }, ...mfg.history].slice(0, 20)
      mfg.history = updated
      if (!writeStore('history', updated)) mfg.runError = '浏览器存储空间不足，本次记录仅保留在当前页面'
    }
  } catch (error) {
    mfg.runError = error?.message ?? '执行失败，请重试。'
  } finally {
    mfg.running = false
    renderToolDrawer()
  }
}

async function exportResult(format) {
  if (!mfg.result) return
  try {
    const payload = await api.post(`/api/panel/mfg/tools/${mfg.result.toolId}/export`, { result: mfg.result, format })
    const url = URL.createObjectURL(new Blob([payload.content], { type: `${payload.mime};charset=utf-8` }))
    const link = document.createElement('a')
    link.href = url
    link.download = payload.filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) {
    mfg.runError = error?.message ?? '导出失败'
    renderToolDrawer()
  }
}

/** 「继续分析」：把结果交给根因分析工具（显式数据映射，源项目同语义）。 */
function continueAnalysis() {
  if (!mfg.result) return
  const target = mfgTools().find((tool) => tool.id === 'root-cause')
  if (!target) return
  const summary = mfg.result.blocks.map((block) => {
    if (block.type === 'metrics') return block.items.map((item) => `- ${item.label}：${fmtNum(item.value)} ${item.unit ?? ''}`).join('\n')
    if (block.type === 'text') return `## ${block.title}\n${block.content}`
    if (block.type === 'bars') return `## ${block.title}\n${block.items.map((item) => `- ${item.label}: ${fmtNum(item.value)}`).join('\n')}`
    if (block.type === 'table') return `## ${block.title}\n${[block.columns, ...block.rows].map((row) => row.join(' | ')).join('\n')}`
    return `## ${block.title}\n${block.label} ${block.dimensions.join(' × ')} mm × ${block.count}`
  }).join('\n\n')
  mfg.selected = target
  mfg.inputs = Object.fromEntries(target.fields.map((field) => [field.key, String(field.default ?? '')]))
  mfg.inputs.context = `请基于以下计算结果整理待验证的改善假设，不将指标直接当成根因：\n${summary}`
  mfg.result = null
  mfg.runError = ''
  renderToolDrawer()
}

// ---------------------------------------------------------------------------
// 事件接线（渲染后绑定，与 app.js 的 wireView 同模式）
// ---------------------------------------------------------------------------

function wireDrawer() {
  const root = document.getElementById('mfgDrawer')
  if (!root) return
  root.querySelectorAll('[data-mfgclose]').forEach((el) => { el.onclick = () => closeTool() })
  const form = document.getElementById('mfgForm')
  form?.addEventListener('submit', (event) => { event.preventDefault(); void runTool() })
  root.querySelectorAll('[data-mfgfield]').forEach((el) => {
    el.oninput = () => { mfg.inputs[el.dataset.mfgfield] = el.value }
  })
  root.querySelector('[data-mfgreset]')?.addEventListener('click', () => {
    const tool = mfg.selected
    if (!tool) return
    mfg.inputs = Object.fromEntries(tool.fields.map((field) => [field.key, String(field.default ?? '')]))
    mfg.result = null
    mfg.runError = ''
    renderToolDrawer()
  })
  root.querySelector('[data-mfgtemplate]')?.addEventListener('click', () => {
    const tool = mfg.selected
    if (!tool) return
    const content = JSON.stringify(Object.fromEntries(tool.fields.map((field) => [field.key, field.default])), null, 2)
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${tool.id}-input.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  const file = root.querySelector('#mfgFile')
  root.querySelector('[data-mfgimport]')?.addEventListener('click', () => file?.click())
  file?.addEventListener('change', async () => {
    const picked = file.files?.[0]
    if (!picked || !mfg.selected) return
    if (picked.size > 200000) { mfg.runError = '请导入小于 200 KB 的文件'; renderToolDrawer(); return }
    try {
      const text = await picked.text()
      if (picked.name.endsWith('.json')) {
        const parsed = JSON.parse(text)
        const values = parsed.input ?? parsed
        if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error()
        const valid = Object.fromEntries(mfg.selected.fields
          .filter((field) => Object.hasOwn(values, field.key) && ['number', 'string'].includes(typeof values[field.key]))
          .map((field) => [field.key, String(values[field.key])]))
        if (Object.keys(valid).length === 0) { mfg.runError = '文件中没有与当前工具匹配的字段，可先导出输入模板'; renderToolDrawer(); return }
        mfg.inputs = { ...mfg.inputs, ...valid }
      } else {
        const field = mfg.selected.fields.find((item) => item.type === 'textarea')
        if (!field) { mfg.runError = '该工具需要 JSON 输入文件，请先导出模板'; renderToolDrawer(); return }
        mfg.inputs = { ...mfg.inputs, [field.key]: text }
      }
      mfg.runError = ''
      renderToolDrawer()
    } catch {
      mfg.runError = '无法读取文件，请使用 UTF-8 文本或有效的 JSON'
      renderToolDrawer()
    }
  })
  root.querySelectorAll('[data-mfgtab]').forEach((el) => {
    el.onclick = () => { mfg.resultTab = el.dataset.mfgtab; renderToolDrawer() }
  })
  root.querySelectorAll('[data-mfgexport]').forEach((el) => {
    el.onclick = () => void exportResult(el.dataset.mfgexport)
  })
  root.querySelector('[data-mfgcontinue]')?.addEventListener('click', () => continueAnalysis())
}

function wireView(root, view, rerender) {
  root.querySelectorAll('[data-mfgtool]').forEach((el) => { el.onclick = () => openTool(el.dataset.mfgtool) })
  root.querySelectorAll('[data-mfgfav]').forEach((el) => {
    el.onclick = (event) => {
      event.stopPropagation()
      const id = el.dataset.mfgfav
      mfg.favorites = mfg.favorites.includes(id) ? mfg.favorites.filter((item) => item !== id) : [...mfg.favorites, id]
      writeStore('favorites', mfg.favorites)
      rerender()
    }
  })
  root.querySelectorAll('[data-mfgcat]').forEach((el) => {
    el.onclick = () => { mfg.category = el.dataset.mfgcat; rerender() }
  })
  root.querySelectorAll('[data-mfglayout]').forEach((el) => {
    el.onclick = () => { mfg.layout = el.dataset.mfglayout; rerender() }
  })
  root.querySelectorAll('[data-mfgview]').forEach((el) => {
    el.onclick = () => { mfg.view = el.dataset.mfgview; rerender() }
  })
  root.querySelectorAll('[data-mfggroup]').forEach((el) => {
    el.onclick = () => { mfg.graphGroup = mfg.graphGroup === el.dataset.mfggroup ? '全部场景' : el.dataset.mfggroup; rerender() }
  })
  root.querySelectorAll('[data-mfgexpand]').forEach((el) => {
    el.onclick = () => { mfg.graphExpanded = mfg.graphExpanded === el.dataset.mfgexpand ? null : el.dataset.mfgexpand; rerender() }
  })
  root.querySelector('[data-mfggraphreset]')?.addEventListener('click', () => {
    mfg.graphGroup = '全部场景'; mfg.graphFilter = 'all'; mfg.search = ''; rerender()
  })
  root.querySelector('[data-mfghistory]')?.addEventListener?.('click', () => {})
  root.querySelectorAll('[data-mfghistory]').forEach((el) => {
    el.onclick = () => {
      const entry = mfg.history[Number(el.dataset.mfghistory)]
      if (!entry) return
      const tool = mfgTools().find((candidate) => candidate.id === entry.result.toolId)
      if (!tool) return
      mfg.selected = tool
      mfg.inputs = Object.fromEntries(tool.fields.map((field) => [field.key, String(entry.result.input?.[field.key] ?? field.default)]))
      mfg.result = entry.result
      mfg.resultTab = 'view'
      mfg.runError = ''
      renderToolDrawer()
    }
  })
  root.querySelector('[data-mfgclearhistory]')?.addEventListener('click', () => {
    mfg.history = []; writeStore('history', []); rerender()
  })
  root.querySelector('[data-mfgretry]')?.addEventListener('click', () => { mfg.loaded = false; void rerender() })
  const search = root.querySelector('#mfgSearch')
  if (search) {
    let timer = null
    search.oninput = () => {
      mfg.search = search.value
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => rerender(), 220)
    }
    const clear = root.querySelector('#mfgSearchClear')
    if (clear) clear.onclick = () => { mfg.search = ''; rerender() }
  }
  const sort = root.querySelector('#mfgSort')
  if (sort) sort.onchange = () => { mfg.sort = sort.value; rerender() }
  const graphFilter = root.querySelector('#mfgGraphFilter')
  if (graphFilter) graphFilter.onchange = () => { mfg.graphFilter = graphFilter.value; rerender() }
}

// ---------------------------------------------------------------------------
// 对外入口（app.js 视图路由调用）
// ---------------------------------------------------------------------------

/** 视图清单（空间内二级导航）。 */
export const MFG_NAV = [
  ['plaza', '工具广场', '▦', ''],
  ['graph', '场景图谱', '⌘', '100'],
  ['favorites', '我的收藏', '★', ''],
  ['history', '运行记录', '◷', ''],
]

/** 导航徽标（随收藏/记录数刷新）。 */
export function mfgNavBadges() {
  return { favorites: mfg.favorites.length ? String(mfg.favorites.length) : '', history: mfg.history.length ? String(mfg.history.length) : '' }
}

/** 渲染入口：由 app.js renderView 在 space=mfg 时调用。 */
export async function renderMfgView(view) {
  const host = document.getElementById('iawMain')
  if (!host) return
  if (!mfg.loaded) {
    host.innerHTML = `<div class="iaw-view mfg-scope">${viewHeader(view, 0)}<div class="iaw-empty">正在加载制造工具箱…</div></div>`
    try {
      await ensureLoaded()
    } catch {
      host.innerHTML = `<div class="iaw-view mfg-scope">${viewHeader(view, 0)}<div class="iaw-empty">${esc(mfg.error)}<br/><button class="iaw-btn" data-mfgretry2>重试连接</button></div></div>`
      host.querySelector('[data-mfgretry2]')?.addEventListener('click', () => { mfg.loaded = false; void renderMfgView(view) })
      return
    }
  }
  const rerender = () => { void renderMfgView(view) }
  host.innerHTML = view === 'graph' ? viewGraph()
    : view === 'favorites' ? viewPlaza('favorites')
      : view === 'history' ? viewHistory()
        : viewPlaza('plaza')
  host.scrollTop = 0
  wireView(host, view, rerender)
}

/** 空间切换时清理抽屉（避免离开空间后浮层残留）。 */
export function closeMfgDrawer() {
  closeTool()
}

/** 设置弹层（本机记录开关；与源项目「工作台设置」同语义）。showModal 为本工作台的 (title, body) 适配器。 */
export function showMfgSettings(showModal) {
  showModal('制造工具箱设置', `<div class="mfg-settings">
      <p>收藏与设置保存在当前浏览器，不会跨设备同步。输入数据会发送到本平台数据面；AI 工具还会将相关输入发送至平台配置的模型服务。</p>
      <label class="mfg-setting"><span><strong>在本机保存运行记录</strong><small>保存输入和输出，最多 20 条。共用电脑建议关闭。</small></span>
        <input type="checkbox" id="mfgRemember" ${mfg.remember ? 'checked' : ''}/></label>
      <div class="mfg-setting"><span><strong>模型服务</strong><small>${mfg.catalog?.modelReady ? '平台已配置可用模型；各 Skill 仍须完成真实模型验收与领域放行' : '平台未配置模型（dsh 侧配置默认模型或登记模型渠道）'}</small></span>
        <span class="mfg-pill ${mfg.catalog?.modelReady ? 'ok' : ''}">${mfg.catalog?.modelReady ? '已连接' : '待配置'}</span></div>
      <button class="iaw-btn" id="mfgClearAll">清空本机记录</button>
    </div>`)
  const checkbox = document.getElementById('mfgRemember')
  if (checkbox) checkbox.onchange = () => { mfg.remember = checkbox.checked; writeStore('remember', mfg.remember) }
  const clear = document.getElementById('mfgClearAll')
  if (clear) clear.onclick = () => { mfg.history = []; writeStore('history', []); void renderMfgView('history') }
}