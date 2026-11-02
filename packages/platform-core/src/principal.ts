/**
 * 统一 Principal Resolver（MCP 治理契约 §2，2026-10-22）。
 *
 * 单点收敛「令牌验证结果（VerifiedPrincipal）→ 各消费面的调用者投影」的纯映射：
 *   - console 鉴权中间件（唯一权威写入点）经 resolveUnifiedPrincipal 组装
 *     exchange.principal = CallerInfo 兼容超集 + unified 字段；
 *   - bridge /mcp、nas OBO、a2a actChainOf、mcp invoke 一律消费 unified，
 *     禁止从请求参数/header 声明身份（契约 §2 红线）。
 *
 * 依赖方向纪律：platform-core 不反向依赖业务插件——plugin-authn 的
 * VerifiedPrincipal 以最小结构类型（VerifiedPrincipalShape）注入，结构化满足即可；
 * 组织/资源反查经 PrincipalLookups 异步端口由宿主（console）装配。
 */
import type { CallerInfo } from './rest-gate.ts'
import type { WorkCallerRef } from './workforce-port.ts'

// ---------------------------------------------------------------------------
// 契约类型（docs/internal/mcp-governance-20261022-contracts.md §2）
// ---------------------------------------------------------------------------

/** act 链节点（authn ActEntry + principal 反查后的统一投影；id=authn principalId 原值）。 */
export interface ActChainNode { kind: 'user' | 'agent' | 'app' | 'platform-service'; id: string; name?: string; refId?: string }

/** 认证方式（由令牌 issuedBy 前缀推导，见 authMethodOf）。 */
export type UnifiedAuthMethod = 'oidc-code' | 'client-credentials' | 'token-exchange' | 'session' | 'entry-ticket' | 'demo'

/** 统一主体：各消费面身份事实的唯一来源。 */
export interface UnifiedPrincipal {
  principalId: string
  kind: 'human' | 'agent' | 'app' | 'platform-service'
  userId?: string; agentId?: string; appId?: string
  orgId?: string; tenantId?: string
  authMethod: UnifiedAuthMethod
  tokenId: string                    // = token.jti
  scopes: string[]
  /** 代理场景的实际用户（act 链最底 human 条目对应的 userId） */
  subjectUserId?: string
  actChain: ActChainNode[]           // 由 authn ActEntry[] + principal 反查映射
  refType?: 'user' | 'agent' | 'app' | 'external'
  refId?: string
  name: string
  permissions: string[]              // 保持 CallerInfo.permissions 语义（verify 的实时 scopes）
}

/** 身份反查端口（宿主装配：console 用 authn.principals / iam / resourceCore 实现）。 */
export interface PrincipalLookups {
  principalOf(id: string): Promise<{ refType?: string; refId?: string; name?: string; type: string } | null>
  orgOf(ref: { kind: 'user' | 'agent' | 'app'; id: string }): Promise<{ orgId?: string; tenantId?: string } | null>
}

/** plugin-authn VerifiedPrincipal 的最小结构投影（避免 platform-core 反向依赖业务插件）。 */
export interface VerifiedPrincipalShape {
  principal: {
    id: string
    type: 'human' | 'machine'
    refType?: 'user' | 'agent' | 'app' | 'external'
    refId?: string
    name: string
  }
  token: { jti: string; issuedBy?: string }
  scopes: string[]
  actChain: Array<{ principalId: string; name: string; type: 'human' | 'machine' }>
}

// ---------------------------------------------------------------------------
// 纯映射实现
// ---------------------------------------------------------------------------

/**
 * 认证方式推导：按 issueToken 调用点的 issuedBy 前缀归纳——
 *   obo: / delegate: → token-exchange；client_credentials → client-credentials；
 *   entry-ticket: → entry-ticket；sso*（OIDC 授权码链路）→ oidc-code；
 *   password: / refresh-*（会话续签）→ session；demo（演示态注入）→ demo；
 * 推导不出（如 console 手工签发）缺省 client-credentials（契约口径）。
 */
export function authMethodOf(issuedBy: string | undefined): UnifiedAuthMethod {
  const source = issuedBy ?? ''
  if (source === 'demo') return 'demo'
  if (source.startsWith('delegate:') || source.startsWith('obo:')) return 'token-exchange'
  if (source === 'client_credentials') return 'client-credentials'
  if (source.startsWith('entry-ticket:')) return 'entry-ticket'
  if (source.startsWith('sso')) return 'oidc-code'
  if (source.startsWith('password:') || source.startsWith('refresh-')) return 'session'
  return 'client-credentials'
}

/** ActEntry.type/machine refType → 统一 kind（契约映射口径）。 */
function kindOfRefType(refType: string | undefined): 'user' | 'agent' | 'app' | 'platform-service' {
  if (refType === 'user') return 'user'
  if (refType === 'agent') return 'agent'
  if (refType === 'app') return 'app'
  return 'platform-service' // external / 缺失 / 反查失败
}

/** 顶层主体 → 统一 kind（human 之外都算机器面：agent/app 有资源归属，其余为平台服务主体）。 */
function kindOfPrincipal(type: string, refType: string | undefined): UnifiedPrincipal['kind'] {
  if (type === 'human') return 'human'
  if (refType === 'agent') return 'agent'
  if (refType === 'app') return 'app'
  return 'platform-service'
}

/**
 * 解析统一主体：VerifiedPrincipal + 身份反查 → UnifiedPrincipal。
 * 反查失败不阻断（fail-safe）：对应字段缺省，绝不让解析错误放大或拒绝既有鉴权结论。
 */
export async function resolveUnifiedPrincipal(
  vp: VerifiedPrincipalShape,
  lookups: PrincipalLookups,
  options: { authMethod?: UnifiedAuthMethod } = {},
): Promise<UnifiedPrincipal> {
  const self = await lookups.principalOf(vp.principal.id).catch(() => null)
  const kind = kindOfPrincipal(vp.principal.type, vp.principal.refType)

  // act 链映射：human → user；machine 经 principalOf 反查 refType（user/agent/app/external），
  // 反查失败给 kind='platform-service' 且不带 id 之外的字段（契约口径）。
  // 数组首位为发起人（issueOnBehalfOf 语义：父链 + 父主体，链首即最初人类）。
  const actChain: ActChainNode[] = []
  for (const entry of vp.actChain) {
    if (entry.type === 'human') {
      actChain.push({ kind: 'user', id: entry.principalId, name: entry.name })
      continue
    }
    const ref = await lookups.principalOf(entry.principalId).catch(() => null)
    if (!ref) {
      // 反查失败：仅保留 id，不带其余字段
      actChain.push({ kind: 'platform-service', id: entry.principalId })
      continue
    }
    // refId = 该主体绑定的资源 id（agent/app 资源 id / userId）——权限组主体匹配按资源 id，
    // 故随节点透出（id 保持 authn principalId 原值，两种标识并存不混淆）。
    actChain.push({
      kind: kindOfRefType(ref.refType),
      id: entry.principalId,
      name: entry.name,
      ...(ref.refId !== undefined ? { refId: ref.refId } : {}),
    })
  }

  // 顶层主体 id 字段：human → userId，agent/app → 各自资源 id
  const ids: Pick<UnifiedPrincipal, 'userId' | 'agentId' | 'appId'> = {}
  if (kind === 'human' && vp.principal.refId) ids.userId = vp.principal.refId
  if (kind === 'agent' && vp.principal.refId) ids.agentId = vp.principal.refId
  if (kind === 'app' && vp.principal.refId) ids.appId = vp.principal.refId

  // 组织归属：human 按 userId、agent/app 按资源 id 反查（platform-service 不反查）
  let org: { orgId?: string; tenantId?: string } | null = null
  if (kind === 'human' || kind === 'agent' || kind === 'app') {
    const id = vp.principal.refId ?? vp.principal.id
    org = await lookups.orgOf({ kind, id } as { kind: 'user' | 'agent' | 'app'; id: string }).catch(() => null)
  }

  // subjectUserId：act 链最底（数组首位为发起人，issueOnBehalfOf 语义：父链 + 父主体）human 条目的
  // refId；主体本身是 human 时即自身 refId（机器凭证代用户换取的委托令牌 sub=该用户）。
  let subjectUserId: string | undefined
  if (vp.principal.type === 'human') {
    subjectUserId = vp.principal.refId
  } else {
    const firstHuman = actChain.find((node) => node.kind === 'user')
    if (firstHuman) {
      const ref = await lookups.principalOf(firstHuman.id).catch(() => null)
      subjectUserId = ref?.refId
    }
  }

  return {
    principalId: vp.principal.id,
    kind,
    ...ids,
    ...(org?.orgId !== undefined ? { orgId: org.orgId } : {}),
    ...(org?.tenantId !== undefined ? { tenantId: org.tenantId } : {}),
    authMethod: options.authMethod ?? authMethodOf(vp.token.issuedBy),
    tokenId: vp.token.jti,
    scopes: [...vp.scopes],
    ...(subjectUserId !== undefined ? { subjectUserId } : {}),
    actChain,
    ...(vp.principal.refType !== undefined ? { refType: vp.principal.refType } : {}),
    ...(vp.principal.refId !== undefined ? { refId: vp.principal.refId } : {}),
    name: self?.name ?? vp.principal.name,
    permissions: [...vp.scopes],
  }
}

/**
 * 统一主体 → CallerInfo（向后兼容投影，字段与 console 鉴权中间件既有产物逐字等价）：
 *   kind：human 之外都算 machine；actChain 投影 {principalId,name,type}（type 回投 human|machine，
 *   与旧 ActEntry 形态一致，审计链路零感知）；permissions=unified.permissions（verify 实时 scopes）。
 */
export function toCallerInfo(p: UnifiedPrincipal): CallerInfo {
  return {
    kind: p.kind === 'human' ? 'human' : 'machine',
    principalId: p.principalId,
    ...(p.kind === 'human' && p.userId !== undefined ? { userId: p.userId } : {}),
    ...(p.kind !== 'human' ? { refType: p.refType, refId: p.refId } : {}),
    name: p.name,
    permissions: p.permissions,
    actChain: p.actChain.map((node) => ({
      principalId: node.id,
      ...(node.name !== undefined ? { name: node.name } : { name: node.id }),
      type: node.kind === 'user' ? 'human' : 'machine',
    })),
  } as CallerInfo
}

/**
 * invoke 面调用者引用（与 plugin-mcp resolveMcpCaller 同口径，W2-T3 起统一消费）。
 *
 * subjects（additive，W4 安全审计 P0-3）：**权限组可匹配的主体集合**——
 * 主体自身（sub 侧：人/agent/app）+ 委托链上出现的 app/agent 演员。
 * 委托语义：User → App/Agent → MCP 时，真正执行动作的是链上的 agent/app，
 * 授予它的权限组必须对其生效；否则 Agent 身份永远匹配不到 agent 主体权限组，
 * 标准接入路径（Agent 用自身凭证换牌）将静默拿到空工具集。
 */
export function toInvokeCaller(p: UnifiedPrincipal): {
  type: 'user' | 'agent' | 'app'; id: string; name: string
  onBehalfOf?: string; actChain?: Array<{ name: string; type: string }>
  subjects?: Array<{ type: 'user' | 'agent' | 'app'; id: string }>
} {
  const type = p.kind === 'human' ? 'user' : p.kind === 'agent' ? 'agent' : 'app'
  const id = p.userId ?? p.agentId ?? p.appId ?? p.principalId
  const delegated = isDelegated(p)
  const subjects: Array<{ type: 'user' | 'agent' | 'app'; id: string }> = [{ type, id }]
  for (const node of p.actChain) {
    if (node.kind === 'user') {
      // 链上真人：主体侧已是本人时避免重复；代用户委托时本人即主体
      if (!subjects.some((item) => item.type === 'user')) subjects.push({ type: 'user', id: node.refId ?? node.id })
      continue
    }
    if (node.kind === 'agent' || node.kind === 'app') {
      // 权限组主体按资源 id 匹配（refId 优先；反查失败回落 principalId）
      const actorId = node.refId ?? node.id
      if (!subjects.some((item) => item.type === node.kind && item.id === actorId)) {
        subjects.push({ type: node.kind, id: actorId })
      }
    }
  }
  return {
    type,
    id,
    name: p.name,
    ...(delegated && p.actChain.length > 0 ? { onBehalfOf: p.actChain[0]!.name ?? p.actChain[0]!.id } : {}),
    ...(delegated ? { actChain: p.actChain.map((node) => ({ name: node.name ?? node.id, type: node.kind === 'user' ? 'human' : 'machine' })) } : {}),
    subjects,
  }
}

/** 工作策略窄端口调用者引用（WorkCallerRef；rest-gate.workCallerOf 委托本实现）。 */
export function toWorkCallerRef(p: UnifiedPrincipal): WorkCallerRef {
  return {
    kind: p.kind === 'human' ? 'human' : 'machine',
    principalId: p.principalId,
    ...(p.userId !== undefined ? { userId: p.userId } : {}),
    ...(p.kind !== 'human' && p.refType !== undefined ? { refType: p.refType } : {}),
    ...(p.kind !== 'human' && p.refId !== undefined ? { refId: p.refId } : {}),
    ...(p.name ? { name: p.name } : {}),
  }
}

/**
 * 是否委托场景：act 链非空即代理（普通会话 act 链为空；OBO/委托令牌必有链）。
 */
export function isDelegated(p: UnifiedPrincipal): boolean {
  return p.actChain.length > 0
}

/**
 * 委托链真实发起人（act 链最底 human 条目，数组首位为发起人）：
 *   - 机器主体：链内首个 user 条目（subjectUserId 缺失=反查失败，fail-safe 返回 null）；
 *   - 人类主体带链（机器凭证代其换取的委托令牌 sub=该用户）：链内无 user 条目时即主体本人；
 *   - 人类主体无链（普通会话）：null（无委托，消费方回落既有事实源）。
 */
export function humanDelegatorOf(p: UnifiedPrincipal): { userId: string; name?: string } | null {
  if (p.actChain.length === 0) return null
  const firstHuman = p.actChain.find((node) => node.kind === 'user')
  if (firstHuman) {
    if (p.subjectUserId === undefined) return null
    return { userId: p.subjectUserId, ...(firstHuman.name !== undefined ? { name: firstHuman.name } : {}) }
  }
  if (p.kind === 'human' && p.subjectUserId !== undefined) {
    return { userId: p.subjectUserId, name: p.name }
  }
  return null
}

// ---------------------------------------------------------------------------
// 宿主装配辅助（console 鉴权中间件 / bridge /mcp 共用，收敛反查接线）
// ---------------------------------------------------------------------------

/** 结构化宿主：console 既有服务按形状注入（platform-core 不感知具体插件）。 */
export interface PrincipalLookupHost {
  /** authn.principals().get(id) */
  principalsGet(id: string): { refType?: string; refId?: string; name?: string; type: string } | undefined
  /** iam.users().get(id) */
  iamUserGet(id: string): { orgId?: string } | undefined
  /** resourceCore.get(kind, id) */
  resourceGet(kind: 'agent' | 'app', id: string): { orgId?: string } | undefined
  /** iam.tenantOfOrg(orgId) */
  tenantOfOrg(orgId: string): string | undefined
}

/** 由结构化宿主装配标准反查端口（console index.ts 与 bridge.ts 共用，避免接线重复）。 */
export function lookupsFromHost(host: PrincipalLookupHost): PrincipalLookups {
  return {
    async principalOf(id) {
      return host.principalsGet(id) ?? null
    },
    async orgOf(ref) {
      if (ref.kind === 'user') {
        const user = host.iamUserGet(ref.id)
        if (!user) return null
        return { orgId: user.orgId, tenantId: host.tenantOfOrg(user.orgId) }
      }
      const resource = host.resourceGet(ref.kind, ref.id)
      if (!resource?.orgId) return null
      return { orgId: resource.orgId, tenantId: host.tenantOfOrg(resource.orgId) }
    },
  }
}

/**
 * CallerInfo（console 既有产物）→ UnifiedPrincipal 的最小回投影。
 * 仅供 rest-gate.workCallerOf 委托 toWorkCallerRef 时做形状对齐（unified 专属字段缺席不参与映射）。
 */
export function unifiedFromCaller(info: CallerInfo): UnifiedPrincipal {
  return {
    principalId: info.principalId,
    kind: info.kind === 'human' ? 'human' : 'platform-service',
    ...(info.userId !== undefined ? { userId: info.userId } : {}),
    ...(info.refType !== undefined ? { refType: info.refType as UnifiedPrincipal['refType'] } : {}),
    ...(info.refId !== undefined ? { refId: info.refId } : {}),
    authMethod: 'client-credentials',
    tokenId: '',
    scopes: [...info.permissions],
    actChain: info.actChain.map((entry) => ({
      kind: entry.type === 'human' ? 'user' : 'platform-service',
      id: (entry as { principalId?: string }).principalId ?? entry.name,
      name: entry.name,
    })),
    name: info.name,
    permissions: [...info.permissions],
  }
}
