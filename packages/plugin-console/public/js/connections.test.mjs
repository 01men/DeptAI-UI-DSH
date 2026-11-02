/**
 * 宿主服务连接管理纯函数自证（docs/frontend-host-switching.md 配套测试）。
 *
 * 运行方式（connections.js 零依赖纯 ESM，Node 直接加载）：
 *
 *     node packages/plugin-console/public/js/connections.test.mjs
 *
 * 覆盖面：地址规范化（协议/尾斜杠/挂载前缀/query-hash 拒绝）、清单增改删、
 * 活动连接决议（默认本机/远程/悬空回落）、删除活动连接的回落标记。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizeBase, loadConnections, saveConnections, upsertConnection, removeConnection,
  activeConnection, setActiveId, getActiveId, CONNECTIONS_KEY, ACTIVE_KEY, LOCAL_ID,
  loadPanels, savePanels, upsertPanel, removePanel, panelUrl, resolvePanels, PANELS_KEY,
} from './connections.js'

/** localStorage 形状的内存 stub（Node 无 localStorage）。 */
function storageStub() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    _store: store,
  }
}

test('normalizeBase：合法地址去尾斜杠、保留挂载前缀', () => {
  assert.deepEqual(normalizeBase('http://192.168.0.7:7300/'), { ok: true, base: 'http://192.168.0.7:7300' })
  assert.deepEqual(normalizeBase('  https://host.example:8801/rq/  '), { ok: true, base: 'https://host.example:8801/rq' })
  assert.equal(normalizeBase('http://localhost:7300').ok, true)
})

test('normalizeBase：缺协议/乱串/query/锚点/空值一律拒绝', () => {
  for (const bad of ['', '   ', '192.168.0.7:7300', 'ftp://x', 'http://h/a?x=1', 'http://h/a#frag', 'not a url']) {
    assert.equal(normalizeBase(bad).ok, false, `应拒绝：${bad}`)
  }
})

test('upsert：新增（名称留空回落主机名）、base 存前规范化', () => {
  const storage = storageStub()
  const first = upsertConnection(storage, { name: '', base: 'http://192.168.0.7:7300/' })
  assert.equal(first.ok, true)
  assert.equal(first.connection.name, '192.168.0.7:7300')
  assert.equal(first.connection.base, 'http://192.168.0.7:7300')
  assert.deepEqual(loadConnections(storage), [first.connection])
})

test('upsert：按 id 更新不新增；非法 base 返回错误且不落盘', () => {
  const storage = storageStub()
  const { connection } = upsertConnection(storage, { name: 'a', base: 'http://a:1' })
  const updated = upsertConnection(storage, { id: connection.id, name: 'b', base: 'http://b:2/rq' })
  assert.equal(updated.list.length, 1)
  assert.equal(updated.list[0].base, 'http://b:2/rq')
  const bad = upsertConnection(storage, { name: 'c', base: 'no-scheme' })
  assert.equal(bad.ok, false)
  assert.equal(loadConnections(storage).length, 1)
})

test('活动连接决议：默认本机（base=部署前缀）→ 切远程 → 悬空 id 回落本机', () => {
  const storage = storageStub()
  assert.equal(activeConnection(storage, '/rq').id, LOCAL_ID)
  assert.equal(activeConnection(storage, '/rq').base, '/rq')
  const { connection } = upsertConnection(storage, { name: '远端', base: 'http://192.168.0.7:7300' })
  setActiveId(storage, connection.id)
  assert.equal(getActiveId(storage), connection.id)
  const remote = activeConnection(storage, '/rq')
  assert.equal(remote.base, 'http://192.168.0.7:7300')
  // 悬空：活动 id 指向的连接被外部清掉 → 回落本机（不白屏）
  saveConnections(storage, [])
  assert.equal(activeConnection(storage, '/rq').id, LOCAL_ID)
})

test('setActiveId(LOCAL_ID) 清空偏好键；removeConnection 标记活动连接被删并回落', () => {
  const storage = storageStub()
  const { connection } = upsertConnection(storage, { name: 'x', base: 'http://x:1' })
  setActiveId(storage, connection.id)
  setActiveId(storage, LOCAL_ID)
  assert.equal(storage._store.has(ACTIVE_KEY), false)

  const other = upsertConnection(storage, { name: 'y', base: 'http://y:1' }).connection
  setActiveId(storage, connection.id)
  setActiveId(storage, other.id)
  const removed = removeConnection(storage, other.id)
  assert.equal(removed.removedActive, true)
  assert.equal(getActiveId(storage), '') // 已回落本机
})

test('removeConnection：删非活动连接不回落；损坏清单回落空数组', () => {
  const storage = storageStub()
  const a = upsertConnection(storage, { name: 'a', base: 'http://a:1' }).connection
  const b = upsertConnection(storage, { name: 'b', base: 'http://b:1' }).connection
  setActiveId(storage, a.id)
  const removed = removeConnection(storage, b.id)
  assert.equal(removed.removedActive, false)
  assert.equal(loadConnections(storage).length, 1)
  storage.setItem(CONNECTIONS_KEY, '{broken json')
  assert.deepEqual(loadConnections(storage), [])
  storage.setItem(CONNECTIONS_KEY, JSON.stringify(['not-an-object', 42]))
  assert.deepEqual(loadConnections(storage), [])
})

// ---------------------------------------------------------------------------
// 部门面板登记（2026-10-22）：面板 = 宿主 × 部门；未登记不产生入口
// ---------------------------------------------------------------------------

test('面板登记：本机登记生成 ?dept= 地址、名称缺省自动拼宿主名', () => {
  const storage = storageStub()
  const created = upsertPanel(storage, { dept: 'mfg', mountBase: '/rq' })
  assert.equal(created.ok, true)
  assert.equal(created.panel.connectionId, LOCAL_ID)
  assert.equal(created.panel.name, 'mfg @ 本机宿主服务')
  assert.equal(panelUrl(created.panel, storage, '/rq'), '/rq/panel/?dept=mfg')
})

test('面板登记：远程宿主拼完整地址；宿主不存在时拒绝并给出原因', () => {
  const storage = storageStub()
  const { connection } = upsertConnection(storage, { name: '参考机', base: 'http://192.168.0.7:7300' })
  const created = upsertPanel(storage, { dept: 'rd', connectionId: connection.id, name: '研发工作台', mountBase: '' })
  assert.equal(created.ok, true)
  assert.equal(panelUrl(created.panel, storage, ''), 'http://192.168.0.7:7300/panel/?dept=rd')
  const missing = upsertPanel(storage, { dept: 'rd', connectionId: 'conn-missing' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /宿主连接不存在/)
})

test('面板登记：同一宿主同一部门不可重复登记（重复返回既有条目）', () => {
  const storage = storageStub()
  const first = upsertPanel(storage, { dept: 'mfg', name: '制造部', mountBase: '' })
  const dup = upsertPanel(storage, { dept: 'mfg', name: '制造部二号', mountBase: '' })
  assert.equal(dup.ok, false)
  assert.match(dup.error, /已登记/)
  assert.equal(loadPanels(storage).length, 1)
  // 不同部门允许
  assert.equal(upsertPanel(storage, { dept: 'rd', mountBase: '' }).ok, true)
  assert.equal(loadPanels(storage).length, 2)
  assert.equal(first.panel.dept, 'mfg')
})

test('面板登记：空 dept 被拒；DELETE 后清单收缩；损坏存储回落空', () => {
  const storage = storageStub()
  assert.equal(upsertPanel(storage, { dept: '' }).ok, false)
  const created = upsertPanel(storage, { dept: 'fin', mountBase: '' }).panel
  removePanel(storage, created.id)
  assert.deepEqual(loadPanels(storage), [])
  storage.setItem(PANELS_KEY, '{oops')
  assert.deepEqual(loadPanels(storage), [])
  savePanels(storage, [{ id: 'x' }]) // 缺 dept 的脏数据被过滤
  assert.deepEqual(loadPanels(storage), [])
})

test('面板登记：dept 口径与服务端 DEPT_RE 一致（大写/连字符/数字一律拒，脏数据被滤）', () => {
  const storage = storageStub()
  for (const bad of ['RD', 'rd-team', 'rd_team', 'rd1', 'r', 'x'.repeat(13)]) {
    const result = upsertPanel(storage, { dept: bad, mountBase: '' })
    assert.equal(result.ok, false, `${bad} 不应登记成功`)
    assert.match(result.error, /小写字母/)
  }
  assert.equal(loadPanels(storage).length, 0)
  // 存量脏数据（旧版本无校验时写入）也要在读取时被滤掉，否则会生成必然 400 的入口
  savePanels(storage, [{ id: 'pnl-old', dept: 'RD', connectionId: LOCAL_ID, name: '旧登记', createdAt: 1 }])
  assert.deepEqual(loadPanels(storage), [])
})

test('面板登记：删除宿主连接时其面板登记一并清理（不留悬空入口）', () => {
  const storage = storageStub()
  const { connection } = upsertConnection(storage, { name: '临时宿主', base: 'http://temp:1' })
  upsertPanel(storage, { dept: 'mfg', connectionId: connection.id, mountBase: '' })
  upsertPanel(storage, { dept: 'rd', mountBase: '' })
  assert.equal(loadPanels(storage).length, 2)
  removeConnection(storage, connection.id)
  const left = loadPanels(storage)
  assert.equal(left.length, 1)
  assert.equal(left[0].connectionId, LOCAL_ID)
})

test('resolvePanels：标注当前宿主与不可用条目', () => {
  const storage = storageStub()
  const { connection } = upsertConnection(storage, { name: '远端', base: 'http://remote:1' })
  upsertPanel(storage, { dept: 'mfg', mountBase: '/rq' })
  const remote = upsertPanel(storage, { dept: 'rd', connectionId: connection.id, mountBase: '/rq' }).panel
  const resolved = resolvePanels(storage, '/rq')
  const local = resolved.find((item) => item.dept === 'mfg')
  const other = resolved.find((item) => item.dept === 'rd')
  assert.equal(local.isActiveHost, true)
  assert.equal(other.isActiveHost, false)
  assert.equal(local.available, true)
  assert.equal(other.available, true)
  // 宿主被绕过 removeConnection 直接删掉（模拟脏数据）→ 条目不可用而非静默给出坏地址
  saveConnections(storage, [])
  const orphan = resolvePanels(storage, '/rq').find((item) => item.id === remote.id)
  assert.equal(orphan.available, false)
  assert.equal(orphan.hostName, '（宿主已删除）')
})
