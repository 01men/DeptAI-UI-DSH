/**
 * plugin-workforce 公共契约（冻结版 V1.0 · 2026-10-15）。
 *
 * 本文件是《数字员工与平台资源调用-技术关联与施工实施路径（2026-10-15）》
 * 附录 A 十项施工决策的落地形态，是全部工作包的共同事实源：
 * 先冻结契约与验收样本，再分实现；实现方不得在本文件之外发明身份、任务或调用协议。
 *
 * 附录 A 冻结决策（本契约体现）：
 *   1. 员工↔Agent 技术身份：一对一有效绑定（workforce_bindings，同 Agent 仅一条 active）。
 *   2. 一期外部/dsh 运行时执行优先，平台提供派工、租约与受控资源调用；不建内置推理循环。
 *   3. dispatch/claim：保留调度预取锁；认领＝「幂等确认已分配租约」。
 *      租约权威存储为 SQLite exec_run_leases（exec-hub 持有），issue.executionRunId 为投影。
 *   4. permit：服务端签发的不透明随机 ID，绑定主体/员工/任用版本/能力清单/run/租约，
 *      短期有效、可撤销；调用必须同时持真实机器令牌，permit 字符串本身不是凭证。
 *   5. 能力清单只下发任务允许的工具句柄；未知风险工具默认不得作写能力开放；参数约束服务端执行。
 *   6. NAS 人代办＝已验证真人链∩员工身份∩任务授权；无人值守＝岗位服务主体映射；
 *      员工文件出入一律走受控 artifact staging，不开放平台本地路径。
 *   7. 权威存储：workforce_* 表落 SQLite（txnStore）；run 业务状态仍归 exec-hub，
 *      租约以 exec_run_leases 为权威、issue 字段为投影。
 *   8. usage 增量关联：workforce_usage_links 记录 invocation↔usageEvent 映射，
 *      不改历史资源键、不双记消费。
 *   9. 审批绑定动作事实＋参数摘要＋任用版本；版本/参数变化必须重评。
 *   10. 旧入口对受管员工等效约束：按可信 caller 反查（platform-core/workforce-port.ts），
 *       与请求是否携带 work 上下文无关。
 */
import type { SqlValue } from '../../platform-core/src/sqlite.ts'
import type {
  ManagedEmployeeRef,
  ResourceActionFacts,
  WorkCallerRef,
  WorkDataClass,
  WorkDenyCode,
  WorkExecutionContext,
} from '../../platform-core/src/workforce-port.ts'

export type {
  ManagedEmployeeRef,
  ResourceActionFacts,
  WorkCallerRef,
  WorkDataClass,
  WorkDenyCode,
  WorkExecutionContext,
  WorkPolicyDecision,
} from '../../platform-core/src/workforce-port.ts'

// ---------------------------------------------------------------------------
// 灰度开关契约（W 批次 W7，决策 D-②：组织级启停）
// ---------------------------------------------------------------------------

/**
 * 灰度开关（W7 契约冻结 2026-10-15，D-② 组织级）：
 *   - grayMode='off'（默认）：全组织开放，等价一期行为；
 *   - grayMode='allowlist'：仅 enabledOrgs 列表内组织可走工作路径（认领/续租/受控调用），
 *     名单外组织一律拒绝（WORKFORCE_DISABLED）并可观测（workforce.gray.denied 事件）。
 * 关闭语义＝显式拒绝而非静默回落 legacy（与 V29「不静默无策略放行」同口径）：
 * 在 port.authorizeWorkAction 与 admission 认领/续租入口同步收口，网关侧 denied 照常落账。
 */
export interface WorkforceGrayConfig {
  grayMode?: 'off' | 'allowlist'
  enabledOrgs?: string[]
}

/** 领域错误：code 为统一拒绝码（中文映射见 platform-core WORK_DENY_CODE_LABELS）。 */
export class WorkforceError extends Error {
  readonly code: WorkDenyCode
  readonly httpStatus: number

  constructor(code: WorkDenyCode, message: string, httpStatus = 403) {
    super(message)
    this.name = 'WorkforceError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

// ---------------------------------------------------------------------------
// 记录类型（权威列见 WORKFORCE_TABLES；数组/对象字段以 JSON TEXT 落库）
// ---------------------------------------------------------------------------

export type EmployeeStatus = 'active' | 'suspended' | 'offboarded'
export type BindingStatus = 'active' | 'inactive'
export type AppointmentStatus = 'preparing' | 'effective' | 'revoking' | 'revoked' | 'failed'
export type GrantStatus = 'preparing' | 'effective' | 'revoking' | 'revoked' | 'failed'
export type ManifestStatus = 'draft' | 'active' | 'retired'
export type PermitStatus = 'active' | 'revoked' | 'expired'
export type LeaseStatus = 'active' | 'released' | 'superseded'
export type InvocationStatus =
  | 'reserved'
  | 'completed'
  | 'denied'
  | 'approval_required'
  | 'rate_limited'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled'
export type DeliverableStatus = 'submitted' | 'accepted' | 'rejected'

/** 员工档案（§8.1）：岗位员工的稳定业务身份，改名/重启不变。 */
export interface EmployeeRecord {
  id: string
  name: string
  displayName: string
  /** 主组织（员工所属组织）。 */
  orgId: string
  /** 真人主管（userId）：责任人，不自动成为代理用户。 */
  supervisorUserId: string
  status: EmployeeStatus
  /** 当前有效绑定 Agent（冗余指针，由绑定服务在事务内维护；''=未绑定）。 */
  primaryAgentId: string
  createdAt: string
  updatedAt: string
}

/** 运行绑定（§8.1）：员工↔技术 Agent 一对一有效绑定。 */
export interface BindingRecord {
  id: string
  employeeId: string
  agentId: string
  principalId: string
  /** dsh / external / … */
  runtime: string
  capabilityVersion: number
  status: BindingStatus
  createdAt: string
  updatedAt: string
}

/** 期望资源授权（§D.4）：任用版本内的授权意图，真实生效以各网关配置＋探针为准。 */
export interface ResourceGrantSpec {
  kind: 'mcp' | 'connector' | 'model' | 'skill' | 'nas' | 'app'
  /** mcp 服务 ID / connector provider / 模型 slug / skill ID / NAS ID / 应用 ID。 */
  registryId: string
  /** 工具名/动作集（写动作必须显式列出，未知风险工具不得默认开放）。 */
  actions: string[]
  risk: 'read' | 'write' | 'admin'
  /** 参数与业务对象约束：factoryIds / pathPrefixes / maxRows / alias 等。 */
  constraints?: Record<string, unknown>
}

/** 资源授权生效记录：准备中→生效→撤销中→已撤销/配置失败（§D.4）。 */
export interface ResourceGrantRecord {
  id: string
  appointmentId: string
  kind: ResourceGrantSpec['kind']
  registryId: string
  actionsJson: string
  risk: ResourceGrantSpec['risk']
  constraintsJson: string
  /** 生效后回填的真实权限组/策略/目录映射引用（不是 UI 勾选项）。 */
  ref: string
  status: GrantStatus
  lastError: string
  checkedAt: string
  createdAt: string
  updatedAt: string
}

/** 任用版本（§8.1/§8.2）：工作组织与权限边界；调岗/升级不改写历史版本。 */
export interface AppointmentRecord {
  id: string
  employeeId: string
  version: number
  position: string
  /** 工作组织（任务归属组织；与资源组织、成本归口分别记录）。 */
  orgId: string
  /** 任用冻结的业务密级上限（统一口径 WorkDataClass）。 */
  dataClass: WorkDataClass
  effectiveFrom: string
  /** ISO 时间；空串＝长期。 */
  effectiveUntil: string
  grantsJson: string
  approvedBy: string
  approvalRef: string
  status: AppointmentStatus
  statusReason: string
  createdAt: string
  updatedAt: string
}

/** 能力清单（§8.1/§9.2）：任务允许的工具句柄集，服务端映射真实资源。 */
export interface ManifestToolHandle {
  /** 展示句柄：`<scope>.<action>`，运行时只能引用句柄，不能自带资源键。 */
  handle: string
  kind: ResourceGrantSpec['kind']
  /** 展示键（如 mcp:quality-gateway）；真实解析键为 registryId。 */
  resourceRef: string
  registryId: string
  action: string
  risk: ResourceGrantSpec['risk']
  constraints?: Record<string, unknown>
  /** 服务端参数 JSON Schema（object 根）；校验不过＝ARGUMENT_SCOPE_DENIED。 */
  parameters?: Record<string, unknown>
  description?: string
}

export interface SkillPin {
  skillId: string
  /** 固定发布版本（不漂移）。 */
  version: string
  /** 内容/包摘要（加载证据核验用）。 */
  contentHash: string
}

export interface ManifestRecord {
  id: string
  appointmentId: string
  version: number
  toolsJson: string
  skillPinsJson: string
  status: ManifestStatus
  createdAt: string
}

/** 短期工作授权（§8.1）：不透明 permit，绑定主体与 run/租约。 */
export interface PermitRecord {
  id: string
  employeeId: string
  agentId: string
  principalId: string
  appointmentId: string
  appointmentVersion: number
  manifestId: string
  issueId: string
  runId: string
  leaseId: string
  leaseVersion: number
  status: PermitStatus
  expiresAt: string
  createdAt: string
  revokedAt: string
  revokedReason: string
}

/** 执行租约（§6.2/§11.6）：权威表 exec_run_leases 由 exec-hub 持有（附录 A 决策 3/7）。 */
export interface RunLeaseRecord {
  id: string
  issueId: string
  runId: string
  employeeId: string
  agentKey: string
  principalId: string
  leaseVersion: number
  status: LeaseStatus
  acquiredAt: string
  renewedAt: string
  expiresAt: string
  releasedAt: string
  releaseReason: string
}

/** 工作调用账本（§9/§11.6）：「这个员工在这个步骤请求做什么以及当前结果」。 */
export interface InvocationRecord {
  id: string
  employeeId: string
  appointmentId: string
  appointmentVersion: number
  runId: string
  permitId: string
  stepKey: string
  kind: ResourceGrantSpec['kind']
  registryId: string
  action: string
  risk: ResourceGrantSpec['risk']
  /** 规范化参数摘要哈希（步骤冲突判定；不可变）。 */
  argsHash: string
  argsSummaryJson: string
  status: InvocationStatus
  errorCode: string
  message: string
  /** 网关调用证据（callId/executionId/模型/版本等）。 */
  gatewayRefJson: string
  usageEventIdsJson: string
  approvalRef: string
  latencyMs: number
  createdAt: string
  settledAt: string
}

/** 交付物（§8.1）：技术执行完成只形成「交付已提交」，验收由真人决定（§6.5）。 */
export interface DeliverableRecord {
  id: string
  runId: string
  issueId: string
  employeeId: string
  summary: string
  artifactIdsJson: string
  version: number
  status: DeliverableStatus
  submittedAt: string
  decidedAt: string
  decidedBy: string
  decisionReason: string
}

/** 工作调用↔消费事实关联（§11.1/§11.3）：只做映射，不复制消费流水。 */
export interface UsageLinkRecord {
  id: string
  invocationId: string
  usageEventId: string
  resource: string
  createdAt: string
}

/** 受控交付/输入文件元信息（§11.6）：内容存受控 staging 目录，不开放平台任意路径。 */
export interface ArtifactRecord {
  id: string
  employeeId: string
  runId: string
  orgId: string
  name: string
  contentType: string
  sizeBytes: number
  sha256: string
  storagePath: string
  source: 'upload' | 'generated'
  createdAt: string
}

/** 已提交状态的待发事件（§11.6）：事件唯一键、重试与消费水位。 */
export interface OutboxRecord {
  id: string
  eventKey: string
  type: string
  payloadJson: string
  status: 'pending' | 'sent' | 'consumed'
  attempts: number
  lastError: string
  createdAt: string
  sentAt: string
  consumedAt: string
}

// ---------------------------------------------------------------------------
// 表结构（权威 DDL）：migrations.ts 直接消费；workforce_* 表由本插件持有
// ---------------------------------------------------------------------------

export interface WorkforceTableSpec {
  name: string
  columns: Record<string, string>
  uniques?: string[][]
  indexes?: string[][]
  /** 需 JSON 序列化/反序列化的 TEXT 字段。 */
  jsonFields?: string[]
}

export const WORKFORCE_TABLES: Record<string, WorkforceTableSpec> = {
  workforce_employees: {
    name: 'workforce_employees',
    columns: {
      id: 'TEXT NOT NULL', name: 'TEXT NOT NULL', displayName: "TEXT NOT NULL DEFAULT ''",
      orgId: 'TEXT NOT NULL', supervisorUserId: "TEXT NOT NULL DEFAULT ''",
      status: 'TEXT NOT NULL', primaryAgentId: "TEXT NOT NULL DEFAULT ''",
      createdAt: 'TEXT NOT NULL', updatedAt: 'TEXT NOT NULL',
    },
    indexes: [['orgId'], ['status']],
  },
  workforce_bindings: {
    name: 'workforce_bindings',
    columns: {
      id: 'TEXT NOT NULL', employeeId: 'TEXT NOT NULL', agentId: 'TEXT NOT NULL',
      principalId: "TEXT NOT NULL DEFAULT ''", runtime: "TEXT NOT NULL DEFAULT 'dsh'",
      capabilityVersion: 'INTEGER NOT NULL DEFAULT 1', status: 'TEXT NOT NULL',
      createdAt: 'TEXT NOT NULL', updatedAt: 'TEXT NOT NULL',
    },
    indexes: [['employeeId'], ['agentId'], ['status']],
  },
  workforce_appointments: {
    name: 'workforce_appointments',
    columns: {
      id: 'TEXT NOT NULL', employeeId: 'TEXT NOT NULL', version: 'INTEGER NOT NULL',
      position: "TEXT NOT NULL DEFAULT ''", orgId: 'TEXT NOT NULL', dataClass: "TEXT NOT NULL DEFAULT 'internal'",
      effectiveFrom: 'TEXT NOT NULL', effectiveUntil: "TEXT NOT NULL DEFAULT ''",
      grantsJson: "TEXT NOT NULL DEFAULT '[]'", approvedBy: "TEXT NOT NULL DEFAULT ''",
      approvalRef: "TEXT NOT NULL DEFAULT ''", status: 'TEXT NOT NULL', statusReason: "TEXT NOT NULL DEFAULT ''",
      createdAt: 'TEXT NOT NULL', updatedAt: 'TEXT NOT NULL',
    },
    uniques: [['employeeId', 'version']],
    indexes: [['employeeId'], ['status']],
  },
  workforce_resource_grants: {
    name: 'workforce_resource_grants',
    columns: {
      id: 'TEXT NOT NULL', appointmentId: 'TEXT NOT NULL',
      kind: 'TEXT NOT NULL', registryId: 'TEXT NOT NULL',
      actionsJson: "TEXT NOT NULL DEFAULT '[]'", risk: "TEXT NOT NULL DEFAULT 'read'",
      constraintsJson: "TEXT NOT NULL DEFAULT '{}'", ref: "TEXT NOT NULL DEFAULT ''",
      status: 'TEXT NOT NULL', lastError: "TEXT NOT NULL DEFAULT ''", checkedAt: "TEXT NOT NULL DEFAULT ''",
      createdAt: 'TEXT NOT NULL', updatedAt: 'TEXT NOT NULL',
    },
    indexes: [['appointmentId'], ['status']],
  },
  workforce_manifests: {
    name: 'workforce_manifests',
    columns: {
      id: 'TEXT NOT NULL', appointmentId: 'TEXT NOT NULL', version: 'INTEGER NOT NULL',
      toolsJson: "TEXT NOT NULL DEFAULT '[]'", skillPinsJson: "TEXT NOT NULL DEFAULT '[]'",
      status: "TEXT NOT NULL DEFAULT 'draft'", createdAt: 'TEXT NOT NULL',
    },
    uniques: [['appointmentId', 'version']],
    indexes: [['appointmentId']],
  },
  workforce_permits: {
    name: 'workforce_permits',
    columns: {
      id: 'TEXT NOT NULL', employeeId: 'TEXT NOT NULL', agentId: 'TEXT NOT NULL', principalId: 'TEXT NOT NULL',
      appointmentId: 'TEXT NOT NULL', appointmentVersion: 'INTEGER NOT NULL',
      manifestId: 'TEXT NOT NULL', issueId: "TEXT NOT NULL DEFAULT ''", runId: "TEXT NOT NULL DEFAULT ''",
      leaseId: "TEXT NOT NULL DEFAULT ''", leaseVersion: 'INTEGER NOT NULL DEFAULT 0',
      status: 'TEXT NOT NULL', expiresAt: 'TEXT NOT NULL', createdAt: 'TEXT NOT NULL',
      revokedAt: "TEXT NOT NULL DEFAULT ''", revokedReason: "TEXT NOT NULL DEFAULT ''",
    },
    indexes: [['employeeId', 'status'], ['principalId'], ['runId']],
  },
  workforce_invocations: {
    name: 'workforce_invocations',
    columns: {
      id: 'TEXT NOT NULL', employeeId: 'TEXT NOT NULL', appointmentId: 'TEXT NOT NULL',
      appointmentVersion: 'INTEGER NOT NULL', runId: 'TEXT NOT NULL', permitId: 'TEXT NOT NULL',
      stepKey: 'TEXT NOT NULL', kind: 'TEXT NOT NULL', registryId: 'TEXT NOT NULL',
      action: 'TEXT NOT NULL', risk: "TEXT NOT NULL DEFAULT 'read'",
      argsHash: 'TEXT NOT NULL', argsSummaryJson: "TEXT NOT NULL DEFAULT '{}'",
      status: 'TEXT NOT NULL', errorCode: "TEXT NOT NULL DEFAULT ''", message: "TEXT NOT NULL DEFAULT ''",
      gatewayRefJson: "TEXT NOT NULL DEFAULT '{}'", usageEventIdsJson: "TEXT NOT NULL DEFAULT '[]'",
      approvalRef: "TEXT NOT NULL DEFAULT ''", latencyMs: 'INTEGER NOT NULL DEFAULT 0',
      createdAt: 'TEXT NOT NULL', settledAt: "TEXT NOT NULL DEFAULT ''",
    },
    // 同一 run 内步骤键唯一（§11.5）；参数摘要不可变——不同参数命中唯一约束＝STEP_ARGUMENT_CONFLICT
    uniques: [['runId', 'stepKey']],
    indexes: [['employeeId'], ['permitId'], ['status']],
  },
  workforce_usage_links: {
    name: 'workforce_usage_links',
    columns: {
      id: 'TEXT NOT NULL', invocationId: 'TEXT NOT NULL', usageEventId: 'TEXT NOT NULL',
      resource: "TEXT NOT NULL DEFAULT ''", createdAt: 'TEXT NOT NULL',
    },
    uniques: [['invocationId', 'usageEventId']],
    indexes: [['invocationId']],
  },
  workforce_artifacts: {
    name: 'workforce_artifacts',
    columns: {
      id: 'TEXT NOT NULL', employeeId: 'TEXT NOT NULL', runId: "TEXT NOT NULL DEFAULT ''",
      orgId: 'TEXT NOT NULL', name: 'TEXT NOT NULL', contentType: "TEXT NOT NULL DEFAULT 'application/octet-stream'",
      sizeBytes: 'INTEGER NOT NULL DEFAULT 0', sha256: 'TEXT NOT NULL', storagePath: 'TEXT NOT NULL',
      source: "TEXT NOT NULL DEFAULT 'upload'", createdAt: 'TEXT NOT NULL',
    },
    indexes: [['employeeId'], ['runId']],
  },
  workforce_deliverables: {
    name: 'workforce_deliverables',
    columns: {
      id: 'TEXT NOT NULL', runId: 'TEXT NOT NULL', issueId: "TEXT NOT NULL DEFAULT ''",
      employeeId: 'TEXT NOT NULL', summary: "TEXT NOT NULL DEFAULT ''",
      artifactIdsJson: "TEXT NOT NULL DEFAULT '[]'", version: 'INTEGER NOT NULL',
      status: "TEXT NOT NULL DEFAULT 'submitted'", submittedAt: 'TEXT NOT NULL',
      decidedAt: "TEXT NOT NULL DEFAULT ''", decidedBy: "TEXT NOT NULL DEFAULT ''", decisionReason: "TEXT NOT NULL DEFAULT ''",
    },
    uniques: [['runId', 'version']],
    indexes: [['employeeId'], ['issueId']],
  },
  workforce_outbox: {
    name: 'workforce_outbox',
    columns: {
      id: 'TEXT NOT NULL', eventKey: 'TEXT NOT NULL', type: 'TEXT NOT NULL',
      payloadJson: "TEXT NOT NULL DEFAULT '{}'", status: "TEXT NOT NULL DEFAULT 'pending'",
      attempts: 'INTEGER NOT NULL DEFAULT 0', lastError: "TEXT NOT NULL DEFAULT ''",
      createdAt: 'TEXT NOT NULL', sentAt: "TEXT NOT NULL DEFAULT ''", consumedAt: "TEXT NOT NULL DEFAULT ''",
    },
    uniques: [['eventKey']],
    indexes: [['status']],
  },
}

// ---------------------------------------------------------------------------
// 仓储接口（repositories.ts 实现；各服务消费）
// ---------------------------------------------------------------------------

export interface TableStore<T> {
  insert(row: T): void
  get(id: string): T | undefined
  all(): T[]
  /** 等值条件查询（字段→值；jsonFields 由实现按字符串匹配原始 JSON 文本）。 */
  findWhere(where: Record<string, SqlValue>): T[]
  update(id: string, patch: Partial<T>): void
  delete(id: string): void
  count(): number
}

export interface WorkforceStore {
  employees: TableStore<EmployeeRecord>
  bindings: TableStore<BindingRecord>
  appointments: TableStore<AppointmentRecord>
  grants: TableStore<ResourceGrantRecord>
  manifests: TableStore<ManifestRecord>
  permits: TableStore<PermitRecord>
  invocations: TableStore<InvocationRecord>
  usageLinks: TableStore<UsageLinkRecord>
  artifacts: TableStore<ArtifactRecord>
  deliverables: TableStore<DeliverableRecord>
  outbox: TableStore<OutboxRecord>
  /** BEGIN IMMEDIATE 同步事务（txnStore 包装）：短检查/预留/提交用；网络调用严禁入内。 */
  txn<T>(fn: () => T): T
  /** 迁移：建齐 WORKFORCE_TABLES（幂等）。 */
  migrate(): void
}

// ---------------------------------------------------------------------------
// 身份解析（identity-resolver.ts）
// ---------------------------------------------------------------------------

export interface IdentityResolution {
  employee: EmployeeRecord
  binding: BindingRecord
  /** 当前生效任用（employee 在岗 + 任用 effective 才返回非 null）。 */
  appointment: AppointmentRecord
}

export interface WorkforceIdentityResolver {
  /**
   * 可信 caller → 员工/绑定/生效任用。
   * 规则（§5）：machine 且 refType=agent → binding.agentId 反查；human → 按 userId 匹配主管? 否——
   * 员工机器主体只从 agent 绑定反查；human 一律返回 null（员工域没有「人是员工」的通道）。
   * 在岗（active）＋一对一绑定有效＋存在 effective 任用才视为受管；否则 null。
   */
  resolveByCaller(caller: WorkCallerRef): Promise<IdentityResolution | null>
  describeAgent(agentId: string): Promise<ManagedEmployeeRef | null>
  /**
   * Agent 绑定态探测（协作面治理第 2 项 permit 覆盖，P2-01）：与 describeAgent 的区别是
   * **区分「未纳管」与「已纳管但 permit 失效」**——前者按 legacy 语义放行，后者必须
   * fail-closed 拒绝（员工离岗 / 任用撤销 / 绑定停用）。只返回服务端回查事实。
   */
  inspectAgent(agentId: string): Promise<AgentBindingState>
}

/** Agent 绑定态（inspectAgent 返回值；bound=false 表示从未纳管）。 */
export interface AgentBindingState {
  agentId: string
  /** 是否存在 active 绑定（纳管事实）。 */
  bound: boolean
  /** 受管三要素全部成立：员工在岗 + 绑定有效 + 存在生效任用。 */
  permitEffective: boolean
  employeeId?: string
  bindingId?: string
  /** permitEffective=false 且 bound=true 时的诚实原因（便于排障与审计）。 */
  reason?: 'EMPLOYEE_NOT_ACTIVE' | 'NO_EFFECTIVE_APPOINTMENT'
}

// ---------------------------------------------------------------------------
// exec-hub 集成端口（exec-hub 实现；workforce 结构化消费——不产生反向 import）
// ---------------------------------------------------------------------------

export type EmployeeClaimResult =
  | { ok: true; issueId: string; runId: string; lease: RunLeaseRecord; created: boolean }
  | {
      ok: false
      code: 'ISSUE_NOT_FOUND' | 'ISSUE_CLOSED' | 'LEASE_HELD_BY_OTHER' | 'ADMISSION_DENIED' | 'BUDGET_EXCEEDED' | 'APPROVAL_REQUIRED' | 'EXEC_HUB_UNAVAILABLE'
      message: string
      holder?: string
    }

export type EmployeeLeaseResult =
  | { ok: true; lease: RunLeaseRecord }
  | { ok: false; code: 'LEASE_STALE' | 'RUN_NOT_OWNED' | 'EXEC_HUB_UNAVAILABLE'; message: string }

/** exec-hub 员工工作路径（附录 A 决策 3：认领＝幂等确认已分配租约）。 */
export interface ExecHubWorkIntegration {
  /**
   * 幂等认领：统一准入（冻结/预算/审批）→ get-or-create run → 原子获得租约。
   * 同员工+同任务重复认领返回既有 run/租约（created=false），不报「他人持有」；
   * 其他员工/其他任用/旧租约/已关闭任务拒绝。
   */
  claimForEmployee(input: { issueId: string; employeeId: string; agentKey: string; principalId: string; ttlMs?: number }): Promise<EmployeeClaimResult>
  /** 续租/进度心跳：同主体、同 run、未撤销、未过期才能续。 */
  renewLease(input: { runId: string; principalId: string; ttlMs?: number }): Promise<EmployeeLeaseResult>
  /** exec_complete 的主体/run 所有权校验（D07）：跨员工/旧租约拒绝。 */
  assertRunOwnership(input: { runId: string; principalId: string }): Promise<{ ok: true; lease: RunLeaseRecord } | { ok: false; code: WorkDenyCode; message: string }>
  /** 停职/撤销联动：按 run 释放租约并清理 issue 投影。 */
  releaseForRun(runId: string, reason: string): void
}

// ---------------------------------------------------------------------------
// 准入与认领（admission-service.ts）；permit（permit-service.ts）
// ---------------------------------------------------------------------------

export interface ClaimInput {
  issueId: string
  /** 运行时别名（兼容 exec_claim 的 agentKey）；主体归属仍以令牌反查为准。 */
  agentKey?: string
  ttlMs?: number
}

export type ClaimOutcome =
  | {
      ok: true
      employeeId: string
      agentId: string
      issueId: string
      runId: string
      lease: RunLeaseRecord
      permit: PermitRecord
      manifest: ManifestRecord
      tools: ManifestToolHandle[]
      /** 幂等重放标记：同主体同任务重复认领返回既有授权。 */
      idempotent: boolean
    }
  | { ok: false; code: WorkDenyCode; message: string; holder?: string }

export interface WorkforceAdmission {
  /** 认领统一入口（REST /claims 与 exec_claim 兼容包装共用，不复制实现）。 */
  claimWork(caller: WorkCallerRef, input: ClaimInput): Promise<ClaimOutcome>
  /** 续租/进度。 */
  renewWorkLease(caller: WorkCallerRef, permitId: string, ttlMs?: number): Promise<EmployeeLeaseResult>
  /**
   * permit 校验：存在、active、未过期、主体匹配（principalId）、任用版本一致；
   * requireRun 时校验 run/租约归属。失败抛 WorkforceError。
   */
  verifyPermit(caller: WorkCallerRef, permitId: string, opts?: { requireRun?: boolean }): Promise<PermitRecord>
  /** exec_complete 所有权校验（D07）：返回核验后上下文，失败抛 WorkforceError。 */
  assertRunOwnership(caller: WorkCallerRef, runId: string): Promise<WorkExecutionContext>
}

export interface WorkforcePermits {
  issue(input: {
    resolution: IdentityResolution
    issueId: string
    runId: string
    lease: RunLeaseRecord
    manifestId: string
    ttlMs: number
  }): PermitRecord
  /** 主体/状态/有效期/任用版本校验；不匹配抛 WorkforceError。 */
  verify(permitId: string, caller: WorkCallerRef, opts?: { requireRun?: boolean }): PermitRecord
  revoke(permitId: string, reason: string): void
  revokeForEmployee(employeeId: string, reason: string): number
  activeForRun(runId: string): PermitRecord | undefined
}

// ---------------------------------------------------------------------------
// 能力清单（capability-manifest.ts）
// ---------------------------------------------------------------------------

export interface WorkforceCapabilities {
  /** 由任用授权期望集生成/滚动版本（skillPins 经 skillHub 探针固定版本与摘要）。 */
  buildForAppointment(appointmentId: string): ManifestRecord
  get(manifestId: string): ManifestRecord
  activeForAppointment(appointmentId: string): ManifestRecord | undefined
  toolsFor(manifestId: string): ManifestToolHandle[]
  resolveTool(manifestId: string, handle: string): ManifestToolHandle | undefined
}

// ---------------------------------------------------------------------------
// 资源适配器（adapters/*）：把受控调用映射到既有网关；缺席能力返回未支持，不以空实现冒充成功
// ---------------------------------------------------------------------------

export interface AdapterProbeResult {
  ok: boolean
  /** 生效后回填的真实权限组/策略/目录映射引用。 */
  ref?: string
  message?: string
}

export interface AdapterInvokeInput {
  work: WorkExecutionContext
  tool: ManifestToolHandle
  args: Record<string, unknown>
  invocationId: string
}

export interface AdapterInvokeResult {
  ok: boolean
  /** 业务结果（completed 时给 value/content）。 */
  value?: unknown
  content?: string
  /** 网关证据：callId / executionId / 模型 / tokens / 版本引用等。 */
  gatewayRef?: Record<string, unknown>
  /** usage.record() 返回的事件 ID 列表（有则回填 usage_links）。 */
  usageEventIds?: string[]
  /** approval_required 时的审批引用。 */
  approvalRef?: string
  rateLimited?: boolean
  /** 网络已发出但结果不确定（写超时等）。 */
  outcomeUnknown?: boolean
  message?: string
}

export interface ResourceAdapter {
  kind: ResourceGrantSpec['kind']
  /** 任用激活时的授权探针（D.4）：只读核验真实配置，不自动扩权。 */
  probeGrant(spec: ResourceGrantSpec, resolution: IdentityResolution): Promise<AdapterProbeResult>
  /** 受控调用：调用既有网关服务并回填证据（适配器内再走网关自身授权链）。 */
  invoke(input: AdapterInvokeInput): Promise<AdapterInvokeResult>
}

export interface AdapterRegistry {
  get(kind: ResourceGrantSpec['kind']): ResourceAdapter | undefined
  /** 全量登记（index.ts 装配时调用）。 */
  register(adapter: ResourceAdapter): void
}

// ---------------------------------------------------------------------------
// 受控调用（invocation-service.ts）：§9.3 状态语义
// ---------------------------------------------------------------------------

export interface InvocationRequest {
  permitId: string
  toolHandle: string
  /** 调用方提出的业务步骤引用；服务端校验长度/字符/run 范围并绑定参数摘要。 */
  stepKey: string
  arguments?: unknown
  traceId?: string
}

export type InvocationOutcome =
  | { status: 'completed'; invocationId: string; value?: unknown; content?: string; gatewayRef?: Record<string, unknown>; work: WorkExecutionContext }
  | { status: 'denied'; invocationId: string; code: WorkDenyCode; message: string }
  | { status: 'approval_required'; invocationId: string; message: string; approvalRef?: string }
  | { status: 'rate_limited'; invocationId: string; message: string; retryAfterMs?: number }
  | { status: 'failed'; invocationId: string; message: string; code?: WorkDenyCode }
  | { status: 'outcome_unknown'; invocationId: string; message: string }
  | { status: 'cancelled'; invocationId: string; message: string }

export interface WorkforceInvocations {
  invoke(caller: WorkCallerRef, request: InvocationRequest): Promise<InvocationOutcome>
  /** 归属校验：员工本人或同组织 workforce.read；结果不跨组织外泄。 */
  get(caller: WorkCallerRef, invocationId: string): InvocationRecord
  listByRun(caller: WorkCallerRef, runId: string): InvocationRecord[]
  /** 适配器回填：网关 usage 事件关联（同对唯一，幂等）。 */
  linkUsage(invocationId: string, usageEventId: string, resource: string): void
  /** outcome_unknown 核验回写（人工/对账后）。 */
  reconcile(id: string, status: 'completed' | 'failed', message: string, gatewayRef?: Record<string, unknown>): void
}

// ---------------------------------------------------------------------------
// 受控 artifact（artifact-service.ts）与交付验收（acceptance-service.ts）
// ---------------------------------------------------------------------------

export interface WorkforceArtifacts {
  /** 受控上传：内容经请求体 base64 进入服务端 staging，禁止平台本地任意路径。 */
  createUpload(caller: WorkCallerRef, input: { name: string; contentType: string; contentBase64: string; runId?: string }): ArtifactRecord
  get(caller: WorkCallerRef, artifactId: string): ArtifactRecord
  /** 员工/同组织 workforce.read 读取受控内容（NAS 写入适配器消费）。 */
  readBase64(caller: WorkCallerRef, artifactId: string): string
}

export interface WorkforceDelivery {
  /** 提交结构化交付：校验 run 归属与 artifact 归属；exec-hub completeRun 使任务入 review。 */
  submit(caller: WorkCallerRef, input: { permitId: string; summary: string; artifactIds: string[] }): Promise<DeliverableRecord>
  /** 真人验收/退回（workforce.accept）：accepted→done；rejected→退回执行并保留全部调用事实。 */
  decide(caller: WorkCallerRef, input: { deliverableId: string; decision: 'accepted' | 'rejected'; reason: string }): Promise<DeliverableRecord>
  get(caller: WorkCallerRef, deliverableId: string): DeliverableRecord
  listByRun(caller: WorkCallerRef, runId: string): DeliverableRecord[]
}

// ---------------------------------------------------------------------------
// 员工与任用管理（employee-service.ts / appointment-service.ts）
// ---------------------------------------------------------------------------

export interface WorkforceEmployees {
  create(input: { name: string; displayName?: string; orgId: string; supervisorUserId: string; agentId: string; principalId?: string; runtime?: string }): EmployeeRecord
  get(id: string): EmployeeRecord
  list(filter?: { orgId?: string; status?: EmployeeStatus }): EmployeeRecord[]
  /** 停职/复岗/离岗：suspend·offboard 联动撤 permit、释放租约（经 exec-hub 集成端口）。 */
  setStatus(caller: WorkCallerRef, id: string, status: EmployeeStatus, reason: string): EmployeeRecord
  /** 换绑（旧 active→inactive，事务内保证同 Agent 仅一条 active）。 */
  bindAgent(caller: WorkCallerRef, employeeId: string, agentId: string, principalId?: string, runtime?: string): BindingRecord
  bindingsFor(employeeId: string): BindingRecord[]
}

export interface WorkforceAppointments {
  create(input: {
    employeeId: string
    position: string
    orgId: string
    dataClass: WorkDataClass
    effectiveFrom: string
    effectiveUntil?: string
    grants: ResourceGrantSpec[]
    approvedBy: string
    approvalRef?: string
  }): AppointmentRecord
  /**
   * 激活（D.4）：逐 grant 探针核验真实授权；全部通过→effective 并回填 ref，
   * 任一失败→该 grant failed、任用保持 preparing（不得签发 permit）。
   */
  activate(caller: WorkCallerRef, id: string): Promise<AppointmentRecord>
  /** 撤销：先提高工作策略版本并撤全部 permit，再异步收敛资源网关（revoking→revoked）。 */
  revoke(caller: WorkCallerRef, id: string, reason: string): Promise<AppointmentRecord>
  get(id: string): AppointmentRecord
  list(filter?: { employeeId?: string; status?: AppointmentStatus }): AppointmentRecord[]
  effectiveForEmployee(employeeId: string): AppointmentRecord | undefined
}

// ---------------------------------------------------------------------------
// 运行时薄工具与 REST 权限点（工具在 tools.ts，路由在 routes.ts）
// ---------------------------------------------------------------------------

export const WORKFORCE_TOOLS = ['workforce_claim', 'workforce_invoke', 'workforce_renew', 'workforce_submit'] as const

export const WORKFORCE_PERMISSIONS = {
  read: 'workforce.read',
  write: 'workforce.write',
  admin: 'workforce.admin',
  invoke: 'workforce.invoke',
  accept: 'workforce.accept',
} as const

/** stepKey 合法性（§9.3）：1-96 位，字母/数字/点/下划线/连字符。 */
export const STEP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/

/** artifact 上传上限（默认 8MB；staging 受控目录，防任意路径）。 */
export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024
