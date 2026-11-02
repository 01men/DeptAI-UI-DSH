/**
 * 平台接入（合并页，Kimi CIO 仪表盘设计适配 §5.9 · docs/internal/design-adaptation-spec-20261014.md）：
 *   tab=接入管理 enroll —— 原 connect 页（一次性接入码 / 已接入客户端 / 外部接入总览）全功能迁入；
 *   tab=宿主连接 hosts —— 复用 connections.js 导出的 renderConnections（非 standalone 形态）；
 *   tab=连接器目录 catalog —— connectors 摘要 + 状态 + 「完整目录」入口（#/connectors）。
 * 旧路由兼容：#/connect → #/access?tab=enroll（connect.js 薄重定向壳），#/connections 保留独立页。
 */
import { api } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openModal, confirmDialog, copyText,
  renderTable, statusBadge, collectForm, field, inputField, selectField, fmtTime, timeAgo,
} from '../ui.js'
import { renderConnections } from './connections.js'

const TEMPLATE_LABEL = { readonly: '只读运维', operator: '运维（读+变更）', executor: '执行方（读+执行）', full: '全部权限' }

/** Agent 本体一键接入口令：复制给 Agent 的中文一句话任务模板（含必填占位）。 */
const AGENT_NL_INSTRUCTION = `【任务】按《元冰可平台 · Agent 接入规范》把下面这个 Agent 接入平台 http://192.168.0.7:7300。

Agent 名称：<全局唯一名称>
描述：<一句话说明>
模型：<deepseek-chat | deepseek-reasoner | deepseek-coder>
风险等级：<low | medium | high>
平台账号：<资源管理员用户名>；口令：<口令>

【执行要求】
1. 严格按规范执行：登录 → 注册 → 用该 Agent 自己的机器凭证完成"发一句话"验证（GET /api/agents 能在列表找到自己）。
2. 名称已存在时按规范复用既有 Agent，不得换名重复注册。
3. clientSecret 只在注册时出现一次，立即安全保存，不得打印到公开输出。
4. 不做上线/下线等审批操作；若明确要求"可被应用编排"或"正式上线"，先补齐治理属性，再走平台 L4 审批单。
5. 完成后回报：Agent id（agt_ 前缀）、clientId、"发一句话"调用的状态码与关键证据、以及控制台查看路径。`

/** Agent 本体一键接入口令：复制可直接粘贴终端的 dshctl 命令串。 */
const AGENT_CLI_COMMAND = `# 1. 设置平台地址与管理员凭证
export DSHCTL_URL=http://192.168.0.7:7300
export DSHCTL_USER=<资源管理员用户名>
export DSHCTL_PASS=<口令>

# 2. 注册 Agent（成功后平台一次性下发 clientId/clientSecret，立即安全保存）
dshctl agent create \\
  --name=<全局唯一名称> \\
  --model=<deepseek-chat|deepseek-reasoner|deepseek-coder> \\
  --riskLevel=<low|medium|high> \\
  --description="<一句话说明>" \\
  --yes

# 3. 用返回的 clientId/clientSecret 换牌
dshctl auth client-credentials \\
  --clientId=<mc-...> \\
  --clientSecret=<cs-...>

# 4. 接入验证（"发一句话"）
export DSHCTL_TOKEN=<步骤3拿到的token>
dshctl agent list   # 列表中能找到自己的 agt_ 前缀 id 即接入完成`

/** AI 应用一键接入口令：复制给 Agent 的中文一句话任务模板。 */
const APP_NL_INSTRUCTION = `【任务】按《元冰可平台 · AI 应用接入规范》把下面这个应用接入平台 http://192.168.0.7:7300。

应用名称：<全局唯一名称>
应用说明：<一句话说明>
应用类型：<web | h5 | miniapp | desktop | api>
访问地址：<https://…（可后补）>
一次性接入码：<向平台管理员索取 enr_ 开头的码，需 operator 模板权限>

【执行要求】
1. 严格按规范执行：connect_setup（用一次性接入码）→ SSO 登录打通（owner 在控制台签发 OIDC 客户端）→ 指标提报 → 计量对齐。
2. 接入码一次消费、默认 15 分钟过期：随用随取，禁止保存复用、禁止写入代码或提示词；已使用/过期直接 connect_test。
3. 403 = 接入码模板权限不足（响应体指明缺哪个权限点），向管理员报告，不要换账号或重试硬闯。
4. SSO 客户端必须由 owner 在「AI应用→应用详情→SSO配置」签发，机器身份自签一律 403；未完成 SSO 签发无法上线。
5. 完成后回报：connect_setup 状态、SSO clientId、控制台查看路径（http://192.168.0.7:7300/ →「AI 应用」页）。`

/** AI 应用一键接入口令：复制可直接粘贴终端的 dshctl 命令串。 */
const APP_CLI_COMMAND = `# 0. 向平台管理员索取一次性接入码（enr_ 开头，operator 模板）
export DSHCTL_URL=http://192.168.0.7:7300
export ENROLLMENT_CODE=<enr_...>

# 1. 远程接入（拿到运维机器凭证）
dshctl connect setup --hubUrl=$DSHCTL_URL --enrollmentCode=$ENROLLMENT_CODE
dshctl connect test     # 自检：健康检查 + 换牌 + 一次只读调用

# 2. SSO 登录打通（owner 在「AI应用→应用详情→SSO配置」签发后填入）
export DSHCTL_OIDC_CLIENT_ID=<控制台签发的 client_id>
export DSHCTL_OIDC_CLIENT_SECRET=<控制台签发的 client_secret>
# 浏览器打开应用，按 app-sso-integration.md 完成授权码 + PKCE S256 流程

# 3. 每日 09:00 提报前一日指标（不带 --date 会记到当天）
dshctl app report <appId> \\
  --date=$(date -d 'yesterday' +%Y-%m-%d) \\
  --dau=<n> --sessions=<n> --retention7=<n> --avg-depth=<n>

# 4. 仅绕过平台网关的直连消耗才需推送（经平台网关的已自动计量）
dshctl usage record --org=<组织ID> --subject=user:<用户ID> --principal=org:<组织ID> \\
  --resource=mcp:<slug> --meter=tokens:<数量>:tokens \\
  --idempotency-key=<本应用名>:<业务单号>`

export async function renderAccess(content, params) {
  const tab = ['enroll', 'hosts', 'catalog'].includes(params.get('tab')) ? params.get('tab') : 'enroll'

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">PLATFORM ACCESS</div>
        <div class="page-title">平台接入</div>
        <div class="page-sub">机器凭证 + 一次性接入码 + 远程 dsh 客户端 + 宿主连接 + 连接器网关一处盘点 · 接入码一次性、只存哈希 · 凭证零进平台。</div>
      </div>
    </div>
    <div class="tabs" id="access-tabs">
      <div class="tab ${tab === 'enroll' ? 'active' : ''}" data-tab="enroll">接入管理</div>
      <div class="tab ${tab === 'hosts' ? 'active' : ''}" data-tab="hosts">宿主连接</div>
      <div class="tab ${tab === 'catalog' ? 'active' : ''}" data-tab="catalog">连接器目录</div>
    </div>
    <div id="access-body"></div>`

  $$('#access-tabs .tab').forEach((el) => {
    el.onclick = () => { location.hash = `#/access?tab=${el.dataset.tab}` }
  })

  const body = $('#access-body')
  if (tab === 'hosts') renderConnections(body, new URLSearchParams(), { standalone: false })
  else if (tab === 'catalog') await renderConnectorSummary(body)
  else await renderEnroll(body, params)
}

// ============ tab 一：接入管理（原 connect 页 enroll 全功能迁入，逻辑照搬） ============

async function renderEnroll(host, params) {
  const [codes, clients, principals, oidcClients] = await Promise.all([
    api.get('/api/connect/codes'),
    api.get('/api/connect/clients'),
    api.get('/api/authn/principals').catch(() => null),
    api.get('/api/authn/oidc/clients').catch(() => null),
  ])
  const hasOverview = principals !== null || oidcClients !== null

  host.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">ENROLLMENT</div>
        <div class="page-title">接入管理</div>
        <div class="page-sub">其他电脑的 dsh 经插件市场安装本平台后，凭一次性接入码向宿主申请机器凭证；工具调用全部转发宿主执行（按模板收敛权限、全程审计）。</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" id="connect-code-create">${icon('plus', 14)}创建接入码</button>
      </div>
    </div>

    <div class="card mb-20">
      <div class="card-head"><span class="card-title">${icon('fingerprint', 15)} 远程 dsh 一键接入（三步）</span></div>
      <div class="card-body fs-13" style="line-height:2">
        <div><b>1. 安装插件</b>（远程电脑执行）：<code class="mono">dsh plugin --profile web add github:01men/ybkkasi</code></div>
        <div><b>2. 申请口令</b>（任选其一）：① 在 dsh 界面对 Agent 说「<span class="mono">接入宿主 &lt;本机局域网地址&gt;，接入码 &lt;下方创建的码&gt;</span>」，Agent 调 <span class="mono">connect_setup</span> 自动完成；② 浏览器打开远程电脑的 <span class="mono">http://127.0.0.1:7390</span> 配置页可视化填写（可随时更新/断开）</div>
        <div><b>3. 验证</b>：远程 Agent 执行 <span class="mono">connect_status</span> / <span class="mono">agent_list</span>，工具已转发宿主执行并在下方「已接入客户端」出现记录。</div>
      </div>
    </div>

    <div class="flex mb-20" style="gap:14px;flex-wrap:wrap;align-items:stretch">
      <div class="card" style="flex:1;min-width:340px">
        <div class="card-head"><span class="card-title">${icon('bot', 15)} Agent 本体接入（三步）</span></div>
        <div class="card-body fs-13" style="line-height:1.9">
          <div><b>1. 环境</b>：<code class="mono">export DSHCTL_URL=http://192.168.0.7:7300</code>（管理员账号走 <code class="mono">DSHCTL_USER</code>/<code class="mono">DSHCTL_PASS</code>）。</div>
          <div><b>2. 注册</b>：<code class="mono">dshctl agent create --name=… --model=… --riskLevel=… --yes</code>，平台一次性下发机器凭证 <code class="mono">mc-…</code> / <code class="mono">cs_…</code>。</div>
          <div><b>3. 验证</b>（"发一句话"）：<code class="mono">dshctl auth client-credentials</code> 换牌 → <code class="mono">dshctl agent list</code> 列表中找到自己的 <code class="mono">agt_…</code> id。</div>
          <div class="fs-12 text-4 mt-8">需 agent.write 权限；clientSecret 仅注册响应可见，丢失只能轮换或重新注册。完整规范见折叠区。</div>
          <div class="flex mt-12" style="gap:8px;justify-content:flex-end;border-top:1px solid var(--border);padding-top:10px">
            <button class="btn btn-default btn-sm" data-copy="agent-nl">${icon('copy', 12)} 复制中文指令</button>
            <button class="btn btn-primary btn-sm" data-copy="agent-cli">${icon('terminal', 12)} 复制命令串</button>
          </div>
          <details class="mt-8">
            <summary class="fs-12 text-3" style="cursor:pointer;padding:4px 0">${icon('chevronDown', 12)} 查看完整规范（agent-app-onboarding.md · Agent 章节）</summary>
            <pre class="mono fs-12" style="white-space:pre-wrap;background:var(--bg-2);padding:10px;border-radius:6px;margin-top:6px;max-height:360px;overflow:auto">二、Agent 本体接入
  步骤 A1：注册（颁发机器凭证）
    POST /api/agents    Authorization: Bearer &lt;token&gt;
    { name, attrs: { description, model, riskLevel, avatar } }
    • description 必填；model 枚举 deepseek-chat|deepseek-reasoner|deepseek-coder
    • riskLevel 枚举 low|medium|high；avatar 一个 emoji
    • name 全局唯一；重名按幂等策略复用
  成功响应：data.agent.id (agt_…) + data.credential.{clientId (mc-…), clientSecret (cs_…)}
  clientSecret 仅此响应可见，平台侧不可再查询
  步骤 A2：Agent "发一句话"（接入验证）
    POST /api/auth/client-credentials  { clientId, clientSecret }
    取 data.token → GET /api/agents  Authorization: Bearer &lt;agent-token&gt;
    验收：200 且列表能找到自己的 id（在册确认；平台审计留痕）

四、上线与审批（完整态，可选）
  1. 补齐治理属性（PATCH /api/agents/:id）
     Agent 上线必填：dataClass
     进试运行（submit_trial）还需 trialGroups 非空
  2. 发起流转 POST /api/agents/:id/transition  { action: "online" }
     online/offline 为审批动作，返回审批单
  3. 审批执行 GET /api/approvals → POST /api/approvals/:id/decide
     有 approval.decide 权限者单人通过即执行
  护栏：禁止绕过审批直接改状态

五、幂等与重试
  • 重名即复用（GET /api/agents 按 name 找既有资源，不要换名重复注册）
  • client-credentials 可重复换牌
  • 失败锁定：登录/换牌连续失败锁来源 IP（15 分钟窗口 5 次起）

七、验收清单
  [ ] Agent 注册返回 agt_ 前缀 id 与 mc-/cs- 凭证
  [ ] 机器凭证换牌成功，GET /api/agents 能在列表找到自己（一句话完成）</pre>
          </details>
        </div>
      </div>

      <div class="card" style="flex:1;min-width:340px">
        <div class="card-head"><span class="card-title">${icon('sparkles', 15)} AI 应用接入（三步）</span></div>
        <div class="card-body fs-13" style="line-height:1.9">
          <div><b>1. 远程接入</b>：向平台管理员索取一次性接入码 <code class="mono">enr_…</code>（operator 模板，含 app.write / usage.write），执行 <code class="mono">dshctl connect setup</code> 拿到运维机器凭证。</div>
          <div><b>2. SSO 登录打通</b>：owner 在「AI 应用 → 应用详情 → SSO 配置」签发 OIDC 客户端；浏览器按 app-sso-integration.md 完成授权码 + PKCE S256。</div>
          <div><b>3. 指标与计量</b>：每日 09:00 <code class="mono">dshctl app report</code> 提报前日指标；仅绕过平台网关的直连消耗才 <code class="mono">dshctl usage record</code>。</div>
          <div class="fs-12 text-4 mt-8">机器身份自签 SSO 一律 403；web/h5 应用未完成 SSO 签发无法上线。完整规范见折叠区。</div>
          <div class="flex mt-12" style="gap:8px;justify-content:flex-end;border-top:1px solid var(--border);padding-top:10px">
            <button class="btn btn-default btn-sm" data-copy="app-nl">${icon('copy', 12)} 复制中文指令</button>
            <button class="btn btn-primary btn-sm" data-copy="app-cli">${icon('terminal', 12)} 复制命令串</button>
          </div>
          <details class="mt-8">
            <summary class="fs-12 text-3" style="cursor:pointer;padding:4px 0">${icon('chevronDown', 12)} 查看完整规范（agent-app-onboarding.md · AI 应用章节）</summary>
            <pre class="mono fs-12" style="white-space:pre-wrap;background:var(--bg-2);padding:10px;border-radius:6px;margin-top:6px;max-height:360px;overflow:auto">三、AI 应用接入
  步骤 B1：注册
    POST /api/apps    Authorization: Bearer &lt;token&gt;
    { name, attrs: { description, appType, icon, url, riskLevel, dataClass, agentIds } }
    • description 必填；appType 枚举 web|h5|miniapp|desktop|api
    • riskLevel 枚举 low|medium|high
    • url、dataClass (public/internal/confidential)、agentIds 为上线前必填，注册时可暂缺
    • agentIds 编排的 Agent 必须已上线（online），否则 400
  成功响应：data.app.id (app_…) + data.credential.{clientId, clientSecret}
  步骤 B2：应用 "发一句话"（接入验证）
    POST /api/apps/&lt;appId&gt;/metrics-report
    { dau, sessions, avgDepth, retention7 }
    验收：200 + GET /api/apps/&lt;appId&gt; 中 data.metrics.sessions ≥ 1

四、上线与审批（完整态，可选）
  1. 补齐治理属性（PATCH /api/apps/:id）
     应用上线必填：url、dataClass、agentIds（至少一个已上线 Agent）
  2. 发起流转 POST /api/apps/:id/transition  { action: "online" }
  3. 审批执行 GET /api/approvals → POST /api/approvals/:id/decide
  4. 应用（web/h5）上线还有 SSO 门禁：owner 签发 SSO 客户端
     POST /api/apps/:id/sso-client，否则上线被拒

五、幂等与重试
  • 重名即复用（GET /api/apps 按 name 找既有资源）
  • 指标上报语义：同日 DAU 取最大值、会话数累加；重复上报安全

七、验收清单
  [ ] 应用注册返回 app_ 前缀 id（编排时确认所依赖 Agent 已 online）
  [ ] metrics-report 上报 200，GET /api/apps/:id 显示会话数 ≥ 1（一句话完成）</pre>
          </details>
        </div>
      </div>
    </div>

    <div class="tabs">
      ${hasOverview ? '<div class="tab" data-tab="overview">外部接入总览</div>' : ''}
      <div class="tab ${hasOverview ? '' : 'active'}" data-tab="codes">${esc(rqI18n.t('接入码 ({n})', { n: codes.codes.length }))}</div>
      <div class="tab" data-tab="clients">${esc(rqI18n.t('已接入客户端 ({n})', { n: clients.clients.length }))}</div>
    </div>
    <div id="connect-body"></div>`

  // 本 tab 内自刷新：重拉数据重渲染（原 connect 页 renderConnect(content) 递归的等价替换）
  const refresh = () => renderEnroll(host, params)

  $('#connect-code-create', host).onclick = openCreateCode

  /** 接入卡的一键复制按钮：把指定接入口令文本写入剪贴板。 */
  const COPY_PAYLOAD = {
    'agent-nl': AGENT_NL_INSTRUCTION,
    'agent-cli': AGENT_CLI_COMMAND,
    'app-nl': APP_NL_INSTRUCTION,
    'app-cli': APP_CLI_COMMAND,
  }
  $$('[data-copy]', host).forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.copy
      const text = COPY_PAYLOAD[key]
      if (!text) return
      const ok = copyText(text)
      if (ok && typeof ok.then === 'function') ok.catch(() => {})
    }
  })

  const body = $('#connect-body', host)
  $$('.tab', host).forEach((el) => {
    el.onclick = () => {
      $$('.tab', host).forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })

  function renderTab(tab) {
    if (tab === 'overview') renderOverview()
    else if (tab === 'codes') renderCodes()
    else renderClients()
  }

  /** 外部接入总览：机器凭证 + OIDC 客户端 + 远程 dsh 一处盘点，跳转对应管理页。 */
  function renderOverview() {
    const machines = (principals?.principals ?? []).filter((p) => p.type === 'machine')
    const byRef = (type) => machines.filter((p) => p.refType === type)
    const oidc = oidcClients?.clients ?? []
    const oidcActive = oidc.filter((c) => c.status === 'active')
    const refCard = (title, list, jump, icon2) => `
      <div class="card card-pad" style="flex:1;min-width:280px">
        <div class="flex-between mb-8">
          <div class="card-title">${icon(icon2, 14)} ${esc(rqI18n.t('{title}（{n}）', { title: rqI18n.t(title), n: list.length }))}</div>
          <button class="btn btn-ghost btn-sm" data-jump="${esc(jump)}">前往管理 ${icon('chevronRight', 12)}</button>
        </div>
        ${list.slice(0, 6).map((item) => `
          <div class="flex" style="padding:6px 0;border-bottom:1px solid var(--border);gap:8px">
            <span class="fs-12 grow ellipsis">${esc(item.name)}</span>
            <span class="fs-11 text-4 mono">${esc(item.id)}</span>
            ${statusBadge(item.status === 'active' ? 'active' : 'frozen', item.status === 'active' ? '正常' : '禁用')}
          </div>`).join('') || '<div class="text-4 fs-12" style="padding:6px 0">暂无</div>'}
        ${list.length > 6 ? `<div class="fs-12 text-4 mt-8">${esc(rqI18n.t('… 共 {n} 项', { n: list.length }))}</div>` : ''}
      </div>`
    body.innerHTML = `
      <div class="muted-box mb-14" style="display:flex;gap:8px">${icon('info', 15)}<span>三类「外部接入身份」一处盘点：<b>机器凭证</b>（API 调用方，按绑定资源分组）、<b>OIDC 客户端</b>（应用 SSO 登录接入）、<b>远程 dsh</b>（接入码换牌的工具代理客户端）。</span></div>
      <div class="stat-grid mb-14" style="grid-template-columns:repeat(4,1fr)">
        <div class="card card-pad"><div class="fs-12 text-3">机器凭证（Agent 绑定）</div><div class="col-num" style="font-size:24px;font-weight:700">${byRef('agent').length}</div></div>
        <div class="card card-pad"><div class="fs-12 text-3">机器凭证（应用/外部）</div><div class="col-num" style="font-size:24px;font-weight:700">${byRef('app').length + byRef('external').length + machines.filter((p) => !p.refType).length}</div></div>
        <div class="card card-pad"><div class="fs-12 text-3">OIDC 客户端（活跃）</div><div class="col-num" style="font-size:24px;font-weight:700">${oidcActive.length}/${oidc.length}</div></div>
        <div class="card card-pad"><div class="fs-12 text-3">远程 dsh 客户端</div><div class="col-num" style="font-size:24px;font-weight:700">${clients.clients.filter((c) => c.status === 'active').length}</div></div>
      </div>
      <div class="flex mb-14" style="gap:14px;flex-wrap:wrap;align-items:stretch">
        ${refCard('机器凭证 · 绑定 Agent', byRef('agent'), '#/authn', 'bot')}
        ${refCard('机器凭证 · 应用 / 外部系统', [...byRef('app'), ...byRef('external'), ...machines.filter((p) => !p.refType)], '#/authn', 'key')}
      </div>
      <div class="flex mb-14" style="gap:14px;flex-wrap:wrap;align-items:stretch">
        <div class="card card-pad" style="flex:1;min-width:280px">
          <div class="flex-between mb-8">
            <div class="card-title">${icon('plug', 14)} ${esc(rqI18n.t('OIDC 客户端（应用 SSO / 外部登记，{n}）', { n: oidc.length }))}</div>
            <button class="btn btn-ghost btn-sm" data-jump="#/authn">前往管理 ${icon('chevronRight', 12)}</button>
          </div>
          ${oidc.slice(0, 6).map((c) => `
            <div class="flex" style="padding:6px 0;border-bottom:1px solid var(--border);gap:8px">
              <span class="fs-12 grow ellipsis">${esc(c.name)}${c.refAppName ? ` <span class="text-4">· ${esc(c.refAppName)}</span>` : ''}</span>
              <span class="badge ${c.clientType === 'public' ? 'badge-purple' : 'badge-info'} no-dot">${c.clientType === 'public' ? 'public' : 'confidential'}</span>
              ${statusBadge(c.status === 'active' ? 'active' : 'frozen', c.status === 'active' ? '使用中' : '已禁用')}
            </div>`).join('') || '<div class="text-4 fs-12" style="padding:6px 0">暂无；在「AI 应用 → SSO 配置」或「认证与令牌 → OIDC 客户端」登记</div>'}
          ${oidc.length > 6 ? `<div class="fs-12 text-4 mt-8">${esc(rqI18n.t('… 共 {n} 项', { n: oidc.length }))}</div>` : ''}
        </div>
        ${refCard('远程 dsh 已接入客户端', clients.clients, '#/access?tab=enroll&sub=clients', 'terminal')}
      </div>`
    body.querySelectorAll('[data-jump]').forEach((btn) => {
      btn.onclick = () => { location.hash = btn.dataset.jump }
    })
  }

  function codeStatus(record) {
    if (record.status === 'revoked') return statusBadge('offline', '已作废')
    if (record.status === 'used') return statusBadge('archived', '已使用')
    if (record.status === 'expired') return statusBadge('offline', '已过期')
    return statusBadge('active', '待使用')
  }

  function renderCodes() {
    const table = renderTable({
      columns: [
        { title: '接入码', width: '22%', render: (c) => `<span class="mono fs-12">${esc(c.codeMask)}</span><div class="col-sub fs-11">仅创建时展示一次</div>` },
        { title: '权限模板', width: 130, render: (c) => `<span class="badge ${c.template === 'full' ? 'badge-warn' : 'badge-info'} no-dot">${esc(TEMPLATE_LABEL[c.template] ?? c.template)}</span>` },
        { title: '有效期至', width: 150, render: (c) => `<span class="fs-12 text-3">${fmtTime(c.expiresAt)}</span>` },
        { title: '状态', width: 100, render: codeStatus },
        { title: '使用方', render: (c) => c.usedBy ? `<span class="fs-12">${esc(c.usedBy)}</span>` : '<span class="text-4">—</span>' },
        { title: '备注/创建', render: (c) => `<span class="fs-12">${esc(c.remark || '—')}</span><div class="col-sub fs-11">${esc(c.createdBy)} · ${timeAgo(c.createdAt)}</div>` },
        {
          title: '', width: 70,
          render: (c) => c.status === 'active'
            ? `<button class="btn btn-default btn-sm" data-revoke="${esc(c.id)}">${icon('x', 12)}作废</button>`
            : '',
        },
      ],
      rows: codes.codes,
      onRowClick: () => {},
      empty: '暂无接入码；点击右上角「创建接入码」开始远程接入',
    })
    body.innerHTML = ''
    body.appendChild(table)
    body.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.onclick = async (event) => {
        event.stopPropagation()
        const result = await confirmDialog({ title: '作废接入码', message: '作废后该码立即失效，未接入的远程电脑将无法使用它申请凭证。', danger: true, confirmText: '作废' })
        if (!result) return
        try {
          await api.delete(`/api/connect/codes/${btn.dataset.revoke}`)
          toast(rqI18n.t('接入码已作废'))
          void refresh()
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }

  function renderClients() {
    const table = renderTable({
      columns: [
        {
          title: '客户端', width: '24%',
          render: (c) => `
            <div class="flex" style="gap:10px">
              <div class="avatar sm" style="background:linear-gradient(135deg,#0ea5e9,#2563eb)">${icon('terminal', 13)}</div>
              <div>
                <div class="col-strong">${esc(c.name)}</div>
                <div class="col-sub mono fs-11">${esc(c.clientId)}</div>
              </div>
            </div>`,
        },
        { title: '权限模板', width: 130, render: (c) => `<span class="badge ${c.template === 'full' ? 'badge-warn' : 'badge-info'} no-dot">${esc(TEMPLATE_LABEL[c.template] ?? (c.template || '手工凭证'))}</span>` },
        { title: '来源主机', render: (c) => `<span class="mono fs-12">${esc(c.hostname || '—')}</span><div class="col-sub fs-11">${esc(c.platform || '')}</div>` },
        { title: '接入时间', width: 150, render: (c) => `<span class="fs-12 text-3">${fmtTime(c.enrolledAt)}</span>` },
        { title: '最近使用', width: 120, render: (c) => `<span class="fs-12 ${c.lastUsedAt ? '' : 'text-4'}">${c.lastUsedAt ? timeAgo(c.lastUsedAt) : '未调用'}</span>` },
        { title: '最近心跳', width: 120, render: (c) => `<span class="fs-12 ${c.lastHeartbeatAt ? '' : 'text-4'}">${c.lastHeartbeatAt ? timeAgo(c.lastHeartbeatAt) : '未上报'}</span>${c.heartbeat?.tools !== undefined ? `<div class="col-sub fs-11">${esc(rqI18n.t('工具 {n}', { n: c.heartbeat.tools }))}${c.heartbeat?.uptimeSec !== undefined ? esc(rqI18n.t(' · 运行 {n}min', { n: Math.floor(c.heartbeat.uptimeSec / 60) })) : ''}</div>` : ''}` },
        { title: '状态', width: 100, render: (c) => statusBadge(c.status === 'active' ? 'active' : 'frozen', c.status === 'active' ? '正常' : '已禁用') },
        {
          title: '', width: 90,
          render: (c) => c.status === 'active'
            ? `<button class="btn btn-default btn-sm" data-disable="${esc(c.id)}" data-name="${esc(c.name)}">${icon('x', 12)}禁用</button>`
            : `<button class="btn btn-default btn-sm" data-enable="${esc(c.id)}">${icon('check', 12)}恢复</button>`,
        },
      ],
      rows: clients.clients,
      onRowClick: (id, row) => openClientDetail(row),
      empty: '暂无已接入客户端；远程电脑完成接入后会出现在这里',
    })
    body.innerHTML = ''
    body.appendChild(table)
    body.querySelectorAll('[data-disable]').forEach((btn) => {
      btn.onclick = async (event) => {
        event.stopPropagation()
        const result = await confirmDialog({
          title: rqI18n.t('禁用客户端「{name}」', { name: btn.dataset.name }),
          message: '将联动吊销其全部机器令牌，远程工具调用立即失效。',
          requireReason: true, danger: true, confirmText: '禁用',
        })
        if (!result) return
        try {
          await api.post(`/api/connect/clients/${btn.dataset.disable}/disable`, { reason: result.reason ?? '' })
          toast(rqI18n.t('客户端已禁用，令牌已联动吊销'))
          void refresh()
        } catch (error) { toast(error.message, 'error') }
      }
    })
    body.querySelectorAll('[data-enable]').forEach((btn) => {
      btn.onclick = async (event) => {
        event.stopPropagation()
        try {
          await api.post(`/api/connect/clients/${btn.dataset.enable}/enable`, {})
          toast(rqI18n.t('客户端已恢复'))
          void refresh()
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }

  function openClientDetail(client) {
    const scopeText = client.scopes.length > 12 ? rqI18n.t('{scopes} 等 {n} 项', { scopes: client.scopes.slice(0, 12).join('、'), n: client.scopes.length }) : client.scopes.join('、')
    openModal({
      title: rqI18n.t('接入客户端：{name}', { name: client.name }),
      body: h(`
        <div class="kv-list fs-13" style="line-height:2.2">
          <div><span class="text-4">ClientId：</span><span class="mono">${esc(client.clientId)}</span></div>
          <div><span class="text-4">权限模板：</span>${esc(rqI18n.t(TEMPLATE_LABEL[client.template] ?? (client.template || '手工凭证')))}（${client.scopes.includes('*') ? esc(rqI18n.t('全部权限')) : esc(rqI18n.t('{n} 个权限点', { n: client.scopes.length }))}）</div>
          <div><span class="text-4">生效权限：</span><span class="fs-12">${esc(scopeText)}</span></div>
          <div><span class="text-4">来源主机：</span><span class="mono">${esc(client.hostname || '—')}</span>（${esc(client.platform || '未知平台')}）</div>
          <div><span class="text-4">接入时间：</span>${fmtTime(client.enrolledAt)}</div>
          <div><span class="text-4">最近使用：</span>${client.lastUsedAt ? timeAgo(client.lastUsedAt) : '未调用'} · ${esc(rqI18n.t('活跃令牌 {n} 个', { n: client.activeTokens }))}</div>
          <div><span class="text-4">最近心跳：</span>${client.lastHeartbeatAt ? timeAgo(client.lastHeartbeatAt) : '未上报'}${client.heartbeat?.tools !== undefined ? esc(rqI18n.t(' · 工具 {n} 个', { n: client.heartbeat.tools })) : ''}${client.heartbeat?.version ? ` · ${esc(client.heartbeat.version)}` : ''}${client.heartbeat?.uptimeSec !== undefined ? esc(rqI18n.t(' · 在线 {n} 分钟', { n: Math.floor(client.heartbeat.uptimeSec / 60) })) : ''}</div>
        </div>`),
      foot: '<button class="btn btn-default" data-cancel>关闭</button>',
    })
  }

  function openCreateCode() {
    const templates = clients.templates ?? []
    const modal = openModal({
      title: '创建接入码（一次性）',
      body: h(`
        <form id="connect-code-form">
          ${field('权限模板', selectField('template', templates.map((t) => ({ value: t.name, label: `${t.label} —— ${t.description}` })), { value: 'readonly' }), { hint: '接入后远程客户端的权限边界，等价于为其签发的口令权限' })}
          ${field('有效分钟数', inputField('ttlMinutes', { value: '15' }), { hint: '超时未使用自动过期（1-1440）' })}
          ${field('用途备注', inputField('remark', { placeholder: '如：研发部小王的办公电脑 dsh' }), { hint: '便于审计与识别使用方' })}
        </form>`),
      // foot 传字符串：openModal 走 innerHTML，可含多个按钮（h() 只取 firstElementChild 会丢按钮）
      foot: `
        <button class="btn btn-default" data-cancel>取消</button>
        <button class="btn btn-primary" id="connect-code-submit">创建并展示接入码</button>`,
    })
    modal.el.querySelector('#connect-code-submit').onclick = async () => {
      const values = collectForm(modal.el.querySelector('#connect-code-form'))
      try {
        const created = await api.post('/api/connect/codes', {
          template: values.template,
          ttlMinutes: Number(values.ttlMinutes) || 15,
          remark: values.remark ?? '',
        })
        modal.close()
        showOneTimeCode(created)
      } catch (error) { toast(error.message, 'error') }
    }
  }

  function showOneTimeCode(created) {
    const modal = openModal({
      title: '接入码已创建（仅展示这一次）',
      // body 传字符串：含多个顶层元素（h() 只取 firstElementChild 会丢内容）
      body: `
        <div class="fs-13 text-4 mb-8">${esc(rqI18n.t('请立即复制并发送给远程电脑的使用者（有效至 {time}）：', { time: fmtTime(created.expiresAt) }))}</div>
        <div class="flex" style="gap:8px;align-items:center">
          <code class="mono" id="connect-one-time-code" style="flex:1;padding:12px;border-radius:8px;background:var(--bg-2);font-size:14px;word-break:break-all">${esc(created.code)}</code>
          <button class="btn btn-default" id="connect-copy-code">${icon('check', 12)}复制</button>
        </div>
        <div class="fs-12 mt-12" style="line-height:1.9">
          远程电脑安装插件后，在 dsh 界面对 Agent 说：<br>
          <span class="mono">「接入宿主平台，地址 &lt;本机局域网地址:端口&gt;，接入码 &lt;上面的码&gt;」</span><br>
          Agent 将执行 <span class="mono">connect_setup</span> 自动申请口令；也可打开远程电脑的 <span class="mono">http://127.0.0.1:7390</span> 配置页填写。
        </div>`,
      foot: '<button class="btn btn-primary" data-cancel>我已保存</button>',
    })
    modal.el.querySelector('#connect-copy-code').onclick = () => copyText(created.code)
    void refresh()
  }

  // 内层子 tab（#sub=）：原 #/connect?tab=clients / codes / overview 深链语义由 connect.js 薄重定向转发
  const sub = params?.get('sub')
  const initialTab = sub === 'clients' ? 'clients' : sub === 'codes' ? 'codes' : sub === 'overview' && hasOverview ? 'overview' : (hasOverview ? 'overview' : 'codes')
  $$('.tab', host).forEach((el) => { if (el.dataset.tab === initialTab) el.classList.add('active'); else el.classList.remove('active') })
  renderTab(initialTab)
}

// ============ tab 三：连接器目录摘要（全功能在 #/connectors，此处只读摘要 + 入口） ============

const AUTH_LABEL = { oauth: 'OAuth 代理授权', api_key: 'API Key 表单直达', custom_credential: '自定义凭证', no_auth: '免凭证虚拟登记' }

async function renderConnectorSummary(host) {
  const [gateway, connections, permGroups, catalogMeta] = await Promise.all([
    api.get('/api/connector/gateway').catch(() => null),
    api.get('/api/connector/connections').catch(() => null),
    api.get('/api/connector/perm-groups').catch(() => null),
    api.get('/api/connector/catalog?kind=providers&limit=1').catch(() => null),
  ])
  const available = gateway?.available === true
  const refs = connections?.connections ?? []
  const activeCount = refs.filter((r) => r.status === 'active').length
  const syncedAt = catalogMeta?.syncedAt

  host.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">CONNECTOR / SAAS</div>
        <div class="page-title">连接器目录</div>
        <div class="page-sub">open-connector 数据面网关：目录 / 连接（OAuth · API Key · 免凭证）/ 双层授权（权限组 ↔ oct_ 令牌镜像）。凭证托管在网关侧保险库，平台零密钥落盘。</div>
      </div>
      <div class="page-actions">
        <span class="badge ${available ? 'badge-ok' : 'badge-warn'} no-dot" title="${esc(gateway?.reason ?? '')}">
          ${icon(available ? 'check' : 'alert', 12)} ${available ? esc(rqI18n.t('网关在线 {ms}ms', { ms: gateway.latencyMs ?? 0 })) : esc(gateway ? rqI18n.t('网关不可用') : rqI18n.t('网关状态未知'))}
        </span>
        <a class="btn btn-primary" href="#/connectors">${icon('plug', 14)}完整目录</a>
      </div>
    </div>

    <div class="stat-grid mb-20" style="grid-template-columns:repeat(4,1fr)">
      <div class="card card-pad">
        <div class="fs-12 text-3">目录同步</div>
        <div class="col-num" style="font-size:20px;font-weight:700">${syncedAt ? '已同步' : '未同步'}</div>
        <div class="fs-11 text-4 mt-4">${syncedAt ? esc(rqI18n.t('最近同步 {time}', { time: timeAgo(syncedAt) })) : '在完整目录页点「同步目录」拉取'}</div>
      </div>
      <div class="card card-pad">
        <div class="fs-12 text-3">连接引用</div>
        <div class="col-num" style="font-size:20px;font-weight:700">${refs.length}</div>
        <div class="fs-11 text-4 mt-4">${esc(rqI18n.t('启用 {a} · 待授权 {b}', { a: activeCount, b: refs.length - activeCount }))}</div>
      </div>
      <div class="card card-pad">
        <div class="fs-12 text-3">权限组</div>
        <div class="col-num" style="font-size:20px;font-weight:700">${(permGroups?.groups ?? []).length}</div>
        <div class="fs-11 text-4 mt-4">每组独立铸造 oct_ 运行时令牌</div>
      </div>
      <div class="card card-pad">
        <div class="fs-12 text-3">凭证托管</div>
        <div class="col-num" style="font-size:20px;font-weight:700">网关侧</div>
        <div class="fs-11 text-4 mt-4">AES-256-GCM 保险库 · 平台只存脱敏引用</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('link', 15)} ${esc(rqI18n.t('连接引用摘要（{n}）', { n: refs.length }))}</span>
        <span class="card-sub">完整管理（新建连接 / 权限组 / 运行日志 / 对账）在连接器页</span>
      </div>
      <div class="card-body" style="padding-top:8px">
        ${refs.slice(0, 8).map((ref) => `
          <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border);gap:10px;align-items:center">
            <span style="color:var(--brand-500)">${icon('plug', 14)}</span>
            <span class="fs-13" style="font-weight:600">${esc(ref.provider)}</span>
            <span class="mono fs-11 text-4" style="word-break:break-all">${esc(ref.alias)}</span>
            <span class="fs-11 text-3" style="margin-left:auto">${esc(rqI18n.t(AUTH_LABEL[ref.authType] ?? ref.authType ?? '—'))}${ref.bridge ? esc(rqI18n.t(' · 桥接过渡')) : ''}</span>
            ${statusBadge(ref.status === 'active' ? 'active' : 'pending', ref.status === 'active' ? '已启用' : '待授权')}
          </div>`).join('') || `
          <div class="empty-hint" style="padding:16px">
            ${icon('plug', 16)} 还没有连接引用——到 <a href="#/connectors" style="color:var(--brand-500)">完整目录</a> 按三形态向导（免凭证 / OAuth / API Key）新建。
          </div>`}
        ${refs.length > 8 ? `<div class="fs-12 text-4 mt-8">${esc(rqI18n.t('… 共 {n} 条，', { n: refs.length }))}<a href="#/connectors" style="color:var(--brand-500)">查看完整目录</a></div>` : ''}
      </div>
    </div>`
}
