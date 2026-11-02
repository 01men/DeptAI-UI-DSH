/**
 * QA 复测工具箱：REST / JSON-RPC / UHP / SSE 断言辅助。
 * 每个测试组从 group-<g>.json 读取 base + adminToken，用 createKit() 建客户端。
 *
 * 用法：
 *   import { createKit, readGroup } from './kit.mjs'
 *   const g = readGroup('A'); const kit = createKit(g.base, g.adminToken)
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME = dirname(fileURLToPath(import.meta.url))

export function readGroup(group) {
  return JSON.parse(readFileSync(join(RUNTIME, `group-${group}.json`), 'utf8'))
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createKit(base, initialToken) {
  let defaultToken = initialToken
  const api = async (method, path, { token = defaultToken, body, headers } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let payload = null
    try { payload = await res.json() } catch { /* ignore */ }
    return { status: res.status, ok: payload?.ok ?? false, data: payload?.data, error: payload?.error, payload }
  }

  const raw = async (method, path, { token, body, headers } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* ignore */ }
    return { status: res.status, json, text, headers: res.headers }
  }

  /** JSON-RPC 主端点：解包平台信封 {ok,data:{jsonrpc,result|error}} */
  const rpc = async (slug, token, body) => {
    const res = await raw('POST', `/api/agents/${encodeURIComponent(slug)}/a2a`, {
      token,
      body: { jsonrpc: '2.0', id: 1, ...body },
    })
    const inner = res.json?.data && res.json.data.jsonrpc ? res.json.data : res.json
    return {
      status: res.status,
      result: inner?.result,
      error: inner?.error ?? (res.json?.ok === false ? res.json.error : undefined),
      raw: res.json,
    }
  }

  const login = async (username, password = 'Ybk@2026') => {
    const res = await api('POST', '/api/auth/login', { body: { username, password } })
    return { ...res, token: res.data?.token, identity: res.data }
  }

  const createPrincipal = async (name, refType, scopes, refId) => {
    const created = await api('POST', '/api/authn/principals', { body: { name, refType, scopes, ...(refId ? { refId } : {}) } })
    if (!created.ok) return { ok: false, error: created.error, raw: created.payload }
    const cc = await api('POST', '/api/auth/client-credentials', { body: { clientId: created.data.clientId, clientSecret: created.data.clientSecret } })
    return { ok: Boolean(cc.data?.token), principal: created.data, token: cc.data?.token, error: cc.error }
  }

  const createAgent = async (body) => {
    const res = await api('POST', '/api/agents', { body })
    return { ...res, agent: res.data?.agent }
  }

  /** 走真实审批链上线（submit_trial → online → 审批人 approve） */
  const onlineAgent = async (agentId, opts = {}) => {
    const trial = await api('POST', `/api/agents/${agentId}/transition`, { body: { action: 'submit_trial' } })
    if (!trial.ok) return { ok: false, step: 'submit_trial', error: trial.error }
    const onlineReq = await api('POST', `/api/agents/${agentId}/transition`, { body: { action: 'online', note: opts.note ?? 'QA 上线' } })
    if (!onlineReq.ok) return { ok: false, step: 'online', error: onlineReq.error }
    const approvalId = onlineReq.data?.approval?.id
    if (!approvalId) return { ok: false, step: 'approval', error: 'missing approval id' }
    const approver = opts.approverToken
    const decided = await api('POST', `/api/approvals/${approvalId}/decide`, {
      token: approver,
      body: { decision: 'approve', opinion: opts.opinion ?? 'QA 异人审批', confirmed: true, finalReview: true },
    })
    return { ok: decided.ok, step: 'decide', approvalId, data: decided.data, error: decided.error }
  }

  const patchAgent = async (agentId, attrs) => api('PATCH', `/api/agents/${agentId}`, { body: { attrs } })

  const getTask = async (slug, token, taskId) => (await rpc(slug, token, { method: 'tasks/get', params: { taskId } })).result?.task

  const waitTask = async (slug, token, taskId, states, timeoutMs = 8000) => {
    const wanted = new Set(states)
    const started = Date.now()
    let last = null
    while (Date.now() - started < timeoutMs) {
      last = await getTask(slug, token, taskId)
      if (last && wanted.has(last.state)) return last
      await sleep(120)
    }
    return last
  }

  const uhp = async (method, path, { token, body, headers } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* ignore */ }
    return { status: res.status, json, text, headers: res.headers }
  }

  const setStubMode = async (stubBase, mode) => {
    const res = await fetch(`${stubBase}/__mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })
    return res.json()
  }
  const stubStats = async (stubBase) => (await fetch(`${stubBase}/__stats`)).json()
  const resetStub = async (stubBase) => (await fetch(`${stubBase}/__reset`, { method: 'POST' })).json()

  return {
    base,
    get adminToken() { return defaultToken },
    setToken(token) { defaultToken = token },
    api, raw, rpc, login, createPrincipal, createAgent, onlineAgent, patchAgent, getTask, waitTask, uhp, setStubMode, stubStats, resetStub,
  }
}

/** 简易断言器：记录通过/失败，末尾输出 JSON 摘要。 */
export function createAsserts(group) {
  const rows = []
  const check = (name, condition, detail = '') => {
    const pass = Boolean(condition)
    rows.push({ group, name, pass, detail: pass ? '' : String(detail).slice(0, 800) })
    console.log(`  ${pass ? '✔' : '✘'} ${name}${pass ? '' : `  ← ${detail}`}`)
    return pass
  }
  const summary = () => ({
    group,
    total: rows.length,
    passed: rows.filter((r) => r.pass).length,
    failed: rows.filter((r) => !r.pass).length,
    failures: rows.filter((r) => !r.pass),
    rows,
  })
  return { check, summary, rows }
}