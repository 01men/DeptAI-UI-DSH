/** 回归：心跳定时器生命周期与只读员工的唤醒准入。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ExecutionHubService, registerExecTimers } from './index.ts'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('定时器启动后执行，插件释放后停止 #10', async () => {
  const ctx = new Context()
  let ticks = 0
  const fork = ctx.plugin({ name: 'exec-timer-test', apply(c) { registerExecTimers(c, () => { ticks++ }, () => {}, 15, 5) } })
  await pause(70)
  assert.ok(ticks >= 2, `应发生首次和周期 tick，实际 ${ticks}`)
  await fork.dispose()
  const stoppedAt = ticks
  await pause(50)
  assert.equal(ticks, stoppedAt)
})

function fixture(scopes, total = 0, wakePatch = {}) {
  const hub = Object.create(ExecutionHubService.prototype)
  const wake = { id: 'w', agentId: 'a', trigger: 'routine', triggerDetail: 'heartbeat:30m', ...wakePatch }
  const agent = { id: 'a', name: '评价官', status: 'online', attrs: { heartbeatIntervalMinutes: 30 } }
  let heartbeat, heartbeatDetail
  const collection = { get: () => wake, update: (_id, patch) => Object.assign(wake, patch) }
  hub.wakes = () => collection
  hub.issues = () => ({ get: () => wake.issueId ? { id: wake.issueId, title: '任务', status: 'todo' } : undefined })
  hub.agentOf = () => agent
  hub.isAgentFrozen = () => false
  hub.checkAgentBudget = () => ({ blocked: false })
  hub.agentScopes = () => scopes
  hub.collectTodos = () => ({ total })
  hub.recordHeartbeat = (_agent, outcome, detail) => { heartbeat = outcome; heartbeatDetail = detail }
  hub.createRun = () => { assert.fail('只读主体不得派发执行 run') }
  hub.auditSafe = () => {}
  Object.defineProperty(hub, 'ctx', { value: { platformBus: { emit() {} } }, configurable: true })
  return { hub, wake, getHeartbeat: () => heartbeat, getHeartbeatDetail: () => heartbeatDetail }
}

test('只读心跳无待办时正常结束；有待办时不得创建 run #7', () => {
  const empty = fixture(['exec.read'])
  assert.equal(empty.hub.processWake('w'), 'skipped')
  assert.equal(empty.wake.status, 'done')
  assert.equal(empty.getHeartbeat(), 'skipped_no_todo')
  const pending = fixture(['exec.read'], 1)
  assert.equal(pending.hub.processWake('w'), 'skipped')
  assert.equal(pending.wake.status, 'done')
  assert.equal(pending.getHeartbeat(), 'skipped_permission')
  assert.match(pending.getHeartbeatDetail(), /未派发/)
})

test('身份未纳管或任务派发仍须写权限 #7', () => {
  for (const item of [fixture(null), fixture(['exec.read'], 0, { issueId: 'i' })]) {
    assert.equal(item.hub.processWake('w'), 'failed')
    assert.equal(item.wake.status, 'failed')
  }
  const noTodos = fixture(['exec.read'], 0, { trigger: 'api' })
  assert.equal(noTodos.hub.processWake('w'), 'skipped')
  assert.equal(noTodos.wake.status, 'done')
})

test('权限拒绝记录不应使健康状态变绿 #7', () => {
  const hub = Object.create(ExecutionHubService.prototype)
  const agent = { id: 'a', name: '评价官', status: 'online', attrs: { heartbeatIntervalMinutes: 30 } }
  hub.heartbeats = () => ({ all: () => [{ agentId: 'a', outcome: 'skipped_permission', at: new Date().toISOString() }] })
  Object.defineProperty(hub, 'ctx', { value: { resourceCore: { list: () => [agent] }, agentRegistry: { usage: () => ({ all: () => [] }), isFrozen: () => false } } })
  assert.equal(hub.agentsHealth()[0].health, 'silent')
})
