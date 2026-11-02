/**
 * 平台授权直达 entry-ticket（一次性入场票据）。
 *
 * 控制台「打开交互界面 / 打开应用」不再裸跳转：登录用户先向平台签发端
 * （POST /api/agents/:id/entry-ticket、POST /api/apps/:id/entry-ticket）领取一次性短时票据，
 * 目标地址以 #entry_ticket=<ticket> 片段打开；目标前端读取片段后回平台公开端点换取身份：
 *   POST /api/authn/entry-tickets/redeem { ticket } → { refType, refId, identity }
 *（公开路由挂在 plugin-console——PUBLIC_PATHS 与审计写入均在彼处收敛。）
 *
 * 安全语义（与 OIDC 授权码互补：标准 RP 走 /oauth/authorize，任意 entryUrl 零改造直达走本通道）：
 *   - 一次性（redeem 即消费，重放拒绝）+ 短时（默认 120s，ENTRY_TICKET_TTL_SECONDS 可调 30~600）；
 *   - 票据为 256bit 随机值（不可穷举），仅经 https 传输且不落目标应用日志（URL fragment 不进服务端）；
 *   - 兑换时实时校验用户状态（冻结/离职即时失效）；agent 票据在签发侧校验「owner / 绑定用户 / 管理员」，
 *     兑换侧不做资源级授权（授权语义在签发时已定格并审计）；
 *   - 签发与兑换均入审计（可按 *.entry.ticket.* 检索直达链路）。
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'

export interface EntryTicketRecord extends RecordBase {
  /** 票据本体即主键（etk_ + 256bit 随机值）；兑换后立即置 consumedAt。
   *  refType 'self'：登录人类自助签发（交接清单 G1 跨源自举回跳），refId 即签发人 userId。 */
  refType: 'agent' | 'app' | 'self'
  refId: string
  userId: string
  issuedBy: string
  expiresAt: string
  consumedAt?: string
  consumedIp?: string
}

export interface EntryTicketIdentity {
  sub: string
  username: string
  name: string
  org: { id: string; name: string; tenantId: string } | null
  roles: string[]
  tenant: string
}

const DEFAULT_TTL_SECONDS = 120

export class EntryTicketService extends Service {
  static readonly provide = 'entryTickets'
  static readonly inject = ['opsStorage', 'iam']

  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context) {
    super(ctx, 'entryTickets')
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 24 * 3600_000)
    this.cleanupTimer.unref?.() // OPT-P3-02
    ctx.effect(() => () => {
      if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    })
  }

  static ttlSeconds(): number {
    const raw = Number(process.env.ENTRY_TICKET_TTL_SECONDS ?? DEFAULT_TTL_SECONDS) || DEFAULT_TTL_SECONDS
    return Math.min(600, Math.max(30, Math.floor(raw)))
  }

  tickets(): Collection<EntryTicketRecord> {
    return this.ctx.opsStorage.collection<EntryTicketRecord>('authn:entryTickets')
  }

  /** 签发：调用方（console 端点）已完成资源存在性、human 身份与使用授权校验并落审计；此处校验用户状态。
   *  maxTtlSeconds：票种 TTL 硬上限（self 自助票 ≤120s，交接清单 G1——覆盖 env 调高）。 */
  issue(input: { refType: 'agent' | 'app' | 'self'; refId: string; userId: string; userName: string }, options: { maxTtlSeconds?: number } = {}): { ticket: string; expiresAt: string; ttlSeconds: number } {
    const user = this.ctx.iam.users().get(input.userId)
    if (!user) throw new Error(t('用户不存在'))
    if (user.status !== 'active') throw new Error(t('账号状态异常，无法签发入场票据'))
    const ttlSeconds = Math.min(EntryTicketService.ttlSeconds(), options.maxTtlSeconds ?? EntryTicketService.ttlSeconds())
    const ticket = 'etk_' + randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
    this.tickets().insert({
      id: ticket,
      refType: input.refType,
      refId: input.refId,
      userId: input.userId,
      issuedBy: input.userName,
      expiresAt,
    })
    return { ticket, expiresAt, ttlSeconds }
  }

  /**
   * 兑换：一次性消费 → 实时校验用户状态 → 返回资源指向与标准化身份（审计由路由层写入）。
   * 票据熵 256bit 且一次性，不做 IP 限流（错误尝试无爆破收益，锁定只会伤及共享出口的正常用户）。
   */
  redeem(ticket: string, clientIp: string): { refType: EntryTicketRecord['refType']; refId: string; expiresAt: string; identity: EntryTicketIdentity } {
    const record = this.tickets().get(String(ticket ?? ''))
    if (!record) throw new Error(t('入场票据无效'))
    if (record.consumedAt) throw new Error(t('入场票据已被使用（一次性，防重放）'))
    if (new Date(record.expiresAt).getTime() < Date.now()) throw new Error(t('入场票据已过期，请从控制台重新打开'))
    this.tickets().update(record.id, { consumedAt: new Date().toISOString(), consumedIp: clientIp })
    const user = this.ctx.iam.users().get(record.userId)
    if (!user || user.status !== 'active') throw new Error(t('签发用户状态异常（冻结/离职联动失效）'))
    const org = this.ctx.iam.orgs().get(user.orgId)
    return {
      refType: record.refType,
      refId: record.refId,
      expiresAt: record.expiresAt,
      identity: {
        sub: user.id,
        username: user.username,
        name: user.displayName,
        org: org ? { id: org.id, name: org.name, tenantId: org.tenantId ?? 't_default' } : null,
        roles: user.roleIds.map((roleId) => this.ctx.iam.roles().get(roleId)?.code).filter(Boolean),
        tenant: org?.tenantId ?? 't_default',
      },
    }
  }

  /** 过期票据 24h 清理（已消费/未消费一并无留存价值）。 */
  private cleanupExpired(): number {
    let removed = 0
    for (const record of this.tickets().all()) {
      if (new Date(record.expiresAt).getTime() < Date.now() - 24 * 3600_000 && this.tickets().remove(record.id)) removed++
    }
    return removed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    entryTickets: EntryTicketService
  }
}
