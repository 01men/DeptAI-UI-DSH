function authMethodOf(issuedBy) {
  const source = issuedBy ?? "";
  if (source === "demo") return "demo";
  if (source.startsWith("delegate:") || source.startsWith("obo:")) return "token-exchange";
  if (source === "client_credentials") return "client-credentials";
  if (source.startsWith("entry-ticket:")) return "entry-ticket";
  if (source.startsWith("sso")) return "oidc-code";
  if (source.startsWith("password:") || source.startsWith("refresh-")) return "session";
  return "client-credentials";
}
function kindOfRefType(refType) {
  if (refType === "user") return "user";
  if (refType === "agent") return "agent";
  if (refType === "app") return "app";
  return "platform-service";
}
function kindOfPrincipal(type, refType) {
  if (type === "human") return "human";
  if (refType === "agent") return "agent";
  if (refType === "app") return "app";
  return "platform-service";
}
async function resolveUnifiedPrincipal(vp, lookups, options = {}) {
  const self = await lookups.principalOf(vp.principal.id).catch(() => null);
  const kind = kindOfPrincipal(vp.principal.type, vp.principal.refType);
  const actChain = [];
  for (const entry of vp.actChain) {
    if (entry.type === "human") {
      actChain.push({ kind: "user", id: entry.principalId, name: entry.name });
      continue;
    }
    const ref = await lookups.principalOf(entry.principalId).catch(() => null);
    if (!ref) {
      actChain.push({ kind: "platform-service", id: entry.principalId });
      continue;
    }
    actChain.push({
      kind: kindOfRefType(ref.refType),
      id: entry.principalId,
      name: entry.name,
      ...ref.refId !== void 0 ? { refId: ref.refId } : {}
    });
  }
  const ids = {};
  if (kind === "human" && vp.principal.refId) ids.userId = vp.principal.refId;
  if (kind === "agent" && vp.principal.refId) ids.agentId = vp.principal.refId;
  if (kind === "app" && vp.principal.refId) ids.appId = vp.principal.refId;
  let org = null;
  if (kind === "human" || kind === "agent" || kind === "app") {
    const id = vp.principal.refId ?? vp.principal.id;
    org = await lookups.orgOf({ kind, id }).catch(() => null);
  }
  let subjectUserId;
  if (vp.principal.type === "human") {
    subjectUserId = vp.principal.refId;
  } else {
    const firstHuman = actChain.find((node) => node.kind === "user");
    if (firstHuman) {
      const ref = await lookups.principalOf(firstHuman.id).catch(() => null);
      subjectUserId = ref?.refId;
    }
  }
  return {
    principalId: vp.principal.id,
    kind,
    ...ids,
    ...org?.orgId !== void 0 ? { orgId: org.orgId } : {},
    ...org?.tenantId !== void 0 ? { tenantId: org.tenantId } : {},
    authMethod: options.authMethod ?? authMethodOf(vp.token.issuedBy),
    tokenId: vp.token.jti,
    scopes: [...vp.scopes],
    ...subjectUserId !== void 0 ? { subjectUserId } : {},
    actChain,
    ...vp.principal.refType !== void 0 ? { refType: vp.principal.refType } : {},
    ...vp.principal.refId !== void 0 ? { refId: vp.principal.refId } : {},
    name: self?.name ?? vp.principal.name,
    permissions: [...vp.scopes]
  };
}
function toCallerInfo(p) {
  return {
    kind: p.kind === "human" ? "human" : "machine",
    principalId: p.principalId,
    ...p.kind === "human" && p.userId !== void 0 ? { userId: p.userId } : {},
    ...p.kind !== "human" ? { refType: p.refType, refId: p.refId } : {},
    name: p.name,
    permissions: p.permissions,
    actChain: p.actChain.map((node) => ({
      principalId: node.id,
      ...node.name !== void 0 ? { name: node.name } : { name: node.id },
      type: node.kind === "user" ? "human" : "machine"
    }))
  };
}
function toInvokeCaller(p) {
  const type = p.kind === "human" ? "user" : p.kind === "agent" ? "agent" : "app";
  const id = p.userId ?? p.agentId ?? p.appId ?? p.principalId;
  const delegated = isDelegated(p);
  const subjects = [{ type, id }];
  for (const node of p.actChain) {
    if (node.kind === "user") {
      if (!subjects.some((item) => item.type === "user")) subjects.push({ type: "user", id: node.refId ?? node.id });
      continue;
    }
    if (node.kind === "agent" || node.kind === "app") {
      const actorId = node.refId ?? node.id;
      if (!subjects.some((item) => item.type === node.kind && item.id === actorId)) {
        subjects.push({ type: node.kind, id: actorId });
      }
    }
  }
  return {
    type,
    id,
    name: p.name,
    ...delegated && p.actChain.length > 0 ? { onBehalfOf: p.actChain[0].name ?? p.actChain[0].id } : {},
    ...delegated ? { actChain: p.actChain.map((node) => ({ name: node.name ?? node.id, type: node.kind === "user" ? "human" : "machine" })) } : {},
    subjects
  };
}
function toWorkCallerRef(p) {
  return {
    kind: p.kind === "human" ? "human" : "machine",
    principalId: p.principalId,
    ...p.userId !== void 0 ? { userId: p.userId } : {},
    ...p.kind !== "human" && p.refType !== void 0 ? { refType: p.refType } : {},
    ...p.kind !== "human" && p.refId !== void 0 ? { refId: p.refId } : {},
    ...p.name ? { name: p.name } : {}
  };
}
function isDelegated(p) {
  return p.actChain.length > 0;
}
function humanDelegatorOf(p) {
  if (p.actChain.length === 0) return null;
  const firstHuman = p.actChain.find((node) => node.kind === "user");
  if (firstHuman) {
    if (p.subjectUserId === void 0) return null;
    return { userId: p.subjectUserId, ...firstHuman.name !== void 0 ? { name: firstHuman.name } : {} };
  }
  if (p.kind === "human" && p.subjectUserId !== void 0) {
    return { userId: p.subjectUserId, name: p.name };
  }
  return null;
}
function lookupsFromHost(host) {
  return {
    async principalOf(id) {
      return host.principalsGet(id) ?? null;
    },
    async orgOf(ref) {
      if (ref.kind === "user") {
        const user = host.iamUserGet(ref.id);
        if (!user) return null;
        return { orgId: user.orgId, tenantId: host.tenantOfOrg(user.orgId) };
      }
      const resource = host.resourceGet(ref.kind, ref.id);
      if (!resource?.orgId) return null;
      return { orgId: resource.orgId, tenantId: host.tenantOfOrg(resource.orgId) };
    }
  };
}
function unifiedFromCaller(info) {
  return {
    principalId: info.principalId,
    kind: info.kind === "human" ? "human" : "platform-service",
    ...info.userId !== void 0 ? { userId: info.userId } : {},
    ...info.refType !== void 0 ? { refType: info.refType } : {},
    ...info.refId !== void 0 ? { refId: info.refId } : {},
    authMethod: "client-credentials",
    tokenId: "",
    scopes: [...info.permissions],
    actChain: info.actChain.map((entry) => ({
      kind: entry.type === "human" ? "user" : "platform-service",
      id: entry.principalId ?? entry.name,
      name: entry.name
    })),
    name: info.name,
    permissions: [...info.permissions]
  };
}
export {
  authMethodOf,
  humanDelegatorOf,
  isDelegated,
  lookupsFromHost,
  resolveUnifiedPrincipal,
  toCallerInfo,
  toInvokeCaller,
  toWorkCallerRef,
  unifiedFromCaller
};
