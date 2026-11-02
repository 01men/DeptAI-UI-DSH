/**
 * @ybkk/plugin-dingtalk-bridge —— REST 面 + 事件装配（review-dsh-agent-panel-v2 Phase 3）。
 *
 * 全部 REST 走 guarded（权限点：dingtalk.message.send / panel.read），自注册路由推入
 * httpServer.routeMatrix 共享登记处（RBAC 断言网覆盖义务与 panel-core 一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../platform-core/src/index.ts'
import { createRestGate } from '../../platform-core/src/index.ts'
import { newId } from '../../platform-core/src/ids.ts'
import { t } from '../../platform-i18n/src/index.ts'
import { DingtalkBridgeService } from './service.ts'

export const name = 'dingtalk-bridge'
// panel 为 panel-core 注册的服务（加载序保证先于本插件）；dingtalkBridge 自供服务不可自 inject
export const inject = ['httpServer', 'opsStorage', 'platformBus', 'iam', 'audit', 'panel']

export function apply(ctx: Context) {
  const http = ctx.httpServer
  const bridge = new DingtalkBridgeService(ctx)

  // R5 收敛：caller/requirePermission/guarded/body/changeLog 统一引 platform-core 共享实现（单点修复、单点审计）
  const { caller, requirePermission, guarded, body, changeLog } = createRestGate(ctx)

  // -- 状态胶囊（顶栏）：连接器形态 / 个人扫码绑定 / 入向能力声明 ----------------------

  guarded('GET', '/api/dingtalk/status', 'panel.read', (exchange) => {
    const info = caller(exchange)
    const connector = bridge.connector()
    const link = info.userId
      ? ctx.iam.identityLinks().find((item) => item.userId === info.userId && item.provider === 'dingtalk').at(-1)
      : undefined
    return {
      connector: connector
        ? { configured: true, mode: connector.mode, corpId: connector.corpId, name: connector.name, enabled: connector.enabled }
        : { configured: false },
      bound: link ? { displayName: link.displayName, corpId: link.corpId, linkedAt: link.linkedAt } : null,
      // D2 裁决：身份绑定事实源 = iam 扫码绑定（identityLinks）；官方连接器 owner-binding 仅留 DSH owner 语义
      bindPath: '/api/auth/sso/bind/authorize（钉钉扫码 → iam identityLinks）',
      // R-SPIKE 未决：入向 Stream 在官方连接器暴露面核对前停用（同 clientId 全企业仅一条 Stream 连接）
      inbound: { enabled: false, reason: t('R-SPIKE：官方 dsh-dingtalk 连接器入向暴露面核对前停用（出向投递已可用）') },
      dws: { enabled: false, reason: t('DWS 数字员工为可选增强，后续迭代') },
      bridges: bridge.bridgeChannels().count(),
    }
  })

  // -- 群桥绑定 -----------------------------------------------------------------

  guarded('GET', '/api/dingtalk/bridges', 'panel.read', (exchange) => {
    const dept = exchange.query.get('dept') ?? ''
    return {
      bridges: bridge.bridgeChannels().find((item) => (dept ? item.dept === dept : true)),
    }
  })

  guarded('POST', '/api/dingtalk/channels/:id/bridge', 'dingtalk.message.send', (exchange) => {
    const input = body<{ chatId?: string; robotCode?: string; purpose?: string }>(exchange)
    if (!input.chatId?.trim() || !input.robotCode?.trim()) throw new Error(t('chatId（openConversationId）与 robotCode 必填'))
    const purpose = input.purpose === 'alerts' ? 'alerts' as const : 'channel' as const
    const channel = ctx.panel.channels().get(String(exchange.params.id))
    if (purpose === 'channel' && !channel) throw new Error(t('面板频道不存在：{id}', { id: String(exchange.params.id) }))
    const info = caller(exchange)
    const existing = bridge.bridgeChannels().findOne((item) => item.channelId === String(exchange.params.id))
    if (existing) {
      bridge.bridgeChannels().update(existing.id, {
        chatId: input.chatId.trim(), robotCode: input.robotCode.trim(), purpose, boundBy: info.userId ?? info.principalId, boundAt: new Date().toISOString(),
      })
    } else {
      bridge.bridgeChannels().insert({
        id: newId('ddbr'), channelId: String(exchange.params.id),
        dept: channel?.dept ?? (purpose === 'alerts' ? 'platform' : ''),
        chatId: input.chatId.trim(), robotCode: input.robotCode.trim(), purpose,
        boundBy: info.userId ?? info.principalId, boundAt: new Date().toISOString(),
      })
    }
    changeLog(exchange, 'dingtalk.bridge.bind', 'panel_channel', String(exchange.params.id), channel?.name ?? 'alerts', `purpose=${purpose}`)
    return { bridge: bridge.bridgeChannels().findOne((item) => item.channelId === String(exchange.params.id)) }
  })

  guarded('DELETE', '/api/dingtalk/channels/:id/bridge', 'dingtalk.message.send', (exchange) => {
    const existing = bridge.bridgeChannels().findOne((item) => item.channelId === String(exchange.params.id))
    if (!existing) throw new Error(t('该频道未绑定群桥：{id}', { id: String(exchange.params.id) }))
    bridge.bridgeChannels().remove(existing.id)
    changeLog(exchange, 'dingtalk.bridge.unbind', 'panel_channel', String(exchange.params.id), '', existing.purpose)
    return { deleted: true }
  })

  // -- 审批推送（审批中心/卡片动作 → 钉钉卡片文本） ----------------------------------

  guarded('POST', '/api/dingtalk/approvals/:id/push', 'dingtalk.message.send', async (exchange) => {
    const approval = ctx.audit.approvals().get(String(exchange.params.id))
    if (!approval) throw new Error(t('审批单不存在：{id}', { id: String(exchange.params.id) }))
    const dept = typeof approval.payload.dept === 'string' ? approval.payload.dept : ''
    const info = caller(exchange)
    const result = await bridge.deliver({
      messageId: `approval:${approval.id}`,
      ...(dept ? { dept } : {}),
      title: t('🔔 审批推送：{title}', { title: approval.title }),
      text: [
        t('单号：{id}', { id: approval.id }),
        t('发起人：{name}', { name: approval.requesterName }),
        t('风险级：{level}{confirm}', { level: approval.riskLevel ?? 'low', confirm: approval.riskLevel === 'high' ? t('（需二次确认）') : '' }),
        t('内容：{payload}', { payload: JSON.stringify(approval.payload) }),
      ].join('\n'),
    })
    if (!result.delivered && result.error) throw new Error(t('推送未完成：{message}', { message: result.error }))
    changeLog(exchange, 'dingtalk.approval.push', 'approval', approval.id, approval.title, result.delivered ? '已投递' : '未绑定群桥')
    return result
  })

  // -- 回决写回（入向适配器契约；staffId 反查 fail-closed） -----------------------------
  // 入向 Stream 停用期间，本端点仅对持有 dingtalk.message.send 的机器凭证（未来适配器）开放：
  // 身份必须能反查 identityLinks，审批权限必须在平台侧复核，high 风险必须显式 confirmed。

  guarded('POST', '/api/dingtalk/bridge/callback', 'dingtalk.message.send', async (exchange) => {
    const input = body<{ staffId?: string; approvalId?: string; decision?: string; opinion?: string; confirmed?: boolean }>(exchange)
    if (!input.staffId || !input.approvalId || !['approve', 'reject'].includes(input.decision ?? '')) {
      throw new Error(t('staffId/approvalId/decision(approve|reject) 必填'))
    }
    const link = ctx.iam.findLinkByProfile('dingtalk', input.staffId)
    if (!link) throw new Error(t('staffId 未绑定任何平台账号（fail-closed：拒绝匿名回决）'))
    const user = ctx.iam.users().get(link.userId)
    if (!user || user.status !== 'active') throw new Error(t('绑定账号不存在或已停用（fail-closed）'))
    const permissions = user.roleIds.flatMap((roleId) => ctx.iam.roles().get(roleId)?.permissions ?? [])
    if (!permissions.includes('*') && !permissions.includes('approval.decide')) {
      throw new Error(t('绑定账号无审批决策权限（fail-closed）'))
    }
    const approval = ctx.audit.approvals().get(input.approvalId)
    if (!approval) throw new Error(t('审批单不存在：{id}', { id: input.approvalId }))
    if (approval.riskLevel === 'high' && input.decision === 'approve' && input.confirmed !== true) {
      throw new Error(t('高风险审批的钉钉回决必须携带 confirmed=true（服务端强制二次确认）'))
    }
    const record = await ctx.audit.decideApproval(approval.id, input.decision as 'approve' | 'reject', user.id, user.displayName, input.opinion ?? t('（钉钉侧回决）'), { confirmed: input.confirmed === true })
    changeLog(exchange, 'dingtalk.approval.callback', 'approval', approval.id, approval.title, `${input.decision} by ${user.displayName}`)
    return { approval: { id: record.id, status: record.status } }
  })

  // -- 事件装配 ----------------------------------------------------------------

  bridge.wireEventBus()
  ctx.effect(() => () => undefined)
}
