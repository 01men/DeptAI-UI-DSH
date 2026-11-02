import { toWorkCallerRef, unifiedFromCaller } from "./principal.js";
import { t } from "../../platform-i18n/dist/index.js";
const IMPLIED_POINTS = { "console.read": "console.login" };
function permissionPointAllows(permissions, point) {
  const impliedBy = IMPLIED_POINTS[point];
  return permissions.includes("*") || permissions.includes(point) || impliedBy !== void 0 && permissions.includes(impliedBy);
}
function createRestGate(ctx) {
  const caller = (exchange) => exchange.principal;
  const requirePermission = (exchange, point) => {
    const info = caller(exchange);
    if (permissionPointAllows(info.permissions, point)) return true;
    ctx.platformBus.emit("audit.authz.denied", {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point,
      path: exchange.path
    });
    exchange.fail(403, "FORBIDDEN", t("\u7F3A\u5C11\u6743\u9650\u70B9 {point}\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u8C03\u6574\u89D2\u8272", { point }), { permission: point });
    return false;
  };
  const guarded = (method, path, permission, handler) => {
    ctx.httpServer.register(method, path, async (exchange) => {
      if (!requirePermission(exchange, permission)) return;
      try {
        const result = await handler(exchange);
        if (!exchange.res.writableEnded) exchange.ok(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        exchange.fail(400, "BAD_REQUEST", message);
      }
    }, { access: "guarded", permission });
  };
  const body = (exchange) => exchange.body ?? {};
  const changeLog = (exchange, action, resourceType, resourceId, resourceName, detail = "") => {
    if (!ctx.audit) throw new Error(t("changeLog \u9700\u8981\u5BBF\u4E3B\u6CE8\u5165 audit \u670D\u52A1\uFF08\u672C\u63D2\u4EF6\u672A\u6CE8\u5165\uFF0C\u7981\u6B62\u9759\u9ED8\u4E22\u5F03\u5BA1\u8BA1\uFF09"));
    const info = caller(exchange);
    ctx.audit.record({
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
  const actorOf = (exchange) => {
    const info = caller(exchange);
    return info.userId ?? info.principalId;
  };
  return { caller, requirePermission, guarded, body, changeLog, actorOf };
}
function workCallerOf(info) {
  return toWorkCallerRef(unifiedFromCaller(info));
}
export {
  IMPLIED_POINTS,
  createRestGate,
  permissionPointAllows,
  workCallerOf
};
