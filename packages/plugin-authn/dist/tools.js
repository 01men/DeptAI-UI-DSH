import { defineTool } from "../../platform-core/dist/index.js";
import { t as translate } from "../../platform-i18n/dist/index.js";
const name = "authn-tools";
const inject = ["tools", "authn"];
function apply(ctx) {
  const t = ctx.tools;
  t.register(defineTool({
    name: "authn_token_issue",
    description: "\u4E3A\u4E3B\u4F53\u7B7E\u53D1\u77ED\u671F\u8BBF\u95EE\u4EE4\u724C\uFF08\u9ED8\u8BA4 2 \u5C0F\u65F6\uFF09\u3002\u4EBA / \u673A\u5668\u8EAB\u4EFD\u5747\u53EF\u3002",
    permission: "authn.token.issue",
    parameters: {
      principalId: { type: "string", required: true, description: "\u4E3B\u4F53 ID\uFF08pri_ \u524D\u7F00\uFF09" },
      ttlHours: { type: "number", description: "\u6709\u6548\u671F\uFF08\u5C0F\u65F6\uFF09\uFF0C\u9ED8\u8BA4 2" },
      reason: { type: "string", description: "\u7B7E\u53D1\u539F\u56E0\uFF08\u5BA1\u8BA1\uFF09" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args) {
      const { token, record } = ctx.authn.issueToken(args.principalId, {
        kind: "access",
        ttlHours: args.ttlHours,
        scopes: ctx.authn.principals().get(args.principalId)?.scopes ?? [],
        issuedBy: `agent:${args.reason ?? "tool"}`
      });
      return { token, jti: record.jti, expiresAt: record.expiresAt };
    }
  }));
  t.register(defineTool({
    name: "authn_token_revoke",
    description: "\u540A\u9500\u4EE4\u724C\uFF08L4 \u9AD8\u5371\uFF0C\u9700 reason\uFF09\u3002\u652F\u6301\u6309 jti \u540A\u9500\u5355\u4E2A\u4EE4\u724C\u3002",
    permission: "authn.token.revoke",
    parameters: {
      jti: { type: "string", required: true, description: "\u4EE4\u724C jti" },
      reason: { type: "string", required: true, description: "\u540A\u9500\u539F\u56E0" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args) {
      const record = ctx.authn.revokeToken(args.jti, args.reason);
      return { jti: record.jti, revokedAt: record.revokedAt };
    }
  }));
  t.register(defineTool({
    name: "authn_token_list",
    description: "\u67E5\u8BE2\u4E3B\u4F53\u4EE4\u724C\u5217\u8868\uFF08\u542B\u540A\u9500\u72B6\u6001\uFF09\u3002",
    permission: "authn.principal.read",
    parameters: {
      principalId: { type: "string", description: "\u6309\u4E3B\u4F53\u8FC7\u6EE4" },
      activeOnly: { type: "boolean", description: "\u4EC5\u672A\u540A\u9500" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args) {
      const tokens = ctx.authn.tokens().find((token) => {
        if (args.principalId && token.principalId !== args.principalId) return false;
        if (args.activeOnly && token.revokedAt) return false;
        return true;
      });
      return {
        total: tokens.length,
        tokens: tokens.map((token) => ({
          jti: token.jti,
          kind: token.kind,
          issuedAt: token.issuedAt,
          expiresAt: token.expiresAt,
          revokedAt: token.revokedAt ?? null,
          issuedBy: token.issuedBy,
          ...token.label !== void 0 ? { label: token.label } : {}
        }))
      };
    }
  }));
  t.register(defineTool({
    name: "authn_credential_create",
    description: "\u4E3A Agent/\u5E94\u7528/\u5916\u90E8\u7CFB\u7EDF\u521B\u5EFA\u673A\u5668\u8EAB\u4EFD\u51ED\u8BC1\uFF08Client Credentials\uFF0C\u5BC6\u94A5\u4EC5\u8FD4\u56DE\u4E00\u6B21\uFF09\u3002",
    permission: "authn.principal.write",
    parameters: {
      name: { type: "string", required: true, description: "\u4E3B\u4F53\u540D\u79F0" },
      refType: { type: "string", enum: ["agent", "app", "external"], description: "\u7ED1\u5B9A\u8D44\u6E90\u7C7B\u578B" },
      refId: { type: "string", description: "\u7ED1\u5B9A\u8D44\u6E90 ID" },
      scopes: { type: "array", items: { type: "string" }, description: '\u6743\u9650\u70B9\u5217\u8868\uFF08\u987B\u4E3A\u6743\u9650\u76EE\u5F55\u4E2D\u7684\u70B9\uFF0C\u6216\u4EC5 ["*"]\uFF09' }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args) {
      const created = ctx.authn.createMachineCredential({
        name: args.name,
        refType: args.refType,
        refId: args.refId,
        scopes: args.scopes ?? ["skill.read"]
      });
      return {
        principalId: created.principal.id,
        clientId: created.clientId,
        clientSecret: created.clientSecret,
        note: translate("clientSecret \u4EC5\u6B64\u4E00\u6B21\u8FD4\u56DE\uFF0C\u8BF7\u59A5\u5584\u4FDD\u7BA1")
      };
    }
  }));
  t.register(defineTool({
    name: "authn_credential_scopes",
    description: "\u8C03\u6574\u673A\u5668\u8EAB\u4EFD\u6743\u9650\u8303\u56F4\uFF08\u6536\u6743/\u6269\u6743\uFF09\u3002\u8C03\u6574\u540E\u5B58\u91CF\u4EE4\u724C\u5168\u90E8\u8054\u52A8\u540A\u9500\uFF0C\u673A\u5668\u4FA7\u9700\u91CD\u65B0\u6362\u724C\u3002",
    permission: "authn.principal.write",
    parameters: {
      principalId: { type: "string", required: true, description: "\u4E3B\u4F53 ID\uFF08pri_ \u524D\u7F00\uFF09" },
      scopes: { type: "array", items: { type: "string" }, required: true, description: '\u65B0\u6743\u9650\u70B9\u5217\u8868\uFF08\u987B\u5168\u90E8\u547D\u4E2D\u6743\u9650\u76EE\u5F55\uFF0C\u6216\u6070\u4E3A ["*"]\uFF09' }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args) {
      const principal = ctx.authn.updateMachineScopes(args.principalId, { scopes: args.scopes });
      const { clientSecretHash, ...safe } = principal;
      void clientSecretHash;
      return { ...safe, note: translate("\u5B58\u91CF\u4EE4\u724C\u5DF2\u5168\u90E8\u540A\u9500\uFF0C\u673A\u5668\u4FA7\u9700\u7528\u51ED\u8BC1\u91CD\u65B0\u6362\u724C") };
    }
  }));
  t.register(defineTool({
    name: "authn_credential_rotate",
    description: "\u8F6E\u6362\u673A\u5668\u51ED\u8BC1\u5BC6\u94A5\uFF08clientSecret\uFF09\u3002clientId \u4E0D\u53D8\uFF0C\u65E7\u503C\u7ACB\u5373\u5931\u6548\uFF0C\u5B58\u91CF\u4EE4\u724C\u5168\u90E8\u540A\u9500\uFF1B\u65B0 secret \u4EC5\u6B64\u4E00\u6B21\u8FD4\u56DE\u3002\u51ED\u8BC1\u4E22\u5931/\u6CC4\u9732\u7684\u8865\u6551\u624B\u6BB5\uFF0C\u65E0\u9700\u91CD\u65B0\u6CE8\u518C Agent\u3002",
    permission: "authn.principal.write",
    parameters: {
      principalId: { type: "string", required: true, description: "\u4E3B\u4F53 ID\uFF08pri_ \u524D\u7F00\uFF09" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args) {
      const rotated = ctx.authn.rotateMachineCredential(args.principalId);
      return {
        clientId: rotated.principal.clientId,
        clientSecret: rotated.clientSecret,
        note: translate("\u65B0 clientSecret \u4EC5\u6B64\u4E00\u6B21\u8FD4\u56DE\uFF0C\u65E7\u503C\u7ACB\u5373\u5931\u6548\uFF0C\u5B58\u91CF\u4EE4\u724C\u5DF2\u5168\u90E8\u540A\u9500")
      };
    }
  }));
}
export {
  apply,
  inject,
  name
};
