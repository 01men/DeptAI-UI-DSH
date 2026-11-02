/**
 * 01门面板入口探针自证（2026-11-01 demo.ybkkasi.com 01门装态部署配套）。
 *
 * 运行方式（gate01-entry.js 零裸 fetch / 零顶层 DOM 访问，baseURI+fetch 可注入，Node 直接加载）：
 *
 *     node packages/plugin-console/public/js/gate01-entry.test.mjs
 *
 * 覆盖面：挂载判定（ok JSON → 面板地址）、前缀推导（根部署 / dsh /rq 挂载）、
 * 不出死链的判定面（404 / SPA HTML 兜底 / 非 ok 信封 / mode 缺失 / 网络异常一律 null）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { probeGate01PanelWith } from './gate01-entry.js'

/** fetch 假体：按序返回预置响应或抛错。 */
function fakeFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (typeof next === 'number') return { ok: next === 200, status: next, headers: { get: () => 'application/json' }, json: async () => ({ ok: false }) }
    if (next instanceof Error) throw next
    return next
  }
  impl.calls = calls
  return impl
}

const okJson = (mode = 'remote') => ({
  ok: true,
  status: 200,
  headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
  json: async () => ({ ok: true, data: { mode } }),
})

const spaHtml = {
  ok: true,
  status: 200,
  headers: { get: (k) => (k === 'content-type' ? 'text/html; charset=utf-8' : null) },
  json: async () => { throw new Error('not json') },
}

test('挂载判定：ok JSON（remote）→ 返回面板地址；本地形态（local）同样露入口', async () => {
  const fetchImpl = fakeFetch([okJson('remote'), okJson('local')])
  const root = 'https://demo.example/'
  assert.equal(await probeGate01PanelWith({ baseURI: root, fetchImpl }), '/gate01-go.html')
  assert.equal(await probeGate01PanelWith({ baseURI: root, fetchImpl }), '/gate01-go.html')
  assert.equal(fetchImpl.calls[0].url, '/gate01/rqcard/link')
  assert.equal(fetchImpl.calls[0].init.headers['x-rqcard-call'], '1')
})

test('前缀推导：dsh 全量挂载形态 /rq/ → /rq/gate01/panel/', async () => {
  const fetchImpl = fakeFetch([okJson('remote')])
  const mounted = 'https://host.example/rq/'
  assert.equal(await probeGate01PanelWith({ baseURI: mounted, fetchImpl }), '/rq/gate01-go.html')
  assert.equal(fetchImpl.calls[0].url, '/rq/gate01/rqcard/link')
})

test('不出死链：404 / SPA HTML 兜底 / 非 ok 信封 / mode 缺失 / 网络异常 → 一律 null', async () => {
  const baseURI = 'https://demo.example/'
  const notOkJson = { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, error: { code: 'X' } }) }
  const noMode = { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, data: {} }) }
  for (const response of [404, spaHtml, notOkJson, noMode, new Error('network down')]) {
    const fetchImpl = fakeFetch([response])
    assert.equal(await probeGate01PanelWith({ baseURI, fetchImpl }), null, JSON.stringify(response.status ?? 'throw'))
  }
})
