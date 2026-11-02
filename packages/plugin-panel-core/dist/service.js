import { createHash } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { PlatformEvents } from "../../platform-core/dist/bus.js";
import { ACTIVITY_LABELS } from "../../platform-core/dist/scenegraph.js";
import { newId } from "../../platform-core/dist/ids.js";
import { resolvePanelModelGateway } from "./llm-bridge.js";
const INDUSTRY_REGISTRY = [
  { code: "YB01", name: "\u94A2\u94C1\u884C\u4E1A", icon: "\u{1F3ED}", sub: "\u94C1\u524D/\u70BC\u94C1/\u70BC\u94A2/\u8F67\u94A2 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 98 \u573A\u666F" },
  { code: "SH01", name: "\u77F3\u5316\u884C\u4E1A", icon: "\u{1F6E2}\uFE0F", sub: "\u70BC\u5236/\u6709\u673A\u5316\u5B66\u54C1/\u9AD8\u5206\u5B50 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 90 \u573A\u666F" },
  { code: "JB01", name: "\u5DE5\u7A0B\u673A\u68B0\u884C\u4E1A", icon: "\u{1F69C}", sub: "\u7814\u53D1\u8BBE\u8BA1/\u96F6\u90E8\u4EF6/\u603B\u88C5/\u8425\u9500\u670D\u52A1 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 46 \u573A\u666F" },
  { code: "QC01", name: "\u65B0\u80FD\u6E90\u6C7D\u8F66\u884C\u4E1A", icon: "\u{1F697}", sub: "\u57FA\u7840\u6750\u6599/\u4E09\u7535/\u6574\u8F66/\u667A\u80FD\u7F51\u8054 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 96 \u573A\u666F" },
  { code: "JB02", name: "\u673A\u5668\u4EBA\u884C\u4E1A", icon: "\u{1F916}", sub: "\u6838\u5FC3\u96F6\u90E8\u4EF6/\u672C\u4F53/\u96C6\u6210\u5E94\u7528 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 75 \u573A\u666F" },
  { code: "WS01", name: "\u533B\u7597\u88C5\u5907\u884C\u4E1A", icon: "\u{1F3E5}", sub: "\u6750\u6599/\u90E8\u4EF6/\u6574\u673A/\u670D\u52A1 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 117 \u573A\u666F" },
  { code: "QB01", name: "\u5BB6\u7535\u884C\u4E1A", icon: "\u{1F4FA}", sub: "\u6574\u673A/\u7ED3\u6784\u4EF6/\u4EA4\u4E92\u611F\u77E5/\u7535\u63A7/\u6838\u5FC3\u96F6\u90E8\u4EF6 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 73 \u573A\u666F" },
  { code: "QB02", name: "\u5236\u7CD6\u884C\u4E1A", icon: "\u{1F36C}", sub: "\u7CD6\u6599/\u538B\u69A8/\u5236\u70BC/\u6210\u54C1\u6D41\u901A \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 22 \u573A\u666F" },
  { code: "QB03", name: "\u767D\u9152\u884C\u4E1A", icon: "\u{1F376}", sub: "\u5236\u66F2/\u917F\u9020/\u50A8\u5B58/\u5305\u88C5/\u4F9B\u5E94\u94FE \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 44 \u573A\u666F" },
  { code: "QB04", name: "\u7F8E\u5986\u65E5\u5316\u884C\u4E1A", icon: "\u{1F484}", sub: "\u4EA7\u54C1\u5F00\u53D1/\u751F\u4EA7\u5236\u9020/\u6E20\u9053\u8FD0\u8425 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 32 \u573A\u666F" },
  { code: "SJ01", name: "\u9502\u7535\u6C60\u884C\u4E1A", icon: "\u{1F50B}", sub: "\u9502\u76D0/\u4E3B\u6750/\u7535\u82AF/\u7535\u6C60\u5305 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 73 \u573A\u666F" },
  { code: "SJ02", name: "\u5370\u5236\u677F\u884C\u4E1A", icon: "\u{1F7E9}", sub: "\u8986\u94DC\u677F/PCB \u5236\u9020/PCBA \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 43 \u573A\u666F" },
  { code: "SJ03", name: "\u667A\u80FD\u79FB\u52A8\u7EC8\u7AEF\u884C\u4E1A", icon: "\u{1F4F1}", sub: "\u7814\u53D1\u8BBE\u8BA1/\u751F\u4EA7\u51C6\u5907/\u7EC4\u4EF6/\u6574\u673A \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 61 \u573A\u666F" },
  { code: "WJ01", name: "\u6C11\u7206\u884C\u4E1A", icon: "\u26A0\uFE0F", sub: "\u539F\u6750/\u7EC4\u4EF6/\u96F7\u7BA1\u88C5\u914D/\u9500\u552E\u4ED3\u50A8 \xB7 \u4E00\u56FE\u56DB\u6E05\u5355 \xB7 15 \u573A\u666F" }
];
const TASK_LANES = ["todo", "doing", "review", "done"];
const LANE_LABELS = { todo: "\u5F85\u529E", doing: "\u8FDB\u884C\u4E2D", review: "\u5F85\u5BA1", done: "\u5B8C\u6210" };
class PanelService extends Service {
  static provide = "panel";
  streamSubscribers = /* @__PURE__ */ new Map();
  constructor(ctx, config = {}) {
    super(ctx, "panel");
    void config;
  }
  /**
   * 可选宿主服务软读（plan-gate01 Phase 2 瘦身）：cordis 4.x 无 optional inject 语法，
   * 未声明键的 ctx.<key> 访问在激活插件内硬抛 without inject（spike 定稿）——9 个可选键
   * （iam/authn/audit/usage/modelGateway/resourceCore/behavior/mcpRegistry/skillHub）统一走
   * ctx.reflect.get(key, false)：有提供者=实例（全量形态语义不变），无=undefined
   * （01门演示态两级降级：记录类空记录 / 能力类诚实降级），绝不裸访问。
   */
  soft(key) {
    return this.ctx.reflect.get(key, false);
  }
  // -- 集合 -----------------------------------------------------------------
  deptConfigs() {
    return this.ctx.opsStorage.collection("panel:deptConfigs");
  }
  channels() {
    return this.ctx.opsStorage.collection("panel:channels");
  }
  messages() {
    const collection = this.ctx.opsStorage.collection("panel:messages");
    collection.uniqueOn("bridge-dedup", (m) => m.uniqueKey ? `${m.channelId}:${m.uniqueKey}` : `id:${m.id}`);
    return collection;
  }
  tasks() {
    return this.ctx.opsStorage.collection("panel:tasks");
  }
  artifacts() {
    return this.ctx.opsStorage.collection("panel:artifacts");
  }
  readCursors() {
    const collection = this.ctx.opsStorage.collection("panel:readCursors");
    collection.uniqueOn("user-channel", (r) => `${r.userId}:${r.channelId}`);
    return collection;
  }
  activations() {
    return this.ctx.opsStorage.collection("panel:activations");
  }
  // -- 部门与行业 ------------------------------------------------------------
  dept(dept) {
    const config = this.deptConfigs().get(dept);
    if (!config) throw new Error(`\u90E8\u95E8\u4E0D\u5B58\u5728\uFF1A${dept}`);
    return config;
  }
  /** 计量/激活用的组织主键：登录人所属组织（org 树根归一由调用方保证存在）。 */
  activeIndustry(orgId) {
    const activation = this.activations().findOne((item) => item.orgId === orgId && item.status === "active");
    if (!activation) return void 0;
    const registry = INDUSTRY_REGISTRY.find((item) => item.code === activation.code);
    return { code: activation.code.toLowerCase(), name: registry?.name ?? activation.code };
  }
  // -- 账号组织打通：部门 ↔ 平台组织 -----------------------------------------
  /** 组织子树包含判定（orgId 沿 parentId 上溯到 rootId）。组织目录缺失（演示态）fail-closed。 */
  orgSubtreeContains(rootId, orgId) {
    const iam = this.soft("iam");
    if (!iam) return false;
    let current = iam.orgs().get(orgId);
    let guard = 0;
    while (current && guard++ < 32) {
      if (current.id === rootId) return true;
      current = current.parentId ? iam.orgs().get(current.parentId) : void 0;
    }
    return false;
  }
  /** 绑定组织信息（名称实时解析，组织改名不落陈旧数据）。组织目录缺失时诚实显示未绑定。 */
  deptOrg(dept) {
    if (!dept.orgId) return void 0;
    const org = this.soft("iam")?.orgs().get(dept.orgId);
    return org ? { id: org.id, name: org.name } : void 0;
  }
  /**
   * 部门范围权限（权限控制 × 组织归属双通道）：'*' 管理员与机器凭证（经 scope 授权的集成面）
   * 直通；绑定组织后，人必须属于该组织子树；未绑定部门对所有 panel.read 持有者开放。
   * org_admin 角色跨部门治理豁免（与 iam.* 的治理语义一致）。
   */
  deptScopeAllowed(exchangeCaller, dept) {
    if (exchangeCaller.permissions.includes("*")) return true;
    if (exchangeCaller.kind === "machine") return true;
    if (!dept.orgId) return true;
    if (exchangeCaller.userId) {
      const iam = this.soft("iam");
      const user = iam?.users().get(exchangeCaller.userId);
      if (user) {
        const isOrgAdmin = user.roleIds.some((roleId) => iam?.roles().get(roleId)?.code === "org_admin");
        if (isOrgAdmin) return true;
        return this.orgSubtreeContains(dept.orgId, user.orgId);
      }
    }
    return false;
  }
  /** 部门名册：绑定组织（或全组织兜底）子树内的成员（最小 PII：姓名/职务/组织名）。组织目录缺失（演示态）→ 空名册。 */
  deptMembers(dept, limit = 50) {
    const iam = this.soft("iam");
    if (!iam) return [];
    const orgRoot = dept.orgId ?? iam.orgs().find((org) => org.parentId === null).at(0)?.id;
    if (!orgRoot) return [];
    const inScope = (orgId) => this.orgSubtreeContains(orgRoot, orgId);
    const orgName = (orgId) => iam.orgs().get(orgId)?.name ?? "";
    return iam.users().all().filter((user) => user.status === "active" && inScope(user.orgId)).slice(0, limit).map((user) => ({ id: user.id, name: user.displayName, ...user.title ? { title: user.title } : {}, orgName: orgName(user.orgId) }));
  }
  /** 计量键（D1 裁决）：panel:<dept>.<行业code 小写>；无激活行业回落 panel:<dept>.core。 */
  meterResource(dept, orgId) {
    const industry = this.activeIndustry(orgId);
    return `panel:${dept}.${industry?.code ?? "core"}`;
  }
  /** 行业三态（选择器）：active 激活 / pending 审批在办 / locked 待授权。 */
  industryStates(orgId, pendingCodes) {
    return INDUSTRY_REGISTRY.map((entry) => {
      const active = this.activations().findOne((item) => item.orgId === orgId && item.code === entry.code && item.status === "active");
      const graphLoaded = this.ctx.scenegraphs.get(entry.code) !== void 0;
      const pending = !active && pendingCodes.includes(entry.code);
      return { ...entry, state: active ? "active" : pending ? "pending" : "locked", graphLoaded };
    });
  }
  /**
   * 行业激活执行器（audit approvals executor）：审批通过 → 置 active + grantCapabilities + 事件。
   * review D6 裁决：复用审批链 + 能力授权，license 签发链路（Ed25519 平台私钥）留待 Phase 4。
   */
  buildActivationExecutor() {
    return async (payload, approverId) => {
      const code = String(payload.code ?? "");
      const orgId = String(payload.orgId ?? "");
      if (!code || !orgId) throw new Error("\u884C\u4E1A\u6FC0\u6D3B\u5BA1\u6279\u5355\u7F3A\u5C11 code/orgId");
      if (!INDUSTRY_REGISTRY.some((item) => item.code === code)) throw new Error(`\u672A\u767B\u8BB0\u884C\u4E1A\uFF1A${code}`);
      const existing = this.activations().findOne((item) => item.orgId === orgId && item.code === code);
      if (existing) {
        this.activations().update(existing.id, { status: "active", activatedAt: (/* @__PURE__ */ new Date()).toISOString(), activatedBy: approverId });
      } else {
        this.activations().insert({ id: newId("act"), code, orgId, status: "active", activatedAt: (/* @__PURE__ */ new Date()).toISOString(), approvalId: String(payload.approvalId ?? ""), activatedBy: approverId });
      }
      try {
        this.soft("usage")?.grantCapabilities(`org:${orgId}`, [`panel:${code.toLowerCase()}`], "industry-activation");
      } catch {
      }
      this.ctx.platformBus.emit(PlatformEvents.PanelIndustryActivated, { code, orgId, activatedBy: approverId });
      return { code, orgId, status: "active" };
    };
  }
  /** Agent 阵容 × Agent 资产联动：绑定资产的存在性与生命周期状态实时解析（宿主数字员工在线面）。资产目录缺失（演示态）→ 未绑定展示。 */
  agentWithAsset(agentCard) {
    const ref = agentCard.agentRef?.replace(/^agent:/, "") ?? "";
    if (!ref) return { ...agentCard };
    const asset = this.soft("resourceCore")?.list("agent").find((item) => item.id === ref || item.slug === ref || item.name === ref);
    if (!asset) return { ...agentCard };
    const attrs = asset.attrs;
    return {
      ...agentCard,
      asset: {
        id: asset.id,
        ...asset.slug ? { slug: asset.slug } : {},
        name: asset.name,
        status: String(asset.status ?? "draft"),
        ...attrs?.model ? { model: String(attrs.model) } : {}
      }
    };
  }
  // -- widget 求值（照抄 portal.board() 的逐源独立降级范式） -------------------
  resolveWidgetSource(widget) {
    const labels = { manual: "\u624B\u5DE5\u767B\u8BB0", mock: "\u6A21\u62DF\u6570\u636E", connector: "\u8FDE\u63A5\u5668", mcp: "MCP" };
    if (widget.source === "manual" || widget.source === "mock") {
      return { rows: widget.rows, degraded: false, sourceLabel: labels[widget.source] };
    }
    return {
      rows: [],
      degraded: true,
      sourceLabel: `${labels[widget.source]}\uFF08${widget.ref ?? "\u672A\u914D\u7F6E"}\uFF09\u6682\u4E0D\u53EF\u7528\u2014\u2014\u7B49\u5F85\u4E1A\u52A1\u8FDE\u63A5\u5668\u63A5\u5165`
    };
  }
  /** 部门看板聚合：全部 widget 独立求值降级（单块故障不拖垮整板）。 */
  board(dept) {
    return dept.widgets.map((widget) => {
      try {
        const resolved = this.resolveWidgetSource(widget);
        return { id: widget.id, type: widget.type, title: widget.title, ...widget.live ? { live: true } : {}, source: resolved.sourceLabel, degraded: resolved.degraded, rows: resolved.rows };
      } catch {
        return { id: widget.id, type: widget.type, title: widget.title, source: "\u6C42\u503C\u5931\u8D25", degraded: true, rows: [] };
      }
    });
  }
  // -- 消息与频道 --------------------------------------------------------------
  /** 未读数：频道内 lastReadAt 之后的非本人消息数。 */
  unreadCount(userId, channelId) {
    const cursor = this.readCursors().findOne((item) => item.userId === userId && item.channelId === channelId);
    const since = cursor?.at ?? "";
    return this.messages().find((m) => m.channelId === channelId && m.createdAt > since && m.senderId !== userId).length;
  }
  markRead(userId, channelId) {
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const cursor = this.readCursors().findOne((item) => item.userId === userId && item.channelId === channelId);
    if (cursor) this.readCursors().update(cursor.id, { at });
    else this.readCursors().insert({ id: newId("cur"), userId, channelId, at });
  }
  /**
   * 发消息：落库 → 游标推进 → 事件（钉钉桥接订阅投递）→ @Agent 唤起。
   * 返回落库消息；Agent 回包异步追加（调用方随后拉取即可）。
   */
  async sendMessage(input) {
    const channel = this.channels().get(input.channelId);
    if (!channel || channel.dept !== input.dept) throw new Error(`\u9891\u9053\u4E0D\u5B58\u5728\u6216\u4E0D\u5C5E\u4E8E\u8BE5\u90E8\u95E8\uFF1A${input.channelId}`);
    const mentions = extractMentions(input.text);
    const record = this.messages().insert({
      id: newId("pmsg"),
      channelId: input.channelId,
      dept: input.dept,
      senderType: input.senderType,
      ...input.senderId ? { senderId: input.senderId } : {},
      senderName: input.senderName,
      text: input.text,
      mentions,
      ...input.senderType === "agent" && input.senderIcon ? { senderIcon: input.senderIcon } : {},
      ...input.senderType === "agent" && input.agentName ? { agentName: input.agentName } : {},
      ...input.senderType === "agent" && input.replyModel ? { model: input.replyModel } : {},
      ...input.card ? { card: { ...input.card, done: [] } } : {},
      ddSync: input.senderType === "system" ? "none" : input.ddSync ? "pending" : "none",
      ...input.sceneCode ? { sceneCode: input.sceneCode } : {},
      ...input.uniqueKey ? { uniqueKey: input.uniqueKey } : {}
    });
    if (input.senderId) this.markRead(input.senderId, input.channelId);
    this.ctx.platformBus.emit(PlatformEvents.PanelMessageCreated, {
      messageId: record.id,
      dept: input.dept,
      channelId: input.channelId,
      senderName: input.senderName,
      text: input.text,
      ddSync: record.ddSync,
      card: record.card,
      title: record.card?.title ?? ""
    });
    if (input.senderType === "human" && input.skipAgentDispatch !== true) void this.dispatchAgentMentions(record, input.modelOverride);
    return record;
  }
  /**
   * panelAgentRuntime MVP（单轮）：@Agent 唤起 → Agent 资产 → modelgw 单轮 → 回包落库。
   * 模型取向：对话框显式指定的 modelOverride 优先，否则跟随 Agent 资产的 model 属性。
   * 未绑定资产/无模型可用 → 诚实降级消息 + 转人工待办，不造假回复。
   */
  async dispatchAgentMentions(message, modelOverride) {
    const dept = this.dept(message.dept);
    for (const agentCard of dept.agents) {
      if (!message.text.includes(`@${agentCard.name}`)) continue;
      await this.invokeAgent(dept, agentCard, message, modelOverride);
    }
  }
  /** Agent 应答落库 + 事件广播（invokeAgent / streamAgentReply 共用；V16/D08 分型标注随事件透传）。 */
  async insertAgentReply(dept, agentCard, trigger, text, card, usedModel, workforce) {
    const record = this.messages().insert({
      id: newId("pmsg"),
      channelId: trigger.channelId,
      dept: dept.id,
      senderType: "agent",
      senderName: agentCard.name,
      senderIcon: agentCard.icon,
      text,
      mentions: [],
      ...card ? { card: { ...card, done: [] } } : {},
      ddSync: "none",
      agentName: agentCard.name,
      ...usedModel ? { model: usedModel } : {},
      ...trigger.sceneCode ? { sceneCode: trigger.sceneCode } : {}
    });
    this.ctx.platformBus.emit(PlatformEvents.PanelMessageCreated, {
      messageId: record.id,
      dept: dept.id,
      channelId: trigger.channelId,
      senderName: agentCard.name,
      text,
      ddSync: "none",
      card: record.card,
      title: record.card?.title ?? "",
      // V16/D08 additive 分型标注（命中受管员工才出现；面板 SSE 扇出原样透传，前端按需消费）
      ...workforce ? { workforce } : {}
    });
    return record;
  }
  /**
   * Agent 调用前置解析（invokeAgent / streamAgentReply 共用）：资产绑定 → 模型取向 →
   * 频道上下文 + 部门场景图谱摘要组装。返回 ok:false 时 reason 为可展示的诚实降级文案；
   * ok 载荷携带 asset（审计 resourceId 与 V16/D08 分型探测的依据）。
   */
  prepareAgentInvocation(dept, agentCard, trigger, modelOverride, contextNote) {
    const channel = this.channels().get(trigger.channelId);
    const ref = agentCard.agentRef?.replace(/^agent:/, "") ?? "";
    const asset = ref ? this.soft("resourceCore")?.list("agent").find((item) => item.id === ref || item.slug === ref || item.name === ref) : void 0;
    if (!asset) return { ok: false, reason: "\u672A\u7ED1\u5B9A Agent \u8D44\u4EA7\uFF08\u8BF7\u5728\u63A7\u5236\u53F0\u300CAgent \u672C\u4F53\u300D\u767B\u8BB0\u5E76\u5728\u6B64\u914D\u7F6E agentRef\uFF09" };
    const preferred = modelOverride ?? String(asset.attrs?.model ?? "");
    const resolved = resolvePanelModelGateway(this.ctx);
    const catalog = resolved?.gateway.models?.().all?.() ?? [];
    const online = catalog.filter((item) => item.status === "online");
    let model = preferred;
    if (!model || !catalog.some((item) => item.slug === model)) {
      if (online.length > 0) model = online[0].slug;
      else if (resolved?.kind === "dsh") model = "default";
    }
    if (!model) return { ok: false, reason: "Agent \u8D44\u4EA7\u672A\u914D\u7F6E\u6A21\u578B\uFF08model \u5C5E\u6027\u4E3A\u7A7A\uFF09\uFF0C\u4E14\u672C\u6B21\u4F1A\u8BDD\u672A\u6307\u5B9A\u6A21\u578B" };
    const recent = this.messages().find((m) => m.channelId === trigger.channelId).slice(-8);
    const contextText = recent.map((m) => `${m.senderName}: ${m.text}`).join("\n");
    const sceneSummary = this.sceneSummaryForDept(dept);
    const systemPrompt = [
      String(asset.attrs?.systemPrompt ?? `\u4F60\u662F\u4F01\u4E1A\u90E8\u95E8\u534F\u4F5C\u9762\u677F\u4E2D\u7684\u6570\u5B57\u540C\u4E8B\u300C${agentCard.name}\u300D\uFF08${agentCard.desc}\uFF09\u3002`),
      sceneSummary ? `\u672C\u90E8\u95E8\u6302\u8F7D\u7684\u884C\u4E1A\u573A\u666F\u56FE\u8C31\u8981\u70B9\uFF1A
${sceneSummary}` : "",
      contextNote ?? "",
      channel ? `\u4EE5\u4E0B\u662F\u9891\u9053\u300C${channel.name}\u300D\u6700\u8FD1\u5BF9\u8BDD\uFF1A
${contextText}` : ""
    ].filter(Boolean).join("\n\n");
    return { ok: true, model, systemPrompt, userText: trigger.text, asset: { id: asset.id } };
  }
  /** Agent 调用后的协作计量（D1 裁决键格式；org 兜底链解析失败才跳过，计量失败不阻塞协作面）。 */
  meterAgentCall(dept, trigger, agentCard) {
    const orgId = this.resolveOrgId(trigger.senderId, dept).orgId;
    if (!orgId) return;
    try {
      this.soft("usage")?.record({
        org: orgId,
        subject: trigger.senderId ? `user:${trigger.senderId}` : "panel:runtime",
        principal: `org:${orgId}`,
        resource: this.meterResource(dept.id, orgId),
        meters: [{ key: "calls", value: 1, unit: "call" }],
        idempotency_key: `panel:agent:${trigger.id}:${agentCard.name}`
      });
    } catch {
    }
  }
  async invokeAgent(dept, agentCard, trigger, modelOverride) {
    const reply = (text, card, usedModel, workforce2) => this.insertAgentReply(dept, agentCard, trigger, text, card, usedModel, workforce2);
    const fallbackToHuman = async (reason) => {
      await reply(`\u300C${agentCard.name}\u300D\u6682\u4E0D\u80FD\u81EA\u4E3B\u5E94\u7B54\uFF1A${reason}\u5DF2\u8F6C\u4EBA\u5DE5\u5F85\u529E\uFF0C\u8BF7\u76F8\u5173\u540C\u4E8B\u8DDF\u8FDB\u3002`);
      this.tasks().insert({
        id: newId("ptask"),
        dept: dept.id,
        title: `\u8DDF\u8FDB\uFF1A${trigger.text.slice(0, 40)}`,
        detail: `Agent\u300C${agentCard.name}\u300D\u4E0D\u53EF\u7528\uFF08${reason}\uFF09\uFF0C\u7531\u6D88\u606F ${trigger.id} \u8F6C\u4EBA\u5DE5`,
        lane: "todo",
        assigneeType: "human",
        createdBy: `agent:${agentCard.name}`,
        messageId: trigger.id
      });
    };
    const prepared = this.prepareAgentInvocation(dept, agentCard, trigger, modelOverride);
    if (!prepared.ok) return void fallbackToHuman(prepared.reason);
    const workforce = await this.managedWorkforceOf(prepared.asset.id);
    const { orgId, orgSource } = this.resolveOrgId(trigger.senderId, dept);
    try {
      const gateway = resolvePanelModelGateway(this.ctx)?.gateway;
      if (!gateway) throw new Error("\u6A21\u578B\u7F51\u5173\u672A\u63A5\u5165\uFF0801\u95E8\u6F14\u793A\u6001\uFF09\u2014\u2014\u8FDE\u63A5\u5BBF\u4E3B\u540E\u53EF\u7528");
      const result = await gateway.invoke({
        model: prepared.model,
        orgId,
        subject: trigger.senderId ? `user:${trigger.senderId}` : "panel:runtime",
        messages: [
          { role: "system", content: prepared.systemPrompt },
          { role: "user", content: prepared.userText }
        ]
      });
      await reply(stripThink(result.content), void 0, result.model, workforce);
      this.auditSafe({
        type: "invoke",
        actorType: "machine",
        actorId: `agent:${agentCard.name}`,
        actorName: agentCard.name,
        action: "panel.agent.invoke",
        resourceType: "agent",
        resourceId: prepared.asset.id,
        resourceName: agentCard.name,
        // V16：审计口径=问答/协作（panel.agent.invoke 非执行链）；受管员工命中时随 detail 留分型标注
        result: "ok",
        detail: `model=${result.model} tokens=${result.inputTokens}/${result.outputTokens} org=${orgSource}${workforce ? `\uFF1Bworkforce=\u53D7\u7BA1\u5458\u5DE5(${workforce.employeeId})\uFF0C${workforce.notice}` : ""}`,
        ...trigger.sceneCode ? { sceneCode: trigger.sceneCode } : {}
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await fallbackToHuman(`\u6A21\u578B\u7F51\u5173\u8C03\u7528\u5931\u8D25\uFF08${message}\uFF09\u3002`);
      this.auditSafe({
        type: "invoke",
        actorType: "machine",
        actorId: `agent:${agentCard.name}`,
        actorName: agentCard.name,
        action: "panel.agent.invoke",
        resourceType: "agent",
        resourceId: prepared.asset.id,
        resourceName: agentCard.name,
        result: "error",
        detail: `model=${prepared.model} \u5931\u8D25\uFF1A${message}`,
        ...trigger.sceneCode ? { sceneCode: trigger.sceneCode } : {}
      });
    } finally {
      this.meterAgentCall(dept, trigger, agentCard);
    }
  }
  /**
   * Agent 流式应答（2026-09-11 用户需求：频道内 @数字同事 → SSE 增量卡片）：
   * onEvent 收 {type:'start'|'delta'|'done'|'fallback'}；dsh 模型桥走原生 text-delta 流，
   * modelgw（单轮 invoke）整段作为单个 delta 下发——通道能力不同，流式语义一致。
   * 完成后照常落库 + 广播（其他端经 SSE 收到持久消息）；降级与转人工语义与 invokeAgent 一致。
   */
  async streamAgentReply(dept, agentCard, trigger, modelOverride, onEvent) {
    onEvent({ type: "start", agent: agentCard.name, icon: agentCard.icon });
    const fallback = async (reason) => {
      onEvent({ type: "fallback", agent: agentCard.name, reason });
      await this.insertAgentReply(dept, agentCard, trigger, `\u300C${agentCard.name}\u300D\u6682\u4E0D\u80FD\u81EA\u4E3B\u5E94\u7B54\uFF1A${reason}\u5DF2\u8F6C\u4EBA\u5DE5\u5F85\u529E\uFF0C\u8BF7\u76F8\u5173\u540C\u4E8B\u8DDF\u8FDB\u3002`);
      this.tasks().insert({
        id: newId("ptask"),
        dept: dept.id,
        title: `\u8DDF\u8FDB\uFF1A${trigger.text.slice(0, 40)}`,
        detail: `Agent\u300C${agentCard.name}\u300D\u4E0D\u53EF\u7528\uFF08${reason}\uFF09\uFF0C\u7531\u6D88\u606F ${trigger.id} \u8F6C\u4EBA\u5DE5`,
        lane: "todo",
        assigneeType: "human",
        createdBy: `agent:${agentCard.name}`,
        messageId: trigger.id
      });
      onEvent({ type: "done", agent: agentCard.name });
    };
    const prepared = this.prepareAgentInvocation(dept, agentCard, trigger, modelOverride);
    if (!prepared.ok) return void fallback(prepared.reason);
    const workforce = await this.managedWorkforceOf(prepared.asset.id);
    const { orgId, orgSource } = this.resolveOrgId(trigger.senderId, dept);
    try {
      const resolved = resolvePanelModelGateway(this.ctx);
      if (!resolved) throw new Error("\u6A21\u578B\u7F51\u5173\u672A\u63A5\u5165\uFF0801\u95E8\u6F14\u793A\u6001\uFF09\u2014\u2014\u8FDE\u63A5\u5BBF\u4E3B\u540E\u53EF\u7528");
      const gateway = resolved.gateway;
      const messages = [
        { role: "system", content: prepared.systemPrompt },
        { role: "user", content: prepared.userText }
      ];
      let content = "";
      let usedModel = "";
      const gatedDelta = createThinkGate((text) => {
        onEvent({ type: "delta", agent: agentCard.name, text, model: usedModel || void 0 });
      });
      if (typeof gateway.streamEvents === "function") {
        for await (const chunk of gateway.streamEvents({
          model: prepared.model,
          orgId,
          messages,
          subject: trigger.senderId ? `user:${trigger.senderId}` : "panel:runtime"
        })) {
          if (chunk.model) usedModel = chunk.model;
          if (chunk.delta) {
            content += chunk.delta;
            gatedDelta(chunk.delta);
          }
        }
      } else {
        const result = await gateway.invoke({
          model: prepared.model,
          orgId,
          subject: trigger.senderId ? `user:${trigger.senderId}` : "panel:runtime",
          messages
        });
        content = result.content;
        usedModel = result.model;
        gatedDelta(result.content);
      }
      const finalContent = stripThink(content);
      if (!finalContent) {
        await fallback("\u6A21\u578B\u53EA\u8F93\u51FA\u4E86\u601D\u8003\u8FC7\u7A0B\uFF08<think> \u672A\u95ED\u5408\u6216\u6B63\u6587\u4E3A\u7A7A\uFF09\uFF0C\u6CA1\u6709\u53EF\u5C55\u793A\u7684\u5E94\u7B54\u3002");
        return;
      }
      await this.insertAgentReply(dept, agentCard, trigger, finalContent, void 0, usedModel || void 0, workforce);
      onEvent({ type: "done", agent: agentCard.name });
      this.auditSafe({
        type: "invoke",
        actorType: "machine",
        actorId: `agent:${agentCard.name}`,
        actorName: agentCard.name,
        action: "panel.agent.invoke",
        resourceType: "agent",
        resourceId: prepared.asset.id,
        resourceName: agentCard.name,
        result: "ok",
        detail: `model=${usedModel || prepared.model} stream=1 org=${orgSource}${workforce ? `\uFF1Bworkforce=\u53D7\u7BA1\u5458\u5DE5(${workforce.employeeId})\uFF0C${workforce.notice}` : ""}`,
        ...trigger.sceneCode ? { sceneCode: trigger.sceneCode } : {}
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await fallback(`\u6A21\u578B\u7F51\u5173\u8C03\u7528\u5931\u8D25\uFF08${message}\uFF09\u3002`);
      this.auditSafe({
        type: "invoke",
        actorType: "machine",
        actorId: `agent:${agentCard.name}`,
        actorName: agentCard.name,
        action: "panel.agent.invoke",
        resourceType: "agent",
        resourceId: prepared.asset.id,
        resourceName: agentCard.name,
        result: "error",
        detail: `model=${prepared.model} \u5931\u8D25\uFF1A${message}`,
        ...trigger.sceneCode ? { sceneCode: trigger.sceneCode } : {}
      });
    } finally {
      this.meterAgentCall(dept, trigger, agentCard);
    }
  }
  callerOrgId(userId) {
    if (!userId) return "";
    const user = this.soft("iam")?.users().get(userId);
    return user?.orgId ?? "";
  }
  /** 平台首个根组织（无父组织）；组织树未播种（01门演示态）时为 undefined。 */
  rootOrgId() {
    try {
      return this.soft("iam")?.orgs().all().find((org) => !org.parentId)?.id;
    } catch {
      return void 0;
    }
  }
  /**
   * 组织归属解析兜底链（#17，2026-10-29 回植自底座）：调用方用户组织 → 部门绑定组织（R11）→ 平台根组织。
   * 机器主体 / 外部工具通道没有用户归属，此前 orgId 空串直达 modelgw——模型应答后在计量落账处
   * 抛「usage 事件 org 必填」，先花钱后报错；现在调用前即解析出真实归属，orgSource 随审计留痕。
   */
  resolveOrgId(userId, dept) {
    const caller = this.callerOrgId(userId);
    if (caller) return { orgId: caller, orgSource: "caller" };
    const deptOrg = dept?.orgId ?? "";
    if (deptOrg) return { orgId: deptOrg, orgSource: `dept:${dept.id}` };
    const root = this.rootOrgId();
    if (root) return { orgId: root, orgSource: "platform-root" };
    return { orgId: "", orgSource: "unresolved" };
  }
  /**
   * V16/D08 受管数字员工结构化探测：按目标 agentId 经 workforce 窄端口服务端反查
   * （ctx.workforcePolicy.port()?.describeManagedAgent）。端口未就绪 → undefined（保持 legacy
   * 现状）；未命中 → undefined；端口执行异常 → undefined（问答面 fail-open，治理端口故障
   * 不阻塞面板应答）。判定只依据服务端反查，与请求是否携带任何 work 上下文无关（冻结契约）。
   */
  async managedWorkforceOf(agentId) {
    try {
      const registry = this.ctx.workforcePolicy;
      const port = registry?.port?.() ?? null;
      if (!port) return void 0;
      const managed = await port.describeManagedAgent(agentId);
      if (!managed) return void 0;
      return { managed: true, employeeId: managed.employeeId, notice: "\u95EE\u7B54\u7ED3\u679C\uFF0C\u4E0D\u6784\u6210\u4EFB\u52A1\u6267\u884C\u6216\u4EA4\u4ED8\u9A8C\u6536" };
    } catch {
      return void 0;
    }
  }
  /**
   * 面板 Agent 点名问答（M3：panel_agent_invoke 工具的服务原语——dsh 标准对话协作主通道）。
   * 与 invokeAgent 共享资产解析/模型取向/场景摘要组装，但同步返回应答文本、不落频道消息
   * （调用方决定是否经 panel_msg_send 留痕）。失败诚实返回 ok:false + reason，不造假回复。
   */
  async askAgent(deptId, agentName, question, options = {}) {
    const dept = this.dept(deptId);
    const agentCard = dept.agents.find((card) => card.name === agentName);
    if (!agentCard) {
      const names = dept.agents.map((card) => card.name);
      return { ok: false, reason: `\u90E8\u95E8 ${dept.id}\uFF08${dept.label}\uFF09\u540D\u518C\u65E0\u6B64 Agent\u3002\u53EF\u7528\u9635\u5BB9\uFF1A${names.join("\u3001") || "\uFF08\u65E0\uFF09"}` };
    }
    const ref = agentCard.agentRef?.replace(/^agent:/, "") ?? "";
    const asset = ref ? this.soft("resourceCore")?.list("agent").find((item) => item.id === ref || item.slug === ref || item.name === ref) : void 0;
    if (!asset) return { ok: false, reason: `Agent\u300C${agentName}\u300D\u672A\u7ED1\u5B9A Agent \u8D44\u4EA7\uFF08agentRef\uFF09\uFF0C\u65E0\u6CD5\u81EA\u4E3B\u5E94\u7B54` };
    const model = options.modelOverride ?? String(asset.attrs?.model ?? "");
    if (!model) return { ok: false, reason: `Agent\u300C${agentName}\u300D\u672A\u914D\u7F6E\u6A21\u578B\uFF08model \u5C5E\u6027\u4E3A\u7A7A\uFF09\uFF0C\u4E14\u672C\u6B21\u672A\u6307\u5B9A\u6A21\u578B` };
    const workforce = await this.managedWorkforceOf(asset.id);
    const { orgId, orgSource } = this.resolveOrgId(options.userId, dept);
    const sceneSummary = this.sceneSummaryForDept(dept);
    const systemPrompt = [
      String(asset.attrs?.systemPrompt ?? `\u4F60\u662F\u4F01\u4E1A\u90E8\u95E8\u534F\u4F5C\u9762\u677F\u4E2D\u7684\u6570\u5B57\u540C\u4E8B\u300C${agentCard.name}\u300D\uFF08${agentCard.desc}\uFF09\u3002`),
      sceneSummary ? `\u672C\u90E8\u95E8\u6302\u8F7D\u7684\u884C\u4E1A\u573A\u666F\u56FE\u8C31\u8981\u70B9\uFF1A
${sceneSummary}` : "",
      options.contextNote ?? ""
    ].filter(Boolean).join("\n\n");
    try {
      const gateway = resolvePanelModelGateway(this.ctx)?.gateway;
      if (!gateway) throw new Error("\u6A21\u578B\u7F51\u5173\u672A\u63A5\u5165\uFF0801\u95E8\u6F14\u793A\u6001\uFF09\u2014\u2014\u8FDE\u63A5\u5BBF\u4E3B\u540E\u53EF\u7528");
      const result = await gateway.invoke({
        model,
        orgId,
        subject: options.userId ? `user:${options.userId}` : "panel:tool",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question }
        ]
      });
      this.auditSafe({
        type: "invoke",
        actorType: "machine",
        actorId: `agent:${agentName}`,
        actorName: agentName,
        action: "panel.agent.invoke",
        resourceType: "agent",
        resourceId: asset.id,
        resourceName: agentName,
        // V16：审计口径=问答/协作；受管员工命中时随 detail 留分型标注
        result: "ok",
        detail: `model=${result.model}\uFF08askAgent \u76F4\u7B54\uFF09org=${orgSource}${workforce ? `\uFF1Bworkforce=\u53D7\u7BA1\u5458\u5DE5(${workforce.employeeId})\uFF0C${workforce.notice}` : ""}`,
        ...options.sceneCode ? { sceneCode: options.sceneCode } : {}
      });
      return {
        ok: true,
        reply: stripThink(result.content),
        model: result.model,
        // V16/D08 additive 分型字段：命中受管数字员工才出现（legacy 路径无此键）
        ...workforce ? { workforce } : {}
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.auditSafe({
        type: "invoke",
        actorType: "machine",
        actorId: `agent:${agentName}`,
        actorName: agentName,
        action: "panel.agent.invoke",
        resourceType: "agent",
        resourceId: asset.id,
        resourceName: agentName,
        result: "error",
        detail: `model=${model} \u5931\u8D25\uFF1A${message}`,
        ...options.sceneCode ? { sceneCode: options.sceneCode } : {}
      });
      return { ok: false, reason: `\u6A21\u578B\u7F51\u5173\u8C03\u7528\u5931\u8D25\uFF08${message}\uFF09` };
    } finally {
      if (orgId) {
        try {
          this.soft("usage")?.record({
            org: orgId,
            subject: options.userId ? `user:${options.userId}` : "panel:tool",
            principal: `org:${orgId}`,
            resource: this.meterResource(dept.id, orgId),
            meters: [{ key: "calls", value: 1, unit: "call" }],
            idempotency_key: `panel:ask:${dept.id}:${agentName}:${newId("ask")}`
          });
        } catch {
        }
      }
    }
  }
  // -- 技能直调（C1-2 / J1 消费面：对话框 @技能名/斜杠命令主通道） ----------------------------
  /**
   * 面板可直调的已上架技能清单（skillhub published + 调用人组织可见）。
   * 与 skillhub.search 同一套可见性口径（visibility=orgs 时按调用人组织过滤）；
   * 仅 published 可直调（deprecated/offline 不给面板点名）。
   */
  listInvokeableSkills(viewerOrgId) {
    const hub = this.soft("skillHub");
    if (!hub) return [];
    return hub.skills().all().filter((skill) => {
      if (skill.status !== "published") return false;
      if (skill.visibility === "orgs") {
        if (!viewerOrgId || !skill.targetOrgs.includes(viewerOrgId)) return false;
      }
      return true;
    }).sort((a, b) => b.stats.downloads - a.stats.downloads).map((skill) => ({
      id: skill.id,
      name: skill.name,
      slug: skill.slug,
      summary: skill.summary,
      category: skill.category,
      version: skill.currentVersion
    }));
  }
  /**
   * 面板技能点名直调（C1-2：panel_skill_invoke 工具与面板对话框共享的服务原语）。
   * 语义：skillhub 已上架（published）技能 → 取当前版本内容作为指令上下文 → 模型网关单轮应答。
   * 失败诚实返回 ok:false + reason（不存在/未上架/不可见/无内容/网关失败），不造假回复、不静默。
   * 与 askAgent 同风格：不落频道消息，调用方决定是否经 sendMessage 留痕。
   */
  async invokeSkill(skillName, message, options = {}) {
    const name = skillName.trim();
    if (!name) return { ok: false, reason: "\u6280\u80FD\u540D\u4E3A\u7A7A\uFF08\u7528 /\u6280\u80FD\u540D \u6216 panel_skill_invoke \u70B9\u540D\uFF09" };
    const { orgId } = this.resolveOrgId(options.userId);
    const viewerOrg = this.callerOrgId(options.userId);
    const invokeable = this.listInvokeableSkills(viewerOrg || void 0);
    const skill = invokeable.find((item) => item.name === name) ?? invokeable.find((item) => item.slug === name);
    if (!skill) {
      const hint = this.soft("skillHub")?.skills().all().find((item) => item.status === "published" && (item.name === name || item.slug === name));
      if (hint) return { ok: false, reason: `\u6280\u80FD\u300C${name}\u300D\u672A\u5BF9\u5F53\u524D\u7528\u6237\u7EC4\u7EC7\u5F00\u653E\uFF08visibility=${hint.visibility}\uFF09\uFF0C\u65E0\u6CD5\u76F4\u8C03` };
      const names = invokeable.slice(0, 8).map((item) => item.name);
      return { ok: false, reason: `\u6CA1\u6709\u5DF2\u4E0A\u67B6\u4E14\u5BF9\u60A8\u5F00\u653E\u7684\u6280\u80FD\u300C${name}\u300D\u3002\u53EF\u7528\u6280\u80FD\uFF1A${names.join("\u3001") || "\uFF08\u65E0\uFF09"}` };
    }
    const record = this.soft("skillHub")?.skills().get(skill.id);
    const version = record?.versions.find((item) => item.version === skill.version && item.status === "published");
    const content = version?.content?.trim() ?? "";
    if (!content) return { ok: false, reason: `\u6280\u80FD\u300C${skill.name}\u300D\u5F53\u524D\u7248\u672C\uFF08${skill.version}\uFF09\u65E0\u6307\u4EE4\u5185\u5BB9\uFF0C\u65E0\u6CD5\u76F4\u8C03` };
    const skillLoad = {
      skillId: skill.id,
      version: skill.version,
      contentHash: createHash("sha256").update(content).digest("hex")
    };
    let model = options.modelOverride?.trim() ?? "";
    if (!model) {
      const online = resolvePanelModelGateway(this.ctx)?.gateway.models().all().filter((item) => item.status === "online" && item.endpoint.trim() !== "") ?? [];
      if (online.length === 0) return { ok: false, reason: "\u6A21\u578B\u76EE\u5F55\u6682\u65E0\u5728\u7EBF\u6A21\u578B\u2014\u2014\u8BF7\u7BA1\u7406\u5458\u5728\u300C\u6A21\u578B\u7BA1\u7406\u300D\u4E2D\u63A5\u5165\u540E\u518D\u76F4\u8C03\u6280\u80FD" };
      model = online[0].slug;
    }
    const systemPrompt = [
      `\u4F60\u5728\u6267\u884C\u4F01\u4E1A\u6280\u80FD\u5E73\u53F0\u4E0A\u67B6\u7684\u6280\u80FD\u300C${skill.name}\u300D\uFF08${skill.summary}\uFF09\u3002\u4E25\u683C\u6309\u4EE5\u4E0B\u6280\u80FD\u6307\u4EE4\u5B8C\u6210\u4EFB\u52A1\uFF1A`,
      content,
      options.contextNote ?? ""
    ].filter(Boolean).join("\n\n");
    try {
      const gateway = resolvePanelModelGateway(this.ctx)?.gateway;
      if (!gateway) throw new Error("\u6A21\u578B\u7F51\u5173\u672A\u63A5\u5165\uFF0801\u95E8\u6F14\u793A\u6001\uFF09\u2014\u2014\u8FDE\u63A5\u5BBF\u4E3B\u540E\u53EF\u7528");
      const result = await gateway.invoke({
        model,
        orgId,
        subject: options.userId ? `user:${options.userId}` : "panel:tool",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message || "\uFF08\u65E0\u9644\u52A0\u8F93\u5165\uFF0C\u6309\u6280\u80FD\u6307\u4EE4\u6267\u884C\uFF09" }
        ]
      });
      this.auditSafe({
        type: "invoke",
        actorType: options.userId ? "human" : "machine",
        actorId: options.userId ?? "panel:tool",
        actorName: options.userId ?? "panel:tool",
        action: "panel.skill.invoke",
        resourceType: "skill",
        resourceId: skill.id,
        resourceName: skill.name,
        result: "ok",
        detail: `model=${result.model} version=${skill.version} contentHash=${skillLoad.contentHash}`,
        ...options.sceneCode ? { sceneCode: options.sceneCode } : {}
      });
      return {
        ok: true,
        reply: stripThink(result.content),
        model: result.model,
        skill: { name: skill.name, version: skill.version },
        // D09/V16 additive：证据化加载指纹（skillId/version/contentHash）
        skillLoad
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.auditSafe({
        type: "invoke",
        actorType: options.userId ? "human" : "machine",
        actorId: options.userId ?? "panel:tool",
        actorName: options.userId ?? "panel:tool",
        action: "panel.skill.invoke",
        resourceType: "skill",
        resourceId: skill.id,
        resourceName: skill.name,
        result: "error",
        detail: `model=${model} \u5931\u8D25\uFF1A${reason}`,
        ...options.sceneCode ? { sceneCode: options.sceneCode } : {}
      });
      return { ok: false, reason: `\u6A21\u578B\u7F51\u5173\u8C03\u7528\u5931\u8D25\uFF08${reason}\uFF09` };
    } finally {
      if (orgId) {
        try {
          this.soft("usage")?.record({
            org: orgId,
            subject: options.userId ? `user:${options.userId}` : "panel:tool",
            principal: `org:${orgId}`,
            // J1 契约 v1 对表：计量资源键用 skill:<ID>（slug 可能含非 ASCII，过不了 usage resource 校验）
            resource: `skill:${skill.id}`,
            meters: [{ key: "calls", value: 1, unit: "call" }],
            idempotency_key: `panel:skill:${skill.id}:${newId("inv")}`
          });
        } catch {
        }
      }
    }
  }
  /** 部门挂载活动的场景图谱摘要（注入 Agent 系统提示；图谱未装载则空串）。 */
  sceneSummaryForDept(dept) {
    try {
      const orgId = this.soft("iam")?.orgs().all()[0]?.id ?? "";
      const active = this.activeIndustry(orgId);
      if (!active) return "";
      const pack = this.ctx.scenegraphs.get(active.code.toUpperCase());
      if (!pack) return "";
      return dept.acts.flatMap((act) => (pack.activities[act] ?? []).map((scene) => `${scene.code} ${scene.name}\uFF08\u73B0\u72B6 ${"\u2605".repeat(scene.s)}${"\u2606".repeat(4 - scene.s)}\uFF0C\u75DB\u70B9\uFF1A${scene.pain}\uFF09`)).join("\n");
    } catch {
      return "";
    }
  }
  // -- 卡片动作（走纯平台链：任务落点 / 审批链 / 钉钉推送） -----------------------
  async cardAction(input) {
    const message = this.messages().get(input.messageId);
    if (!message?.card) throw new Error(`\u6D88\u606F\u4E0D\u5B58\u5728\u6216\u65E0\u64CD\u4F5C\u5361\u7247\uFF1A${input.messageId}`);
    const op = message.card.ops.find((item) => item.id === input.opId);
    if (!op) throw new Error(`\u64CD\u4F5C\u9879\u4E0D\u5B58\u5728\uFF1A${input.opId}`);
    if (message.card.done.includes(input.opId)) throw new Error("\u8BE5\u64CD\u4F5C\u5DF2\u6267\u884C\u8FC7\uFF08\u5E42\u7B49\u4FDD\u62A4\uFF09");
    let result = "\u5DF2\u8BB0\u5F55";
    const action = op.action ?? "ack";
    if (action === "task.create") {
      this.tasks().insert({
        id: newId("ptask"),
        dept: message.dept,
        title: message.card.title,
        detail: `\u6765\u81EA\u6D88\u606F\u5361\u7247\uFF08${input.actorName} \u786E\u8BA4\uFF09`,
        lane: "todo",
        assigneeType: "human",
        sceneCode: message.sceneCode,
        createdBy: input.actorId,
        messageId: message.id
      });
      result = `\u5DF2\u751F\u6210\u4EFB\u52A1\uFF1A${message.card.title}`;
    } else if (action === "task.transition") {
      const task = this.tasks().find((item) => item.messageId === message.id).at(-1) ?? this.tasks().find((item) => item.dept === message.dept && item.lane !== "done").at(-1);
      if (!task) throw new Error("\u6CA1\u6709\u53EF\u6D41\u8F6C\u7684\u5173\u8054\u4EFB\u52A1");
      this.transitionTask(task.id, op.lane ?? "doing", input.actorId);
      result = `\u4EFB\u52A1 ${task.title} \u2192 ${LANE_LABELS[op.lane ?? "doing"]}`;
    } else if (action === "approval.request") {
      const audit = this.soft("audit");
      if (!audit) throw new Error("\u5BA1\u6279\u4E2D\u5FC3\u672A\u63A5\u5165\uFF0801\u95E8\u6F14\u793A\u6001\uFF09\u2014\u2014\u8FDE\u63A5\u5BBF\u4E3B\u540E\u53EF\u8D70\u5BA1\u6279\u94FE");
      const approval = audit.createApproval({
        kind: "panel.card-action",
        title: `${message.card.title} \xB7 ${op.label}`,
        payload: { messageId: message.id, dept: message.dept, opId: op.id, opLabel: op.label, reason: input.reason ?? "" },
        requesterId: input.actorId,
        requesterName: input.actorName,
        // QA A-06：卡片未声明风险级时缺省 high（fail-closed），不再「一次 approve 即执行」
        riskLevel: op.risk ?? "high"
      });
      result = `\u5DF2\u63D0\u4EA4\u5BA1\u6279\uFF08${approval.id}\uFF09\uFF0C\u5728\u5BA1\u6279\u4E2D\u5FC3\u8DDF\u8FDB`;
    } else if (action === "dd.push") {
      result = "\u5DF2\u8BF7\u6C42\u63A8\u9001\u9489\u9489";
    }
    const done = [...message.card.done, input.opId];
    this.messages().update(message.id, { card: { ...message.card, done } });
    const updated = this.messages().get(message.id);
    this.ctx.platformBus.emit(PlatformEvents.PanelCardAction, {
      messageId: message.id,
      dept: message.dept,
      opId: op.id,
      opLabel: op.label,
      action,
      title: message.card.title,
      text: message.text,
      actorId: input.actorId,
      actorName: input.actorName,
      ddPush: action === "dd.push",
      channelName: this.channels().get(message.channelId)?.name ?? ""
    });
    return { message: updated, result };
  }
  // -- 任务 -------------------------------------------------------------------
  /** 审计落痕（IAW 交接 5-2）：任务/Agent 直调带 sceneCode 维度落审计时间线；失败不阻塞面板主链。 */
  auditSafe(entry) {
    try {
      const audit = this.ctx.reflect.get("audit", false);
      audit?.record(entry);
    } catch {
    }
  }
  createTask(input) {
    this.dept(input.dept);
    if (input.execIssueId) {
      const hub = this.execHub();
      if (!hub) throw new Error("\u6267\u884C\u4E2D\u67A2\u672A\u63A5\u5165\uFF0801\u95E8\u6F14\u793A\u6001\uFF09\u2014\u2014\u643A\u5E26 execIssueId \u7684\u4EFB\u52A1\u9700\u8981\u5BBF\u4E3B\u6267\u884C\u4E2D\u67A2");
      if (!hub.issues().get(input.execIssueId)) throw new Error(`\u6267\u884C\u4E2D\u67A2\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF1A${input.execIssueId}`);
    }
    if (input.reworkOf && !this.tasks().get(input.reworkOf)) throw new Error(`\u8FD4\u5DE5\u6765\u6E90\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF1A${input.reworkOf}`);
    const record = this.tasks().insert({
      id: newId("ptask"),
      dept: input.dept,
      title: input.title,
      ...input.detail ? { detail: input.detail } : {},
      lane: input.lane ?? "todo",
      assigneeType: input.assigneeType ?? "human",
      ...input.assigneeName ? { assigneeName: input.assigneeName } : {},
      ...input.sceneCode ? { sceneCode: input.sceneCode } : {},
      ...input.execIssueId ? { execIssueId: input.execIssueId } : {},
      ...input.goalId ? { goalId: input.goalId } : {},
      ...input.evidenceRefs?.length ? { evidenceRefs: input.evidenceRefs } : {},
      ...input.reworkOf ? { reworkOf: input.reworkOf } : {},
      createdBy: input.createdBy
    });
    this.auditSafe({
      type: "change",
      actorType: input.createdBy.startsWith("agent:") ? "machine" : "human",
      actorId: input.createdBy,
      actorName: input.createdBy,
      action: "panel.task.create",
      resourceType: "panel_task",
      resourceId: record.id,
      resourceName: input.title,
      result: "ok",
      detail: `\u6CF3\u9053 ${input.lane ?? "todo"}${input.assigneeName ? `\uFF0C\u6307\u6D3E ${input.assigneeName}` : ""}${input.execIssueId ? `\uFF0C\u8840\u7F18 exec:${input.execIssueId}` : ""}`,
      ...input.sceneCode ? { sceneCode: input.sceneCode } : {}
    });
    return record;
  }
  /** exec-hub 软读（执行中枢投影）：缺席（01门演示态）→ undefined，端点级诚实降级。 */
  execHub() {
    return this.soft("execHub");
  }
  /** 面板泳道 → exec-hub 任务状态镜像（todo/doing/review/done ↔ todo/in_progress/review/done）。 */
  laneToIssueStatus(lane) {
    return lane === "doing" ? "in_progress" : lane;
  }
  transitionTask(taskId, lane, actorId) {
    const task = this.tasks().get(taskId);
    if (!task) throw new Error(`\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF1A${taskId}`);
    if (!TASK_LANES.includes(lane)) throw new Error(`\u975E\u6CD5\u6CF3\u9053\uFF1A${lane}`);
    const updated = this.tasks().update(taskId, { lane });
    let mirror = "";
    if (task.execIssueId) {
      const hub = this.execHub();
      if (!hub) mirror = "\uFF1Bexec-hub \u7F3A\u5E2D\uFF0C\u4EC5\u672C\u5730\u6D41\u8F6C";
      else {
        try {
          hub.transitionIssue(task.execIssueId, this.laneToIssueStatus(lane), `panel:${actorId}`);
          mirror = `\uFF1B\u955C\u50CF exec:${task.execIssueId} \u2192 ${this.laneToIssueStatus(lane)}`;
        } catch (error) {
          mirror = `\uFF1B\u955C\u50CF\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    this.ctx.platformBus.emit(PlatformEvents.PanelTaskUpdated, { taskId, dept: task.dept, lane, actorId, title: task.title });
    this.auditSafe({
      type: "change",
      actorType: actorId.startsWith("agent:") ? "machine" : "human",
      actorId,
      actorName: actorId,
      action: "panel.task.transition",
      resourceType: "panel_task",
      resourceId: taskId,
      resourceName: task.title,
      result: "ok",
      detail: `${task.lane} \u2192 ${lane}${mirror}`,
      ...task.sceneCode ? { sceneCode: task.sceneCode } : {}
    });
    return updated;
  }
  /**
   * 验收裁决（DSH issue#4 修订，2026-10-29）：签认关闭（accepted）/ 打回返工（rework）。
   * 结论落面板任务 + 镜像回写 exec-hub（accepted→done；rework→in_progress 重开返工）；
   * 同一任务不可重复裁决；镜像失败如实留痕不阻塞结论（对账靠 audit detail）。
   */
  taskVerdict(taskId, verdict, input) {
    const task = this.tasks().get(taskId);
    if (!task) throw new Error(`\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF1A${taskId}`);
    if (task.verdict) throw new Error(`\u4EFB\u52A1\u5DF2\u6709\u9A8C\u6536\u7ED3\u8BBA\uFF08${task.verdict === "accepted" ? "\u7B7E\u8BA4" : "\u8FD4\u5DE5"}\uFF09\uFF0C\u4E0D\u53EF\u91CD\u590D\u88C1\u51B3`);
    const updated = this.tasks().update(taskId, {
      verdict,
      verdictBy: input.actorId,
      verdictAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...input.opinion ? { verdictOpinion: input.opinion } : {}
    });
    let mirror = "exec-hub \u7F3A\u5E2D\uFF0C\u4EC5\u672C\u5730\u843D\u7ED3\u8BBA";
    const hub = task.execIssueId ? this.execHub() : void 0;
    if (hub && task.execIssueId) {
      const target = verdict === "accepted" ? "done" : "in_progress";
      try {
        hub.transitionIssue(task.execIssueId, target, `panel:${input.actorId}`);
        mirror = `\u955C\u50CF exec:${task.execIssueId} \u2192 ${target}`;
      } catch (error) {
        mirror = `\u955C\u50CF\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.ctx.platformBus.emit(PlatformEvents.PanelTaskUpdated, {
      taskId,
      dept: task.dept,
      lane: updated.lane,
      actorId: input.actorId,
      title: task.title,
      verdict,
      ...task.execIssueId ? { execIssueId: task.execIssueId } : {}
    });
    this.auditSafe({
      type: "change",
      actorType: input.actorId.startsWith("agent:") ? "machine" : "human",
      actorId: input.actorId,
      actorName: input.actorId,
      action: "panel.task.verdict",
      resourceType: "panel_task",
      resourceId: taskId,
      resourceName: task.title,
      result: "ok",
      detail: `\u9A8C\u6536\u7ED3\u8BBA ${verdict === "accepted" ? "\u7B7E\u8BA4\u5173\u95ED" : "\u6253\u56DE\u8FD4\u5DE5"}${input.opinion ? `\uFF08${input.opinion}\uFF09` : ""}\uFF1B${mirror}`,
      ...task.sceneCode ? { sceneCode: task.sceneCode } : {}
    });
    return updated;
  }
  /**
   * 部门目标投影（DSH issue#4 修订，2026-10-29）：读透 exec-hub（不复制权威状态）——
   * 目标（含 metric 基线/目标值）+ 任务（含血缘 goalAncestry/执行锁）+ 面板侧关联任务 ID。
   * 范围：部门绑定组织 → 该组织子树；未绑定 → 全量（与部门范围权限同口径）。
   * exec-hub 缺席 → null（调用方 503 DEGRADED 诚实降级）。
   */
  deptGoalsProjection(dept) {
    const hub = this.execHub();
    if (!hub) return null;
    const iam = this.soft("iam");
    const orgScoped = dept.orgId && iam ? (orgId) => this.orgSubtreeContains(dept.orgId, orgId) : () => true;
    const panelTaskByIssue = /* @__PURE__ */ new Map();
    for (const task of this.tasks().find((item) => item.dept === dept.id)) {
      if (!task.execIssueId) continue;
      panelTaskByIssue.set(task.execIssueId, [...panelTaskByIssue.get(task.execIssueId) ?? [], task.id]);
    }
    const goals = hub.goals().all().filter((goal) => orgScoped(goal.orgId)).map((goal) => ({ ...goal }));
    const issues = hub.issues().all().filter((issue) => orgScoped(issue.orgId)).map((issue) => ({
      ...issue,
      panelTaskIds: panelTaskByIssue.get(String(issue.id)) ?? []
    }));
    return { goals, issues };
  }
  // -- 场景诊断（会话 × 图谱联动） -------------------------------------------------
  /** 场景编号规范引用（如 QB01-A-2-5）——会话产出沉淀回转型路线图的联动点。 */
  sceneContext(code) {
    const hit = this.ctx.scenegraphs.findScene(code);
    if (!hit) throw new Error(`\u573A\u666F\u7F16\u53F7\u5728\u5DF2\u88C5\u8F7D\u56FE\u8C31\u4E2D\u4E0D\u5B58\u5728\uFF1A${code}`);
    return { pack: hit.pack, activityLabel: ACTIVITY_LABELS[hit.activity], sceneLabel: `${hit.scene.name}\uFF08\u73B0\u72B6 ${"\u2605".repeat(hit.scene.s)}${"\u2606".repeat(4 - hit.scene.s)}\uFF09` };
  }
  async diagnose(input) {
    const dept = this.dept(input.dept);
    const { pack, sceneLabel } = this.sceneContext(input.sceneCode);
    const channel = this.channels().find((item) => item.dept === input.dept).at(0);
    if (!channel) throw new Error(`\u90E8\u95E8 ${dept.label} \u6682\u65E0\u534F\u4F5C\u9891\u9053\uFF0C\u8BF7\u5148\u5EFA\u9891\u9053`);
    const agentCard = dept.agents[0];
    const text = `@${agentCard.name} \u8BF7\u5BF9\u300C${pack.name}\u300D\u573A\u666F\u300C${sceneLabel}\u300D\uFF08${input.sceneCode}\uFF09\u505A\u6570\u5B57\u5316\u8BCA\u65AD\uFF0C\u6309\u4E00\u56FE\u56DB\u6E05\u5355\u6846\u67B6\u8BC4\u4F30\u5DEE\u8DDD/\u9009\u578B/\u4F18\u5148\u7EA7\u3002`;
    const message = await this.sendMessage({
      dept: input.dept,
      channelId: channel.id,
      senderType: "human",
      senderId: input.actorId,
      senderName: input.actorName,
      text,
      ddSync: false,
      sceneCode: input.sceneCode
    });
    const task = this.createTask({
      dept: input.dept,
      title: `\u573A\u666F\u8BCA\u65AD\uFF1A${input.sceneCode} ${sceneLabel}`,
      detail: `\u6D3E ${agentCard.name} \u6309\u4E00\u56FE\u56DB\u6E05\u5355\u6846\u67B6\u8BCA\u65AD\uFF08\u6765\u81EA\u573A\u666F\u56FE\u8C31 ${pack.code}\uFF09`,
      lane: "todo",
      assigneeType: "agent",
      assigneeName: agentCard.name,
      sceneCode: input.sceneCode,
      createdBy: input.actorId
    });
    return { message, task };
  }
  // -- SSE 订阅注册表 -----------------------------------------------------------
  subscribeStream(dept, listener) {
    const set = this.streamSubscribers.get(dept) ?? /* @__PURE__ */ new Set();
    set.add(listener);
    this.streamSubscribers.set(dept, set);
    return () => set.delete(listener);
  }
  /** 平台事件 → SSE 订阅者扇出（panel.* / flow.* / dingtalk-bridge.delivered）。 */
  wireEventBus() {
    const forward = (name) => (payload) => {
      const dept = payload?.dept;
      const targets = dept ? [dept] : [...this.streamSubscribers.keys()];
      for (const target of targets) {
        for (const listener of this.streamSubscribers.get(target) ?? []) {
          try {
            listener({ name, payload });
          } catch {
          }
        }
      }
    };
    this.ctx.platformBus.on(PlatformEvents.PanelMessageCreated, forward(PlatformEvents.PanelMessageCreated));
    this.ctx.platformBus.on(PlatformEvents.PanelTaskUpdated, forward(PlatformEvents.PanelTaskUpdated));
    this.ctx.platformBus.on(PlatformEvents.PanelCardAction, forward(PlatformEvents.PanelCardAction));
    this.ctx.platformBus.on(PlatformEvents.PanelIndustryActivated, forward(PlatformEvents.PanelIndustryActivated));
    this.ctx.platformBus.on(PlatformEvents.DingtalkDelivered, forward(PlatformEvents.DingtalkDelivered));
    this.ctx.platformBus.on(PlatformEvents.ScenegraphUpdated, forward(PlatformEvents.ScenegraphUpdated));
    this.ctx.platformBus.on(PlatformEvents.FlowCreated, forward(PlatformEvents.FlowCreated));
    this.ctx.platformBus.on(PlatformEvents.FlowStepUpdated, forward(PlatformEvents.FlowStepUpdated));
    this.ctx.platformBus.on(PlatformEvents.FlowCompleted, forward(PlatformEvents.FlowCompleted));
    this.ctx.platformBus.on(PlatformEvents.ConnectorPolicyMirrorFailed, forward(PlatformEvents.ConnectorPolicyMirrorFailed));
    this.ctx.platformBus.on(PlatformEvents.ConnectorPolicySnapshotDrifted, forward(PlatformEvents.ConnectorPolicySnapshotDrifted));
  }
}
function extractMentions(text) {
  const mentions = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(/@([\p{L}\p{N}·]{2,20})/gu)) mentions.add(match[1]);
  return [...mentions];
}
const THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>/;
const THINK_OPEN_UNTERMINATED = /^\s*<think>[\s\S]*$/;
function stripThink(text) {
  let out = text.replace(THINK_BLOCK, "");
  if (THINK_OPEN_UNTERMINATED.test(out)) out = "";
  return out.trimStart();
}
function createThinkGate(emit) {
  let hold = "";
  let passed = false;
  return (text) => {
    if (passed) {
      emit(text);
      return;
    }
    hold += text;
    if (hold.trimStart().startsWith("<think>")) {
      const close = hold.indexOf("</think>");
      if (close === -1) return;
      passed = true;
      const rest = hold.slice(close + "</think>".length);
      hold = "";
      if (rest) emit(rest);
      return;
    }
    passed = true;
    const all = hold;
    hold = "";
    emit(all);
  };
}
export {
  INDUSTRY_REGISTRY,
  LANE_LABELS,
  PanelService,
  TASK_LANES,
  createThinkGate,
  extractMentions,
  stripThink
};
