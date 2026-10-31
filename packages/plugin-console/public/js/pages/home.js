/**
 * 产品首页（公共营销页）：品牌叙事 + 资源生态树（canvas 特效）+ 能力矩阵 + 架构理念 + 快速开始。
 *
 * 免会话可浏览——未登录访问根路径落地本页（不再直接整登录页），登录从导航/CTA 进入 #/login。
 * 主题为品牌字面量色（科技蓝 #1466CF + 晶青蓝 #28B5EC + 微信绿 #07C160；2026-10-30 首页回退批次由元冰蓝/冰湖青切换，取自冰晶主题色系），不消费 --brand-*，
 * 免受登录态五平台 data-platform 主题覆写影响；样式见 css/home.css（index.html 直链）。
 * 特效零依赖（零构建约束）：canvas 2D 手绘生态树（生长动画 + 绿色流转脉冲 + 悬停依赖链高亮）、
 * 粒子星尘、数字滚动与滚动显现（IntersectionObserver）；rAF 循环以 canvas 脱离文档为退出条件。
 */
import { icon } from '../icons.js'
import { session } from '../api.js'
import { $, $$ } from '../ui.js'

/** 生态树数据：平台 → 三域 → 资源叶（与控制台导航同源的 12 个能力面） */
const TREE = {
  label: '元冰可平台',
  children: [
    { label: 'AI 资源域', children: ['Skill 市场', 'Agent 本体', 'AI 应用', 'MCP 服务', 'NAS 存储'] },
    { label: '治理与运营', children: ['组织账号', '审批中心', '审计告警', '财务视图'] },
    { label: '接入与协同', children: ['连接器', '平台接入', '部门面板'] },
  ],
}

const FEATURES = [
  { icon: 'zap', title: '资产登记', desc: '五类资源一个入口登记建档：元数据、归属、计量口径一步到位。' },
  { icon: 'sparkles', title: 'Skill 市场', desc: '企业级技能市场：上架审批、热度洞察、活跃日历一目了然。' },
  { icon: 'bot', title: 'Agent 本体', desc: 'Agent 身份与运行档案统一纳管，能力、依赖、健康度全程可见。' },
  { icon: 'app', title: 'AI 应用', desc: '应用注册即接入单点登录与计量，流量、活跃与成本一屏读懂。', green: true },
  { icon: 'plug', title: 'MCP 服务', desc: 'MCP 端点目录与调用治理：工具边界清晰、每一次调用可审计。' },
  { icon: 'server', title: 'NAS 存储', desc: '文件资产纳管与授权：数据不动、权限先行，跨域共享有据可查。', green: true },
  { icon: 'checkSquare', title: '审批中心', desc: '上架、授权、变更统一审批流：待办聚合、随时处理、留痕完整。' },
  { icon: 'scroll', title: '审计与告警', desc: '全链路操作审计与告警订阅，合规检查永远有据可依。', green: true },
  { icon: 'coins', title: '财务视图', desc: '用量与成本穿透到资源与团队：口径透明、内部结算可解释。' },
  { icon: 'users', title: '组织与账号', desc: '双轨身份 + 角色权限 + 三方集成：一套组织树管住所有入口。' },
  { icon: 'link', title: '连接器', desc: '钉钉等三方身份与消息通道开箱即接，组织协同不断档。', green: true },
  { icon: 'building', title: '部门面板', desc: '业务同学零门槛工作台：打开即用，无需理解控制台全貌。' },
]

const STATS = [
  { n: 9, unit: '大', lab: '业务域即插即用' },
  { n: 5, unit: '类', lab: 'AI 资源统一纳管' },
  { n: 24, unit: '个', lab: '平台插件并行运转' },
  { n: 1201, unit: '条', lab: '自检断言每次启动全绿' },
]

export function renderHome(app) {
  const loginLabel = session.token ? '进入控制台' : '登录控制台'
  app.innerHTML = `
  <div class="home">
    <nav class="home-nav" id="home-nav">
      <a class="home-nav-brand" href="#/home">
        <img src="ybk-mark.png" alt="元冰可">
        <div><div class="cn">元冰可</div><div class="en">YUANBINGKE</div></div>
      </a>
      <div class="home-nav-links">
        <a href="#sec-features">产品能力</a>
        <a href="#sec-arch">架构理念</a>
        <a href="#sec-start">快速开始</a>
      </div>
      <div class="home-nav-cta">
        <a class="home-btn home-btn-ghost" href="#/panels" style="height:38px;padding:0 16px;font-size:13.5px">部门面板</a>
        <a class="home-btn home-btn-primary" href="#/login" id="home-login-btn" style="height:38px;padding:0 18px;font-size:13.5px">${loginLabel}</a>
      </div>
      <button class="home-nav-toggle" id="home-nav-toggle" aria-label="打开菜单" aria-expanded="false">${icon('menu', 20)}</button>
    </nav>

    <header class="home-hero">
      <div class="home-hero-bg"><canvas id="home-stars"></canvas></div>
      <div class="home-hero-copy">
        <div class="home-hero-eyebrow"><span class="dot"></span>企业级 AI 资源管理平台</div>
        <h1>让团队一起用 AI，<br>把<span class="grad">每一份资源</span>都管起来</h1>
        <p class="home-hero-sub">Skill 市场、Agent 本体、AI 应用、MCP 服务、NAS 存储——五类资源一套身份、一套权限、一套审计。基于 DeepSeek Harness「一切皆插件」架构，九大业务域即插即用，按团队需要随用随上。</p>
        <div class="home-hero-actions">
          <a class="home-btn home-btn-primary" href="#/login">${icon('arrowUp')}${loginLabel}</a>
          <a class="home-btn home-btn-ghost" href="#sec-start">了解架构</a>
        </div>
        <div class="home-hero-hint">${icon('shieldCheck')}支持钉钉扫码 · 账号密码 · 一次性票据免登</div>
      </div>
      <div class="home-hero-visual">
        <div class="home-tree-wrap">
          <canvas id="home-tree"></canvas>
          <div class="home-tree-caption"><i></i>资源生态树 · 悬停查看依赖链路</div>
        </div>
      </div>
    </header>

    <div class="home-stats">
      ${STATS.map((s, i) => `
      <div class="home-stat home-reveal" style="--d:${i * 0.08}s">
        <div class="home-stat-num" data-n="${s.n}">0<span class="unit">${s.unit}</span></div>
        <div class="home-stat-lab">${s.lab}</div>
        <div class="bar"></div>
      </div>`).join('')}
    </div>

    <section class="home-section" id="sec-features">
      <div class="home-sec-head home-reveal">
        <div class="home-sec-kicker">产品能力</div>
        <h2>一个平台，管住企业的全部 AI 资产</h2>
        <p>从资源登记到用量计量、从权限治理到审计告警，九大业务域以插件形态按需启用——能力齐全，但从不为用不到的功能付费。</p>
      </div>
      <div class="home-grid">
        ${FEATURES.map((f, i) => `
        <div class="home-card${f.green ? ' green' : ''} home-reveal" style="--d:${(i % 4) * 0.07}s">
          <div class="home-card-ic">${icon(f.icon)}</div>
          <div class="home-card-title">${f.title}</div>
          <div class="home-card-desc">${f.desc}</div>
        </div>`).join('')}
      </div>
    </section>

    <section class="home-section" id="sec-arch">
      <div class="home-sec-head home-reveal">
        <div class="home-sec-kicker">架构理念</div>
        <h2>一切皆插件，治理与生俱来</h2>
        <p>平台自身由 24 个插件组成：业务域即插即用、按需生长；资源从注册那一刻起就进入身份、权限与审计的治理轨道。</p>
      </div>
      <div class="home-arch home-reveal">
        <div class="home-points">
          <div class="home-point">
            <div class="home-point-ic">${icon('puzzle')}</div>
            <div><b>一切皆插件</b><span>基于 DeepSeek Harness 插件架构，九大业务域即插即用：按团队需要随用随上，不绑架整体升级。</span></div>
          </div>
          <div class="home-point">
            <div class="home-point-ic">${icon('shieldCheck')}</div>
            <div><b>注册即治理</b><span>双轨身份 + 角色权限 + 令牌网关：从接入到调用全链路留痕，企业合规一次到位。</span></div>
          </div>
          <div class="home-point">
            <div class="home-point-ic">${icon('gitBranch')}</div>
            <div><b>依赖可穿透</b><span>应用 → Agent → MCP/Skill 拓扑一图可视：谁依赖谁、影响多大，改动之前先知道。</span></div>
          </div>
        </div>
        <div>
          <div class="home-topo">
            <svg viewBox="0 0 480 268" width="100%" role="img" aria-label="依赖拓扑示意">
              <defs>
                <marker id="tp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="rgba(159,196,255,0.55)"/>
                </marker>
              </defs>
              <g stroke="rgba(159,196,255,0.4)" stroke-width="1.3" fill="none" class="tp-edges">
                <path class="flow" d="M96,84 C150,84 160,66 214,66"/>
                <path class="flow" d="M96,84 C150,84 160,116 214,116"/>
                <path class="flow" d="M96,176 C150,176 160,116 214,116"/>
                <path class="flow" d="M96,176 C150,176 160,166 214,166"/>
                <path class="flow" d="M254,66 C310,66 320,62 366,62"/>
                <path class="flow" d="M254,66 C310,66 320,107 366,107"/>
                <path class="flow" d="M254,116 C310,116 320,107 366,107"/>
                <path class="flow" d="M254,116 C310,116 320,152 366,152"/>
                <path class="flow" d="M254,166 C310,166 320,152 366,152"/>
                <path class="flow" d="M254,166 C310,166 320,197 366,197"/>
              </g>
              <g stroke="#07C160" stroke-width="2" fill="none" opacity="0.95">
                <path class="flow" d="M96,84 C150,84 160,116 214,116"/>
                <path class="flow" d="M254,116 C310,116 320,152 366,152"/>
              </g>
              <g fill="rgba(255,255,255,0.05)" stroke="rgba(159,196,255,0.34)" stroke-width="1">
                <rect x="26" y="68" width="70" height="32" rx="8"/>
                <rect x="26" y="160" width="70" height="32" rx="8"/>
                <rect x="196" y="50" width="58" height="32" rx="8"/>
                <rect x="196" y="100" width="58" height="32" rx="8"/>
                <rect x="196" y="150" width="58" height="32" rx="8"/>
                <rect x="366" y="46" width="88" height="32" rx="8"/>
                <rect x="366" y="91" width="88" height="32" rx="8"/>
                <rect x="366" y="136" width="88" height="32" rx="8"/>
                <rect x="366" y="181" width="88" height="32" rx="8"/>
              </g>
              <g stroke="#07C160" stroke-width="1.6" fill="rgba(7,193,96,0.10)">
                <rect x="196" y="100" width="58" height="32" rx="8"/>
                <rect x="366" y="136" width="88" height="32" rx="8"/>
              </g>
              <g font-size="12" fill="#C4DBFF" text-anchor="middle" font-family="inherit">
                <text x="61" y="88">智能客服</text>
                <text x="61" y="180">营销助手</text>
                <text x="225" y="70">客服 Agent</text>
                <text x="225" y="120" fill="#4EE59B">数据 Agent</text>
                <text x="410" y="66">MCP · 知识库</text>
                <text x="410" y="111">Skill · 工单</text>
                <text x="410" y="156" fill="#4EE59B">MCP · 报表</text>
                <text x="410" y="201">Skill · 分析</text>
              </g>
              <g font-size="10.5" fill="#7E9AD2" text-anchor="middle">
                <text x="61" y="46">AI 应用</text>
                <text x="225" y="38">Agent 本体</text>
                <text x="410" y="30">能力底座（MCP / Skill）</text>
              </g>
            </svg>
            <div class="home-topo-cap">依赖穿透示例：营销助手 → 数据 Agent → MCP · 报表（绿色链路）</div>
          </div>
        </div>
      </div>
    </section>

    <section class="home-section" id="sec-start">
      <div class="home-sec-head home-reveal" style="text-align:center;margin-left:auto;margin-right:auto">
        <div class="home-sec-kicker" style="justify-content:center">快速开始</div>
        <h2>从第一份资产登记开始</h2>
        <p style="margin-left:auto;margin-right:auto">三步进入运转状态，治理能力随资源一起就位。</p>
      </div>
      <div class="home-cta-band">
        <div class="home-steps">
          <div class="home-step home-reveal">
            <div class="home-step-no">1</div>
            <b>登记第一份资源</b>
            <span>登录控制台，把第一个 MCP 服务或 Skill 登记建档——归属、口径、权限一次配齐。</span>
          </div>
          <div class="home-step home-reveal" style="--d:0.1s">
            <div class="home-step-no">2</div>
            <b>邀请团队按角色入岗</b>
            <span>组织账号开箱即建：管理员、开发者、审计员各就其位，权限随角色自动流转。</span>
          </div>
          <div class="home-step home-reveal" style="--d:0.2s">
            <div class="home-step-no">3</div>
            <b>部门面板开箱即用</b>
            <span>业务同学从钉钉或门户一键进入部门面板：打开即工作台，资源共享从第一天开始。</span>
          </div>
        </div>
        <div class="home-cta-actions home-reveal">
          <a class="home-btn home-btn-green" href="#/login">${loginLabel}</a>
          <a class="home-btn home-btn-light" href="#/panels">进入部门面板</a>
        </div>
        <div class="home-cta-note home-reveal">首次部署：平台管理员初始口令见服务器 data/admin-initial-password.txt，登录后请立即修改。</div>
      </div>
    </section>

    <footer class="home-footer">
      <div class="home-footer-inner">
        <div class="home-footer-brand">
          <img src="ybk-mark.png" alt="元冰可">
          <div>
            <div class="cn">元冰可 <span style="font-size:11px;letter-spacing:2px;color:#7E9AD2;font-weight:500">YUANBINGKE</span></div>
            <div class="en">让企业的每一份 AI 资产，安全、可见、可协作</div>
            <div class="tag">企业AI资源管理平台 · 一切皆插件</div>
          </div>
        </div>
        <div class="home-footer-links">
          <a href="#sec-features">产品能力</a>
          <a href="#sec-arch">架构理念</a>
          <a href="#sec-start">快速开始</a>
          <a href="#/panels">部门面板</a>
          <a href="https://github.com/01men/ybkkasi" target="_blank" rel="noopener" id="home-footer-github">GitHub 源码 · MIT</a>
        </div>
      </div>
      <div class="home-footer-meta">
        <span>© 2026 杭州元冰可科技有限公司 · 基于 DeepSeek Harness 构建</span>
        <span class="grow-dot"><i></i>系统运行中 · 自检断言全绿</span>
      </div>
    </footer>
  </div>`

  mountNav(app)
  mountStars($('#home-stars'))
  mountTree($('#home-tree'))
  mountCounters(app)
  mountReveal(app)
}

/* ---------- 顶部导航：滚动态玻璃效果 + 移动端汉堡下拉（≤880px） ---------- */
function mountNav() {
  const nav = $('#home-nav')
  if (!nav) return
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8)
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
  // 移动端：汉堡开合锚点菜单；点选锚点后收起
  $('#home-nav-toggle')?.addEventListener('click', () => {
    const open = nav.classList.toggle('open')
    const toggle = $('#home-nav-toggle')
    if (toggle) toggle.setAttribute('aria-expanded', String(open))
  })
  nav.querySelectorAll('.home-nav-links a').forEach((a) => {
    a.addEventListener('click', () => nav.classList.remove('open'))
  })
}

/* ---------- 粒子星尘（hero 背景）：零依赖 canvas ---------- */
function mountStars(canvas) {
  if (!canvas) return
  // canvas 缺席守卫（headless/jsdom 或 canvas 被禁用的环境）：跳过特效，页面结构照常渲染
  const ctx = canvas.getContext ? canvas.getContext('2d') : null
  if (!ctx) return
  let stars = []
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = canvas.clientWidth * dpr
    canvas.height = canvas.clientHeight * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const count = Math.round((canvas.clientWidth * canvas.clientHeight) / 16000)
    stars = Array.from({ length: Math.min(count, 70) }, () => ({
      x: Math.random() * canvas.clientWidth,
      y: Math.random() * canvas.clientHeight,
      r: 0.8 + Math.random() * 1.8,
      vy: 0.06 + Math.random() * 0.22,
      vx: (Math.random() - 0.5) * 0.08,
      ph: Math.random() * Math.PI * 2,
      green: Math.random() < 0.22,
    }))
  }
  resize()
  window.addEventListener('resize', resize)
  const tick = (t) => {
    if (!document.body.contains(canvas)) return
    const w = canvas.clientWidth
    const hgt = canvas.clientHeight
    ctx.clearRect(0, 0, w, hgt)
    for (const s of stars) {
      s.y -= s.vy
      s.x += s.vx
      if (s.y < -4) { s.y = hgt + 4; s.x = Math.random() * w }
      if (s.x < -4) s.x = w + 4
      if (s.x > w + 4) s.x = -4
      const a = 0.16 + 0.42 * (0.5 + 0.5 * Math.sin(t * 0.0012 + s.ph))
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
      ctx.globalAlpha = a
      ctx.fillStyle = s.green ? 'rgb(96,232,168)' : 'rgb(120,196,255)'
      ctx.fill()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/* ---------- 资源生态树：生长动画 + 绿色流转脉冲 + 悬停依赖链高亮 ---------- */
function mountTree(canvas) {
  if (!canvas) return
  // canvas 缺席守卫（headless/jsdom 或 canvas 被禁用的环境）：跳过生态树动画，页面结构照常渲染
  const ctx = canvas.getContext ? canvas.getContext('2d') : null
  if (!ctx) return
  const BLUE = '#1466CF'
  const CYAN = '#28B5EC'
  const LIGHT = '#C4DBFF'
  const GREEN = '#07C160'

  // 节点模型：id 用于链路高亮；node = {id, label, x, y, r, depth, parent, appearAt}
  let nodes = []
  let edges = []
  let pulses = []
  let ripples = []
  let hover = null
  let start = 0

  const layout = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const hgt = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = hgt * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    nodes = []
    edges = []
    const root = { id: '根', label: TREE.label, x: w / 2, y: 46, r: 15, depth: 0, parent: null, appearAt: 0 }
    nodes.push(root)
    TREE.children.forEach((domain, di) => {
      const dx = w * (0.5 + (di - 1) * 0.32)
      const dn = { id: `域${di}`, label: domain.label, x: dx, y: 128, r: 10.5, depth: 1, parent: root, appearAt: 0.16 + di * 0.1 }
      nodes.push(dn)
      edges.push({ from: root, to: dn, start: 0.05 + di * 0.09, end: 0.16 + di * 0.09 })
      const step = Math.min(42, (hgt - 210) / domain.children.length)
      domain.children.forEach((leaf, ci) => {
        const ln = {
          id: `域${di}叶${ci}`, label: leaf, x: dx, y: 196 + ci * step + 14,
          r: 4.5, depth: 2, parent: dn, appearAt: 0.3 + di * 0.06 + ci * 0.045,
        }
        nodes.push(ln)
        edges.push({ from: dn, to: ln, start: 0.24 + di * 0.06 + ci * 0.04, end: 0.3 + di * 0.06 + ci * 0.045 })
      })
    })
  }
  layout()
  window.addEventListener('resize', layout)

  const ease = (t) => 1 - Math.pow(1 - t, 3)
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    }
  }
  // 垂直方向连接的贝塞尔控制点（同 x 时退化为平滑直线，跨列时自然弯曲）
  const ctrl = (a, b) => {
    const mid = (a.y + b.y) / 2
    return [{ x: a.x, y: mid }, { x: b.x, y: mid }]
  }
  const edgePoints = (e) => {
    const [c1, c2] = ctrl(e.from, e.to)
    return { p0: { x: e.from.x, y: e.from.y + e.from.r + 3 }, c1, c2, p3: { x: e.to.x, y: e.to.y - e.to.r - 3 } }
  }
  const pointAt = (e, t) => { const { p0, c1, c2, p3 } = edgePoints(e); return bez(p0, c1, c2, p3, t) }
  const pathOf = (leaf) => {
    const chain = []
    for (let n = leaf; n; n = n.parent) chain.unshift(n)
    const segs = []
    for (let i = 0; i < chain.length - 1; i++) {
      segs.push(edges.find((e) => e.from === chain[i] && e.to === chain[i + 1]))
    }
    return { chain, segs }
  }

  // 悬停：命中叶子 → 高亮 根→叶 链路（依赖穿透语义）
  canvas.addEventListener('pointermove', (ev) => {
    const rect = canvas.getBoundingClientRect()
    const mx = ev.clientX - rect.left
    const my = ev.clientY - rect.top
    hover = null
    for (const n of nodes) {
      if (n.depth === 2 && Math.hypot(n.x - mx, n.y - my) < 18) { hover = n; break }
    }
    canvas.style.cursor = hover ? 'pointer' : 'default'
  })
  canvas.addEventListener('pointerleave', () => { hover = null })

  const spawnPulse = (now) => {
    const leaves = nodes.filter((n) => n.depth === 2)
    const leaf = leaves[Math.floor(Math.random() * leaves.length)]
    if (!leaf) return
    pulses.push({ segs: pathOf(leaf).segs, t: 0, speed: 0.55 + Math.random() * 0.3, leaf, born: now })
  }

  const draw = (now) => {
    if (!document.body.contains(canvas)) return
    if (!start) start = now
    const grow = ease(Math.min((now - start) / 2100, 1))
    const w = canvas.clientWidth
    const hgt = canvas.clientHeight
    const sway = Math.sin(now * 0.0011) * 3
    ctx.clearRect(0, 0, w, hgt)
    ctx.save()
    ctx.translate(0, sway)

    const hoverChain = hover ? new Set(pathOf(hover).chain) : null

    // 连线
    for (const e of edges) {
      const local = Math.max(0, Math.min(1, (grow - e.start) / Math.max(0.001, e.end - e.start)))
      if (local <= 0) continue
      const { p0, c1, c2, p3 } = edgePoints(e)
      const lit = hoverChain && (hoverChain.has(e.from) && hoverChain.has(e.to))
      const dim = hoverChain && !lit
      const steps = 26
      const upto = Math.max(1, Math.round(steps * local))
      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      for (let i = 1; i <= upto; i++) {
        const p = bez(p0, c1, c2, p3, (i / upto) * local)
        ctx.lineTo(p.x, p.y)
      }
      ctx.strokeStyle = lit ? 'rgba(111,212,255,0.95)' : 'rgba(40,181,236,0.34)'
      ctx.globalAlpha = dim ? 0.4 : 1
      ctx.lineWidth = lit ? 2.2 : 1.2
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // 节点
    for (const n of nodes) {
      const local = Math.max(0, Math.min(1, (grow - n.appearAt) / 0.22))
      if (local <= 0) continue
      const scale = 0.6 + 0.4 * ease(local) + (local >= 1 ? 0 : 0)
      const lit = !hoverChain || hoverChain.has(n)
      const alpha = hoverChain && !hoverChain.has(n) ? 0.45 : 1
      ctx.globalAlpha = alpha

      if (n.depth === 0) {  // 根：六边形平台节点（呼应 logo）
        ctx.beginPath()
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 6 + (i * Math.PI) / 3
          const px = n.x + Math.cos(a) * (n.r + 5) * scale
          const py = n.y + Math.sin(a) * (n.r + 5) * scale
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)
        }
        ctx.closePath()
        const g = ctx.createLinearGradient(n.x - 16, n.y - 16, n.x + 16, n.y + 16)
        g.addColorStop(0, BLUE)
        g.addColorStop(1, CYAN)
        ctx.fillStyle = g
        ctx.shadowColor = 'rgba(40,181,236,0.65)'
        ctx.shadowBlur = 16
        ctx.fill()
        ctx.shadowBlur = 0
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'
        ctx.lineWidth = 1
        ctx.stroke()
      } else if (n.depth === 1) {  // 域：实心青蓝圆
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r * scale, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(20,102,207,0.9)'
        ctx.shadowColor = 'rgba(40,181,236,0.55)'
        ctx.shadowBlur = 10
        ctx.fill()
        ctx.shadowBlur = 0
        ctx.strokeStyle = 'rgba(111,212,255,0.9)'
        ctx.lineWidth = 1.4
        ctx.stroke()
      } else {  // 叶：小圆点 + 右侧标签
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fillStyle = hover === n ? GREEN : 'rgba(159,196,255,0.9)'
        ctx.shadowColor = hover === n ? 'rgba(7,193,96,0.8)' : 'rgba(0,0,0,0)'
        ctx.shadowBlur = hover === n ? 9 : 0
        ctx.fill()
        ctx.shadowBlur = 0
      }
      ctx.globalAlpha = 1

      // 标签
      ctx.font = n.depth === 0
        ? '600 14px ' + getComputedStyle(document.body).fontFamily
        : n.depth === 1 ? '600 12.5px ' + getComputedStyle(document.body).fontFamily
          : '12px ' + getComputedStyle(document.body).fontFamily
      ctx.globalAlpha = alpha * local
      ctx.fillStyle = n.depth === 2 ? LIGHT : '#FFFFFF'
      if (n.depth === 0) {
        ctx.textAlign = 'center'
        ctx.fillText(n.label, n.x, n.y - n.r - 14)
      } else if (n.depth === 1) {
        ctx.textAlign = 'center'
        ctx.fillText(n.label, n.x, n.y - n.r - 9)
      } else {
        ctx.textAlign = 'left'
        ctx.fillStyle = hover === n ? '#7CF0AE' : lit ? LIGHT : 'rgba(187,211,255,0.75)'
        ctx.fillText(n.label, n.x + 11, n.y + 4)
      }
      ctx.globalAlpha = 1
    }

    // 生长完成后：绿色流转脉冲（根 → 域 → 叶，象征审批/授权/调用在链路上流转）
    if (grow >= 1) {
      if (!draw.lastSpawn || now - draw.lastSpawn > 720) {
        spawnPulse(now)
        draw.lastSpawn = now
      }
      pulses = pulses.filter((p) => p.t <= 1)
      for (const p of pulses) {
        p.t += 0.0065 * p.speed
        const tt = Math.max(0, Math.min(0.999, p.t))
        const seg = p.segs[Math.min(p.segs.length - 1, Math.floor(tt * p.segs.length))]
        const local = tt * p.segs.length - Math.floor(tt * p.segs.length)
        const pos = pointAt(seg, local)
        // 拖尾
        for (let k = 1; k <= 4; k++) {
          const tp = Math.max(0, tt - k * 0.018)
          const sg = p.segs[Math.min(p.segs.length - 1, Math.floor(tp * p.segs.length))]
          const lp = tp * p.segs.length - Math.floor(tp * p.segs.length)
          const pos2 = pointAt(sg, lp)
          ctx.beginPath()
          ctx.arc(pos2.x, pos2.y, 2.4 - k * 0.45, 0, Math.PI * 2)
          ctx.globalAlpha = 0.28 - k * 0.06
          ctx.fillStyle = 'rgb(7,193,96)'
          ctx.fill()
        }
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2)
        ctx.globalAlpha = 1
        ctx.fillStyle = GREEN
        ctx.shadowColor = 'rgba(7,193,96,0.95)'
        ctx.shadowBlur = 10
        ctx.fill()
        ctx.shadowBlur = 0
        if (p.t >= 1) ripples.push({ x: p.leaf.x, y: p.leaf.y, r: 4, a: 0.8 })
      }
    }

    // 抵达涟漪
    ripples = ripples.filter((rp) => rp.a > 0.02)
    for (const rp of ripples) {
      rp.r += 0.55
      rp.a *= 0.94
      ctx.beginPath()
      ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2)
      ctx.globalAlpha = rp.a
      ctx.strokeStyle = 'rgb(78,229,155)'
      ctx.lineWidth = 1.4
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    ctx.restore()
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)
}

/* ---------- 数字滚动 ---------- */
function mountCounters() {
  const els = $$('.home-stat-num')
  if (!els.length) return
  const animate = (el) => {
    const target = Number(el.dataset.n ?? 0)
    const unit = el.querySelector('.unit')
    // 动画帧缺席守卫（headless/jsdom / 老浏览器）：直接落终值，不做补间
    if (typeof requestAnimationFrame !== 'function') {
      el.innerHTML = `${target.toLocaleString('zh-CN')}<span class="unit">${unit?.textContent ?? ''}</span>`
      return
    }
    const t0 = performance.now()
    const dur = 1300
    const step = (now) => {
      if (!document.body.contains(el)) return
      const p = Math.min((now - t0) / dur, 1)
      const val = Math.round(target * (1 - Math.pow(1 - p, 3)))
      el.innerHTML = `${val.toLocaleString('zh-CN')}<span class="unit">${unit?.textContent ?? ''}</span>`
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  // 观察者缺席守卫（headless/jsdom / 老浏览器）：直接落终值，不留空白数字
  if (typeof IntersectionObserver === 'undefined') {
    els.forEach((el) => animate(el))
    return
  }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { animate(en.target); io.unobserve(en.target) }
    }
  }, { threshold: 0.4 })
  els.forEach((el) => io.observe(el))
}

/* ---------- 滚动显现 ---------- */
function mountReveal() {
  const els = $$('.home-reveal')
  if (!els.length) return
  // 观察者缺席守卫：直接置终态（.in），绝不让内容因缺少观察者而永久隐藏
  if (typeof IntersectionObserver === 'undefined') {
    els.forEach((el) => el.classList.add('in'))
    return
  }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target) }
    }
  }, { threshold: 0.12 })
  els.forEach((el) => io.observe(el))
}
