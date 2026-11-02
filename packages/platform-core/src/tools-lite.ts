/**
 * ToolRuntime-lite：dsh ToolRuntime 的独立宿主实现（服务键与 dsh 相同：`tools`）。
 *
 * - 注册契约对齐 dsh：ToolDefinition = { name, description, parameters(JSON Schema),
 *   output: { schema, render }, execute(args, exec) }，注册时校验 output 声明。
 * - execute() 冻结参数快照、运行 guard 链、校验规范值、经 render 产出内容块。
 * - 在完整 dsh 运行时中，本服务不加载（provideToolRuntime=false），
 *   同一批插件定义直接注册到真正的 ToolRuntime，模型即可调用。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

export interface ContentBlock {
  type: 'text'
  text: string
}

/** 调用者身份（由入口从令牌解析后注入，工具内禁止从 args 读取身份）。 */
export interface ToolPrincipal {
  kind: 'human' | 'machine'
  principalId: string
  userId?: string
  /** D01（additive）：machine 专属——凭证关联资源类型（refType=agent 时可反查数字员工绑定）。 */
  refType?: string
  /** D01（additive）：machine 专属——凭证关联资源 ID。 */
  refId?: string
  name: string
  permissions: string[]
  actChain?: Array<{ name: string; type: string }>
}

export interface ToolRunContext {
  callId: string
  name: string
  signal: AbortSignal
  agent?: unknown
  token?: symbol
  /** 调用者身份；身份类工具在缺失时应 fail-closed 而非降级到共享身份。 */
  principal?: ToolPrincipal
}

export interface ToolDefinitionLite {
  name: string
  description: string
  /** JSON Schema（object 根），与 dsh 原生注册的 parameters 字段一致。 */
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => ContentBlock[]
  }
  execute: (args: any, exec: ToolRunContext) => Promise<unknown>
  timeoutMs?: number
  /** 来源插件名（本运行时登记用）。 */
  plugin?: string
  /** 调用所需的最小权限点（RBAC）。缺省视为无需额外权限（仅登录）。 */
  permission?: string
}

export interface ToolExecutionResultLite {
  isError: boolean
  value?: unknown
  content: ContentBlock[]
  error?: { message: string }
  callId: string
  name: string
  durationMs: number
}

export type ToolGuardLite = (input: { name: string; arguments: unknown }) => string | undefined

/**
 * 上下文型 guard（D02/D03 additive）：在旧 ToolGuardLite 之后运行，额外获得
 * 调用者身份（principal）与 callId——入口/网关继续负责权限与策略，guard 链由此
 * 获得身份可见性（缺身份 fail-closed 的工具可在此统一拦截）。旧 ToolGuardLite 不动。
 * 返回字符串＝拒绝原因；返回 undefined＝放行。
 */
export type ContextualToolGuard = (input: { name: string; arguments: unknown; principal?: ToolPrincipal; callId: string }) => string | undefined

/** 注册级拦截器（OPT-P1-03 正式扩展点）：所有 register 调用先过拦截链，返回（可替换的）定义。 */
export type ToolInterceptor = (definition: ToolDefinitionLite) => ToolDefinitionLite

export class ToolRuntimeLite extends Service {
  static readonly provide = 'tools'

  private definitions = new Map<string, ToolDefinitionLite>()
  private guards: ToolGuardLite[] = []
  private contextualGuards: ContextualToolGuard[] = []
  private interceptors: ToolInterceptor[] = []

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(definition: ToolDefinitionLite): () => void {
    for (const fn of this.interceptors) definition = fn(definition)
    const { name, output } = definition
    if (typeof name !== 'string' || !name) throw new TypeError(`[tools] 工具名必须是非空字符串`)
    if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
      throw new TypeError(`工具 "${name}" 必须声明 output { schema, render }`)
    }
    // OPT-P2-04：schema 强校验——契约强度对齐原报告叙述（此前只查 render 不查 schema）
    if (output.schema === undefined || output.schema === null || typeof output.schema !== 'object' || Array.isArray(output.schema)) {
      throw new TypeError(`工具 "${name}" 必须声明 output.schema（非空对象根，JSON Schema）`)
    }
    if (this.definitions.has(name)) throw new Error(`[tools] 工具名重复：${name}`)
    this.definitions.set(name, definition)
    try {
      this.ctx.platformBus?.emit('tools/change', { kind: 'register', name })
    } catch {
      // platformBus 未注入当前 fiber 时跳过通知（cordis 严格服务访问）
    }
    return () => {
      this.definitions.delete(name)
    }
  }

  guard(guard: ToolGuardLite): () => void {
    this.guards.push(guard)
    return () => {
      const index = this.guards.indexOf(guard)
      if (index >= 0) this.guards.splice(index, 1)
    }
  }

  /**
   * 上下文型 guard 注册器（D02/D03 additive）：注册的 guard 在旧 guard 链全部通过后
   * 运行，按注册顺序执行并注入 principal/callId。任一返回拒绝原因即短路（与旧 guard
   * 同款失败形态：isError + 中文拒绝文案）。返回注销函数。
   */
  guardContext(guard: ContextualToolGuard): () => void {
    if (typeof guard !== 'function') throw new TypeError('[tools] guardContext 的 guard 必须是函数')
    this.contextualGuards.push(guard)
    return () => {
      const index = this.contextualGuards.indexOf(guard)
      if (index >= 0) this.contextualGuards.splice(index, 1)
    }
  }

  /**
   * 注册级拦截器（OPT-P1-03 正式扩展点）：此后所有 register 先经拦截链再入表。
   * 供 connect 远程转发等横切能力挂在契约上，取代原型猴补丁。返回注销函数。
   */
  intercept(fn: ToolInterceptor): () => void {
    if (typeof fn !== 'function') throw new TypeError('[tools] intercept 的拦截器必须是函数')
    this.interceptors.push(fn)
    return () => {
      const index = this.interceptors.indexOf(fn)
      if (index >= 0) this.interceptors.splice(index, 1)
    }
  }

  /**
   * 已注册工具的执行体包扎（OPT-P1-03 正式扩展点）：用 wrap 替换当前 execute，
   * wrap 收到原执行体、返回新执行体。返回还原函数（按包扎时的现场逆向恢复）。
   * 工具不存在抛 TypeError（不静默）。
   */
  decorate(name: string, wrap: (execute: ToolDefinitionLite['execute']) => ToolDefinitionLite['execute']): () => void {
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`[tools] decorate 目标工具不存在：${name}`)
    if (typeof wrap !== 'function') throw new TypeError(`[tools] decorate 的 wrap 必须是函数（工具 ${name}）`)
    const previous = definition.execute
    definition.execute = wrap(previous)
    return () => {
      definition.execute = previous
    }
  }

  schemas(): Array<{ name: string; description: string; parameters: Record<string, unknown>; plugin?: string; permission?: string }> {
    return [...this.definitions.values()].map(({ name, description, parameters, plugin, permission }) => ({
      name,
      description,
      parameters,
      plugin,
      permission,
    }))
  }

  has(name: string): boolean {
    return this.definitions.has(name)
  }

  async execute(input: { name: string; arguments?: unknown; signal?: AbortSignal; principal?: ToolPrincipal }): Promise<ToolExecutionResultLite> {
    const started = Date.now()
    const callId = randomUUID()
    const name = input.name
    const args = input.arguments ?? {}
    const base = { callId, name }
    const definition = this.definitions.get(name)
    if (!definition) {
      return { ...base, isError: true, content: [{ type: 'text', text: `未知工具：${name}` }], error: { message: `未知工具：${name}` }, durationMs: 0 }
    }
    for (const guard of this.guards) {
      const reason = guard({ name, arguments: args })
      if (reason) {
        return { ...base, isError: true, content: [{ type: 'text', text: `调用被拒绝：${reason}` }], error: { message: reason }, durationMs: Date.now() - started }
      }
    }
    // 上下文型 guard（D02/D03）：旧 guard 链之后运行，注入身份可见性（principal/callId）
    for (const guard of this.contextualGuards) {
      const reason = guard({ name, arguments: args, ...(input.principal ? { principal: input.principal } : {}), callId })
      if (reason) {
        return { ...base, isError: true, content: [{ type: 'text', text: `调用被拒绝：${reason}` }], error: { message: reason }, durationMs: Date.now() - started }
      }
    }
    const signal = input.signal ?? new AbortController().signal
    const exec: ToolRunContext = { callId, name, signal, ...(input.principal ? { principal: input.principal } : {}) }
    try {
      const value = await definition.execute(structuredClone(args), exec)
      const content = safeRender(definition, args, value)
      return { ...base, isError: false, value, content, durationMs: Date.now() - started }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ...base, isError: true, content: [{ type: 'text', text: `工具执行失败：${message}` }], error: { message }, durationMs: Date.now() - started }
    }
  }
}

function safeRender(definition: ToolDefinitionLite, args: unknown, value: unknown): ContentBlock[] {
  try {
    const rendered = definition.output.render(args, value)
    return Array.isArray(rendered) ? rendered : [{ type: 'text', text: JSON.stringify(value) }]
  } catch {
    return [{ type: 'text', text: JSON.stringify(value) }]
  }
}

// ---------------------------------------------------------------------------
// 平台工具定义辅助：扁平参数说明 → JSON Schema，输出默认 pretty JSON 渲染。
// 该形态与 dsh 原生 ToolRuntime 的注册契约一致，可原样注册到两种宿主。
// ---------------------------------------------------------------------------

export interface ToolParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  required?: boolean
  description?: string
  enum?: Array<string | number>
  items?: Record<string, unknown>
}

export interface PlatformToolSpec {
  name: string
  description: string
  /** 插件名（登记来源用）。 */
  plugin?: string
  parameters: Record<string, ToolParamSpec>
  /** 输出 JSON Schema 根节点。 */
  output: Record<string, unknown>
  /** 自定义模型可见渲染（默认 JSON pretty print）。 */
  render?: (args: unknown, value: unknown) => ContentBlock[]
  timeoutMs?: number
  /** 调用所需的最小权限点（RBAC）。缺省视为无需额外权限（仅登录）。 */
  permission?: string
  execute: (args: any, exec: ToolRunContext) => Promise<unknown>
}

export function defineTool(spec: PlatformToolSpec): ToolDefinitionLite {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, param] of Object.entries(spec.parameters)) {
    const node: Record<string, unknown> = { type: param.type }
    if (param.description) node.description = param.description
    if (param.enum) node.enum = param.enum
    if (param.items) node.items = param.items
    properties[key] = node
    if (param.required) required.push(key)
  }
  const parameters: Record<string, unknown> = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
  return {
    name: spec.name,
    description: spec.description,
    plugin: spec.plugin,
    ...(spec.permission !== undefined ? { permission: spec.permission } : {}),
    parameters,
    output: {
      schema: spec.output,
      render: spec.render ?? ((_args: unknown, value: unknown) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ]),
    },
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    execute: spec.execute,
  }
}
