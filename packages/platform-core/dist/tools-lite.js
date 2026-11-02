import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
class ToolRuntimeLite extends Service {
  static provide = "tools";
  definitions = /* @__PURE__ */ new Map();
  guards = [];
  contextualGuards = [];
  interceptors = [];
  constructor(ctx) {
    super(ctx, "tools");
  }
  register(definition) {
    for (const fn of this.interceptors) definition = fn(definition);
    const { name, output } = definition;
    if (typeof name !== "string" || !name) throw new TypeError(`[tools] \u5DE5\u5177\u540D\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
    if (output === void 0 || typeof output !== "object" || typeof output.render !== "function") {
      throw new TypeError(`\u5DE5\u5177 "${name}" \u5FC5\u987B\u58F0\u660E output { schema, render }`);
    }
    if (output.schema === void 0 || output.schema === null || typeof output.schema !== "object" || Array.isArray(output.schema)) {
      throw new TypeError(`\u5DE5\u5177 "${name}" \u5FC5\u987B\u58F0\u660E output.schema\uFF08\u975E\u7A7A\u5BF9\u8C61\u6839\uFF0CJSON Schema\uFF09`);
    }
    if (this.definitions.has(name)) throw new Error(`[tools] \u5DE5\u5177\u540D\u91CD\u590D\uFF1A${name}`);
    this.definitions.set(name, definition);
    try {
      this.ctx.platformBus?.emit("tools/change", { kind: "register", name });
    } catch {
    }
    return () => {
      this.definitions.delete(name);
    };
  }
  guard(guard) {
    this.guards.push(guard);
    return () => {
      const index = this.guards.indexOf(guard);
      if (index >= 0) this.guards.splice(index, 1);
    };
  }
  /**
   * 上下文型 guard 注册器（D02/D03 additive）：注册的 guard 在旧 guard 链全部通过后
   * 运行，按注册顺序执行并注入 principal/callId。任一返回拒绝原因即短路（与旧 guard
   * 同款失败形态：isError + 中文拒绝文案）。返回注销函数。
   */
  guardContext(guard) {
    if (typeof guard !== "function") throw new TypeError("[tools] guardContext \u7684 guard \u5FC5\u987B\u662F\u51FD\u6570");
    this.contextualGuards.push(guard);
    return () => {
      const index = this.contextualGuards.indexOf(guard);
      if (index >= 0) this.contextualGuards.splice(index, 1);
    };
  }
  /**
   * 注册级拦截器（OPT-P1-03 正式扩展点）：此后所有 register 先经拦截链再入表。
   * 供 connect 远程转发等横切能力挂在契约上，取代原型猴补丁。返回注销函数。
   */
  intercept(fn) {
    if (typeof fn !== "function") throw new TypeError("[tools] intercept \u7684\u62E6\u622A\u5668\u5FC5\u987B\u662F\u51FD\u6570");
    this.interceptors.push(fn);
    return () => {
      const index = this.interceptors.indexOf(fn);
      if (index >= 0) this.interceptors.splice(index, 1);
    };
  }
  /**
   * 已注册工具的执行体包扎（OPT-P1-03 正式扩展点）：用 wrap 替换当前 execute，
   * wrap 收到原执行体、返回新执行体。返回还原函数（按包扎时的现场逆向恢复）。
   * 工具不存在抛 TypeError（不静默）。
   */
  decorate(name, wrap) {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`[tools] decorate \u76EE\u6807\u5DE5\u5177\u4E0D\u5B58\u5728\uFF1A${name}`);
    if (typeof wrap !== "function") throw new TypeError(`[tools] decorate \u7684 wrap \u5FC5\u987B\u662F\u51FD\u6570\uFF08\u5DE5\u5177 ${name}\uFF09`);
    const previous = definition.execute;
    definition.execute = wrap(previous);
    return () => {
      definition.execute = previous;
    };
  }
  schemas() {
    return [...this.definitions.values()].map(({ name, description, parameters, plugin, permission }) => ({
      name,
      description,
      parameters,
      plugin,
      permission
    }));
  }
  has(name) {
    return this.definitions.has(name);
  }
  async execute(input) {
    const started = Date.now();
    const callId = randomUUID();
    const name = input.name;
    const args = input.arguments ?? {};
    const base = { callId, name };
    const definition = this.definitions.get(name);
    if (!definition) {
      return { ...base, isError: true, content: [{ type: "text", text: `\u672A\u77E5\u5DE5\u5177\uFF1A${name}` }], error: { message: `\u672A\u77E5\u5DE5\u5177\uFF1A${name}` }, durationMs: 0 };
    }
    for (const guard of this.guards) {
      const reason = guard({ name, arguments: args });
      if (reason) {
        return { ...base, isError: true, content: [{ type: "text", text: `\u8C03\u7528\u88AB\u62D2\u7EDD\uFF1A${reason}` }], error: { message: reason }, durationMs: Date.now() - started };
      }
    }
    for (const guard of this.contextualGuards) {
      const reason = guard({ name, arguments: args, ...input.principal ? { principal: input.principal } : {}, callId });
      if (reason) {
        return { ...base, isError: true, content: [{ type: "text", text: `\u8C03\u7528\u88AB\u62D2\u7EDD\uFF1A${reason}` }], error: { message: reason }, durationMs: Date.now() - started };
      }
    }
    const signal = input.signal ?? new AbortController().signal;
    const exec = { callId, name, signal, ...input.principal ? { principal: input.principal } : {} };
    try {
      const value = await definition.execute(structuredClone(args), exec);
      const content = safeRender(definition, args, value);
      return { ...base, isError: false, value, content, durationMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, isError: true, content: [{ type: "text", text: `\u5DE5\u5177\u6267\u884C\u5931\u8D25\uFF1A${message}` }], error: { message }, durationMs: Date.now() - started };
    }
  }
}
function safeRender(definition, args, value) {
  try {
    const rendered = definition.output.render(args, value);
    return Array.isArray(rendered) ? rendered : [{ type: "text", text: JSON.stringify(value) }];
  } catch {
    return [{ type: "text", text: JSON.stringify(value) }];
  }
}
function defineTool(spec) {
  const properties = {};
  const required = [];
  for (const [key, param] of Object.entries(spec.parameters)) {
    const node = { type: param.type };
    if (param.description) node.description = param.description;
    if (param.enum) node.enum = param.enum;
    if (param.items) node.items = param.items;
    properties[key] = node;
    if (param.required) required.push(key);
  }
  const parameters = {
    type: "object",
    properties,
    ...required.length > 0 ? { required } : {}
  };
  return {
    name: spec.name,
    description: spec.description,
    plugin: spec.plugin,
    ...spec.permission !== void 0 ? { permission: spec.permission } : {},
    parameters,
    output: {
      schema: spec.output,
      render: spec.render ?? ((_args, value) => [
        { type: "text", text: JSON.stringify(value, null, 2) }
      ])
    },
    ...spec.timeoutMs !== void 0 ? { timeoutMs: spec.timeoutMs } : {},
    execute: spec.execute
  };
}
export {
  ToolRuntimeLite,
  defineTool
};
