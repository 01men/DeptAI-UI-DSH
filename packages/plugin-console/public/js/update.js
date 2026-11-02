/** 平台更新：顶栏更新徽标 + 更新抽屉（检查 / 偏好设置 / 一键升级）。 */
import { api, session } from './api.js'
import { h, esc, toast, openDrawer, confirmDialog } from './ui.js'
import { icon } from './icons.js'
import rqI18n from './i18n.js'

const canCheck = () => session.can('platform.update.read')
const canManage = () => session.can('platform.update.apply')

const fmtTime = (iso) => {
  if (!iso) return '从未检查'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

/** 顶栏徽标：登录后调用；有未忽略的新版本时显示「可更新」胶囊。 */
export async function mountUpdateBadge() {
  const host = document.getElementById('update-host')
  if (!host || !session.token) return
  try {
    const status = await api.get('/api/update/status')
    host.innerHTML = ''
    if (!status.hasUpdate || status.dismissed) return
    const label = status.updateKind === 'version'
      ? rqI18n.t('v{v} 可更新', { v: status.latest?.version ?? '?' })
      : rqI18n.t('上游领先 {n} 提交', { n: status.behindBy })
    const pill = h(`<button title="平台有可用更新，点击查看详情" style="display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:999px;border:1px solid #fcd34d;background:#fffbeb;color:#b45309;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">${icon('refresh', 13)}<span>${esc(label)}</span></button>`)
    pill.onclick = () => void openUpdateDrawer()
    host.appendChild(pill)
  } catch { /* 静默：更新徽标失败不影响主界面 */ }
}

const modeBadge = (mode) => mode === 'source'
  ? '<span style="display:inline-block;padding:1px 8px;border-radius:999px;background:#eff6ff;color:#1d4ed8;font-size:12px">源码检出（git）</span>'
  : '<span style="display:inline-block;padding:1px 8px;border-radius:999px;background:#f5f3ff;color:#6d28d9;font-size:12px">插件市场安装（bundle）</span>'

function renderStatusHtml(status) {
  const commits = (status.recentCommits ?? []).slice(0, 10).map((item) => `
    <div style="display:flex;gap:8px;padding:7px 0;border-bottom:1px dashed var(--line, #eceef2);font-size:13px">
      <code style="color:#6b7280;flex-shrink:0">${esc(item.sha)}</code>
      <span class="ellipsis" style="flex:1">${esc(item.message)}</span>
    </div>`).join('')
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px">
      <div style="padding:10px 12px;border:1px solid var(--line, #eceef2);border-radius:10px">
        <div style="font-size:12px;color:#8a8f99;margin-bottom:4px">当前版本</div>
        <div style="font-size:16px;font-weight:700">v${esc(status.currentVersion)}</div>
        <div style="margin-top:6px">${modeBadge(status.installMode)}</div>
      </div>
      <div style="padding:10px 12px;border:1px solid var(--line, #eceef2);border-radius:10px">
        <div style="font-size:12px;color:#8a8f99;margin-bottom:4px">上游最新</div>
        <div style="font-size:16px;font-weight:700;${status.hasUpdate ? 'color:#b45309' : ''}">${status.latest ? `v${esc(status.latest.version)}` : '未检查'}</div>
        <div style="margin-top:6px;font-size:12px;color:#8a8f99">${esc(rqI18n.t('仓库 {repo}@{branch}', { repo: status.repo, branch: status.branch }))}</div>
      </div>
      <div style="padding:10px 12px;border:1px solid var(--line, #eceef2);border-radius:10px">
        <div style="font-size:12px;color:#8a8f99;margin-bottom:4px">最近检查</div>
        <div style="font-size:13px;font-weight:600">${esc(fmtTime(status.lastCheckedAt))}</div>
        <div style="margin-top:6px;font-size:12px;color:#8a8f99">${esc(status.nextCheckHint)}</div>
      </div>
    </div>
    ${status.lastError ? `<div style="padding:8px 12px;border-radius:8px;background:#fef2f2;color:#b91c1c;font-size:12px;margin-bottom:12px">${esc(rqI18n.t('上次检查部分失败：{msg}', { msg: status.lastError }))}</div>` : ''}
    ${status.behindBy > 0 ? `
      <div style="font-size:13px;font-weight:600;margin:4px 0 2px">${esc(rqI18n.t('上游新增提交（{n}）', { n: status.behindBy }))}</div>
      <div style="max-height:200px;overflow:auto">${commits || '<div class="muted" style="padding:6px 0">（提交明细需源码检出形态）</div>'}</div>` : ''}
    ${status.installMode !== 'source' ? `
      <div style="margin-top:12px;padding:10px 12px;border-radius:10px;background:#f8fafc;border:1px solid var(--line, #eceef2);font-size:13px;line-height:1.9">
        <b>升级方式（插件市场安装形态）</b><br>
        在宿主 dsh 侧执行：<code style="background:#eef2ff;padding:1px 6px;border-radius:6px">dsh plugin update github:${esc(status.repo)}</code><br>
        完成后重启 dsh 宿主进程生效。
      </div>` : ''}`
}

/** 更新抽屉（徽标与「插件与工具」页均可打开）。 */
export async function openUpdateDrawer() {
  let status
  try {
    status = await api.get('/api/update/status')
  } catch (e) {
    toast(e.message, 'error')
    return
  }
  const drawer = openDrawer({
    title: '平台更新',
    sub: rqI18n.t('当前 v{v} · {mode} · 上游 {repo}', {
      v: status.currentVersion,
      mode: status.installMode === 'source' ? rqI18n.t('源码检出') : rqI18n.t('插件市场安装'),
      repo: status.repo,
    }),
    body: renderStatusHtml(status),
    foot: 'loading',
  })
  const foot = drawer.el.querySelector('.drawer-foot')
  if (!foot) return

  const renderFoot = () => {
    foot.innerHTML = ''
    const actions = h('<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"></div>')
    if (canCheck()) {
      const checkBtn = h(`<button class="btn btn-ghost" id="upd-check">立即检查</button>`)
      checkBtn.onclick = async () => {
        checkBtn.disabled = true
        checkBtn.textContent = '检查中…'
        try {
          const fresh = await api.post('/api/update/check')
          toast(fresh.hasUpdate ? rqI18n.t('发现新版本 v{v}', { v: fresh.latest?.version ?? '' }) : rqI18n.t('已是最新版本'))
          drawer.el.querySelector('.drawer-body').innerHTML = renderStatusHtml(fresh)
          status = fresh
          renderFoot()
        } catch (e) {
          toast(e.message, 'error')
          checkBtn.disabled = false
          checkBtn.textContent = '立即检查'
        }
      }
      actions.appendChild(checkBtn)
    }
    if (canManage()) {
      if (status.hasUpdate && status.latest?.version) {
        const dismissLabel = status.dismissed ? '恢复更新提醒' : '忽略此版本'
        const dismissBtn = h(`<button class="btn btn-ghost" id="upd-dismiss">${dismissLabel}</button>`)
        dismissBtn.onclick = async () => {
          try {
            const fresh = await api.post('/api/update/settings', { dismissedVersion: status.dismissed ? null : status.latest.version })
            status = fresh
            drawer.el.querySelector('.drawer-body').innerHTML = renderStatusHtml(fresh)
            renderFoot()
            toast(rqI18n.t('已更新提醒偏好'))
            void mountUpdateBadge()
          } catch (e) { toast(e.message, 'error') }
        }
        actions.appendChild(dismissBtn)
      }
      if (status.installMode === 'source') {
        const dryBtn = h('<button class="btn btn-ghost" id="upd-dryrun">预演升级</button>')
        dryBtn.onclick = async () => {
          try {
            const plan = await api.post('/api/update/apply', { dryRun: true })
            const steps = (plan.steps ?? []).map((s) => `· ${s}`).join('<br>')
            const incoming = (plan.incomingCommits ?? []).length ? `<br><br>待拉取提交：<br>${plan.incomingCommits.map((s) => `· ${esc(s)}`).join('<br>')}` : ''
            await confirmDialog({ title: rqI18n.t('升级预演（dry-run）'), message: `${rqI18n.t('将依次执行：')}<br>${steps}${incoming}`, confirmText: rqI18n.t('知道了') })
          } catch (e) { toast(e.message, 'error') }
        }
        actions.appendChild(dryBtn)
        const applyBtn = h('<button class="btn btn-primary" id="upd-apply">一键升级</button>')
        applyBtn.onclick = async () => {
          const result = await confirmDialog({
            title: rqI18n.t('一键升级平台'),
            danger: true,
            requireReason: true,
            confirmText: rqI18n.t('执行升级'),
            message: `${rqI18n.t('将执行')} <b>git pull --ff-only + npm install</b>${rqI18n.t('（v{from} → v{to}），完成后需', { from: esc(status.currentVersion), to: esc(status.latest?.version ?? '?') })}<b>${rqI18n.t('重启平台进程')}</b>${rqI18n.t('生效。')}<br>${rqI18n.t('本地未提交的修改会使升级安全失败，不会强改。')}`,
          })
          if (!result) return
          applyBtn.disabled = true
          applyBtn.textContent = '升级执行中…（可能需要几分钟）'
          try {
            const data = await api.post('/api/update/apply', { reason: result.reason })
            toast(data.notice ?? rqI18n.t('升级完成，请重启进程'))
            const fresh = await api.get('/api/update/status')
            status = fresh
            drawer.el.querySelector('.drawer-body').innerHTML = renderStatusHtml(fresh)
            renderFoot()
          } catch (e) {
            toast(e.message, 'error')
            applyBtn.disabled = false
            applyBtn.textContent = '一键升级'
          }
        }
        actions.appendChild(applyBtn)
      }
      // 偏好设置行
      const pref = h(`<div style="display:flex;gap:10px;align-items:center;font-size:13px;color:#4b5563;margin-left:auto">
        <label style="display:flex;gap:5px;align-items:center;cursor:pointer"><input type="checkbox" id="upd-auto" ${status.autoCheck ? 'checked' : ''}>自动检查</label>
        <span>每 <input type="number" id="upd-hours" min="1" max="720" value="${status.intervalHours}" style="width:56px;padding:2px 6px;border:1px solid var(--line,#e5e7eb);border-radius:6px"> 小时</span>
      </div>`)
      pref.querySelector('#upd-auto').onchange = async (e) => {
        try {
          status = await api.post('/api/update/settings', { autoCheck: e.target.checked })
          toast(status.autoCheck ? rqI18n.t('已开启自动检查') : rqI18n.t('已关闭自动检查'))
        } catch (err) { toast(err.message, 'error') }
      }
      pref.querySelector('#upd-hours').onchange = async (e) => {
        try {
          status = await api.post('/api/update/settings', { intervalHours: Number(e.target.value) || 24 })
          toast(rqI18n.t('自动检查间隔已设为 {n} 小时', { n: status.intervalHours }))
        } catch (err) { toast(err.message, 'error') }
      }
      actions.appendChild(pref)
    } else {
      actions.appendChild(h('<span style="font-size:12px;color:#8a8f99;margin-left:auto">升级与设置需 platform.update.apply 权限</span>'))
    }
    foot.appendChild(actions)
  }
  renderFoot()
}
