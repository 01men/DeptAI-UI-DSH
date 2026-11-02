import { Service } from "@deepseek-ai/cordis";
function createHostWebPort(webServer) {
  const port = {
    register: (route) => webServer.register(route)
  };
  if (typeof webServer.tapIndex === "function") {
    const tapIndex = webServer.tapIndex.bind(webServer);
    port.tapIndex = (transform) => tapIndex(transform);
  }
  return port;
}
class HostBridgeRegistry extends Service {
  static provide = "hostBridge";
  web = null;
  constructor(ctx) {
    super(ctx, "hostBridge");
  }
  registerWebPort(port) {
    this.web = port;
    try {
      this.ctx.platformBus?.emit("hostBridge.port.ready", { at: (/* @__PURE__ */ new Date()).toISOString() });
    } catch {
    }
  }
  /** 未登记返回 null：消费方据此降级（对齐 workforce port() 语义）。 */
  port() {
    return this.web;
  }
  isReady() {
    return this.web !== null;
  }
}
export {
  HostBridgeRegistry,
  createHostWebPort
};
