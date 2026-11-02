import { newId } from "./ids.js";
function moduleDecision(allow, reasons, obligations = []) {
  return { allow, reasons: [...reasons], decisionId: newId("pd"), obligations };
}
class PolicyDecisionPoint {
  modules = [];
  register(m) {
    this.modules.push(m);
  }
  /** 已注册模块 id（只读视图，供装配面诊断）。 */
  moduleIds() {
    return this.modules.map((m) => m.id);
  }
  async decide(req) {
    const allowReasons = [];
    const denyReasons = [];
    const obligations = [];
    let allow = true;
    for (const module of this.modules) {
      let decision;
      try {
        decision = await module.decide(req);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        decision = { allow: false, reasons: [`\u6A21\u5757 ${module.id} \u88C1\u51B3\u5F02\u5E38\uFF08fail-closed\uFF09\uFF1A${message}`], decisionId: newId("pd"), obligations: [] };
      }
      ;
      (decision.allow ? allowReasons : denyReasons).push(...decision.reasons);
      if (Array.isArray(decision.obligations)) obligations.push(...decision.obligations);
      if (!decision.allow) allow = false;
    }
    const reasons = allow ? allowReasons : [...denyReasons, ...allowReasons];
    return { allow, reasons, decisionId: newId("pd"), obligations };
  }
}
function wrapPolicyDecision(allow, reasons) {
  return { allow, reasons: [...reasons], decisionId: newId("pd"), obligations: [] };
}
export {
  PolicyDecisionPoint,
  moduleDecision,
  wrapPolicyDecision
};
