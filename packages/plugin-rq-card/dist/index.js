import { defineTool } from "./tool.js";
import { CONSOLE_BASE } from "./wire.js";
import { HostLinkService, RQCARD_CALL_HEADER } from "./hostlink.js";
import { HostLinkService as HostLinkService2, RQCARD_CALL_HEADER as RQCARD_CALL_HEADER2 } from "./hostlink.js";
import { normalizeHubBase, proxyPathAllowed } from "./hostlink.js";
function summarizeForToolResult(input) {
  const lines = [];
  const flag = input.isError ? "\u26A0 " : "";
  lines.push(`**${input.toolName}** ${flag}${input.summary}`);
  for (const [key, value] of Object.entries(input.details ?? {})) {
    lines.push(`- ${key}\uFF1A${String(value)}`);
  }
  if (input.consoleHash !== void 0) {
    lines.push(`\u{1F449} [\u523001\u95E8\u63A7\u5236\u53F0\u5904\u7406](${CONSOLE_BASE}${input.consoleHash})`);
  }
  return lines.join("\n");
}
const name = "rq-card";
const inject = ["httpServer", "tools", "opsStorage"];
function apply(ctx, config = {}) {
  const http = ctx.httpServer;
  const link = new HostLinkService(ctx, { dataDir: config.dataDir, scanPorts: config.scanPorts });
  const wizardGuard = (exchange) => {
    const raw = exchange.headers[RQCARD_CALL_HEADER];
    const value = String(Array.isArray(raw) ? raw[0] : raw ?? "");
    if (value !== "1") {
      exchange.fail(403, "WIZARD_CALL_HEADER_REQUIRED", "\u5411\u5BFC\u7AEF\u70B9\u8981\u6C42 x-rqcard-call: 1 \u8BF7\u6C42\u5934\uFF08\u8DE8\u7AD9\u9632\u5FA1\uFF09");
      return false;
    }
    return true;
  };
  const json = (exchange) => exchange.body ?? {};
  const fail = (exchange, code, error) => {
    exchange.fail(400, code, error instanceof Error ? error.message : String(error));
  };
  http.register("GET", "/rqcard/link", async (exchange) => {
    if (!wizardGuard(exchange)) return;
    const cfg = link.getConfig();
    const probe = cfg.mode === "remote" && cfg.hubBase ? await link.probeHub(cfg.hubBase).catch(() => null) : null;
    exchange.ok({
      mode: cfg.mode,
      hubBase: cfg.hubBase ?? null,
      hubMountPrefix: cfg.hubMountPrefix ?? null,
      label: cfg.label ?? null,
      savedAt: cfg.savedAt ?? null,
      probe
    });
  });
  http.register("POST", "/rqcard/link/local", (exchange) => {
    if (!wizardGuard(exchange)) return;
    const input = json(exchange);
    exchange.ok({ config: link.setLocal(input.label) });
  });
  http.register("POST", "/rqcard/link/remote", async (exchange) => {
    if (!wizardGuard(exchange)) return;
    const input = json(exchange);
    try {
      exchange.ok(await link.setRemote(String(input.hubBase ?? ""), input.label, { timeoutMs: input.timeoutMs }));
    } catch (error) {
      fail(exchange, "LINK_REMOTE_FAILED", error);
    }
  });
  http.register("POST", "/rqcard/link/reset", (exchange) => {
    if (!wizardGuard(exchange)) return;
    exchange.ok({ config: link.reset() });
  });
  http.register("POST", "/rqcard/link/scan", async (exchange) => {
    if (!wizardGuard(exchange)) return;
    const input = json(exchange);
    try {
      exchange.ok(await link.scan(input.candidates));
    } catch (error) {
      fail(exchange, "LINK_SCAN_FAILED", error);
    }
  });
  http.use(async (exchange) => {
    if (!exchange.path.startsWith("/rqcard/proxy")) return;
    const sseProxy = exchange.method === "GET" && exchange.path === "/rqcard/proxy/api/panel/stream";
    if (!sseProxy && !wizardGuard(exchange)) return;
    await link.proxy(exchange);
  });
  ctx.tools.register(defineTool({
    name: "rq_host_status",
    description: "\u67E5\u770B01\u95E8\u5BBF\u4E3B\u8FDE\u63A5\u72B6\u6001\uFF1A\u672C\u673A\u5373\u5BBF\u4E3B\uFF08local\uFF09/ \u8FDE\u63A5\u8FDC\u7AEF\u5BBF\u4E3B\uFF08remote\uFF0C\u542B\u5730\u5740\u4E0E\u9762\u677F\u5165\u53E3\uFF09/ \u672A\u914D\u7F6E\uFF08none\uFF0C\u6253\u5F00\u9762\u677F\u4F1A\u8FDB\u5165\u8FDE\u63A5\u5411\u5BFC\uFF09\u3002",
    parameters: {},
    output: { type: "object", additionalProperties: true },
    async execute() {
      const cfg = link.getConfig();
      return {
        mode: cfg.mode,
        hubBase: cfg.hubBase ?? null,
        panelUrl: cfg.mode === "remote" && cfg.hubBase ? `${cfg.hubBase}${cfg.hubMountPrefix ?? ""}/panel/` : `${CONSOLE_BASE}/panel/`,
        ...cfg.mode === "none" ? { notice: "\u5C1A\u672A\u914D\u7F6E\u5BBF\u4E3B\u8FDE\u63A5\uFF1A\u6253\u5F00\u9762\u677F /panel/ \u4F1A\u8FDB\u5165\u8FDE\u63A5\u5411\u5BFC\uFF08\u4E5F\u53EF\u8BA9\u4F7F\u7528\u8005\u5728\u6D4F\u89C8\u5668\u5B8C\u6210\u914D\u7F6E\uFF09" } : {}
      };
    }
  }));
}
export {
  HostLinkService2 as HostLinkService,
  RQCARD_CALL_HEADER2 as RQCARD_CALL_HEADER,
  apply,
  inject,
  name,
  normalizeHubBase,
  proxyPathAllowed,
  summarizeForToolResult
};
