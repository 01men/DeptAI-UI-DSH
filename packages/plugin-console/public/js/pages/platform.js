/** 平台信息：插件树 / 工具目录 / 事件流 —— 「一切皆插件」的可视化证明。 */
import { api } from '../api.js'
import { icon } from '../icons.js'
import { h, $, $$, esc, timeAgo } from '../ui.js'
import { openUpdateDrawer } from '../update.js'
import rqI18n from '../i18n.js'

export async function renderPlatform(content) {
  const info = await api.get('/api/platform/info')
  const pluginDesc = {
    'platform-core': ['基础层', '存储 / 事件总线 / 工具运行时 / HTTP', 'settings'],
    'resource-core': ['底座', '资源本体：属性 schema + 生命周期 + 依赖图', 'layers'],
    iam: ['业务域', '组织账号 / 角色 / 用户组 / 三方连接器', 'users'],
    authn: ['业务域', '统一认证：双轨身份 / 令牌 / on-behalf-of', 'key'],
    audit: ['业务域', '审计日志 / 告警 / 成本 / 审批中心', 'scroll'],
    mcp: ['业务域', 'MCP 部署 / 权限组 / 网关 / 监控', 'plug'],
    skillhub: ['业务域', 'Skill 市场：扫描 / 审批 / 版本化上架', 'sparkles'],
    agent: ['业务域', 'Agent 本体：注册 / 绑定 / 监测 / 生命周期', 'bot'],
    app: ['业务域', 'AI 应用：编排 / 指标 / 成本穿透', 'app'],
    connect: ['业务域', '远程接入：接入码 / 客户端 / 工具代理', 'fingerprint'],
    update: ['平台维护', '上游版本检查 / 通知 / 一键升级', 'refresh'],
    console: ['接入层', 'REST 网关 / 控制台 SPA / 种子数据', 'globe'],
  }

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="micro-label">PLUGINS / RUNTIME</div>
        <div class="page-title">插件与工具</div>
        <div class="page-sub">运行中的平台 = 一棵 cordis 插件树。每个业务域都是可独立启停的插件，工具契约与 dsh 原生 ToolRuntime 对齐。</div>
      </div>
      <div class="page-actions">
        <button class="badge badge-brand no-dot" id="btn-platform-version" title="查看平台更新" style="cursor:pointer;border:0">${esc(rqI18n.t('版本 v{v}{suffix}', { v: info.version, suffix: info.installMode === 'bundle' ? rqI18n.t('（市场安装）') : '' }))}</button>
        <span class="badge badge-brand no-dot">${esc(rqI18n.t('运行时：{v}', { v: info.runtime }))}</span>
        <span class="badge badge-ok no-dot">${esc(rqI18n.t('{n} 个插件在线', { n: info.plugins.length }))}</span>
      </div>
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.2fr 1fr;align-items:start">
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('puzzle', 15)} 插件树</span><span class="card-sub">dsh-plugin-* 体系</span></div>
        <div class="card-body" style="padding-top:8px">
          ${info.plugins.map((plugin) => {
            const meta = pluginDesc[plugin] ?? ['业务域', '', 'box']
            const layerClass = meta[0] === '基础层' || meta[0] === '底座' ? 'badge-muted' : meta[0] === '接入层' ? 'badge-info' : 'badge-brand'
            return `
              <div class="flex" style="padding:9px 0;border-bottom:1px solid var(--border)">
                <span style="color:var(--brand-500)">${icon(meta[2], 16)}</span>
                <span class="mono fs-13" style="font-weight:600">dsh-plugin-${esc(plugin)}</span>
                <span class="fs-12 text-3 grow">${esc(meta[1])}</span>
                <span class="badge ${layerClass} no-dot">${esc(meta[0])}</span>
              </div>`
          }).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('zap', 15)} 最近平台事件</span></div>
        <div class="card-body" style="padding-top:8px">
          ${info.events.map((event) => `
            <div class="flex" style="padding:6px 0;border-bottom:1px solid var(--border)">
              <span class="mono fs-11" style="color:var(--brand-600);min-width:150px">${esc(event.name)}</span>
              <span class="fs-11 text-4">${timeAgo(event.at)}</span>
            </div>`).join('') || '<span class="text-4 fs-12">暂无</span>'}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('terminal', 15)} ${esc(rqI18n.t('模型可用工具目录（{n}）', { n: info.tools.length }))}</span>
        <span class="card-sub">与 dsh ToolRuntime 契约一致 · 可被 dshctl / Skill / 模型直接调用</span>
      </div>
      <div class="card-body" style="padding-top:8px">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:8px">
          ${info.tools.map((tool) => `
            <div class="card" style="padding:10px 14px;border-radius:9px;cursor:default">
              <div class="flex" style="gap:8px">
                <span class="mono fs-12" style="font-weight:600;color:var(--brand-600)">${esc(tool.name)}</span>
                <span class="badge badge-muted no-dot" style="margin-left:auto">${esc(tool.plugin ?? 'core')}</span>
              </div>
              <div class="fs-12 text-3 mt-8" style="line-height:1.5">${esc(tool.description)}</div>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="card mt-20">
      <div class="card-head"><span class="card-title">${icon('box', 15)} ${esc(rqI18n.t('数据集合（{n}）', { n: info.collections.length }))}</span><span class="card-sub">存储抽象：JSON 集合 + 原子落盘，可替换为 DB 实现</span></div>
      <div class="card-body">
        <div class="flex" style="flex-wrap:wrap;gap:6px">
          ${info.collections.map((collection) => `<span class="badge badge-muted no-dot mono">${esc(collection)}</span>`).join('')}
        </div>
      </div>
    </div>`

  const versionBtn = $('#btn-platform-version')
  if (versionBtn) versionBtn.onclick = () => void openUpdateDrawer()
}
