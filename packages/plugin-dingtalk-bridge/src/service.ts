/**
 * @dsh-ops/plugin-dingtalk-bridge —— 钉钉桥接（review-dsh-agent-panel-v2 Phase 3）。
 *
 * 职责（出向优先，R-SPIKE 未决不做入向硬编码）：
 *   - 群桥绑定：panel 频道 ↔ 钉钉群会话（openConversationId + robotCode），purpose=channel/alerts
 *   - 出向投递：订阅 panel.message.created（ddSync=pending）与 panel.card.action（dd.push）→
 *     经 iam 连接器凭证（凭证单一来源铁律，本插件零凭证存储）调机器人群消息 API →
 *     回执 emit dingtalk-bridge.delivered（面板订阅回写 ddSync 状态）
 *   - 告警投递：订阅 audit.alert.fired → purpose=alerts 的群桥坐实 channels:['dingtalk']（补仓库欠账）
 *   - 审批推送：POST /api/dingtalk/approvals/:id/push → 审批卡片文本推群
 *   - 回决写回：POST /api/dingtalk/bridge/callback —— staffId↔identityLinks 反查身份 +
 *     审批权限校验 + high 风险必须显式 confirmed（fail-closed，对齐 decideApproval 语义）
 *
 * 入向（钉钉 Stream）刻意停用：官方连接器 @dingtalk-real-ai/dsh-dingtalk 是否向平台暴露
 * 发送/事件面属 R-SPIKE 未决项，且同一 clientId 全企业仅一条 Stream 连接——在连接器文档
 * 核对前不引入 SDK、不开入向端点；status 端点如实声明 inbound=disabled(reason)。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Collection, RecordBase } from '../../platform-core/src/storage.ts'
import { PlatformEvents } from '../../platform-core/src/bus.ts'
import { newId } from '../../platform-core/src/ids.ts'
import { t } from '../../platform-i18n/src/index.ts'

export interface BridgeChannelRecord extends RecordBase {
  /** panel:channels 的频道 id。 */
  channelId: string
  dept: string
  /** 钉钉群会话标识（openConversationId / chatId）。 */
  chatId: string
  /** 机器人编码（企业内部机器人 robotCode）。 */
  robotCode: string
  /** channel=面板频道同步群；alerts=运维告警/审批群。 */
  purpose: 'channel' | 'alerts'
  boundBy: string
  boundAt: string
}

export interface BridgeMessageRecord extends RecordBase {
  messageId: string
  direction: 'out' | 'in'
  chatId: string
  status: 'sent' | 'failed'
  error?: string
  /** 去重键（出向=messageId:chatId；入向=sender 提供的 uniqueKey）。 */
  dedupKey: string
}

interface DingtalkConnectorConfig {
  provider: string
  enabled: boolean
  mode: 'real' | 'mock'
  corpId: string
  name: string
  appKey: string
  secretActual?: string
  apiBase?: string
  oapiBase?: string
}

export class DingtalkBridgeService extends Service {
  static readonly provide = 'dingtalkBridge'

  private tokenCache: { token: string; expiresAt: number } | undefined

  constructor(ctx: Context, config: Record<string, never> = {}) {
    super(ctx, 'dingtalkBridge')
    void config
  }

  bridgeChannels(): Collection<BridgeChannelRecord> {
    const collection = this.ctx.opsStorage.collection<BridgeChannelRecord>('dingtalk:bridgeChannels')
    collection.uniqueOn('channel-bridge', (r) => r.channelId)
    return collection
  }

  bridgeMessages(): Collection<BridgeMessageRecord> {
    const collection = this.ctx.opsStorage.collection<BridgeMessageRecord>('dingtalk:bridgeMessages')
    collection.uniqueOn('dedup', (r) => r.dedupKey)
    return collection
  }

  /** 连接器配置只读视图（凭证单一来源=iam；本服务不落任何 secret）。 */
  connector(): Pick<DingtalkConnectorConfig, 'provider' | 'enabled' | 'mode' | 'corpId' | 'name'> | undefined {
    const config = this.dingtalkConfig()
    if (!config) return undefined
    return { provider: config.provider, enabled: config.enabled, mode: config.mode, corpId: config.corpId, name: config.name }
  }

  private dingtalkConfig(): DingtalkConnectorConfig | undefined {
    const configs = this.ctx.iam.connectorConfigs().all() as unknown as DingtalkConnectorConfig[]
    return configs.find((config) => config.provider === 'dingtalk' && config.enabled)
  }

  /** 企业 accessToken（iam 连接器同款 API 形态；令牌仅内存缓存，不落盘）。 */
  private async accessToken(): Promise<{ token: string; oapiBase: string }> {
    const config = this.dingtalkConfig()
    if (!config) throw new Error(t('钉钉连接器未配置（请先在控制台「三方集成」配置并启用）'))
    if (config.mode === 'mock') throw new Error(t('钉钉连接器为 mock 演示模式——不做真实外呼，切 real 并指向有效网关后再投递'))
    if (!config.secretActual) throw new Error(t('钉钉连接器缺少密钥（appSecret 未配置）'))
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) return { token: this.tokenCache.token, oapiBase: config.oapiBase ?? 'https://oapi.dingtalk.com' }
    const apiBase = config.apiBase ?? 'https://api.dingtalk.com'
    const response = await fetch(`${apiBase}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: config.appKey, appSecret: config.secretActual }),
    })
    const payload = (await response.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number; message?: string }
    if (!response.ok || !payload.accessToken) {
      const detail = payload.message ? t('：{message}', { message: payload.message }) : ''
      throw new Error(t('钉钉 accessToken 获取失败（HTTP {status}）', { status: response.status }) + detail)
    }
    this.tokenCache = { token: payload.accessToken, expiresAt: Date.now() + (payload.expireIn ?? 7200) * 1000 }
    return { token: payload.accessToken, oapiBase: config.oapiBase ?? 'https://oapi.dingtalk.com' }
  }

  /**
   * 群消息投递（机器人群消息 API 形态）。真实语义：POST {oapi}/v1.0/robot/groupMessages/send。
   * errcode=0 视为成功；网络/凭证/业务错误一律 fail 并带原因（面板侧转 failed + 告警留痕）。
   */
  async sendToGroup(input: { chatId: string; robotCode: string; title: string; text: string }): Promise<{ ok: true }> {
    const { token, oapiBase } = await this.accessToken()
    let response: Response
    try {
      response = await fetch(`${oapiBase}/v1.0/robot/groupMessages/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify({
          robotCode: input.robotCode,
          openConversationId: input.chatId,
          msgKey: 'sampleMarkdown',
          msgParam: JSON.stringify({ title: input.title, text: input.text }),
        }),
      })
    } catch (error) {
      throw new Error(t('钉钉投递网络失败：{message}', { message: error instanceof Error ? error.message : String(error) }))
    }
    const payload = (await response.json().catch(() => ({}))) as { errcode?: number; errmsg?: string; message?: string }
    if (!response.ok || (payload.errcode !== undefined && payload.errcode !== 0)) {
      throw new Error(t('钉钉投递被拒（HTTP {status}）：{message}', { status: response.status, message: payload.errmsg ?? payload.message ?? 'unknown' }))
    }
    return { ok: true }
  }

  /** 出向投递 + 回执（去重 + 留痕 + 事件）。返回是否实际投递（未绑群桥=false，不算失败）。 */
  async deliver(input: { messageId: string; dept?: string; title: string; text: string; chatId?: string; robotCode?: string }): Promise<{ delivered: boolean; error?: string }> {
    const bridge = input.chatId
      ? this.bridgeChannels().findOne((item) => item.chatId === input.chatId)
      : this.bridgeChannels().find((item) => item.purpose === 'channel' && (!input.dept || item.dept === input.dept)).at(0)
      ?? this.bridgeChannels().find((item) => item.purpose === 'channel').at(0)
    if (!bridge && !(input.chatId && input.robotCode)) return { delivered: false, error: t('未绑定群桥') }
    const chatId = bridge?.chatId ?? input.chatId!
    const robotCode = bridge?.robotCode ?? input.robotCode!
    const dedupKey = `${input.messageId}:${chatId}`
    if (this.bridgeMessages().findOne((item) => item.dedupKey === dedupKey)) return { delivered: true }
    try {
      await this.sendToGroup({ chatId, robotCode, title: input.title, text: input.text })
      this.bridgeMessages().insert({ id: newId('ddm'), messageId: input.messageId, direction: 'out', chatId, status: 'sent', dedupKey })
      this.ctx.platformBus.emit(PlatformEvents.DingtalkDelivered, { messageId: input.messageId, ok: true, chatId })
      return { delivered: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        this.bridgeMessages().insert({ id: newId('ddm'), messageId: input.messageId, direction: 'out', chatId, status: 'failed', error: message, dedupKey })
      } catch { /* 回执落库失败不影响事件通知 */ }
      this.ctx.platformBus.emit(PlatformEvents.DingtalkDelivered, { messageId: input.messageId, ok: false, error: message, chatId })
      return { delivered: false, error: message }
    }
  }

  /** 事件订阅装配（消息同步 / 卡片推送 / 告警投递）。 */
  wireEventBus(): void {
    this.ctx.platformBus.on(PlatformEvents.PanelMessageCreated, (payload) => {
      const data = payload as { messageId?: string; dept?: string; ddSync?: string; senderName?: string; text?: string; title?: string } | undefined
      if (data?.ddSync !== 'pending' || !data.messageId) return
      void this.deliver({
        messageId: data.messageId, dept: data.dept,
        title: t('{name} · 部门面板', { name: data.senderName ?? t('面板消息') }),
        text: data.text ?? '',
      }).catch(() => undefined)
    })
    this.ctx.platformBus.on(PlatformEvents.PanelCardAction, (payload) => {
      const data = payload as { dept?: string; ddPush?: boolean; title?: string; text?: string; actorName?: string; channelName?: string } | undefined
      if (!data?.ddPush) return
      void this.deliver({
        messageId: `card:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        dept: data.dept,
        title: data.title ?? t('面板卡片'),
        text: `${data.text ?? ''}\n\n${t('—— {actor}（{channel}）', { actor: data.actorName ?? '', channel: data.channelName ? t('频道：{name}', { name: data.channelName }) : t('部门面板') })}`,
      }).catch(() => undefined)
    })
    // 告警 dingtalk 通道坐实：全部告警推 purpose=alerts 群桥（规则 channels:['dingtalk'] 的投递实现）
    this.ctx.platformBus.on(PlatformEvents.AlertFired, (payload) => {
      const data = payload as { severity?: string; title?: string; message?: string } | undefined
      const bridges = this.bridgeChannels().find((item) => item.purpose === 'alerts')
      if (!data || bridges.length === 0) return
      for (const bridge of bridges) {
        void this.deliver({
          messageId: `alert:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          chatId: bridge.chatId, robotCode: bridge.robotCode,
          title: `${data.severity === 'critical' ? '🚨' : '⚠️'} ${data.title ?? t('平台告警')}`,
          text: data.message ?? '',
        }).catch(() => undefined)
      }
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dingtalkBridge: DingtalkBridgeService
  }
}
