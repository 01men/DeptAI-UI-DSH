import { resolvePanelModelGateway } from "../llm-bridge.js";
import { execute } from "./engine.js";
import { tools as mfgTools, categories as mfgCategories, findTool, toolSearchText } from "./catalog.js";
import { loadRoadmap, roadmapGroups, ROADMAP_STATUS_LABELS } from "./roadmap.js";
import { toMarkdown, exportFileName } from "./export.js";
import { MfgError } from "./validate.js";
import { buildRelease, releaseReady, MemoryReleaseStore, skillHash } from "./quality.js";
import { skills as mfgSkills } from "./skills.js";
import { evaluateSkills, evaluationPlan, fixtures } from "./evaluate.js";
function createReleaseStore(ctx) {
  const soft = (key) => {
    try {
      return ctx.reflect.get(key, false);
    } catch {
      return void 0;
    }
  };
  const storage = soft("opsStorage");
  if (!storage || typeof storage.collection !== "function") return new MemoryReleaseStore();
  const collection = storage.collection("panel:mfgReleases");
  return {
    get(skillId) {
      const record = collection.findOne((item) => item.skillId === skillId);
      return record ? {
        skillId: record.skillId,
        skillHash: record.skillHash,
        modelHash: record.modelHash,
        reportHash: record.reportHash,
        approvedBy: record.approvedBy,
        reviewKind: record.reviewKind,
        approvedAt: record.approvedAt,
        expiresAt: record.expiresAt
      } : void 0;
    },
    put(release) {
      const existing = collection.findOne((item) => item.skillId === release.skillId);
      if (existing) collection.update(existing.id, { ...release });
      else collection.insert({ id: `mrel_${release.skillId}`, ...release });
    },
    remove(skillId) {
      const existing = collection.findOne((item) => item.skillId === skillId);
      if (existing) collection.remove(existing.id);
    },
    list() {
      return collection.all().map((record) => ({
        skillId: record.skillId,
        skillHash: record.skillHash,
        modelHash: record.modelHash,
        reportHash: record.reportHash,
        approvedBy: record.approvedBy,
        reviewKind: record.reviewKind,
        approvedAt: record.approvedAt,
        expiresAt: record.expiresAt
      }));
    }
  };
}
function createModelRuntime(ctx, releases) {
  const resolve = () => resolvePanelModelGateway(ctx)?.gateway;
  return {
    releases,
    identity() {
      const gateway = resolve();
      if (!gateway) return null;
      const models = gateway.models?.().all?.() ?? [];
      const online = models.find((model) => model.status === "online") ?? models[0];
      if (!online?.slug) return null;
      return { model: online.slug, endpoint: online.endpoint };
    },
    async invoke(input) {
      const gateway = resolve();
      if (!gateway) throw new MfgError("MODEL_NOT_CONFIGURED", "\u6A21\u578B\u7F51\u5173\u672A\u63A5\u5165\uFF0801\u95E8\u6F14\u793A\u6001\uFF09\u2014\u2014\u8FDE\u63A5\u5BBF\u4E3B\u5E76\u767B\u5F55\u540E\u5728\u5E73\u53F0\u4FA7\u914D\u7F6E\u6A21\u578B", 503);
      const models = gateway.models?.().all?.() ?? [];
      const online = models.find((model) => model.status === "online") ?? models[0];
      if (!online?.slug) throw new MfgError("MODEL_NOT_CONFIGURED", "\u5E73\u53F0\u6A21\u578B\u76EE\u5F55\u4E3A\u7A7A\u2014\u2014\u8BF7\u5728 dsh \u4FA7\u914D\u7F6E\u9ED8\u8BA4\u6A21\u578B\u6216\u767B\u8BB0\u6A21\u578B\u6E20\u9053", 503);
      const result = await gateway.invoke({
        model: online.slug,
        subject: "panel:mfg-toolkit",
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user }
        ],
        ...input.signal ? { signal: input.signal } : {}
      });
      return { content: String(result.content ?? ""), model: String(result.model ?? online.slug) };
    }
  };
}
function applyMfgModule(ctx, deps) {
  const { guarded, changeLog, renderJson } = deps;
  const releases = createReleaseStore(ctx);
  const runtime = createModelRuntime(ctx, releases);
  guarded("GET", "/api/panel/mfg/catalog", "panel.read", () => {
    const identity = runtime.identity();
    const skills = Object.keys(mfgSkills).map((skillId) => {
      const tool = mfgTools.find((item) => item.skill === skillId);
      const verdict = identity ? releaseReady(releases, skillId, identity) : { ready: false, reason: "\u5E73\u53F0\u672A\u914D\u7F6E\u53EF\u7528\u6A21\u578B" };
      return {
        skillId,
        skillVersion: mfgSkills[skillId].version,
        toolId: tool?.id ?? "",
        released: verdict.ready,
        reason: verdict.ready ? "" : verdict.reason,
        skillHash: skillHash(skillId)
      };
    });
    return {
      tools: mfgTools.map((tool) => ({ ...tool, released: tool.mode === "calculation" ? true : Boolean(skills.find((item) => item.skillId === tool.skill)?.released) })),
      categories: [...mfgCategories],
      skills,
      modelReady: Boolean(identity),
      model: identity?.model ?? "",
      targetCount: 100,
      status: "100 \u4E2A\u5DE5\u5177\u5DF2\u9009\u578B\uFF0C13 \u4E2A\u8BA1\u7B97\u5185\u6838\u5DF2\u5B9E\u73B0\uFF0C3 \u4E2A AI \u5DE5\u5177\u6309\u6A21\u578B\u72EC\u7ACB\u9A8C\u6536\uFF0C84 \u4E2A\u89C4\u5212\u4E2D"
    };
  });
  guarded("GET", "/api/panel/mfg/roadmap", "panel.read", () => {
    const roadmap = loadRoadmap();
    return {
      version: roadmap.version,
      sourceWorkbook: roadmap.sourceWorkbook,
      sourceRows: roadmap.sourceRows,
      sourceStatusCounts: roadmap.sourceStatusCounts,
      pdfSource: roadmap.pdfSource,
      pdfPages: roadmap.pdfPages,
      groups: roadmapGroups(roadmap),
      statusLabels: ROADMAP_STATUS_LABELS,
      tools: roadmap.tools
    };
  });
  guarded("POST", "/api/panel/mfg/tools/:id/run", "panel.write", async (exchange) => {
    const id = String(exchange.params.id ?? "");
    try {
      const result = await execute(id, exchange.body ?? {});
      changeLog(exchange, "mfg.tool.run", "mfg-tool", id, findTool(id)?.title ?? id, `blocks=${result.blocks.length} mode=${result.mode}`);
      return result;
    } catch (error) {
      if (error instanceof MfgError) exchange.fail(error.status, error.code, error.message);
      else exchange.fail(500, "INTERNAL_ERROR", error instanceof Error ? error.message : "\u6267\u884C\u5931\u8D25");
      return null;
    }
  });
  guarded("GET", "/api/panel/mfg/tools/:id/template", "panel.read", (exchange) => {
    const tool = findTool(String(exchange.params.id ?? ""));
    if (!tool) return { fields: [] };
    return { toolId: tool.id, fields: tool.fields.map((field) => ({ key: field.key, label: field.label, default: field.default, unit: field.unit ?? "" })) };
  });
  guarded("POST", "/api/panel/mfg/tools/:id/export", "panel.read", (exchange) => {
    const body = exchange.body ?? {};
    const result = body.result;
    if (!result || typeof result !== "object" || !Array.isArray(result.blocks)) {
      exchange.fail(400, "BAD_REQUEST", "\u7F3A\u5C11\u53EF\u5BFC\u51FA\u7684\u8FD0\u884C\u7ED3\u679C");
      return null;
    }
    const format = body.format === "md" ? "md" : "json";
    return format === "md" ? { filename: exportFileName(result, "md"), content: toMarkdown(result), mime: "text/markdown" } : { filename: exportFileName(result, "json"), content: JSON.stringify(result, null, 2), mime: "application/json" };
  });
  guarded("GET", "/api/panel/mfg/releases", "panel.read", () => {
    const identity = runtime.identity();
    return {
      identity: identity ?? null,
      releases: releases.list().map((release) => ({
        ...release,
        valid: identity ? releaseReady(releases, release.skillId, identity).ready : false
      }))
    };
  });
  guarded("GET", "/api/panel/mfg/evaluation-plan", "panel.read", () => ({
    plan: evaluationPlan(3),
    fixtures: Object.fromEntries(Object.entries(fixtures).map(([skillId, suite]) => [skillId, suite.map((item) => ({ id: item.id, context: item.context }))])),
    note: "\u8BC4\u4F30\u8BA1\u5212\u4E0D\u53D1\u8D77\u6A21\u578B\u8C03\u7528\u3002\u771F\u5B9E\u8BC4\u4F30\u7ECF POST /api/panel/mfg/evaluate \u6267\u884C\u5E76\u4EA7\u751F live \u62A5\u544A\uFF1B\u62A5\u544A\u987B\u7ECF\u4EBA\u5DE5\u5BA1\u9605\u540E\u53E6\u884C\u7B7E\u7F72\u653E\u884C\u3002"
  }));
  guarded("POST", "/api/panel/mfg/evaluate", "panel.config.write", async (exchange) => {
    const body = exchange.body ?? {};
    if (!runtime.identity()) {
      exchange.fail(503, "MODEL_NOT_CONFIGURED", "\u5E73\u53F0\u672A\u914D\u7F6E\u53EF\u7528\u6A21\u578B\uFF0C\u65E0\u6CD5\u6267\u884C\u771F\u5B9E\u8BC4\u4F30\uFF08mock \u7ED3\u679C\u4E0D\u6784\u6210\u9A8C\u6536\uFF09");
      return null;
    }
    const reports = await evaluateSkills({
      runtime,
      ...Array.isArray(body.skills) && body.skills.length ? { skillIds: body.skills } : {},
      repetitions: Number.isInteger(body.repetitions) ? Math.min(5, Math.max(1, body.repetitions)) : 3
    });
    const storage = (() => {
      try {
        return ctx.reflect.get("opsStorage", false);
      } catch {
        return void 0;
      }
    })();
    if (storage?.collection) {
      const collection = storage.collection("panel:mfgReports");
      for (const report of reports) {
        collection.insert({ id: `mrp_${report.skillId}_${Date.now()}`, report, reportText: JSON.stringify(report, null, 2) });
      }
    }
    changeLog(exchange, "mfg.evaluate", "mfg-skill", reports.map((item) => item.skillId).join(","), "\u5236\u9020\u5DE5\u5177\u7BB1 Skill \u8BC4\u4F30", `reports=${reports.length}`);
    return {
      reports: reports.map((report) => ({ skillId: report.skillId, status: report.status, live: report.live, model: report.model, repetitions: report.repetitions, cases: report.cases })),
      note: "\u8BC4\u4F30\u62A5\u544A\u4E0D\u6784\u6210\u653E\u884C\u3002\u8BF7\u4EBA\u5DE5\u5BA1\u9605\u901A\u8FC7\u540E\uFF0C\u7ECF POST /api/panel/mfg/releases \u7531\u5BA1\u6838\u4EBA\u7B7E\u7F72\u653E\u884C\u3002"
    };
  });
  guarded("POST", "/api/panel/mfg/releases", "panel.config.write", (exchange) => {
    const body = exchange.body ?? {};
    const report = body.report;
    if (!report || typeof report !== "object") {
      exchange.fail(400, "BAD_REQUEST", "\u7F3A\u5C11\u8BC4\u4F30\u62A5\u544A");
      return null;
    }
    const reviewKind = body.reviewKind === "domain" ? "domain" : "technical";
    try {
      const release = buildRelease(report, JSON.stringify(report, null, 2), String(body.reviewer ?? ""), reviewKind);
      releases.put(release);
      changeLog(exchange, "mfg.release", "mfg-skill", release.skillId, `\u653E\u884C ${release.skillId}`, `reviewer=${release.approvedBy} kind=${reviewKind} expires=${release.expiresAt}`);
      return { release };
    } catch (error) {
      if (error instanceof MfgError) exchange.fail(error.status, error.code, error.message);
      else exchange.fail(400, "BAD_REQUEST", error instanceof Error ? error.message : "\u653E\u884C\u5931\u8D25");
      return null;
    }
  });
  guarded("DELETE", "/api/panel/mfg/releases/:skillId", "panel.config.write", (exchange) => {
    const skillId = String(exchange.params.skillId ?? "");
    releases.remove(skillId);
    changeLog(exchange, "mfg.release.revoke", "mfg-skill", skillId, `\u64A4\u56DE\u653E\u884C ${skillId}`);
    return { revoked: skillId };
  });
  ctx.tools.register({
    name: "panel_mfg_tools_list",
    description: "\u5217\u51FA\u5236\u9020\u5DE5\u5177\u7BB1\u7684\u5168\u90E8\u5DE5\u5177\uFF0813 \u4E2A\u8BA1\u7B97\u5185\u6838 + 3 \u4E2A AI \u5DE5\u5177\uFF0C\u5171 100 \u9879\u9009\u9898\uFF09\uFF0C\u542B\u5206\u7C7B\u3001\u6267\u884C\u65B9\u5F0F\u4E0E\u653E\u884C\u72B6\u6001",
    permission: "panel.read",
    parameters: { type: "object", properties: { query: { type: "string", description: "\u53EF\u9009\u68C0\u7D22\u8BCD\uFF08\u6807\u9898/\u526F\u6807\u9898/\u6807\u7B7E/\u5206\u7C7B\uFF09" } } },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args) {
      const query = String(args.query ?? "").trim().toLowerCase();
      const identity = runtime.identity();
      const found = query ? mfgTools.filter((tool) => toolSearchText(tool).includes(query)) : mfgTools;
      return found.map((tool) => {
        const skillId = tool.skill;
        const released = tool.mode === "calculation" ? true : Boolean(skillId && identity && releaseReady(releases, skillId, identity).ready);
        return { id: tool.id, title: tool.title, category: tool.category, mode: tool.mode, tags: tool.tags, released };
      });
    }
  });
  ctx.tools.register({
    name: "panel_mfg_tool_run",
    description: "\u6267\u884C\u4E00\u4E2A\u5236\u9020\u5DE5\u5177\uFF0813 \u4E2A\u786E\u5B9A\u6027\u8BA1\u7B97\u5185\u6838\uFF1BAI \u5DE5\u5177\u9700\u5E73\u53F0\u914D\u7F6E\u6A21\u578B\u4E14\u8BE5 Skill \u5DF2\u653E\u884C\uFF09\u3002\u8FD4\u56DE\u7EDF\u4E00\u7ED3\u6784\u5316\u7ED3\u679C\uFF08metrics/bars/table/text/scene\uFF09\u3002",
    permission: "panel.write",
    parameters: {
      type: "object",
      properties: {
        tool_id: { type: "string", description: "\u5DE5\u5177 id\uFF08\u5982 oee / cpk / pareto / bom-diff / quote-compare\uFF09" },
        input: { type: "object", description: "\u5DE5\u5177\u8F93\u5165\uFF08\u5B57\u6BB5\u89C1 panel_mfg_tools_list \u5BF9\u5E94\u7684\u5B9A\u4E49\uFF1B\u672A\u77E5\u5B57\u6BB5\u4F1A\u88AB\u62D2\u7EDD\uFF09" }
      },
      required: ["tool_id"]
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args) {
      const input = args;
      return execute(String(input.tool_id), input.input ?? {});
    }
  });
  ctx.tools.register({
    name: "panel_mfg_roadmap",
    description: "\u67E5\u8BE2 100 \u9879\u5236\u9020 AI \u5DE5\u5177\u9009\u9898\u6E05\u5355\uFF08\u6765\u6E90\u8FFD\u6EAF\uFF1APMO \u573A\u666F\u6E05\u5355\u884C\u53F7 + \u884C\u4E1A PDF \u9875\u7801\uFF1B\u72B6\u6001\uFF1A13 \u5DF2\u5B9E\u73B0\u8BA1\u7B97\u5185\u6838 / 3 \u5F85\u6A21\u578B\u9A8C\u6536 / 84 \u89C4\u5212\uFF09",
    permission: "panel.read",
    parameters: {
      type: "object",
      properties: {
        group: { type: "string", description: "\u53EF\u9009\u4E1A\u52A1\u573A\u666F\u5206\u7EC4\uFF08\u5982 \u751F\u4EA7\u5236\u9020 / \u8D28\u91CF\u5DE5\u7A0B\uFF09" },
        status: { type: "string", description: "\u53EF\u9009\u72B6\u6001\u7B5B\u9009\uFF08implemented-calculation / model-validation-pending / planned\uFF09" }
      }
    },
    output: { schema: { type: "object" }, render: renderJson },
    async execute(args) {
      const input = args;
      const roadmap = loadRoadmap();
      let items = roadmap.tools;
      if (input.group) items = items.filter((item) => item.group === input.group);
      if (input.status) items = items.filter((item) => item.status === input.status);
      return {
        total: roadmap.tools.length,
        matched: items.length,
        groups: roadmapGroups(roadmap),
        statusLabels: ROADMAP_STATUS_LABELS,
        items: items.map((item) => ({
          id: item.id,
          title: item.title,
          group: item.group,
          priority: item.priority,
          status: item.status,
          statusLabel: ROADMAP_STATUS_LABELS[item.status] ?? item.status,
          implementation: item.implementation ?? "",
          acceptance: item.acceptance,
          sources: item.sources.map((source) => ({ row: source.row, department: source.department, scenario: source.originalScenario }))
        }))
      };
    }
  });
}
export {
  applyMfgModule
};
