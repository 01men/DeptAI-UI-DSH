import { t } from "../../platform-i18n/dist/index.js";
function toOpenApiPath(pattern) {
  const params = [];
  const path = pattern.split("/").map((segment) => {
    if (!segment.startsWith(":")) return segment;
    const name = segment.slice(1);
    params.push(name);
    return `{${name}}`;
  }).join("/");
  return { path: path || "/", params };
}
function tagOf(pattern) {
  const segments = pattern.split("/").filter(Boolean);
  if (segments[0] === "api") return segments[1] ?? "api";
  return segments[0] ?? "root";
}
function operationIdOf(method, openApiPath) {
  const slug = openApiPath.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${method.toLowerCase()}_${slug || "root"}`;
}
function buildOpenApiDocument(routes, options) {
  const paths = {};
  const tags = /* @__PURE__ */ new Set();
  const sorted = [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const route of sorted) {
    const { path, params } = toOpenApiPath(route.path);
    const method = route.method.toLowerCase();
    const item = paths[path] ??= {};
    if (item[method] !== void 0) continue;
    const tag = tagOf(route.path);
    tags.add(tag);
    const auth = route.auth;
    const envelope = auth.access !== "outside-api";
    const operation = {
      operationId: operationIdOf(method, path),
      tags: [tag],
      ...params.length > 0 ? { parameters: params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })) } : {},
      responses: envelope ? {
        "200": {
          description: t("\u6210\u529F\uFF1A\u7EDF\u4E00\u4FE1\u5C01 { ok: true, data }"),
          content: { "application/json": { schema: { $ref: "#/components/schemas/OkEnvelope" } } }
        },
        default: {
          description: t("\u5931\u8D25\uFF1A\u7EDF\u4E00\u4FE1\u5C01 { ok: false, error: { code, message } }\uFF08401 \u672A\u8BA4\u8BC1 / 403 \u7F3A\u6743\u9650\u70B9 / 404 \u4E0D\u5B58\u5728 / 422 \u6821\u9A8C\u5931\u8D25\uFF09"),
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } }
        }
      } : { default: { description: t("\u534F\u8BAE\u9762\u54CD\u5E94\uFF08OAuth / MCP JSON-RPC / \u6587\u6863\u9875\u7B49\uFF0C\u4E0D\u8D70\u7EDF\u4E00\u4FE1\u5C01\uFF09") } },
      // 精确鉴权声明（与 route-matrix 同口径）：guarded=权限点保护；authenticated=仅 Bearer；
      // public=免鉴权（selfValidated=处理器自带凭证校验）；outside-api=协议面自管鉴权
      "x-auth": { ...auth }
    };
    if (auth.access === "guarded") {
      operation.security = [{ bearerAuth: [] }];
      operation["x-permission"] = auth.permission;
    } else if (auth.access === "authenticated") {
      operation.security = [{ bearerAuth: [] }];
    } else if (auth.access === "public") {
      operation.security = [];
    }
    item[method] = operation;
  }
  const externalBase = (options.externalBase ?? "").replace(/\/+$/, "");
  return {
    openapi: "3.0.3",
    info: {
      title: t("\u5143\u51B0\u53EF \xB7 \u4F01\u4E1A AI \u8D44\u6E90\u7EDF\u4E00\u7BA1\u7406\u5E73\u53F0 API"),
      version: options.version,
      description: t("\u7531\u8FD0\u884C\u65F6\u8DEF\u7531\u53F0\u8D26\u81EA\u52A8\u751F\u6210\uFF1A\u8986\u76D6\u5168\u90E8\u5DF2\u6CE8\u518C\u7AEF\u70B9\u53CA\u5176\u9274\u6743\u8981\u6C42\uFF08x-auth / x-permission\uFF09\u3002/api/* \u54CD\u5E94\u4E3A\u7EDF\u4E00 JSON \u4FE1\u5C01\uFF1B\u9010\u5B57\u6BB5\u5951\u7EA6\u89C1\u5404\u63D2\u4EF6 manifest\uFF08api.yaml\uFF09\u3002")
    },
    servers: [{ url: externalBase || "/" }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: t("\u5E73\u53F0\u4EE4\u724C\uFF08\u4EBA\u7C7B\u8D26\u53F7 POST /api/auth/login \u6362\u53D6\uFF0C\u6216\u673A\u5668\u51ED\u8BC1\u7B7E\u53D1\uFF09\uFF1B/mcp \u4E0E REST \u5171\u7528\u540C\u4E00\u5957\u4EE4\u724C")
        }
      },
      schemas: {
        OkEnvelope: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean", enum: [true] }, data: {} }
        },
        ErrorEnvelope: {
          type: "object",
          required: ["ok", "error"],
          properties: {
            ok: { type: "boolean", enum: [false] },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" } },
              additionalProperties: true
            }
          }
        }
      }
    }
  };
}
export {
  buildOpenApiDocument,
  toOpenApiPath
};
