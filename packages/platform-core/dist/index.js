import { StorageService } from "./storage.js";
import { PlatformBusService } from "./bus.js";
import { ToolRuntimeLite } from "./tools-lite.js";
import { HttpServerService } from "./http.js";
import { SqliteTxnService } from "./sqlite.js";
import { WorkforcePolicyRegistry } from "./workforce-port.js";
import { BehaviorService } from "./behavior.js";
import { ScenegraphService } from "./scenegraph.js";
export * from "./storage.js";
export * from "./storage-sqlite.js";
export * from "./bus.js";
export * from "./tools-lite.js";
export * from "./http.js";
export * from "./openapi.js";
export * from "./rest-gate.js";
export * from "./principal.js";
export * from "./pdp.js";
export * from "./trace.js";
export * from "./ids.js";
export * from "./sensitive.js";
export * from "./sqlite.js";
export * from "./workforce-port.js";
export * from "./host-bridge.js";
export * from "./yaml.js";
export * from "./zip.js";
export * from "./plugin-ctx.js";
export * from "./version.js";
export * from "./behavior.js";
export * from "./scenegraph.js";
export * from "./signature.js";
export * from "./boot-probe.js";
export * from "./taxonomy.js";
const name = "platform-core";
async function apply(ctx, config = {}) {
  const storage = new StorageService(ctx, { dataDir: config.dataDir });
  ctx.plugin(PlatformBusService);
  ctx.plugin(SqliteTxnService, { dataDir: config.dataDir });
  ctx.plugin(WorkforcePolicyRegistry);
  if (config.provideToolRuntime !== false) {
    ctx.plugin(ToolRuntimeLite);
  }
  const http = new HttpServerService(ctx, config.http ?? {});
  await storage.start();
  await storage.restoreAll();
  ctx.plugin(BehaviorService);
  ctx.plugin(ScenegraphService);
  if (config.startHttp !== false) {
    void http.start().then(() => {
      ctx.logger("platform-core").info(`HTTP \u670D\u52A1\u5DF2\u542F\u52A8\uFF1Ahttp://${http.host}:${http.port}`);
    }, (error) => {
      ctx.logger("platform-core").error("HTTP \u670D\u52A1\u542F\u52A8\u5931\u8D25", error);
    });
  }
}
export {
  apply,
  name
};
