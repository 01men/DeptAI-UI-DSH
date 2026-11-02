/**
 * 交付与验收服务（实施路径 §6.5：完成与验收分开）。
 *
 * 技术执行完成只形成「交付已提交」（deliverable submitted → exec-hub completeRun
 * 使任务转 review）；验收由具备 workforce.accept 的真人决定——通过→任务 done，
 * 退回→任务回 in_progress 并附原因。全部调用事实保留不删（V30：仅摘要无证据
 * 不能自动完成业务验收）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId } from '../../platform-core/src/ids.ts'
import type {
  ArtifactRecord,
  DeliverableRecord,
  PermitRecord,
  WorkforceDelivery,
  WorkforceIdentityResolver,
  WorkforceStore,
} from './contract.ts'
import { WorkforceError } from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type { WorkCallerRef } from '../../platform-core/src/workforce-port.ts'

export class DeliveryService extends Service implements WorkforceDelivery {
  static readonly provide = 'workforceDelivery'

  constructor(ctx: Context) {
    super(ctx, 'workforceDelivery')
  }

  // -- 依赖 -------------------------------------------------------------

  private get store(): WorkforceStore {
    const store = (this.ctx as unknown as { workforceStore?: WorkforceStore }).workforceStore
    if (!store || typeof store.txn !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceStore 未就绪（迁移未完成）'), 503)
    }
    return store
  }

  private get identity(): WorkforceIdentityResolver {
    const resolver = (this.ctx as unknown as { workforceIdentity?: WorkforceIdentityResolver }).workforceIdentity
    if (!resolver || typeof resolver.resolveByCaller !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceIdentity 未就绪'), 503)
    }
    return resolver
  }

  private admission(): { verifyPermit: (caller: WorkCallerRef, permitId: string, opts?: { requireRun?: boolean }) => Promise<PermitRecord> } {
    const admission = (this.ctx as unknown as {
      workforceAdmission?: { verifyPermit?: import('./contract.ts').WorkforceAdmission['verifyPermit'] }
    }).workforceAdmission
    if (!admission || typeof admission.verifyPermit !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceAdmission 未就绪'), 503)
    }
    return { verifyPermit: admission.verifyPermit.bind(admission) }
  }

  private emit(event: string, payload: unknown): void {
    try {
      ;(this.ctx as unknown as { platformBus?: { emit(name: string, payload: unknown): unknown } })
        .platformBus?.emit(event, payload)
    } catch {
      // platformBus 未注入当前 fiber 时跳过
    }
  }

  private warn(message: string): void {
    try {
      ;(this.ctx as unknown as { logger?: (name: string) => { warn(message: string): unknown } })
        .logger?.('workforce').warn(message)
    } catch {
      // logger 未注入时跳过
    }
  }

  // -- 提交 ---------------------------------------------------------------

  async submit(caller: WorkCallerRef, input: { permitId: string; summary: string; artifactIds: string[] }): Promise<DeliverableRecord> {
    const permit = await this.admission().verifyPermit(caller, input.permitId, { requireRun: true })
    if (!input.summary?.trim()) throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('交付摘要不能为空'))
    if (!Array.isArray(input.artifactIds) || input.artifactIds.length === 0) {
      // V30：仅摘要没有交付证据，不能形成有效交付
      throw new WorkforceError('ARTIFACT_SCOPE_DENIED', t('交付必须引用至少一个 artifact 证据'))
    }
    // artifact 全部存在且属该员工/该 run
    for (const artifactId of input.artifactIds) {
      const artifact = this.store.artifacts.get(artifactId)
      if (!artifact
        || artifact.employeeId !== permit.employeeId
        || (artifact.runId !== '' && artifact.runId !== permit.runId)) {
        throw new WorkforceError('ARTIFACT_SCOPE_DENIED', t('artifact {artifactId} 不存在或不属于该员工/该 run', { artifactId }))
      }
    }
    // 版本＝该 run max+1（退回重交不覆盖历史交付）。TableStore.insert 为 void——记录以
    // 本地变量返回，不得返回 insert() 结果（返回 void 会让提交链路拿到 undefined）
    const deliverable = this.store.txn(() => {
      const prior = this.store.deliverables.findWhere({ runId: permit.runId })
      const version = prior.reduce((max, item) => Math.max(max, item.version), 0) + 1
      const record: DeliverableRecord = {
        id: newId('wfdev'),
        runId: permit.runId,
        issueId: permit.issueId,
        employeeId: permit.employeeId,
        summary: input.summary.trim(),
        artifactIdsJson: JSON.stringify(input.artifactIds),
        version,
        status: 'submitted',
        submittedAt: new Date().toISOString(),
        decidedAt: '',
        decidedBy: '',
        decisionReason: '',
      }
      this.store.deliverables.insert(record)
      return record
    })
    // 任务转 review 由 exec-hub 收口：结构化探测 completeRun（真实签名 (runId, {status, summary})）。
    // 缺席/失败只告警不阻断——交付事实已落账，任务状态由运维对账收敛。
    try {
      const hub = (this.ctx as unknown as {
        execHub?: { completeRun?: (runId: string, options?: { status?: string; summary?: string }) => unknown }
      }).execHub
      if (typeof hub?.completeRun === 'function') {
        hub.completeRun(permit.runId, { status: 'completed', summary: t('数字员工交付提交：{id}', { id: deliverable.id }) })
      } else {
        this.warn(`execHub.completeRun 缺席：run ${permit.runId} 未自动转 review（交付 ${deliverable.id} 已落账，需人工对账）`)
      }
    } catch (error) {
      this.warn(`execHub.completeRun 失败（run ${permit.runId}）：${error instanceof Error ? error.message : String(error)}——交付 ${deliverable.id} 已落账，任务状态需人工对账`)
    }
    this.emit('workforce.deliverable.submitted', {
      deliverableId: deliverable.id, runId: deliverable.runId, issueId: deliverable.issueId,
      employeeId: deliverable.employeeId, version: deliverable.version,
    })
    return deliverable
  }

  // -- 验收 ---------------------------------------------------------------

  async decide(caller: WorkCallerRef, input: { deliverableId: string; decision: 'accepted' | 'rejected'; reason: string }): Promise<DeliverableRecord> {
    // 验收只能由真人作出（权限点 workforce.accept 由路由层把守，此处复核主体类型）
    if (caller.kind !== 'human') {
      throw new WorkforceError('PRINCIPAL_BINDING_MISMATCH', t('验收决定必须由真人作出（模型输出「成功」与 HTTP 200 都不能关闭业务任务）'))
    }
    if (!input.reason?.trim()) throw new WorkforceError('ARGUMENT_SCOPE_DENIED', t('验收/退回必须附原因'))
    const deliverable = this.store.deliverables.get(input.deliverableId)
    if (!deliverable) throw new WorkforceError('RUN_NOT_OWNED', t('交付不存在：{id}', { id: input.deliverableId }), 404)
    if (deliverable.status !== 'submitted') {
      throw new WorkforceError('STEP_ARGUMENT_CONFLICT', t('该交付已{state}，不可重复决定', { state: deliverable.status === 'accepted' ? t('验收通过') : t('被退回') }))
    }
    const actor = caller.userId ?? caller.principalId
    if (input.decision === 'accepted') {
      // 通过→关联任务 done（先流转后落账：回写失败则整体失败可重试，不留半决定）
      this.transitionIssue(deliverable, 'done', actor, true)
    } else {
      // 退回→任务回 in_progress 并附原因（流转失败只告警，退回事实照常落账）
      this.transitionIssue(deliverable, 'in_progress', actor, false)
    }
    // TableStore.update 为 void（落库副作用）——回读作为决定后事实（不得接收 update() 结果）
    this.store.deliverables.update(deliverable.id, {
      status: input.decision,
      decidedAt: new Date().toISOString(),
      decidedBy: actor,
      decisionReason: input.reason.trim(),
    })
    const updated = this.store.deliverables.get(deliverable.id)!
    this.emit('workforce.acceptance.decided', {
      deliverableId: updated.id, runId: updated.runId, issueId: updated.issueId,
      decision: input.decision, decidedBy: actor, reason: updated.decisionReason,
    })
    return updated
  }

  /**
   * exec-hub 任务状态回写（结构化探测服务层 transitionIssue(id, to, actor)——真实签名）。
   * 方法缺席：accepted 时阻断（任务不能无人收口）；rejected 时告警放行（退回事实已定）。
   */
  private transitionIssue(deliverable: DeliverableRecord, to: 'done' | 'in_progress', actor: string, blocking: boolean): void {
    if (!deliverable.issueId) {
      if (blocking) throw new WorkforceError('POLICY_INTERNAL_ERROR', t('交付未关联任务，无法回写验收结果（请检查 permit 签发链）'))
      this.warn(`交付 ${deliverable.id} 未关联任务，退回无需回写`)
      return
    }
    try {
      const hub = (this.ctx as unknown as {
        execHub?: { transitionIssue?: (id: string, to: string, actor: string) => unknown; issues?: () => { get(id: string): { status?: string } | undefined } }
      }).execHub
      if (typeof hub?.transitionIssue !== 'function' || typeof hub?.issues !== 'function') {
        if (blocking) throw new WorkforceError('POLICY_INTERNAL_ERROR', t('execHub.transitionIssue 缺席：验收通过但任务无法收口，请先接入执行中枢'))
        this.warn(`execHub.transitionIssue 缺席：任务 ${deliverable.issueId} 未回写 ${to}（交付 ${deliverable.id}）`)
        return
      }
      const issue = hub.issues().get(deliverable.issueId)
      if (!issue) {
        if (blocking) throw new WorkforceError('POLICY_INTERNAL_ERROR', t('关联任务不存在：{id}', { id: deliverable.issueId }))
        this.warn(`关联任务不存在：${deliverable.issueId}（交付 ${deliverable.id}）`)
        return
      }
      hub.transitionIssue(deliverable.issueId, to, actor)
    } catch (error) {
      if (blocking) {
        throw new WorkforceError('POLICY_INTERNAL_ERROR', t('验收通过但任务状态回写失败：{message}', { message: error instanceof Error ? error.message : String(error) }))
      }
      this.warn(`任务 ${deliverable.issueId} 回写 ${to} 失败（交付 ${deliverable.id}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // -- 查询 ---------------------------------------------------------------

  async get(caller: WorkCallerRef, deliverableId: string): Promise<DeliverableRecord> {
    const record = this.store.deliverables.get(deliverableId)
    if (!record) throw new WorkforceError('RUN_NOT_OWNED', t('交付不存在：{id}', { id: deliverableId }), 404)
    await this.assertReadable(caller, record.employeeId, this.workOrgOf(record))
    return record
  }

  async listByRun(caller: WorkCallerRef, runId: string): Promise<DeliverableRecord[]> {
    const records = this.store.deliverables.findWhere({ runId })
    if (records.length === 0) return []
    await this.assertReadable(caller, records[0]!.employeeId, this.workOrgOf(records[0]!))
    return records.sort((a, b) => a.version - b.version)
  }

  /** 交付引用的 artifact 元信息（验收人核对证据用）。 */
  artifactsOf(deliverable: DeliverableRecord): ArtifactRecord[] {
    const ids = this.parseIds(deliverable.artifactIdsJson)
    return ids.map((id) => this.store.artifacts.get(id)).filter((item): item is ArtifactRecord => Boolean(item))
  }

  // -- 内部 ---------------------------------------------------------------

  private workOrgOf(record: { issueId: string; employeeId: string }): string {
    // 工作组织以员工主组织近似（交付记录未冗余 orgId；同组织判定满足「不跨组织外泄」）
    return this.store.employees.get(record.employeeId)?.orgId ?? ''
  }

  private async assertReadable(caller: WorkCallerRef, employeeId: string, orgId: string): Promise<void> {
    const resolution = await this.identity.resolveByCaller(caller)
    if (resolution && resolution.employee.id === employeeId) return
    if (caller.kind === 'human' && caller.userId && orgId) {
      try {
        const iam = (this.ctx as unknown as { iam?: { users?: () => { get(id: string): { orgId?: string } | undefined } } }).iam
        const user = typeof iam?.users === 'function' ? iam.users().get(caller.userId) : undefined
        if (user?.orgId === orgId) return
      } catch {
        // fail-closed：落入末尾拒绝
      }
    }
    throw new WorkforceError('RUN_NOT_OWNED', t('无权查看该交付记录（仅本人或同组织主体）'))
  }

  private parseIds(text: string): string[] {
    try {
      const value = JSON.parse(text) as unknown
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }
}
