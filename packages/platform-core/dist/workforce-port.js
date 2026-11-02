import { Service } from "@deepseek-ai/cordis";
import { t } from "../../platform-i18n/dist/index.js";
const WORK_DATA_CLASS_ORDER = {
  public: 0,
  internal: 1,
  secret: 2,
  confidential: 3,
  topsecret: 4
};
const WORK_DENY_CODE_LABELS = {
  WORKFORCE_NOT_READY: "\u6570\u5B57\u5458\u5DE5\u5DE5\u4F5C\u7B56\u7565\u672A\u5C31\u7EEA\uFF0C\u5DE5\u4F5C\u8DEF\u5F84\u4E0D\u53EF\u7528",
  EMPLOYEE_NOT_ACTIVE: "\u6570\u5B57\u5458\u5DE5\u4E0D\u5728\u5C97\uFF08\u505C\u804C\u6216\u5DF2\u79BB\u5C97\uFF09",
  APPOINTMENT_NOT_EFFECTIVE: "\u4EFB\u7528\u672A\u751F\u6548\uFF08\u8D44\u6E90\u6388\u6743\u51C6\u5907\u672A\u5B8C\u6210\uFF09",
  APPOINTMENT_EXPIRED: "\u4EFB\u7528\u5DF2\u8FC7\u671F",
  PRINCIPAL_BINDING_MISMATCH: "\u8C03\u7528\u4E3B\u4F53\u4E0E\u5458\u5DE5\u6280\u672F\u7ED1\u5B9A\u4E0D\u5339\u914D",
  RUN_NOT_OWNED: "\u8BE5 run \u4E0D\u5F52\u5C5E\u5F53\u524D\u8C03\u7528\u4E3B\u4F53",
  LEASE_STALE: "\u6267\u884C\u79DF\u7EA6\u5DF2\u8FC7\u671F\u6216\u88AB\u66F4\u9AD8\u7248\u672C\u53D6\u4EE3",
  TOOL_NOT_GRANTED: "\u5DE5\u5177\u672A\u5217\u5165\u672C\u4EFB\u7528\u80FD\u529B\u6E05\u5355",
  ARGUMENT_SCOPE_DENIED: "\u53C2\u6570\u8D85\u51FA\u4EFB\u7528\u8FB9\u754C\uFF08\u5DE5\u5382/\u5DE5\u5355/\u76EE\u5F55\u7B49\u8303\u56F4\u7EA6\u675F\uFF09",
  APPROVAL_REQUIRED: "\u8BE5\u52A8\u4F5C\u9700\u8981\u4E1A\u52A1\u5BA1\u6279\uFF0C\u8BF7\u5C55\u793A\u5BA1\u6279\u5355\u5E76\u7B49\u5F85",
  BUDGET_EXCEEDED: "\u9884\u7B97\u4E0D\u8DB3\u6216\u9884\u7559\u5931\u8D25",
  STEP_ARGUMENT_CONFLICT: "\u540C\u4E00\u4E1A\u52A1\u6B65\u9AA4\u952E\u5DF2\u7ED1\u5B9A\u4E0D\u540C\u53C2\u6570\uFF0C\u51B2\u7A81\u62D2\u7EDD",
  OUTCOME_UNKNOWN: "\u5916\u90E8\u7ED3\u679C\u4E0D\u786E\u5B9A\uFF0C\u8BF7\u5148\u67E5\u8BC1\u6838\u9A8C\uFF0C\u7981\u6B62\u81EA\u52A8\u91CD\u8BD5\u5199\u5165",
  ARTIFACT_SCOPE_DENIED: "\u6587\u4EF6\u8303\u56F4\u8D8A\u754C\uFF08\u4EC5\u5141\u8BB8\u53D7\u63A7 artifact \u4E0A\u4F20/\u8BFB\u53D6\uFF09",
  RATE_LIMITED: "\u547D\u4E2D\u53EF\u91CD\u8BD5\u6D41\u63A7\uFF0C\u8BF7\u6309\u670D\u52A1\u7AEF\u91CD\u8BD5\u7B56\u7565\u9000\u907F",
  TOOL_UNKNOWN: "\u5DE5\u5177\u53E5\u67C4\u65E0\u6CD5\u89E3\u6790\u5230\u5DF2\u767B\u8BB0\u8D44\u6E90",
  RISK_UNREGISTERED: "\u5DE5\u5177\u98CE\u9669\u672A\u767B\u8BB0\u751F\u6548\uFF0C\u5199\u80FD\u529B\u987B\u5148\u7ECF\u98CE\u9669\u767B\u8BB0\u5BA1\u6279\uFF08V11\uFF09",
  WORKFORCE_DISABLED: "\u6570\u5B57\u5458\u5DE5\u57DF\u5BF9\u672C\u7EC4\u7EC7\u5904\u4E8E\u7070\u5EA6\u5173\u95ED",
  POLICY_INTERNAL_ERROR: "\u5DE5\u4F5C\u7B56\u7565\u6267\u884C\u5F02\u5E38\uFF08fail-closed\uFF09"
};
class WorkforcePolicyRegistry extends Service {
  static provide = "workforcePolicy";
  provider = null;
  constructor(ctx) {
    super(ctx, "workforcePolicy");
  }
  register(provider) {
    this.provider = provider;
    try {
      this.ctx.platformBus?.emit("workforce.port.ready", { at: (/* @__PURE__ */ new Date()).toISOString() });
    } catch {
    }
  }
  /** 未登记返回 null：消费方据此走 legacy 或拒绝新工作路径（V29）。 */
  port() {
    return this.provider;
  }
  isReady() {
    return this.provider !== null;
  }
}
async function gateManagedWork(registry, caller, query) {
  const port = registry?.port?.() ?? null;
  if (!port || !caller) return { mode: "legacy" };
  let managed;
  try {
    managed = await port.resolveManagedEmployee(caller);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { mode: "denied", code: "POLICY_INTERNAL_ERROR", message: t("\u5DE5\u4F5C\u7B56\u7565\u53CD\u67E5\u5931\u8D25\uFF08fail-closed\uFF09\uFF1A{message}", { message }) };
  }
  if (!managed) return { mode: "legacy" };
  try {
    const decision = await port.authorizeWorkAction(caller, query);
    return decision.allow ? { mode: "managed", work: decision.work } : { mode: "denied", code: decision.code, message: decision.message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { mode: "denied", code: "POLICY_INTERNAL_ERROR", message: t("\u5DE5\u4F5C\u7B56\u7565\u6821\u9A8C\u5F02\u5E38\uFF08fail-closed\uFF09\uFF1A{message}", { message }) };
  }
}
export {
  WORK_DATA_CLASS_ORDER,
  WORK_DENY_CODE_LABELS,
  WorkforcePolicyRegistry,
  gateManagedWork
};
