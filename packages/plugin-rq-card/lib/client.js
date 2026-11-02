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
  applyViaPort: () => applyViaPort,
  deriveExecutionState: () => deriveExecutionState,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react2 = require("react");

// src/client/host-port.ts
function createClientHostPort(ctx) {
  const slots = ctx.slots;
  const locale = ctx.locale;
  const root = ctx;
  const port = {
    slots: {
      inject: (slot, factory) => slots.inject(slot, factory),
      register: (spec, component) => slots.register(spec, component)
    },
    locale: {
      register: (namespace, dictionaries) => locale.register(namespace, dictionaries)
    },
    effect: (action, name) => root.effect(action, name)
  };
  if (typeof slots.specDynamic === "function") {
    const specDynamic = slots.specDynamic.bind(ctx.slots);
    port.slots.specDynamic = (name) => {
      try {
        const spec = specDynamic(name);
        return typeof spec === "object" && spec !== null ? spec : void 0;
      } catch {
        return void 0;
      }
    };
  }
  return port;
}

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
var FEEDBACK_ENTRY_ID = "rq-feedback";
var TOOLVIEW_ENTRY_PREFIX = "rq-tool-";
var DEGRADED_BADGE_ID = "rq-card-degraded";

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
  // ── 降级角标（shell.overlay）──
  "badge.degraded": "\u5143\u51B0\u53EF\u5361\u7247\u672A\u751F\u6548\uFF08\u7EAF\u6587\u672C\u6A21\u5F0F\uFF09"
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
  "badge.degraded": "RongQi cards inactive (plain-text mode)"
};
var ja = {
  "card.state.calling": "\u547C\u3073\u51FA\u3057\u4E2D",
  "card.state.executing": "\u5B9F\u884C\u4E2D",
  "card.state.done": "\u5B8C\u4E86",
  "card.state.blocked": "\u30D6\u30ED\u30C3\u30AF\u4E2D",
  "card.state.idle": "\u5F85\u6A5F\u4E2D",
  "card.args.summary": "\u547C\u3073\u51FA\u3057\u5F15\u6570",
  "card.result.title": "\u5B9F\u884C\u7D50\u679C",
  "card.result.truncated": "\uFF08\u5185\u5BB9\u304C\u9577\u3044\u305F\u3081\u5207\u308A\u6368\u3066\u307E\u3057\u305F\uFF09",
  "card.console.link": "\u30B3\u30F3\u30BD\u30FC\u30EB\u3067\u958B\u304F",
  "card.cancel.button": "\u30AD\u30E3\u30F3\u30BB\u30EB",
  "card.cancel.hint": "\u30AD\u30E3\u30F3\u30BB\u30EB\u306F\u30DB\u30B9\u30C8\u5074\u306E\u63A5\u7D9A\u5F8C\u306B\u6709\u52B9\u306B\u306A\u308A\u307E\u3059",
  "card.degraded.hint": "\u6642\u9593\u304C\u304B\u304B\u3063\u3066\u3044\u307E\u3059\u3002\u30D0\u30C3\u30AF\u30B0\u30E9\u30A6\u30F3\u30C9\u3067\u51E6\u7406\u4E2D\u3067\u3059",
  "card.blocked.nas-authz-deny": "\u30A2\u30AF\u30BB\u30B9\u6A29\u304C\u3042\u308A\u307E\u305B\u3093\u3002\u5148\u306B\u6A29\u9650\u3092\u7533\u8ACB\u3057\u3066\u304F\u3060\u3055\u3044",
  "card.blocked.quota-exhausted": "\u30A6\u30A9\u30EC\u30C3\u30C8\u6B8B\u9AD8\u3092\u4F7F\u3044\u5207\u308A\u307E\u3057\u305F\u3002\u8FFD\u52A0\u3092\u7533\u8ACB\u3057\u3066\u304F\u3060\u3055\u3044",
  "card.blocked.pdp-unreachable": "\u30DD\u30EA\u30B7\u30FC\u5224\u5B9A\u30DD\u30A4\u30F3\u30C8\uFF08PDP\uFF09\u306B\u5230\u9054\u3067\u304D\u306A\u3044\u305F\u3081\u3001\u4FDD\u8B77\u7684\u306B\u4E00\u6642\u505C\u6B62\u4E2D\u3067\u3059",
  "card.blocked.breaker-open": "\u30B5\u30FC\u30AD\u30C3\u30C8\u30D6\u30EC\u30FC\u30AB\u30FC\u304C\u4F5C\u52D5\u4E2D\u3067\u3059\u3002\u5FA9\u65E7\u5F8C\u306B\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044",
  "card.blocked.down": "\u30B5\u30FC\u30D3\u30B9\u306F\u73FE\u5728\u5229\u7528\u3067\u304D\u307E\u305B\u3093\u3002\u5FA9\u65E7\u5F8C\u306B\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044",
  "card.blocked.binding-invalid": "ID \u30D0\u30A4\u30F3\u30C7\u30A3\u30F3\u30B0\u306E\u6709\u52B9\u671F\u9650\u304C\u5207\u308C\u3066\u3044\u307E\u3059\u3002\u518D\u30D0\u30A4\u30F3\u30C9\u3057\u3066\u304F\u3060\u3055\u3044",
  "card.blocked.invoke-error": "\u5B9F\u884C\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002\u8A73\u7D30\u306F\u7D50\u679C\u60C5\u5831\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044",
  "card.action.nas-authz-deny": "\u30A2\u30AF\u30BB\u30B9\u7533\u8ACB",
  "card.action.quota-exhausted": "\u6B8B\u9AD8\u3092\u7533\u8ACB",
  "card.action.pdp-unreachable": "\u30D7\u30E9\u30C3\u30C8\u30D5\u30A9\u30FC\u30E0\u72B6\u614B\u3092\u78BA\u8A8D",
  "card.action.breaker-open": "\u30B5\u30FC\u30D3\u30B9\u72B6\u614B\u3092\u78BA\u8A8D",
  "card.action.down": "\u30B5\u30FC\u30D3\u30B9\u72B6\u614B\u3092\u78BA\u8A8D",
  "card.action.binding-invalid": "\u518D\u30D0\u30A4\u30F3\u30C9",
  "card.action.invoke-error": "\u30D7\u30E9\u30C3\u30C8\u30D5\u30A9\u30FC\u30E0\u72B6\u614B\u3092\u78BA\u8A8D",
  "fb.like": "\u5F79\u306B\u7ACB\u3063\u305F",
  "fb.dislike": "\u5F79\u306B\u7ACB\u305F\u306A\u304B\u3063\u305F",
  "fb.done": "\u8A18\u9332\u3057\u307E\u3057\u305F\u3002\u30D5\u30A3\u30FC\u30C9\u30D0\u30C3\u30AF\u3042\u308A\u304C\u3068\u3046\u3054\u3056\u3044\u307E\u3059",
  "badge.degraded": "RongQi \u30AB\u30FC\u30C9\u304C\u7121\u52B9\u3067\u3059\uFF08\u30C6\u30AD\u30B9\u30C8\u30E2\u30FC\u30C9\uFF09"
};

// src/client/styles.ts
var PLUGIN_ID = "@dsh-ops/plugin-rq-card";
var SHEET = `
.rq-ecard{border:1px solid var(--rq-edge,#e2e6ee);border-radius:10px;padding:8px 12px;
  margin:4px 0;font-size:var(--fs-13,13px);line-height:1.5;background:var(--rq-surface,#fff);max-width:640px}
.rq-ecard-head{display:flex;align-items:center;gap:8px;font-weight:600}
.rq-ecard-chip{font-weight:400;font-size:var(--fs-11,11px);padding:1px 8px;border-radius:999px;
  background:var(--rq-muted-bg,#eef1f6);color:var(--rq-muted-fg,#5b6472)}
.rq-ecard[data-state="calling"] .rq-ecard-chip{background:var(--rq-info-bg,#e8f1fd);color:var(--rq-info-fg,#2563c4)}
.rq-ecard[data-state="executing"] .rq-ecard-chip{background:var(--rq-ok-bg,#e6f5ee);color:var(--rq-ok-fg,#177a4c)}
.rq-ecard[data-state="done"] .rq-ecard-chip{background:var(--rq-ok-bg,#e6f5ee);color:var(--rq-ok-fg,#177a4c)}
.rq-ecard[data-state="blocked"]{border-color:var(--rq-danger,#e5484d);box-shadow:inset 3px 0 0 var(--rq-danger,#e5484d)}
.rq-ecard[data-state="blocked"] .rq-ecard-chip{background:var(--rq-danger-bg,#fdebec);color:var(--rq-danger-fg,#c62a2f)}
.rq-ecard-skel{margin-top:8px}
.rq-ecard-skel-line{height:10px;border-radius:5px;background:var(--rq-muted-bg,#eef1f6);margin:6px 0;
  animation:rq-pulse 1.4s ease-in-out infinite}
.rq-ecard-skel-line:nth-child(2){width:70%}
.rq-ecard-skel-line:nth-child(3){width:45%}
.rq-ecard-pulse{margin-top:8px;height:6px;border-radius:3px;overflow:hidden;background:var(--rq-muted-bg,#eef1f6)}
.rq-ecard-pulse::before{content:"";display:block;height:100%;width:38%;border-radius:3px;
  background:var(--rq-info-fg,#2563c4);opacity:.55;animation:rq-sweep 1.6s ease-in-out infinite}
.rq-ecard-degraded{margin-top:6px;font-size:var(--fs-12,12px);color:var(--rq-warn-fg,#9a6700)}
.rq-ecard-args{margin-top:8px;color:var(--rq-muted-fg,#5b6472);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:var(--fs-12,12px);white-space:pre-wrap;word-break:break-all;max-height:72px;overflow:hidden}
.rq-ecard-result{margin-top:8px;white-space:pre-wrap;word-break:break-word;color:var(--rq-text,#252b35)}
.rq-ecard-foot{margin-top:8px;display:flex;align-items:center;gap:10px}
.rq-ecard-link{color:var(--rq-info-fg,#2563c4);text-decoration:none;font-size:var(--fs-12,12px)}
.rq-ecard-link:hover{text-decoration:underline}
.rq-ecard-action{display:inline-block;padding:3px 12px;border-radius:6px;border:1px solid var(--rq-danger,#e5484d);
  color:var(--rq-danger-fg,#c62a2f);background:var(--rq-surface,#fff);font-size:var(--fs-12,12px);text-decoration:none;cursor:pointer}
.rq-ecard-action:hover{background:var(--rq-danger-bg,#fdebec)}
.rq-ecard-cancel{margin-left:auto;padding:2px 10px;border-radius:6px;border:1px solid var(--rq-line,#c9cfda);
  background:var(--rq-surface,#fff);color:var(--rq-muted-fg,#5b6472);font-size:var(--fs-12,12px);cursor:not-allowed}
.rq-ecard-reason{margin-top:6px;color:var(--rq-danger-fg,#c62a2f)}
@keyframes rq-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes rq-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}

.rq-fb{display:inline-flex;align-items:center;gap:4px;margin-left:8px}
.rq-fb-btn{border:none;background:transparent;cursor:pointer;font-size:var(--fs-13,13px);line-height:1;
  padding:3px 6px;border-radius:6px;opacity:.55}
.rq-fb-btn:hover{background:var(--rq-muted-bg,#eef1f6);opacity:1}
.rq-fb-btn[data-active="true"]{opacity:1;background:var(--rq-info-bg,#e8f1fd)}
.rq-fb-done{font-size:var(--fs-11,11px);color:var(--rq-faint,#8a92a0)}

.rq-badge{position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:4px 10px;border-radius:999px;
  background:var(--rq-muted-fg,#5b6472);color:var(--rq-surface,#fff);font-size:var(--fs-11,11px);opacity:.75;pointer-events:none}
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
  "approval_decide"
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
function probeSpec(host, slot) {
  return host.slots.specDynamic?.(slot);
}
var inject = ["slots", "locale"];
function apply(ctx) {
  applyViaPort(createClientHostPort(ctx));
}
function applyViaPort(host) {
  safely("styles", () => {
    ensureStyles();
  });
  safely("locale", () => {
    host.effect(() => host.locale.register(NS, { zh, en, ja }), "rq-card: dictionaries");
  });
  const toolviewSpec = probeSpec(host, SLOT_TOOLVIEW);
  if (toolviewSpec?.kind !== "keyed") {
    markDegraded(`${SLOT_TOOLVIEW} spec missing or not keyed`, toolviewSpec);
  } else {
    for (const tool of RQ_TOOL_NAMES) {
      safely(`toolview:${tool}`, () => {
        host.slots.inject(SLOT_TOOLVIEW, () => host.slots.register({
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
  const actionsSpec = probeSpec(host, SLOT_ASSISTANT_ACTIONS);
  if (actionsSpec?.kind !== "list") {
    markDegraded(`${SLOT_ASSISTANT_ACTIONS} spec missing or not list`, actionsSpec);
  } else {
    safely("assistant-actions", () => {
      host.slots.inject(SLOT_ASSISTANT_ACTIONS, () => {
        const controllers = /* @__PURE__ */ new Map();
        const controllerFor = (sessionId) => {
          let controller = controllers.get(sessionId);
          if (controller === void 0) {
            controller = new RqFeedbackController();
            controllers.set(sessionId, controller);
          }
          return controller;
        };
        const dispose = host.slots.register({
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
    const overlaySpec = probeSpec(host, SLOT_OVERLAY);
    if (overlaySpec?.kind === "list") {
      safely("overlay-badge", () => {
        host.slots.inject(SLOT_OVERLAY, () => host.slots.register({
          name: SLOT_OVERLAY,
          id: DEGRADED_BADGE_ID,
          order: 90,
          locale: NS
        }, function RqCardDegradedBadge(props) {
          const maybeT = props?.t;
          const translate = typeof maybeT === "function" ? maybeT : (key) => zh[key] ?? key;
          return (0, import_react2.createElement)("span", { className: "rq-badge" }, translate("badge.degraded"));
        }));
      });
    }
    console.warn(`[rq-card] degraded mode with ${DEGRADED.length} reason(s); markdown fallback remains available`);
  }
  console.info("[rq-card] client plugin applied:", PLUGIN_ID2);
}
return module.exports; } });
//# sourceMappingURL=client.js.map
