/**
 * 我的接入（员工自助，2026-11-02）：个人接入令牌 + MCP 调用配置一键生成。
 * 权限对齐是构造性的：令牌鉴权时按当前角色实时解析（角色变更即时生效，吊销立即失效），
 * 本页不授予任何额外权限——配置能做什么完全由「我」的角色决定。
 * 明文只展示一次（对齐接入码先例）；列表恒掩码。
 */
import { api, session } from '../api.js'
import rqI18n from '../i18n.js'
import { icon } from '../icons.js'
import {
  $, esc, toast, openModal, confirmDialog, copyText, fmtTime, timeAgo,
} from '../ui.js'

const TTL_OPTIONS = [
  { hours: 168, label: '7 天' },
  { hours: 720, label: '30 天（默认）' },
  { hours: 2160, label: '90 天' },
]

export async function renderMe(content) {
  const me = await api.get('/api/auth/me').catch(() => null)
  const permCount = Array.isArray(me?.permissions)
    ? (me.permissions.includes('*') ? rqI18n.t('全部（管理员）') : String(me.permissions.length))
    : '—'

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">PERSONAL / ACCESS</div>
        <div class="page-title">${esc(rqI18n.t('我的接入'))}</div>
        <div class="page-sub">${esc(rqI18n.t('生成属于你的 MCP 调用配置：粘贴到支持 MCP 的客户端（如 AI IDE / Agent 运行时），以你的身份使用平台工具面。'))}</div>
      </div>
    </div>

    <div class="card card-pad mb-20" id="me-identity">
      <div class="flex" style="gap:14px;align-items:center;flex-wrap:wrap">
        <div style="font-size:26px">${esc(session.user?.avatar ?? '👤')}</div>
        <div style="min-width:0">
          <div class="fs-14" style="font-weight:600">${esc(session.user?.displayName ?? me?.name ?? '')}</div>
          <div class="fs-12 text-3">${esc(rqI18n.t('生效权限点：{n}', { n: permCount }))} · ${esc(rqI18n.t('权限随角色实时对齐：角色变更即时生效，令牌吊销立即失效'))}</div>
        </div>
      </div>
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.1fr 1fr;align-items:start">
      <div class="card card-pad">
        <div class="fs-13" style="font-weight:600;margin-bottom:6px">${esc(rqI18n.t('生成 MCP 调用配置'))}</div>
        <div class="fs-12 text-3 mb-12" style="line-height:1.8">${esc(rqI18n.t('为本次用途填写备注（会显示在下方的令牌列表中，便于后续识别与吊销），选择有效期后生成。配置明文只展示一次。'))}</div>
        <div id="me-create-form"></div>
      </div>
      <div class="card card-pad">
        <div class="fs-13" style="font-weight:600;margin-bottom:6px">${esc(rqI18n.t('使用说明'))}</div>
        <div class="fs-12 text-3" style="line-height:1.9">
          1. ${esc(rqI18n.t('点击「生成配置」，一键复制 JSON；'))}<br>
          2. ${esc(rqI18n.t('粘贴到 MCP 客户端的 mcpServers 配置（Streamable HTTP 形态）；'))}<br>
          3. ${esc(rqI18n.t('客户端工具列表 = 你的角色 × 工具权限点过滤，与控制台身份一致；'))}<br>
          4. ${esc(rqI18n.t('不再使用时回到本页吊销；换工作交接前请先吊销全部令牌。'))}
        </div>
      </div>
    </div>

    <div class="card">
      <div style="padding:14px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px">
        <div class="fs-13" style="font-weight:600">${esc(rqI18n.t('我的令牌'))}</div>
        <span class="fs-11 text-4">${esc(rqI18n.t('按签发时间倒序 · 完整令牌值不在此展示'))}</span>
      </div>
      <div style="overflow:auto"><table class="tbl">
        <thead><tr>
          <th>${esc(rqI18n.t('备注'))}</th><th>${esc(rqI18n.t('令牌'))}</th><th>${esc(rqI18n.t('状态'))}</th>
          <th>${esc(rqI18n.t('签发'))}</th><th>${esc(rqI18n.t('过期'))}</th><th>${esc(rqI18n.t('最近使用'))}</th><th></th>
        </tr></thead>
        <tbody id="me-token-body"><tr><td colspan="7" class="text-4 fs-12" style="padding:24px;text-align:center">${esc(rqI18n.t('加载中…'))}</td></tr></tbody>
      </table></div>
    </div>`

  // -- 生成表单（演示态隐藏写入口：写操作 405，与接入页一键巡检同口径） ----------------
  const form = $('#me-create-form')
  if (session.isDemo) {
    form.innerHTML = `<div class="fs-12 text-4">${esc(rqI18n.t('演示态为只读，不能签发个人接入令牌。'))}</div>`
  } else {
    form.innerHTML = `
      <label class="fs-12 text-3">${esc(rqI18n.t('备注（必填，≤100 字）'))}</label>
      <input class="input" id="me-label" maxlength="100" placeholder="${esc(rqI18n.t('例如：我的 IDE MCP 接入'))}" style="margin:4px 0 12px">
      <label class="fs-12 text-3">${esc(rqI18n.t('有效期'))}</label>
      <select class="input" id="me-ttl" style="margin:4px 0 14px">
        ${TTL_OPTIONS.map((option) => `<option value="${option.hours}">${esc(option.label)}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="me-generate">${icon('sparkles', 14)} ${esc(rqI18n.t('生成配置（一键复制）'))}</button>`

    $('#me-generate').onclick = async () => {
      const label = $('#me-label').value.trim()
      if (!label) { toast(rqI18n.t('请先填写备注'), 'error'); return }
      const ttlHours = Number($('#me-ttl').value)
      try {
        const created = await api.post('/api/authn/mcp-tokens', { label, ttlHours })
        showOneTimeConfig(created)
        await refreshTokens()
      } catch (error) { toast(error.message, 'error') }
    }
  }

  // -- 一次性配置弹窗（明文只此一次） ------------------------------------------------
  function showOneTimeConfig(created) {
    const json = JSON.stringify(created.config, null, 2)
    const modal = openModal({
      title: rqI18n.t('配置已生成（明文仅展示这一次）'),
      body: `
        <div class="fs-12 mb-8" style="color:var(--danger, #c0392b);line-height:1.7">${esc(rqI18n.t('令牌与你的角色权限实时对齐；请立即复制并粘贴到 MCP 客户端配置——关闭本弹窗后无法再次查看明文，只能吊销重建。'))}</div>
        <div class="flex" style="gap:8px;align-items:flex-start">
          <pre class="code-block" id="me-config-json" style="flex:1;margin:0;padding:12px;border-radius:8px;background:var(--bg-2);font-size:12px;overflow:auto;max-height:300px;user-select:all">${esc(json)}</pre>
          <button class="btn btn-default" id="me-copy-config" style="white-space:nowrap">${icon('check', 12)} ${esc(rqI18n.t('一键复制'))}</button>
        </div>
        <div class="fs-12 text-3 mt-12" style="line-height:1.8">
          ${esc(rqI18n.t('备注：{label} · 有效至 {time}', { label: created.label, time: fmtTime(created.expiresAt) }))}<br>
          ${esc(rqI18n.t('dsh 挂载形态下地址需带上挂载前缀（如 /rq/mcp）。'))}
        </div>`,
      foot: `<button class="btn btn-primary" data-cancel>${esc(rqI18n.t('我已保存'))}</button>`,
    })
    modal.el.querySelector('#me-copy-config').onclick = () => copyText(json)
  }

  // -- 令牌列表 ----------------------------------------------------------------------
  async function refreshTokens() {
    const holder = $('#me-token-body')
    if (!holder) return
    try {
      const data = await api.get('/api/authn/mcp-tokens')
      if (!data.tokens.length) {
        holder.innerHTML = `<tr><td colspan="7" class="text-4 fs-12" style="padding:24px;text-align:center">${esc(rqI18n.t('还没有个人接入令牌——用上方表单生成第一条配置。'))}</td></tr>`
        return
      }
      holder.innerHTML = data.tokens.map((token) => `
        <tr>
          <td class="fs-13">${esc(token.label || '—')}</td>
          <td class="mono fs-12 text-3">${esc(token.jtiMasked)}</td>
          <td>${token.revokedAt
            ? `<span class="fs-12 text-4">${esc(rqI18n.t('已吊销'))}</span>`
            : `<span class="badge badge-ok no-dot">${esc(rqI18n.t('活跃'))}</span>`}</td>
          <td class="fs-12 text-3" title="${esc(token.issuedAt)}">${esc(timeAgo(token.issuedAt))}</td>
          <td class="fs-12 text-3">${esc(fmtTime(token.expiresAt))}</td>
          <td class="fs-12 text-3">${token.lastUsedAt ? esc(timeAgo(token.lastUsedAt)) : '—'}</td>
          <td style="text-align:right">${token.revokedAt ? '' : `<button class="btn btn-default btn-sm" data-jti="${esc(token.jti)}" data-label="${esc(token.label ?? '')}">${esc(rqI18n.t('吊销'))}</button>`}</td>
        </tr>`).join('')
    } catch (error) {
      holder.innerHTML = `<tr><td colspan="7" class="text-4 fs-12" style="padding:24px;text-align:center">${esc(error.message)}</td></tr>`
    }
  }

  $('#me-token-body').onclick = async (event) => {
    const button = event.target.closest('button[data-jti]')
    if (!button) return
    const confirmed = await confirmDialog({
      title: rqI18n.t('吊销个人接入令牌'),
      message: rqI18n.t('「{label}」将被立即吊销，使用该配置的客户端即刻失效（需重新生成）。', { label: button.dataset.label || button.dataset.jti }),
      danger: true,
      confirmText: rqI18n.t('吊销'),
    })
    if (!confirmed) return
    try {
      await api.delete(`/api/authn/mcp-tokens/${encodeURIComponent(button.dataset.jti)}`)
      toast(rqI18n.t('已吊销'), 'ok')
      await refreshTokens()
    } catch (error) { toast(error.message, 'error') }
  }

  await refreshTokens()
}
