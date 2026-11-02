const ROOT_KEY = Symbol.for("ybkk.cordis.root");
const FIBER_STATE = {
  0: "PENDING",
  1: "LOADING",
  2: "ACTIVE",
  3: "FAILED",
  4: "DISPOSED",
  5: "UNLOADING"
};
const STATE_ACTIVE = 2;
const STATE_FAILED = 3;
function assertSingleRoot(ctx) {
  const holder = globalThis;
  const existing = holder[ROOT_KEY];
  if (existing && existing !== ctx.root) {
    throw new Error(
      "\u68C0\u6D4B\u5230\u53CC\u5B9E\u4F8B\uFF1A\u8FDB\u7A0B\u5185\u51FA\u73B0\u4E86\u7B2C\u4E8C\u4E2A root Context\uFF0C\u670D\u52A1\u6CE8\u518C\u4E0E inject \u89E3\u6790\u5C06\u5206\u5C5E\u4E24\u68F5\u9694\u79BB\u6811\uFF0Cfiber \u4F1A\u9759\u9ED8\u5361\u6B7B\u5728 PENDING\u3002\u4FEE\u590D\u65B9\u5F0F\uFF1A\u590D\u7528 vendor/cordis \u5355\u5B9E\u4F8B\uFF08\u5168\u90E8\u6A21\u5757\u7ECF\u540C\u4E00 specifier \u89E3\u6790\u5230\u540C\u4E00\u4EFD cordis\uFF09\uFF0C\u6216\u6539\u7528\u72EC\u7ACB\u5BBF\u4E3B\u8FDB\u7A0B\u5F62\u6001\uFF0C\u7981\u6B62\u5728\u540C\u4E00\u8FDB\u7A0B\u521B\u5EFA\u7B2C\u4E8C\u4E2A\u6839\u4E0A\u4E0B\u6587\u3002"
    );
  }
  holder[ROOT_KEY] ??= ctx.root;
}
function failedButCovered(ctx, fiber) {
  const declared = fiber.runtime?.callback?.provide;
  const names = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
  if (names.length === 0) return false;
  return names.every((name) => {
    const impl = ctx.reflect._getImpl(name, true);
    return !!impl && impl.fiber !== fiber;
  });
}
function probeTree(ctx, required) {
  const unreachable = required.filter((name) => !ctx.reflect._getImpl(name, true));
  const stuck = [];
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.state === STATE_ACTIVE) continue;
      const waiting = Object.keys(fiber.inject).filter((name) => !fiber.ctx.reflect._getImpl(name, true));
      stuck.push({
        plugin: fiber.name,
        state: FIBER_STATE[fiber.state] ?? `UNKNOWN(${fiber.state})`,
        waiting,
        blocking: fiber.state === STATE_FAILED ? !failedButCovered(ctx, fiber) : true
      });
    }
  }
  return { ok: unreachable.length === 0 && !stuck.some((item) => item.blocking), unreachable, stuck };
}
function formatTreeHealth(h) {
  const lines = ["\u63D2\u4EF6\u6811\u672A\u5065\u5EB7\uFF0C\u62D2\u7EDD\u542F\u52A8"];
  if (h.unreachable.length > 0) {
    lines.push(`\u4E0D\u53EF\u8FBE\u670D\u52A1\uFF08${h.unreachable.length}\uFF09\uFF1A${h.unreachable.join("\u3001")}`);
  }
  for (const item of h.stuck) {
    const waiting = item.waiting.length > 0 ? item.waiting.join("\u3001") : "\uFF08\u65E0\u672A\u6EE1\u8DB3\u7684 inject\uFF0C\u67E5\u63D2\u4EF6\u81EA\u8EAB\u542F\u52A8\u9519\u8BEF\uFF09";
    const benign = item.blocking ? "" : "\uFF08\u826F\u6027\u8D25\u8005\uFF1A\u58F0\u660E\u670D\u52A1\u5DF2\u7531\u5176\u4ED6 fiber \u63A5\u7BA1\uFF0C\u4E0D\u62E6\u542F\u52A8\uFF09";
    lines.push(`\u5361\u6B7B\u63D2\u4EF6 ${item.plugin} \xB7 \u72B6\u6001 ${item.state}${benign} \xB7 \u7B49\u5F85 inject\uFF1A${waiting}`);
  }
  return lines.join("\n");
}
export {
  assertSingleRoot,
  formatTreeHealth,
  probeTree
};
