/**
 * 部门面板登记（2026-10-22）：宿主连接 × 部门 的显式登记。
 *
 * 背景：此前 NAV「部门面板」是一个硬编码外链 `${BASE}/panel/`，与控制台的宿主连接清单
 * 没有任何事实关联——换宿主后进哪个部门、看哪份看板，由目标宿主自己的 localStorage 记忆决定。
 * 现在把关系显式化：
 *   - 面板登记绑定「宿主（来自宿主服务连接清单）+ 部门标识」；
 *   - 未登记的部门不产生跳转入口（#/panels 只列登记项），登记面在「宿主服务连接」页；
 *   - 宿主被删除时其面板登记自动清理（connections.js removeConnection），不留悬空入口。
 * 数据只存浏览器（与连接清单同域同生命期），不引入服务端状态；权限沿用 panel.read
 * （目标面板自身仍按 panel.read + 部门范围拦截，登记只是入口管理，不是授权）。
 *
 * 本模块导出两处共用的 UI 片段：
 *   - loadPanelDepts()：面板部门目录（失败返回空，登记退化为手工填标识）
 *   - renderPanelRegistry()：登记清单 + 新增/编辑/删除（connections 页与管理页共用）
 */
import { api } from '../api.js'
import { icon } from '../icons.js'
import { $, esc, toast, confirmDialog, openModal, collectForm, field, inputField, selectField } from '../ui.js'
import { loadConnections, upsertPanel, removePanel, resolvePanels, LOCAL_ID } from '../connections.js'
import { LANDING_PREF_KEY } from '../landing.js'
import rqI18n from '../i18n.js'

const MOUNT = new URL('.', document.baseURI).pathname.replace(/\/$/, '')

/** 面板部门目录（panel.read）；面板服务不可用时返回空数组，调用方退化为手工输入。 */
export async function loadPanelDepts() {
  try {
    return (await api.get('/api/panel/depts'))?.depts ?? []
  } catch {
    return []
  }
}

/** 宿主候选：本机恒在列，其余来自连接清单。 */
export function panelHostOptions(storage = localStorage) {
  return [
    { id: LOCAL_ID, name: '本机宿主服务' },
    ...loadConnections(storage).map((item) => ({ id: item.id, name: item.name })),
  ]
}

function hostBase(connectionId, storage = localStorage) {
  const base = connectionId === LOCAL_ID
    ? MOUNT
    : loadConnections(storage).find((item) => item.id === connectionId)?.base ?? ''
  return String(base).replace(/\/+$/, '')
}

/**
 * 渲染面板登记清单（可嵌在任意容器）。
 * @param {HTMLElement} container 宿主容器
 * @param {{ depts?: Array<{id:string,label:string}>, filterHostId?: string, onChange?: () => void, compact?: boolean }} options
 *   filterHostId 只展示该宿主的登记（连接页按行展开时用）；不传=全部。
 */
export function renderPanelRegistry(container, { depts = [], filterHostId, onChange, compact = false } = {}) {
  const render = () => {
    const all = resolvePanels(localStorage, MOUNT)
    const panels = filterHostId ? all.filter((panel) => panel.connectionId === filterHostId) : all
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <div class="fs-13" style="font-weight:600">${icon('users', 14)} ${esc(rqI18n.t('部门面板'))}</div>
        <span class="fs-12 text-3">${esc(rqI18n.t('登记在该宿主上的部门可从这里一键进入；未登记则不提供入口。'))}</span>
        <button class="btn btn-default btn-sm" data-register style="margin-left:auto">${icon('plus', 13)} ${esc(rqI18n.t('登记面板'))}</button>
      </div>
      <div data-rows></div>`

    const rows = container.querySelector('[data-rows]')
    if (!panels.length) {
      rows.innerHTML = `<div class="fs-12 text-4" style="padding:6px 2px">${esc(rqI18n.t('暂无登记的面板。'))}</div>`
    } else {
      for (const panel of panels) {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px 2px;border-top:1px solid var(--border);flex-wrap:wrap'
        row.innerHTML = `
          <div style="flex:1;min-width:200px">
            <div class="fs-13" style="font-weight:600;display:flex;gap:8px;align-items:center">
              ${esc(panel.name)}
              ${panel.isActiveHost ? `<span class="badge badge-ok no-dot">${esc(rqI18n.t('当前宿主'))}</span>` : `<span class="badge badge-muted no-dot">${esc(rqI18n.t('其他宿主'))}</span>`}
              ${panel.available ? '' : `<span class="badge badge-warn no-dot">${esc(rqI18n.t('宿主已删除'))}</span>`}
            </div>
            <div class="fs-12 text-3">
              ${esc(panel.hostName)} · <code class="mono">${esc(panel.dept)}</code>
              ${compact ? '' : ` · <span class="text-4">${esc(panel.url)}</span>`}
            </div>
          </div>
          <button class="btn btn-primary btn-sm" data-open ${panel.available ? '' : 'disabled'}>${icon('external', 13)} ${esc(rqI18n.t('进入'))}</button>
          <button class="btn btn-ghost btn-sm" data-edit>${icon('edit', 13)}</button>
          <button class="btn btn-ghost btn-sm" data-del>${icon('trash', 13)}</button>`
        row.querySelector('[data-open]').onclick = () => {
          if (!panel.url) return
          // 显式跨工作台切换：记落地偏好，控制台分诊不再把业务身份硬拽回面板首页
          try { localStorage.setItem(LANDING_PREF_KEY, 'panel') } catch { /* 忽略 */ }
          location.assign(panel.url)
        }
        row.querySelector('[data-edit]').onclick = () => openPanelEditor({ panel, depts, onSaved: () => { render(); onChange?.() } })
        row.querySelector('[data-del]').onclick = async () => {
          const confirmed = await confirmDialog({
            title: rqI18n.t('删除面板登记'),
            danger: true,
            message: rqI18n.t('确定删除「{name}」的面板登记？删除后该部门在控制台不再有一键入口（面板本身数据不受影响）。', { name: panel.name }),
          })
          if (!confirmed) return
          removePanel(localStorage, panel.id)
          toast(rqI18n.t('已删除面板登记'))
          render()
          onChange?.()
        }
        rows.appendChild(row)
      }
    }
    container.querySelector('[data-register]').onclick = () => openPanelEditor({
      ...(filterHostId ? { connectionId: filterHostId } : {}),
      depts,
      onSaved: () => { render(); onChange?.() },
    })
  }
  render()
  return { refresh: render }
}

/** 登记/编辑弹窗：宿主 + 部门标识（有目录用下拉，无目录手填）。 */
export function openPanelEditor({ panel, connectionId, depts = [], onSaved } = {}) {
  const isEdit = !!panel
  const hosts = panelHostOptions()
  const hostOptions = hosts.map((host) => ({ value: host.id, label: host.id === LOCAL_ID ? `${host.name}（内置）` : host.name }))
  const deptOptions = depts.map((dept) => ({ value: dept.id, label: `${dept.label}（${dept.id}）` }))
  const selectedHost = panel?.connectionId ?? connectionId ?? LOCAL_ID
  const selectedDept = panel?.dept ?? deptOptions[0]?.value ?? ''
  const modal = openModal({
    title: isEdit ? esc(rqI18n.t('编辑面板登记')) : esc(rqI18n.t('登记面板')),
    body: `
      <div class="form-grid">
        ${field(rqI18n.t('所属宿主'), selectField('host', hostOptions, { value: selectedHost }), { required: true, hint: rqI18n.t('只列出已在宿主服务连接登记的宿主；本机恒可选用') })}
        ${field(rqI18n.t('面板名称'), inputField('name', { value: panel?.name, placeholder: rqI18n.t('如：制造部工作台') }), { hint: rqI18n.t('留空自动生成「部门标识 @ 宿主名」') })}
        ${field(rqI18n.t('部门标识'), deptOptions.length
          ? selectField('dept', deptOptions, { value: selectedDept })
          : inputField('dept', { value: selectedDept, placeholder: 'mfg' }), { required: true, hint: deptOptions.length ? rqI18n.t('来自面板部门目录') : rqI18n.t('面板服务不可用，请手工填写目标宿主的部门标识') })}
      </div>
      <div class="form-hint" style="margin-top:10px">${esc(rqI18n.t('跳转地址：{url}', { url: `${hostBase(selectedHost)}/panel/?dept=${selectedDept || '…'}` }))}</div>`,
    foot: `<button class="btn btn-default" data-cancel>${esc(rqI18n.t('取消'))}</button><button class="btn btn-primary" data-ok>${isEdit ? esc(rqI18n.t('保存')) : esc(rqI18n.t('登记'))}</button>`,
  })
  modal.el.querySelector('[data-ok]').onclick = () => {
    const data = collectForm(modal.body)
    const result = upsertPanel(localStorage, {
      ...(isEdit ? { id: panel.id } : {}),
      name: data.name,
      connectionId: data.host,
      dept: data.dept,
      mountBase: MOUNT,
    })
    if (!result.ok) return toast(result.error, 'error')
    modal.close()
    toast(isEdit ? rqI18n.t('面板登记已更新') : rqI18n.t('面板已登记，可直接进入'))
    onSaved?.()
  }
}

/** 「部门面板」管理页（#/panels）：全部登记的跳转看板，登记动作引导到宿主服务连接。 */
export async function renderPanels(content) {
  const depts = await loadPanelDepts()
  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">DEPARTMENT PANELS</div>
        <div class="page-title">${esc(rqI18n.t('部门面板'))}</div>
        <div class="page-sub">${esc(rqI18n.t('这里只列出已在「宿主服务连接」中登记的面板：宿主 × 部门。没有登记就没有入口，避免误入其他宿主的同名部门。'))}</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" id="panel-goto-connections">${icon('server', 14)} ${esc(rqI18n.t('去宿主服务连接登记'))}</button>
        <button class="btn btn-primary" id="panel-add">${icon('plus', 14)} ${esc(rqI18n.t('登记面板'))}</button>
      </div>
    </div>
    <div class="card mb-20">
      <div class="card-head"><span class="card-title">${icon('users', 15)} ${esc(rqI18n.t('已登记面板'))}</span></div>
      <div class="card-body" style="padding-top:8px" id="panel-registry"></div>
    </div>
    <div class="muted-box" style="display:flex;gap:8px">
      ${icon('info', 15)}
      <span class="fs-12">${esc(rqI18n.t('面板运行在宿主服务上；跨宿主访问需目标宿主为同代版本并已放行跨域。面板自身的读取仍按 panel.read 与部门范围校验，登记只决定「有没有入口」。'))}</span>
    </div>`
  const registry = renderPanelRegistry($('#panel-registry'), { depts })
  $('#panel-add').onclick = () => openPanelEditor({ depts, onSaved: () => registry.refresh() })
  $('#panel-goto-connections').onclick = () => { location.hash = '#/connections' }
}