#!/usr/bin/env node
/**
 * QA 复测环境脚手架：为每个测试组拉起完全隔离的实例（独立端口 + 独立数据目录 + 独立模型 stub）。
 *
 * 用法：node qa-runtime-20261021/setup-group.mjs <group> <instancePort> <stubPort>
 * 输出：qa-runtime-20261021/group-<group>.json（base / stub / 账号令牌 / 夹具清单）
 *
 * 设计约束：
 * - 数据目录从 fixture-template 复制，测试组之间零共享（互不污染）
 * - 所有模型 endpoint 指向本组 stub，stub 支持行为切换（accept/counter/slow/error）
 * - 不修改产品源码；进程与脚本全部落在 qa-runtime-20261021/
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, rm, writeFile, open } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [group, instancePortRaw, stubPortRaw] = process.argv.slice(2)
if (!group || !instancePortRaw || !stubPortRaw) {
  console.error('用法：setup-group.mjs <group> <instancePort> <stubPort>')
  process.exit(1)
}
const instancePort = Number(instancePortRaw)
const stubPort = Number(stubPortRaw)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = join(ROOT, 'qa-runtime-20261021')
const TEMPLATE = join(RUNTIME, 'fixture-template')
const DATA = join(ROOT, `data-qa-g${group}-20261021`)
const BASE = `http://127.0.0.1:${instancePort}`
const STUB = `http://127.0.0.1:${stubPort}`

const logPath = join(RUNTIME, `group-${group}.log`)
const outPath = join(RUNTIME, `group-${group}.json`)

async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let payload = null
  try { payload = await res.json() } catch { /* ignore */ }
  return { status: res.status, payload }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHealthy() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch { /* retry */ }
    await sleep(400)
  }
  return false
}

async function main() {
  if (!existsSync(TEMPLATE)) {
    await cp(join(ROOT, 'data-qa-20261020'), TEMPLATE, { recursive: true })
  }
  await rm(DATA, { recursive: true, force: true })
  await mkdir(DATA, { recursive: true })
  await cp(TEMPLATE, DATA, { recursive: true })

  const out = await open(logPath, 'a')
  const stub = spawn(process.execPath, [join(RUNTIME, 'model-stub.mjs')], {
    env: { ...process.env, STUB_PORT: String(stubPort) },
    stdio: ['ignore', out.fd, out.fd],
    detached: true,
  })
  stub.unref()

  const server = spawn(process.execPath, [join(ROOT, 'src/main.ts'), '--port', String(instancePort), '--data', DATA], {
    env: {
      ...process.env,
      A2A_SYNC_WAIT_MS: process.env.A2A_SYNC_WAIT_MS ?? '1000',
      A2A_PATROL_INTERVAL_MINUTES: '0',
    },
    cwd: ROOT,
    stdio: ['ignore', out.fd, out.fd],
    detached: true,
  })
  server.unref()
  await out.close()

  if (!(await waitHealthy())) {
    console.error(`实例未启动，见 ${logPath}`)
    process.exit(1)
  }

  const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
  const admin = login.payload?.data?.token
  if (!admin) {
    console.error('admin 登录失败', JSON.stringify(login.payload).slice(0, 300))
    process.exit(1)
  }

  // 把全部模型指到本组 stub（避免组间共享模型行为）
  const models = await api('GET', '/api/modelgw/models', { token: admin })
  const modelRows = models.payload?.data?.models ?? models.payload?.data ?? []
  for (const model of Array.isArray(modelRows) ? modelRows : []) {
    await api('POST', '/api/modelgw/models', {
      token: admin,
      body: { slug: model.slug, displayName: model.displayName, provider: model.provider, endpoint: `${STUB}/v1`, apiKey: 'stub-key', costCentsPerKTokens: 0, status: 'online' },
    })
  }

  const accounts = {}
  for (const username of ['admin', 'qa-ops', 'qa-approver', 'qa-collab', 'qa-acceptor', 'qa-a2aadmin', 'qa-member', 'qa-ro', 'qa-outsider']) {
    const res = await api('POST', '/api/auth/login', { body: { username, password: 'Ybk@2026' } })
    if (res.payload?.ok) accounts[username] = { token: res.payload.data.token, user: res.payload.data.user, role: res.payload.data.role, permissions: res.payload.data.permissions }
  }

  const agents = await api('GET', '/api/agents', { token: admin })
  const agentRows = agents.payload?.data?.agents ?? []
  const harnesses = await api('GET', '/api/uhp/harnesses', { token: admin })

  const result = {
    group,
    base: BASE,
    stub: STUB,
    dataDir: DATA,
    log: logPath,
    adminToken: admin,
    accounts,
    agents: agentRows.map((a) => ({ id: a.id, slug: a.slug, name: a.name, status: a.status, attrs: a.attrs })),
    harnesses: harnesses.payload?.data?.harnesses ?? [],
  }
  await writeFile(outPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: true, base: BASE, stub: STUB, out: outPath, accounts: Object.keys(accounts), agents: result.agents.map((a) => `${a.slug}:${a.status}:${a.attrs?.autonomy ?? '-'}`) }, null, 2))
}

await main()