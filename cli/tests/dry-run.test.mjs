import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../dshctl.mjs', import.meta.url))

test('dry-run refuses unsupported mutations while allowing explicit previews', async (t) => {
  const requests = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined })
    res.setHeader('content-type', 'application/json')
    let data = { id: 'test', name: 'test', releasedGroups: [] }
    if (req.url === '/api/auth/login') data = { token: 'test-token' }
    if (req.url === '/api/iam/orgs/tree') data = []
    if (req.url.endsWith('/deploy')) data = { impact: [] }
    if (req.url === '/api/connector/execute') data = { status: 'preview' }
    if (req.url === '/api/update/apply') data = { steps: [] }
    res.end(JSON.stringify({ ok: true, data }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const temp = await mkdtemp(path.join(tmpdir(), 'dshctl-dry-run-'))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(temp, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.address().port}`
  const run = (args, credentials = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: temp,
      env: { ...process.env, DSHCTL_URL: url, DSHCTL_TOKEN: 'test-token', ...credentials },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })

  for (const args of [
    ['org', 'create', '--name=test', '--dry-run'],
    ['--dry-run=true', 'org', 'create', '--name=test'],
    ['connector', 'connections', 'delete', 'test', '--yes', '--dry-run'],
    ['connector', 'connections', 'delete', 'test', '--dry-run'],
  ]) {
    const before = requests.length
    const result = await run(args)
    assert.notEqual(result.code, 0, result.output)
    assert.equal(requests.length, before, `${args.join(' ')} must not send a request`)
  }

  const pluginDir = path.join(temp, 'plugin')
  const plugin = await run(['plugin', 'init', '--id=com.example.demo', `--dir=${pluginDir}`, '--dry-run'])
  assert.notEqual(plugin.code, 0)
  await assert.rejects(access(pluginDir), { code: 'ENOENT' })

  const loginStart = requests.length
  const login = await run(['org', 'create', '--name=test', '--dry-run'], {
    DSHCTL_TOKEN: '', DSHCTL_USER: 'test', DSHCTL_PASS: 'test',
  })
  assert.notEqual(login.code, 0)
  assert.deepEqual(requests.slice(loginStart).map((r) => r.path), ['/api/auth/login'])

  const read = await run(['org', 'list', '--dry-run'])
  assert.equal(read.code, 0, read.output)
  assert.equal(requests.at(-1).path, '/api/iam/orgs/tree')

  for (const [args, expectedPath] of [
    [['mcp', 'deploy', 'test', '--dry-run'], '/api/mcp/services/test/deploy'],
    [['connector', 'execute', '--action=test', '--dry-run'], '/api/connector/execute'],
    [['update', 'apply', '--dry-run'], '/api/update/apply'],
  ]) {
    const result = await run(args)
    assert.equal(result.code, 0, result.output)
    assert.equal(requests.at(-1).path, expectedPath)
    assert.equal(requests.at(-1).body.dryRun, true)
  }

  const real = await run(['--dry-run=false', 'org', 'create', '--name=test'])
  assert.equal(real.code, 0, real.output)
  assert.equal(requests.at(-1).path, '/api/iam/orgs')
})
