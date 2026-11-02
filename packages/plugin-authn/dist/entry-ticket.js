import { randomBytes } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { t } from "../../platform-i18n/dist/index.js";
const DEFAULT_TTL_SECONDS = 120;
class EntryTicketService extends Service {
  static provide = "entryTickets";
  static inject = ["opsStorage", "iam"];
  cleanupTimer;
  constructor(ctx) {
    super(ctx, "entryTickets");
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 24 * 36e5);
    this.cleanupTimer.unref?.();
    ctx.effect(() => () => {
      if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    });
  }
  static ttlSeconds() {
    const raw = Number(process.env.ENTRY_TICKET_TTL_SECONDS ?? DEFAULT_TTL_SECONDS) || DEFAULT_TTL_SECONDS;
    return Math.min(600, Math.max(30, Math.floor(raw)));
  }
  tickets() {
    return this.ctx.opsStorage.collection("authn:entryTickets");
  }
  /** 签发：调用方（console 端点）已完成资源存在性、human 身份与使用授权校验并落审计；此处校验用户状态。
   *  maxTtlSeconds：票种 TTL 硬上限（self 自助票 ≤120s，交接清单 G1——覆盖 env 调高）。 */
  issue(input, options = {}) {
    const user = this.ctx.iam.users().get(input.userId);
    if (!user) throw new Error(t("\u7528\u6237\u4E0D\u5B58\u5728"));
    if (user.status !== "active") throw new Error(t("\u8D26\u53F7\u72B6\u6001\u5F02\u5E38\uFF0C\u65E0\u6CD5\u7B7E\u53D1\u5165\u573A\u7968\u636E"));
    const ttlSeconds = Math.min(EntryTicketService.ttlSeconds(), options.maxTtlSeconds ?? EntryTicketService.ttlSeconds());
    const ticket = "etk_" + randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlSeconds * 1e3).toISOString();
    this.tickets().insert({
      id: ticket,
      refType: input.refType,
      refId: input.refId,
      userId: input.userId,
      issuedBy: input.userName,
      expiresAt
    });
    return { ticket, expiresAt, ttlSeconds };
  }
  /**
   * 兑换：一次性消费 → 实时校验用户状态 → 返回资源指向与标准化身份（审计由路由层写入）。
   * 票据熵 256bit 且一次性，不做 IP 限流（错误尝试无爆破收益，锁定只会伤及共享出口的正常用户）。
   */
  redeem(ticket, clientIp) {
    const record = this.tickets().get(String(ticket ?? ""));
    if (!record) throw new Error(t("\u5165\u573A\u7968\u636E\u65E0\u6548"));
    if (record.consumedAt) throw new Error(t("\u5165\u573A\u7968\u636E\u5DF2\u88AB\u4F7F\u7528\uFF08\u4E00\u6B21\u6027\uFF0C\u9632\u91CD\u653E\uFF09"));
    if (new Date(record.expiresAt).getTime() < Date.now()) throw new Error(t("\u5165\u573A\u7968\u636E\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u4ECE\u63A7\u5236\u53F0\u91CD\u65B0\u6253\u5F00"));
    this.tickets().update(record.id, { consumedAt: (/* @__PURE__ */ new Date()).toISOString(), consumedIp: clientIp });
    const user = this.ctx.iam.users().get(record.userId);
    if (!user || user.status !== "active") throw new Error(t("\u7B7E\u53D1\u7528\u6237\u72B6\u6001\u5F02\u5E38\uFF08\u51BB\u7ED3/\u79BB\u804C\u8054\u52A8\u5931\u6548\uFF09"));
    const org = this.ctx.iam.orgs().get(user.orgId);
    return {
      refType: record.refType,
      refId: record.refId,
      expiresAt: record.expiresAt,
      identity: {
        sub: user.id,
        username: user.username,
        name: user.displayName,
        org: org ? { id: org.id, name: org.name, tenantId: org.tenantId ?? "t_default" } : null,
        roles: user.roleIds.map((roleId) => this.ctx.iam.roles().get(roleId)?.code).filter(Boolean),
        tenant: org?.tenantId ?? "t_default"
      }
    };
  }
  /** 过期票据 24h 清理（已消费/未消费一并无留存价值）。 */
  cleanupExpired() {
    let removed = 0;
    for (const record of this.tickets().all()) {
      if (new Date(record.expiresAt).getTime() < Date.now() - 24 * 36e5 && this.tickets().remove(record.id)) removed++;
    }
    return removed;
  }
}
export {
  EntryTicketService
};
