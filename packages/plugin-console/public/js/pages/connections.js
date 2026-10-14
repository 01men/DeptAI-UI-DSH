/**
 * 宿主服务连接（docs/frontend-host-switching.md）：连接清单 + 测活 + 一键切换。
 *
 * 切换语义：写活动连接偏好 → location.reload() 整页刷新 → api.js 按新连接重定 BASE
 * （BASE 模块级定刻，刷新是应用新连接的唯一途径，即「切换后自动页面服务刷新」）。
 * 无会话也可用：登录前就要能换目标宿主（app.js 对 #/connections 做会话前置分支，
 * standalone 形态渲染极简卡片）；有会话时在控制台外壳内渲染（ builders 常规页）。
 */
import { IS_LOCAL_HOST, probeHostBase } from '../api.js'
import { icon } from '../icons.js'
import { $, esc, toast } from '../ui.js'
import {
  loadConnections, upsertConnection, removeConnection, activeConnection, setActiveId, LOCAL_ID,
} from '../connections.js'

/** 本机连接的展示地址（页面源 + 部署前缀）。 */
const PAGE_BASE = location.origin + new URL('.', document.baseURI).pathname.replace(/\/$/, '')

export function renderConnections(content, params, { standalone = false } = {}) {
  const mount = () => loadConnections(localStorage)
  const active = () => activeConnection(localStorage, new URL('.', document.baseURI).pathname.replace(/\/$/, ''))

  const switchTo = (id) => {
    setActiveId(localStorage, id)
    // 自动页面服务刷新：新 BASE 在刷新后的模块加载时刻生效
    location.reload()
  }

  const render = () => {
    const connections = mount()
    const current = active()
    const rows = [
      rowHtml({ id: LOCAL_ID, name: '本机宿主服务', base: PAGE_BASE }, current, true),
      ...connections.map((item) => rowHtml(item, current, false)),
    ].join('')

    content.innerHTML = `
      ${standalone ? `
        <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f3f5f9;padding:24px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
            <img src="ybk-mark.png" alt="元冰可" style="width:40px;height:40px;border-radius:10px">
            <div style="font-size:17px;font-weight:600">宿主服务连接</div>
          </div>
          <div class="card" style="width:100%;max-width:720px" id="conn-card">` : `
        <div class="page-head">
          <div>
            <div class="page-title">宿主服务连接</div>
            <div class="page-desc">控制台默认连接本机宿主服务；可手动配置其他宿主（如 http://192.168.0.7:7300），配置过即可一键切换，切换后页面自动刷新生效。</div>
          </div>
        </div>
        <div class="card mb-20" id="conn-card">`}
        <div class="card-head"><span class="card-title">${icon('server', 15)} 连接清单</span><span class="card-sub">当前：${esc(current.name)}${IS_LOCAL_HOST ? '' : '（远程）'}</span></div>
        <div class="card-body" style="padding-top:8px">
          <div id="conn-rows">${rows}</div>
          <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
            <div class="fs-13" style="font-weight:600;margin-bottom:8px">${icon('plus', 14)} 新增连接</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
              <div style="flex:1;min-width:160px">
                <label class="form-label">名称（留空取地址主机名）</label>
                <input class="input" id="conn-new-name" placeholder="如：参考机 0.7">
              </div>
              <div style="flex:2;min-width:260px">
                <label class="form-label">宿主服务地址</label>
                <input class="input" id="conn-new-base" placeholder="http://192.168.0.7:7300（挂载形态含前缀，如 http://host:8801/rq）">
              </div>
              <button class="btn btn-primary" id="conn-new-save">保存</button>
            </div>
            <div class="form-hint" style="margin-top:8px">目标宿主需与本控台同代版本（数据面默认放行跨域）；登录账号、组织与权限均为目标宿主侧数据，切换后需按目标宿主重新登录。</div>
          </div>
        </div>
      </div>
      ${standalone ? '<div style="margin-top:16px"><a class="fs-13" style="color:var(--brand-500);cursor:pointer" id="conn-back">← 返回登录</a></div></div>' : ''}
    `

    $('#conn-back')?.addEventListener('click', () => { location.hash = '#/login' })
    $('#conn-new-save').addEventListener('click', () => {
      const name = $('#conn-new-name').value.trim()
      const base = $('#conn-new-base').value
      const result = upsertConnection(localStorage, { name, base })
      if (!result.ok) return toast(result.error, 'error')
      toast(`已保存连接「${result.connection.name}」，点击其「切换」启用`)
      render()
    })

    wireRows(render)
  }

  const rowHtml = (item, current, isLocal) => `
    <div class="conn-row" data-id="${esc(item.id)}" style="display:flex;gap:12px;align-items:center;padding:10px 4px;border-bottom:1px solid var(--border);flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <div class="fs-13" style="font-weight:600;display:flex;gap:8px;align-items:center">
          ${esc(item.name)}
          ${current.id === item.id ? '<span class="badge badge-ok no-dot">当前</span>' : ''}
          ${isLocal ? '<span class="badge badge-muted no-dot">内置</span>' : ''}
        </div>
        <div class="fs-12" style="color:var(--text-3);font-family:ui-monospace,Consolas,monospace;word-break:break-all">${esc(item.base)}</div>
        <div class="fs-12 conn-probe" style="color:var(--text-3)"></div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" data-act="probe">${icon('activity', 13)} 测活</button>
        ${current.id === item.id
          ? (isLocal ? '' : `<button class="btn btn-ghost btn-sm" data-act="switch" title="连接已变更时重新应用">${icon('refresh', 13)} 重新应用</button>`)
          : `<button class="btn btn-primary btn-sm" data-act="switch">${icon('check', 13)} 切换</button>`}
        ${isLocal ? '' : `
          <button class="btn btn-ghost btn-sm" data-act="edit">${icon('edit', 13)}</button>
          <button class="btn btn-ghost btn-sm" data-act="remove" title="删除">${icon('trash', 13)}</button>`}
      </div>
    </div>`

  const wireRows = (render) => {
    content.querySelectorAll('.conn-row').forEach((row) => {
      const id = row.dataset.id
      const isLocal = id === LOCAL_ID
      const item = isLocal
        ? { id: LOCAL_ID, name: '本机宿主服务', base: PAGE_BASE }
        : mount().find((entry) => entry.id === id)
      if (!item) return
      row.querySelector('[data-act="probe"]')?.addEventListener('click', async (event) => {
        event.currentTarget.disabled = true
        const cell = row.querySelector('.conn-probe')
        cell.textContent = '测活中…'
        const result = await probeHostBase(item.base)
        cell.innerHTML = `${result.ok ? '<span style="color:#067647">● 可达 ' : '<span style="color:#b42318">● 不可达：'}${esc(result.message)}</span>`
        event.currentTarget.disabled = false
      })
      row.querySelector('[data-act="switch"]')?.addEventListener('click', () => {
        if (id === active().id) return
        switchTo(id)
      })
      row.querySelector('[data-act="edit"]')?.addEventListener('click', () => renderEdit(row, item, render))
      let armed = false
      row.querySelector('[data-act="remove"]')?.addEventListener('click', (event) => {
        if (!armed) {
          armed = true
          event.currentTarget.title = '再次点击确认删除'
          event.currentTarget.style.color = '#d0342c'
          toast('再点一次确认删除该连接')
          return
        }
        const result = removeConnection(localStorage, id)
        if (result.removedActive) switchTo(LOCAL_ID) // 删的是活动连接：回落本机并刷新
        else { toast('已删除'); render() }
      })
    })
  }

  const renderEdit = (row, item, render) => {
    row.innerHTML = `
      <div style="flex:1;min-width:260px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div style="flex:1;min-width:140px">
          <label class="form-label">名称</label>
          <input class="input" data-edit="name" value="${esc(item.name)}">
        </div>
        <div style="flex:2;min-width:240px">
          <label class="form-label">宿主服务地址</label>
          <input class="input" data-edit="base" value="${esc(item.base)}">
        </div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" data-act="save">保存</button>
        <button class="btn btn-ghost btn-sm" data-act="cancel">取消</button>
      </div>`
    row.querySelector('[data-act="cancel"]').addEventListener('click', render)
    row.querySelector('[data-act="save"]').addEventListener('click', () => {
      const result = upsertConnection(localStorage, {
        id: item.id,
        name: row.querySelector('[data-edit="name"]').value,
        base: row.querySelector('[data-edit="base"]').value,
      })
      if (!result.ok) return toast(result.error, 'error')
      toast(active().id === item.id ? '已保存。点击「重新应用」以生效' : '已保存')
      render()
    })
  }

  render()
}
