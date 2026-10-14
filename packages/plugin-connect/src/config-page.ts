/**
 * 客户端本地配置界面：远程电脑上打开浏览器完成/修改宿主连接配置的轻量单页。
 *
 * 形态：独立小 HTTP 服务（默认仅监听 127.0.0.1:7390，仅本机浏览器可访问），
 * 页面零依赖原生 JS。供「安装完插件不知道怎么配凭证」的场景可视化操作，
 * 与 Agent 工具（connect_setup 等）双通道等价。
 *
 * 防护：Host 头白名单（防 DNS rebinding）+ 跨域 Origin 拒绝（防浏览器 CSRF）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { ConnectClientService } from './client.ts'

export interface ConfigServerConfig {
  port?: number
  host?: string
}

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '[0:0:0:0:0:0:0:1]'])

export class ConnectConfigServer extends Service {
  static readonly provide = 'connectConfigServer'

  readonly port: number
  readonly host: string
  private server: import('node:http').Server | undefined
  private client: ConnectClientService

  constructor(ctx: Context, client: ConnectClientService, config: ConfigServerConfig = {}) {
    super(ctx, 'connectConfigServer')
    this.client = client
    this.port = config.port ?? 7390
    this.host = config.host ?? '127.0.0.1'
    ctx.effect(() => () => {
      void this.stop()
    })
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => {
      void this.dispatch(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private sameOriginGuard(req: IncomingMessage): boolean {
    const host = String(req.headers['host'] ?? '').split(':')[0]!.toLowerCase()
    if (!ALLOWED_HOSTS.has(host)) return false
    const origin = req.headers['origin']
    if (origin === undefined) return true // 同源 GET/非浏览器客户端（curl 等）
    try {
      return ALLOWED_HOSTS.has(new URL(String(origin)).hostname.toLowerCase())
    } catch {
      return false
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`)
    const method = (req.method ?? 'GET').toUpperCase()
    const reply = (status: number, payload: unknown, contentType = 'application/json; charset=utf-8'): void => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
      res.end(body)
    }
    try {
      if (!this.sameOriginGuard(req)) {
        reply(403, { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: '配置接口仅允许本机访问' } })
        return
      }
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        reply(200, CONFIG_PAGE_HTML, 'text/html; charset=utf-8')
        return
      }
      let body: Record<string, unknown> = {}
      if (method === 'POST') {
        const raw = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk) => chunks.push(chunk as Buffer))
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          req.on('error', () => resolve(''))
        })
        if (raw) body = JSON.parse(raw) as Record<string, unknown>
      }
      if (method === 'GET' && url.pathname === '/api/status') {
        reply(200, { ok: true, data: await this.client.status() })
        return
      }
      if (method === 'POST' && url.pathname === '/api/setup') {
        const data = await this.client.enroll({
          hubUrl: String(body['hubUrl'] ?? ''),
          enrollmentCode: String(body['enrollmentCode'] ?? ''),
          clientName: body['clientName'] === undefined || body['clientName'] === '' ? undefined : String(body['clientName']),
        })
        reply(200, { ok: true, data: { configured: true, clientName: data.clientName, template: data.template, hubUrl: data.hubUrl } })
        return
      }
      if (method === 'POST' && url.pathname === '/api/login') {
        const data = await this.client.loginWithCredential({
          hubUrl: String(body['hubUrl'] ?? ''),
          clientId: String(body['clientId'] ?? ''),
          clientSecret: String(body['clientSecret'] ?? ''),
          clientName: body['clientName'] === undefined || body['clientName'] === '' ? undefined : String(body['clientName']),
        })
        reply(200, { ok: true, data: { configured: true, clientName: data.clientName, hubUrl: data.hubUrl } })
        return
      }
      if (method === 'POST' && url.pathname === '/api/test') {
        const probe = await this.probe()
        reply(200, { ok: true, data: probe })
        return
      }
      if (method === 'POST' && url.pathname === '/api/reset') {
        this.client.reset()
        reply(200, { ok: true, data: { configured: false } })
        return
      }
      reply(404, { ok: false, error: { code: 'NOT_FOUND', message: `路由不存在：${method} ${url.pathname}` } })
    } catch (error) {
      reply(400, { ok: false, error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) } })
    }
  }

  /** 连通性 + 令牌 + 一次真实读调用（列 Agent）三合一体检。 */
  private async probe(): Promise<Record<string, unknown>> {
    const config = this.client.getConfig()
    if (!config) return { configured: false, hint: '请先填写宿主地址与接入码完成接入' }
    const result = await this.client.status()
    let sample: Record<string, unknown> = {}
    try {
      const value = await this.client.forward('agent_list', {}) // 走一次完整转发链路（含令牌获取）
      sample = { toolProxy: 'ok', sampleCall: { tool: 'agent_list', total: (value as { total?: number })?.total } }
    } catch { /* forward 失败信息已在 status.lastError */ }
    return { ...result, ...sample }
  }
}

// ---------------------------------------------------------------------------
// 内嵌单页（原生 JS，无外部依赖）
// ---------------------------------------------------------------------------

const CONFIG_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>元冰可 · 平台接入配置（dsh 本机）</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f3f5f9; color: #1f2329; }
  .wrap { max-width: 760px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #646a73; font-size: 13px; margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 12px; padding: 20px 22px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(31,35,41,.04); }
  .card h2 { font-size: 15px; margin: 0 0 14px; }
  .kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 12px; font-size: 13px; }
  .kv .k { color: #646a73; }
  .kv .v { font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
  .dot.ok { background: #10b981; } .dot.bad { background: #ef4444; } .dot.warn { background: #f59e0b; }
  label { display: block; font-size: 13px; color: #4b5158; margin: 12px 0 6px; }
  input { width: 100%; padding: 9px 11px; border: 1px solid #d5d9e0; border-radius: 8px; font-size: 14px; font-family: ui-monospace, Consolas, monospace; }
  input:focus { outline: 2px solid #4f6ef7; border-color: transparent; }
  .btns { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
  button { padding: 9px 18px; border-radius: 8px; border: 1px solid transparent; font-size: 14px; cursor: pointer; }
  .primary { background: #4f6ef7; color: #fff; }
  .primary:hover { background: #3d5bf5; }
  .ghost { background: #fff; border-color: #d5d9e0; color: #1f2329; }
  .danger { background: #fff; border-color: #f3c1c1; color: #d0342c; }
  .msg { margin-top: 12px; font-size: 13px; padding: 10px 12px; border-radius: 8px; display: none; }
  .msg.ok { display: block; background: #ecfdf3; color: #067647; }
  .msg.err { display: block; background: #fef3f2; color: #b42318; white-space: pre-wrap; }
  ol { margin: 8px 0 0; padding-left: 20px; font-size: 13px; color: #4b5158; line-height: 1.9; }
  code { background: #f2f3f5; border-radius: 4px; padding: 1px 6px; font-size: 12px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 14px; }
  .tab { padding: 7px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; background: #f2f3f5; }
  .tab.active { background: #4f6ef7; color: #fff; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <h1>元冰可 · 企业AI资源管理平台 — 接入配置</h1>
  <div class="sub">本页只在本机（127.0.0.1）可访问；配置保存于本机 data 目录，凭证不会发往宿主以外的任何地方。</div>

  <div class="card">
    <h2>当前状态</h2>
    <div class="kv" id="status">加载中…</div>
    <div class="btns"><button class="ghost" onclick="refresh()">刷新状态</button><button class="ghost" onclick="test()">测试连接</button></div>
    <div class="msg" id="test-msg"></div>
  </div>

  <div class="card">
    <h2>接入宿主服务</h2>
    <ol>
      <li>请宿主服务管理员在控制台「平台接入」页创建<b>接入码</b>（一次性，默认 15 分钟有效）</li>
      <li>在下方填入宿主地址与接入码，点击「申请接入」——本机将自动向宿主换取长期机器凭证</li>
      <li>后续所有平台运维工具调用将自动转发到宿主执行；也可随时在本页更新配置或断开</li>
    </ol>
    <div class="tabs">
      <div class="tab active" data-tab="enroll" onclick="switchTab('enroll')">接入码申请（推荐）</div>
      <div class="tab" data-tab="credential" onclick="switchTab('credential')">已有机器凭证</div>
    </div>
    <div id="pane-enroll">
      <label>宿主服务地址（如 http://192.168.1.5:7300）</label>
      <input id="hubUrl" placeholder="http://127.0.0.1:7300">
      <label>接入码（enr_ 开头，一次性）</label>
      <input id="enrollCode" placeholder="enr_xxxxxxxxxxxxxxxx">
      <label>本机名称（可选，用于宿主侧识别）</label>
      <input id="clientName" placeholder="留空自动取主机名">
      <div class="btns"><button class="primary" onclick="setup()">申请接入</button></div>
    </div>
    <div id="pane-credential" class="hidden">
      <label>宿主服务地址</label>
      <input id="hubUrl2" placeholder="http://192.168.1.5:7300">
      <label>ClientId（mc- 开头）</label>
      <input id="clientId">
      <label>ClientSecret</label>
      <input id="clientSecret" type="password">
      <div class="btns"><button class="primary" onclick="login()">保存凭证</button></div>
    </div>
    <div class="msg" id="setup-msg"></div>
  </div>

  <div class="card">
    <h2>断开</h2>
    <div class="sub" style="margin:0 0 12px">清除本机保存的宿主凭证（宿主侧凭证仍存在，如需彻底回收请在宿主控制台禁用该客户端）。</div>
    <button class="danger" onclick="reset()">断开并清除本机凭证</button>
    <div class="msg" id="reset-msg"></div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id)
const show = (id, ok, text) => { const el = $(id); el.className = 'msg ' + (ok ? 'ok' : 'err'); el.textContent = text }
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  const payload = await res.json().catch(() => null)
  if (!res.ok || !payload || payload.ok === false) throw new Error(payload && payload.error ? payload.error.message : ('HTTP ' + res.status))
  return payload.data
}
async function refresh() {
  const s = await post('/api/status', {})
  const rows = []
  const dot = (ok) => '<span class="dot ' + (ok === true ? 'ok' : ok === false ? 'bad' : 'warn') + '"></span>'
  rows.push(['接入状态', s.configured ? dot(true) + '已接入' : dot(false) + '未接入'])
  if (s.configured) {
    rows.push(['宿主地址', s.hubUrl])
    rows.push(['客户端名称', s.clientName])
    rows.push(['权限模板', s.template])
    rows.push(['宿主可达', s.hubReachable === true ? dot(true) + '正常' : dot(false) + '不可达'])
    rows.push(['机器令牌', s.tokenState])
    rows.push(['工具执行', s.toolProxy])
    if (s.lastError) rows.push(['最近错误', s.lastError])
  } else {
    rows.push(['说明', s.hint || '填写下方表单完成接入'])
  }
  $('status').innerHTML = rows.map(([k, v]) => '<span class="k">' + k + '</span><span class="v">' + v + '</span>').join('')
}
async function setup() {
  try {
    const data = await post('/api/setup', { hubUrl: $('hubUrl').value, enrollmentCode: $('enrollCode').value, clientName: $('clientName').value })
    show('setup-msg', true, '接入成功：' + data.clientName + '（模板 ' + data.template + '）。平台运维工具已切换为远程执行。')
    $('enrollCode').value = ''
    refresh()
  } catch (e) { show('setup-msg', false, e.message) }
}
async function login() {
  try {
    const data = await post('/api/login', { hubUrl: $('hubUrl2').value, clientId: $('clientId').value, clientSecret: $('clientSecret').value })
    show('setup-msg', true, '凭证验证并保存成功：' + data.clientName)
    refresh()
  } catch (e) { show('setup-msg', false, e.message) }
}
async function test() {
  try {
    const data = await post('/api/test', {})
    show('test-msg', true, '连通性：' + (data.hubReachable === true ? '正常' : '不可达') + '；机器令牌：' + data.tokenState)
  } catch (e) { show('test-msg', false, e.message) }
}
async function reset() {
  try {
    await post('/api/reset', {})
    show('reset-msg', true, '已断开并清除本机凭证。')
    refresh()
  } catch (e) { show('reset-msg', false, e.message) }
}
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === name))
  $('pane-enroll').classList.toggle('hidden', name !== 'enroll')
  $('pane-credential').classList.toggle('hidden', name !== 'credential')
}
refresh()
</script>
</body>
</html>
`
