/**
 * 数字员工工作策略窄端口（施工蓝本：《数字员工与平台资源调用-技术关联与施工实施路径》2026-10-15 §10.2、附录 D.5）。
 *
 * 依赖方向纪律（防循环装配，附录 A 决策 10）：
 *   - platform-core 只声明类型与登记器，不反向 import 任何业务插件；
 *   - plugin-workforce 装配完成后调用 register() 登记真实策略实现；
 *   - 资源网关（mcp/connector/modelgw/nas/skillhub）与 exec-hub 仅依赖本文件，
 *     经 ctx.workforcePolicy 消费。提供者未登记时 port() 返回 null：
 *     数字员工新工作路径一律不可用（拒绝），不得静默按无策略放行（验收 V29）。
 *
 * 防绕行关键语义（D.5）：「是否受管数字员工」只能按已验证 caller 反查判定，
 * 与请求是否携带 work 上下文无关——员工删除上下文不得退回旧入口宽松分支。
 * 两层授权取交集：本端口只做工作级授权，资源网关原有授权链一项不少。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { t } from '../../platform-i18n/src/index.ts'

// ---------------------------------------------------------------------------
// 统一业务密级（D14）：与 Agent schema / ModelGateway 的同名枚举语义不同，
// 全平台工作面只用本口径；到旧协议的映射必须由适配器显式完成，禁止静默回落 internal。
//   public      公开
//   internal    内部
//   secret      秘密（业务秘密级）
//   confidential 机密（Agent 处理需审批）
//   topsecret   绝密（禁止 Agent 直接处理：模型/资源调用前直接拒绝）
// ---------------------------------------------------------------------------
export type WorkDataClass = 'public' | 'internal' | 'secret' | 'confidential' | 'topsecret'

export const WORK_DATA_CLASS_ORDER: Record<WorkDataClass, number> = {
  public: 0,
  internal: 1,
  secret: 2,
  confidential: 3,
  topsecret: 4,
}

/** 领域拒绝码（实施路径 §13.3；错误要能指导「停止、申请、等待、核验或重试」）。 */
export type WorkDenyCode =
  | 'WORKFORCE_NOT_READY'
  | 'EMPLOYEE_NOT_ACTIVE'
  | 'APPOINTMENT_NOT_EFFECTIVE'
  | 'APPOINTMENT_EXPIRED'
  | 'PRINCIPAL_BINDING_MISMATCH'
  | 'RUN_NOT_OWNED'
  | 'LEASE_STALE'
  | 'TOOL_NOT_GRANTED'
  | 'ARGUMENT_SCOPE_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'BUDGET_EXCEEDED'
  | 'STEP_ARGUMENT_CONFLICT'
  | 'OUTCOME_UNKNOWN'
  | 'ARTIFACT_SCOPE_DENIED'
  | 'RATE_LIMITED'
  | 'TOOL_UNKNOWN'
  | 'RISK_UNREGISTERED'
  | 'WORKFORCE_DISABLED'
  | 'POLICY_INTERNAL_ERROR'

export const WORK_DENY_CODE_LABELS: Record<WorkDenyCode, string> = {
  WORKFORCE_NOT_READY: '数字员工工作策略未就绪，工作路径不可用',
  EMPLOYEE_NOT_ACTIVE: '数字员工不在岗（停职或已离岗）',
  APPOINTMENT_NOT_EFFECTIVE: '任用未生效（资源授权准备未完成）',
  APPOINTMENT_EXPIRED: '任用已过期',
  PRINCIPAL_BINDING_MISMATCH: '调用主体与员工技术绑定不匹配',
  RUN_NOT_OWNED: '该 run 不归属当前调用主体',
  LEASE_STALE: '执行租约已过期或被更高版本取代',
  TOOL_NOT_GRANTED: '工具未列入本任用能力清单',
  ARGUMENT_SCOPE_DENIED: '参数超出任用边界（工厂/工单/目录等范围约束）',
  APPROVAL_REQUIRED: '该动作需要业务审批，请展示审批单并等待',
  BUDGET_EXCEEDED: '预算不足或预留失败',
  STEP_ARGUMENT_CONFLICT: '同一业务步骤键已绑定不同参数，冲突拒绝',
  OUTCOME_UNKNOWN: '外部结果不确定，请先查证核验，禁止自动重试写入',
  ARTIFACT_SCOPE_DENIED: '文件范围越界（仅允许受控 artifact 上传/读取）',
  RATE_LIMITED: '命中可重试流控，请按服务端重试策略退避',
  TOOL_UNKNOWN: '工具句柄无法解析到已登记资源',
  RISK_UNREGISTERED: '工具风险未登记生效，写能力须先经风险登记审批（V11）',
  WORKFORCE_DISABLED: '数字员工域对本组织处于灰度关闭',
  POLICY_INTERNAL_ERROR: '工作策略执行异常（fail-closed）',
}

/** 已验证调用者：由各入口从令牌/会话解析（结构对齐 rest-gate CallerInfo），禁止来自请求参数。 */
export interface WorkCallerRef {
  kind: 'human' | 'machine'
  principalId: string
  userId?: string
  /** machine 专属：凭证关联资源（refType=agent 时可反查数字员工绑定）。 */
  refType?: string
  refId?: string
  name?: string
}

/** 受管数字员工引用（服务端反查结果）。 */
export interface ManagedEmployeeRef {
  employeeId: string
  agentId: string
  appointmentId: string
  appointmentVersion: number
  workOrgId: string
  /** 任用冻结的业务密级上限。 */
  dataClass: WorkDataClass
}

/** 资源动作事实：由资源服务自行解析，不接受客户端/模型自报风险（附录 D.5）。 */
export interface ResourceActionFacts {
  kind: 'mcp' | 'connector' | 'model' | 'skill' | 'nas' | 'app'
  /** mcp 服务 ID / connector provider / 模型 slug / skill ID / NAS ID / 应用 ID。 */
  registryId: string
  /** 工具名 / 动作 ID / invoke / read|write|search… 由各网关语义决定。 */
  action: string
  /**
   * W 批次 V11 根治：risk 取「可信风险登记生效值」；无生效登记时为 'unknown'
   * （不再按 read 隐式开放、也不按 write 盲目保守初判）。
   * 'unknown' 的裁决在工作策略端口：只读语境（清单句柄仅授 read / 只读约束）放行，
   * 写语境一律 RISK_UNREGISTERED 拒绝——写能力必须先经「登记→审核→生效」。
   */
  risk: 'read' | 'write' | 'admin' | 'unknown'
}

/** 工作引用索引：允许由请求携带，仅作索引；授权事实一律服务端回查（§10.4）。 */
export interface WorkRefIndex {
  permitId?: string
  runId?: string
  issueId?: string
  stepKey?: string
  traceId?: string
}

export interface WorkActionQuery {
  facts: ResourceActionFacts
  ref?: WorkRefIndex
  /** 规范化参数摘要（哈希），由调用方网关计算；用于步骤冲突判定与审计。 */
  argsHash?: string
}

/** 服务端核验后的可信执行上下文（§8.3）：身份、组织、版本与代理链由服务端解析，不接受客户端同形 JSON。 */
export interface WorkExecutionContext {
  employeeId: string
  agentId: string
  principalId: string
  appointmentId: string
  appointmentVersion: number
  workOrgId: string
  dataClass: WorkDataClass
  /** 原始业务发起人（有则保留，与员工身份并存不互覆）。 */
  requesterUserId?: string
  actChain?: Array<{ name: string; type: string }>
  issueId?: string
  runId?: string
  leaseVersion?: number
  /** 本次放行依据的工作授权（permit）ID。 */
  permitId: string
  capabilityManifestId?: string
  policyVersion: number
  traceId?: string
}

export type WorkPolicyDecision =
  | { allow: true; work: WorkExecutionContext }
  | { allow: false; code: WorkDenyCode; message: string }

/** 资源执行前策略端口：由 plugin-workforce 实现并登记；资源网关在网络动作前消费。 */
export interface ResourceExecutionPolicyPort {
  /** 可信 caller 反查受管员工；非员工返回 null（旧路径继续走原有授权链）。 */
  resolveManagedEmployee(caller: WorkCallerRef): Promise<ManagedEmployeeRef | null>
  /** 按技术 Agent 反查受管员工（Panel/A2A「问答 vs 执行」分型等场景使用）。 */
  describeManagedAgent(agentId: string): Promise<ManagedEmployeeRef | null>
  /**
   * 工作级授权：员工在岗、任用生效、permit 有效且主体匹配、run/租约归属、
   * 工具在能力清单、参数范围、审批与预算状态。返回放行时携带核验后上下文。
   */
  authorizeWorkAction(caller: WorkCallerRef, query: WorkActionQuery): Promise<WorkPolicyDecision>
}

/**
 * 登记器（platform-core 持有，装配早于一切业务插件）。
 * plugin-workforce 装配完成（迁移与各服务就绪）后调用 register()。
 */
export class WorkforcePolicyRegistry extends Service {
  static readonly provide = 'workforcePolicy'

  private provider: ResourceExecutionPolicyPort | null = null

  constructor(ctx: Context) {
    super(ctx, 'workforcePolicy')
  }

  register(provider: ResourceExecutionPolicyPort): void {
    this.provider = provider
    try {
      this.ctx.platformBus?.emit('workforce.port.ready', { at: new Date().toISOString() })
    } catch {
      // platformBus 未注入当前 fiber 时跳过通知（cordis 严格服务访问）
    }
  }

  /** 未登记返回 null：消费方据此走 legacy 或拒绝新工作路径（V29）。 */
  port(): ResourceExecutionPolicyPort | null {
    return this.provider
  }

  isReady(): boolean {
    return this.provider !== null
  }
}

export type ManagedWorkGate =
  | { mode: 'legacy' }
  | { mode: 'denied'; code: WorkDenyCode; message: string }
  | { mode: 'managed'; work: WorkExecutionContext }

/**
 * 网关统一消费助手：
 *   - 端口未就绪或调用者缺失 → legacy（非受管路径继续原授权链）；
 *   - caller 命中受管员工 → 工作级校验；拒绝则 denied（fail-closed）；
 *   - 端口执行异常 → denied POLICY_INTERNAL_ERROR（不静默降级）。
 * 判定只依据可信 caller，与请求是否携带 work 引用无关（D.5 防绕行）。
 */
export async function gateManagedWork(
  registry: WorkforcePolicyRegistry | null | undefined,
  caller: WorkCallerRef | undefined | null,
  query: WorkActionQuery,
): Promise<ManagedWorkGate> {
  const port = registry?.port?.() ?? null
  if (!port || !caller) return { mode: 'legacy' }
  let managed: ManagedEmployeeRef | null
  try {
    managed = await port.resolveManagedEmployee(caller)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { mode: 'denied', code: 'POLICY_INTERNAL_ERROR', message: t('工作策略反查失败（fail-closed）：{message}', { message }) }
  }
  if (!managed) return { mode: 'legacy' }
  try {
    const decision = await port.authorizeWorkAction(caller, query)
    return decision.allow ? { mode: 'managed', work: decision.work } : { mode: 'denied', code: decision.code, message: decision.message }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { mode: 'denied', code: 'POLICY_INTERNAL_ERROR', message: t('工作策略校验异常（fail-closed）：{message}', { message }) }
  }
}

// Cordis Context 类型增补：workforcePolicy 由 platform-core 首位装配时提供（provide='workforcePolicy'），
// 各资源网关与 exec-hub 经 ctx.workforcePolicy 消费——写进 Context 契约，消除消费方防御式读取的类型盲区
// （写法对齐 plugin-exec-hub/src/index.ts 末尾的 declare module）。
declare module '@deepseek-ai/cordis' {
  interface Context {
    workforcePolicy: WorkforcePolicyRegistry
  }
}
