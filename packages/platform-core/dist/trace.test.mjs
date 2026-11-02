/**
 * 全链 trace 基元单元测试（W3-T5，MCP 治理契约 §14）。
 *
 * 运行方式：node --test packages/platform-core/src/trace.test.mjs
 *
 * 覆盖面：newTraceId 形态（32hex、非全零、随机）/ traceparent 往返（format → parse）/
 * 非法输入（段数/版本/全零/非法 hex/类型）一律 null 或显式抛错。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newTraceId, parseTraceparent, formatTraceparent } from './index.ts'

test('newTraceId：32 位小写 hex、非全零、连续生成互不相同', () => {
  const seen = new Set()
  for (let i = 0; i < 64; i++) {
    const id = newTraceId()
    assert.match(id, /^[0-9a-f]{32}$/)
    assert.notEqual(id, '0'.repeat(32))
    seen.add(id)
  }
  assert.equal(seen.size, 64, '128-bit 随机不应碰撞')
})

test('traceparent 往返：format → parse 还原一致（显式 parentId / flags）', () => {
  const traceId = newTraceId()
  const header = formatTraceparent(traceId, '0123456789abcdef', '01')
  assert.equal(header, `00-${traceId}-0123456789abcdef-01`)
  const parsed = parseTraceparent(header)
  assert.ok(parsed)
  assert.equal(parsed.version, '00')
  assert.equal(parsed.traceId, traceId)
  assert.equal(parsed.parentId, '0123456789abcdef')
  assert.equal(parsed.flags, '01')
})

test('traceparent 往返：parentId/flags 缺省生成且可解析（parent 16hex、flags 01）', () => {
  const parsed = parseTraceparent(formatTraceparent(newTraceId()))
  assert.ok(parsed)
  assert.match(parsed.parentId, /^[0-9a-f]{16}$/)
  assert.equal(parsed.flags, '01')
})

test('parseTraceparent 非法输入一律 null（不抛错、不带病透传）', () => {
  assert.equal(parseTraceparent(''), null)
  assert.equal(parseTraceparent('not-a-traceparent'), null)
  assert.equal(parseTraceparent('00-_only-three-segments-01'), null)
  assert.equal(parseTraceparent('00-xxx-zzz-01'), null, '非 hex 段拒绝')
  assert.equal(parseTraceparent(`00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`), null, '全零 trace-id 拒绝')
  assert.equal(parseTraceparent(`00-${newTraceId()}-${'0'.repeat(16)}-01`), null, '全零 parent-id 拒绝')
  assert.equal(parseTraceparent(`ff-${newTraceId()}-${'1'.repeat(16)}-01`), null, 'version ff 按规范拒绝')
  assert.equal(parseTraceparent(`00-${newTraceId()}-${'1'.repeat(16)}-zz`), null, '非法 flags 拒绝')
  assert.equal(parseTraceparent(` 00-${newTraceId()}-${'1'.repeat(16)}-01 `), null, '含空白变体拒绝')
  assert.equal(parseTraceparent(undefined), null)
  assert.equal(parseTraceparent(null), null)
})

test('formatTraceparent 非法输入显式抛错（构造面错误不降级成坏头外发）', () => {
  assert.throws(() => formatTraceparent('short'), /traceId/)
  assert.throws(() => formatTraceparent('0'.repeat(32)), /traceId/)
  assert.throws(() => formatTraceparent(newTraceId().toUpperCase().slice(0, 31) + 'g'), /traceId/)
  assert.throws(() => formatTraceparent(newTraceId(), 'bad-parent'), /parentId/)
  assert.throws(() => formatTraceparent(newTraceId(), '0'.repeat(16)), /parentId/)
  assert.throws(() => formatTraceparent(newTraceId(), undefined, 'xyz'), /flags/)
})
