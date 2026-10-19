import { join, dirname } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PlatformEvents } from "../../platform-core/dist/bus.js";
import { newId } from "../../platform-core/dist/ids.js";
import { PanelService, TASK_LANES } from "./service.js";
import { CardpackService, CARD_PLATFORMS, filterCards } from "./cardpacks.js";
import { CardpackService as CardpackService2, CARD_PLATFORMS as CARD_PLATFORMS2, filterCards as filterCards2 } from "./cardpacks.js";
import { seedPanel, DEMO_ORG_ID } from "./seed/seed.js";
import { resolvePanelModelGateway } from "./llm-bridge.js";
import { DwsCli } from "./dws.js";
import { applyMfgModule } from "./mfg/module.js";
const name = "panel-core";
const inject = [
  "httpServer",
  "opsStorage",
  "platformBus",
  "tools",
  "scenegraphs"
];
const DEMO_PRINCIPAL = {
  kind: "human",
  principalId: "demo-visitor",
  name: "\u6F14\u793A\u8BBF\u5BA2",
  permissions: ["panel.read", "scenegraph.read"],
  actChain: []
};
const soft = (ctx, key) => ctx.reflect.get(key, false);
const DEPT_RE = /^[a-z]{2,12}$/;
function apply(ctx, config = {}) {
  const demoAuth = config.demoAuth === true;
  const http = ctx.httpServer;
  ctx.plugin(PanelService);
  ctx.plugin(CardpackService);
  const cardpacks = new CardpackService(ctx);
  const panel = new PanelService(ctx);
  const caller = (exchange) => exchange.principal;
  const requirePermission = (exchange, point) => {
    if (!exchange.principal) {
      const header = String(exchange.headers["authorization"] ?? "");
      if (header.startsWith("Bearer ")) {
        const authn = soft(ctx, "authn");
        if (!authn) {
          exchange.fail(401, "UNAUTHENTICATED", "\u8BA4\u8BC1\u4E2D\u5FC3\u672A\u63A5\u5165\uFF0C\u65E0\u6CD5\u6821\u9A8C\u6240\u51FA\u793A\u7684\u4EE4\u724C");
          return false;
        }
        try {
          const verified = authn.verify(header.slice(7));
          exchange.principal = {
            kind: verified.principal.type,
            principalId: verified.principal.id,
            ...verified.principal.type === "human" && verified.principal.refId ? { userId: verified.principal.refId } : {},
            ...verified.principal.type === "machine" ? { refType: verified.principal.refType, refId: verified.principal.refId } : {},
            name: verified.principal.name,
            permissions: verified.scopes,
            actChain: verified.actChain
          };
        } catch (error) {
          exchange.fail(401, "TOKEN_INVALID", `\u4EE4\u724C\u65E0\u6548\uFF1A${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
      }
    }
    if (demoAuth && !exchange.principal) {
      if (!["GET", "HEAD", "OPTIONS"].includes(exchange.method.toUpperCase())) {
        exchange.fail(403, "DEMO_READONLY", "\u6F14\u793A\u6570\u636E\u53EA\u8BFB\uFF1A\u8FDE\u63A5\u5BBF\u4E3B\u5E76\u767B\u5F55\u540E\u89E3\u9501\u5199\u64CD\u4F5C");
        return false;
      }
      exchange.principal = DEMO_PRINCIPAL;
    } else if (!exchange.principal) {
      exchange.fail(401, "UNAUTHENTICATED", "\u672A\u8BA4\u8BC1\uFF1A\u8BF7\u5148\u767B\u5F55\uFF08\u9274\u6743\u4E2D\u95F4\u4EF6\u672A\u8986\u76D6\u8BE5\u8BF7\u6C42\uFF09");
      return false;
    }
    const info = caller(exchange);
    if (info.permissions.includes("*") || info.permissions.includes(point)) return true;
    ctx.platformBus.emit("audit.authz.denied", {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point,
      path: exchange.path
    });
    exchange.fail(403, "FORBIDDEN", `\u7F3A\u5C11\u6743\u9650\u70B9 ${point}\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u8C03\u6574\u89D2\u8272`, { permission: point });
    return false;
  };
  const degraded = (exchange, capability) => {
    exchange.fail(503, "DEGRADED", `\u300C${capability}\u300D\u80FD\u529B\u672A\u63A5\u5165\uFF0801\u95E8\u6F14\u793A\u6001\uFF09\u2014\u2014\u8FDE\u63A5\u5BBF\u4E3B\u540E\u53EF\u7528`);
    return null;
  };
  const guarded = (method, path, permission, handler) => {
    http.register(method, path, async (exchange) => {
      if (!requirePermission(exchange, permission)) return;
      try {
        const result = await handler(exchange);
        if (!exchange.res.writableEnded) {
          const isDemoPrincipal = caller(exchange)?.principalId === DEMO_PRINCIPAL.principalId;
          const demoMarked = demoAuth && isDemoPrincipal && result !== null && typeof result === "object" && !Array.isArray(result) ? { ...result, demo: true } : result;
          exchange.ok(demoMarked);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        exchange.fail(400, "BAD_REQUEST", message);
      }
    }, { access: "guarded", permission });
  };
  const body = (exchange) => exchange.body ?? {};
  const changeLog = (exchange, action, resourceType, resourceId, resourceName, detail = "") => {
    const info = caller(exchange);
    soft(ctx, "audit")?.record({
      type: "change",
      actorType: info.kind === "human" ? "human" : "machine",
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      action,
      resourceType,
      resourceId,
      resourceName,
      result: "ok",
      detail,
      ...info.actChain.length > 0 ? { actChain: info.actChain } : {}
    });
  };
  const deptOf = (exchange) => {
    const dept = String(exchange.params.dept ?? "");
    if (!DEPT_RE.test(dept)) throw new Error(`\u90E8\u95E8\u6807\u8BC6\u975E\u6CD5\uFF1A${dept}`);
    const config2 = panel.dept(dept);
    if (!panel.deptScopeAllowed(caller(exchange), config2)) {
      exchange.fail(403, "FORBIDDEN", `\u90E8\u95E8\u8303\u56F4\u53D7\u9650\uFF1A${config2.label} \u5DF2\u7ED1\u5B9A\u7EC4\u7EC7\u6CBB\u7406\uFF0C\u4EC5\u8BE5\u7EC4\u7EC7\u5B50\u6811\u6210\u5458\u53EF\u8BBF\u95EE`, { permission: "panel.read", deptScope: config2.orgId });
      throw new Error("\u90E8\u95E8\u8303\u56F4\u53D7\u9650");
    }
    return config2;
  };
  const orgIdOf = (exchange) => {
    const info = caller(exchange);
    const iam = soft(ctx, "iam");
    return (info.userId ? iam?.users().get(info.userId)?.orgId : void 0) ?? iam?.orgs().find((org) => org.parentId === null).at(0)?.id ?? DEMO_ORG_ID;
  };
  guarded("GET", "/api/panel/depts", "panel.read", (exchange) => {
    const info = caller(exchange);
    return {
      depts: panel.deptConfigs().all().map((dept) => ({
        ...dept,
        allowed: panel.deptScopeAllowed(info, dept),
        org: panel.deptOrg(dept)
      }))
    };
  });
  guarded("GET", "/api/panel/orgs", "panel.config.write", (exchange) => {
    const iam = soft(ctx, "iam");
    if (!iam) return degraded(exchange, "\u7EC4\u7EC7\u76EE\u5F55");
    return { orgs: iam.orgs().all().map((org) => ({ id: org.id, name: org.name, parentId: org.parentId })) };
  });
  guarded("PUT", "/api/panel/:dept/config", "panel.config.write", (exchange) => {
    const iam = soft(ctx, "iam");
    if (!iam) return degraded(exchange, "\u7EC4\u7EC7\u76EE\u5F55");
    const dept = panel.dept(String(exchange.params.dept ?? ""));
    const input = body(exchange);
    if (input.orgId !== void 0 && input.orgId !== null && input.orgId !== "") {
      if (!iam.orgs().get(input.orgId)) throw new Error(`\u7EC4\u7EC7\u4E0D\u5B58\u5728\uFF1A${input.orgId}`);
      ctx.panel.deptConfigs().update(dept.id, { orgId: input.orgId });
    } else {
      ctx.panel.deptConfigs().update(dept.id, { orgId: void 0 });
    }
    const updated = panel.dept(dept.id);
    changeLog(exchange, "panel.dept.bind_org", "panel_dept", dept.id, dept.label, updated.orgId ?? "\uFF08\u89E3\u9664\u7ED1\u5B9A\uFF09");
    return { dept: { ...updated, org: panel.deptOrg(updated) } };
  });
  guarded("GET", "/api/panel/:dept/overview", "panel.read", (exchange) => {
    const dept = deptOf(exchange);
    const info = caller(exchange);
    const orgId = orgIdOf(exchange);
    const channels = panel.channels().find((item) => item.dept === dept.id).map((channel) => ({
      ...channel,
      unread: info.userId ? panel.unreadCount(info.userId, channel.id) : 0
    }));
    return {
      dept,
      org: panel.deptOrg(dept),
      members: panel.deptMembers(dept),
      industry: panel.activeIndustry(orgId),
      channels,
      agents: dept.agents.map((agent) => panel.agentWithAsset(agent)),
      kpis: dept.kpis,
      widgets: panel.board(dept),
      pendingActivations: soft(ctx, "audit")?.approvals().find((item) => item.kind === "industry.activation" && item.status === "pending").map((item) => ({ id: item.id, code: String(item.payload.code ?? ""), orgId: String(item.payload.orgId ?? "") })).filter((item) => !orgId || item.orgId === orgId) ?? []
    };
  });
  guarded("GET", "/api/panel/:dept/board", "panel.read", (exchange) => ({
    dept: deptOf(exchange).id,
    widgets: panel.board(deptOf(exchange))
  }));
  guarded("GET", "/api/panel/:dept/widgets", "panel.read", (exchange) => ({ widgets: deptOf(exchange).widgets }));
  guarded("PUT", "/api/panel/:dept/widgets", "panel.config.write", (exchange) => {
    const dept = deptOf(exchange);
    const widgets = body(exchange).widgets;
    if (!Array.isArray(widgets)) throw new Error("body.widgets \u5FC5\u987B\u662F\u6570\u7EC4");
    for (const widget of widgets) {
      if (!widget.id || !widget.type || !widget.title) throw new Error("widget \u5FC5\u987B\u5305\u542B id/type/title");
      if (!["bars", "funnel", "alerts", "todos", "feeds"].includes(widget.type)) throw new Error(`widget.type \u975E\u6CD5\uFF1A${widget.type}`);
      if (!["manual", "mock", "connector", "mcp"].includes(widget.source)) throw new Error(`widget.source \u975E\u6CD5\uFF08\u6765\u6E90\u5FBD\u6807\u5FC5\u586B\uFF09\uFF1A${widget.source}`);
    }
    ctx.panel.deptConfigs().update(dept.id, { widgets });
    changeLog(exchange, "panel.widget.layout", "panel_dept", dept.id, dept.label, `${widgets.length} \u5757 widget`);
    return { widgets };
  });
  guarded("GET", "/api/panel/:dept/kpis", "panel.read", (exchange) => ({ kpis: deptOf(exchange).kpis }));
  guarded("PUT", "/api/panel/:dept/kpis", "panel.config.write", (exchange) => {
    const dept = deptOf(exchange);
    const kpis = body(exchange).kpis;
    if (!Array.isArray(kpis)) throw new Error("body.kpis \u5FC5\u987B\u662F\u6570\u7EC4");
    for (const kpi of kpis) {
      if (!kpi.label || kpi.value === void 0) throw new Error("kpi \u5FC5\u987B\u5305\u542B label/value");
      if (!["manual", "mock", "connector"].includes(kpi.source)) throw new Error(`kpi.source \u975E\u6CD5\uFF08\u6765\u6E90\u5FBD\u6807\u5FC5\u586B\uFF09\uFF1A${kpi.source}`);
    }
    ctx.panel.deptConfigs().update(dept.id, { kpis });
    changeLog(exchange, "panel.kpi.layout", "panel_dept", dept.id, dept.label, `${kpis.length} \u4E2A KPI`);
    return { kpis };
  });
  guarded("PUT", "/api/panel/:dept/agents", "panel.config.write", (exchange) => {
    const dept = deptOf(exchange);
    const agents = body(exchange).agents;
    if (!Array.isArray(agents) || agents.length === 0) throw new Error("body.agents \u5FC5\u987B\u662F\u975E\u7A7A\u6570\u7EC4");
    for (const agent of agents) {
      if (!agent.name || !agent.icon) throw new Error("agent \u5FC5\u987B\u5305\u542B name/icon");
      if (agent.agentRef && !/^agent:[A-Za-z0-9._-]+$/.test(agent.agentRef)) throw new Error(`agentRef \u683C\u5F0F\u975E\u6CD5\uFF08agent:<idOrSlug>\uFF09\uFF1A${agent.agentRef}`);
    }
    ctx.panel.deptConfigs().update(dept.id, { agents });
    changeLog(exchange, "panel.agent.roster", "panel_dept", dept.id, dept.label, `${agents.length} \u4E2A Agent \u9635\u5BB9\u4F4D`);
    return { agents };
  });
  const modelGateway = () => resolvePanelModelGateway(ctx);
  const maskedModel = (model) => ({
    ...model,
    apiKey: model.apiKey.startsWith("env:") ? model.apiKey : "***"
  });
  guarded("GET", "/api/panel/models", "panel.read", async (exchange) => {
    const resolved = modelGateway();
    if (!resolved) return degraded(exchange, "\u6A21\u578B\u7F51\u5173");
    if (resolved.kind === "dsh") {
      const models = await resolved.gateway.ensureCatalog();
      return { models: models.map(maskedModel), source: "dsh" };
    }
    return { models: resolved.gateway.models().all().map(maskedModel), source: "modelgw" };
  });
  guarded("POST", "/api/panel/models", "panel.config.write", (exchange) => {
    const resolved = modelGateway();
    if (!resolved) return degraded(exchange, "\u6A21\u578B\u7F51\u5173");
    if (resolved.kind === "dsh") {
      exchange.fail(400, "MODEL_READONLY", "\u6A21\u578B\u76EE\u5F55\u7531 dsh \u914D\u7F6E\u6258\u7BA1\uFF08settings.yaml agent-default-model / llm \u9002\u914D\u5668\uFF09\u2014\u201401\u95E8\u9762\u677F\u53EA\u8BFB\uFF0C\u8BF7\u5728 dsh \u4FA7\u589E\u5220\u6539\u6A21\u578B");
      return;
    }
    const gateway = resolved.gateway;
    const input = body(exchange);
    const slug = input.slug?.trim() ?? "";
    if (!slug) throw new Error("\u6A21\u578B slug \u5FC5\u586B\uFF08\u5982 deepseek-chat\uFF09");
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(slug)) throw new Error(`slug \u4EC5\u5141\u8BB8\u5B57\u6BCD/\u6570\u5B57/._-\uFF082-64 \u4F4D\uFF09\uFF1A${slug}`);
    if (!input.endpoint?.trim()) throw new Error("endpoint \u5FC5\u586B\uFF08OpenAI \u517C\u5BB9\u57FA\u5740\uFF1B\u672A\u914D\u7F6E\u4E0D\u53EF\u8C03\u7528\uFF0C\u7EDD\u4E0D\u9020\u5047\u56DE\u590D\uFF09");
    if (!Number.isFinite(input.listCentsPerKTokens) || (input.listCentsPerKTokens ?? -1) < 0) throw new Error("listCentsPerKTokens \u5FC5\u987B\u662F\u975E\u8D1F\u6570\uFF08\u6302\u724C\u4EF7\uFF0C\u5206/\u5343 tokens\uFF09");
    const status = input.status === "offline" ? "offline" : "online";
    const dataClassLimit = input.dataClassLimit === "public" || input.dataClassLimit === "internal" || input.dataClassLimit === "secret" ? input.dataClassLimit : "internal";
    const existing = gateway.models().findOne((item) => item.slug === slug);
    const model = gateway.upsertModel({
      slug,
      displayName: input.displayName?.trim() || slug,
      provider: input.provider?.trim() || "external",
      endpoint: input.endpoint.trim(),
      apiKey: input.apiKey?.trim() || existing?.apiKey || "env:MODEL_API_KEY",
      listCentsPerKTokens: input.listCentsPerKTokens,
      costCentsPerKTokens: input.costCentsPerKTokens ?? Math.floor(input.listCentsPerKTokens / 2),
      status,
      dataClassLimit
    });
    changeLog(exchange, "panel.model.upsert", "model", model.id, model.slug, `${status === "online" ? "\u4E0A\u7EBF" : "\u4E0B\u7EBF"}\uFF0C\u5206\u7EA7\u4E0A\u9650=${dataClassLimit}`);
    return maskedModel(model);
  });
  guarded("DELETE", "/api/panel/models/:id", "panel.config.write", (exchange) => {
    const resolved = modelGateway();
    if (!resolved) return degraded(exchange, "\u6A21\u578B\u7F51\u5173");
    if (resolved.kind === "dsh") {
      exchange.fail(400, "MODEL_READONLY", "\u6A21\u578B\u76EE\u5F55\u7531 dsh \u914D\u7F6E\u6258\u7BA1\u2014\u201401\u95E8\u9762\u677F\u53EA\u8BFB\uFF0C\u8BF7\u5728 dsh \u4FA7\u589E\u5220\u6539\u6A21\u578B");
      return;
    }
    const gateway = resolved.gateway;
    const id = exchange.params["id"];
    const model = gateway.models().get(id);
    if (!model) throw new Error(`\u6A21\u578B\u4E0D\u5B58\u5728\uFF1A${id}`);
    gateway.models().remove(id);
    changeLog(exchange, "panel.model.delete", "model", id, model.slug);
    return { deleted: true };
  });
  guarded("POST", "/api/panel/models/:slug/test", "panel.config.write", async (exchange) => {
    const resolved = modelGateway();
    if (!resolved) return degraded(exchange, "\u6A21\u578B\u7F51\u5173");
    const slug = String(exchange.params.slug ?? "");
    const info = caller(exchange);
    const orgId = orgIdOf(exchange);
    if (resolved.kind === "modelgw" && !orgId) throw new Error("\u65E0\u6CD5\u786E\u5B9A\u8BA1\u8D39\u7EC4\u7EC7\uFF08orgId\uFF09\uFF0C\u65E0\u6CD5\u6267\u884C\u771F\u5B9E\u8C03\u7528\u6D4B\u8BD5");
    try {
      const result = await resolved.gateway.invoke({
        model: slug,
        messages: [{ role: "user", content: "\u6A21\u578B\u8FDE\u901A\u6027\u6D4B\u8BD5\uFF0C\u8BF7\u76F4\u63A5\u56DE\u590D\uFF1AOK" }],
        ...resolved.kind === "modelgw" ? { orgId } : {},
        subject: info.userId ? `user:${info.userId}` : `panel:${info.principalId}`,
        maxTokens: 16
      });
      return { ok: true, model: result.model, content: result.content.slice(0, 80), outputTokens: result.outputTokens };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /HTTP 404/.test(message) ? "\uFF08\u63D0\u793A\uFF1AHTTP 404 \u5E38\u56E0 endpoint \u6F0F\u4E86 /v1 \u8DEF\u5F84\u2014\u2014OpenAI \u517C\u5BB9\u57FA\u5740\u5E94\u5F62\u5982 https://<host>/v1\uFF09" : "";
      return { ok: false, error: `${message}${hint}` };
    }
  });
  const refAlive = (ref) => {
    const colon = ref.indexOf(":");
    const type = ref.slice(0, colon);
    const id = ref.slice(colon + 1);
    const matches = (item) => item.id === id || item.slug === id;
    if (!soft(ctx, "resourceCore") && ["agent", "app", "nas"].includes(type)) return true;
    if (!soft(ctx, "mcpRegistry") && type === "mcp") return true;
    if (!soft(ctx, "skillHub") && type === "skill") return true;
    if (!soft(ctx, "iam") && type === "kb") return true;
    try {
      if (type === "agent" || type === "app" || type === "nas") {
        return soft(ctx, "resourceCore").list(type).some(matches);
      }
      if (type === "mcp") return soft(ctx, "mcpRegistry").services().all().some(matches);
      if (type === "skill") return soft(ctx, "skillHub").skills().all().some(matches);
      if (type === "kb") return soft(ctx, "iam").orgs().get(id) !== void 0;
      return true;
    } catch {
      return true;
    }
  };
  guarded("GET", "/api/panel/board", "panel.read", (exchange) => {
    const info = caller(exchange);
    const available = [...new Set(cardpacks.all().map((pack) => pack.platform))];
    const requested = exchange.query.get("platform") ?? process.env.RQ_PLATFORM ?? (available.includes("rd") ? "rd" : available[0]) ?? "strategy";
    if (!CARD_PLATFORMS.includes(requested)) {
      exchange.fail(400, "BAD_REQUEST", `platform \u975E\u6CD5\uFF08\u5E94\u4E3A ${CARD_PLATFORMS.join("/")}\uFF09`);
      return;
    }
    const platform = requested;
    const iam = soft(ctx, "iam");
    const user = info.userId ? iam?.users().get(info.userId) : void 0;
    const roles = user ? user.roleIds.map((roleId) => iam?.roles().get(roleId)?.code).filter((code) => Boolean(code)) : [];
    cardpacks.setRefAliveResolver(refAlive);
    const packs = cardpacks.forPlatform(platform);
    const { cards, droppedDeadRefs } = filterCards({ packs, roles, refAlive });
    if (droppedDeadRefs.length > 0) {
      ctx.platformBus.emit("audit.alert.fired", {
        id: newId("alt"),
        severity: "warning",
        title: "\u5361\u7247\u5305\u542B\u5931\u6548\u8D44\u4EA7\u5F15\u7528",
        message: `\u5E73\u53F0 ${platform} \u5361\u7247\u5305\u4E2D ${droppedDeadRefs.length} \u4E2A ref \u5DF2\u5931\u6548\u88AB\u8FC7\u6EE4\uFF1A${droppedDeadRefs.join("\u3001")}\uFF08\u8BF7\u4FEE\u6B63 cardpacks \u914D\u7F6E\uFF09`
      });
    }
    const weekAgo = new Date(Date.now() - 7 * 24 * 36e5).toISOString();
    const behaviorCount = (type) => {
      return soft(ctx, "behavior")?.query({ type, from: weekAgo }).total ?? 0;
    };
    let usageCount = 0;
    let chargeCents = 0;
    let byDay = [];
    const usageAgg = soft(ctx, "usage");
    if (usageAgg) {
      const totals = usageAgg.totals({ from: weekAgo });
      usageCount = totals.count;
      chargeCents = totals.charge_cents;
      byDay = usageAgg.breakdown(weekAgo).byDay;
    }
    const completedCalls = soft(ctx, "mcpRegistry")?.calls().all().filter((call) => call.ok && call.at >= weekAgo).length ?? 0;
    return {
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      windowDays: 7,
      // 卡片包面（顶层平铺，控制台工作台卡片消费方零改动换端点即可用）
      platform,
      label: packs[0]?.label ?? "",
      roles,
      cards,
      totalPacks: packs.length,
      availablePlatforms: available,
      droppedDeadRefs,
      // 聚合面（战略看板）——资产目录缺席（演示态）→ 全 0（看板诚实降级为演示数据视图）
      assets: {
        appsOnline: soft(ctx, "resourceCore")?.list("app").filter((item) => item.status === "online").length ?? 0,
        agentsOnline: soft(ctx, "resourceCore")?.list("agent").filter((item) => item.status === "online").length ?? 0,
        skillsPublished: soft(ctx, "skillHub")?.skills().all().filter((item) => item.status === "published").length ?? 0,
        mcpServing: soft(ctx, "mcpRegistry")?.services().all().filter((service) => service.status === "online" || service.status === "gray").length ?? 0
      },
      waic: { count: usageCount, chargeCents },
      byDay,
      funnel: {
        exposed: behaviorCount("card.exposed"),
        clicked: behaviorCount("card.clicked"),
        invoked: usageCount,
        completed: completedCalls
      },
      // ROI 用工成本模型（WP-14）：估算口径声明随响应下发，看板侧必须展示「估算」字样。
      roi: {
        minutesPerCallEstimate: Number(process.env.ROI_MINUTES_PER_CALL ?? 3),
        laborCostCentsPerHour: Number(process.env.ROI_LABOR_COST_CENTS_PER_HOUR ?? 5e3),
        callBase: completedCalls > 0 ? completedCalls : usageCount,
        estimatedHoursSaved: Math.round((completedCalls > 0 ? completedCalls : usageCount) * Number(process.env.ROI_MINUTES_PER_CALL ?? 3) / 60 * 100) / 100,
        estimatedLaborCostCents: Math.round((completedCalls > 0 ? completedCalls : usageCount) * Number(process.env.ROI_MINUTES_PER_CALL ?? 3) / 60 * Number(process.env.ROI_LABOR_COST_CENTS_PER_HOUR ?? 5e3)),
        platformChargeCents: chargeCents,
        note: "\u4F30\u7B97\u53E3\u5F84\uFF1A\u66FF\u4EE3\u5DE5\u65F6 = \u8C03\u7528\u6B21\u6570 \xD7 \u5355\u6B21\u66FF\u4EE3\u5206\u949F \xF7 60\uFF1B\u4EBA\u529B\u6210\u672C = \u66FF\u4EE3\u5DE5\u65F6 \xD7 \u7EFC\u5408\u4EBA\u529B\u65F6\u85AA\u3002\u975E\u5B9E\u6D4B\u503C\u3002"
      }
    };
  });
  guarded("GET", "/api/panel/:dept/channels", "panel.read", (exchange) => {
    const dept = deptOf(exchange);
    const info = caller(exchange);
    return {
      channels: panel.channels().find((item) => item.dept === dept.id).map((channel) => ({
        ...channel,
        unread: info.userId ? panel.unreadCount(info.userId, channel.id) : 0
      }))
    };
  });
  guarded("POST", "/api/panel/:dept/channels", "panel.write", (exchange) => {
    const dept = deptOf(exchange);
    const input = body(exchange);
    if (!input.name?.trim()) throw new Error("\u9891\u9053\u540D\u5FC5\u586B");
    const info = caller(exchange);
    const channel = panel.channels().insert({
      id: newId("pchan"),
      dept: dept.id,
      name: input.name.trim(),
      ...input.desc ? { desc: input.desc.trim() } : {},
      createdBy: info.userId ?? info.principalId
    });
    changeLog(exchange, "panel.channel.create", "panel_channel", channel.id, channel.name);
    return { channel };
  });
  guarded("GET", "/api/panel/:dept/messages", "panel.read", (exchange) => {
    const dept = deptOf(exchange);
    const channelId = exchange.query.get("channelId") ?? "";
    const after = exchange.query.get("after") ?? "";
    const limitRaw = Number(exchange.query.get("limit") ?? 80);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 80, 1), 200);
    let rows = panel.messages().find((m) => m.dept === dept.id && (channelId ? m.channelId === channelId : true));
    if (after) rows = rows.filter((m) => m.createdAt > after);
    return { messages: rows.slice(-limit) };
  });
  guarded("POST", "/api/panel/:dept/messages", "panel.write", async (exchange) => {
    const dept = deptOf(exchange);
    const input = body(exchange);
    if (!input.text?.trim()) throw new Error("\u6D88\u606F\u5185\u5BB9\u5FC5\u586B");
    if (input.text.length > 1e4) throw new Error("\u6D88\u606F\u5185\u5BB9\u8FC7\u957F\uFF08\u4E0A\u9650 10000 \u5B57\u7B26\uFF09");
    const channelId = input.channelId || panel.channels().find((item) => item.dept === dept.id).at(0)?.id;
    if (!channelId) throw new Error("\u90E8\u95E8\u6682\u65E0\u9891\u9053\uFF0C\u8BF7\u5148\u521B\u5EFA");
    const requestedModel = input.model?.trim() ?? "";
    if (requestedModel && !modelGateway()?.gateway.models().findOne((item) => item.slug === requestedModel)) {
      throw new Error(`\u6A21\u578B\u672A\u5728\u76EE\u5F55\u767B\u8BB0\uFF1A${requestedModel}\uFF08\u53EF\u5728\u300C\u{1F9E0} \u6A21\u578B\u300D\u4E2D\u767B\u8BB0\uFF09`);
    }
    const info = caller(exchange);
    const message = await panel.sendMessage({
      dept: dept.id,
      channelId,
      senderType: "human",
      senderId: info.userId,
      senderName: info.name,
      text: input.text.trim(),
      ddSync: input.ddSync === true,
      ...input.uniqueKey ? { uniqueKey: input.uniqueKey } : {},
      ...requestedModel ? { modelOverride: requestedModel } : {},
      // streamAgent（2026-09-11 流式应答卡）：@数字同事 由前端流式端点驱动应答，跳过隐式派发防双跑；
      // 流式端点不可用时前端回落拉取，应答缺失可由用户重发触发（诚实降级，不假装有人在打字）
      ...input.streamAgent === true ? { skipAgentDispatch: true } : {}
    });
    return { message };
  });
  http.register("POST", "/api/panel/:dept/agent-stream", async (exchange) => {
    if (!requirePermission(exchange, "panel.write")) return;
    const res = exchange.res;
    const sse = (payload) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}

`);
      } catch {
      }
    };
    try {
      const dept = deptOf(exchange);
      const input = body(exchange);
      const message = input.messageId ? panel.messages().get(input.messageId) : void 0;
      if (!message || message.dept !== dept.id || message.senderType !== "human") {
        exchange.fail(400, "BAD_REQUEST", "\u6D88\u606F\u4E0D\u5B58\u5728\u6216\u4E0D\u5C5E\u4E8E\u8BE5\u90E8\u95E8");
        return;
      }
      if (res.headersSent) return;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const mentioned = dept.agents.filter((agent) => message.text.includes(`@${agent.name}`));
      if (mentioned.length === 0) {
        sse({ type: "end", note: "\u6D88\u606F\u672A\u70B9\u540D\u4EFB\u4F55\u6570\u5B57\u540C\u4E8B" });
        res.end();
        return;
      }
      const requestedModel = input.model?.trim() || void 0;
      for (const agentCard of mentioned) {
        await panel.streamAgentReply(dept, agentCard, message, requestedModel, sse);
      }
      sse({ type: "end" });
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) {
        sse({ type: "end", error: message });
        res.end();
      } else {
        exchange.fail(400, "BAD_REQUEST", message);
      }
    }
  }, { access: "guarded", permission: "panel.write" });
  guarded("POST", "/api/panel/channels/:id/read", "panel.read", (exchange) => {
    const info = caller(exchange);
    if (!info.userId) throw new Error("\u4EC5\u5E73\u53F0\u8D26\u53F7\u53EF\u63A8\u8FDB\u5DF2\u8BFB\u6E38\u6807");
    panel.markRead(info.userId, String(exchange.params.id));
    return { ok: true };
  });
  guarded("POST", "/api/panel/messages/:id/card-action", "panel.write", async (exchange) => {
    const input = body(exchange);
    if (!input.opId) throw new Error("opId \u5FC5\u586B");
    const info = caller(exchange);
    const result = await panel.cardAction({
      messageId: String(exchange.params.id),
      opId: input.opId,
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      ...input.reason ? { reason: input.reason } : {}
    });
    changeLog(exchange, "panel.card.action", "panel_message", result.message.id, result.message.card?.title ?? "", result.result);
    return result;
  });
  guarded("GET", "/api/panel/:dept/skills", "panel.read", (exchange) => {
    deptOf(exchange);
    return { skills: panel.listInvokeableSkills(orgIdOf(exchange)) };
  });
  guarded("POST", "/api/panel/:dept/skills/invoke", "panel.write", async (exchange) => {
    const dept = deptOf(exchange);
    const input = body(exchange);
    const skillName = input.skill?.trim() ?? "";
    const message = input.message?.trim() ?? "";
    if (!skillName) throw new Error("skill \u5FC5\u586B\uFF08\u6280\u80FD\u540D\u6216 slug\uFF09");
    if (!message) throw new Error("message \u5FC5\u586B\uFF08\u8981\u4EA4\u7ED9\u6280\u80FD\u7684\u8F93\u5165/\u95EE\u9898\uFF09");
    if (message.length > 1e4) throw new Error("\u6D88\u606F\u5185\u5BB9\u8FC7\u957F\uFF08\u4E0A\u9650 10000 \u5B57\u7B26\uFF09");
    const channelId = input.channelId || panel.channels().find((item) => item.dept === dept.id).at(0)?.id;
    if (!channelId) throw new Error("\u90E8\u95E8\u6682\u65E0\u9891\u9053\uFF0C\u8BF7\u5148\u521B\u5EFA");
    const requestedModel = input.model?.trim() ?? "";
    if (requestedModel && !modelGateway()?.gateway.models().findOne((item) => item.slug === requestedModel)) {
      throw new Error(`\u6A21\u578B\u672A\u5728\u76EE\u5F55\u767B\u8BB0\uFF1A${requestedModel}\uFF08\u53EF\u5728\u300C\u{1F9E0} \u6A21\u578B\u300D\u4E2D\u767B\u8BB0\uFF09`);
    }
    const info = caller(exchange);
    const trace = await panel.sendMessage({
      dept: dept.id,
      channelId,
      senderType: "human",
      senderId: info.userId,
      senderName: info.name,
      text: `/${skillName} ${message}`,
      ddSync: false,
      ...requestedModel ? { modelOverride: requestedModel } : {},
      ...input.uniqueKey ? { uniqueKey: input.uniqueKey } : {},
      skipAgentDispatch: true
    });
    changeLog(exchange, "panel.skill.invoke", "panel_message", trace.id, skillName, message.slice(0, 200));
    const result = await panel.invokeSkill(skillName, message, {
      userId: info.userId,
      ...requestedModel ? { modelOverride: requestedModel } : {}
    });
    if (!result.ok) {
      await panel.sendMessage({
        dept: dept.id,
        channelId,
        senderType: "system",
        senderName: "01\u95E8",
        text: `\u26A1 \u6280\u80FD\u300C${skillName}\u300D\u8C03\u7528\u5931\u8D25\uFF1A${result.reason}`,
        ddSync: false
      });
      return { ok: false, reason: result.reason, message: trace };
    }
    const reply = await panel.sendMessage({
      dept: dept.id,
      channelId,
      senderType: "agent",
      senderName: `\u26A1 ${result.skill.name}`,
      senderIcon: "\u26A1",
      agentName: result.skill.name,
      text: result.reply,
      ddSync: false,
      ...result.model ? { replyModel: result.model } : {},
      ...trace.sceneCode ? { sceneCode: trace.sceneCode } : {}
    });
    return { ok: true, reply: result.reply, model: result.model, skill: result.skill, message: trace, replyMessage: reply };
  });
  guarded("GET", "/api/panel/:dept/tasks", "panel.read", (exchange) => ({
    tasks: panel.tasks().find((item) => item.dept === deptOf(exchange).id)
  }));
  guarded("POST", "/api/panel/:dept/tasks", "panel.task.write", (exchange) => {
    const dept = deptOf(exchange);
    const input = body(exchange);
    if (!input.title?.trim()) throw new Error("\u4EFB\u52A1\u6807\u9898\u5FC5\u586B");
    if (input.lane !== void 0 && !TASK_LANES.includes(input.lane)) throw new Error(`\u975E\u6CD5\u6CF3\u9053\uFF1A${input.lane}`);
    const info = caller(exchange);
    const task = panel.createTask({
      dept: dept.id,
      title: input.title.trim(),
      ...input.detail ? { detail: input.detail } : {},
      ...input.lane ? { lane: input.lane } : {},
      ...input.assigneeType === "agent" ? { assigneeType: "agent" } : {},
      ...input.assigneeName ? { assigneeName: input.assigneeName } : {},
      ...input.sceneCode ? { sceneCode: input.sceneCode } : {},
      createdBy: info.userId ?? info.principalId
    });
    return { task };
  });
  guarded("POST", "/api/panel/tasks/:id/transition", "panel.task.write", (exchange) => {
    const lane = body(exchange).lane;
    if (!lane || !TASK_LANES.includes(lane)) throw new Error(`\u975E\u6CD5\u6CF3\u9053\uFF1A${lane}`);
    const info = caller(exchange);
    return { task: panel.transitionTask(String(exchange.params.id), lane, info.userId ?? info.principalId) };
  });
  guarded("GET", "/api/panel/:dept/artifacts", "panel.read", (exchange) => ({
    artifacts: panel.artifacts().find((item) => item.dept === deptOf(exchange).id).slice(-100).reverse()
  }));
  guarded("POST", "/api/panel/:dept/artifacts", "panel.write", (exchange) => {
    const dept = deptOf(exchange);
    const input = body(exchange);
    if (!input.title?.trim() || !input.content?.trim()) throw new Error("\u6807\u9898\u4E0E\u5185\u5BB9\u5FC5\u586B");
    const kind = ["report", "order", "quote", "diagnosis", "other"].includes(input.kind ?? "") ? input.kind : "other";
    const info = caller(exchange);
    const artifact = panel.artifacts().insert({
      id: newId("part"),
      dept: dept.id,
      kind,
      title: input.title.trim(),
      content: input.content.trim(),
      ...input.sceneCode ? { sceneCode: input.sceneCode } : {},
      createdBy: info.userId ?? info.principalId
    });
    changeLog(exchange, "panel.artifact.create", "panel_artifact", artifact.id, artifact.title);
    return { artifact };
  });
  guarded("POST", "/api/panel/:dept/scenes/:code/diagnose", "panel.write", async (exchange) => {
    const info = caller(exchange);
    return panel.diagnose({
      dept: String(exchange.params.dept),
      sceneCode: String(exchange.params.code),
      actorId: info.userId ?? info.principalId,
      actorName: info.name
    });
  });
  guarded("POST", "/api/panel/:dept/scenes/:code/sync-dingtalk", "panel.write", (exchange) => {
    const dept = deptOf(exchange);
    const code = String(exchange.params.code);
    const { pack, sceneLabel } = panel.sceneContext(code);
    const info = caller(exchange);
    ctx.platformBus.emit(PlatformEvents.PanelCardAction, {
      dept: dept.id,
      opId: "scene-sync",
      opLabel: "\u540C\u6B65\u9489\u9489\u7FA4",
      action: "dd.push",
      ddPush: true,
      title: `\u{1F5FA} ${pack.name}\u573A\u666F\u5361\uFF1A${sceneLabel}`,
      text: `\u3010${pack.name} \xB7 ${code}\u3011${sceneLabel}
\u75DB\u70B9\u4E0E\u56DB\u6E05\u5355\u8BE6\u89C1\u90E8\u95E8\u9762\u677F\u300C\u573A\u666F\u56FE\u8C31\u300D\u9875\u3002`,
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      channelName: ""
    });
    changeLog(exchange, "panel.scene.sync_dingtalk", "panel_scene", code, sceneLabel);
    return { ok: true, note: "\u5DF2\u8BF7\u6C42\u9489\u9489\u6865\u63A5\u6295\u9012\uFF08\u672A\u7ED1\u5B9A\u7FA4\u6865\u65F6\u6295\u9012\u5931\u8D25\u4F1A\u7559\u75D5\u544A\u8B66\uFF09" };
  });
  guarded("GET", "/api/panel/industries", "panel.read", (exchange) => {
    const orgId = orgIdOf(exchange);
    const pendingCodes = soft(ctx, "audit")?.approvals().find((item) => item.kind === "industry.activation" && item.status === "pending" && String(item.payload.orgId ?? "") === orgId).map((item) => String(item.payload.code ?? "")) ?? [];
    return { industries: panel.industryStates(orgId, pendingCodes) };
  });
  guarded("POST", "/api/panel/industries/:code/activate-requests", "panel.write", (exchange) => {
    const audit = soft(ctx, "audit");
    if (!audit) return degraded(exchange, "\u5BA1\u6279\u4E2D\u5FC3");
    const code = String(exchange.params.code ?? "").toUpperCase();
    const registry = panel.industryStates("", []).find((item) => item.code === code);
    if (!registry) throw new Error(`\u672A\u767B\u8BB0\u884C\u4E1A\uFF1A${code}`);
    const orgId = orgIdOf(exchange);
    if (!orgId) throw new Error("\u65E0\u6CD5\u786E\u5B9A\u6240\u5C5E\u7EC4\u7EC7\uFF08\u7EC4\u7EC7\u8D26\u53F7\u7F3A\u5931\uFF09");
    const existing = panel.activations().findOne((item) => item.orgId === orgId && item.code === code && item.status === "active");
    if (existing) throw new Error(`\u884C\u4E1A ${code} \u5BF9\u672C\u7EC4\u7EC7\u5DF2\u662F\u6FC0\u6D3B\u6001`);
    const info = caller(exchange);
    const approval = audit.createApproval({
      kind: "industry.activation",
      // WP-10/L1（QA A-06）：L4 高危统一高风险——通过需二次确认 + 公司级终审标记
      riskLevel: "high",
      title: `\u884C\u4E1A\u529F\u80FD\u5305\u6388\u6743\u6FC0\u6D3B\uFF1A${registry.name}\uFF08${code}\uFF09`,
      payload: { code, orgId, requestedBy: info.name, sub: registry.sub, graphLoaded: registry.graphLoaded },
      requesterId: info.userId ?? info.principalId,
      requesterName: info.name,
      riskLevel: "high"
    });
    changeLog(exchange, "panel.industry.activate_request", "panel_industry", code, registry.name, `\u5BA1\u6279\u5355 ${approval.id}`);
    return { approval };
  });
  guarded("GET", "/api/panel/scenegraph", "scenegraph.read", (exchange) => {
    const code = (exchange.query.get("industry") ?? "").toUpperCase();
    const pack = ctx.scenegraphs.get(code);
    if (!pack) throw new Error(`\u573A\u666F\u56FE\u8C31\u672A\u88C5\u8F7D\u6216\u672A\u6FC0\u6D3B\uFF1A${code}\uFF08\u5DF2\u88C5\u8F7D\uFF1A${ctx.scenegraphs.all().map((item) => item.code).join("/") || "\u65E0"}\uFF09`);
    return { pack, problems: ctx.scenegraphs.loadProblems() };
  });
  guarded("POST", "/api/panel/scenegraphs/reload", "panel.config.write", async (exchange) => {
    const result = await ctx.scenegraphs.reloadFromDir();
    changeLog(exchange, "panel.scenegraph.reload", "scenegraph", "all", `${result.packs} \u5305`, `\u95EE\u9898 ${result.problems.length} \u9879`);
    return result;
  });
  guarded("GET", "/api/panel/:dept/poll", "panel.read", (exchange) => {
    const dept = deptOf(exchange);
    const info = caller(exchange);
    const since = exchange.query.get("since") ?? "";
    const messages = panel.messages().find((m) => m.dept === dept.id && (since ? m.createdAt > since : true)).slice(-50);
    return {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      messages,
      tasks: panel.tasks().find((item) => item.dept === dept.id),
      unread: info.userId ? panel.channels().find((item) => item.dept === dept.id).map((channel) => ({ channelId: channel.id, unread: panel.unreadCount(info.userId, channel.id) })) : []
    };
  });
  const streamTickets = /* @__PURE__ */ new Map();
  const STREAM_TICKET_TTL_MS = 6e4;
  const issueStreamTicket = (principal, dept) => {
    const now = Date.now();
    for (const [key, value] of streamTickets) if (value.expiresAt < now) streamTickets.delete(key);
    const raw = "stk_" + randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    streamTickets.set(createHash("sha256").update(raw).digest("hex"), { principal, dept, expiresAt: now + STREAM_TICKET_TTL_MS });
    return raw;
  };
  guarded("POST", "/api/panel/stream-ticket", "panel.read", (exchange) => {
    const dept = String(body(exchange).dept ?? "");
    if (!DEPT_RE.test(dept)) throw new Error(`\u90E8\u95E8\u6807\u8BC6\u975E\u6CD5\uFF1A${dept}`);
    const deptConfig = panel.dept(dept);
    if (!panel.deptScopeAllowed(caller(exchange), deptConfig)) {
      exchange.fail(403, "FORBIDDEN", `\u90E8\u95E8\u8303\u56F4\u53D7\u9650\uFF1A${deptConfig.label} \u5DF2\u7ED1\u5B9A\u7EC4\u7EC7\u6CBB\u7406\uFF0C\u4EC5\u8BE5\u7EC4\u7EC7\u5B50\u6811\u6210\u5458\u53EF\u8BBF\u95EE`, { permission: "panel.read", deptScope: deptConfig.orgId });
      return;
    }
    return { ticket: issueStreamTicket(caller(exchange), dept), expiresInSeconds: STREAM_TICKET_TTL_MS / 1e3 };
  });
  http.register("GET", "/api/panel/stream", (exchange) => {
    const fail = (status, message) => exchange.fail(status, "STREAM_AUTH_FAILED", message);
    let dept = exchange.query.get("dept") ?? "";
    const ticketRaw = exchange.query.get("ticket") ?? "";
    if (!ticketRaw && !exchange.query.get("token")) return fail(401, "\u7F3A\u5C11 ticket/token \u67E5\u8BE2\u53C2\u6570");
    if (ticketRaw) {
      const key = createHash("sha256").update(ticketRaw).digest("hex");
      const entry = streamTickets.get(key);
      if (!entry || entry.expiresAt < Date.now()) {
        streamTickets.delete(key);
        return fail(401, "ticket \u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u83B7\u53D6");
      }
      streamTickets.delete(key);
      const queryDept = dept;
      dept = entry.dept;
      if (queryDept && queryDept !== dept) return fail(400, `dept \u67E5\u8BE2\u53C2\u6570\u4E0E ticket \u7B7E\u53D1\u90E8\u95E8\u4E0D\u4E00\u81F4\uFF1A${queryDept} \u2260 ${dept}`);
      exchange.principal = entry.principal;
      if (!requirePermission(exchange, "panel.read")) return;
    } else {
      const token = exchange.query.get("token") ?? "";
      if (!token) return fail(401, "\u7F3A\u5C11 token \u67E5\u8BE2\u53C2\u6570");
      if (!DEPT_RE.test(dept)) return fail(400, `\u90E8\u95E8\u6807\u8BC6\u975E\u6CD5\uFF1A${dept}`);
      const authn = soft(ctx, "authn");
      if (!authn) return fail(401, "\u8BA4\u8BC1\u4E2D\u5FC3\u672A\u63A5\u5165\uFF0801\u95E8\u6F14\u793A\u6001\uFF09\u2014\u2014\u8FDE\u63A5\u5BBF\u4E3B\u540E\u53EF\u8BA2\u9605\u5B9E\u65F6\u6D41");
      try {
        const verified = authn.verify(token);
        exchange.principal = {
          kind: verified.principal.type,
          principalId: verified.principal.id,
          ...verified.principal.type === "human" && verified.principal.refId ? { userId: verified.principal.refId } : {},
          ...verified.principal.type === "machine" ? { refType: verified.principal.refType, refId: verified.principal.refId } : {},
          name: verified.principal.name,
          permissions: verified.scopes,
          actChain: verified.actChain
        };
      } catch (error) {
        return fail(401, `\u4EE4\u724C\u65E0\u6548\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
      if (!requirePermission(exchange, "panel.read")) return;
    }
    const deptConfig = (() => {
      try {
        return panel.dept(dept);
      } catch {
        return void 0;
      }
    })();
    if (!deptConfig) return fail(404, `\u90E8\u95E8\u4E0D\u5B58\u5728\uFF1A${dept}`);
    if (!panel.deptScopeAllowed(caller(exchange), deptConfig)) {
      exchange.fail(403, "FORBIDDEN", `\u90E8\u95E8\u8303\u56F4\u53D7\u9650\uFF1A${deptConfig.label} \u5DF2\u7ED1\u5B9A\u7EC4\u7EC7\u6CBB\u7406\uFF0C\u4EC5\u8BE5\u7EC4\u7EC7\u5B50\u6811\u6210\u5458\u53EF\u8BBF\u95EE`, { permission: "panel.read", deptScope: deptConfig.orgId });
      return;
    }
    const res = exchange.res;
    if (res.headersSent) return;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.write("retry: 5000\n\n");
    const unsubscribe = panel.subscribeStream(dept, (event) => {
      try {
        res.write(`data: ${JSON.stringify({ name: event.name, payload: event.payload })}

`);
      } catch {
      }
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
      }
    }, 25e3);
    exchange.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }, { access: "public", selfValidated: true });
  const offExecutor = soft(ctx, "audit")?.registerExecutor("industry.activation", panel.buildActivationExecutor()) ?? (() => {
  });
  panel.wireEventBus();
  const offDelivered = ctx.platformBus.on(PlatformEvents.DingtalkDelivered, (payload) => {
    const { messageId, ok, error } = payload ?? {};
    if (!messageId) return;
    const message = panel.messages().get(messageId);
    if (!message) return;
    if (ok) {
      if (message.ddSync !== "sent") panel.messages().update(messageId, { ddSync: "sent" });
      return;
    }
    if (message.ddSync !== "pending") return;
    panel.messages().update(messageId, { ddSync: "failed" });
    if (error) {
      soft(ctx, "audit")?.fire({ severity: "warning", title: "\u9489\u9489\u6865\u63A5\u6295\u9012\u5931\u8D25", message: `\u6D88\u606F ${messageId} \u6295\u9012\u5931\u8D25\uFF1A${error}`, resourceType: "panel_message", resourceId: messageId });
    }
  });
  ctx.effect(() => () => {
    offExecutor();
    offDelivered();
  });
  const loginViaAuthn = () => {
    const authn = soft(ctx, "authn");
    const iam = soft(ctx, "iam");
    if (!authn || !iam) return void 0;
    return {
      login: (username, password) => {
        const result = authn.login(username, password);
        const user = iam.users().get(result.userId);
        return {
          token: result.token,
          refreshToken: result.refreshToken,
          expiresAt: result.record.expiresAt,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            orgId: user.orgId,
            roleIds: user.roleIds,
            roles: user.roleIds.map((roleId) => iam.roles().get(roleId)?.name).filter(Boolean),
            permissions: iam.userPermissions(user.id)
          }
        };
      },
      refresh: (refreshToken) => authn.refreshSession(refreshToken)
    };
  };
  http.register("POST", "/api/panel/auth/login", (exchange) => {
    const backend = loginViaAuthn();
    if (!backend) {
      exchange.fail(503, "AUTHN_UNAVAILABLE", "\u8BA4\u8BC1\u9762\u672A\u5C31\u7EEA\uFF08\u672C\u673A\u5F62\u6001\u672A\u88C5\u914D\u8BA4\u8BC1\u4E2D\u5FC3\uFF09\u2014\u2014\u8BF7\u4ECE\u5BBF\u4E3B/\u63A7\u5236\u53F0\u767B\u5F55");
      return;
    }
    const { username, password } = body(exchange);
    if (!username || !password) {
      exchange.fail(400, "BAD_REQUEST", "\u7528\u6237\u540D\u4E0E\u5BC6\u7801\u5FC5\u586B");
      return;
    }
    try {
      exchange.ok(backend.login(username, password));
    } catch (error) {
      exchange.fail(401, "LOGIN_FAILED", error instanceof Error ? error.message : String(error));
    }
  }, { access: "public" });
  http.register("POST", "/api/panel/auth/refresh", (exchange) => {
    const backend = loginViaAuthn();
    if (!backend) {
      exchange.fail(503, "AUTHN_UNAVAILABLE", "\u8BA4\u8BC1\u9762\u672A\u5C31\u7EEA\uFF08\u672C\u673A\u5F62\u6001\u672A\u88C5\u914D\u8BA4\u8BC1\u4E2D\u5FC3\uFF09");
      return;
    }
    const { refreshToken } = body(exchange);
    if (!refreshToken) {
      exchange.fail(400, "BAD_REQUEST", "refreshToken \u5FC5\u586B");
      return;
    }
    try {
      const result = backend.refresh(refreshToken);
      exchange.ok({ token: result.token, refreshToken: result.refreshToken });
    } catch (error) {
      exchange.fail(401, "REFRESH_FAILED", error instanceof Error ? error.message : String(error));
    }
  }, { access: "public" });
  const dingtalkBridgePresent = Boolean(soft(ctx, "dingtalkBridge"));
  {
    const dws = new DwsCli(ctx);
    guarded("GET", "/api/panel/ddws/status", "panel.read", async () => {
      const status = await dws.status();
      return {
        ...status,
        via: "dws-cli",
        // 形状兼容（app.js renderTopRight 消费）：bound=false | {displayName,...}
        bound: status.bound && status.group ? { displayName: status.group, via: "dws-cli" } : false,
        connector: { configured: status.installed, name: `dws CLI${status.version ? ` ${status.version}` : ""}`, mode: status.installed ? "real" : "mock" }
      };
    });
    guarded("POST", "/api/panel/ddws/install", "panel.config.write", async () => dws.install());
    guarded("POST", "/api/panel/ddws/login", "panel.config.write", async () => dws.startLogin());
    guarded("GET", "/api/panel/ddws/login", "panel.read", async () => dws.loginState());
    guarded("DELETE", "/api/panel/ddws/login", "panel.config.write", () => {
      dws.cancelLogin();
      return { cancelled: true };
    });
    guarded("PUT", "/api/panel/ddws/bind", "panel.config.write", (exchange) => {
      const group = body(exchange).group?.trim() ?? "";
      const record = dws.bind(group, caller(exchange).userId ?? caller(exchange).principalId);
      return { bound: true, group: record.group };
    });
    guarded("DELETE", "/api/panel/ddws/bind", "panel.config.write", () => {
      dws.unbind();
      return { bound: false };
    });
    guarded("POST", "/api/panel/ddws/test", "panel.write", async (exchange) => {
      const text = body(exchange).text?.trim() || "01\u95E8\u9762\u677F dws \u8FDE\u901A\u6027\u6D4B\u8BD5";
      try {
        const sent = await dws.sendToGroup(text);
        return { ok: true, group: sent.group };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    guarded("POST", "/api/panel/ddws/pull", "panel.write", async (exchange) => {
      const dept = deptOf(exchange);
      const input = body(exchange);
      const channelId = input.channelId || panel.channels().find((item) => item.dept === dept.id).at(0)?.id;
      if (!channelId) throw new Error("\u90E8\u95E8\u6682\u65E0\u9891\u9053\uFF0C\u8BF7\u5148\u521B\u5EFA");
      const channel = panel.channels().get(channelId);
      if (!channel || channel.dept !== dept.id) throw new Error(`\u9891\u9053\u4E0D\u5B58\u5728\u6216\u4E0D\u5C5E\u4E8E\u8BE5\u90E8\u95E8\uFF1A${channelId}`);
      const info = caller(exchange);
      try {
        const incoming = await dws.pullLatestMessages(Math.floor(Number(input.limit) || 20));
        let inserted = 0;
        for (const item of incoming) {
          const uniqueKey = `dws:${item.messageId}`;
          if (panel.messages().findOne((m) => m.channelId === channelId && m.uniqueKey === uniqueKey)) continue;
          await panel.sendMessage({
            dept: dept.id,
            channelId,
            senderType: "human",
            senderId: info.userId,
            senderName: `${item.sender} \xB7 \u9489\u9489`,
            text: item.text,
            ddSync: false,
            sceneCode: void 0,
            uniqueKey
          });
          inserted += 1;
        }
        return { ok: true, inserted, fetched: incoming.length, group: channel.name };
      } catch (error) {
        return { ok: false, inserted: 0, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ctx.platformBus.on(PlatformEvents.PanelMessageCreated, (payload) => {
      const data = payload ?? {};
      if (!data.messageId || data.ddSync !== "pending") return;
      const bridgeSvc = soft(ctx, "dingtalkBridge");
      if (bridgeSvc?.bridgeChannels?.().find((item) => item.purpose === "channel").length > 0) return;
      void dws.sendToGroup(String(data.text ?? "")).then(
        (sent) => ctx.platformBus.emit(PlatformEvents.DingtalkDelivered, { messageId: data.messageId, ok: true, via: "dws-cli", group: sent.group }),
        (error) => ctx.platformBus.emit(PlatformEvents.DingtalkDelivered, {
          messageId: data.messageId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    });
    ctx.logger("panel-core").info(`01\u95E8\u672C\u5730\u9489\u9489\u9762\u5DF2\u6302\u8F7D\uFF1Adws CLI \u6865\uFF08/api/panel/ddws/*\uFF0C\u5BBF\u4E3B\u6865${dingtalkBridgePresent ? "\u5728\u573A\u5171\u5B58" : "\u7F3A\u5E2D\u72EC\u4EFB"}\uFF1BddSync \u6295\u9012\u6309\u7FA4\u6865\u5F52\u5C5E\u88C1\u51B3\uFF09`);
  }
  {
    let seedTries = 0;
    const seedTimer = setInterval(() => {
      seedTries += 1;
      const iamNow = soft(ctx, "iam");
      if (!iamNow) {
        if (seedTries >= 60) {
          clearInterval(seedTimer);
          ctx.logger("panel-core").info("iam \u672A\u5C31\u7EEA\uFF0C\u8DF3\u8FC7 01\u95E8\u57FA\u7EBF\u7BA1\u7406\u5458\u79CD\u5B50\uFF08\u7EAF\u6F14\u793A\u6001\uFF09");
        }
        return;
      }
      clearInterval(seedTimer);
      if (iamNow.orgs().count() > 0) return;
      try {
        iamNow.ensureBuiltinRoles();
        const root = iamNow.createOrg({ name: process.env.ORG_NAME ?? "\u5143\u51B0\u53EF\u96C6\u56E2" });
        const roleSuper = iamNow.roles().findOne((role) => role.code === "super_admin");
        const { user, initialPassword } = iamNow.createUser({
          username: "admin",
          displayName: "\u5E73\u53F0\u7BA1\u7406\u5458",
          orgId: root.id,
          title: "\u5E73\u53F0\u7BA1\u7406\u5458",
          roleIds: [roleSuper.id],
          password: process.env.ADMIN_PASSWORD
        });
        iamNow.users().update(user.id, { status: "active" });
        void user;
        if (initialPassword) {
          const file = join(ctx.opsStorage.dataDirPath, "admin-initial-password.txt");
          if (!existsSync(file)) {
            writeFileSync(file, `\u5E73\u53F0\u7BA1\u7406\u5458 admin \u7684\u521D\u59CB\u53E3\u4EE4\uFF08\u4EC5\u751F\u6210\u4E00\u6B21\uFF1B\u9996\u6B21\u767B\u5F55\u540E\u8BF7\u59A5\u5584\u4FDD\u7BA1\u5E76\u5220\u9664\u672C\u6587\u4EF6\uFF09\uFF1A
${initialPassword}
`, "utf8");
          }
        }
        ctx.logger("panel-core").info("01\u95E8\u88C5\u6001\u57FA\u7EBF\u79CD\u5B50\u5B8C\u6210\uFF1A\u5185\u7F6E\u89D2\u8272 + \u6839\u7EC4\u7EC7 + \u5E73\u53F0\u7BA1\u7406\u5458 admin\uFF08\u521D\u59CB\u53E3\u4EE4\u89C1 data/admin-initial-password.txt\uFF09");
      } catch (error) {
        ctx.logger("panel-core").warn(`01\u95E8\u88C5\u6001\u57FA\u7EBF\u79CD\u5B50\u5931\u8D25\uFF08\u4E0D\u963B\u65AD\u88C5\u914D\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
    }, 500);
    ctx.effect(() => () => clearInterval(seedTimer));
  }
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  if (existsSync(publicDir)) {
    if (config.landingRedirect) {
      http.register("GET", "/", (exchange) => {
        exchange.res.writeHead(302, { location: `${http.externalBase}/panel/` }).end();
      });
    }
    http.register("GET", "/panel", (exchange) => {
      if (exchange.path.endsWith("/")) {
        exchange.file(join(publicDir, "index.html"));
        return;
      }
      exchange.res.writeHead(302, { location: `${http.externalBase}/panel/` }).end();
    });
    http.serveStatic("/panel", publicDir, "/index.html");
  }
  void seedPanel(ctx, panel, demoAuth);
  const renderJson = (args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }];
  ctx.tools.register({
    name: "panel_agents_list",
    description: "\u5217\u51FA\u90E8\u95E8\u9762\u677F\u7684 Agent \u9635\u5BB9\uFF08\u540D\u79F0/\u804C\u8D23/\u7ED1\u5B9A\u8D44\u4EA7\uFF09\uFF0C\u7528\u4E8E\u9009\u62E9\u534F\u4F5C\u5BF9\u8C61",
    permission: "panel.read",
    parameters: { type: "object", properties: { dept: { type: "string", description: "\u90E8\u95E8\u6807\u8BC6\uFF08rd/mfg/sales/strategy/fin\uFF09\uFF0C\u7F3A\u7701\u5217\u51FA\u5168\u90E8\u90E8\u95E8" } } },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args) {
      const dept = args.dept;
      const configs = dept ? [panel.dept(dept)] : panel.deptConfigs().all();
      return configs.map((config2) => ({ dept: config2.id, label: config2.label, agents: config2.agents }));
    }
  });
  ctx.tools.register({
    name: "panel_msg_send",
    description: "\u5411\u90E8\u95E8\u534F\u4F5C\u9891\u9053\u53D1\u6D88\u606F\uFF08\u53EF\u9009 --sync-dingtalk \u8BED\u4E49\uFF1Async_dingtalk=true \u65F6\u7ECF\u9489\u9489\u6865\u63A5\u540C\u6B65\u5230\u7FA4\uFF09",
    permission: "panel.write",
    parameters: {
      type: "object",
      properties: {
        dept: { type: "string", description: "\u90E8\u95E8\u6807\u8BC6" },
        channel_id: { type: "string", description: "\u9891\u9053 id\uFF0C\u7F3A\u7701\u53D6\u90E8\u95E8\u9996\u4E2A\u9891\u9053" },
        text: { type: "string", description: "\u6D88\u606F\u6587\u672C\uFF08\u652F\u6301 @Agent\u540D \u5524\u8D77\uFF09" },
        sync_dingtalk: { type: "boolean", description: "\u662F\u5426\u540C\u6B65\u5230\u9489\u9489\u7FA4\uFF08\u9700\u5DF2\u7ED1\u5B9A\u7FA4\u6865\uFF09" }
      },
      required: ["dept", "text"]
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args, exec) {
      const input = args;
      const channelId = input.channel_id || panel.channels().find((item) => item.dept === input.dept).at(0)?.id;
      if (!channelId) throw new Error(`\u90E8\u95E8 ${input.dept} \u6682\u65E0\u9891\u9053`);
      const message = await panel.sendMessage({
        dept: input.dept,
        channelId,
        senderType: "human",
        senderId: exec.principal?.userId,
        senderName: exec.principal?.name ?? "\u5DE5\u5177\u8C03\u7528",
        text: input.text,
        ddSync: input.sync_dingtalk === true
      });
      return { messageId: message.id, ddSync: message.ddSync };
    }
  });
  ctx.tools.register({
    name: "panel_task_create",
    description: "\u5728\u90E8\u95E8\u4EFB\u52A1\u770B\u677F\u521B\u5EFA\u4EFB\u52A1\u5361\uFF08\u6CF3\u9053 todo/doing/review/done\uFF0C\u7F3A\u7701 todo\uFF09",
    permission: "panel.task.write",
    parameters: {
      type: "object",
      properties: {
        dept: { type: "string", description: "\u90E8\u95E8\u6807\u8BC6" },
        title: { type: "string", description: "\u4EFB\u52A1\u6807\u9898" },
        detail: { type: "string", description: "\u4EFB\u52A1\u8BE6\u60C5" },
        lane: { type: "string", enum: ["todo", "doing", "review", "done"], description: "\u76EE\u6807\u6CF3\u9053" },
        scene_code: { type: "string", description: "\u5173\u8054\u573A\u666F\u56FE\u8C31\u7F16\u53F7\uFF08\u5982 QB01-A-2-5\uFF09" }
      },
      required: ["dept", "title"]
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args, exec) {
      const input = args;
      const task = panel.createTask({
        dept: input.dept,
        title: input.title,
        ...input.detail ? { detail: input.detail } : {},
        ...input.lane ? { lane: input.lane } : {},
        ...input.scene_code ? { sceneCode: input.scene_code } : {},
        createdBy: exec.principal?.userId ?? exec.principal?.principalId ?? "tool"
      });
      return { taskId: task.id, lane: task.lane };
    }
  });
  ctx.tools.register({
    name: "panel_task_transition",
    description: "\u8FC1\u79FB\u90E8\u95E8\u4EFB\u52A1\u5230\u6307\u5B9A\u6CF3\u9053\uFF08todo/doing/review/done\uFF09",
    permission: "panel.task.write",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string", description: "\u4EFB\u52A1 id" }, lane: { type: "string", enum: ["todo", "doing", "review", "done"], description: "\u76EE\u6807\u6CF3\u9053" } },
      required: ["task_id", "lane"]
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args, exec) {
      const input = args;
      const task = panel.transitionTask(input.task_id, input.lane, exec.principal?.userId ?? "tool");
      return { taskId: task.id, lane: task.lane };
    }
  });
  ctx.tools.register({
    name: "panel_scene_diag",
    description: "\u5BF9\u884C\u4E1A\u573A\u666F\u56FE\u8C31\u4E2D\u7684\u573A\u666F\u53D1\u8D77\u6570\u5B57\u5316\u8BCA\u65AD\uFF08\u751F\u6210\u8BCA\u65AD\u4EFB\u52A1\u5E76\u8FDB\u5165\u534F\u4F5C\u4F1A\u8BDD\uFF09",
    permission: "panel.write",
    parameters: {
      type: "object",
      properties: { dept: { type: "string", description: "\u90E8\u95E8\u6807\u8BC6" }, scene_code: { type: "string", description: "\u573A\u666F\u7F16\u53F7\uFF08\u5982 QB01-A-2-5\uFF09" } },
      required: ["dept", "scene_code"]
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args, exec) {
      const input = args;
      const result = await panel.diagnose({
        dept: input.dept,
        sceneCode: input.scene_code,
        actorId: exec.principal?.userId ?? "tool",
        actorName: exec.principal?.name ?? "\u5DE5\u5177\u8C03\u7528"
      });
      return { messageId: result.message.id, taskId: result.task.id };
    }
  });
  ctx.tools.register({
    name: "panel_widget_data",
    description: "\u8BFB\u53D6\u90E8\u95E8\u770B\u677F widget \u6570\u636E\uFF08\u542B\u6765\u6E90\u5FBD\u6807\u4E0E\u964D\u7EA7\u6807\u8BB0\uFF09",
    permission: "panel.read",
    parameters: {
      type: "object",
      properties: { dept: { type: "string", description: "\u90E8\u95E8\u6807\u8BC6" }, widget_id: { type: "string", description: "widget id\uFF0C\u7F3A\u7701\u8FD4\u56DE\u5168\u90E8" } },
      required: ["dept"]
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args) {
      const input = args;
      const dept = panel.dept(input.dept);
      const widgets = panel.board(dept);
      return input.widget_id ? widgets.filter((widget) => widget.id === input.widget_id) : widgets;
    }
  });
  ctx.tools.register({
    name: "panel_agent_invoke",
    description: "\u70B9\u540D\u8C03\u7528\u90E8\u95E8\u9762\u677F\u7684\u67D0\u4E2A Agent \u63D0\u95EE\u5E76\u540C\u6B65\u53D6\u56DE\u5E94\u7B54\uFF08dsh \u6807\u51C6\u5BF9\u8BDD\u534F\u4F5C\u4E3B\u901A\u9053\uFF09\uFF1A\u6309\u90E8\u95E8\u540D\u518C\u5168\u540D\u5339\u914D\uFF0C\u7ECF\u9762\u677F Agent \u8D44\u4EA7\uFF08agentRef/model/systemPrompt\uFF09+ \u884C\u4E1A\u573A\u666F\u6458\u8981\u7EC4\u88C5\u4E0A\u4E0B\u6587\uFF0C\u5355\u8F6E\u8C03\u7528\u6A21\u578B\u7F51\u5173\u3002\u5E94\u7B54\u4E0D\u843D\u9891\u9053\u6D88\u606F\uFF1B\u5982\u9700\u7559\u75D5\u8BF7\u914D\u5408 panel_msg_send\u3002\u5931\u8D25\u8BDA\u5B9E\u8FD4\u56DE ok:false\uFF08\u4E0D\u9020\u5047\u56DE\u590D\uFF09\u3002",
    permission: "panel.write",
    parameters: {
      type: "object",
      properties: {
        dept: { type: "string", description: "\u90E8\u95E8\u6807\u8BC6\uFF08rd/mfg/sales/strategy/fin\uFF09" },
        agent: { type: "string", description: "Agent \u540D\u518C\u5168\u540D\uFF08\u53EF\u7528 panel_agents_list \u67E5\u8BE2\uFF0C\u5982\u300C\u8D28\u91CF\u5206\u6790 Agent\u300D\uFF09" },
        message: { type: "string", description: "\u8981\u95EE\u8BE5 Agent \u7684\u95EE\u9898/\u6307\u4EE4" },
        context_note: { type: "string", description: "\u9644\u52A0\u4E0A\u4E0B\u6587\u8BF4\u660E\uFF08\u53EF\u9009\uFF0C\u62FC\u5165\u7CFB\u7EDF\u63D0\u793A\uFF09" }
      },
      required: ["dept", "agent", "message"]
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args, exec) {
      const input = args;
      return await panel.askAgent(input.dept, input.agent, input.message, {
        userId: exec.principal?.userId,
        ...input.context_note ? { contextNote: input.context_note } : {}
      });
    }
  });
  ctx.tools.register({
    name: "panel_skill_invoke",
    description: "\u70B9\u540D\u8C03\u7528\u6280\u80FD\u5E73\u53F0\u4E0A\u67B6\u7684\u67D0\u4E2A Skill \u5E76\u540C\u6B65\u53D6\u56DE\u6267\u884C\u7ED3\u679C\uFF08\u9762\u677F\u5BF9\u8BDD\u6846 /\u6280\u80FD\u540D \u76F4\u8C03\u7684\u540C\u4E00\u670D\u52A1\u539F\u8BED\uFF09\uFF1A\u6309\u6280\u80FD\u540D\u6216 slug \u5168\u540D\u5339\u914D\uFF08\u987B\u4E3A\u5DF2\u4E0A\u67B6\u4E14\u5BF9\u8C03\u7528\u4EBA\u7EC4\u7EC7\u5F00\u653E\u7684\u6280\u80FD\uFF09\uFF0C\u53D6\u5F53\u524D\u7248\u672C\u6307\u4EE4\u5185\u5BB9\u7EC4\u88C5\u4E0A\u4E0B\u6587\uFF0C\u5355\u8F6E\u8C03\u7528\u6A21\u578B\u7F51\u5173\u3002\u5931\u8D25\u8BDA\u5B9E\u8FD4\u56DE ok:false + \u539F\u56E0\uFF08\u4E0D\u5B58\u5728/\u672A\u4E0A\u67B6/\u4E0D\u53EF\u89C1/\u65E0\u5185\u5BB9/\u7F51\u5173\u5931\u8D25\uFF09\uFF0C\u4E0D\u9020\u5047\u56DE\u590D\u3002",
    permission: "panel.write",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "\u6280\u80FD\u540D\u6216 slug\uFF08\u5DF2\u4E0A\u67B6 published \u6280\u80FD\uFF09" },
        message: { type: "string", description: "\u8981\u4EA4\u7ED9\u6280\u80FD\u7684\u8F93\u5165/\u95EE\u9898" },
        context_note: { type: "string", description: "\u9644\u52A0\u4E0A\u4E0B\u6587\u8BF4\u660E\uFF08\u53EF\u9009\uFF0C\u62FC\u5165\u7CFB\u7EDF\u63D0\u793A\uFF09" }
      },
      required: ["skill", "message"]
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args, exec) {
      const input = args;
      return await panel.invokeSkill(input.skill, input.message, {
        userId: exec.principal?.userId,
        ...input.context_note ? { contextNote: input.context_note } : {}
      });
    }
  });
  ctx.tools.register({
    name: "panel_board_digest",
    description: "\u8BFB\u53D6\u6218\u7565\u770B\u677F\u805A\u5408\u6458\u8981\uFF08\u8FD1 7 \u5929\uFF09\uFF1A\u8D44\u4EA7\u5728\u7EBF\u6570\u3001\u8C03\u7528\u6F0F\u6597\uFF08\u66DD\u5149\u2192\u70B9\u51FB\u2192\u8C03\u7528\u2192\u5B8C\u6210\uFF09\u3001\u8BA1\u91CF\u4E0E ROI \u4F30\u7B97\u3001\u6307\u5B9A\u5E73\u53F0\u5361\u7247\u5305\u6807\u9898\u6E05\u5355\u3002\u7ED9\u5BF9\u8BDD/Agent \u505A\u770B\u677F\u63A5\u5730\u7684\u4E8B\u5B9E\u6E90\uFF08\u5B8C\u6574\u6570\u636E\u8D70 GET /api/panel/board\uFF09\u3002",
    permission: "panel.read",
    parameters: {
      type: "object",
      properties: { platform: { type: "string", description: `\u5361\u7247\u5305\u5E73\u53F0\uFF08${CARD_PLATFORMS.join("/")}\uFF09\uFF0C\u7F3A\u7701 rd` } }
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args, exec) {
      const input = args;
      const available = [...new Set(cardpacks.all().map((pack) => pack.platform))];
      const requested = input.platform ?? process.env.RQ_PLATFORM ?? (available.includes("rd") ? "rd" : available[0]) ?? "strategy";
      if (!CARD_PLATFORMS.includes(requested)) {
        throw new Error(`platform \u975E\u6CD5\uFF08\u5E94\u4E3A ${CARD_PLATFORMS.join("/")}\uFF09`);
      }
      const platform = requested;
      const info = exec.principal;
      const iam = soft(ctx, "iam");
      const user = info?.userId ? iam?.users().get(info.userId) : void 0;
      const roles = user ? user.roleIds.map((roleId) => iam?.roles().get(roleId)?.code).filter((code) => Boolean(code)) : [];
      cardpacks.setRefAliveResolver(refAlive);
      const packs = cardpacks.forPlatform(platform);
      const { cards } = filterCards({ packs, roles, refAlive });
      const weekAgo = new Date(Date.now() - 7 * 24 * 36e5).toISOString();
      const behaviorCount = (type) => {
        return soft(ctx, "behavior")?.query({ type, from: weekAgo }).total ?? 0;
      };
      const usageTotals = soft(ctx, "usage")?.totals({ from: weekAgo });
      const usageCount = usageTotals?.count ?? 0;
      const chargeCents = usageTotals?.charge_cents ?? 0;
      const completedCalls = soft(ctx, "mcpRegistry")?.calls().all().filter((call) => call.ok && call.at >= weekAgo).length ?? 0;
      const minutesPerCall = Number(process.env.ROI_MINUTES_PER_CALL ?? 3);
      const callBase = completedCalls > 0 ? completedCalls : usageCount;
      return {
        generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        windowDays: 7,
        platform,
        assets: {
          appsOnline: soft(ctx, "resourceCore")?.list("app").filter((item) => item.status === "online").length ?? 0,
          agentsOnline: soft(ctx, "resourceCore")?.list("agent").filter((item) => item.status === "online").length ?? 0,
          skillsPublished: soft(ctx, "skillHub")?.skills().all().filter((item) => item.status === "published").length ?? 0,
          mcpServing: soft(ctx, "mcpRegistry")?.services().all().filter((service) => service.status === "online" || service.status === "gray").length ?? 0
        },
        funnel: {
          exposed: behaviorCount("card.exposed"),
          clicked: behaviorCount("card.clicked"),
          invoked: usageCount,
          completed: completedCalls
        },
        waic: { count: usageCount, chargeCents },
        roiEstimate: {
          callBase,
          estimatedHoursSaved: Math.round(callBase * minutesPerCall / 60 * 100) / 100,
          note: "\u4F30\u7B97\u53E3\u5F84\uFF08\u975E\u5B9E\u6D4B\uFF09\uFF1A\u66FF\u4EE3\u5DE5\u65F6 = \u8C03\u7528\u6B21\u6570 \xD7 \u5355\u6B21\u66FF\u4EE3\u5206\u949F \xF7 60"
        },
        cards: cards.map((card) => ({ id: card.id, title: card.title, badge: card.badge }))
      };
    }
  });
  applyMfgModule(ctx, { guarded, changeLog, renderJson });
}
export {
  CARD_PLATFORMS2 as CARD_PLATFORMS,
  CardpackService2 as CardpackService,
  apply,
  filterCards2 as filterCards,
  inject,
  name
};
