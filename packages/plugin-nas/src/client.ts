/**
 * NasMcpClient —— MCP Streamable HTTP 客户端（NAS 文件网关专用轻量实现）。
 *
 * 与 plugin-mcp 的传输层同构（不跨插件引用私有方法，保持插件自包含）：
 * 单 POST JSON-RPC，兼容纯 JSON 与 SSE（text/event-stream 取首个 data 帧）两种响应；
 * initialize 握手缓存 mcp-session-id（TTL 5 分钟，无状态服务缓存空串避免重复握手）；
 * AbortController 超时控制。
 */
import { t } from '../../platform-i18n/src/index.ts'

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

const PROBE_TIMEOUT_MS = 5_000
const CALL_TIMEOUT_MS = 20_000
const SESSION_TTL_MS = 5 * 60_000

export class NasMcpClient {
  private sessionId: string | undefined
  private sessionExpiresAt = 0
  private readonly endpoint: string
  private readonly headers: Record<string, string>

  constructor(endpoint: string, headers: Record<string, string> = {}) {
    this.endpoint = endpoint
    this.headers = headers
  }

  /** initialize 探活：返回服务端信息；不可达抛错。 */
  async probe(): Promise<{ serverInfo?: { name?: string; version?: string } }> {
    const { payload } = await this.request({
      jsonrpc: '2.0',
      id: `nas-probe-${Date.now()}`,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-nas-gateway', version: '1.0' } },
    }, PROBE_TIMEOUT_MS)
    if (payload?.error) throw new Error(t('网关 initialize 失败：{reason}', { reason: payload.error.message ?? t('未知错误') }))
    return { serverInfo: payload?.result?.serverInfo }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const sessionId = await this.ensureSession()
    const { payload } = await this.request({
      jsonrpc: '2.0',
      id: `nas-tools-${Date.now()}`,
      method: 'tools/list',
      params: {},
    }, PROBE_TIMEOUT_MS, sessionId)
    if (payload?.error) throw new Error(t('网关 tools/list 失败：{reason}', { reason: payload.error.message ?? t('未知错误') }))
    return Array.isArray(payload?.result?.tools) ? payload.result.tools : []
  }

  /** tools/call：返回 MCP content（文本块/数组或原样对象）；isError 时抛错。
   *  options.headers 支持逐调用附加头（X-On-Behalf-User 透传真实用户身份，dev-plan-nas-authz §2.4）。 */
  async call(tool: string, args: Record<string, unknown> = {}, options?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<unknown> {
    const timeoutMs = options?.timeoutMs ?? CALL_TIMEOUT_MS
    const sessionId = await this.ensureSession().catch(() => undefined)
    const send = (sid?: string) => this.request({
      jsonrpc: '2.0',
      id: `nas-${Date.now()}`,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }, timeoutMs, sid, options?.headers)
    let { payload } = await send(sessionId)
    if (payload?.error && sessionId && /session|initialized/i.test(String(payload.error.message ?? ''))) {
      this.sessionId = undefined
      const renewed = await this.ensureSession().catch(() => undefined)
      ;({ payload } = await send(renewed))
    }
    if (payload?.error) throw new Error(t('网关返回错误：{reason}', { reason: payload.error.message ?? JSON.stringify(payload.error).slice(0, 200) }))
    const result = payload?.result
    if (result?.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((block: any) => block?.text ?? '').join(' ')
        : String(result.content ?? '')
      throw new Error(t('网关工具 {tool} 执行失败：{reason}', { tool, reason: text || 'isError=true' }))
    }
    if (Array.isArray(result?.content)) {
      // 单一文本块直接返回文本，多块返回数组（调用方按需 JSON.parse）
      const blocks = result.content as Array<Record<string, unknown>>
      return blocks.length === 1 && typeof blocks[0]?.text === 'string' ? blocks[0].text : blocks
    }
    return result?.content ?? result ?? null
  }

  private async ensureSession(): Promise<string | undefined> {
    if (this.sessionId !== undefined && this.sessionExpiresAt > Date.now()) return this.sessionId || undefined
    const { payload, sessionId } = await this.request({
      jsonrpc: '2.0',
      id: `nas-init-${Date.now()}`,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-nas-gateway', version: '1.0' } },
    }, PROBE_TIMEOUT_MS)
    if (payload?.error) throw new Error(t('网关 initialize 失败：{reason}', { reason: payload.error.message ?? t('未知错误') }))
    const effective = sessionId ?? ''
    this.sessionId = effective
    this.sessionExpiresAt = Date.now() + SESSION_TTL_MS
    if (effective) {
      await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' }, PROBE_TIMEOUT_MS, effective).catch(() => undefined)
    }
    return effective || undefined
  }

  private async request(message: Record<string, unknown>, timeoutMs: number, sessionId?: string, extraHeaders?: Record<string, string>): Promise<{ payload: any; sessionId?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...this.headers,
          ...extraHeaders,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(t('网关 HTTP {status}：{body}', { status: response.status, body: (await response.text().catch(() => '')).slice(0, 200) }))
      }
      const sessionIdHeader = response.headers.get('mcp-session-id') ?? undefined
      const contentType = String(response.headers.get('content-type') ?? '')
      const text = await response.text()
      if (contentType.includes('text/event-stream')) {
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue
          const frame = line.slice(5).trim()
          if (!frame || frame === '[DONE]') continue
          try { return { payload: JSON.parse(frame), sessionId: sessionIdHeader } } catch { /* 跳过非 JSON 帧 */ }
        }
        throw new Error(t('网关 SSE 响应中未找到 JSON-RPC 帧'))
      }
      if (!text) return { payload: null, sessionId: sessionIdHeader }
      try {
        return { payload: JSON.parse(text), sessionId: sessionIdHeader }
      } catch {
        throw new Error(t('网关响应不是合法 JSON：{body}', { body: text.slice(0, 200) }))
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error(t('网关请求超时（{timeout}ms）', { timeout: timeoutMs }))
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
