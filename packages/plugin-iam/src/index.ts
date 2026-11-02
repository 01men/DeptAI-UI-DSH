/**
 * @dsh-ops/plugin-iam —— 组织账号管理（IAM）。
 *
 * 覆盖方案 §二：组织/账号、三方认证绑定、三方接入配置、角色/用户组。
 * 三方连接器（钉钉/飞书/企微）实现统一 OrgConnector 接口，新增 IM 平台只需新增连接器。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  PlatformEvents, newId, sha256Hex, generateSecret, mask,
  type Collection, type RecordBase,
} from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import * as iamTools from './tools.ts'
import { DingTalkAuthAdapter, RealDingTalkAuthAdapter, type DingTalkCredentials, type IdentityProviderAdapter } from './providers.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface OrgRecord extends RecordBase {
  name: string
  parentId: string | null
  order: number
  status: 'active' | 'archived'
  customFields: Record<string, string>
  /** 所属租户（多租户最小集，v1.2 第 2 步；缺省 t_default 兜底存量数据）。 */
  tenantId?: string
  /**
   * 组织负责人（NAS 数据权限 P/D/T 角色推导依据，dev-plan-nas-authz §2.1）。
   * 事实源：钉钉连接器同步 dept_manager_userid_list；兼容 customFields['leaderUserIds'] 逗号分隔旧口径。
   * 多负责人全部推导为对应负责人角色（co-leader）；为空时 nasAuthz 发 leaderVacant 告警。
   */
  leaderUserIds?: string[]
  /**
   * 负责人口径（缺省 = 'sync' 跟随连接器同步）：'manual' 表示控制台手动绑定锁定，
   * 连接器同步不再覆盖该组织的负责人（远端没配负责人的部门靠它补录）；清空负责人即恢复 'sync'。
   */
  leaderSource?: 'sync' | 'manual'
}

/** 租户（多租户最小集）：计量/用量报表的租户维度载体。 */
export interface TenantRecord extends RecordBase {
  name: string
  status: 'active' | 'suspended'
  /** 套餐档位（后续计费档位扩展位，schema v1 已含 tenant 维度）。 */
  plan: 'trial' | 'standard' | 'enterprise'
}

export const DEFAULT_TENANT_ID = 't_default'

export type UserStatus = 'pending' | 'active' | 'frozen' | 'deactivated'

export interface ThirdPartyBinding {
  provider: 'dingtalk' | 'feishu' | 'wecom'
  unionId: string
  displayName: string
  boundAt: string
  /** 主体企业 corpId（多主体隔离维度；缺省/空串视为同一旧主体）。 */
  corpId?: string
}

export interface UserRecord extends RecordBase {
  username: string
  displayName: string
  email: string
  phone: string
  orgId: string
  title: string
  status: UserStatus
  roleIds: string[]
  passwordSalt: string
  passwordHash: string
  bindings: ThirdPartyBinding[]
  jobNumber?: string
  lastLoginAt?: string
  frozenReason?: string
  /**
   * 账号类型（NAS 数据权限特殊账号规则，dev-plan-nas-authz §2.1）：
   * internal=正式员工（缺省）；external=外部顾问/合作方（白名单目录只读）；
   * suspended-review=可疑标记（全 deny + 审计转人工复核）。
   */
  accountType?: 'internal' | 'external' | 'suspended-review'
  /**
   * 主归属组织（跨部门兼任语义，dev-plan-nas-authz §2.1）：缺省取组织链最深者。
   * orgId ≠ primaryOrgId 时，orgId 组织子树仅授只读（兼任只读，避免双写冲突）。
   */
  primaryOrgId?: string
  /**
   * 三方绑定豁免（2026-10-22 解绑能力）：被人工解绑/更换过的「provider|corpId」，连接器同步
   * 不再自动重建该主体的身份链接。
   *
   * 为什么必须有：同步逻辑按「bindings 里有没有该 provider+corpId」决定是否补链，
   * 解绑后下一次同步（默认 60 分钟一次）会立刻按工号把人的钉钉身份绑回来——用户看到的是
   * 「点了没反应」。与部门负责人 leaderSource='manual' 的「手动绑定锁定，同步不覆盖」同构：
   * 人工决定优先于同步事实，要恢复自动绑定需显式解除豁免（重新扫码绑定即自动清除）。
   */
  bindingExemptions?: string[]
  /**
   * 人类已知口令（2026-10-22 解绑护栏的事实源）：仅在「有人拿到过明文口令」时为 true——
   * 创建时显式指定口令、管理员重置口令、本人改密。SSO 自注册与通讯录同步创建的账号
   * 口令是随机值且从未下发，此标记为 false，此时三方身份是唯一可用的登录方式。
   */
  passwordKnown?: boolean
}

export interface RoleRecord extends RecordBase {
  code: string
  name: string
  builtin: boolean
  description: string
  /** '*' 表示全部权限点。 */
  permissions: string[]
}

/**
 * 账号管理操作者上下文（QA A-03）：外部入口（REST 管理路由与工具桥）必须携带可归因 actor，
 * 组织归属校验 fail-closed（N1）。permissions 取操作者令牌实时解析结果（'*'=平台管理员）；
 * orgId 为显式组织归属（工具桥 `_actor` 注入形态），缺省按 userId 反查账号档案定位归属组织。
 */
export interface UserManageActor {
  userId?: string
  /** 操作者归属组织（组织子树判定根；缺省按 userId 反查账号档案）。 */
  orgId?: string
  permissions: string[]
}

/** 内部系统身份（基线迁移/种子初始化/三方同步等服务内部链路）：显式平台级操作者，替代无归因放行。 */
export const SYSTEM_ACTOR: UserManageActor = { permissions: ['*'] }

/**
 * 跨组织操作拒绝（QA A-03/N4）：领域语义为 403 FORBIDDEN——控制台路由层捕获后经
 * exchange.fail(403) 回写（guarded 兜底对裸 Error 一律 400，跨组织拒绝不属请求格式错误）。
 */
export class OrgScopeDeniedError extends Error {
  readonly status = 403
  readonly code = 'FORBIDDEN'

  constructor(message: string) {
    super(message)
    this.name = 'OrgScopeDeniedError'
  }
}

export interface UserGroupRule {
  orgIds?: string[]
  title?: string
}

export interface UserGroupRecord extends RecordBase {
  name: string
  type: 'static' | 'dynamic'
  rule?: UserGroupRule
  memberIds: string[]
  description: string
  /**
   * 是否为 NAS 数据权限 C 角色关联的动态用户组（dev-plan-nas-authz §2.2）。
   * 由 nasAuthz 规则导入/更新时回写标记；重算漂移时无论幅度大小都发 cGroupDrift 告警。
   */
  authzRoleC?: boolean
  /** 成员重算漂移告警阈值（人数，缺省 5；仅对未标记 authzRoleC 的组生效）。 */
  driftAlertThreshold?: number
}

export interface ConnectorConfigRecord extends RecordBase {
  id: string
  provider: 'dingtalk' | 'feishu' | 'wecom'
  /** 主体名称（多主体展示维度；缺省 `${provider}-${corpId}`）。 */
  name: string
  enabled: boolean
  corpId: string
  appKey: string
  secretMasked: string
  secretActual?: string
  syncOrgRoot: string
  intervalMinutes: number
  callbackUrl: string
  loginEnabled: boolean
  conflictStrategy: 'third_party_wins' | 'platform_wins' | 'manual'
  /** real=真实 OpenAPI；mock=演示降级（显式标注）。 */
  mode: 'real' | 'mock'
  /** OpenAPI 基址覆盖（测试/专有部署指向本地）。 */
  apiBase?: string
  /** 通讯录 topapi 基址覆盖（默认 https://oapi.dingtalk.com）。 */
  oapiBase?: string
  /** 同步树挂载的目标组织 ID（空=平台根；多主体各自挂到自己的根组织）。 */
  targetOrgId?: string
  lastSyncAt?: string
  lastSyncResult?: { ok: boolean; created: number; updated: number; conflicts: number; frozen: number; message: string }
}

/**
 * 三方身份链接（融合 auth-identity 的 user_identity_links 设计）。
 * 活跃链接在 (provider, corpId, providerUserId) 上引擎级唯一——「一人一号」按主体隔离，
 * 由唯一约束兜底，禁止以「先查后插」替代约束（红线）。解绑即物理删除记录（等价 WHERE unlinked_at IS NULL 的部分唯一索引）。
 *
 * kind（2026-10-22 解绑能力新增）：同一 provider+corpId 下同一个自然人可能同时存在两条链，
 * 用途不同、可独立存废：
 *   - login（缺省）：登录身份链，providerUserId 是 unionId。用于「这个人是谁」的判定与 SSO 登录。
 *   - staff：任职身份链，providerUserId 是 userid(staffId)。用于通讯录任职/负责人反查
 *     （部门负责人映射、NAS 数据权限身份反查）——它描述的是「此人在组织里的岗位」，不是登录凭据。
 * 两者并存是既有设计（同步时同时写入）。解绑登录身份不应连带抹掉任职事实：
 * 抹掉会让部门负责人反查断链、审批路由回退到父部门（2026-10-22 实测回归）。
 */
export interface IdentityLinkRecord extends RecordBase {
  provider: 'dingtalk' | 'feishu' | 'wecom'
  providerUserId: string
  corpId: string
  userId: string
  displayName: string
  linkedAt: string
  linkedBy: string
  /** 链路用途：login=登录身份（缺省）；staff=任职身份。缺省按 login 解读（存量数据兼容）。 */
  kind?: 'login' | 'staff'
}

export interface SyncConflictRecord extends RecordBase {
  provider: string
  kind: 'user_attr' | 'user_new' | 'user_left' | 'org_change'
  thirdPartyData: Record<string, unknown>
  platformData: Record<string, unknown>
  status: 'pending' | 'resolved'
  resolution?: string
  resolvedBy?: string
  resolvedAt?: string
}

/** 动态用户组成员快照（C 组漂移可观测，dev-plan-nas-authz §2.2）。 */
export interface GroupSnapshotRecord extends RecordBase {
  groupId: string
  memberIds: string[]
  computedAt: string
}

/** 组成员漂移告警默认阈值（人数）。 */
export const DEFAULT_GROUP_DRIFT_THRESHOLD = 5

/** 连接器自动同步巡检 tick：到期判定按各配置自身 intervalMinutes，不在此处定周期。 */
const AUTO_SYNC_TICK_MS = 60_000
/** 启动后首跑延迟：错开平台装载窗口，超期/从未同步的连接器启动即补同步。
 * 90s 口径（2026-10-13 R4 复盘）：原 15s 在 boot 较慢的环境会抢先于 SSO 兑换断言把演示名册
 * （dd_u003 等）自动同步建身份链接，「未命中签发待绑定票据」判定被污染为 hit——
 * 演示环境本就带 intervalMinutes=60 的演示连接器，boot 即触发属合理，拉长延迟让交互窗口先行。 */
const AUTO_SYNC_BOOT_DELAY_MS = 90_000
/** 单连接器最小生效间隔（防误配高频拖垮钉钉 OpenAPI 配额；0=该连接器关闭自动同步）。 */
const AUTO_SYNC_MIN_INTERVAL_MINUTES = 5

// ---------------------------------------------------------------------------
// 权限点目录
// ---------------------------------------------------------------------------

export const PermissionCatalog: Array<{ point: string; label: string; group: string }> = [
  { point: 'console.login', label: '登录控制台', group: '基础' },
  // 控制台只读基线（2026-10-17 演示模式批次）：工作台聚合/通知/平台信息/工具目录/最近调用
  // 五个纯读路由的声明点。被 console.login 蕴含（判定面规则见 platform-core rest-gate.ts
  // IMPLIED_POINTS），任何可登录角色无需显式授予即通过；单独授予本点不构成登录能力。
  // 免登演示态的只读白名单收录本点（访客可读工作台，拿不到 console.login 本身）。
  { point: 'console.read', label: '控制台只读（工作台/通知/平台信息/工具目录）', group: '基础' },
  { point: 'iam.org.read', label: '查看组织', group: '组织账号' },
  { point: 'iam.org.write', label: '管理组织', group: '组织账号' },
  { point: 'iam.user.read', label: '查看账号', group: '组织账号' },
  { point: 'iam.user.write', label: '管理账号', group: '组织账号' },
  { point: 'iam.user.freeze', label: '冻结/注销账号', group: '组织账号' },
  { point: 'iam.role.write', label: '管理角色', group: '组织账号' },
  { point: 'iam.connector.write', label: '管理三方接入', group: '组织账号' },
  { point: 'iam.scene.write', label: '管理场景级授权策略（场景 ABAC）', group: '组织账号' },
  { point: 'iam.roster.read', label: '读取全员名册（组织数据通道，接入应用拉取）', group: '组织账号' },
  { point: 'authn.principal.read', label: '查看身份/凭证', group: '统一认证' },
  { point: 'authn.principal.write', label: '管理机器凭证', group: '统一认证' },
  { point: 'authn.token.issue', label: '签发令牌', group: '统一认证' },
  { point: 'authn.token.revoke', label: '吊销令牌', group: '统一认证' },
  { point: 'authn.oidc.read', label: '查看 OIDC 客户端', group: '统一认证' },
  { point: 'authn.oidc.write', label: '管理 OIDC 客户端（签发/轮换/禁用）', group: '统一认证' },
  { point: 'mcp.service.read', label: '查看 MCP 服务', group: 'MCP' },
  // W3-T5（MCP 治理契约 §12/§15）：scope 模板读取点（POST /api/mcp/perm-groups/:id/scope-template，
  // dry 语义不落库）——目录缺此点时 resource_admin 的 mcp.* 通配无法展开到它（全量 403）
  { point: 'mcp.permgroup.read', label: '读取 MCP 权限组与 scope 模板', group: 'MCP' },
  { point: 'mcp.service.write', label: '管理 MCP 服务', group: 'MCP' },
  { point: 'mcp.service.deploy', label: '部署/灰度 MCP', group: 'MCP' },
  { point: 'mcp.service.offline', label: '下线 MCP', group: 'MCP' },
  { point: 'mcp.permgroup.write', label: '管理 MCP 权限组', group: 'MCP' },
  { point: 'mcp.invoke', label: '调用 MCP 网关', group: 'MCP' },
  // W 批次 W1（2026-10-15，V11 根治）：MCP 工具可信风险登记审批面——登记/两级审批/重审清单/退场
  { point: 'mcp.risk.admin', label: 'MCP 工具风险登记审批（登记/两级审批/重审清单）', group: 'MCP' },
  // 连接器纳管（SaaS 数据面网关；invoke 独立权限点对齐 mcp.invoke 先例）
  { point: 'connector.gateway.write', label: '配置连接器网关与健康操作', group: '连接器' },
  { point: 'connector.catalog.read', label: '浏览连接器目录', group: '连接器' },
  { point: 'connector.connection.read', label: '查看连接器连接（org 内）', group: '连接器' },
  { point: 'connector.connection.write', label: '创建/删除连接器连接（含 OAuth 发起）', group: '连接器' },
  { point: 'connector.invoke', label: '调用连接器 action', group: '连接器' },
  { point: 'connector.permgroup.write', label: '管理连接器权限组', group: '连接器' },
  { point: 'connector.runs.read', label: '查看连接器运行日志/对账视图', group: '连接器' },
  // connector.market.publish 移除（E-06 权限点卫生）：全仓无任何消费闸门（无 guarded/requirePermission/
  // hasPermission 引用），亦无内置角色持有；上架动作由 market.submit 契约 + 市场审批流承载。
  { point: 'skill.read', label: '浏览 Skill 市场', group: 'Skill 市场' },
  { point: 'skill.submit', label: '提交 Skill', group: 'Skill 市场' },
  { point: 'skill.approve', label: '审批 Skill', group: 'Skill 市场' },
  { point: 'skill.publish', label: '上架/下架 Skill', group: 'Skill 市场' },
  { point: 'skill.install', label: '安装 Skill', group: 'Skill 市场' },
  { point: 'skill.storage.write', label: '配置 Skill 包存储后端（本地/NAS）', group: 'Skill 市场' },
  { point: 'nas.read', label: '查看 NAS 存储', group: 'NAS 存储' },
  { point: 'nas.write', label: '管理 NAS 存储（纳管/上线/文件读写）', group: 'NAS 存储' },
  // NAS 数据权限（dev-plan-nas-authz §2.3）：check 供网关/hermes 专用资源账号调用，read/write 供规则管理
  { point: 'nas.authz.check', label: 'NAS 数据权限判定（check/scope）', group: 'NAS 存储' },
  { point: 'nas.authz.read', label: '查看 NAS 数据权限规则与判定留痕', group: 'NAS 存储' },
  { point: 'nas.authz.write', label: '管理 NAS 数据权限规则/例外（含破窗 override）', group: 'NAS 存储' },
  // 孤儿权限点补录（R10 总表发现，2026-10-13）：plugin-nas/manifest/permissions.yaml 已声明、
  // console 两处 guarded 路由（所有权登记/改写）实际校验，但目录此前未收录——自定义角色无法勾选
  { point: 'nas.ownership.write', label: '管理 NAS 文件所有权（上传登记/重命名改写/删除移除）', group: 'NAS 存储' },
  { point: 'agent.read', label: '查看 Agent', group: 'Agent 本体' },
  { point: 'agent.write', label: '管理 Agent', group: 'Agent 本体' },
  { point: 'agent.approve', label: '审批 Agent 上线', group: 'Agent 本体' },
  { point: 'agent.offline', label: '下线 Agent', group: 'Agent 本体' },
  { point: 'agent.a2a.invoke', label: 'A2A 跨运行时点名调用（IAW 7-1）', group: 'Agent 本体' },
  { point: 'app.read', label: '查看 AI 应用', group: 'AI 应用' },
  { point: 'app.write', label: '管理 AI 应用', group: 'AI 应用' },
  { point: 'app.offline', label: '下线 AI 应用', group: 'AI 应用' },
  // 应用外部凭证取值（issue #19，2026-10-31）：独立权限点——登记/轮换沿用 app.write，
  // 取值（拿到明文）单独授权 + 逐次审计；缺省无内置角色持有（按需显式授权，最小披露面）
  { point: 'app.credential.fetch', label: '取用应用外部凭证（每次取用落审计）', group: 'AI 应用' },
  // 数据要素域（IAW 交接 2-1..2-4）：数据集登记/质量分/血缘/指标字典
  { point: 'resource.dataset.write', label: '管理数据要素（数据集/质量分/血缘/指标字典）', group: '数据要素' },
  { point: 'audit.read', label: '查看审计日志', group: '审计' },
  { point: 'audit.rule.write', label: '管理告警规则', group: '审计' },
  { point: 'approval.read', label: '查看审批中心', group: '审批' },
  { point: 'approval.decide', label: '审批决策', group: '审批' },
  { point: 'usage.read', label: '查看计量流水', group: '用量计量' },
  { point: 'usage.write', label: '登记计量事件', group: '用量计量' },
  { point: 'usage.admin', label: '管理价格簿/对账/能力授权', group: '用量计量' },
  { point: 'modelgw.read', label: '查看模型网关', group: '模型网关' },
  { point: 'modelgw.invoke', label: '调用模型网关', group: '模型网关' },
  { point: 'modelgw.admin', label: '管理模型目录', group: '模型网关' },
  { point: 'market.read', label: '浏览插件市场', group: '插件市场' },
  // market.submit 移除（E-06 权限点卫生）：提交面 POST /api/market/submit 走开发者身份自校验
  // （access=authenticated + developerCaller），该权限点全仓无消费、无角色持有。
  { point: 'market.approve', label: '审批插件', group: '插件市场' },
  { point: 'market.install', label: '安装插件', group: '插件市场' },
  { point: 'market.developer', label: '开发者门户', group: '插件市场' },
  { point: 'connect.manage', label: '管理平台接入（接入码/远程客户端）', group: '平台接入' },
  { point: 'platform.update.read', label: '查看/触发平台更新检查', group: '平台维护' },
  { point: 'platform.update.apply', label: '执行平台升级（git pull + npm install）', group: '平台维护' },
  // 部门面板（review-dsh-agent-panel-v2 Phase 0：D3 裁决——无 dingtalk.* 事件权限点、总线订阅不需权限点）
  { point: 'panel.read', label: '查看部门面板（会话/看板/知识/图谱）', group: '部门面板' },
  { point: 'panel.write', label: '面板协作（发消息/建频道/卡片动作/激活申请）', group: '部门面板' },
  { point: 'panel.task.write', label: '面板任务流转（创建/泳道迁移）', group: '部门面板' },
  { point: 'panel.config.write', label: '面板配置（widget/KPI 布局/图谱重载）', group: '部门面板' },
  { point: 'scenegraph.read', label: '查看行业场景图谱', group: '部门面板' },
  // scenegraph.activate 移除（E-06 权限点卫生）：行业激活的实际闸门是 panel.write（激活申请）
  // 与 market.approve（审批执行），该点全仓无消费；org_admin 迁移批次同步摘除（存量库已
  // 落库的点由管理员按角色编辑回收，迁移只补缺不删改）。
  { point: 'dingtalk.message.send', label: '钉钉桥接消息投递（群桥绑定/推送/回决回调）', group: '部门面板' },
  // 事务流引擎（IAW 交接 3-1..3-4，宿主新域 flow）
  { point: 'flow.read', label: '查看事务流（编排/模板/SLA）', group: '事务流' },
  { point: 'flow.write', label: '事务流流转（创建实例/步骤推进/取消）', group: '事务流' },
  { point: 'flow.admin', label: '管理事务流模板库', group: '事务流' },
  // 执行中枢（2026-10-14 路线图 R5/R10 前置，plugin-exec-hub 域）：权限点此前只在
  // plugin-exec-hub/plugin.yaml 声明、目录未收录（自定义角色无法勾选，同 nas.ownership.write
  // 孤儿点先例）——收录后内置角色与自定义角色才能按粒度授权
  { point: 'exec.read', label: '查看执行中枢（目标/任务/唤醒/心跳）', group: '执行中枢' },
  { point: 'exec.write', label: '操作执行中枢任务', group: '执行中枢' },
  { point: 'exec.admin', label: '执行中枢运维（手动 tick 等）', group: '执行中枢' },
  // 数字员工域（W 批次，plugin-workforce）：权限点此前只在 plugin.yaml/permissions.yaml 声明、
  // 目录未收录（exec.* 孤儿点同先例）——收录后 authn 机器凭证才能签发 workforce.* scope、
  // 内置角色与自定义角色才能按粒度授权（W5 运维面 workforce.admin 同批销账）
  { point: 'workforce.read', label: '查看数字员工域（员工/任用/调用/交付）', group: '数字员工' },
  { point: 'workforce.write', label: '管理数字员工域（员工/绑定/任用）', group: '数字员工' },
  { point: 'workforce.admin', label: '数字员工运维（批量停复职/审计报表/台账清理）', group: '数字员工' },
  { point: 'workforce.invoke', label: '数字员工受控调用（认领/续租/受控执行）', group: '数字员工' },
  { point: 'workforce.accept', label: '数字员工交付验收（提交/决定）', group: '数字员工' },
]

export const BuiltinRoles: Array<Omit<RoleRecord, 'id' | 'createdAt' | 'updatedAt'>> = [
  { code: 'super_admin', name: '平台超级管理员', builtin: true, description: '拥有全部权限点', permissions: ['*'] },
  // org_admin 补 exec.*（2026-10-14 执行中枢纳管）：组织管理员对本组织执行中枢全权（与 iam.* 同口径）
  // + workforce.*（W 批次 2026-10-15）：本组织数字员工域全权（与 BUILTIN_ROLE_MIGRATION 两处同步）
  { code: 'org_admin', name: '组织管理员', builtin: true, description: '管理本组织账号与用户组', permissions: ['console.login', 'iam.*', 'approval.read', 'exec.*', 'workforce.*'] },
  // resource_admin 补 exec.read + modelgw.read（2026-10-14）：资源管理员可查看执行中枢（操作 Agent 的运行面）
  // 与模型目录（R2-B：渠道分级/预算治理需要看到模型清单，写面仍归 modelgw.admin）
  // + workforce.read（W 批次 2026-10-15）：资源管理员可查看数字员工域（员工消费其所管资源，运维面仍归 org_admin）
  { code: 'resource_admin', name: '资源管理员', builtin: true, description: '管理 MCP/Skill/Agent/应用/NAS/连接器资源与数据要素', permissions: ['console.login', 'mcp.*', 'skill.*', 'agent.*', 'app.*', 'nas.*', 'authn.oidc.*', 'connector.*', 'resource.dataset.write', 'panel.read', 'flow.read', 'approval.read', 'modelgw.read', 'exec.read', 'workforce.read'] },
  { code: 'developer', name: '开发者', builtin: true, description: '提交与调试资源（应用限自身 owner 范围，服务端校验）', permissions: ['console.login', 'iam.user.read', 'iam.org.read', 'mcp.service.read', 'mcp.invoke', 'skill.read', 'skill.submit', 'skill.install', 'agent.read', 'agent.write', 'app.read', 'app.write', 'nas.read', 'connector.catalog.read', 'connector.connection.read', 'connector.invoke', 'exec.read', 'exec.write'] },
  { code: 'member', name: '普通用户', builtin: true, description: '浏览市场与可用资源', permissions: ['console.login', 'skill.read', 'agent.read', 'app.read', 'panel.read', 'panel.write', 'panel.task.write', 'scenegraph.read', 'flow.read', 'flow.write', 'exec.read', 'exec.write'] },
  { code: 'auditor', name: '审计员（只读）', builtin: true, description: '全平台只读审计', permissions: ['console.login', 'iam.org.read', 'iam.user.read', 'authn.principal.read', 'authn.oidc.read', 'mcp.service.read', 'skill.read', 'agent.read', 'app.read', 'nas.read', 'audit.read', 'approval.read', 'connector.runs.read', 'connector.connection.read', 'exec.read'] },
]

/**
 * 内置角色的一次性幂等权限迁移：ensureBuiltinRoles 只插不更新——生产已落库角色不会自动
 * 获得后续版本新增的权限点。迁移只做「缺则补」，不触碰用户自定义角色；每次启动都会
 * 重新比对（幂等），历史标记（connector-permissions-v1）仅作观测。
 */
export const BUILTIN_ROLE_MIGRATION: Record<string, string[]> = {
  // resource_admin 补治理读面（外部 QA-20261014 QA-03）：数据集/指标/血缘等读路由挂 panel.read、
  // 事务流模板与实例列表挂 flow.read——此前资源管理员"能写（resource.dataset.write/flow.admin）不能读"
  // + exec.read/modelgw.read（2026-10-14 执行中枢与模型目录读面，与 BuiltinRoles 两处必须同步）
  resource_admin: ['connector.gateway.write', 'connector.catalog.read', 'connector.connection.read', 'connector.connection.write', 'connector.invoke', 'connector.permgroup.write', 'connector.runs.read', 'resource.dataset.write', 'flow.admin', 'panel.read', 'flow.read', 'modelgw.read', 'exec.read'],
  // developer 补 agent.write：与 app.write 对称——开发者应能注册/提报更新 Agent（2026-08 修复"总是报没有 agent.write 权限"）
  // + exec.read/exec.write（2026-10-14）：开发者可在执行中枢查看与操作自己发起的任务
  developer: ['connector.catalog.read', 'connector.connection.read', 'connector.invoke', 'agent.write', 'panel.read', 'scenegraph.read', 'flow.read', 'exec.read', 'exec.write'],
  // auditor 补 nas.authz.read：审计员可查看 NAS 数据权限规则与判定留痕（dev-plan-nas-authz §2.3）
  // + exec.read（2026-10-14）：执行中枢任务/唤醒留痕纳入只读审计面
  auditor: ['connector.runs.read', 'connector.connection.read', 'nas.authz.read', 'panel.read', 'scenegraph.read', 'flow.read', 'exec.read'],
  // 部门面板（review-dsh-agent-panel-v2 Phase 0）：业务成员=member 直用面板；org_admin 增配置；
  // 存量库经迁移补点，新装库直接来自 BuiltinRoles 定义（两处必须同步）
  // + exec.read/exec.write（2026-10-14）：普通用户可在执行中枢发起/查看自己的任务
  member: ['panel.read', 'panel.write', 'panel.task.write', 'scenegraph.read', 'flow.read', 'flow.write', 'exec.read', 'exec.write'],
  // org_admin 增 exec.*（2026-10-14）：本组织执行中枢全权（读/写/运维 tick，与 iam.* 通配同口径）
  // scenegraph.activate 摘除（E-06）：全仓无消费死点（见 PermissionCatalog 内注）
  // + workforce.*（W 批次 2026-10-15）：本组织数字员工域全权（运维面 workforce.admin 与 exec.admin 同口径）
  org_admin: ['panel.read', 'panel.write', 'panel.task.write', 'panel.config.write', 'scenegraph.read', 'flow.read', 'flow.write', 'flow.admin', 'exec.*', 'workforce.*'],
}

/** 兼容别名：迁移通道创建时的历史命名（仅 connector 批次）。 */
export const CONNECTOR_ROLE_MIGRATION = BUILTIN_ROLE_MIGRATION

// ---------------------------------------------------------------------------
// 场景级授权（IAW 交接 6-1：角色 L1-L5 × 场景 ABAC 细粒度）
// ---------------------------------------------------------------------------

/**
 * 场景授权策略条目：按角色/用户 × 动作 × allow/deny 的 ABAC 规则行。
 * action 键与权限点同形（panel.read/panel.task.write…）或业务自定义动作键（如 'scene.export'）；
 * principalId='*' 为通配。
 */
export interface ScenePolicyEntry {
  principalType: 'role' | 'user'
  principalId: string
  actions: string[]
  effect: 'allow' | 'deny'
}

/**
 * 场景授权策略：挂 sceneCode 维度（ScenegraphScene.code，如 QB01-A-2-5）。
 * 判定语义（fail-closed）：场景无任何策略 → default（回落角色 RBAC 与部门范围权限，存量行为不变）；
 * 有策略 → deny 条目优先命中即拒，allow 命中即放行，都不命中一律拒绝。
 * version 乐观锁：并发编辑以 expectedVersion 对账（冲突抛错，先读后写）。
 */
export interface ScenePolicyRecord extends RecordBase {
  sceneCode: string
  /** 组织维度收敛（缺省=全组织通用策略）；同场景可按组织各挂一条。 */
  orgId?: string
  entries: ScenePolicyEntry[]
  note?: string
  version: number
}

export interface SceneCheckDecision {
  /** default=场景未配置策略（回落 RBAC）；allow/deny=场景策略裁决。 */
  decision: 'allow' | 'deny' | 'default'
  reason: string
  policyId?: string
  sceneCode: string
  action: string
}

// ---------------------------------------------------------------------------
// 三方连接器接口
// ---------------------------------------------------------------------------

export interface RemoteDirectory {
  orgs: Array<{ remoteId: string; name: string; parentRemoteId: string | null; /** 部门负责人三方 userId 列表（钉钉 dept_manager_userid_list），nasAuthz 角色推导依据。 */ managerRemoteIds?: string[] }>
  users: Array<{
    remoteId: string
    /** 钉钉 userid（staffId）：hermes X-On-Behalf-User 身份头与 dept_manager_userid_list 的口径；与 remoteId(unionId) 并存为两条 identityLinks。 */
    remoteUserId?: string
    name: string
    jobNumber: string
    title: string
    orgRemoteId: string
    /** 一人多部门：orgRemoteId 为主归属（优先 deptRemoteIds[0]=钉钉主部门，缺省取目录首见），其余部门记兼任挂靠（引擎 orgId 子树兼任只读）。 */
    extraOrgRemoteIds?: string[]
    /** 钉钉 dept_id_list 原序（首位=主部门），多部门时用于校正主归属。 */
    deptRemoteIds?: string[]
    email: string
    active: boolean
  }>
}

export interface OrgConnector {
  provider: string
  label: string
  fetchDirectory(): Promise<RemoteDirectory>
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; message: string; mock?: boolean }>
}

/** 钉钉连接器（演示环境内置模拟目录服务，接口与真实 OpenAPI 对齐）。 */
export class DingTalkConnector implements OrgConnector {
  provider = 'dingtalk'
  label = '钉钉'

  private directory: RemoteDirectory = {
    orgs: [
      { remoteId: 'dd_root', name: '元冰可集团', parentRemoteId: null, managerRemoteIds: ['staff_001'] },
      { remoteId: 'dd_tech', name: '技术中心', parentRemoteId: 'dd_root', managerRemoteIds: ['staff_001'] },
      { remoteId: 'dd_ai', name: 'AI 平台部', parentRemoteId: 'dd_tech', managerRemoteIds: ['staff_002'] },
      { remoteId: 'dd_be', name: '后端部', parentRemoteId: 'dd_tech', managerRemoteIds: ['staff_004'] },
      { remoteId: 'dd_fe', name: '前端部', parentRemoteId: 'dd_tech', managerRemoteIds: ['staff_005'] },
      { remoteId: 'dd_prod', name: '产品运营部', parentRemoteId: 'dd_root', managerRemoteIds: ['staff_006'] },
      { remoteId: 'dd_mkt', name: '市场部', parentRemoteId: 'dd_root', managerRemoteIds: ['staff_008'] },
    ],
    users: [
      { remoteId: 'dd_u001', remoteUserId: 'staff_001', name: '陈远舟', jobNumber: 'DD0001', title: '技术总监', orgRemoteId: 'dd_tech', email: 'chenyz@yuanbingke.com', active: true },
      { remoteId: 'dd_u002', remoteUserId: 'staff_002', name: '林小满', jobNumber: 'DD0002', title: '算法工程师', orgRemoteId: 'dd_ai', email: 'linxm@yuanbingke.com', active: true },
      { remoteId: 'dd_u003', remoteUserId: 'staff_003', name: '周既白', jobNumber: 'DD0003', title: '算法工程师', orgRemoteId: 'dd_ai', email: 'zhoujb@yuanbingke.com', active: true },
      { remoteId: 'dd_u004', remoteUserId: 'staff_004', name: '苏砚秋', jobNumber: 'DD0004', title: '后端工程师', orgRemoteId: 'dd_be', email: 'suyq@yuanbingke.com', active: true },
      { remoteId: 'dd_u005', remoteUserId: 'staff_005', name: '何青梧', jobNumber: 'DD0005', title: '前端工程师', orgRemoteId: 'dd_fe', email: 'heqw@yuanbingke.com', active: true },
      { remoteId: 'dd_u006', remoteUserId: 'staff_006', name: '顾星阑', jobNumber: 'DD0006', title: '产品经理', orgRemoteId: 'dd_prod', email: 'guxl@yuanbingke.com', active: true },
      { remoteId: 'dd_u007', remoteUserId: 'staff_007', name: '叶栖迟', jobNumber: 'DD0007', title: '运营专员', orgRemoteId: 'dd_prod', email: 'yqz@yuanbingke.com', active: true },
      { remoteId: 'dd_u008', remoteUserId: 'staff_008', name: '孟疏桐', jobNumber: 'DD0008', title: '市场专员', orgRemoteId: 'dd_mkt', email: 'mst@yuanbingke.com', active: true },
      { remoteId: 'dd_u009', remoteUserId: 'staff_009', name: '周明澜', jobNumber: 'DD0009', title: '前端工程师', orgRemoteId: 'dd_fe', extraOrgRemoteIds: ['dd_be'], email: 'zhml@yuanbingke.com', active: true },
      { remoteId: 'dd_u010', remoteUserId: 'staff_010', name: '姜叙白', jobNumber: 'DD0010', title: '数据工程师', orgRemoteId: 'dd_be', email: 'jxb@yuanbingke.com', active: false },
    ],
  }

  async fetchDirectory(): Promise<RemoteDirectory> {
    await delay(120 + Math.floor(Math.random() * 80))
    return structuredClone(this.directory)
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; message: string; mock?: boolean }> {
    const started = Date.now()
    await delay(40)
    return { ok: true, latencyMs: Date.now() - started, message: t('降级模式：未配置钉钉企业凭证，使用内置演示目录'), mock: true }
  }
}

/**
 * 钉钉连接器（真实 OpenAPI）：通讯录分页拉取，目录映射到 RemoteDirectory。
 * 链路：企业内部应用 accessToken（POST api.dingtalk.com/v1.0/oauth2/accessToken）
 *   → 部门树（oapi topapi/v2/department/listsubid + department/get，自根 BFS）
 *   → 部门成员（oapi topapi/v2/user/list 分页）。
 * 接口失败（HTTP 非 2xx 或 errcode != 0）一律抛出带 errmsg 的错误——
 * 历史教训：静默返回空目录会让同步「成功」但 0 条数据，故障无法察觉。
 */
export class RealDingTalkConnector implements OrgConnector {
  provider = 'dingtalk'
  label = '钉钉'
  private corpTokenCache: { token: string; expiresAt: number } | undefined
  private readonly credentials: DingTalkCredentials
  /** 同步根部门 ID（缺省 1=企业根）。 */
  private readonly syncOrgRoot: string

  constructor(credentials: DingTalkCredentials, options: { syncOrgRoot?: string } = {}) {
    this.credentials = credentials
    this.syncOrgRoot = options.syncOrgRoot?.trim() || '1'
  }

  private get apiBase(): string {
    return this.credentials.apiBase ?? 'https://api.dingtalk.com'
  }

  private get oapiBase(): string {
    return this.credentials.oapiBase ?? 'https://oapi.dingtalk.com'
  }

  private async corpAccessToken(): Promise<string> {
    if (this.corpTokenCache && this.corpTokenCache.expiresAt > Date.now() + 60_000) {
      return this.corpTokenCache.token
    }
    const response = await fetch(`${this.apiBase}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: this.credentials.appKey, appSecret: this.credentials.appSecret }),
    })
    const payload = (await response.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number }
    if (!response.ok || !payload.accessToken) {
      throw new Error(t('钉钉企业 accessToken 获取失败（HTTP {status}）', { status: response.status }))
    }
    this.corpTokenCache = { token: payload.accessToken, expiresAt: Date.now() + (payload.expireIn ?? 7200) * 1000 }
    return payload.accessToken
  }

  /** 调 oapi topapi：access_token 走 query；errcode != 0 即抛错（不静默吞错）。 */
  private async topapi<T>(path: string, body: Record<string, unknown>): Promise<T & { errcode?: number; errmsg?: string }> {
    const token = await this.corpAccessToken()
    const response = await fetch(`${this.oapiBase}${path}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = (await response.json().catch(() => ({}))) as T & { errcode?: number; errmsg?: string }
    if (!response.ok || (payload.errcode ?? 0) !== 0) {
      throw new Error(t('钉钉接口 {path} 调用失败（HTTP {status}，errcode {errcode}：{errmsg}）', { path, status: response.status, errcode: payload.errcode ?? '-', errmsg: payload.errmsg ?? t('无错误信息') }))
    }
    return payload
  }

  async fetchDirectory(): Promise<RemoteDirectory> {
    const rootId = this.syncOrgRoot
    const rootInfo = await this.getDepartment(rootId)
    const orgs: RemoteDirectory['orgs'] = [{ remoteId: rootId, name: rootInfo.name, parentRemoteId: null, ...(rootInfo.managerRemoteIds ? { managerRemoteIds: rootInfo.managerRemoteIds } : {}) }]
    const users: RemoteDirectory['users'] = []
    // 自根部门 BFS（上限 3 层 / 每层 50 部门，防御异常目录）
    let frontier = [rootId]
    for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
      const next: string[] = []
      for (const deptId of frontier.slice(0, 50)) {
        for (const childId of await this.listSubDepartmentIds(deptId)) {
          const child = await this.getDepartment(childId)
          orgs.push({ remoteId: childId, name: child.name, parentRemoteId: deptId, ...(child.managerRemoteIds ? { managerRemoteIds: child.managerRemoteIds } : {}) })
          next.push(childId)
        }
      }
      frontier = next
    }
    for (const org of orgs) {
      const members = await this.listUsers(org.remoteId)
      for (const member of members) {
        const existing = users.find((user) => user.remoteId === member.remoteId)
        if (existing) {
          // 一人多部门（兼任语义数据源）：首见部门记入 extraOrgRemoteIds，收尾按 deptRemoteIds 校正主归属
          if (existing.orgRemoteId !== org.remoteId && !(existing.extraOrgRemoteIds ?? []).includes(org.remoteId)) {
            existing.extraOrgRemoteIds = [...(existing.extraOrgRemoteIds ?? []), org.remoteId]
          }
          continue
        }
        users.push({ ...member, orgRemoteId: org.remoteId })
      }
    }
    // 主归属校正：钉钉 dept_id_list 首位=主部门（目录遍历序 ≠ 用户主部门序，首见可能误判）
    for (const user of users) {
      const deptIds = (user.deptRemoteIds ?? []).filter((id) => id === user.orgRemoteId || orgs.some((org) => org.remoteId === id))
      if (deptIds.length > 0 && deptIds[0] !== user.orgRemoteId) {
        const rest = [user.orgRemoteId, ...(user.extraOrgRemoteIds ?? [])].filter((id) => id !== deptIds[0])
        user.orgRemoteId = deptIds[0]
        user.extraOrgRemoteIds = [...new Set(rest)]
      }
    }
    return { orgs, users }
  }

  /** 部门详情（取名 + 负责人列表；根部门 dept_id=1 返回企业名）。 */
  private async getDepartment(deptId: string): Promise<{ name: string; managerRemoteIds?: string[] }> {
    const payload = await this.topapi<{ result?: { name?: string; dept_manager_userid_list?: string[] } }>('/topapi/v2/department/get', { dept_id: Number(deptId) })
    const managerRemoteIds = (payload.result?.dept_manager_userid_list ?? []).filter((id) => Boolean(id))
    return { name: payload.result?.name ?? t('部门 {deptId}', { deptId }), ...(managerRemoteIds.length > 0 ? { managerRemoteIds } : {}) }
  }

  /** 下一级子部门 ID 列表（不受授权范围限制）。 */
  private async listSubDepartmentIds(deptId: string): Promise<string[]> {
    const payload = await this.topapi<{ result?: { dept_id_list?: number[] } }>('/topapi/v2/department/listsubid', { dept_id: Number(deptId) })
    return (payload.result?.dept_id_list ?? []).map(String)
  }

  private async listUsers(deptId: string): Promise<RemoteDirectory['users']> {
    const users: RemoteDirectory['users'] = []
    let cursor = 0
    for (let page = 0; page < 10; page++) {
      const payload = await this.topapi<{
        result?: {
          has_more?: boolean
          next_cursor?: number
          list?: Array<{ unionid?: string; userid?: string; dept_id_list?: number[]; name?: string; job_number?: string; title?: string; email?: string; org_email?: string; active?: boolean }>
        }
      }>('/topapi/v2/user/list', { dept_id: Number(deptId), cursor, size: 100 })
      const result = payload.result ?? {}
      for (const item of result.list ?? []) {
        const remoteId = item.unionid ?? item.userid
        if (!remoteId) continue
        const deptRemoteIds = (item.dept_id_list ?? []).map(String).filter(Boolean)
        users.push({
          remoteId,
          ...(item.userid && item.userid !== remoteId ? { remoteUserId: item.userid } : {}),
          name: item.name ?? remoteId,
          jobNumber: item.job_number || remoteId,
          title: item.title ?? '',
          orgRemoteId: deptId,
          ...(deptRemoteIds.length > 1 ? { deptRemoteIds } : {}),
          email: item.email || item.org_email || '',
          active: item.active ?? true,
        })
      }
      if (!result.has_more) break
      cursor = Number(result.next_cursor ?? cursor + 100)
    }
    return users
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; message: string; mock?: boolean }> {
    const started = Date.now()
    try {
      await this.corpAccessToken()
      return { ok: true, latencyMs: Date.now() - started, message: t('钉钉 OpenAPI 连通正常（真实模式）'), mock: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, latencyMs: Date.now() - started, message, mock: false }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class IamService extends Service {
  static readonly provide = 'iam'

  /**
   * 内置连接器实现范围（applyConnectorMode 能直接实例化的 provider）。
   * 配置保存以「可实现」为准放行，而非「当前已注册」——否则生产基线（无 DEMO_SEED、
   * 注册表为空）首次保存钉钉凭证会被守卫拦死，形成「先有配置才能注册、先注册才能存配置」死锁。
   */
  private static readonly BUILTIN_CONNECTOR_PROVIDERS: ReadonlySet<string> = new Set(['dingtalk'])

  /** 运行时注册表：key 为配置实例 ID（DEMO_SEED 内置 mock 用 'demo:dingtalk'），provider 仅表示平台类型。 */
  private connectors = new Map<string, OrgConnector>()
  private authProviders = new Map<string, IdentityProviderAdapter>()
  /** 自动同步去重：同一配置实例上一轮尚未结束时跳过（同步耗时超过巡检周期时不叠加并发）。 */
  private autoSyncing = new Set<string>()
  private autoSyncTimer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context) {
    super(ctx, 'iam')
    // 默认不注册任何三方身份源：生产基线三方登录入口自动隐藏（未配置连接器时 sso 不可用）。
    // mock 钉钉 IdP 仅在显式 DEMO_SEED=1 演示环境下注册，避免生产基线暴露演示身份/匿名注册入口。
    if (process.env.DEMO_SEED === '1') {
      this.registerConnector('demo:dingtalk', new DingTalkConnector())
      this.registerAuthProvider('demo:dingtalk', new DingTalkAuthAdapter())
    }
    this.ensureDefaultTenant()
    // 连接器/身份源注册表仅存内存：重启后须按持久化配置重建，否则 real 模式的
    // Real*Adapter 不会恢复（扫码登录/同步将报「未注册」）。多主体：按配置实例 id 逐条恢复。
    for (const config of this.connectorConfigs().all()) {
      this.applyConnectorMode(config.id)
    }
    // 连接器定时自动同步（intervalMinutes 落地）：控制台「同步频率」此前只存不跑，
    // 通讯录变动（新入职/离职/调岗）需人工点同步才进平台。启动后首跑补同步超期配置，
    // 此后每分钟巡检到期；IAM_CONNECTOR_AUTO_SYNC=off 一键停用（对齐 PORTAL_SYNC 惯例）。
    this.autoSyncTimer = setInterval(() => void this.runDueAutoSyncs(), AUTO_SYNC_TICK_MS)
    this.autoSyncTimer.unref?.() // OPT-P3-02
    setTimeout(() => void this.runDueAutoSyncs(), AUTO_SYNC_BOOT_DELAY_MS)
    ctx.effect(() => () => {
      if (this.autoSyncTimer) clearInterval(this.autoSyncTimer)
    })
  }

  /** 注册连接器实例：key 为配置实例 id（多主体各自独立注册/注销）。 */
  registerConnector(key: string, connector: OrgConnector): () => void {
    this.connectors.set(key, connector)
    return () => this.connectors.delete(key)
  }

  /** 注册身份源 Adapter 实例：登录主流程面向接口编程，新增平台零侵入。 */
  registerAuthProvider(key: string, adapter: IdentityProviderAdapter): () => void {
    this.authProviders.set(key, adapter)
    return () => this.authProviders.delete(key)
  }

  /**
   * 按平台类型取身份源（旧调用兼容；多主体请用 getAuthProviderByConfig）。
   * 优先配置实例注册的身份源（按配置创建顺序取第一）；`demo:` 前缀的 DEMO_SEED 引导注册
   * 仅作「尚无配置」窗口的兜底——否则演示实例长期占据首位，会遮蔽配置切换后的真实/新 mock 实例。
   */
  getAuthProvider(type: string): IdentityProviderAdapter {
    let demoFallback: IdentityProviderAdapter | undefined
    for (const [key, adapter] of this.authProviders) {
      if (adapter.type !== type) continue
      if (key.startsWith('demo:')) {
        demoFallback ??= adapter
        continue
      }
      return adapter
    }
    if (demoFallback) return demoFallback
    throw new Error(t('未注册的身份源：{type}', { type }))
  }

  /** 按配置实例 id 取身份源（多主体登录/绑定按主体发起）。 */
  getAuthProviderByConfig(configId: string): IdentityProviderAdapter {
    const adapter = this.authProviders.get(configId)
    if (!adapter) throw new Error(t('未注册的身份源：{type}', { type: configId }))
    return adapter
  }

  /** 三方身份链接集合（活跃唯一约束：同一主体下的同一三方身份只能映射一个平台账号）。 */
  identityLinks(): Collection<IdentityLinkRecord> {
    const collection = this.ctx.opsStorage.collection<IdentityLinkRecord>('iam:identityLinks')
    collection.uniqueOn('identity_link_active', (record) => `${record.provider}|${record.corpId}|${record.providerUserId}`)
    return collection
  }

  /**
   * 命中查找：按归一化档案定位已绑定的平台账号。
   * 传 corpId 时精确命中优先；无精确命中回落任意 corp 的同三方身份——钉钉 unionId 跨企业同人，
   * 且兼容单主体部署在 mock/real 间切换（corpId 变化）后的身份连续性。多主体下同身份多链接时精确匹配生效。
   */
  findLinkByProfile(provider: string, providerUserId: string, corpId?: string): IdentityLinkRecord | undefined {
    const links = this.identityLinks().find((link) => link.provider === provider && link.providerUserId === providerUserId)
    if (corpId === undefined) return links[0]
    return links.find((link) => link.corpId === corpId) ?? links[0]
  }

  /** 建立身份链接（唯一约束兜底；user.bindings 保持为投影，便于列表展示）。 */
  linkIdentity(userId: string, profile: { provider: IdentityLinkRecord['provider']; providerUserId: string; corpId: string; displayName: string; kind?: 'login' | 'staff' }, actor: string): IdentityLinkRecord {
    const user = this.users().get(userId)
    if (!user) throw new Error(t('账号不存在：{id}', { id: userId }))
    const link = this.identityLinks().insert({
      id: newId('idl'),
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      corpId: profile.corpId,
      userId,
      displayName: profile.displayName,
      linkedAt: new Date().toISOString(),
      linkedBy: actor,
      ...(profile.kind ? { kind: profile.kind } : {}),
    })
    // 人工绑定意图覆盖此前的解绑决定：同步不再把它当作「用户不想要」的主体。
    // 只在写「登录链」时清除豁免——同步补写任职链（staff）不构成人工绑定意图，
    // 否则解绑后一次同步就会把解绑决定冲掉（用户看到「点了没反应」）。
    if (profile.kind !== 'staff') {
      this.clearBindingExemption(userId, profile.provider, profile.corpId)
    }
    // 投影重建（bindings 仅作展示，事实源是 identityLinks）：统一由登录链重算，
    // 不在此处增量追加——增量追加会把任职链（staff）也算成「绑定的三方账号」，
    // 且与解绑后的重建口径不一致（解绑清空、写入又加回，用户看到解绑没生效）。
    // 必须在豁免处理之后：重建会按豁免过滤主体，先清豁免才能把新绑定显示出来。
    this.rebuildBindingsProjection(userId)
    return link
  }

  /**
   * 解除身份链接（同时按事实源重建投影）。
   *
   * 四个必须做对的点（2026-10-22 解绑/更换能力上线时的整改）：
   *   1. 多主体：同一 provider 可能有多个 corpId 的链接（unionId 链 + userid 链），
   *      传 corpId 只删该主体的链接；不传=删该 provider 全部（显式语义，调用方负责确认）。
   *   2. 事实源：`findOne` + `remove` 只删到一条，其余同 provider 链接会变成幽灵——按 provider
   *      （或 provider+corpId）全量删除。
   *   3. 投影：bindings 必须由剩余 identityLinks 重算，不能按 provider 一刀切过滤——
   *      否则「解绑一个主体」会把另一个主体的展示行一起清掉，而链接还在。
   *   4. 链路角色：只解「登录身份链」（kind≠staff）。任职身份链（staff）描述的是此人在组织里的
   *      岗位事实（部门负责人映射、NAS 数据权限身份反查都依赖它），不是登录凭据——
   *      连带抹掉会让部门负责人反查断链、审批路由回退到父部门（实测回归）。
   */
  unlinkIdentity(userId: string, provider: IdentityLinkRecord['provider'], corpId?: string, kind?: 'login' | 'staff'): boolean {
    const targets = this.identityLinks().find((item) => item.userId === userId
      && item.provider === provider
      && (corpId === undefined || (item.corpId ?? '') === corpId)
      && (kind === undefined ? item.kind !== 'staff' : item.kind === kind))
    if (targets.length === 0) return false
    // 记录豁免（按实际删掉的主体粒度）：否则下一次连接器同步会按工号把链接补回来。
    const exempted = new Set<string>((this.users().get(userId)?.bindingExemptions ?? []))
    for (const link of targets) exempted.add(`${provider}|${link.corpId ?? ''}`)
    for (const link of targets) this.identityLinks().remove(link.id)
    this.users().update(userId, { bindingExemptions: [...exempted] })
    // 投影重建时排除被豁免的主体：解绑后该主体不再显示为「已绑定」，
    // 即使任职链仍在（任职事实没被抹掉，只是不再作为「可登录的绑定」展示）。
    this.rebuildBindingsProjection(userId)
    return true
  }

  /** 清除绑定豁免（重新扫码/手工绑定成功时调用：人工绑定的意图覆盖此前的解绑决定）。 */
  private clearBindingExemption(userId: string, provider: string, corpId: string): void {
    const user = this.users().get(userId)
    if (!user?.bindingExemptions?.length) return
    const key = `${provider}|${corpId}`
    if (!user.bindingExemptions.includes(key)) return
    const next = user.bindingExemptions.filter((item) => item !== key)
    this.users().update(userId, { bindingExemptions: next.length ? next : undefined })
  }

  /** 由 identityLinks（事实源）重建 user.bindings 投影：多主体按 provider+corpId 一行。 */
  private rebuildBindingsProjection(userId: string): void {
    const user = this.users().get(userId)
    if (!user) return
    const links = this.identityLinks().find((item) => item.userId === userId)
    // 被豁免的主体不再展示（人工解绑的决定优先于任职链的存在）
    const exempted = new Set<string>(this.users().get(userId)?.bindingExemptions ?? [])
    const visible = links.filter((link) => !exempted.has(`${link.provider}|${link.corpId ?? ''}`))
    // 每个主体（provider+corpId）取一条代表链：登录链优先；没有登录链时回落任职链
    // （存量数据在 kind 回填前只有未标记的链，回落后维持「该主体仍绑定」的既有展示语义）。
    const seen = new Map<string, IdentityLinkRecord>()
    for (const link of visible) {
      const key = `${link.provider}|${link.corpId ?? ''}`
      const current = seen.get(key)
      if (!current) { seen.set(key, link); continue }
      // 登录链优先于任职链
      if (current.kind === 'staff' && link.kind !== 'staff') seen.set(key, link)
    }
    this.users().update(userId, {
      bindings: [...seen.values()].map((link) => ({
        provider: link.provider,
        unionId: link.providerUserId,
        displayName: link.displayName,
        boundAt: link.linkedAt,
        ...(link.corpId ? { corpId: link.corpId } : {}),
      })),
    })
  }

  /** 已注册连接器实例清单（多主体：携带 configId/主体名，provider 仅表示平台类型）。 */
  connectorProviders(): Array<{ configId: string; provider: string; label: string; name?: string }> {
    return [...this.connectors.entries()].map(([configId, connector]) => {
      const name = this.connectorConfigById(configId)?.name
      return { configId, provider: connector.provider, label: t(connector.label), ...(name !== undefined ? { name } : {}) }
    })
  }

  // -- 集合 ---------------------------------------------------------------

  orgs(): Collection<OrgRecord> {
    const collection = this.ctx.opsStorage.collection<OrgRecord>('iam:orgs')
    // 同级同名唯一按连接器分区：手工/历史组织（无 connectorId）维持旧口径，
    // 不同主体同步下来的同名部门（两家企业很可能同名）各自落库不撞键。
    collection.uniqueOn('org_same_level_name', (org) => `${String(org.customFields['connectorId'] ?? '')}|${org.parentId ?? '-'}|${org.name}`)
    return collection
  }

  users(): Collection<UserRecord> {
    const collection = this.ctx.opsStorage.collection<UserRecord>('iam:users')
    collection.uniqueOn('user_username', (user) => user.username)
    return collection
  }

  roles(): Collection<RoleRecord> {
    return this.ctx.opsStorage.collection<RoleRecord>('iam:roles')
  }

  groups(): Collection<UserGroupRecord> {
    return this.ctx.opsStorage.collection<UserGroupRecord>('iam:groups')
  }

  connectorConfigs(): Collection<ConnectorConfigRecord> {
    const collection = this.ctx.opsStorage.collection<ConnectorConfigRecord>('iam:connectors')
    // 多主体：同一 provider 可接入多家企业，但 provider|corpId 引擎级唯一（重复主体拒绝）
    collection.uniqueOn('connector_provider_corp', (config) => `${config.provider}|${config.corpId}`)
    return collection
  }

  conflicts(): Collection<SyncConflictRecord> {
    return this.ctx.opsStorage.collection<SyncConflictRecord>('iam:conflicts')
  }

  tenants(): Collection<TenantRecord> {
    const collection = this.ctx.opsStorage.collection<TenantRecord>('iam:tenants')
    collection.uniqueOn('tenant_name', (tenant) => tenant.name)
    return collection
  }

  /** 多租户最小集：默认租户兜底（存量数据全部落 t_default）。 */
  ensureDefaultTenant(): TenantRecord {
    const existing = this.tenants().get(DEFAULT_TENANT_ID)
    if (existing) return existing
    return this.tenants().insert({
      id: DEFAULT_TENANT_ID,
      name: '默认租户',
      status: 'active',
      plan: 'standard',
    })
  }

  // -- 场景级授权（IAW 交接 6-1） ---------------------------------------------

  scenePolicies(): Collection<ScenePolicyRecord> {
    const collection = this.ctx.opsStorage.collection<ScenePolicyRecord>('iam:scenePolicies')
    collection.uniqueOn('scene_org', (policy) => `${policy.sceneCode}|${policy.orgId ?? ''}`)
    return collection
  }

  /**
   * 登记场景授权策略（upsert by sceneCode+orgId，version 乐观锁）：
   * expectedVersion 与存量 version 不一致时拒绝（并发编辑对账）；新建不带 expectedVersion。
   */
  upsertScenePolicy(input: { sceneCode: string; orgId?: string; entries: ScenePolicyEntry[]; note?: string; expectedVersion?: number }): ScenePolicyRecord {
    if (!input.sceneCode?.trim()) throw new Error(t('场景策略 sceneCode 必填（如 QB01-A-2-5）'))
    if (!Array.isArray(input.entries) || input.entries.length === 0) throw new Error(t('场景策略 entries 至少一条（空策略请用 DELETE 移除）'))
    for (const entry of input.entries) {
      if (!['role', 'user'].includes(entry.principalType)) throw new Error(t('策略条目 principalType 非法：{value}（role/user）', { value: entry.principalType }))
      if (!entry.principalId?.trim()) throw new Error(t('策略条目 principalId 必填（roleId/userId/*）'))
      if (!Array.isArray(entry.actions) || entry.actions.length === 0) throw new Error(t('策略条目 actions 至少一项'))
      if (!['allow', 'deny'].includes(entry.effect)) throw new Error(t('策略条目 effect 非法：{value}（allow/deny）', { value: entry.effect }))
      if (entry.principalType === 'role' && entry.principalId !== '*' && !this.roles().get(entry.principalId)) {
        throw new Error(t('策略条目引用的角色不存在：{id}', { id: entry.principalId }))
      }
      if (entry.principalType === 'user' && entry.principalId !== '*' && !this.users().get(entry.principalId)) {
        throw new Error(t('策略条目引用的用户不存在：{id}', { id: entry.principalId }))
      }
    }
    const existing = this.scenePolicies().findOne((item) => item.sceneCode === input.sceneCode && (item.orgId ?? '') === (input.orgId ?? ''))
    if (existing) {
      if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
        throw new Error(t('场景策略版本冲突：当前 v{current}，请求基于 v{expected}（请刷新后重试）', { current: existing.version, expected: input.expectedVersion }))
      }
      const updated = this.scenePolicies().update(existing.id, {
        entries: input.entries,
        ...(input.note !== undefined ? { note: input.note } : {}),
        version: existing.version + 1,
      })
      this.ctx.platformBus.emit(PlatformEvents.IamScenePolicyChanged, { sceneCode: input.sceneCode, orgId: input.orgId ?? null, policyId: updated.id, version: updated.version, action: 'updated' })
      return updated
    }
    const created = this.scenePolicies().insert({
      id: newId('scp'), sceneCode: input.sceneCode,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      entries: input.entries,
      ...(input.note ? { note: input.note } : {}),
      version: 1,
    })
    this.ctx.platformBus.emit(PlatformEvents.IamScenePolicyChanged, { sceneCode: input.sceneCode, orgId: input.orgId ?? null, policyId: created.id, version: 1, action: 'created' })
    return created
  }

  deleteScenePolicy(id: string): { deleted: boolean } {
    const policy = this.scenePolicies().get(id)
    if (!policy) throw new Error(t('场景策略不存在：{id}', { id }))
    this.scenePolicies().remove(id)
    this.ctx.platformBus.emit(PlatformEvents.IamScenePolicyChanged, { sceneCode: policy.sceneCode, orgId: policy.orgId ?? null, policyId: id, action: 'deleted' })
    return { deleted: true }
  }

  /**
   * iam.check(scene, action)（IAW 交接 6-1）：场景维度 ABAC 判定。
   * 判定序：①场景无策略 → default（回落 hasPermission 角色链路，存量行为不变）；
   * ②deny 条目命中（用户/角色/通配 × 动作）→ deny；③allow 命中 → allow；④其余 → deny（fail-closed）。
   * 本判定是场景维度的**细粒度收敛**，不替代角色 RBAC：调用方应同时满足 hasPermission(基础权限点)。
   */
  checkScene(userId: string, sceneCode: string, action: string): SceneCheckDecision {
    const user = this.users().get(userId)
    if (!user) {
      return { decision: 'deny', reason: t('用户不存在：{userId}', { userId }), sceneCode, action }
    }
    const policies = this.scenePolicies().all().filter((item) =>
      item.sceneCode === sceneCode && ((item.orgId ?? '') === '' || item.orgId === user.orgId))
    if (policies.length === 0) {
      return { decision: 'default', reason: t('场景未配置授权策略，回落角色 RBAC 与部门范围权限（存量口径）'), sceneCode, action }
    }
    const matches = (entry: ScenePolicyEntry): boolean =>
      (entry.principalId === '*' && entry.principalType === 'role')
      || (entry.principalType === 'user' && (entry.principalId === '*' || entry.principalId === userId))
      || (entry.principalType === 'role' && user.roleIds.includes(entry.principalId))
    const actionHit = (entry: ScenePolicyEntry): boolean => entry.actions.includes('*') || entry.actions.includes(action)
    for (const policy of policies) {
      for (const entry of policy.entries) {
        if (entry.effect === 'deny' && matches(entry) && actionHit(entry)) {
          return { decision: 'deny', reason: t('场景策略 deny 命中（policy={policyId}）', { policyId: policy.id }), policyId: policy.id, sceneCode, action }
        }
      }
    }
    for (const policy of policies) {
      for (const entry of policy.entries) {
        if (entry.effect === 'allow' && matches(entry) && actionHit(entry)) {
          return { decision: 'allow', reason: t('场景策略 allow 命中（policy={policyId}）', { policyId: policy.id }), policyId: policy.id, sceneCode, action }
        }
      }
    }
    const policy = policies[0]!
    return { decision: 'deny', reason: t('场景已配置授权策略且无命中条目（fail-closed，policy={policyId}）', { policyId: policy.id }), policyId: policy.id, sceneCode, action }
  }

  createTenant(input: { name: string; plan?: TenantRecord['plan'] }): TenantRecord {
    if (!input.name?.trim()) throw new Error(t('租户名称不能为空'))
    if (this.tenants().findOne((tenant) => tenant.name === input.name)) throw new Error(t('租户已存在：{name}', { name: input.name }))
    return this.tenants().insert({
      id: newId('t'),
      name: input.name,
      status: 'active',
      plan: input.plan ?? 'trial',
    })
  }

  /** 租户解析：org → tenant；缺省 t_default（usage/用量报表统一入口）。 */
  tenantOfOrg(orgId: string): string {
    return this.orgs().get(orgId)?.tenantId ?? DEFAULT_TENANT_ID
  }

  // -- 组织 ---------------------------------------------------------------

  orgTree(): OrgTreeNode[] {
    const nodes = new Map<string, OrgTreeNode>()
    for (const org of this.orgs().all()) {
      nodes.set(org.id, { ...org, children: [] })
    }
    const roots: OrgTreeNode[] = []
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) {
        nodes.get(node.parentId)!.children.push(node)
      } else {
        roots.push(node)
      }
    }
    const sortRec = (list: OrgTreeNode[]): OrgTreeNode[] => {
      list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh'))
      for (const item of list) sortRec(item.children)
      return list
    }
    return sortRec(roots)
  }

  createOrg(input: { name: string; parentId?: string | null; order?: number; customFields?: Record<string, string>; tenantId?: string; leaderUserIds?: string[] }, actor?: UserManageActor): OrgRecord {
    if (!input.name?.trim()) throw new Error(t('组织名称不能为空'))
    const parentId = input.parentId ?? null
    if (parentId && !this.orgs().get(parentId)) throw new Error(t('父组织不存在：{id}', { id: parentId }))
    // 挂载点受操作者组织子树约束（N1 与账号管理同口径）；顶级组织（parentId=null）仅平台管理员可建
    this.assertManageScope(actor, parentId ?? undefined, t('创建组织'))
    // 同级同名判重与引擎唯一键同口径：按连接器归属分区（无 connectorId 的手工组织一个分区）。
    const ownerKey = input.customFields?.['connectorId'] ?? ''
    const duplicate = this.orgs().findOne((org) => org.name === input.name && org.parentId === parentId
      && (org.customFields['connectorId'] ?? '') === ownerKey)
    if (duplicate) throw new Error(t('同级下已存在同名组织「{name}」', { name: input.name }))
    const record = this.orgs().insert({
      id: newId('org'),
      name: input.name.trim(),
      parentId,
      order: input.order ?? this.orgs().count() + 1,
      status: 'active',
      customFields: input.customFields ?? {},
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.leaderUserIds !== undefined ? { leaderUserIds: input.leaderUserIds, leaderSource: 'manual' } : {}),
    })
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: 'create', orgId: record.id, name: record.name })
    return record
  }

  /** 维护组织负责人（控制台补录 / leaderVacant 告警后的处置入口）。传空数组即清空并恢复跟随同步。 */
  setOrgLeaders(id: string, leaderUserIds: string[]): OrgRecord {
    this.requireOrg(id)
    const unique = [...new Set(leaderUserIds)]
    for (const userId of unique) {
      if (!this.users().get(userId)) throw new Error(t('负责人账号不存在：{id}', { id: userId }))
    }
    // 手动绑定即锁定：连接器同步不再覆盖（钉钉侧没配负责人的部门靠它补录）；清空 = 恢复跟随同步。
    return unique.length > 0
      ? this.orgs().update(id, { leaderUserIds: unique, leaderSource: 'manual' })
      : this.orgs().update(id, { leaderUserIds: [], leaderSource: 'sync' })
  }

  /** 兼容读取：负责人历史口径 customFields['leaderUserIds']（逗号分隔），结构化字段优先。 */
  leadersOf(orgId: string): string[] {
    const org = this.orgs().get(orgId)
    if (!org) return []
    if (Array.isArray(org.leaderUserIds)) return org.leaderUserIds
    const legacy = String(org.customFields?.['leaderUserIds'] ?? '').trim()
    return legacy ? legacy.split(',').map((item) => item.trim()).filter(Boolean) : []
  }

  renameOrg(id: string, name: string, actor?: UserManageActor): OrgRecord {
    const org = this.requireOrg(id)
    this.assertManageScope(actor, id, t('重命名组织'))
    if (!name?.trim()) throw new Error(t('组织名称不能为空'))
    const trimmed = name.trim()
    // 判重口径同 createOrg：只在同一连接器归属分区内拒绝同名。
    const duplicate = this.orgs().findOne((item) => item.id !== id && item.name === trimmed && item.parentId === org.parentId
      && (item.customFields['connectorId'] ?? '') === (org.customFields['connectorId'] ?? ''))
    if (duplicate) throw new Error(t('同级下已存在同名组织「{name}」', { name: trimmed }))
    const updated = this.orgs().update(id, { name: trimmed })
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: 'rename', orgId: id, name: trimmed })
    return updated
  }

  /** 移动组织（拖拽调岗），含环检测；组织与新上级均须落在操作者子树内（防借移动越界挂载）。 */
  moveOrg(id: string, newParentId: string | null, actor?: UserManageActor): OrgRecord {
    this.requireOrg(id)
    this.assertManageScope(actor, id, t('移动组织'))
    this.assertManageScope(actor, newParentId ?? undefined, t('移动组织到目标上级'))
    if (newParentId) {
      if (newParentId === id) throw new Error(t('不能将组织移动到自身之下'))
      // 父组织存在性校验（QA SEC-03）：不存在时下方环检测会静默放行，产生悬挂 parentId
      if (!this.orgs().get(newParentId)) throw new Error(t('父组织不存在：{id}', { id: newParentId }))
      let cursor: string | null = newParentId
      while (cursor) {
        if (cursor === id) throw new Error(t('不允许形成组织环'))
        cursor = this.orgs().get(cursor)?.parentId ?? null
      }
    }
    const updated = this.orgs().update(id, { parentId: newParentId })
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: 'move', orgId: id })
    return updated
  }

  /**
   * 删除组织。默认仅允许空组织（无子组织且无直属账号）；
   * cascade=true 一键删除整棵子树：子树内组织全部移除，直接挂载的账号上移到
   * 存活的最近上级组织（被删根的父组织；删除根组织时上移到首个存活根组织）。
   */
  deleteOrg(id: string, options?: { cascade?: boolean }, actor?: UserManageActor): { deleted: boolean; removedOrgs: number; movedUsers: number; fallbackOrgId?: string } {
    const org = this.requireOrg(id)
    this.assertManageScope(actor, id, t('删除组织'))
    if (!options?.cascade) {
      if (this.orgs().find((item) => item.parentId === id).length > 0) throw new Error(t('存在子组织，无法删除；请改用「连同子组织一键删除」'))
      if (this.users().find((user) => user.orgId === id).length > 0) throw new Error(t('组织下仍有账号，无法删除；请改用「连同子组织一键删除」（账号将上移到上级组织）'))
      this.orgs().remove(id)
      this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: 'delete', orgId: id, name: org.name })
      return { deleted: true, removedOrgs: 1, movedUsers: 0 }
    }
    const subtree = this.orgSubtreeIds(id)
    const subtreeSet = new Set(subtree)
    // 账号落点：被删根的父组织必然不在子树内（树无环）；删根组织时落到首个存活根组织
    const fallbackOrgId = org.parentId ?? this.orgs().find((item) => !subtreeSet.has(item.id) && !item.parentId)[0]?.id ?? null
    const movedUsers = this.users().find((user) => subtreeSet.has(user.orgId))
    if (!fallbackOrgId && movedUsers.length > 0) throw new Error(t('删除后将没有任何组织可挂载账号，请先把账号迁移到其他组织再删除'))
    if (fallbackOrgId) {
      for (const user of movedUsers) this.users().update(user.id, { orgId: fallbackOrgId })
    }
    for (const orgId of subtree) {
      if (this.orgs().get(orgId)) this.orgs().remove(orgId)
    }
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, {
      kind: 'delete', orgId: id, name: org.name, cascade: true,
      removedOrgs: subtree.length, movedUsers: movedUsers.length,
    })
    return { deleted: true, removedOrgs: subtree.length, movedUsers: movedUsers.length, ...(fallbackOrgId ? { fallbackOrgId } : {}) }
  }

  private requireOrg(id: string): OrgRecord {
    const org = this.orgs().get(id)
    if (!org) throw new Error(t('组织不存在：{id}', { id }))
    return org
  }

  /** 组织子树 id 集合（数据权限范围）。 */
  orgSubtreeIds(rootId: string): string[] {
    const result: string[] = [rootId]
    const walk = (parentId: string): void => {
      for (const org of this.orgs().find((item) => item.parentId === parentId)) {
        result.push(org.id)
        walk(org.id)
      }
    }
    walk(rootId)
    return result
  }

  // -- 账号 ---------------------------------------------------------------

  /**
   * 组织归属校验（QA A-03/N1 fail-closed）：非平台管理员（无 '*'）只允许管理本组织子树内的
   * 账号/组织；机器主体与无法定位组织归属者一律拒绝。actor.orgId（工具桥 `_actor` 注入）
   * 优先，缺省按 userId 反查账号档案。actor 缺失一律拒绝：外部入口（REST 管理路由与工具桥）
   * 必须携带真实调用者身份，服务内部链路（种子/三方同步/SSO 自注册）显式传 SYSTEM_ACTOR。
   */
  private assertManageScope(actor: UserManageActor | undefined, targetOrgId: string | undefined, action: string): void {
    if (!actor) {
      throw new OrgScopeDeniedError(t('账号管理操作缺少操作者身份（{action}）：外部入口必须携带可归因调用者，内部系统链路请显式传入系统身份（组织隔离，QA A-03）', { action }))
    }
    if (actor.permissions.includes('*')) return
    const actorOrgId = actor.orgId ?? (actor.userId ? this.users().get(actor.userId)?.orgId : undefined)
    if (!actorOrgId || !targetOrgId || !this.orgSubtreeIds(actorOrgId).includes(targetOrgId)) {
      throw new OrgScopeDeniedError(t('跨组织账号操作被拒绝（{action}）：目标不在操作者的组织子树内（组织隔离，QA A-03）', { action }))
    }
  }

  /** 口令强度（QA A-08）：建号与重置统一口径——≥8 位且不含中文（此前建号无校验，'123' 可建可登）。 */
  private assertPasswordStrength(password: string): void {
    if (password.trim().length < 8) throw new Error(t('口令长度不得少于 8 位'))
    if (/[\u4e00-\u9fff]/.test(password)) throw new Error(t('口令不得包含中文'))
  }

  /** 创建账号：未显式指定口令时生成随机初始口令（仅本次调用返回，须安全传达给本人）。 */
  createUser(input: {
    username: string
    displayName: string
    orgId: string
    email?: string
    phone?: string
    title?: string
    roleIds?: string[]
    password?: string
    jobNumber?: string
  }, actor?: UserManageActor): { user: UserRecord; initialPassword?: string } {
    if (!input.username?.trim()) throw new Error(t('用户名不能为空'))
    if (!/^[a-z0-9_.-]+$/i.test(input.username)) throw new Error(t('用户名仅支持字母、数字与 _ . -'))
    if (this.users().findOne((user) => user.username === input.username)) throw new Error(t('用户名已存在：{username}', { username: input.username }))
    if (!this.orgs().get(input.orgId)) throw new Error(t('组织不存在：{id}', { id: input.orgId }))
    this.assertManageScope(actor, input.orgId, t('创建账号'))
    // P0-02：建号携带 roleIds 时同样受可授权上限约束（否则绕过 assignRoles 直写角色）
    if (input.roleIds?.length) this.assertGrantCeiling(actor, this.resolveRolePermissions(input.roleIds), t('创建账号'))
    if (input.password !== undefined) this.assertPasswordStrength(input.password)
    const password = input.password ?? generateSecret('init')
    const user = this.users().insert({
      id: newId('usr'),
      username: input.username,
      displayName: input.displayName || input.username,
      email: input.email ?? `${input.username}@yuanbingke.com`,
      phone: input.phone ?? '',
      orgId: input.orgId,
      title: input.title ?? '',
      status: 'pending',
      roleIds: input.roleIds ?? [],
      passwordSalt: '',
      passwordHash: hashPasswordScrypt(password),
      bindings: [],
      // 仅当调用方显式给了口令（有人拿到明文）才标记；随机生成的初始口令未下发，不算已知
      ...(input.password !== undefined ? { passwordKnown: true } : {}),
      ...(input.jobNumber !== undefined ? { jobNumber: input.jobNumber } : {}),
    })
    return input.password ? { user } : { user, initialPassword: password }
  }

  /** 重置口令：不传 password 则生成随机初始口令；传入则设置为指定口令（均仅本次返回明文）。 */
  resetPassword(id: string, password?: string, actor?: UserManageActor): { user: UserRecord; initialPassword: string } {
    const user = this.requireUser(id)
    this.assertManageScope(actor, user.orgId, t('重置口令'))
    if (user.status === 'deactivated') throw new Error(t('账号已注销，无法重置口令'))
    if (password !== undefined) this.assertPasswordStrength(password)
    const next = password ?? generateSecret('init')
    // 重置口令的明文会一次性回显给操作者（由人转达），因此视为「已知口令」
    this.users().update(id, { passwordSalt: '', passwordHash: hashPasswordScrypt(next), passwordKnown: true })
    // P1-08（安全审查 2026-10-31）：重置口令联动撤销该账号全部既有会话——旧 access 即时失效、
    // 旧 refresh 不得再换新令牌、以其为 sub 的委托令牌同批吊销。经平台事件解耦（跨插件联动
    // 不直连，authn 侧订阅后执行吊销并落审计），与「冻结即吊销」同一通道。
    this.ctx.platformBus.emit(PlatformEvents.UserPasswordReset, { userId: id, username: user.username })
    return { user: this.users().get(id)!, initialPassword: next }
  }

  importUsers(items: Array<{ username: string; displayName: string; orgId: string; title?: string; email?: string }>, actor?: UserManageActor): { created: UserRecord[]; skipped: string[] } {
    const created: UserRecord[] = []
    const skipped: string[] = []
    for (const item of items) {
      if (this.users().findOne((user) => user.username === item.username)) {
        skipped.push(item.username)
        continue
      }
      created.push(this.createUser(item, actor).user)
    }
    return { created, skipped }
  }

  activateUser(id: string, actor?: UserManageActor): UserRecord {
    const user = this.requireUser(id)
    this.assertManageScope(actor, user.orgId, t('激活账号'))
    if (user.status !== 'pending') throw new Error(t('仅待激活账号可激活'))
    return this.users().update(id, { status: 'active' })
  }

  freezeUser(id: string, reason: string, actor?: UserManageActor): UserRecord {
    const user = this.requireUser(id)
    this.assertManageScope(actor, user.orgId, t('冻结账号'))
    if (!reason?.trim()) throw new Error(t('冻结必须填写原因（审计要求）'))
    const updated = this.users().update(id, { status: 'frozen', frozenReason: reason })
    this.ctx.platformBus.emit(PlatformEvents.UserFrozen, { userId: id, username: updated.username, reason })
    return updated
  }

  unfreezeUser(id: string, actor?: UserManageActor): UserRecord {
    const user = this.requireUser(id)
    this.assertManageScope(actor, user.orgId, t('解冻账号'))
    const updated = this.users().update(id, { status: 'active', frozenReason: undefined })
    this.ctx.platformBus.emit(PlatformEvents.UserActivated, { userId: id })
    return updated
  }

  deactivateUser(id: string, reason: string, actor?: UserManageActor): UserRecord {
    const user = this.requireUser(id)
    this.assertManageScope(actor, user.orgId, t('注销账号'))
    if (!reason?.trim()) throw new Error(t('注销必须填写原因'))
    const updated = this.users().update(id, { status: 'deactivated', frozenReason: reason })
    this.ctx.platformBus.emit(PlatformEvents.UserFrozen, { userId: id, username: updated.username, reason: t('注销：{reason}', { reason }) })
    return updated
  }

  updateUser(id: string, patch: Partial<Pick<UserRecord, 'displayName' | 'email' | 'phone' | 'title' | 'orgId' | 'accountType' | 'primaryOrgId'>>, actor?: UserManageActor): UserRecord {
    // 白名单收敛（QA SEC-01）：PATCH 编辑仅接受档案类字段，与上方 TS 签名一致；
    // status/passwordHash/passwordSalt/username/id 等字段原样落库会造成越权改状态、植入口令
    // （账号接管），此处显式拒绝并点名被拒字段（诚实拒绝，不静默忽略）。
    const allowedFields = ['displayName', 'email', 'phone', 'title', 'orgId', 'accountType', 'primaryOrgId']
    const rejected = Object.keys(patch ?? {}).filter((key) => !allowedFields.includes(key))
    if (rejected.length > 0) {
      throw new Error(t('账号编辑不接受以下字段：{fields}（状态请走冻结/解冻/激活/注销端点，口令请走重置口令端点，角色请走角色分配接口）', { fields: rejected.join('、') }))
    }
    const user = this.requireUser(id)
    this.assertManageScope(actor, user.orgId, t('修改账号'))
    if (patch.orgId) {
      if (!this.orgs().get(patch.orgId)) throw new Error(t('组织不存在：{id}', { id: patch.orgId }))
      // 迁移目标组织同样受操作者组织子树约束（防止借「改归属」把账号挪出隔离域）
      this.assertManageScope(actor, patch.orgId, t('迁移账号组织'))
    }
    if (patch.primaryOrgId && !this.orgs().get(patch.primaryOrgId)) throw new Error(t('主归属组织不存在：{id}', { id: patch.primaryOrgId }))
    if (patch.accountType !== undefined && !['internal', 'external', 'suspended-review'].includes(patch.accountType)) {
      throw new Error(t('非法账号类型：{type}', { type: patch.accountType }))
    }
    return this.users().update(id, patch)
  }

  deleteUser(id: string, actor?: UserManageActor): boolean {
    const user = this.requireUser(id)
    this.assertManageScope(actor, user.orgId, t('删除账号'))
    if (user.status !== 'deactivated') throw new Error(t('仅已注销账号可物理删除'))
    return this.users().remove(id)
  }

  /**
   * 绑定三方身份：事实源为 identityLinks（引擎级唯一约束），user.bindings 为投影。
   *
   * 安全审查 P1-05（2026-10-31）：
   *   ① 代他人绑定收敛为平台超级管理员（'*'）——手工绑定写入的是调用方声明的任意 unionId，
   *      组织管理员若能给他人账号挂自己的三方身份，即可经三方登录接管该账号（含超管）。
   *      组织管理员的合规通道是扫码授权（/api/auth/sso/bind/authorize，被绑定身份=扫码人本人）
   *      与连接器同步；本端点自绑（id=操作者本人）不受限。
   *   ② 移除伪「二次验证码」校验——旧逻辑只查 '000000'/6 位格式，从未对应真实挑战
   *      （验证码形同虚设）。verifyCode 参数保留接收（前端兼容），不再声明安全语义。
   */
  bindThirdParty(id: string, binding: { provider: ThirdPartyBinding['provider']; unionId: string; displayName: string; corpId?: string; verifyCode?: string }, actor?: UserManageActor): UserRecord {
    const user = this.requireUser(id)
    this.assertManageScope(actor, user.orgId, t('绑定三方身份'))
    const selfBind = actor?.userId !== undefined && actor.userId === id
    if (!selfBind && !actor?.permissions.includes('*')) {
      throw new OrgScopeDeniedError(t('为其他账号手工绑定三方身份仅限平台超级管理员（防借三方登录接管他人账号，安全审查 P1-05）；请走扫码授权或连接器同步通道'))
    }
    // corpId 缺省取该 provider 已配置主体的 corpId（控制台手工绑定即针对已接入主体），
    // 保证「一人一号」唯一约束（provider|corpId|providerUserId）对存量链接生效。
    const corpId = binding.corpId ?? this.connectorConfig(binding.provider)?.corpId ?? ''
    // 已占用判定以 identityLinks 的「登录链」为准（投影可能因解绑重建而滞后）：
    // 同一 provider+corpId 已有登录链即视为已绑定。任职链（staff）不算占用——
    // 它描述的是岗位事实，用户解绑登录身份后重新绑定登录身份是允许的（任职链保留不动）。
    const occupied = this.identityLinks().findOne((link) => link.userId === id
      && link.provider === binding.provider
      && link.kind !== 'staff'
      && (link.corpId ?? '') === corpId)
    if (occupied) {
      throw new Error(t('该账号已绑定{provider}身份，请先解绑', { provider: binding.provider }))
    }
    // 一人一号：目标三方身份若已绑定其他账号，提前给出可读错误（引擎唯一约束仍兜底）。
    // 只看登录链：任职链（staff）是岗位事实，同一自然人在别的主体/岗位出现属正常，
    // 拿它判「一人一号」会误报。
    const taken = this.identityLinks().findOne((link) => link.provider === binding.provider
      && link.providerUserId === binding.unionId
      && link.kind !== 'staff'
      && (link.corpId ?? '') === corpId)
    if (taken && taken.userId !== id) {
      throw new Error(t('该三方身份已绑定其他平台账号（一人一号），请先解除对方绑定'))
    }
    // 唯一约束冲突由存储引擎兜底（同一主体下同一三方身份只能映射一个账号）
    this.linkIdentity(id, {
      provider: binding.provider,
      providerUserId: binding.unionId,
      corpId,
      displayName: binding.displayName,
    }, 'console')
    return this.users().get(id)!
  }

  /**
   * 解除三方绑定（管理面）。corpId 缺省=该 provider 全部主体（管理员显式选择「解绑钉钉」）。
   * 解绑后写入豁免，避免连接器同步把链接自动补回。
   * 安全审查 P1-05：移除伪验证码校验（旧逻辑只查 6 位格式、从未对应真实挑战）；解绑本身
   * 不授予访问权（只影响登录方式，且「最后登录方式需先设口令」反锁定护栏在 performUnbind），
   * 配合 bindThirdParty 收敛为 '*' 后，解绑不再构成账号接管链的一环。
   */
  unbindThirdParty(id: string, provider: ThirdPartyBinding['provider'], verifyCode: string, actor?: UserManageActor, corpId?: string): UserRecord {
    const user = this.requireUser(id)
    this.assertManageScope(actor, user.orgId, t('解绑三方身份'))
    void verifyCode
    return this.performUnbind(user, provider, corpId)
  }

  /**
   * 本人自助解绑（无 iam.user.write 的业务同学在面板里解绑自己的钉钉）。
   * 与 unbindThirdParty 的唯一差别是不做组织子树校验——操作对象恒为调用者本人，
   * 由路由层从会话取 userId（不接受请求体指定），因此不存在越权面。
   */
  unbindOwnThirdParty(userId: string, provider: ThirdPartyBinding['provider'], verifyCode: string, corpId?: string): UserRecord {
    const user = this.requireUser(userId)
    if (!verifyCode || verifyCode.length !== 6) throw new Error(t('解绑需二次验证（6 位验证码）'))
    return this.performUnbind(user, provider, corpId)
  }

  /** 解绑实际执行（含反锁定护栏：先判后删，不留中间态）。 */
  private performUnbind(user: UserRecord, provider: ThirdPartyBinding['provider'], corpId?: string): UserRecord {
    const targets = this.identityLinks().find((link) => link.userId === user.id
      && link.provider === provider
      && (corpId === undefined || (link.corpId ?? '') === corpId)
      && link.kind !== 'staff')
    if (targets.length === 0) {
      throw new Error(t('该账号未绑定{provider}身份', { provider }))
    }
    // 反锁定护栏：三方身份是 SSO 自注册/通讯录同步账号唯一已知的登录凭据
    // （创建时的随机口令从未下发给人）。解绑后若既不剩任何三方绑定、又没有已知口令，
    // 账号将永久无法登录且管理员无从补救——在这里拦住，并告知先设口令。
    const remainingLinks = this.identityLinks().find((link) => link.userId === user.id
      && link.kind !== 'staff'
      && !targets.some((target) => target.id === link.id))
    if (remainingLinks.length === 0 && !this.hasUsablePassword(user)) {
      throw new Error(t('这是该账号唯一的登录方式，解绑后将无法登录。请先为账号设置口令（管理员重置口令），再解绑三方身份'))
    }
    this.unlinkIdentity(user.id, provider, corpId)
    return this.users().get(user.id)!
  }

  /**
   * 账号是否有可用口令（可用于账号密码登录）。
   * 依据是 passwordKnown 标记（有人拿到过明文），不是用户名形态——通讯录同步创建的账号
   * 用户名是工号、口令同为随机值，按形态判断会把它们误判成「有已知口令」而放行解绑。
   */
  private hasUsablePassword(user: UserRecord): boolean {
    return Boolean(user.passwordHash) && user.passwordKnown === true
  }

  /**
   * 账号清单（N3 组织管理员读面收敛）：orgId 展开为其组织子树过滤；scopeOrgIds（调用方可见
   * 组织集合，控制台层由 scopedOrgIdsOf 计算）传入时做交集——非平台管理员只看得到管辖子树
   * 内的账号。两者缺省不过滤（平台管理员/服务内部调用，保持既有全量口径）。
   */
  listUsers(input: { orgId?: string; status?: string; q?: string; scopeOrgIds?: string[] } = {}): UserRecord[] {
    const orgScope = input.orgId ? new Set(this.orgSubtreeIds(input.orgId)) : undefined
    const allowScope = input.scopeOrgIds ? new Set(input.scopeOrgIds) : undefined
    const q = input.q?.toLowerCase()
    return this.users().find((user) => {
      if (input.status && user.status !== input.status) return false
      if (orgScope && !orgScope.has(user.orgId)) return false
      if (allowScope && !allowScope.has(user.orgId)) return false
      if (q && !`${user.displayName}${user.username}${user.email}`.toLowerCase().includes(q)) return false
      return true
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  verifyPassword(username: string, password: string): UserRecord {
    const user = this.users().findOne((item) => item.username === username)
    if (!user) throw new Error(t('用户名或密码错误'))
    if (!verifyPasswordHash(user, password)) throw new Error(t('用户名或密码错误'))
    // 透明升级（A-09）：旧格式（裸 sha256）验证通过即重哈希为 scrypt——存量用户无感迁移，
    // 下一次登录起新格式生效；升级失败不阻断登录（下次再试）。
    if (!user.passwordHash.startsWith(SCRYPT_PREFIX)) {
      try {
        this.users().update(user.id, { passwordSalt: '', passwordHash: hashPasswordScrypt(password) })
      } catch { /* 升级失败保持旧哈希，验证已通过不阻断 */ }
    }
    if (user.status === 'frozen') throw new Error(t('账号已冻结：{reason}', { reason: user.frozenReason ?? t('联系管理员') }))
    if (user.status === 'deactivated') throw new Error(t('账号已注销'))
    if (user.status === 'pending') throw new Error(t('账号待激活，请联系管理员'))
    return user
  }

  markLogin(id: string): void {
    this.users().update(id, { lastLoginAt: new Date().toISOString() })
  }

  private requireUser(id: string): UserRecord {
    const user = this.users().get(id)
    if (!user) throw new Error(t('账号不存在：{id}', { id }))
    return user
  }

  // -- 角色 ---------------------------------------------------------------

  /**
   * 存量账号口令已知性回填（幂等，2026-10-22 解绑护栏配套）：
   * `passwordKnown` 是本批次新增字段，存量账号没有它。若把「缺字段」直接当成 false，
   * 所有既有账号都会被判成「只能靠三方登录」，解绑功能对它们等于全程被拒。
   *
   * 回填口径（保守向可用性倾斜，但不放宽真正的风险面）：
   *   - 已有任意三方绑定的账号 → 不标记（解绑护栏照常生效，只有当它是唯一登录方式时拦）；
   *   - 没有任何三方绑定的账号 → 标记 true（它本来就只能靠口令登录，说明口令是已知的）。
   */
  backfillPasswordKnown(): number {
    const collection = this.ctx.opsStorage.collection<RecordBase & { key: string }>('iam:migrations')
    if (collection.findOne((item) => item.key === 'password-known-v1')) return 0
    let touched = 0
    for (const user of this.users().all()) {
      if (user.passwordKnown !== undefined) continue
      if ((user.bindings ?? []).length === 0 && user.passwordHash) {
        this.users().update(user.id, { passwordKnown: true })
        touched++
      }
    }
    collection.insert({ id: newId('mig'), key: 'password-known-v1', note: `backfilled ${touched}` })
    return touched
  }

  /**
   * 存量身份链的 kind 回填（幂等，2026-10-22 解绑能力配套）。
   *
   * 本批次新增了 kind 字段区分「登录链」与「任职链」，存量链没有该字段。回填依据两条事实：
   *   1. 同一 (provider, corpId, userId) 下若有多条链，则登录链是 unionId 形态、任职链是 userid 形态
   *      （钉钉 unionId 形如 dd_uXXX，userid 形如 staff_XXX）——这是同步写链的既有约定；
   *   2. 形态判据兜底：providerUserId 命中该主体任一部门的负责人 userid 列表（managerRemoteIds）→ 任职链。
   * 回填后解绑只动登录链，任职链（部门负责人反查、NAS 数据权限身份反查）保持不动。
   */
  backfillIdentityLinkKinds(): number {
    const links = this.identityLinks().all()
    const groupOf = (link: IdentityLinkRecord) => `${link.provider}|${link.corpId ?? ''}|${link.userId}`
    const groups = new Map<string, IdentityLinkRecord[]>()
    for (const link of links) {
      const key = groupOf(link)
      const list = groups.get(key) ?? []
      list.push(link)
      groups.set(key, list)
    }
    // 部门负责人引用的是三方 userid（managerRemoteIds 口径）→ 这些 id 属任职链
    const staffIds = new Set<string>()
    for (const org of this.orgs().all()) {
      for (const id of this.leadersOf(org.id)) {
        // 负责人已反查为平台 userId，无法据此判定；此处仅收集形如 staff_ 的三方 id（同步前的旧口径残留）
        if (/^(staff|user|ou_)/i.test(id)) staffIds.add(id)
      }
    }
    let touched = 0
    for (const group of groups.values()) {
      // 多链组：unionId 形态=登录链，其余=任职链
      const isUnionShape = (id: string) => /^(dd_u|ou_|union)/i.test(id) || !/^(staff|user)/i.test(id)
      for (const link of group) {
        if (link.kind !== undefined) continue
        const kind: 'login' | 'staff' = (group.length > 1 && !isUnionShape(link.providerUserId))
          || staffIds.has(link.providerUserId)
          ? 'staff' : 'login'
        this.identityLinks().update(link.id, { kind })
        touched++
      }
    }
    return touched
  }

  ensureBuiltinRoles(): void {
    for (const role of BuiltinRoles) {
      if (!this.roles().findOne((item) => item.code === role.code)) {
        this.roles().insert({ id: newId('rol'), ...role })
      }
    }
  }

  /**
   * 内置角色权限迁移（幂等）：给已落库的 resource_admin/developer/auditor 补齐连接器纳管
   * 权限点。只补缺不覆盖；迁移标记入 iam:migrations 集合供观测（P2 修正⑯）。
   */
  ensureConnectorPermissionsMigration(): { applied: boolean; touched: string[] } {
    const collection = this.ctx.opsStorage.collection<RecordBase & { key: string; note?: string }>('iam:migrations')
    const marker = collection.findOne((item) => item.key === 'connector-permissions-v1')
    const touched: string[] = []
    for (const [code, additions] of Object.entries(BUILTIN_ROLE_MIGRATION)) {
      const role = this.roles().findOne((item) => item.code === code)
      if (!role) continue
      const missing = additions.filter((point) => !role.permissions.includes(point))
      if (missing.length > 0) {
        this.roles().update(role.id, { permissions: [...role.permissions, ...missing] })
        this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: 'builtin_role_migration', roleId: role.id })
        touched.push(`${code}+${missing.join(',')}`)
      }
    }
    // 通配语义复查：resource_admin 持有 mcp.* 形态的通配时 userPermissions 已可展开 connector.*
    // （旧库存量不含 connector.*），故此处显式并入该通配保证无需逐点追加。
    const resourceAdmin = this.roles().findOne((item) => item.code === 'resource_admin')
    if (resourceAdmin && !resourceAdmin.permissions.includes('connector.*')) {
      this.roles().update(resourceAdmin.id, { permissions: [...resourceAdmin.permissions, 'connector.*'] })
      this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: 'builtin_role_migration', roleId: resourceAdmin.id })
      touched.push('resource_admin+connector.*')
    }
    if (!marker) {
      collection.insert({
        id: newId('mig'), key: 'connector-permissions-v1',
        ...(touched.length > 0 ? { note: touched.join('; ') } : {}),
      })
    }
    return { applied: marker === undefined || touched.length > 0, touched }
  }

  /**
   * 可授权权限上限（安全审查 P0-02，2026-10-31）：非平台超级管理员（无 '*'）的操作者，
   * 只能授予/管理自己本身已持有的权限点——组织管理员（iam.*）不得把任何账号提为平台超管、
   * 不得授予自己没有的跨域能力、不得创建/编辑含 '*' 或超出自身权限集的角色。
   * actor.permissions 为解析后的字面量点集（'*' 仅平台超管持有）；requested 允许通配形态，
   * 逐点展开后比对。REST 与工具桥等一切外部入口共用（服务层单点裁决）。
   */
  private assertGrantCeiling(actor: UserManageActor | undefined, requested: string[], action: string): void {
    if (!actor) {
      throw new OrgScopeDeniedError(t('角色管理操作缺少操作者身份（{action}）：外部入口必须携带可归因调用者，内部系统链路请显式传入系统身份（防提权，安全审查 P0-02）', { action }))
    }
    if (actor.permissions.includes('*')) return
    const owned = new Set(actor.permissions)
    for (const permission of requested) {
      if (permission === '*') {
        throw new OrgScopeDeniedError(t('仅平台超级管理员可授予/配置全量权限「*」（{action}，防提权）', { action }))
      }
      if (permission.endsWith('.*')) {
        const prefix = permission.slice(0, -2)
        const leaked = PermissionCatalog.filter((item) => item.point.startsWith(`${prefix}.`) && !owned.has(item.point)).map((item) => item.point)
        if (leaked.length > 0) {
          throw new OrgScopeDeniedError(t('超出可授权上限（{action}）：操作者未持有 {points}（不可授予自身没有的权限，防提权）', { action, points: leaked.slice(0, 5).join('、') }))
        }
      } else if (!owned.has(permission)) {
        throw new OrgScopeDeniedError(t('超出可授权上限（{action}）：操作者未持有权限点 {point}（不可授予自身没有的权限，防提权）', { action, point: permission }))
      }
    }
  }

  /** 非平台超管不得改动「组织子树外账号仍挂载的角色」——防止借编辑共享角色影响其他组织持有人（P0-02）。 */
  private assertRoleHolderScope(actor: UserManageActor | undefined, roleId: string, action: string): void {
    if (!actor || actor.permissions.includes('*')) return
    const actorOrgId = actor.orgId ?? (actor.userId ? this.users().get(actor.userId)?.orgId : undefined)
    if (!actorOrgId) throw new OrgScopeDeniedError(t('角色管理操作缺少操作者组织归属（{action}）', { action }))
    const allowed = new Set(this.orgSubtreeIds(actorOrgId))
    const outside = this.users().find((user) => user.roleIds.includes(roleId) && !allowed.has(user.orgId))
    if (outside.length > 0) {
      throw new OrgScopeDeniedError(t('该角色仍被本组织子树外的账号挂载（{action}被拒绝）：{names} 等——请由平台超级管理员处理', { action, names: outside.slice(0, 3).map((user) => user.displayName).join('、') }))
    }
  }

  createRole(input: { code: string; name: string; description?: string; permissions: string[] }, actor?: UserManageActor): RoleRecord {
    if (!input.code || !/^[a-z0-9_]+$/.test(input.code)) throw new Error(t('角色 code 仅支持小写字母/数字/下划线'))
    if (this.roles().findOne((role) => role.code === input.code)) throw new Error(t('角色 code 已存在：{code}', { code: input.code }))
    this.assertPermissions(input.permissions)
    this.assertGrantCeiling(actor, input.permissions, t('创建角色'))
    return this.roles().insert({
      id: newId('rol'),
      code: input.code,
      name: input.name,
      builtin: false,
      description: input.description ?? '',
      permissions: input.permissions,
    })
  }

  updateRole(id: string, patch: { name?: string; description?: string; permissions?: string[] }, actor?: UserManageActor): RoleRecord {
    const role = this.roles().get(id)
    if (!role) throw new Error(t('角色不存在：{id}', { id }))
    if (role.builtin && patch.permissions) throw new Error(t('内置角色的权限不可修改'))
    if (patch.permissions) this.assertPermissions(patch.permissions)
    if (patch.permissions) {
      // P0-02：编辑角色等价于对全部持有人一次性改权——上限校验用「改后权限集」整体裁决，
      // 并拒绝改动组织子树外账号仍挂载的角色（防止借共享角色跨组织提权）
      this.assertGrantCeiling(actor, patch.permissions, t('编辑角色'))
      this.assertRoleHolderScope(actor, id, t('编辑角色'))
    }
    const updated = this.roles().update(id, patch)
    this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: 'role', roleId: id })
    return updated
  }

  /**
   * 删除自定义角色（2026-10-14 路线图 R4 删除面补齐）：角色治理此前只增不改不删——
   * 试错/演示产生的废角色永久滞留目录。三重护栏：
   *   ① 内置角色不可删（平台基线，删掉会让新装库与存量库 RBAC 面分叉）；
   *   ② 仍有账号挂载时不可删（删了会把挂载者权限整体蒸发，须先解绑）；
   *   ③ 不存在即拒（与 updateRole 同口径，不静默成功）。
   */
  deleteRole(id: string, actor?: UserManageActor): void {
    const role = this.roles().get(id)
    if (!role) throw new Error(t('角色不存在：{id}', { id }))
    if (role.builtin) throw new Error(t('内置角色「{name}」不可删除（平台基线；如需收敛权限请走角色编辑）', { name: role.name }))
    // P0-02：删除前校验持有人作用域（当前无挂载时恒过；与编辑同口径防跨组织治理干扰）
    this.assertRoleHolderScope(actor, id, t('删除角色'))
    const holders = this.users().all().filter((user) => user.roleIds.includes(id))
    if (holders.length > 0) {
      throw new Error(t('角色「{name}」仍被 {count} 个账号挂载（{names} 等），请先在账号管理中解除后再删除', { name: role.name, count: holders.length, names: holders.slice(0, 5).map((user) => user.displayName).join('、') }))
    }
    this.roles().remove(id)
    this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: 'role', roleId: id })
  }

  private assertPermissions(permissions: string[]): void {
    for (const permission of permissions) {
      if (permission === '*' || permission.endsWith('.*')) continue
      if (!PermissionCatalog.some((item) => item.point === permission)) {
        throw new Error(t('未知权限点：{permission}', { permission }))
      }
    }
  }

  assignRoles(userId: string, roleIds: string[], actor?: UserManageActor): UserRecord {
    const user = this.requireUser(userId)
    this.assertManageScope(actor, user.orgId, t('调整角色'))
    for (const roleId of roleIds) {
      if (!this.roles().get(roleId)) throw new Error(t('角色不存在：{id}', { id: roleId }))
    }
    // P0-02：按「角色解析后的实际权限点」做可授权上限裁决——角色粒度绕不过（把 super_admin
    // 或任何含操作者未持权限点的角色分配给本组织任意账号，均在此拒绝；含 '*' 的角色解析即 '*'）
    this.assertGrantCeiling(actor, this.resolveRolePermissions(roleIds), t('分配角色'))
    const updated = this.users().update(userId, { roleIds })
    this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: 'user_roles', userId })
    return updated
  }

  /** 解析一组角色的实际权限点集合（并集，支持通配）；人机两侧共用同一解析规则。 */
  resolveRolePermissions(roleIds: string[]): string[] {
    const result = new Set<string>()
    for (const roleId of roleIds) {
      const role = this.roles().get(roleId)
      if (!role) continue
      if (role.permissions.includes('*')) return ['*']
      for (const permission of role.permissions) {
        if (permission.endsWith('.*')) {
          const prefix = permission.slice(0, -2)
          for (const item of PermissionCatalog) {
            if (item.point.startsWith(`${prefix}.`)) result.add(item.point)
          }
        } else {
          result.add(permission)
        }
      }
    }
    return [...result]
  }

  /** 计算用户的实际权限点集合（角色并集，支持通配）。 */
  userPermissions(userId: string): string[] {
    const user = this.users().get(userId)
    if (!user) return []
    return this.resolveRolePermissions(user.roleIds)
  }

  hasPermission(userId: string, point: string): boolean {
    const permissions = this.userPermissions(userId)
    return permissions.includes('*') || permissions.includes(point)
  }

  // -- 用户组 -------------------------------------------------------------

  createGroup(input: { name: string; type: 'static' | 'dynamic'; rule?: UserGroupRule; memberIds?: string[]; description?: string }): UserGroupRecord {
    if (!input.name?.trim()) throw new Error(t('用户组名称不能为空'))
    if (this.groups().findOne((group) => group.name === input.name)) throw new Error(t('用户组已存在：{name}', { name: input.name }))
    if (input.type === 'dynamic' && !input.rule) throw new Error(t('动态用户组必须提供圈人规则'))
    return this.groups().insert({
      id: newId('grp'),
      name: input.name,
      type: input.type,
      ...(input.rule !== undefined ? { rule: input.rule } : {}),
      memberIds: input.type === 'static' ? (input.memberIds ?? []) : [],
      description: input.description ?? '',
    })
  }

  updateGroup(id: string, patch: { name?: string; memberIds?: string[]; rule?: UserGroupRule; description?: string }): UserGroupRecord {
    const group = this.groups().get(id)
    if (!group) throw new Error(t('用户组不存在：{id}', { id }))
    return this.groups().update(id, patch)
  }

  deleteGroup(id: string): boolean {
    return this.groups().remove(id)
  }

  /** 解析用户组成员（动态组按规则实时圈人）。 */
  resolveGroupMembers(id: string): UserRecord[] {
    const group = this.groups().get(id)
    if (!group) throw new Error(t('用户组不存在：{id}', { id }))
    if (group.type === 'static') {
      return group.memberIds
        .map((memberId) => this.users().get(memberId))
        .filter((user): user is UserRecord => Boolean(user) && user!.status === 'active')
    }
    const rule = group.rule ?? {}
    const orgIds = rule.orgIds?.length ? new Set(this.orgSubtreeIds(rule.orgIds[0]!).concat(rule.orgIds)) : undefined
    return this.users().find((user) => {
      if (user.status !== 'active') return false
      if (orgIds && !orgIds.has(user.orgId)) return false
      if (rule.title && user.title !== rule.title) return false
      return true
    })
  }

  groupsOfUser(userId: string): UserGroupRecord[] {
    return this.groups().find((group) => {
      if (group.type === 'static') return group.memberIds.includes(userId)
      return this.resolveGroupMembers(group.id).some((user) => user.id === userId)
    })
  }

  /** 动态用户组成员快照（dev-plan-nas-authz §2.2：重算结果落快照，漂移可观测）。 */
  groupSnapshots(): Collection<GroupSnapshotRecord> {
    return this.ctx.opsStorage.collection<GroupSnapshotRecord>('iam:groupSnapshots')
  }

  /**
   * 重算全部动态用户组成员并与快照比对（连接器同步收尾 / REST 手动触发）。
   * 漂移人数 ≥ 阈值（组上 driftAlertThreshold，缺省 5）或组被标记为 NAS C 关联组（authzRoleC）
   * 时发 `nas.authz.cGroupDrift` 事件——防止 HR 调整静默改变跨域只读范围。
   * 返回本次发生漂移的组清单（含增减明细），供调用方展示/断言。
   */
  refreshGroupSnapshots(actor: string): Array<{ groupId: string; groupName: string; added: string[]; removed: string[]; threshold: number; alerted: boolean }> {
    const drifts: Array<{ groupId: string; groupName: string; added: string[]; removed: string[]; threshold: number; alerted: boolean }> = []
    for (const group of this.groups().find((item) => item.type === 'dynamic')) {
      const memberIds = this.resolveGroupMembers(group.id).map((user) => user.id).sort()
      const existing = this.groupSnapshots().findOne((item) => item.groupId === group.id)
      const previous = existing?.memberIds ?? null
      if (previous !== null) {
        const prevSet = new Set(previous)
        const nextSet = new Set(memberIds)
        const added = memberIds.filter((id) => !prevSet.has(id))
        const removed = previous.filter((id) => !nextSet.has(id))
        if (added.length > 0 || removed.length > 0) {
          const threshold = group.driftAlertThreshold ?? DEFAULT_GROUP_DRIFT_THRESHOLD
          // C 关联组任何幅度的漂移都告警（跨域只读范围敏感）；其余组按阈值
          const alerted = group.authzRoleC === true || (added.length + removed.length) >= threshold
          if (alerted) {
            this.ctx.platformBus.emit('nas.authz.cGroupDrift', {
              groupId: group.id, groupName: group.name, added, removed,
              addedCount: added.length, removedCount: removed.length, threshold, actor,
            })
          }
          drifts.push({ groupId: group.id, groupName: group.name, added, removed, threshold, alerted })
        }
      }
      const record: GroupSnapshotRecord = { id: existing?.id ?? `gsn_${group.id}`, groupId: group.id, memberIds, computedAt: new Date().toISOString() }
      if (existing) this.groupSnapshots().update(existing.id, record)
      else this.groupSnapshots().insert(record)
    }
    return drifts
  }

  // -- 三方接入 -----------------------------------------------------------

  /** 按平台类型取第一条配置（旧调用兼容；多主体请用 connectorConfigById/resolveConnectorConfig）。 */
  connectorConfig(provider: string): ConnectorConfigRecord | undefined {
    return this.connectorConfigs().findOne((config) => config.provider === provider)
  }

  /** 按配置实例 id 寻址（多主体：配置实例以 ConnectorConfigRecord.id 寻址，provider 仅表示平台类型）。 */
  connectorConfigById(id: string): ConnectorConfigRecord | undefined {
    return this.connectorConfigs().get(id)
  }

  /** 解析配置实例：先按 id 找，找不到按 provider 取第一条（enabled 优先）——REST 旧参数兼容入口。 */
  resolveConnectorConfig(idOrProvider: string): ConnectorConfigRecord | undefined {
    const byId = this.connectorConfigById(idOrProvider)
    if (byId) return byId
    const candidates = this.connectorConfigs().find((config) => config.provider === idOrProvider)
    return candidates.find((config) => config.enabled) ?? candidates[0]
  }

  /** 更新/创建接入配置：带 id 按 id 更新；不带 id 维持旧行为（按 provider 第一条更新，无则建）。 */
  upsertConnectorConfig(input: {
    /** 配置实例 id（多主体按 id 更新；缺省=旧的按 provider 第一条语义）。 */
    id?: string
    provider: 'dingtalk' | 'feishu' | 'wecom'
    /** 主体名称（缺省 `${provider}-${corpId}`）。 */
    name?: string
    corpId: string
    appKey: string
    appSecret?: string
    enabled?: boolean
    syncOrgRoot?: string
    intervalMinutes?: number
    callbackUrl?: string
    loginEnabled?: boolean
    conflictStrategy?: ConnectorConfigRecord['conflictStrategy']
    /** real=真实 OpenAPI（需真实企业凭证）；mock=演示降级。 */
    mode?: 'real' | 'mock'
    /** OpenAPI 基址覆盖（测试/专有部署）。 */
    apiBase?: string
    /** 通讯录 topapi 基址覆盖（默认 https://oapi.dingtalk.com）。 */
    oapiBase?: string
    /** 同步树挂载的目标组织 ID（空=平台根）。 */
    targetOrgId?: string
  }): ConnectorConfigRecord {
    if (!IamService.BUILTIN_CONNECTOR_PROVIDERS.has(input.provider)) throw new Error(t('未注册的连接器：{provider}', { provider: input.provider }))
    let existing: ConnectorConfigRecord | undefined
    if (input.id !== undefined) {
      existing = this.connectorConfigById(input.id)
      if (!existing) throw new Error(t('接入配置不存在：{id}', { id: input.id }))
    } else {
      existing = this.connectorConfig(input.provider)
    }
    const secret = input.appSecret ?? existing?.secretActual ?? 'demo-secret'
    // 非演示密钥的全新配置默认 real（表单不采集 mode，靠密钥形态推导；demo- 前缀=演示降级）。
    const mode = input.mode ?? (secret.startsWith('demo-') ? 'mock' : existing?.mode ?? 'real')
    const payload = {
      provider: input.provider,
      name: input.name ?? existing?.name ?? `${input.provider}-${input.corpId}`,
      enabled: input.enabled ?? existing?.enabled ?? true,
      corpId: input.corpId,
      appKey: input.appKey,
      secretMasked: mask(secret, 4),
      secretActual: secret,
      syncOrgRoot: input.syncOrgRoot ?? existing?.syncOrgRoot ?? '',
      intervalMinutes: input.intervalMinutes ?? existing?.intervalMinutes ?? 60,
      callbackUrl: input.callbackUrl ?? existing?.callbackUrl ?? '',
      loginEnabled: input.loginEnabled ?? existing?.loginEnabled ?? false,
      conflictStrategy: input.conflictStrategy ?? existing?.conflictStrategy ?? 'manual',
      mode,
      ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : existing?.apiBase !== undefined ? { apiBase: existing.apiBase } : {}),
      ...(input.oapiBase !== undefined ? { oapiBase: input.oapiBase } : existing?.oapiBase !== undefined ? { oapiBase: existing.oapiBase } : {}),
      ...(input.targetOrgId !== undefined ? { targetOrgId: input.targetOrgId } : existing?.targetOrgId !== undefined ? { targetOrgId: existing.targetOrgId } : {}),
    }
    const saved = existing
      ? this.connectorConfigs().update(existing.id, payload)
      : this.connectorConfigs().insert({ id: newId('conn'), ...payload })
    this.applyConnectorMode(saved.id)
    return saved
  }

  /** 新建接入配置实例（多主体：同一 provider 可接入多家企业，provider|corpId 由引擎级唯一约束拒绝重复主体）。 */
  createConnectorConfig(input: {
    provider: 'dingtalk' | 'feishu' | 'wecom'
    /** 主体名称（缺省 `${provider}-${corpId}`）。 */
    name?: string
    corpId: string
    appKey: string
    appSecret?: string
    enabled?: boolean
    syncOrgRoot?: string
    intervalMinutes?: number
    callbackUrl?: string
    loginEnabled?: boolean
    conflictStrategy?: ConnectorConfigRecord['conflictStrategy']
    /** real=真实 OpenAPI（需真实企业凭证）；mock=演示降级。 */
    mode?: 'real' | 'mock'
    /** OpenAPI 基址覆盖（测试/专有部署）。 */
    apiBase?: string
    /** 通讯录 topapi 基址覆盖（默认 https://oapi.dingtalk.com）。 */
    oapiBase?: string
    /** 同步树挂载的目标组织 ID（空=平台根）。 */
    targetOrgId?: string
  }): ConnectorConfigRecord {
    if (!IamService.BUILTIN_CONNECTOR_PROVIDERS.has(input.provider)) throw new Error(t('未注册的连接器：{provider}', { provider: input.provider }))
    const secret = input.appSecret ?? 'demo-secret'
    // 与 upsert 同一推导：demo- 前缀密钥=演示降级（mock），其余全新配置默认 real。
    const mode = input.mode ?? (secret.startsWith('demo-') ? 'mock' : 'real')
    const saved = this.connectorConfigs().insert({
      id: newId('conn'),
      provider: input.provider,
      name: input.name ?? `${input.provider}-${input.corpId}`,
      enabled: input.enabled ?? true,
      corpId: input.corpId,
      appKey: input.appKey,
      secretMasked: mask(secret, 4),
      secretActual: secret,
      syncOrgRoot: input.syncOrgRoot ?? '',
      intervalMinutes: input.intervalMinutes ?? 60,
      callbackUrl: input.callbackUrl ?? '',
      loginEnabled: input.loginEnabled ?? false,
      conflictStrategy: input.conflictStrategy ?? 'manual',
      mode,
      ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
      ...(input.oapiBase !== undefined ? { oapiBase: input.oapiBase } : {}),
      ...(input.targetOrgId !== undefined ? { targetOrgId: input.targetOrgId } : {}),
    })
    this.applyConnectorMode(saved.id)
    return saved
  }

  /** 删除接入配置实例：同时注销运行时连接器/身份源注册项（不存在则抛错）。 */
  deleteConnectorConfig(id: string): void {
    if (!this.connectorConfigById(id)) throw new Error(t('接入配置不存在：{id}', { id }))
    this.connectorConfigs().remove(id)
    this.connectors.delete(id)
    this.authProviders.delete(id)
  }

  /** 按单条配置实例实例化连接器/身份源 Adapter 的 real/mock 实现（第 0 步：连接器真实化；多主体按 configId 注册）。 */
  applyConnectorMode(configId: string): void {
    const config = this.connectorConfigById(configId)
    if (!config) return
    if (config.provider === 'dingtalk') {
      if (config.mode === 'real' && config.secretActual) {
        const credentials: DingTalkCredentials = {
          corpId: config.corpId,
          appKey: config.appKey,
          appSecret: config.secretActual,
          ...(config.apiBase !== undefined ? { apiBase: config.apiBase } : {}),
          ...(config.oapiBase !== undefined ? { oapiBase: config.oapiBase } : {}),
        }
        this.registerConnector(config.id, new RealDingTalkConnector(credentials, { syncOrgRoot: config.syncOrgRoot }))
        this.registerAuthProvider(config.id, new RealDingTalkAuthAdapter(credentials))
      } else if (config.mode === 'mock') {
        // 显式声明 mock（演示/联调）：仅 DEMO_SEED 环境允许注册 mock 身份源，
        // 生产基线禁止将 mock 作为可登录身份源暴露。
        if (process.env.DEMO_SEED === '1') {
          this.registerConnector(config.id, new DingTalkConnector())
          this.registerAuthProvider(config.id, new DingTalkAuthAdapter())
        } else {
          this.registerConnector(config.id, new DingTalkConnector())
        }
      }
    }
  }

  async testConnector(idOrProvider: string): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const config = this.resolveConnectorConfig(idOrProvider)
    const connector = config ? this.connectors.get(config.id) : undefined
    if (!connector) throw new Error(t('未注册的连接器：{provider}', { provider: idOrProvider }))
    return connector.healthCheck()
  }

  /** 全量同步：目录映射 + 冲突入队 + 离职联动。失败同样落 lastSyncResult（ok:false），避免「点了没反应」。 */
  async syncConnector(idOrProvider: string, actor: string): Promise<{ created: number; updated: number; conflicts: number; frozen: number; message: string }> {
    const config = this.resolveConnectorConfig(idOrProvider)
    if (!config || !config.enabled) throw new Error(t('连接器未启用：{provider}', { provider: idOrProvider }))
    const connector = this.connectors.get(config.id)
    if (!connector) throw new Error(t('未注册的连接器：{provider}', { provider: idOrProvider }))
    try {
      return await this.runSync(config.provider, actor, config, connector)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result = { ok: false, created: 0, updated: 0, conflicts: 0, frozen: 0, message: t('同步失败：{message}', { message }) }
      this.connectorConfigs().update(config.id, { lastSyncAt: new Date().toISOString(), lastSyncResult: result })
      throw error
    }
  }

  private async runSync(provider: ConnectorConfigRecord['provider'], actor: string, config: ConnectorConfigRecord, connector: OrgConnector): Promise<{ created: number; updated: number; conflicts: number; frozen: number; message: string }> {
    const directory = await connector.fetchDirectory()

    const remoteOrgToId = new Map<string, string>()
    let created = 0
    let updated = 0
    for (const remoteOrg of directory.orgs) {
      // 多主体：同步树根挂到 config.targetOrgId（空=平台根）
      const parent = remoteOrg.parentRemoteId ? remoteOrgToId.get(remoteOrg.parentRemoteId) : (config.targetOrgId ?? null)
      if (parent === undefined && remoteOrg.parentRemoteId) continue
      // 部门归属双键 customFields { remoteId, connectorId }：旧数据只有 remoteId 的视为不属于任何连接器，不会被误匹配
      const local = this.orgs().findOne((org) => org.customFields['remoteId'] === remoteOrg.remoteId && org.customFields['connectorId'] === config.id)
        // 名称兜底只认领「无归属（手工/历史）或本连接器」的组织——其他主体名下的同名部门不能合并
        ?? this.orgs().findOne((org) => org.name === remoteOrg.name && org.parentId === parent
          && (org.customFields['connectorId'] === undefined || org.customFields['connectorId'] === config.id))
      if (local) {
        // 认领即盖章：名称兜底命中的无归属组织补写 remoteId/connectorId，
        // 之后其他主体的名称兜底不再能命中它（否则第二主体会合并进第一主体的树）。
        if (local.customFields['connectorId'] !== config.id || local.customFields['remoteId'] !== remoteOrg.remoteId) {
          this.orgs().update(local.id, { customFields: { ...local.customFields, remoteId: remoteOrg.remoteId, connectorId: config.id } })
        }
        remoteOrgToId.set(remoteOrg.remoteId, local.id)
      } else {
        const record = this.createOrg({ name: remoteOrg.name, parentId: parent, customFields: { remoteId: remoteOrg.remoteId, connectorId: config.id } }, SYSTEM_ACTOR)
        remoteOrgToId.set(remoteOrg.remoteId, record.id)
        created++
      }
    }

    let conflicts = 0
    let frozen = 0

    for (const remoteUser of directory.users) {
      const orgId = remoteOrgToId.get(remoteUser.orgRemoteId)
      if (!orgId) continue
      // 一人多部门（兼任语义，dev-plan-nas-authz §2.1）：主归属=orgId（首个部门），挂靠=extraOrgRemoteIds 首个命中。
      // 引擎侧 primaryOrgId=主归属锚点，orgId 子树按兼任只读——双身份权限并存不冲突。
      const secondaryOrgId = (remoteUser.extraOrgRemoteIds ?? []).map((remoteOrgId) => remoteOrgToId.get(remoteOrgId)).find(Boolean)
// 多主体：身份匹配以 identityLinks（事实源）为准，bindings 仅为兼容存量投影；
      // 二者都未命中才按工号认领——解绑后 bindings 会被重建为空，此处若只认投影会错判为新人重复建号。
      // 注意：只认登录身份链（kind≠staff）——任职链是岗位事实，不能用来定位「谁要绑登录身份」。
      let local = this.users().get(this.identityLinks().findOne((link) => link.provider === provider
        && link.providerUserId === remoteUser.remoteId
        && link.kind !== 'staff'
        && (link.corpId ?? '') === config.corpId)?.userId ?? '')
        ?? this.users().findOne((user) => user.bindings.some((binding) => binding.provider === provider && binding.unionId === remoteUser.remoteId && (binding.corpId ?? '') === config.corpId))
        ?? this.users().findOne((user) => user.jobNumber === remoteUser.jobNumber)
      if (!local) {
        const { user: record } = this.createUser({
          username: remoteUser.jobNumber.toLowerCase(),
          displayName: remoteUser.name,
          orgId,
          title: remoteUser.title,
          email: remoteUser.email,
          jobNumber: remoteUser.jobNumber,
        }, SYSTEM_ACTOR)
        this.users().update(record.id, secondaryOrgId ? { status: 'active', primaryOrgId: orgId, orgId: secondaryOrgId } : { status: 'active' })
        this.linkIdentity(record.id, { provider, providerUserId: remoteUser.remoteId, corpId: config.corpId, displayName: remoteUser.name, kind: 'login' }, 'connector-sync')
        // 任职身份链（staff）：与既有用户同口径写入——部门负责人映射与 NAS 数据权限身份反查依赖它
        if (remoteUser.remoteUserId) {
          try {
            this.linkIdentity(record.id, { provider, providerUserId: remoteUser.remoteUserId, corpId: config.corpId, displayName: remoteUser.name, kind: 'staff' }, 'connector-sync')
          } catch {
            // 唯一约束冲突：该 userid 已绑定其他账号，跳过
          }
        }
        created++
        continue
      }
      // 绑定补链：已被人工解绑的主体（bindingExemptions 含 provider|corpId）跳过登录身份链——
      // 否则解绑会在下一次同步（默认 60 分钟）被静默撤销，用户看到的是「点了没反应」。
      // 任职身份链（staff）不受豁免约束：它描述的是「此人在组织里的岗位」，是组织事实而非登录凭据，
      // 豁免它会断掉部门负责人反查与 NAS 数据权限身份反查。
      const exemptKey = `${provider}|${config.corpId ?? ''}`
      const exempted = (local.bindingExemptions ?? []).includes(exemptKey)
      const hasLinkForSubject = (providerUserId: string) => Boolean(this.identityLinks().findOne((link) => link.provider === provider
        && link.userId === local!.id
        && link.providerUserId === providerUserId
        && (link.corpId ?? '') === config.corpId))
      if (!exempted && !hasLinkForSubject(remoteUser.remoteId)) {
        try {
          this.linkIdentity(local.id, { provider, providerUserId: remoteUser.remoteId, corpId: config.corpId, displayName: remoteUser.name, kind: 'login' }, 'connector-sync')
        } catch {
          // 唯一约束冲突：该三方身份已绑定其他账号（一人一号），跳过并保留冲突语义
        }
      }
      // 运营身份链（nasAuthz P0）：unionId 供 SSO 登录匹配，userid 供 nasAuthz 身份反查
      // （hermes X-On-Behalf-User 上报 userid 口径）与 dept_manager_userid_list 负责人映射——两链并存互不覆盖。
      if (remoteUser.remoteUserId && !hasLinkForSubject(remoteUser.remoteUserId)) {
        try {
          this.linkIdentity(local.id, { provider, providerUserId: remoteUser.remoteUserId, corpId: config.corpId, displayName: remoteUser.name, kind: 'staff' }, 'connector-sync')
        } catch {
          // 唯一约束冲突：该 userid 已绑定其他账号，跳过（沿用 unionId 链语义）
        }
      }
      // 兼任归属是组织架构事实（钉钉多部门），不进属性冲突机制，直接落库收敛：
      // primaryOrgId 锚定主归属，orgId 切到兼任挂靠（引擎对其子树授只读）
      if (secondaryOrgId && (local.primaryOrgId !== orgId || local.orgId !== secondaryOrgId)) {
        this.users().update(local.id, { primaryOrgId: orgId, orgId: secondaryOrgId })
        local = this.users().get(local.id) ?? local
      }
      if (!remoteUser.active) {
        if (local.status === 'active' || local.status === 'pending') {
          this.freezeUser(local.id, t('三方同步：{provider} 通讯录已离职', { provider }), SYSTEM_ACTOR)
          frozen++
        }
        continue
      }
      const attrDiffers = local.displayName !== remoteUser.name || local.title !== remoteUser.title || local.orgId !== (secondaryOrgId ?? orgId)
      if (attrDiffers) {
        if (config.conflictStrategy === 'third_party_wins') {
          this.users().update(local.id, { displayName: remoteUser.name, title: remoteUser.title, orgId: secondaryOrgId ?? orgId })
          updated++
        } else if (config.conflictStrategy === 'platform_wins') {
          updated++
        } else {
          this.conflicts().insert({
            id: newId('cfl'),
            provider,
            kind: 'user_attr',
            thirdPartyData: { displayName: remoteUser.name, title: remoteUser.title, orgId, orgName: this.orgs().get(orgId)?.name },
            platformData: { displayName: local.displayName, title: local.title, orgId: local.orgId, orgName: this.orgs().get(local.orgId)?.name },
            status: 'pending',
          })
          conflicts++
        }
      }
    }

    // 负责人同步（dev-plan-nas-authz 步骤 1）：dept_manager_userid_list → 平台 userId（identityLinks 反查）。
    // 置于用户循环之后：userid 身份链在同一轮先落库，负责人才映射得上（钉钉负责人列表是 userid 口径）。
    // 远端显式给空列表=清空负责人；字段缺省=不动本地（兼容旧目录源）。映射不上的远端负责人被丢弃（不落悬空 ID）。
    // 手动锁定（leaderSource='manual'，控制台补录）的组织整段跳过——远端没配负责人的部门靠手动补录兜底。
    // 先补齐存量链的 kind：本轮刚写入的链在旧数据里与存量链混在同一 (provider,corpId,userId) 组，
    // 缺 kind 时无法区分登录链与任职链（解绑会连带抹掉任职事实）。
    this.backfillIdentityLinkKinds()
    let leaderSynced = 0
    let leaderPinned = 0
    for (const remoteOrg of directory.orgs) {
      if (!Array.isArray(remoteOrg.managerRemoteIds)) continue
      const localOrgId = remoteOrgToId.get(remoteOrg.remoteId)
      if (!localOrgId) continue
      const localOrg = this.orgs().get(localOrgId)
      if (localOrg?.leaderSource === 'manual') { leaderPinned++; continue }
      const leaderUserIds = remoteOrg.managerRemoteIds
        .map((remoteUserId) => this.identityLinks().findOne((link) => link.provider === provider && link.providerUserId === remoteUserId && (link.corpId ?? '') === config.corpId)?.userId)
        .filter((id): id is string => Boolean(id))
      this.orgs().update(localOrgId, { leaderUserIds, leaderSource: 'sync' })
      leaderSynced++
    }

    // 动态用户组重算快照 + 漂移告警（dev-plan-nas-authz §2.2）：HR 调整 title/org 后
    // 组成员可能静默变化，同步收尾时统一重算并与快照比对，漂移超阈值或涉及 C 关联组即告警。
    const drifts = this.refreshGroupSnapshots('connector-sync')

    const result = { ok: true, created, updated, conflicts, frozen, message: t('同步完成：新建 {created}，更新 {updated}，冲突 {conflicts}，离职冻结 {frozen}{leaderSyncedPart}{leaderPinnedPart}{driftsPart}', { created, updated, conflicts, frozen, leaderSyncedPart: leaderSynced > 0 ? t('，负责人 {n}', { n: leaderSynced }) : '', leaderPinnedPart: leaderPinned > 0 ? t('，手动锁定 {n}', { n: leaderPinned }) : '', driftsPart: drifts.length > 0 ? t('，组漂移 {n}', { n: drifts.length }) : '' }) }
    this.connectorConfigs().update(config.id, { lastSyncAt: new Date().toISOString(), lastSyncResult: result })
    this.ctx.platformBus.emit(PlatformEvents.ConnectorSynced, { provider, actor, ...result })
    return result
  }

  resolveConflict(id: string, keep: 'third_party' | 'platform', actor: string): SyncConflictRecord {
    const conflict = this.conflicts().get(id)
    if (!conflict) throw new Error(t('冲突记录不存在：{id}', { id }))
    if (conflict.status === 'resolved') throw new Error(t('该冲突已处理'))
    if (conflict.kind === 'user_attr') {
      const jobNumber = String(conflict.thirdPartyData.jobNumber ?? '')
      const local = this.users().findOne((user) => user.bindings.some((binding) => binding.provider === conflict.provider && binding.unionId === conflict.thirdPartyData.unionId))
        ?? (jobNumber ? this.users().findOne((user) => user.jobNumber === jobNumber) : undefined)
      if (local) {
        const source = keep === 'third_party' ? conflict.thirdPartyData : conflict.platformData
        this.users().update(local.id, {
          displayName: String(source.displayName ?? local.displayName),
          title: String(source.title ?? local.title),
          orgId: String(source.orgId ?? local.orgId),
        })
      }
    }
    return this.conflicts().update(id, {
      status: 'resolved',
      resolution: keep,
      resolvedBy: actor,
      resolvedAt: new Date().toISOString(),
    })
  }

  /**
   * 连接器自动同步巡检（定时器每分钟调用；POST /api/iam/connectors/auto-sync 为其手动触发口）：
   * 已启用的配置实例中，lastSyncAt 距今超过生效间隔（intervalMinutes，下限 5 分钟；0=关闭自动同步）
   * 即全量同步——从未同步过的连接器视为到期（启动即补同步）。actor 记 'auto-sync' 与手动同步区分；
   * 单配置失败不阻断其余配置（失败已落 lastSyncResult），返回逐条处理结果。
   */
  async runDueAutoSyncs(now = Date.now()): Promise<Array<{ configId: string; provider: string; name: string; message: string; ok: boolean }>> {
    if (process.env.IAM_CONNECTOR_AUTO_SYNC === 'off') return []
    const handled: Array<{ configId: string; provider: string; name: string; message: string; ok: boolean }> = []
    for (const config of this.connectorConfigs().all()) {
      const intervalMinutes = config.intervalMinutes ?? 0
      if (!config.enabled || intervalMinutes <= 0) continue
      if (config.lastSyncAt && now - new Date(config.lastSyncAt).getTime() < Math.max(intervalMinutes, AUTO_SYNC_MIN_INTERVAL_MINUTES) * 60_000) continue
      if (this.autoSyncing.has(config.id)) continue
      this.autoSyncing.add(config.id)
      try {
        const result = await this.syncConnector(config.id, 'auto-sync')
        handled.push({ configId: config.id, provider: config.provider, name: config.name, ok: true, message: result.message })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger('iam').warn(`连接器自动同步失败（${config.name}）：${message}`)
        handled.push({ configId: config.id, provider: config.provider, name: config.name, ok: false, message })
      } finally {
        this.autoSyncing.delete(config.id)
      }
    }
    if (handled.length > 0) {
      this.ctx.logger('iam').info(`连接器自动同步巡检：本次处理 ${handled.length} 条（${handled.filter((item) => item.ok).length} 成功）`)
    }
    return handled
  }

  /**
   * 全员名册（组织数据通道）：供已接入的外部应用（人事/绩效等）以机器凭证
   * （iam.roster.read scope，应用注册凭证经控制台追加授权）一次性拉取在职账号与组织树，
   * 用于铺排填报任务与 sub → 业务角色映射；id 即 userinfo 的 sub（稳定关联键）。
   * PII 最小化：不含手机号；已注销账号不出现在名册；每次拉取由控制台层记审计（invoke）。
   */
  roster(): {
    generatedAt: string
    orgs: Array<{ id: string; name: string; parentId: string | null; status: string; leaderUserIds: string[] }>
    users: Array<{ id: string; username: string; displayName: string; email: string; jobNumber: string; title: string; orgId: string; orgName: string; primaryOrgId?: string; status: UserStatus; accountType?: UserRecord['accountType'] }>
  } {
    const orgNames = new Map(this.orgs().all().map((org) => [org.id, org.name]))
    return {
      generatedAt: new Date().toISOString(),
      orgs: this.orgs().all().map((org) => ({
        id: org.id,
        name: org.name,
        parentId: org.parentId,
        status: org.status,
        leaderUserIds: this.leadersOf(org.id),
      })),
      users: this.users().all()
        .filter((user) => user.status !== 'deactivated')
        .map((user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          email: user.email,
          jobNumber: user.jobNumber ?? '',
          title: user.title,
          orgId: user.orgId,
          orgName: orgNames.get(user.orgId) ?? '',
          ...(user.primaryOrgId !== undefined ? { primaryOrgId: user.primaryOrgId } : {}),
          status: user.status,
          ...(user.accountType !== undefined ? { accountType: user.accountType } : {}),
        })),
    }
  }
}

export interface OrgTreeNode extends OrgRecord {
  children: OrgTreeNode[]
}

// -- 口令哈希（A-09：scrypt KDF + 常数时间比较） ---------------------------------------------

/** scrypt 存储格式前缀：`scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`（参数随哈希自描述，可平滑调档）。 */
const SCRYPT_PREFIX = 'scrypt$'
/** OWASP 推荐下限档（N=2^14, r=8, p=1），单次派生约 16MiB 内存。 */
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64

/** 新格式口令哈希（scrypt，随机 16 字节盐）。 */
function hashPasswordScrypt(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `${SCRYPT_PREFIX}${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

/** 旧格式口令哈希（裸 sha256，存量库口径；仅供无感升级校验，不再用于新写入）。 */
function hashPassword(password: string, salt: string): string {
  return sha256Hex(`${salt}:${password}`)
}

/**
 * 口令校验（常数时间比较，timingSafeEqual）：新格式走 scrypt 参数复算；
 * 旧格式（裸 sha256 hex）按旧算法复算后同精度比较——两条路径都不因首字节差异提前返回。
 */
function verifyPasswordHash(record: { passwordHash: string; passwordSalt: string }, password: string): boolean {
  if (record.passwordHash.startsWith(SCRYPT_PREFIX)) {
    const [n, r, p, saltB64, hashB64] = record.passwordHash.slice(SCRYPT_PREFIX.length).split('$')
    const expected = Buffer.from(hashB64 ?? '', 'base64')
    if (expected.length === 0 || !Number(n) || !Number(r) || !Number(p)) return false
    try {
      const actual = scryptSync(password, Buffer.from(saltB64 ?? '', 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) })
      return timingSafeEqual(expected, actual)
    } catch {
      return false
    }
  }
  const expected = Buffer.from(record.passwordHash, 'utf8')
  const actual = Buffer.from(hashPassword(password, record.passwordSalt), 'utf8')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    iam: IamService
  }
}

export const name = 'iam'
export const inject = ['opsStorage', 'platformBus']

export function apply(ctx: Context) {
  ctx.plugin(IamService)
  ctx.plugin(iamTools)
}
