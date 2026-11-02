/**
 * 全链 trace 基元（MCP 治理契约 §14，W3-T5）。
 *
 * 平台侧最小的 W3C Trace Context 子集：
 *   - newTraceId()：32 位小写 hex 的 trace id（128-bit，随机生成，非全零）；
 *   - parseTraceparent / formatTraceparent：`{version}-{trace-id}-{parent-id}-{trace-flags}`
 *     四段格式的解析与序列化（version=00 口径；非法输入解析返回 null、序列化抛错）。
 *
 * 消费面：plugin-mcp invoke 入口无 trace 即生成（调用方可经 InvokeCaller.traceId /
 * X-Trace-Id / mcp-session-id 头透传），下游 HTTP 转发带 traceparent 头，
 * usage/调用记录/审计事件按 traceId 关联还原调用链。
 */
import { randomBytes } from 'node:crypto'

const TRACEPARENT_VERSION = '00'
const TRACE_ID_RE = /^[0-9a-f]{32}$/
const PARENT_ID_RE = /^[0-9a-f]{16}$/
const FLAGS_RE = /^[0-9a-f]{2}$/

/** 生成 32 位 hex trace id（128-bit 随机，全零概率忽略；防御性重抽一次）。 */
export function newTraceId(): string {
  const id = randomBytes(16).toString('hex')
  return id === '0'.repeat(32) ? randomBytes(16).toString('hex') : id
}

/** 解析后的 traceparent 结构（W3C Trace Context version 00）。 */
export interface Traceparent {
  version: string
  /** 32 位 hex trace id。 */
  traceId: string
  /** 16 位 hex parent span id。 */
  parentId: string
  /** 2 位 hex trace flags。 */
  flags: string
}

/**
 * 解析 traceparent 头（W3C 口径，version=00）：
 *   - 四段、段数不符 / 含空白变体 → null；
 *   - version 必须为 '00'（本平台仅产出/接收 00；'ff' 按规范禁止，其余版本不识别）；
 *   - trace-id 32 hex 且非全零、parent-id 16 hex 且非全零、flags 2 hex；
 *   - 任何不合法一律 null（调用方回落生成新 trace，绝不带病透传）。
 */
export function parseTraceparent(header: string): Traceparent | null {
  if (typeof header !== 'string') return null
  const parts = header.split('-')
  if (parts.length !== 4) return null
  const [version, traceId, parentId, flags] = parts
  if (version !== TRACEPARENT_VERSION) return null
  if (!TRACE_ID_RE.test(traceId) || /^0+$/.test(traceId)) return null
  if (!PARENT_ID_RE.test(parentId) || /^0+$/.test(parentId)) return null
  if (!FLAGS_RE.test(flags)) return null
  return { version, traceId, parentId, flags }
}

/**
 * 序列化 traceparent 头：version 恒 '00'；parentId 缺省随机生成（网关发起的新 span）；
 * flags 缺省 '01'（sampled）。traceId/parentId 非法（形态或全零）抛错——构造面错误
 * 必须显式暴露，不允许降级成坏头外发。
 */
export function formatTraceparent(traceId: string, parentId?: string, flags = '01'): string {
  if (!TRACE_ID_RE.test(traceId) || /^0+$/.test(traceId)) {
    throw new Error(`非法 traceId（须为 32 位非全零 hex）：${traceId}`)
  }
  const parent = parentId ?? randomBytes(8).toString('hex')
  if (!PARENT_ID_RE.test(parent) || /^0+$/.test(parent)) {
    throw new Error(`非法 parentId（须为 16 位非全零 hex）：${parent}`)
  }
  if (!FLAGS_RE.test(flags)) {
    throw new Error(`非法 trace flags（须为 2 位 hex）：${flags}`)
  }
  return `${TRACEPARENT_VERSION}-${traceId}-${parent}-${flags}`
}
