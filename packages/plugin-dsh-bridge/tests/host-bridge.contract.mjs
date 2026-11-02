#!/usr/bin/env node
/**
 * host-bridge 契约测试（EXEC-CHECKLIST W5）——node 直跑断言脚本（exit 0/1）。
 *
 * 不依赖真实 dsh：用 mock webServer / mock httpServer 驱动改造后的
 * plugin-dsh-bridge，逐条断言「宿主桥窄端口」的契约成立：
 *   1. adapter 正确包装 mock webServer 的必须能力（register 转发保真）；
 *   2. 可选能力 tapIndex 存在时转发、缺失时降级不炸（不要求宿主升级）；
 *   3. HostBridgeRegistry 端口注册/取用往返；
 *   4. dsh-bridge apply 全链：等价 selftest.mjs dsh 宿主挂载段的 fakeWebServer
 *      场景——5 条路由注册 + tapIndex 注入 + /rq 剥前缀 dispatch + /dsh-bridge
 *      status 端点行为（进程内 fake req/res，不监听端口）。
 *
 * 运行：node packages/plugin-dsh-bridge/tests/host-bridge.contract.mjs
 * （或 npm run test:contracts）
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as dshBridge from '../src/index.ts'
import { HostBridgeRegistry, createHostWebPort } from '../../platform-core/src/host-bridge.ts'

// ── 轻量 check（selftest 同思路）────────────────────────────────────────────
const results = []
let failures = 0
function check(name, condition, detail = '') {
  const pass = Boolean(condition)
  results.push({ name, pass })
  if (!pass) failures++
  console.log(`  ${pass ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}${pass ? '' : `  ← ${detail}`}`)
  return pass
}

// ── mock 工厂 ────────────────────────────────────────────────────────────────
const makeFakeWebServer = ({ withTapIndex = true } = {}) => {
  const captured = []
  const taps = []
  const fake = { register: (route) => { captured.push(route); return () => {} } }
  if (withTapIndex) fake.tapIndex = (transform) => { taps.push(transform); return () => {} }
  return { fake, captured, taps }
}

/** 进程内 fake res：捕获写头与响应体（不监听端口）。 */
const makeFakeRes = () => {
  const res = {
    statusCode: 0, headers: {}, body: '',
    writeHead(code, headers) { res.statusCode = code; res.headers = { ...headers }; return res },
    end(body) { res.body = body ?? ''; return res },
  }
  return res
}

/** 静默 logger（契约测试不关心日志内容，只要求 apply 可调用）。 */
const silentLogger = () => ({ info() {}, warn() {}, error() {} })

/**
 * 复刻 selftest「dsh 宿主挂载」段的进程内装配形态：
 * plain-object 服务视图 + fakeWebServer + 真实 Context 上的 IdentityBindingService。
 */
function applyBridge({ withTapIndex = true, withOidc = true } = {}) {
  const { fake, captured, taps } = makeFakeWebServer({ withTapIndex })
  const dispatched = []
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-contract-'))
  const credentialFile = join(dir, 'dsh-agent-credential.json')
  const ctxView = {
    webServer: fake,
    httpServer: { dispatch: (req, res) => { dispatched.push({ req, res }) } },
    logger: silentLogger,
    identityBinding: new dshBridge.IdentityBindingService(new Context(), {}),
    ...(withOidc ? { oidc: { issuer: () => 'https://oidc.example.invalid' } } : {}),
  }
  if (withOidc) {
    writeFileSync(credentialFile, JSON.stringify({ oidc: { clientId: 'oc-contract', clientSecret: 'ocs_contract' } }))
  }
  dshBridge.apply(ctxView, withOidc ? { mountPath: '/rq', oidcCredentialFile: credentialFile } : { mountPath: '/rq' })
  return { captured, taps, dispatched, dir }
}

const findRoute = (captured, kind, path) => captured.find((r) => r.kind === kind && r.path === path)

// ══ 1. adapter 包装必须能力（register 转发保真）══════════════════════════════
console.log('\n\x1b[36m━━ 1. adapter 必须能力：register 转发保真 ━━\x1b[0m')
{
  const { fake, captured } = makeFakeWebServer({ withTapIndex: false })
  const port = createHostWebPort(fake)
  const handler = () => {}
  const route = { kind: 'prefix', path: '/rq', handler }
  const returned = port.register(route)
  const seen = captured[0]
  check('register 调用转发到宿主（恰好一次）', captured.length === 1)
  check('route 三元组保真（kind/path/handler 同引用）',
    seen?.kind === 'prefix' && seen?.path === '/rq' && seen?.handler === handler)
  check('宿主返回值原样透传（dispose 函数）', typeof returned === 'function')
  check('端口不含 tapIndex 伪造（mock 未提供 → 属性缺席）', port.tapIndex === undefined)
}

// ══ 2. 可选能力 tapIndex：存在转发 / 缺席降级 ════════════════════════════════
console.log('\n\x1b[36m━━ 2. 可选能力 tapIndex：存在转发、缺席降级 ━━\x1b[0m')
{
  const { fake, taps } = makeFakeWebServer({ withTapIndex: true })
  const port = createHostWebPort(fake)
  const out = port.tapIndex?.((html) => `<x>${html}</x>`)
  check('tapIndex 存在时转发并返回宿主返回值', typeof out === 'function' && taps.length === 1)
  check('transform 经宿主执行且产出一致', taps[0]('a') === '<x>a</x>')

  const bare = createHostWebPort({ register: () => {} })
  check('tapIndex 缺席 → 端口属性缺席（降级面，不要求宿主升级）', bare.tapIndex === undefined)
}

// ══ 3. HostBridgeRegistry 端口注册/取用往返 ═════════════════════════════════
console.log('\n\x1b[36m━━ 3. HostBridgeRegistry 注册/取用往返 ━━\x1b[0m')
{
  const ctx = new Context()
  const registry = new HostBridgeRegistry(ctx)
  check('未登记：port() 返回 null、isReady() false（消费方降级语义）',
    registry.port() === null && registry.isReady() === false)
  const port = createHostWebPort({ register: () => {} })
  registry.registerWebPort(port)
  check('登记后 port() 取回同一端口实例、isReady() true',
    registry.port() === port && registry.isReady() === true)
  const next = createHostWebPort({ register: () => {} })
  registry.registerWebPort(next)
  check('重复登记取新（最后登记者生效）', registry.port() === next)
}

// ══ 4. apply 全链：5 条路由注册（selftest fakeWebServer 场景等价）════════════
console.log('\n\x1b[36m━━ 4. apply 全链：fakeWebServer 挂载契约（等价 selftest）━━\x1b[0m')
{
  const { captured, taps, dispatched, dir } = applyBridge()
  check('① prefix /rq 挂载路由已注册', Boolean(findRoute(captured, 'prefix', '/rq')),
    JSON.stringify(captured.map((r) => `${r.kind}:${r.path}`)))
  check('② exact /auth/entry 已注册', Boolean(findRoute(captured, 'exact', '/auth/entry')))
  check('③ prefix /dsh-bridge 已注册', Boolean(findRoute(captured, 'prefix', '/dsh-bridge')))
  check('④ exact /auth/oidc/start 已注册', Boolean(findRoute(captured, 'exact', '/auth/oidc/start')))
  check('⑤ exact /auth/oidc/callback 已注册', Boolean(findRoute(captured, 'exact', '/auth/oidc/callback')))
  check('⑥ tapIndex 注入恰一次，脚本含 entry_ticket 兑换调用',
    taps.length === 1 && taps[0]('<html><head></head></html>').includes('entry_ticket'))

  // 路由行为等价：/rq 裸路径 302 归一 + 剥前缀 dispatch（经 mock httpServer 捕获）
  const mount = findRoute(captured, 'prefix', '/rq')
  const res302 = makeFakeRes()
  mount.handler({ url: '/rq', headers: {} }, res302)
  check('⑦ /rq 裸路径 → 302 location /rq/（目录形态归一）',
    res302.statusCode === 302 && res302.headers.location === '/rq/')
  const reqProbe = { url: '/rq/api/__mount_probe', headers: {} }
  mount.handler(reqProbe, makeFakeRes())
  check('⑧ /rq/api/* 剥前缀后交 httpServer.dispatch（/api/__mount_probe）',
    dispatched.length === 1 && dispatched[0].req.url === '/api/__mount_probe')

  // 身份半端点行为：无 Cookie 状态查询 → 未绑定 + 原因码（WP-04/A2 契约）
  const status = findRoute(captured, 'prefix', '/dsh-bridge')
  const resStatus = makeFakeRes()
  status.handler({ url: '/dsh-bridge/status', method: 'GET', headers: {} }, resStatus)
  let statusPayload = null
  try { statusPayload = JSON.parse(resStatus.body) } catch { /* 保持 null */ }
  check('⑨ /dsh-bridge/status 无 Cookie → bound:false + reason:no_cookie（JSON 信封）',
    resStatus.statusCode === 200 && statusPayload?.ok === true
    && statusPayload?.data?.bound === false && statusPayload?.data?.reason === 'no_cookie',
    JSON.stringify(resStatus.body))
  rmSync(dir, { recursive: true, force: true })
}

// ══ 5. 可选能力缺失：fakeWebServer 无 tapIndex 时 apply 降级不炸 ═════════════
console.log('\n\x1b[36m━━ 5. fakeWebServer 缺 tapIndex：降级不炸 ━━\x1b[0m')
{
  const { captured, taps } = applyBridge({ withTapIndex: false })
  check('全部 5 条路由照常注册（可选能力缺失不影响必须能力）',
    Boolean(findRoute(captured, 'prefix', '/rq')) && Boolean(findRoute(captured, 'exact', '/auth/entry'))
    && Boolean(findRoute(captured, 'prefix', '/dsh-bridge')) && Boolean(findRoute(captured, 'exact', '/auth/oidc/start'))
    && Boolean(findRoute(captured, 'exact', '/auth/oidc/callback')))
  check('tapIndex 未被调用（免登脚本通道诚实降级）', taps.length === 0)
}

// ══ 6. 源面收敛守卫：dsh-bridge 不直接 import 任何 dsh 包 ═══════════════════
console.log('\n\x1b[36m━━ 6. 源面收敛守卫 ━━\x1b[0m')
{
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  check('src/index.ts 无 @deepseek-ai/dsh-* 直接依赖（耦合只经 platform-core 窄端口）',
    !source.includes('@deepseek-ai/dsh'))
  check('src/index.ts 经 host-bridge 端口消费（createHostWebPort 接线在场）',
    source.includes('createHostWebPort') && source.includes('hostWeb.register'))
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const passed = results.length - failures
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}host-bridge 契约：${passed}/${results.length} 通过${failures === 0 ? '（全绿）' : `（${failures} 失败）`}\x1b[0m`)
process.exitCode = failures === 0 ? 0 : 1
