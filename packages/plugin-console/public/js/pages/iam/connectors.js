/**
 * 三方集成 tab：连接器配置/同步执行/健康巡检/多主体（R4 前端拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 pages/iam.js 的 renderIam 闭包拆出，逐字搬运（行为与迁出前一致）。
 */
import { api, session } from '../../api.js'
import { icon } from '../../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog, copyText,
  renderTable, statusBadge, collectForm, field, inputField, selectField, textareaField,
  searchableSelectField, mountSearchableSelects,
  attachDropdown, timeAgo, emptyState,
} from '../../ui.js'
import {
  providerName, nameStatusMismatch, strategyName, fieldName, syncStatCard,
  flattenTree, flattenTreePaths, findOrgNode, flattenOrgList, buildOrgPaths, debounce,
} from './helpers.js'
import rqI18n from '../../i18n.js'

export async function renderConnectors(params2, ctx2) {
  const [data, orgs] = await Promise.all([api.get('/api/iam/connectors'), api.get('/api/iam/orgs')])
  const configs = data.configs ?? []
  // 目标组织展示/下拉共用：平铺组织列表按 parentId 还原层级后拍平（带全路径，UI-04）
  const orgOptions = flattenOrgList(orgs)
  const orgPathOptions = buildOrgPaths(orgs)
  const orgNameOf = (id) => orgOptions.find((o) => o.id === id)?.name
  // 回调地址按当前访问地址自动生成（与后端发起授权时按 Host 头拼接的 redirect_uri 一致），
  // 直接复制到钉钉开发者后台的登录重定向地址即可，无需手填。全部主体共用同一回调地址。
  const callbackUrl = `${location.origin.replace(/\/+$/, '')}/api/auth/sso`
  $('#iam-actions').innerHTML = `<button class="btn btn-primary" id="conn-add">${icon('plus', 14)}新增接入</button>`
  $('#conn-add').onclick = () => openConnectorEditor(null)

  const body = $('#iam-body')
  if (!configs.length) {
    body.innerHTML = ''
    body.appendChild(emptyState({ title: '还没有三方接入', desc: '接入钉钉等企业主体后，可按主体独立同步通讯录、开启扫码登录', actionText: '新增接入', onAction: () => $('#conn-add').click() }))
  } else {
    body.innerHTML = ''
    for (const config of configs) body.appendChild(connectorCard(config))
  }

  /** 单个接入主体卡片：配置概览 + 自检/同步/编辑/删除，操作均按配置实例 id 寻址。 */
  function connectorCard(config) {
    const card = h(`
      <div class="card mb-20">
        <div class="card-head">
          <span class="card-title">${icon('link', 15)} ${esc(config.name || providerName(config.provider))}</span>
          <span class="badge ${config.mode === 'real' ? 'badge-brand' : 'badge-muted'} no-dot">${config.mode === 'real' ? 'real' : 'mock'}</span>
          ${config.enabled ? '<span class="badge badge-ok">已启用</span>' : '<span class="badge badge-muted">未启用</span>'}
          <div class="card-head-actions">
            <button class="btn btn-default btn-sm" data-test>${icon('wifi', 13)}连通性自检</button>
            <button class="btn btn-primary btn-sm" data-sync>${icon('refresh', 13)}立即同步</button>
          </div>
        </div>
        <div class="card-body">
          <div class="grid-3 mb-14">
            ${syncStatCard('最近同步', config.lastSyncAt ? timeAgo(config.lastSyncAt) : '从未同步', config.lastSyncResult?.ok ? 'var(--ok)' : 'var(--text-3)')}
            ${syncStatCard('同步结果', config.lastSyncResult ? config.lastSyncResult.message : '—', 'var(--text-1)')}
            ${syncStatCard('同步频率', (config.intervalMinutes ?? 60) > 0 ? rqI18n.t('每 {n} 分钟（自动）', { n: config.intervalMinutes ?? 60 }) : '仅手动', 'var(--text-1)')}
          </div>
          <div class="desc-grid">
            <div class="desc-item"><span class="k">平台</span><span class="v">${esc(providerName(config.provider))}</span></div>
            <div class="desc-item"><span class="k">CorpID</span><span class="v mono">${esc(config.corpId ?? '未配置')}</span></div>
            <div class="desc-item"><span class="k">AppKey</span><span class="v mono">${esc(config.appKey ?? '未配置')}</span></div>
            <div class="desc-item"><span class="k">AppSecret</span><span class="v mono">${esc(config.secretMasked ?? '—')} <span class="text-4">（KMS 加密存储）</span></span></div>
            <div class="desc-item"><span class="k">目标组织</span><span class="v">${esc(config.targetOrgId ? (orgNameOf(config.targetOrgId) ?? config.targetOrgId) : '平台根')}</span></div>
            <div class="desc-item"><span class="k">扫码登录</span><span class="v">${config.loginEnabled ? '已开启' : '未开启'}</span></div>
            <div class="desc-item"><span class="k">回调地址</span><span class="v mono">${esc(callbackUrl)}</span></div>
            <div class="desc-item"><span class="k">冲突策略</span><span class="v">${esc(strategyName(config.conflictStrategy))}</span></div>
          </div>
          <div class="flex mt-14">
            <button class="btn btn-default btn-sm" data-edit>${icon('settings', 13)}接入配置</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del>${icon('trash', 13)}删除</button>
          </div>
        </div>
      </div>`)
    card.querySelector('[data-test]').onclick = async (e) => {
      const btn = e.currentTarget
      btn.classList.add('btn-loading')
      try {
        const result = await api.post(`/api/iam/connectors/${config.id}/test`)
        toast(rqI18n.t('{msg}（{ms}ms）', { msg: result.message, ms: result.latencyMs }))
      } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
    }
    card.querySelector('[data-sync]').onclick = async (e) => {
      const btn = e.currentTarget
      btn.classList.add('btn-loading')
      try {
        const result = await api.post(`/api/iam/connectors/${config.id}/sync`)
        toast(result.message)
        setTimeout(() => ctx2.rerender(), 600)
      } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
    }
    card.querySelector('[data-edit]').onclick = () => openConnectorEditor(config)
    card.querySelector('[data-del]').onclick = async () => {
      const result = await confirmDialog({
        title: '删除接入', danger: true,
        message: esc(rqI18n.t('确定删除主体「{name}」的接入配置？将同时注销其运行时连接器与登录身份源（已同步的组织与账号保留）。', { name: config.name || config.corpId })),
      })
      if (!result) return
      try {
        await api.delete(`/api/iam/connectors/${config.id}`)
        toast(rqI18n.t('接入已删除')); ctx2.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
    return card
  }

  /** 接入配置弹窗：config 为空为新增接入（AppSecret 必填），传入 config 为编辑（AppSecret 留空保持不变）。 */
  function openConnectorEditor(config) {
    const isEdit = !!config
    const modal = openModal({
      title: isEdit ? esc(rqI18n.t('接入配置（{name}）', { name: config.name || providerName(config.provider) })) : '新增接入', wide: true,
      body: `
        <div class="form-grid">
          ${field('三方平台', '<code class="mono" style="line-height:32px">钉钉（dingtalk）</code>', { hint: '当前仅支持钉钉，更多平台陆续接入' })}
          ${field('主体名称', inputField('name', { value: config?.name, placeholder: '如：集团总部 / 华南子公司' }), { required: true })}
          ${field('CorpID', inputField('corpId', { value: config?.corpId }), { required: true })}
          ${field('AppKey', inputField('appKey', { value: config?.appKey }), { required: true })}
          ${field('AppSecret', inputField('appSecret', { value: '', placeholder: isEdit ? '留空保持不变（加密存储）' : '必填（加密存储）' }), { required: !isEdit, hint: '通过 KMS 托管加密，禁止明文落库' })}
          ${field('同步频率（分钟）', inputField('intervalMinutes', { value: config?.intervalMinutes ?? 60 }), { hint: '按此间隔自动同步通讯录（下限 5 分钟）；填 0 表示仅手动同步' })}
          ${field('回调地址（自动生成）', `
            <div class="flex" style="gap:8px">
              <input class="input" name="callbackUrl" readonly value="${esc(callbackUrl)}" style="flex:1">
              <button class="btn btn-default" id="conn-copy-callback">${icon('copy', 13)}复制</button>
            </div>`, { full: true, hint: '按当前访问地址生成，请将其配置到钉钉开发者后台对应应用的登录重定向地址（redirect URI）' })}
          ${field('冲突处理策略', selectField('conflictStrategy', [
            { value: 'manual', label: '人工确认（推荐）' },
            { value: 'third_party_wins', label: '以三方为准' },
            { value: 'platform_wins', label: '以平台为准' },
          ], { value: config?.conflictStrategy ?? 'manual' }))}
          ${field('目标组织', searchableSelectField('targetOrgId', orgPathOptions, { value: config?.targetOrgId ?? '', emptyLabel: '（平台根）', placeholder: '点击选择目标组织' }), { hint: '同步下来的三方部门与人员挂到该组织下，空值为平台根' })}
          ${field(' ', `<label class="flex"><input type="checkbox" name="loginEnabled" ${config?.loginEnabled ? 'checked' : ''} style="accent-color:var(--brand-500)"> 允许钉钉扫码登录控制台</label>`)}
        </div>`,
      foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>${isEdit ? '保存' : '创建'}</button>`,
    })
    mountSearchableSelects(modal.body)
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('#conn-copy-callback').onclick = () => copyText(callbackUrl)
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data2 = collectForm(modal.body)
      if (!data2.name) return toast(rqI18n.t('主体名称不能为空'), 'error')
      if (!data2.corpId || !data2.appKey) return toast(rqI18n.t('CorpID 与 AppKey 不能为空'), 'error')
      if (!isEdit && !data2.appSecret) return toast(rqI18n.t('AppSecret 不能为空'), 'error')
      const payload = {
        provider: 'dingtalk',
        name: data2.name,
        corpId: data2.corpId,
        appKey: data2.appKey,
        // 显式输入按原值落库（0=仅手动同步）；空/非法输入回落默认 60（Number('')===0 须先排除空串，否则清空会误存 0）
        intervalMinutes: data2.intervalMinutes === '' || !Number.isFinite(Number(data2.intervalMinutes)) ? 60 : Math.max(0, Number(data2.intervalMinutes)),
        callbackUrl: data2.callbackUrl,
        conflictStrategy: data2.conflictStrategy,
        targetOrgId: data2.targetOrgId || undefined,
        loginEnabled: data2.loginEnabled,
        ...(data2.appSecret ? { appSecret: data2.appSecret } : {}),
      }
      try {
        if (isEdit) {
          await api.put(`/api/iam/connectors/${config.id}`, payload)
          toast(rqI18n.t('配置已更新（变更已审计）'))
        } else {
          await api.post('/api/iam/connectors', payload)
          toast(rqI18n.t('接入已创建'))
        }
        modal.close(); ctx2.rerender()
      } catch (error) { toast(error.message, 'error') }
    }
  }

  if (params2.get('action') === 'sync') {
    // 兼容旧入口（未指定主体）：对第一条 dingtalk 配置触发同步
    const target = configs.find((c) => c.provider === 'dingtalk')
    if (target) void api.post(`/api/iam/connectors/${target.id}/sync`).then((r) => toast(r.message)).catch((e) => toast(e.message, 'error'))
    location.hash = '#/iam?tab=connectors'
  }
}
