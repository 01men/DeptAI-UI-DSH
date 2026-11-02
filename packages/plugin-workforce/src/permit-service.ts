/**
 * 工作授权（permit）服务（实施路径 §8.1/§13，附录 A 决策 4）。
 *
 * permit 是服务端签发的不透明随机 ID（generateSecret，非 JWT、非自解码结构），
 * 绑定主体/员工/任用版本/能力清单/run/租约，短期有效、可撤销；
 * 调用必须同时持真实机器令牌——permit 字符串本身不是凭证。
 * 权威存储：workforce_permits（SQLite，契约 WORKFORCE_TABLES）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { generateSecret } from '../../platform-core/src/ids.ts'
import type { WorkCallerRef } from '../../platform-core/src/workforce-port.ts'
import {
  WorkforceError,
  type IdentityResolution,
  type PermitRecord,
  type RunLeaseRecord,
  type WorkforcePermits,
  type WorkforceStore,
} from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'

/** permit 默认有效期：30 分钟（§8.3 短期授权；租约默认 15 分钟由 exec-hub 侧持有）。 */
const DEFAULT_PERMIT_TTL_MS = 30 * 60_000

export class PermitService extends Service implements WorkforcePermits {
  static readonly provide = 'workforcePermits'

  private readonly ttlMs: number

  constructor(ctx: Context, config: { permitTtlMs?: number } = {}) {
    super(ctx, 'workforcePermits')
    this.ttlMs = config.permitTtlMs && config.permitTtlMs > 0 ? config.permitTtlMs : DEFAULT_PERMIT_TTL_MS
  }

  // -- 依赖（结构化消费组1仓储实现，不反向依赖具体类） ---------------------------------

  private get store(): WorkforceStore {
    const store = (this.ctx as unknown as { workforceStore?: WorkforceStore }).workforceStore
    if (!store || typeof store.txn !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceStore 未就绪（迁移未完成）'), 503)
    }
    return store
  }

  private emit(event: string, payload: unknown): void {
    try {
      ;(this.ctx as unknown as { platformBus?: { emit(name: string, payload: unknown): unknown } })
        .platformBus?.emit(event, payload)
    } catch {
      // platformBus 未注入当前 fiber 时跳过（cordis 严格服务访问）
    }
  }

  // -- 签发 -------------------------------------------------------------

  issue(input: {
    resolution: IdentityResolution
    issueId: string
    runId: string
    lease: RunLeaseRecord
    manifestId: string
    ttlMs: number
  }): PermitRecord {
    const now = new Date().toISOString()
    const ttl = input.ttlMs > 0 ? input.ttlMs : this.ttlMs
    // 不透明随机 ID：不可猜测、不可自解码（附录 A 决策 4）；主体取绑定 principalId（机器令牌反查事实）
    const record: PermitRecord = {
      id: generateSecret('wfpermit'),
      employeeId: input.resolution.employee.id,
      agentId: input.resolution.binding.agentId,
      principalId: input.resolution.binding.principalId,
      appointmentId: input.resolution.appointment.id,
      appointmentVersion: input.resolution.appointment.version,
      manifestId: input.manifestId,
      issueId: input.issueId,
      runId: input.runId,
      leaseId: input.lease.id,
      leaseVersion: input.lease.leaseVersion,
      status: 'active',
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      createdAt: now,
      revokedAt: '',
      revokedReason: '',
    }
    // TableStore.insert 为 void（落库副作用）——记录以本地变量返回，不得返回 insert() 结果
    this.store.permits.insert(record)
    return record
  }

  // -- 校验 -------------------------------------------------------------

  verify(permitId: string, caller: WorkCallerRef, opts?: { requireRun?: boolean }): PermitRecord {
    const permit = this.store.permits.get(permitId)
    if (!permit || permit.status !== 'active') {
      throw new WorkforceError('TOOL_NOT_GRANTED', t('工作授权 permit 不存在或已失效（{permitId}…）', { permitId: permitId.slice(0, 12) }))
    }
    if (permit.expiresAt && permit.expiresAt <= new Date().toISOString()) {
      throw new WorkforceError('TOOL_NOT_GRANTED', t('工作授权 permit 已过期，请重新认领（workforce_claim）'))
    }
    if (permit.principalId && caller.principalId !== permit.principalId) {
      throw new WorkforceError('PRINCIPAL_BINDING_MISMATCH', t('permit 与当前调用主体不匹配（permit 主体绑定为签发时机器主体）'))
    }
    if (opts?.requireRun) {
      if (!permit.runId || !permit.leaseId) {
        throw new WorkforceError('RUN_NOT_OWNED', t('permit 未绑定执行 run/租约，不能用于资源调用'))
      }
    }
    // 任用版本与 IdentityResolution 一致性由调用方组合校验（admission/port 持有解析结果）
    return permit
  }

  // -- 撤销 -------------------------------------------------------------

  revoke(permitId: string, reason: string): void {
    const permit = this.store.permits.get(permitId)
    if (!permit || permit.status !== 'active') return
    this.store.permits.update(permitId, {
      status: 'revoked',
      revokedAt: new Date().toISOString(),
      revokedReason: reason,
    })
    this.emit('workforce.permit.revoked', { permitId, employeeId: permit.employeeId, runId: permit.runId, reason })
  }

  revokeForEmployee(employeeId: string, reason: string): number {
    let revoked = 0
    for (const permit of this.store.permits.findWhere({ employeeId, status: 'active' })) {
      if (permit.expiresAt && permit.expiresAt <= new Date().toISOString()) continue
      this.revoke(permit.id, reason)
      revoked += 1
    }
    return revoked
  }

  activeForRun(runId: string): PermitRecord | undefined {
    return this.store.permits.findWhere({ runId })
      .filter((permit) => permit.status === 'active' && (!permit.expiresAt || permit.expiresAt > new Date().toISOString()))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }
}
