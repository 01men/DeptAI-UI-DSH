/** 接入指引生成器：手动注册 Agent / AI 应用成功后，按平台接入规范自动生成可执行指引（附刚颁发的凭证）。 */
import { esc, openModal, copyText } from './ui.js'

const base = () => location.origin

/** Agent 接入指引全文（可直接交给执行 Agent 照做；凭证已填好）。 */
export function buildAgentOnboardingText(agent, credential) {
  const origin = base()
  return `【任务】按《元冰可平台 · Agent 接入指引》完成下方 Agent 的接入验证与运营数据提报。平台地址：${origin}

【资源与凭证】（client_secret 仅此一次展示，请立即安全保存，不落明文日志）
- Agent ID：${agent.id}
- 唯一标识：${agent.slug ?? '—'}
- client_id：${credential.clientId}
- client_secret：${credential.clientSecret}

【第 1 步 · 机器凭证换牌】（令牌 2 小时有效，可随时重复换取）
curl -s -X POST ${origin}/api/auth/client-credentials \\
  -H 'content-type: application/json' \\
  -d '{"clientId":"${credential.clientId}","clientSecret":"${credential.clientSecret}"}'
→ 取响应 data.token，后续请求头带：Authorization: Bearer <token>

【第 2 步 · 接入验证（"发一句话"：首次运营数据提报）】
curl -s -X POST ${origin}/api/agents/${agent.id}/metrics-report \\
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \\
  -d '{"dau":1,"sessions":1,"uniqueUsers":1}'
→ 返回 200 即接入成功；GET ${origin}/api/agents/${agent.id} 中 metrics.sessions ≥ 1 可复核。
【接入义务】每日定时提报运营数据是接入平台的强制要求（与 AI 应用同级），不是倡导：
- 必报字段：dau（日活跃用户数，同日取最大）、sessions（对话会话数，同日累加）、
  uniqueUsers（对话去重用户数）；有用户明细时随报 userIds 列表（平台侧哈希脱敏去重，不落明文）。
- 重复上报安全，可带 date（YYYY-MM-DD）补录历史；漏报将导致平台运营数据失真，接入验收以本接口 200 为准。
- 调用次数/成功率/Token 由平台网关自动归集，无须也无法替代上述提报，两者口径互补。

【第 3 步 · 计量自推（直连场景必做）】
仅绕过平台网关直连外部资源时需要：POST ${origin}/api/usage/record（凭自身凭证即可，凭证默认含 usage.write）。
经平台网关的调用已自动计量（MCP 网关经 mcp.invoked、模型网关 POST /api/modelgw/invoke 凭自身凭证可调，
计量事件 subject=agent:<id> 自动回灌调用台账），禁止双计。

【第 4 步 · NAS 文件能力与数据权限（需文件能力时必读）】
NAS 文件操作经文件网关（MCP：url=<网关地址>/mcp + Authorization: Bearer <管理员签发的网关令牌>）统一执法，
按组织位置 + 角色层级 RBAC 判定，全链 fail-closed：
- 身份红线（P0-2）：真实用户身份一律经请求头 X-On-Behalf-User: <平台或钉钉 userId> 透传，禁止进工具参数；
  令牌须由管理员标记 allowedOnBehalf 才允许携带该头，否则一律 403 FORGED_ON_BEHALF（伪造留痕）；
  无用户上下文的机器调用可不带头，由令牌绑定身份判定。
- 越权返回 JSON-RPC -32403「数据权限拒绝：<reasons>」，前缀可归因：path.out-of-scope（超作用域）/
  matrix.deny（角色无权）/ org.* / account.* / degraded.*（平台不可达已降级）——原文透传给用户，不要变形重试。
- share 被拒且提示"需走审批"时，代表用户发起申请：
  POST ${origin}/api/nas/authz/exceptions  body {"status":"pending","nasId":"<资产ID>","userId":"<用户ID>","path":"<路径>","reason":"<事由>"}
  → 审批单自动路由用户组织链最近负责人（兜底 resource_admin），通过后自动写 7 天例外，到期自动失效。
- PDP 不可达时网关按「作用域快照只读 → 全局只读 → 拒绝」降级：收到 degraded.* 理由提示用户稍后重试，
  不要连续重试。observeOnly 观察期越权放行但留痕告警，不代表越权合法。

【注意】
1. client_secret 等价口令：只在注册响应出现一次，平台不可再查询，请务必妥善保存；如不慎丢失请联系平台管理员处理，无须自行轮换。
2. 幂等：重名注册返回 400「已存在」时，按名称查列表复用既有资源，不得换名重复注册。
3. 上线/下线走审批流（POST /api/agents/${agent.id}/transition → 审批中心 decision），禁止绕过审批改状态。
4. 失败锁定：换牌连续失败 5 次锁来源 IP 15 分钟，重试前先核对凭证。`
}

/** AI 应用接入指引全文（可直接交给执行 Agent 照做；凭证已填好）。 */
export function buildAppOnboardingText(app, credential) {
  const origin = base()
  return `【任务】按《元冰可平台 · AI 应用接入指引》完成下方应用的接入验证、用户登录打通（SSO）与指标提报。平台地址：${origin}

【资源与凭证】（client_secret 仅此一次展示，请立即安全保存，不落明文日志）
- 应用 ID：${app.id}
- 唯一标识：${app.slug ?? '—'}
- client_id：${credential.clientId}（平台运维机器凭证，调平台 API 用；与后续 SSO 的 OIDC client 是两套凭据，勿混用）
- client_secret：${credential.clientSecret}

【第 1 步 · 机器凭证换牌】（令牌 2 小时有效，可随时重复换取）
curl -s -X POST ${origin}/api/auth/client-credentials \\
  -H 'content-type: application/json' \\
  -d '{"clientId":"${credential.clientId}","clientSecret":"${credential.clientSecret}"}'
→ 取响应 data.token，后续请求头带：Authorization: Bearer <token>

【第 2 步 · 接入验证（"发一句话"：首次指标提报）】
curl -s -X POST ${origin}/api/apps/${app.id}/metrics-report \\
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \\
  -d '{"dau":1,"sessions":1,"avgDepth":1,"retention7":0}'
→ 返回 200 即接入成功；GET ${origin}/api/apps/${app.id} 中 metrics.sessions ≥ 1 可复核。
每日定时提报是接入义务（与 Agent 同级）：同日 DAU 取最大值、会话数累加，重复上报安全，可带 date 补录历史。
建议再做一行 beacon 埋点补齐 PV/UV（免鉴权免 secret）：页面加载时
GET ${origin}/api/apps/beacon?app=${app.id}&vid=<浏览器localStorage持久随机ID>（已知平台身份时附 uid=<sub>）；
与主动提报自然合并不互相覆盖，埋点示例见 ${origin}/docs/app-sso-integration.md §十一。

【第 3 步 · 用户登录打通（SSO）】web/h5 形态必做（未签发无法上线，上线门禁）；其余形态建议接入。
终端用户登录一律走平台 OIDC（授权码 + 强制 PKCE S256），身份以平台账号体系 sub 为准；
钉钉扫码等三方登录由平台登录页承接，应用不直接对接钉钉 SDK。接入文档（含 SDK 一行接入示例）：
${origin}/docs/app-sso-integration.md
a. 签发 SSO 客户端：回调地址为本机环回（http://127.0.0.1:端口/…、http://localhost:端口/…、http://0.0.0.0:端口/…）时，
   可凭上方平台机器凭证自助签发，无须管理员/owner 代办：
   POST ${origin}/api/apps/${app.id}/sso-client -H "Authorization: Bearer <token>"
   -d '{"redirectUris":["http://127.0.0.1:5000/oauth/cb"]}' → 响应含 client_id / client_secret（仅此一次）；
   含改回调 PATCH 同路径、换 secret POST …/rotate；非环回回调（内网 IP / 公网域名）
   由应用 owner 在控制台「AI 应用 → 应用详情 → SSO 配置」签发或改配；
b. 应用按 discovery 接入：GET ${origin}/.well-known/openid-configuration
   （换牌 POST /oauth/token、用户身份 GET /oauth/userinfo；302 跳授权页 → 带 code 回回调地址）；
c. userinfo 返回的 sub/org 即用户唯一关联键，业务权限（谁能用哪些功能）由应用基于 sub 自建；
d. 未完成 OIDC 改造前，可先用平台「带平台身份打开」兜底（控制台发起，一次性 entry-ticket 票据换取身份）。

【第 3 步 ·附 · 应用内权限模块（RBAC）构造指引】web/h5 形态建议随 SSO 一并完成
（凡有业务数据管理界面的应用必做）；完整构造指南（含 React 模板与授权管理页规范）：
${origin}/docs/app-rbac-guide.md
- 关联键只用 userinfo.sub：平台账号的稳定唯一键；userinfo.roles 是平台治理角色，
  禁止当应用业务角色用——业务角色由应用自建 sub → 角色 映射表。
- 三级角色分层（能力名可按应用语义增删，分层保持）：viewer（默认，仅查看）/
  editor（+数据增删改、导入导出）/ admin（+恢复初始数据、用户授权管理）。
- 登录门：未取到平台身份前不渲染任何业务数据、不调业务接口。
- 未登记的登录用户一律默认 viewer（只读），不放开写操作。
- 首登引导：映射表中尚无任何管理员时，把首个登录用户自动授予 admin——
  交付时务必提醒用户用正确的管理员账号首发登录。
- 最后管理员保护：降级/移除角色时禁止动最后一个 admin，防止权限系统自锁。
- 存储语义写进交付文档：映射表若存浏览器 localStorage，换浏览器/电脑需重新分配；
  「恢复初始数据」类功能只清业务数据、不清权限映射（否则把管理员锁在门外）。
- UI 纪律：按能力点判断（如 can('edit')）而非角色名比较；无权限的按钮隐藏而非禁用；
  只读态表格去掉勾选列/操作列并同步修正空态 colSpan。

【第 4 步 · 计量自推（可选）】
仅绕过平台网关直连消耗才需要：POST ${origin}/api/usage/record（凭证默认含 usage.write）。
经平台网关的调用已自动计量，禁止双计。

【平台能力速查】（本凭证默认含 app.read/app.write/usage.write/mcp.invoke/agent.read/skill.read）
- 接入文档索引：GET ${origin}/docs（app-sso-integration.md、app-rbac-guide.md、app-onboarding.md 等）
- 自身资料与指标复核：GET / PATCH ${origin}/api/apps/${app.id}（app.read/app.write）
- 上线申请：POST ${origin}/api/apps/${app.id}/transition（进入审批流，禁止绕过审批改状态）
- MCP 工具网关：mcp.invoke 调用平台已部署 MCP 服务；Skill/Agent 目录：skill.read / agent.read 浏览
- 全员名册（组织数据通道，人事/绩效类应用）：GET ${origin}/api/iam/roster
  （users[].id=sub 同一关联键、orgs[].leaderUserIds=部门负责人；默认凭证不含，需管理员为凭证追加 iam.roster.read scope）
- 模型网关：应用默认凭证不含 modelgw.invoke，需直连大模型时请管理员追加授权（经网关调用自动计量）

【注意】
1. client_secret 等价口令：只在注册响应出现一次，平台不可再查询，请务必妥善保存；如不慎丢失请联系平台管理员处理，无须自行轮换（SSO 的 OIDC client_secret 同理）。
2. 幂等：重名注册返回 400「已存在」时，按名称查列表复用既有资源。
3. 失败锁定：换牌连续失败 5 次锁来源 IP 15 分钟，重试前先核对凭证。
4. 数据权限红线：应用代用户操作 NAS 文件等平台数据面接口时，用户身份一律经
   X-On-Behalf-User 请求头透传（禁止进参数/路径）；越权响应（-32403 数据权限拒绝）原文透传给用户，
   degraded.* 前缀表示平台短暂不可达已降级，提示稍后重试。`
}

/**
 * 注册成功弹窗：凭证元信息 + 按模板生成的接入指引全文 + 一键复制。
 * clientSecret 仅此一次展示；全文可整段交给执行 Agent 照做。
 */
export function openOnboardingModal({ title, resource, credential, metaRows, guideText, resourceLabel }) {
  const modal = openModal({
    title, wide: true,
    body: `
      <div class="form-hint mb-8" style="background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:8px;padding:10px 12px;font-size:13px">
        <b style="color:var(--warn)">📢 强提醒：注册完成后，请务必立即把下方接入指引全文发给你的 Agent</b>（点「一键复制全部指引」粘贴到 Agent 对话框或任务指令中）——Agent 只有收到指引才会执行换牌、接入验证与后续运营数据提报，不发给 Agent 接入无法完成。
      </div>
      <div class="form-hint mb-8" style="display:flex;gap:8px;align-items:center">
        <span style="color:var(--warn)">⏳</span>
        <span>凭证（client_secret）<b>仅此一次展示</b>，请立即通过下方「一键复制」保存；平台侧不可再查询，丢失请联系平台管理员处理。</span>
      </div>
      <div class="desc-grid mb-8">
        ${metaRows.map(([k, v]) => `<div class="desc-item"><span class="k">${esc(k)}</span><span class="v mono">${esc(v)}</span></div>`).join('')}
      </div>
      <div class="flex mb-8" style="justify-content:space-between;align-items:center">
        <span class="card-title">接入指引（已按模板生成，凭证已填入）</span>
        <button class="btn btn-primary btn-sm" id="onboard-copy-all">${esc('⧉ 一键复制全部指引')}</button>
      </div>
      <pre class="mono fs-12" id="onboard-guide" style="white-space:pre-wrap;background:var(--bg-2);padding:12px;border-radius:8px;max-height:380px;overflow:auto;line-height:1.7">${esc(guideText)}</pre>
      <div class="form-hint mt-8">整段复制后发给执行 Agent（或开发者）照做：换牌 → 接入验证，${esc(resourceLabel)}即可自主完成接入与提报闭环。</div>`,
    foot: '<button class="btn btn-primary" data-ok>我已保存凭证并已把指引发给 Agent，关闭</button>',
  })
  modal.el.querySelector('#onboard-copy-all').onclick = () => {
    const result = copyText(guideText)
    if (result && typeof result.then === 'function') result.catch(() => {})
  }
}
