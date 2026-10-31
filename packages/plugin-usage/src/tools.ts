/**
 * usage 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type CallerInfo } from '../../platform-core/src/index.ts'
import { prepareAssetUsageReport, type AssetUsageCheckCtx, type AssetUsageReportInput } from './asset-reports.ts'

export const name = 'usage-tools'
export const inject = ['tools', 'usage']

/** asset_usage_report 的授权编排需要 skillHub/mcpRegistry/resourceCore——三者均注入 usage
 *  （装配晚于本插件），静态 inject 会成环且被 boot-order lint 拦截；按 exec-hub softRead 先例
 *  经 ctx.reflect.get 运行时软读（工具调用发生在启动完成后，服务必然已装配；未装配则拒绝提报）。 */
function softRead(ctx: Context, key: string): unknown {
  try {
    const reflect = (ctx as unknown as { reflect?: { get?: (k: string, optional?: boolean) => unknown } }).reflect
    if (typeof reflect?.get === 'function') return reflect.get(key, false)
    return (ctx as unknown as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'usage_query',
    description: '查询资源消耗计量事件（按主体/资源/时间窗过滤，返回事件数与应收金额）。',
    // REL-07：此前未声明权限点（缺省仅登录），audit 等无 usage.read 主体可经工具桥读到全平台计量——
    // 与 REST 面 GET /api/usage/totals（usage.read）口径对齐
    permission: 'usage.read',
    parameters: {
      principal: { type: 'string', description: '计费责任主体过滤（org:<id> / plugin:<id>）' },
      resource: { type: 'string', description: '资源过滤（model:<slug> / mcp:<slug> / plugin:<id>）' },
      from: { type: 'string', description: '起始时间（ISO）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return ctx.usage.totals({
        ...(args.principal ? { principal: args.principal } : {}),
        ...(args.resource ? { resource: args.resource } : {}),
        ...(args.from ? { from: args.from } : {}),
      })
    },
  }))

  t.register(defineTool({
    name: 'usage_reconcile',
    description: '触发计量对账：usage 事件流水 vs 消费方投影，偏差即告警。',
    permission: 'usage.admin',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      return ctx.usage.reconcile()
    },
  }))

  t.register(defineTool({
    name: 'usage_replay',
    description: '重放时间窗内计量事件（消费水位保证幂等，重复重放不产生重复扣费/投影）。',
    permission: 'usage.admin',
    parameters: {
      since: { type: 'string', required: true, description: '起始时间（ISO，含）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return ctx.usage.replay(args.since)
    },
  }))

  t.register(defineTool({
    name: 'usage_deadletter_retry',
    description: '重投 usage 消费死信：逐条重新分发，成功即移出死信队列。',
    permission: 'usage.admin',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      return ctx.usage.retryDeadLetters()
    },
  }))

  // 资产使用凭证（2026-10-31）：Agent 使用 skill/MCP 后主动提报使用事实（台账 usageReports30d /
  // 审计逐次留痕）。授权闭环：机器主体必须已获取该资产（skill install/download；mcp 权限组），
  // 校验编排与 REST 面共用 prepareAssetUsageReport（见 asset-reports.ts）。
  t.register(defineTool({
    name: 'asset_usage_report',
    description: '提报资产使用凭证（skill/MCP 使用事实）：每次使用平台资产后上报，形成资产经营侧的使用凭证。要求本 Agent 已获取该资产（skill 已 install/download；MCP 已权限组绑定），未获取先提报会被拒绝。幂等键约定 <agent标识>:<业务单号>，同键同内容重放安全。',
    permission: 'usage.write',
    parameters: {
      assetType: { type: 'string', required: true, enum: ['skill', 'mcp'], description: '资产类型' },
      assetRef: { type: 'string', required: true, description: '资产引用（skill 的 id 或 slug / mcp 的 slug）' },
      assetVersion: { type: 'string', description: '使用时的资产版本' },
      action: { type: 'string', description: '使用动作（默认 invoke；如 execute/call/read）' },
      occurredAt: { type: 'string', description: '使用发生时间（ISO8601，缺省当前；仅允许补录近 30 天）' },
      outcome: { type: 'string', enum: ['success', 'failure'], description: '使用结果（默认 success）' },
      durationMs: { type: 'integer', description: '耗时毫秒' },
      tokens: { type: 'integer', description: '消耗 token 数（如适用）' },
      taskId: { type: 'string', description: '关联工作任务/业务单号' },
      note: { type: 'string', description: '一句话说明' },
      idempotencyKey: { type: 'string', required: true, description: '幂等键（约定 <agent标识>:<业务单号>）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      // 身份 fail-closed：无调用者上下文（非桥接宿主）不降级、直接拒绝
      if (!exec.principal) throw new Error('调用者身份缺失，无法提报使用凭证（本工具必须在携带调用者身份的宿主中使用）')
      const checkCtx = {
        skillHub: softRead(ctx, 'skillHub'),
        mcpRegistry: softRead(ctx, 'mcpRegistry'),
        resourceCore: softRead(ctx, 'resourceCore'),
      }
      if (!checkCtx.skillHub || !checkCtx.mcpRegistry || !checkCtx.resourceCore) {
        throw new Error('资产域服务未装配（skillHub/mcpRegistry/resourceCore 缺失），无法校验授权关系')
      }
      const prepared = prepareAssetUsageReport(checkCtx as unknown as AssetUsageCheckCtx, args as AssetUsageReportInput, exec.principal as unknown as CallerInfo)
      return ctx.usage.submitAssetUsageReport(prepared)
    },
  }))
}
