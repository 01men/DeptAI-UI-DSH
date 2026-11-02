/**
 * 组织与账号（iam 页骨架，R4 前端拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 五个 tab 渲染函数拆至同目录 {members,roles,groups,connectors,conflicts}.js，
 * 本骨架只做 tab 路由分发；对外导出面（renderIam）与迁出前一致。
 */
import { $, $$ } from '../../ui.js'
import { renderMembers } from './members.js'
import { renderRoles } from './roles.js'
import { renderGroups } from './groups.js'
import { renderConnectors } from './connectors.js'
import { renderConflicts } from './conflicts.js'

export async function renderIam(content, params, ctx) {
  const tab = params.get('tab') ?? 'members'
  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">IAM / ORG</div>
        <div class="page-title">组织与账号</div>
        <div class="page-sub">一套身份贯穿 MCP / Agent / 应用 / Skill / 模型 / NAS——组织架构、账号生命周期、角色权限与三方同步，人是一切授权的主体。</div>
      </div>
      <div class="page-actions" id="iam-actions"></div>
    </div>
    <div class="tabs" id="iam-tabs">
      <div class="tab ${tab === 'members' ? 'active' : ''}" data-tab="members">组织成员</div>
      <div class="tab ${tab === 'roles' ? 'active' : ''}" data-tab="roles">角色权限</div>
      <div class="tab ${tab === 'groups' ? 'active' : ''}" data-tab="groups">用户组</div>
      <div class="tab ${tab === 'connectors' ? 'active' : ''}" data-tab="connectors">三方集成</div>
      <div class="tab ${tab === 'conflicts' ? 'active' : ''}" data-tab="conflicts">同步冲突 <span class="tab-count" id="conflict-count"></span></div>
    </div>
    <div id="iam-body"></div>`

  $$('#iam-tabs .tab').forEach((el) => {
    el.onclick = () => { location.hash = `#/iam?tab=${el.dataset.tab}` }
  })

  // ctx（{rerender}）须贯穿到每个 tab：各 tab 的增删改回调里都调 ctx.rerender() 刷新整页
  if (tab === 'members') await renderMembers(ctx)
  if (tab === 'roles') await renderRoles(ctx)
  if (tab === 'groups') await renderGroups(ctx)
  if (tab === 'connectors') await renderConnectors(params, ctx)
  if (tab === 'conflicts') await renderConflicts(ctx)
}
