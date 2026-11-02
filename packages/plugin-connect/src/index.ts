/**
 * @dsh-ops/plugin-connect —— 远程接入插件（一份代码，两种角色）。
 *
 * - role=host（独立宿主默认）：提供接入码 / enroll / 客户端管理端点与工具，
 *   让远程 dsh 运行时（插件市场安装形态）可向本平台申请机器凭证。
 * - role=client（dsh.bundle 安装形态）：向宿主申请并保管机器凭证；
 *   配置完成后，平台全部运维工具的执行自动转发宿主（未配置时保持本地执行，向后兼容；
 *   OPT-P1-03 起代理挂在 tools.intercept/decorate 正式扩展点上，转发失败 fail-closed 显式告警）；
 *   同时起一个仅本机可访问的配置页（默认 http://127.0.0.1:7390）供人工填写/更新配置，
 *   并向模型暴露 connect_* 工具，让 Agent 用自然语言完成「申请口令 / 改配置 / 断开」。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'
import { t as translate } from '../../platform-i18n/src/index.ts'
import { ConnectClientService, isProxiedTool } from './client.ts'
import { ConnectConfigServer } from './config-page.ts'
import { connectHostApi, connectHostTools } from './host.ts'

export * from './client.ts'
export * from './config-page.ts'
export * from './host.ts'

export interface ConnectConfig {
  /** host=宿主侧（管理端点）；client=远程 dsh 侧（申请凭证 + 工具远程代理）。 */
  role?: 'host' | 'client'
  /** 客户端配置文件目录（默认与本地存储同目录）。 */
  dataDir?: string
  /** 客户端本机配置页监听（默认 127.0.0.1:7390；host=0.0.0.0 可局域网访问）。 */
  configServer?: { port?: number; host?: string }
  /** 心跳间隔分钟数（默认 5；0 = 关闭心跳推送）。 */
  heartbeatIntervalMinutes?: number
}

export const name = 'connect'
export const inject = ['tools', 'httpServer', 'opsStorage', 'platformBus']

export function apply(ctx: Context, config: ConnectConfig = {}) {
  if (config.role === 'client') {
    applyClient(ctx, config)
    return
  }
  // host 角色：管理端点（等 authn/iam/audit 就绪）+ 宿主侧接入管理工具
  ctx.plugin(connectHostApi)
  ctx.plugin(connectHostTools)
}

// ---------------------------------------------------------------------------
// client 角色
// ---------------------------------------------------------------------------

function applyClient(ctx: Context, config: ConnectConfig): void {
  const client = new ConnectClientService(ctx, { dataDir: config.dataDir })

  // 工具远程代理（OPT-P1-03）：挂在 tools.intercept/decorate 正式扩展点上（不再原型猴补丁），
  // 业务工具（非 connect_ 前缀）在已接入时转发宿主 /api/tools/execute；
  // 转发失败显式抛错 + connect.degraded 事件（fail-closed），绝不静默落本地。
  // 安装仍宜早于业务插件注册（入口层拦截新注册），先注册的存量工具由 decorate 兜底。
  const proxied = installToolProxy(ctx, client)

  // 本机配置页（仅本机可访问；用户在 dsh 界面之外的可视化配置入口）
  const server = new ConnectConfigServer(ctx, client, config.configServer ?? {})
  void server.start().then(() => {
    ctx.logger('connect').info(
      `接入配置页已就绪：http://${server.host}:${server.port}${proxied ? '（当前工具为本地执行，接入后自动切换远程）' : '（远程转发不可用：运行时缺少工具扩展点，已显式降级本地，connect_status 可查）'}`,
    )
  }, (error: unknown) => {
    ctx.logger('connect').error(`接入配置页启动失败（端口 ${server.port}）：`, error)
  })

  // -- 心跳推送：接入后周期性向宿主上报存活与运行元信息（宿主侧接入资产监测） ------
  // 默认 5 分钟一轮，heartbeatIntervalMinutes=0 关闭；未接入时静默跳过，失败仅记录 lastError。
  const heartbeatMinutes = config.heartbeatIntervalMinutes ?? 5
  if (heartbeatMinutes > 0) {
    const bootAt = Date.now()
    const beat = (): void => {
      if (!client.hasHub()) return
      let tools = 0
      try { tools = ctx.tools.schemas?.().length ?? 0 } catch { /* dsh 原生运行时接口差异时降级为 0 */ }
      void client.heartbeat({ tools, version: process.version, uptimeSec: Math.floor((Date.now() - bootAt) / 1000) })
        .catch((error: unknown) => client.noteError(`heartbeat: ${error instanceof Error ? error.message : String(error)}`))
    }
    const timer = setInterval(beat, heartbeatMinutes * 60_000)
    timer.unref?.()
    const first = setTimeout(beat, 10_000) // 接入配置完成后 10s 内先发一次，宿主侧立即可见
    first.unref?.()
    // cordis ctx.effect(fn)：fn 返回清理函数，须双层箭头（否则注册时即执行）
    ctx.effect(() => () => { clearInterval(timer); clearTimeout(first) })
  }

  // -- Agent 工具：安装完插件后，Agent 用自然语言即可完成口令申请与配置更新 ----
  const t = ctx.tools
  t.register(defineTool({
    name: 'connect_status',
    description: '查看当前与宿主平台的接入状态（是否已配置、宿主可达性、机器令牌状态、工具执行模式 local/remote、最近错误）。',
    permission: 'console.login',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      return await client.status()
    },
  }))

  t.register(defineTool({
    name: 'connect_setup',
    description: '向宿主平台申请口令并完成接入（安装插件后第一步）：用管理员签发的一次性接入码换取长期机器凭证并保存到本机。成功后平台运维工具自动切换为远程执行。',
    parameters: {
      hubUrl: { type: 'string', required: true, description: '宿主平台服务地址，如 http://192.168.1.5:7300' },
      enrollmentCode: { type: 'string', required: true, description: '宿主管理员在控制台「平台接入」创建的一次性接入码（enr_ 开头）' },
      clientName: { type: 'string', description: '本机名称（默认 dsh-主机名，宿主侧便于识别）' },
    },
    permission: 'console.login',
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const result = await client.enroll({
        hubUrl: String(args.hubUrl),
        enrollmentCode: String(args.enrollmentCode),
        clientName: args.clientName === undefined || args.clientName === '' ? undefined : String(args.clientName),
      })
      const probe = await client.probeHub().catch(() => null)
      return {
        ok: true,
        hubUrl: result.hubUrl,
        clientName: result.clientName,
        template: result.template,
        hubReachable: probe?.reachable === true,
        notice: translate('机器凭证已保存到本机；平台运维工具已切换为远程执行（宿主侧执行、按模板权限收敛、全程审计）'),
      }
    },
  }))

  t.register(defineTool({
    name: 'connect_login',
    description: '用已有机器凭证（ClientId/ClientSecret）配置宿主连接。适用于管理员在宿主控制台手工签发凭证后分发的场景。',
    parameters: {
      hubUrl: { type: 'string', required: true, description: '宿主平台服务地址' },
      clientId: { type: 'string', required: true, description: '机器凭证 ClientId（mc- 开头）' },
      clientSecret: { type: 'string', required: true, description: '机器凭证 ClientSecret' },
      clientName: { type: 'string', description: '本机名称（可选）' },
    },
    permission: 'console.login',
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const result = await client.loginWithCredential({
        hubUrl: String(args.hubUrl),
        clientId: String(args.clientId),
        clientSecret: String(args.clientSecret),
        clientName: args.clientName === undefined || args.clientName === '' ? undefined : String(args.clientName),
      })
      return { ok: true, hubUrl: result.hubUrl, clientName: result.clientName, notice: translate('凭证已验证并保存，工具切换为远程执行') }
    },
  }))

  t.register(defineTool({
    name: 'connect_test',
    description: '体检宿主连接：健康检查 + 机器令牌换发 + 一次真实只读调用（agent_list）。',
    permission: 'console.login',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      const status = await client.status()
      if (!client.hasHub()) return { ...status, note: translate('尚未接入，先执行 connect_setup') }
      let sample: Record<string, unknown> = {}
      try {
        const value = await client.forward('agent_list', {})
        sample = { sampleCall: { tool: 'agent_list', total: (value as { total?: number })?.total } }
      } catch (error) {
        sample = { sampleCall: { tool: 'agent_list', error: error instanceof Error ? error.message : String(error) } }
      }
      return { ...status, ...sample }
    },
  }))

  t.register(defineTool({
    name: 'connect_reset',
    description: '断开宿主连接：清除本机保存的机器凭证与令牌缓存，工具回到本地执行（宿主侧凭证不受影响，回收请在宿主控制台禁用）。',
    permission: 'console.login',
    parameters: {
      reason: { type: 'string', description: '断开原因（记录到本机日志）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const was = client.getConfig()
      client.reset()
      ctx.logger('connect').info(`已断开宿主连接${args.reason ? `：${String(args.reason)}` : ''}${was ? `（原 ${was.hubUrl}）` : ''}`)
      return { ok: true, configured: false, notice: translate('本机凭证已清除，工具回到本地执行模式') }
    },
  }))
}

/**
 * 工具远程代理安装（OPT-P1-03，契约化改造）：
 * - 入口层：tools.intercept 注册级拦截——此后注册的业务工具（非 connect_ 前缀）换装转发执行体；
 * - 兜底层：tools.decorate 对先于本插件注册的存量业务工具逐个包扎；
 * - fail-closed：转发失败显式抛错 + connect.degraded 节流告警事件（落总线/审计），绝不静默落本地；
 * - 运行时缺少扩展点（非 ToolRuntime-lite 形态）→ 显式降级（事件 + 状态 + error 日志），不再原型猴补丁。
 * 返回是否成功安装。
 */
export function installToolProxy(ctx: Context, client: ConnectClientService): boolean {
  const tools = ctx.tools as unknown as {
    intercept?: (fn: (definition: Record<string, unknown>) => Record<string, unknown>) => () => void
    decorate?: (name: string, wrap: (execute: unknown) => unknown) => () => void
    schemas?: () => Array<{ name: string }>
  } | undefined
  if (!tools || typeof tools.intercept !== 'function' || typeof tools.decorate !== 'function') {
    ctx.logger('connect').error('运行时缺少 tools.intercept/decorate 扩展点：远程转发不可用，已显式降级为本地执行（connect.degraded 已发事件）')
    client.noteDegraded('tool_runtime_contract_missing', translate('ctx.tools 未提供 intercept/decorate 扩展点（非 ToolRuntime-lite 形态）'))
    try { ctx.platformBus?.emit('connect.degraded', { reason: 'tool_runtime_contract_missing', detail: translate('ctx.tools 未提供 intercept/decorate 扩展点（非 ToolRuntime-lite 形态）'), at: new Date().toISOString() }) } catch { /* 总线未就绪：状态已记 client */ }
    return false
  }

  // 转发执行体：已接入→转发（失败显式抛错，绝不落本地）；未接入→本地（connect_reset 的显式语义，非降级）
  const makeProxied = (toolName: string, localExecute: unknown): unknown => {
    return async (args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<unknown> => {
      if (client.hasHub()) {
        try {
          return await client.forward(toolName, args ?? {}, exec)
        } catch (error) {
          client.noteForwardFailure(toolName, error)
          throw error
        }
      }
      return await (localExecute as ((a: Record<string, unknown>, e: { signal?: AbortSignal }) => Promise<unknown>) | undefined)?.(args ?? {}, exec)
    }
  }

  const disposers: Array<() => void> = []
  // 入口层：注册级拦截（覆盖此后注册的全部业务工具）；登记被换装的工具供注销时解包还原
  const interceptedTools: Array<{ name: string; localExecute: unknown }> = []
  disposers.push(tools.intercept((definition) => {
    const toolName = definition?.['name']
    if (typeof toolName !== 'string' || !isProxiedTool(toolName)) return definition
    interceptedTools.push({ name: toolName, localExecute: definition['execute'] })
    return { ...definition, execute: makeProxied(toolName, definition['execute']) }
  }))
  // 兜底层：存量已注册业务工具逐个包扎（竞态注销的工具跳过）
  for (const schema of tools.schemas?.() ?? []) {
    if (!isProxiedTool(schema.name)) continue
    try {
      disposers.push(tools.decorate(schema.name, (execute) => makeProxied(schema.name, execute)))
    } catch { /* 工具已在装饰间隙注销：跳过 */ }
  }
  ctx.effect(() => () => {
    for (const off of [...disposers].reverse()) off()
    // 注销时把入口层换装过的工具解包回本地执行体（decorate 语义：换回捕获的本地原执行体）
    for (const item of interceptedTools) {
      try {
        tools.decorate?.(item.name, () => item.localExecute)
      } catch { /* 工具已注销：跳过 */ }
    }
  })
  return true
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectClient: ConnectClientService
    connectConfigServer: ConnectConfigServer
  }
}
