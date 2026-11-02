import { defineTool } from "../../platform-core/dist/index.js";
import { t as translate } from "../../platform-i18n/dist/index.js";
const name = "iam-tools";
const inject = ["tools", "iam"];
function manageActorOf(args, exec) {
  const { _actor, ...rest } = args ?? {};
  const bridge = _actor ?? void 0;
  if (bridge && typeof bridge === "object") {
    return {
      actor: {
        ...typeof bridge.id === "string" && bridge.id ? { userId: bridge.id } : {},
        ...typeof bridge.orgId === "string" && bridge.orgId ? { orgId: bridge.orgId } : {},
        permissions: bridge.platformAdmin === true ? ["*"] : []
      },
      rest
    };
  }
  const principal = exec?.principal;
  return {
    actor: {
      ...principal?.userId ? { userId: principal.userId } : {},
      permissions: Array.isArray(principal?.permissions) ? [...principal.permissions] : []
    },
    rest
  };
}
function apply(ctx) {
  const t = ctx.tools;
  const scopedOrgIdsOf = (actor) => {
    if (actor.permissions.includes("*")) return null;
    const orgId = actor.orgId ?? (actor.userId ? ctx.iam.users().get(actor.userId)?.orgId : void 0);
    return orgId ? ctx.iam.orgSubtreeIds(orgId) : [];
  };
  t.register(defineTool({
    name: "iam_org_tree",
    description: "\u83B7\u53D6\u7EC4\u7EC7\u67B6\u6784\u6811\uFF08\u542B\u5404\u7EA7\u5B50\u7EC4\u7EC7\u4E0E\u4EBA\u6570\u7EDF\u8BA1\uFF09\u3002\u4EC5\u8FD4\u56DE\u8C03\u7528\u8005\u7EC4\u7EC7\u5B50\u6811\u5185\u7684\u90E8\u5206\u3002",
    permission: "iam.org.read",
    parameters: {},
    output: { type: "object", additionalProperties: true },
    async execute(args, exec) {
      const { actor } = manageActorOf(args, exec);
      const scope = scopedOrgIdsOf(actor);
      const decorate = (nodes) => nodes.map((node) => ({
        id: node.id,
        name: node.name,
        status: node.status,
        userCount: ctx.iam.users().find((user) => user.orgId === node.id).length,
        children: decorate(node.children)
      }));
      if (scope === null) return { tree: decorate(ctx.iam.orgTree()) };
      const rootId = scope[0];
      if (!rootId) return { tree: [] };
      const prune = (nodes) => nodes.filter((node) => scope.includes(node.id)).map((node) => ({ ...node, children: prune(node.children ?? []) }));
      return { tree: prune(ctx.iam.orgTree()) };
    }
  }));
  t.register(defineTool({
    name: "iam_org_create",
    description: "\u521B\u5EFA\u7EC4\u7EC7\uFF08\u9700 iam.org.write \u6743\u9650\uFF09\u3002parentId \u4E3A\u7A7A\u8868\u793A\u9876\u7EA7\u7EC4\u7EC7\u3002",
    permission: "iam.org.write",
    parameters: {
      name: { type: "string", required: true, description: "\u7EC4\u7EC7\u540D\u79F0" },
      parentId: { type: "string", description: "\u7236\u7EC4\u7EC7 ID" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args, exec) {
      const { actor, rest } = manageActorOf(args, exec);
      const org = ctx.iam.createOrg({ name: rest.name, parentId: rest.parentId ?? null }, actor);
      return { id: org.id, name: org.name };
    }
  }));
  t.register(defineTool({
    name: "iam_org_update",
    description: "\u4FEE\u6539\u7EC4\u7EC7\uFF1A\u91CD\u547D\u540D\u548C/\u6216\u8C03\u6574\u4E0A\u7EA7\u7EC4\u7EC7\uFF08\u9700 iam.org.write \u6743\u9650\uFF09\u3002name \u4E0E parentId \u81F3\u5C11\u63D0\u4F9B\u4E00\u4E2A\uFF1BparentId \u4F20\u7A7A\u5B57\u7B26\u4E32\u8868\u793A\u63D0\u5347\u4E3A\u9876\u7EA7\u7EC4\u7EC7\u3002",
    permission: "iam.org.write",
    parameters: {
      orgId: { type: "string", required: true, description: "\u7EC4\u7EC7 ID" },
      name: { type: "string", description: "\u65B0\u7EC4\u7EC7\u540D\u79F0" },
      parentId: { type: "string", description: "\u65B0\u7236\u7EC4\u7EC7 ID\uFF08\u4F20\u7A7A\u5B57\u7B26\u4E32\u8868\u793A\u63D0\u5347\u4E3A\u9876\u7EA7\u7EC4\u7EC7\uFF09" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args, exec) {
      const { actor, rest } = manageActorOf(args, exec);
      if (rest.name === void 0 && rest.parentId === void 0) throw new Error(translate("name \u4E0E parentId \u81F3\u5C11\u63D0\u4F9B\u4E00\u4E2A"));
      if (rest.name !== void 0) ctx.iam.renameOrg(rest.orgId, rest.name, actor);
      if (rest.parentId !== void 0) ctx.iam.moveOrg(rest.orgId, rest.parentId || null, actor);
      const org = ctx.iam.orgs().get(rest.orgId);
      return { id: org.id, name: org.name, parentId: org.parentId };
    }
  }));
  t.register(defineTool({
    name: "iam_user_list",
    description: "\u67E5\u8BE2\u8D26\u53F7\u5217\u8868\uFF0C\u53EF\u6309\u7EC4\u7EC7/\u72B6\u6001/\u5173\u952E\u5B57\u8FC7\u6EE4\u3002",
    permission: "iam.user.read",
    parameters: {
      orgId: { type: "string", description: "\u9650\u5B9A\u7EC4\u7EC7\uFF08\u542B\u5B50\u6811\uFF09" },
      status: { type: "string", enum: ["pending", "active", "frozen", "deactivated"], description: "\u72B6\u6001\u8FC7\u6EE4" },
      q: { type: "string", description: "\u59D3\u540D/\u7528\u6237\u540D\u5173\u952E\u5B57" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args, exec) {
      const { actor } = manageActorOf(args, exec);
      const scope = scopedOrgIdsOf(actor);
      const allow = scope === null ? null : new Set(scope);
      if (args.orgId && allow && !allow.has(String(args.orgId))) {
        throw new Error(translate("\u67E5\u8BE2\u7EC4\u7EC7\u8D85\u51FA\u8C03\u7528\u8005\u7684\u7EC4\u7EC7\u5B50\u6811\uFF08\u7EC4\u7EC7\u9694\u79BB\uFF09"));
      }
      const users = ctx.iam.users().find((user) => {
        if (args.status && user.status !== args.status) return false;
        if (args.q && !`${user.displayName}${user.username}`.includes(args.q)) return false;
        if (allow && !allow.has(user.orgId)) return false;
        if (args.orgId) {
          const orgScope = new Set(ctx.iam.orgSubtreeIds(String(args.orgId)));
          if (!orgScope.has(user.orgId)) return false;
        }
        return true;
      });
      return {
        total: users.length,
        users: users.map((user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          org: ctx.iam.orgs().get(user.orgId)?.name,
          title: user.title,
          status: user.status
        }))
      };
    }
  }));
  t.register(defineTool({
    name: "iam_user_create",
    description: "\u521B\u5EFA\u8D26\u53F7\u3002\u672A\u63D0\u4F9B password \u65F6\u751F\u6210\u968F\u673A\u521D\u59CB\u53E3\u4EE4\uFF0C\u4EC5\u5728\u8FD4\u56DE\u503C initialPassword \u4E2D\u51FA\u73B0\u4E00\u6B21\uFF0C\u8BF7\u5B89\u5168\u4F20\u8FBE\u7ED9\u672C\u4EBA\u3002",
    permission: "iam.user.write",
    parameters: {
      username: { type: "string", required: true, description: "\u767B\u5F55\u540D\uFF08\u5B57\u6BCD\u6570\u5B57\uFF09" },
      displayName: { type: "string", required: true, description: "\u59D3\u540D" },
      orgId: { type: "string", required: true, description: "\u6240\u5C5E\u7EC4\u7EC7 ID" },
      title: { type: "string", description: "\u804C\u4F4D" },
      roleIds: { type: "array", items: { type: "string" }, description: "\u89D2\u8272 ID \u5217\u8868" },
      password: { type: "string", description: "\u521D\u59CB\u53E3\u4EE4\uFF08\u7F3A\u7701\u5219\u968F\u673A\u751F\u6210\uFF0C\u4EC5\u8FD4\u56DE\u4E00\u6B21\uFF09" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args, exec) {
      const { actor, rest } = manageActorOf(args, exec);
      const { user, initialPassword } = ctx.iam.createUser({ ...rest, roleIds: rest.roleIds }, actor);
      return { id: user.id, username: user.username, status: user.status, ...initialPassword ? { initialPassword } : {} };
    }
  }));
  t.register(defineTool({
    name: "iam_user_reset_password",
    description: "\u91CD\u7F6E\u8D26\u53F7\u4E3A\u968F\u673A\u521D\u59CB\u53E3\u4EE4\uFF08\u4EC5\u8FD4\u56DE\u4E00\u6B21\uFF1B\u8BF7\u7B2C\u4E00\u65F6\u95F4\u4F20\u8FBE\u7ED9\u672C\u4EBA\uFF09\u3002",
    permission: "iam.user.write",
    parameters: {
      userId: { type: "string", required: true, description: "\u8D26\u53F7 ID" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args, exec) {
      const { actor, rest } = manageActorOf(args, exec);
      const { user, initialPassword } = ctx.iam.resetPassword(rest.userId, void 0, actor);
      return { id: user.id, username: user.username, initialPassword };
    }
  }));
  t.register(defineTool({
    name: "iam_user_freeze",
    description: "\u51BB\u7ED3\u8D26\u53F7\uFF08L4 \u9AD8\u5371\uFF1A\u5FC5\u987B\u586B\u5199 reason\uFF0C\u5C06\u8054\u52A8\u540A\u9500\u540D\u4E0B\u5168\u90E8\u4EE4\u724C\uFF09\u3002",
    permission: "iam.user.freeze",
    parameters: {
      userId: { type: "string", required: true, description: "\u8D26\u53F7 ID" },
      reason: { type: "string", required: true, description: "\u51BB\u7ED3\u539F\u56E0\uFF08\u5BA1\u8BA1\u7559\u75D5\uFF09" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args, exec) {
      const { actor, rest } = manageActorOf(args, exec);
      const user = ctx.iam.freezeUser(rest.userId, rest.reason, actor);
      return { id: user.id, status: user.status, note: translate("\u5DF2\u53D1\u5E03 iam.user.frozen \u4E8B\u4EF6\uFF0C\u8BA4\u8BC1\u4E2D\u5FC3\u5C06\u540A\u9500\u5176\u4EE4\u724C") };
    }
  }));
  t.register(defineTool({
    name: "iam_role_list",
    description: "\u5217\u51FA\u5168\u90E8\u89D2\u8272\u4E0E\u6743\u9650\u70B9\u3002",
    permission: "iam.org.read",
    parameters: {},
    output: { type: "object", additionalProperties: true },
    async execute() {
      return {
        roles: ctx.iam.roles().all().map((role) => ({ id: role.id, code: role.code, name: role.name, builtin: role.builtin, permissions: role.permissions }))
      };
    }
  }));
  t.register(defineTool({
    name: "iam_sync_run",
    description: "\u89E6\u53D1\u4E09\u65B9\u901A\u8BAF\u5F55\u5168\u91CF\u540C\u6B65\uFF08\u652F\u6301\u591A\u4E3B\u4F53\uFF1A\u540C\u4E00\u5E73\u53F0\u53EF\u63A5\u5165\u591A\u5BB6\u4F01\u4E1A\uFF0C\u4F20 configId \u6307\u5B9A\u4E3B\u4F53\u5B9E\u4F8B\uFF0C\u7F3A\u7701\u6309 provider \u53D6\u7B2C\u4E00\u6761\uFF09\u3002",
    permission: "iam.connector.write",
    parameters: {
      provider: { type: "string", enum: ["dingtalk"], description: "\u8FDE\u63A5\u5668\uFF08\u4E0E configId \u81F3\u5C11\u63D0\u4F9B\u4E00\u4E2A\uFF1B\u7F3A\u7701\u6309 provider \u53D6\u7B2C\u4E00\u6761\u914D\u7F6E\uFF09" },
      configId: { type: "string", description: "\u63A5\u5165\u914D\u7F6E\u5B9E\u4F8B ID\uFF08\u591A\u4E3B\u4F53\u65F6\u6307\u5B9A\uFF0C\u4F18\u5148\u4E8E provider\uFF09" },
      actor: { type: "string", description: "\u64CD\u4F5C\u4EBA\uFF08\u5BA1\u8BA1\u7528\uFF09" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args) {
      const target = args.configId ?? args.provider;
      if (!target) throw new Error(translate("provider \u4E0E configId \u81F3\u5C11\u63D0\u4F9B\u4E00\u4E2A"));
      return await ctx.iam.syncConnector(target, args.actor ?? "agent");
    }
  }));
  t.register(defineTool({
    name: "iam_conflict_list",
    description: "\u67E5\u770B\u4E09\u65B9\u540C\u6B65\u51B2\u7A81\u961F\u5217\uFF08pending \u672A\u5904\u7406\uFF09\u3002",
    permission: "iam.org.read",
    parameters: {
      status: { type: "string", enum: ["pending", "resolved"], description: "\u9ED8\u8BA4 pending" }
    },
    output: { type: "object", additionalProperties: true },
    async execute(args) {
      const conflicts = ctx.iam.conflicts().find((item) => item.status === (args.status ?? "pending"));
      return { total: conflicts.length, conflicts };
    }
  }));
}
export {
  apply,
  inject,
  name
};
