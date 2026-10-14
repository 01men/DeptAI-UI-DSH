/* rq-card-build-id: 86e8632fc2615825 */
var module = { exports: {} }; var exports = module.exports;
window.__ModuleLoader__.load({ id: "@dsh-ops/plugin-rq-card", factory: (require) => {
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  deriveExecutionState: () => deriveExecutionState,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react3 = require("react");

// src/client/state.ts
function blocked(reason) {
  return { state: "blocked", reason };
}
function deriveExecutionState(input) {
  if (input.authzDenied === true) return blocked("nas-authz-deny");
  if (input.quotaExceeded === true) return blocked("quota-exhausted");
  if (input.pdpUnreachable === true) return blocked("pdp-unreachable");
  if (input.breakerOpen === true) return blocked("breaker-open");
  if (input.healthStatus === "down") return blocked("down");
  if (input.bindingInvalid === true) return blocked("binding-invalid");
  if (input.hasResult) {
    return input.resultIsError ? blocked("invoke-error") : { state: "done" };
  }
  if (input.invokePhase === "calling") return { state: "calling" };
  if (input.healthStatus === "healthy") return { state: "executing" };
  if (input.healthStatus === "degraded") return { state: "executing", degraded: true };
  return { state: "idle" };
}

// src/wire.ts
var CONSOLE_BASE = "/rq";
var FEEDBACK_ENDPOINT = `${CONSOLE_BASE}/api/usage/feedback`;
var SLOT_TOOLVIEW = "tool.call.toolview";
var SLOT_ASSISTANT_ACTIONS = "conversation.chat.assistant-actions";
var SLOT_OVERLAY = "shell.overlay";
var SLOT_SETTINGS = "settings.section";
var SLOT_VIEW = "conversation.view";
var LINK_ENDPOINT = `${CONSOLE_BASE}/rqcard/link`;
var PANEL_URL = `${CONSOLE_BASE}/panel/`;
var PANEL_EMBED_URL = `${PANEL_URL}?embed=1`;
var RQCARD_CALL_HEADER = "x-rqcard-call";
var FEEDBACK_ENTRY_ID = "rq-feedback";
var TOOLVIEW_ENTRY_PREFIX = "rq-tool-";
var DEGRADED_BADGE_ID = "rq-card-degraded";
var UNLINKED_BADGE_ID = "rq-card-unlinked";

// src/client/controller.ts
var INITIAL_VIEW = Object.freeze({
  items: /* @__PURE__ */ new Map()
});
async function postFeedback(body) {
  try {
    const response = await fetch(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin"
    });
    if (!response.ok) {
      return {
        ok: false,
        error: { code: "http", message: `feedback endpoint HTTP ${response.status}` }
      };
    }
    await response.json().catch(() => void 0);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "transport",
        message: error instanceof Error ? error.message : "feedback request failed"
      }
    };
  }
}
var RqFeedbackController = class {
  view = INITIAL_VIEW;
  listeners = /* @__PURE__ */ new Set();
  /** 返回缓存的不可变视图（HostObservable 契约）。 */
  getSnapshot = () => this.view;
  /** 订阅视图替换（HostObservable 契约）。 */
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /**
   * 提交评分：先写本地乐观态（选中即亮），再 fire-and-forget 上报。
   * 同分重复点击为 no-op（幂等，避免无意义重发）。
   * @param messageId 定稿 assistant 消息 id。
   * @param score 👍/👎。
   * @param note 可选说明（UI 暂不收集，契约预留）。
   */
  rate(messageId, score, note) {
    const current = this.view.items.get(messageId);
    if (current?.score === score) return Promise.resolve();
    this.commit(messageId, score);
    return postFeedback({ messageId, score, ...note === void 0 ? {} : { note } }).then((result) => {
      if (!result.ok) {
        console.debug("[rq-card] feedback not recorded:", result.error.message);
      }
    });
  }
  /** 替换视图并通知订阅者（订阅者异常就地吞掉，不拖垮通知循环）。 */
  commit(messageId, score) {
    const items = new Map(this.view.items);
    items.set(messageId, { score });
    this.view = Object.freeze({ items });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[rq-card] feedback subscriber threw:", error);
      }
    }
  }
};

// src/client/ExecutionCard.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var ROUTE_FOR_TOOL_PREFIX = Object.freeze({
  mcp: "#/mcp",
  nas: "#/nas",
  skill: "#/skills",
  app: "#/apps",
  agent: "#/agents",
  iam: "#/iam",
  authn: "#/authn",
  audit: "#/audit",
  connector: "#/connectors",
  billing: "#/platform",
  market: "#/assets",
  model: "#/platform",
  approval: "#/approvals"
});
var ROUTE_FOR_REASON = Object.freeze({
  "nas-authz-deny": "#/nas-authz",
  "quota-exhausted": "#/approvals",
  "pdp-unreachable": "#/dashboard",
  "breaker-open": "#/mcp",
  down: "#/mcp",
  "binding-invalid": "#/connect",
  "invoke-error": "#/dashboard"
});
function routeForTool(toolName) {
  const prefix = toolName.split("_", 1)[0] ?? "";
  return `${CONSOLE_BASE}${ROUTE_FOR_TOOL_PREFIX[prefix] ?? "#/dashboard"}`;
}
var RESULT_TEXT_LIMIT = 600;
function resultText(block) {
  const content = block.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const piece of content) {
    if (typeof piece === "object" && piece !== null && "text" in piece && typeof piece.text === "string") {
      parts.push(piece.text);
    }
  }
  const text = parts.join("\n").trim();
  return text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}\u2026` : text;
}
function CardBody({ state, block, toolName, t }) {
  const text = t;
  switch (state.state) {
    case "calling":
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rq-ecard-skel", "aria-busy": "true", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-skel-line" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-skel-line" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-skel-line" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-foot", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "rq-ecard-cancel", disabled: true, title: text("card.cancel.hint"), children: text("card.cancel.button") }) })
      ] });
    case "executing":
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { "aria-busy": "true", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-pulse" }),
        state.degraded === true && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rq-ecard-degraded", children: [
          "\u23F3 ",
          text("card.degraded.hint")
        ] })
      ] });
    case "done": {
      const settled = block;
      const summary = resultText(settled);
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        summary !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-result", children: summary }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-foot", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", { className: "rq-ecard-link", href: routeForTool(toolName), target: "_blank", rel: "noreferrer", children: [
          text("card.console.link"),
          " \u2197"
        ] }) })
      ] });
    }
    case "blocked": {
      const reason = state.reason ?? "invoke-error";
      const settled = block;
      const summary = "kind" in block ? resultText(settled) : "";
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-reason", children: text(`card.blocked.${reason}`) }),
        summary !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-result", children: summary }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-foot", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { className: "rq-ecard-action", href: `${CONSOLE_BASE}${ROUTE_FOR_REASON[reason] ?? "#/dashboard"}`, children: text(`card.action.${reason}`) }) })
      ] });
    }
    default:
      return null;
  }
}
function ExecutionCard(props) {
  const { toolName, block, deriveState, healthSnapshot, t } = props;
  const hasResult = typeof block === "object" && block !== null && "kind" in block;
  const resultIsError = hasResult === true && typeof block.isError === "boolean" && block.isError;
  const invokePhase = hasResult ? "idle" : "calling";
  const extra = healthSnapshot?.() ?? {};
  const state = deriveState({
    hasResult,
    resultIsError,
    invokePhase,
    ...extra
  });
  const argsRaw = typeof block === "object" && block !== null && "argsRaw" in block ? String(block.argsRaw ?? "") : "";
  const text = t;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rq-ecard", "data-state": state.state, "data-tool": toolName, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "rq-ecard-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: toolName }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "rq-ecard-chip", children: text(`card.state.${state.state}`) })
    ] }),
    argsRaw !== "" && (state.state === "calling" || state.state === "executing") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "rq-ecard-args", children: argsRaw }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardBody, { state, block, toolName, t })
  ] });
}

// src/client/RqFeedback.tsx
var import_react = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
var DONE_HINT_MS = 1800;
function RqFeedback(props) {
  const { messageId, rate, t } = props;
  const maybeHook = props.useRqfb;
  const useRqfb = typeof maybeHook === "function" ? maybeHook : null;
  const text = t;
  const item = useRqfb?.((view) => view.items.get(messageId));
  const [doneHint, setDoneHint] = (0, import_react.useState)(false);
  const alive = (0, import_react.useRef)(true);
  (0, import_react.useEffect)(() => () => {
    alive.current = false;
  }, []);
  const onRate = (0, import_react.useCallback)((score) => {
    if (item?.score === score) return;
    void rate(messageId, score).then(() => {
      if (alive.current) {
        setDoneHint(true);
        setTimeout(() => {
          if (alive.current) setDoneHint(false);
        }, DONE_HINT_MS);
      }
    });
  }, [item?.score, messageId, rate]);
  const likeLabel = text("fb.like");
  const dislikeLabel = text("fb.dislike");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "rq-fb", "data-rq-feedback": "", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "rq-fb-btn",
        "aria-label": likeLabel,
        title: likeLabel,
        "aria-pressed": item?.score === "up" || void 0,
        "data-active": item?.score === "up" || void 0,
        onClick: () => {
          onRate("up");
        },
        children: "\u{1F44D}"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "rq-fb-btn",
        "aria-label": dislikeLabel,
        title: dislikeLabel,
        "aria-pressed": item?.score === "down" || void 0,
        "data-active": item?.score === "down" || void 0,
        onClick: () => {
          onRate("down");
        },
        children: "\u{1F44E}"
      }
    ),
    doneHint && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "rq-fb-done", role: "status", children: text("fb.done") })
  ] });
}

// src/client/RqSettings.tsx
var import_react2 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
function RqSettings({ open, refresh, t }) {
  const [link, setLink] = (0, import_react2.useState)(void 0);
  const reload = (0, import_react2.useCallback)(async () => {
    setLink(await refresh());
  }, [refresh]);
  (0, import_react2.useEffect)(() => {
    void reload();
  }, [reload]);
  const mode = link?.mode;
  const modeText = mode === "remote" ? t("settings.mode.remote") : mode === "local" ? t("settings.mode.local") : mode === "none" ? t("settings.mode.none") : "\u2026";
  const probeText = link?.mode === "remote" ? link.probe?.reachable === true ? t("settings.probe.ok") : t("settings.probe.fail") : null;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rq-set", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "rq-set-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: `rq-set-mode rq-set-mode-${mode ?? "unknown"}`, children: modeText }),
      link?.mode === "remote" && link.hubBase ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "rq-set-hub", children: [
        String(link.hubBase),
        probeText ? ` \xB7 ${probeText}` : ""
      ] }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "rq-set-btn", onClick: () => void reload(), children: t("settings.refresh") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "rq-set-hint", children: t("settings.hint") }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "rq-set-row", children: mode === "none" ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "rq-set-btn rq-set-primary", onClick: () => open(PANEL_URL), children: t("settings.open.wizard") }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "rq-set-btn rq-set-primary", onClick: () => open(PANEL_URL), children: t("settings.open.panel") }) })
  ] });
}

// src/client/RqWorkbench.tsx
var import_jsx_runtime4 = require("react/jsx-runtime");
function RqWorkbench({ t }) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rq-wb", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "rq-wb-bar", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "rq-wb-title", children: [
        "\u{1F333} ",
        t("view.workbench")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("a", { className: "rq-wb-link", href: PANEL_EMBED_URL.replace("?embed=1", ""), target: "_blank", rel: "noreferrer", children: [
        t("view.open.external"),
        " \u2197"
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "iframe",
      {
        className: "rq-wb-frame",
        src: PANEL_EMBED_URL,
        title: t("view.workbench"),
        referrerPolicy: "same-origin"
      }
    )
  ] });
}

// src/client/hostStatus.ts
async function fetchHostLink() {
  try {
    const response = await fetch(LINK_ENDPOINT, { headers: { [RQCARD_CALL_HEADER]: "1" } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) return null;
    return payload?.data ?? null;
  } catch {
    return null;
  }
}

// src/client/locales.ts
var zh = {
  // ── 执行卡：状态徽标 ──
  "card.state.calling": "\u8C03\u7528\u4E2D",
  "card.state.executing": "\u6267\u884C\u4E2D",
  "card.state.done": "\u5DF2\u5B8C\u6210",
  "card.state.blocked": "\u5DF2\u53D7\u963B",
  "card.state.idle": "\u7B49\u5F85\u4E2D",
  // ── 执行卡：通用 ──
  "card.args.summary": "\u8C03\u7528\u53C2\u6570",
  "card.result.title": "\u6267\u884C\u7ED3\u679C",
  "card.result.truncated": "\uFF08\u5185\u5BB9\u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD\uFF09",
  "card.console.link": "\u5230\u63A7\u5236\u53F0\u67E5\u770B",
  // ── 执行卡：调用中（骨架 + 可取消占位）──
  "card.cancel.button": "\u53D6\u6D88",
  "card.cancel.hint": "\u53D6\u6D88\u901A\u9053\u5F85\u5BBF\u4E3B\u534A\u63A5\u7EBF\u540E\u542F\u7528",
  // ── 执行卡：执行中（进度脉冲）──
  "card.degraded.hint": "\u6709\u70B9\u6162\uFF0C\u5DF2\u8F6C\u540E\u53F0\u5904\u7406",
  // ── 执行卡：异常阻断（业务文案，原因码 = C3 js/errors.js 的键）──
  "card.blocked.nas-authz-deny": "\u6CA1\u6709\u8BBF\u95EE\u6743\u9650\uFF0C\u8BF7\u5148\u7533\u8BF7\u6388\u6743",
  "card.blocked.quota-exhausted": "\u94B1\u5305\u989D\u5EA6\u5DF2\u8017\u5C3D\uFF0C\u8BF7\u7533\u8BF7\u8FFD\u52A0",
  "card.blocked.pdp-unreachable": "\u7B56\u7565\u51B3\u7B56\u70B9\u6682\u4E0D\u53EF\u8FBE\uFF0C\u5DF2\u4FDD\u62A4\u6027\u6682\u505C",
  "card.blocked.breaker-open": "\u7194\u65AD\u4FDD\u62A4\u751F\u6548\u4E2D\uFF0C\u5F85\u670D\u52A1\u6062\u590D\u540E\u91CD\u8BD5",
  "card.blocked.down": "\u670D\u52A1\u6682\u4E0D\u53EF\u7528\uFF0C\u6062\u590D\u540E\u5373\u53EF\u91CD\u8BD5",
  "card.blocked.binding-invalid": "\u8EAB\u4EFD\u7ED1\u5B9A\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u7ED1\u5B9A",
  "card.blocked.invoke-error": "\u6267\u884C\u51FA\u9519\uFF0C\u8BE6\u89C1\u7ED3\u679C\u4FE1\u606F",
  // ── 执行卡：阻断行动按钮（跳 /rq 控制台对应页，同源带登录态）──
  "card.action.nas-authz-deny": "\u7533\u8BF7\u8BBF\u95EE",
  "card.action.quota-exhausted": "\u7533\u8BF7\u989D\u5EA6",
  "card.action.pdp-unreachable": "\u67E5\u770B\u5E73\u53F0\u72B6\u6001",
  "card.action.breaker-open": "\u67E5\u770B\u670D\u52A1\u72B6\u6001",
  "card.action.down": "\u67E5\u770B\u670D\u52A1\u72B6\u6001",
  "card.action.binding-invalid": "\u91CD\u65B0\u7ED1\u5B9A",
  "card.action.invoke-error": "\u67E5\u770B\u5E73\u53F0\u72B6\u6001",
  // ── 反馈条 ──
  "fb.like": "\u6709\u5E2E\u52A9",
  "fb.dislike": "\u6CA1\u5E2E\u52A9",
  "fb.done": "\u5DF2\u8BB0\u5F55\uFF0C\u611F\u8C22\u53CD\u9988",
  // ── 设置分区「元冰可宿主」（M2）──
  "settings.nav": "\u6995\u5668\u5BBF\u4E3B",
  "settings.mode.local": "\u672C\u673A\u5373\u5BBF\u4E3B",
  "settings.mode.remote": "\u5DF2\u8FDE\u63A5\u8FDC\u7AEF\u5BBF\u4E3B",
  "settings.mode.none": "\u672A\u8FDE\u63A5\u5BBF\u4E3B",
  "settings.probe.ok": "\u53EF\u8FBE",
  "settings.probe.fail": "\u4E0D\u53EF\u8FBE",
  "settings.refresh": "\u5237\u65B0\u72B6\u6001",
  "settings.open.wizard": "\u6253\u5F00\u8FDE\u63A5\u5411\u5BFC",
  "settings.open.panel": "\u6253\u5F00\u6995\u5668\u5DE5\u4F5C\u53F0",
  "settings.hint": "\u8FDE\u63A5\u5BBF\u4E3B\uFF08\u9009\u62E9 IP\uFF09\u5E76\u5728\u9762\u677F\u5B8C\u6210\u9489\u9489/\u8D26\u53F7\u767B\u5F55\uFF1B\u9762\u677F\u5730\u5740 /rq/panel/\u3002",
  // ── 会话视图 Tab「元冰可工作台」（M3）──
  "view.workbench": "\u6995\u5668\u5DE5\u4F5C\u53F0",
  "view.open.external": "\u5728\u6D4F\u89C8\u5668\u6253\u5F00",
  // ── 未连接角标（M3，shell.overlay）──
  "overlay.unlinked": "\u6995\u5668\uFF1A\u672A\u8FDE\u63A5\u5BBF\u4E3B\uFF0C\u70B9\u51FB\u6253\u5F00\u5411\u5BFC"
};
var en = {
  "card.state.calling": "Calling",
  "card.state.executing": "Running",
  "card.state.done": "Done",
  "card.state.blocked": "Blocked",
  "card.state.idle": "Waiting",
  "card.args.summary": "Arguments",
  "card.result.title": "Result",
  "card.result.truncated": "(truncated)",
  "card.console.link": "Open in console",
  "card.cancel.button": "Cancel",
  "card.cancel.hint": "Cancellation becomes available once the host channel is wired",
  "card.degraded.hint": "Slow \u2014 moved to background",
  "card.blocked.nas-authz-deny": "No access permission \u2014 request authorization first",
  "card.blocked.quota-exhausted": "Wallet quota exhausted \u2014 request a top-up",
  "card.blocked.pdp-unreachable": "Policy decision point unreachable \u2014 paused protectively",
  "card.blocked.breaker-open": "Circuit breaker is open \u2014 retry after recovery",
  "card.blocked.down": "Service is down \u2014 retry once it recovers",
  "card.blocked.binding-invalid": "Identity binding expired \u2014 please re-bind",
  "card.blocked.invoke-error": "Execution failed \u2014 see result details",
  "card.action.nas-authz-deny": "Request access",
  "card.action.quota-exhausted": "Request quota",
  "card.action.pdp-unreachable": "Platform status",
  "card.action.breaker-open": "Service status",
  "card.action.down": "Service status",
  "card.action.binding-invalid": "Re-bind",
  "card.action.invoke-error": "Platform status",
  "fb.like": "Helpful",
  "fb.dislike": "Not helpful",
  "fb.done": "Recorded \u2014 thanks for the feedback",
  "settings.nav": "Yuanbingke host",
  "settings.mode.local": "This machine is the host",
  "settings.mode.remote": "Connected to remote host",
  "settings.mode.none": "Host not linked",
  "settings.probe.ok": "reachable",
  "settings.probe.fail": "unreachable",
  "settings.refresh": "Refresh",
  "settings.open.wizard": "Open connect wizard",
  "settings.open.panel": "Open Yuanbingke workbench",
  "settings.hint": "Link a host (pick an IP) and sign in with DingTalk/account on the panel; panel lives at /rq/panel/.",
  "view.workbench": "Yuanbingke workbench",
  "view.open.external": "Open in browser",
  "overlay.unlinked": "Yuanbingke: host not linked \u2014 click to open the wizard"
};

// src/client/styles.ts
var PLUGIN_ID = "@dsh-ops/plugin-rq-card";
var SHEET = `
.rq-ecard{border:1px solid var(--rq-ecard-edge,#e2e6ee);border-radius:10px;padding:8px 12px;
  margin:4px 0;font-size:13px;line-height:1.5;background:var(--rq-ecard-bg,#fff);max-width:640px}
.rq-ecard-head{display:flex;align-items:center;gap:8px;font-weight:600}
.rq-ecard-chip{font-weight:400;font-size:11px;padding:1px 8px;border-radius:999px;
  background:#eef1f6;color:#5b6472}
.rq-ecard[data-state="calling"] .rq-ecard-chip{background:#e8f1fd;color:#2563c4}
.rq-ecard[data-state="executing"] .rq-ecard-chip{background:#e6f5ee;color:#177a4c}
.rq-ecard[data-state="done"] .rq-ecard-chip{background:#e6f5ee;color:#177a4c}
.rq-ecard[data-state="blocked"]{border-color:#e5484d;box-shadow:inset 3px 0 0 #e5484d}
.rq-ecard[data-state="blocked"] .rq-ecard-chip{background:#fdebec;color:#c62a2f}
.rq-ecard-skel{margin-top:8px}
.rq-ecard-skel-line{height:10px;border-radius:5px;background:#eef1f6;margin:6px 0;
  animation:rq-pulse 1.4s ease-in-out infinite}
.rq-ecard-skel-line:nth-child(2){width:70%}
.rq-ecard-skel-line:nth-child(3){width:45%}
.rq-ecard-pulse{margin-top:8px;height:6px;border-radius:3px;overflow:hidden;background:#eef1f6}
.rq-ecard-pulse::before{content:"";display:block;height:100%;width:38%;border-radius:3px;
  background:#2563c4;opacity:.55;animation:rq-sweep 1.6s ease-in-out infinite}
.rq-ecard-degraded{margin-top:6px;font-size:12px;color:#9a6700}
.rq-ecard-args{margin-top:8px;color:#5b6472;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:72px;overflow:hidden}
.rq-ecard-result{margin-top:8px;white-space:pre-wrap;word-break:break-word;color:#252b35}
.rq-ecard-foot{margin-top:8px;display:flex;align-items:center;gap:10px}
.rq-ecard-link{color:#2563c4;text-decoration:none;font-size:12px}
.rq-ecard-link:hover{text-decoration:underline}
.rq-ecard-action{display:inline-block;padding:3px 12px;border-radius:6px;border:1px solid #e5484d;
  color:#c62a2f;background:#fff;font-size:12px;text-decoration:none;cursor:pointer}
.rq-ecard-action:hover{background:#fdebec}
.rq-ecard-cancel{margin-left:auto;padding:2px 10px;border-radius:6px;border:1px solid #c9cfda;
  background:#fff;color:#5b6472;font-size:12px;cursor:not-allowed}
.rq-ecard-reason{margin-top:6px;color:#c62a2f}
@keyframes rq-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes rq-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}

.rq-fb{display:inline-flex;align-items:center;gap:4px;margin-left:8px}
.rq-fb-btn{border:none;background:transparent;cursor:pointer;font-size:13px;line-height:1;
  padding:3px 6px;border-radius:6px;opacity:.55}
.rq-fb-btn:hover{background:#eef1f6;opacity:1}
.rq-fb-btn[data-active="true"]{opacity:1;background:#e8f1fd}
.rq-fb-done{font-size:11px;color:#8a92a0}

.rq-badge{position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:4px 10px;border-radius:999px;
  background:#5b6472;color:#fff;font-size:11px;opacity:.75;pointer-events:none}

.rq-set{display:flex;flex-direction:column;gap:8px;font-size:13px}
.rq-set-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rq-set-mode{font-size:12px;padding:2px 10px;border-radius:999px;background:#eef1f6;color:#5b6472}
.rq-set-mode-local{background:#e6f5ee;color:#177a4c}
.rq-set-mode-remote{background:#e8f1fd;color:#2563c4}
.rq-set-mode-none{background:#fdebec;color:#c62a2f}
.rq-set-hub{color:#5b6472;font-size:12px}
.rq-set-btn{padding:5px 14px;border-radius:8px;border:1px solid #c9cfda;background:#fff;
  color:#252b35;font-size:12px;cursor:pointer}
.rq-set-btn:hover{background:#f3f5f9}
.rq-set-primary{border-color:#2563c4;color:#2563c4}
.rq-set-hint{color:#8a92a0;font-size:12px;line-height:1.6;margin:0}

.rq-wb{display:flex;flex-direction:column;height:100%;min-height:0;background:#fff}
.rq-wb-bar{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;
  border-bottom:1px solid #eef1f6;font-size:12px;color:#5b6472}
.rq-wb-title{font-weight:600}
.rq-wb-link{color:#2563c4;text-decoration:none}
.rq-wb-link:hover{text-decoration:underline}
.rq-wb-frame{flex:1;min-height:0;width:100%;border:none;background:#f3f4f6}

.rq-unlinked{position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:5px 12px;border-radius:999px;
  background:#c62a2f;color:#fff;font-size:11px;cursor:pointer;border:none;box-shadow:0 4px 12px rgba(198,42,47,.3)}
.rq-unlinked:hover{filter:brightness(.94)}
`;
var injected = false;
function ensureStyles() {
  if (injected || typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin="${PLUGIN_ID}"]`) !== null) {
    injected = true;
    return;
  }
  const tag = document.createElement("style");
  tag.dataset.plugin = PLUGIN_ID;
  tag.textContent = SHEET;
  document.head.appendChild(tag);
  injected = true;
}

// src/client/index.ts
var NS = "rq-card";
var PLUGIN_ID2 = "@dsh-ops/plugin-rq-card";
var RQ_TOOL_NAMES = [
  // 资产调运（四态主战场）
  "mcp_invoke",
  "mcp_service_list",
  "mcp_health_check",
  "mcp_metrics",
  "mcp_deploy",
  "mcp_offline",
  // NAS（文件/知识目录）
  "nas_list",
  "nas_get",
  "nas_health_check",
  "nas_fs_list",
  "nas_fs_search",
  "nas_fs_upload",
  "nas_fs_mkdir",
  "nas_fs_delete",
  // 技能
  "skill_search",
  "skill_submit",
  "skill_approve",
  "skill_publish",
  "skill_install",
  "skill_deprecate",
  // 应用
  "app_list",
  "app_metrics",
  "app_cost_breakdown",
  "app_topology",
  "app_metrics_report",
  // Agent
  "agent_list",
  "agent_get",
  "agent_bind_user",
  "agent_metrics",
  "agent_metrics_report",
  "agent_offline",
  // 身份与访问
  "iam_user_list",
  "iam_user_create",
  "iam_user_freeze",
  "iam_user_reset_password",
  "iam_org_tree",
  "iam_org_create",
  "iam_org_update",
  "iam_role_list",
  "iam_sync_run",
  "iam_conflict_list",
  "authn_token_issue",
  "authn_token_list",
  "authn_token_revoke",
  "authn_credential_create",
  "authn_credential_rotate",
  "authn_credential_scopes",
  // 连接器 / 模型 / 计费 / 审计 / 市场 / 审批
  "connector_catalog_search",
  "connector_connection_list",
  "connector_execute",
  "connector_run_list",
  "connector_perm_group_list",
  "model_list",
  "billing_wallet_balance",
  "audit_logs",
  "audit_alerts_list",
  "audit_alerts_read_all",
  "audit_cost_report",
  "market_plugin_list",
  "approval_decide",
  // 面板（部门工作台 + 战略看板）
  "panel_agents_list",
  "panel_msg_send",
  "panel_task_create",
  "panel_task_transition",
  "panel_scene_diag",
  "panel_widget_data",
  "panel_agent_invoke",
  "panel_board_digest",
  // 宿主连接（M2）
  "rq_host_status"
];
var DEGRADED = [];
function markDegraded(what, error) {
  DEGRADED.push(what);
  console.warn(`[rq-card] degraded (${what}):`, error ?? "target slot unavailable");
}
function safely(what, action) {
  try {
    action();
  } catch (error) {
    markDegraded(what, error);
  }
}
function probeSpec(ctx, slot) {
  try {
    const spec = ctx.slots.specDynamic?.(slot);
    return typeof spec === "object" && spec !== null ? spec : void 0;
  } catch {
    return void 0;
  }
}
var inject = ["slots", "locale"];
function apply(ctx) {
  safely("styles", () => {
    ensureStyles();
  });
  safely("locale", () => {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "rq-card: dictionaries");
  });
  const toolviewSpec = probeSpec(ctx, SLOT_TOOLVIEW);
  if (toolviewSpec?.kind !== "keyed") {
    markDegraded(`${SLOT_TOOLVIEW} spec missing or not keyed`, toolviewSpec);
  } else {
    for (const tool of RQ_TOOL_NAMES) {
      safely(`toolview:${tool}`, () => {
        ctx.slots.inject(SLOT_TOOLVIEW, () => ctx.slots.register({
          name: SLOT_TOOLVIEW,
          key: tool,
          id: `${TOOLVIEW_ENTRY_PREFIX}${tool}`,
          locale: NS,
          inject: () => ({
            // C2 表映射的唯一入口；healthSnapshot 为宿主半后续接线点。
            deriveState: deriveExecutionState
          })
        }, ExecutionCard));
      });
    }
  }
  const actionsSpec = probeSpec(ctx, SLOT_ASSISTANT_ACTIONS);
  if (actionsSpec?.kind !== "list") {
    markDegraded(`${SLOT_ASSISTANT_ACTIONS} spec missing or not list`, actionsSpec);
  } else {
    safely("assistant-actions", () => {
      ctx.slots.inject(SLOT_ASSISTANT_ACTIONS, () => {
        const controllers = /* @__PURE__ */ new Map();
        const controllerFor = (sessionId) => {
          let controller = controllers.get(sessionId);
          if (controller === void 0) {
            controller = new RqFeedbackController();
            controllers.set(sessionId, controller);
          }
          return controller;
        };
        const dispose = ctx.slots.register({
          name: SLOT_ASSISTANT_ACTIONS,
          id: FEEDBACK_ENTRY_ID,
          order: 20,
          locale: NS,
          inject: (sessionId) => {
            const controller = controllerFor(sessionId);
            return {
              hooks: { rqfb: controller },
              rate: (messageId, score, note) => controller.rate(messageId, score, note)
            };
          }
        }, RqFeedback);
        return () => {
          dispose();
          controllers.clear();
        };
      });
    });
  }
  if (DEGRADED.length > 0) {
    const overlaySpec = probeSpec(ctx, SLOT_OVERLAY);
    if (overlaySpec?.kind === "list") {
      safely("overlay-badge", () => {
        ctx.slots.inject(SLOT_OVERLAY, () => ctx.slots.register({
          name: SLOT_OVERLAY,
          id: DEGRADED_BADGE_ID,
          order: 90
        }, function RqCardDegradedBadge() {
          return (0, import_react3.createElement)("span", { className: "rq-badge" }, "\u6995\u5668\u5361\u7247\u672A\u751F\u6548\uFF08\u7EAF\u6587\u672C\u6A21\u5F0F\uFF09");
        }));
      });
    }
    console.warn(`[rq-card] degraded mode with ${DEGRADED.length} reason(s); markdown fallback remains available`);
  }
  const settingsSpec = probeSpec(ctx, SLOT_SETTINGS);
  const t = (() => {
    try {
      return ctx.locale.bind(NS);
    } catch {
      return void 0;
    }
  })();
  if (settingsSpec?.kind !== "list") {
    markDegraded(`${SLOT_SETTINGS} spec missing or not list`, settingsSpec);
  } else {
    safely("settings-section", () => {
      ctx.slots.inject(SLOT_SETTINGS, () => ctx.slots.register({
        name: SLOT_SETTINGS,
        id: "rq-hostlink",
        order: 30,
        ...t ? { label: () => t("settings.nav") } : {},
        locale: NS,
        inject: () => ({
          open: (url) => {
            try {
              window.open(url, "_blank", "noopener");
            } catch {
            }
          },
          refresh: () => fetchHostLink()
        })
      }, RqSettings));
    });
  }
  const viewSpec = probeSpec(ctx, SLOT_VIEW);
  if (viewSpec?.kind !== "list") {
    markDegraded(`${SLOT_VIEW} spec missing or not list`, viewSpec);
  } else {
    safely("workbench-view", () => {
      ctx.slots.inject(SLOT_VIEW, () => ctx.slots.register({
        name: SLOT_VIEW,
        id: "rq-workbench",
        order: 20,
        ...t ? { label: () => t("view.workbench") } : {},
        locale: NS,
        inject: () => ({})
      }, RqWorkbench));
    });
  }
  safely("unlinked-badge", () => {
    void fetchHostLink().then((link) => {
      if (link?.mode !== "none") return;
      const overlaySpec2 = probeSpec(ctx, SLOT_OVERLAY);
      if (overlaySpec2?.kind !== "list") return;
      ctx.slots.inject(SLOT_OVERLAY, () => ctx.slots.register({
        name: SLOT_OVERLAY,
        id: UNLINKED_BADGE_ID,
        order: 80
      }, function RqUnlinkedBadge() {
        return (0, import_react3.createElement)("button", {
          type: "button",
          className: "rq-unlinked",
          onClick: () => {
            try {
              window.open(PANEL_URL, "_blank", "noopener");
            } catch {
            }
          }
        }, "\u6995\u5668\uFF1A\u672A\u8FDE\u63A5\u5BBF\u4E3B\uFF0C\u70B9\u51FB\u6253\u5F00\u5411\u5BFC");
      }));
    });
  });
  console.info("[rq-card] client plugin applied:", PLUGIN_ID2);
}
return module.exports; } });
//# sourceMappingURL=client.js.map
