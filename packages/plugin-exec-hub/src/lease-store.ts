/**
 * 执行租约权威存储（LeaseStoreService）——exec_run_leases（SQLite txnStore）。
 *
 * 附录 A 决策 3/7（冻结）：SQLite 为租约唯一权威；issue.executionRunId /
 * executionAgentKey / executionLockedAt 三字段降级为投影（由 ExecutionHubService
 * 写齐保持现状兼容，读取裁决一律以本表为准）。
 *
 * 事务语义（txnStore.txn 同步 BEGIN IMMEDIATE）：
 *   - acquire：检查-插入/续期在同一事务内完成（Node 单线程 + 同步事务＝无并发窗口）；
 *     同一 issue 至多一条 active 且未过期租约；leaseVersion 按 issue 内单调递增。
 *   - renew：同主体 + active + 未过期 → 续 renewedAt/expiresAt；否则 LEASE_STALE。
 *   - release / releaseForIssue：run/issue 级批量置 released（终态封存，不删行——审计链保留）。
 *
 * 本文件不 import plugin-workforce（防循环，§10.2）；RunLeaseRecord 为
 * plugin-workforce contract.ts 冻结形状的结构镜像，字段逐一对齐。
 */
import { newId } from '../../platform-core/src/ids.ts'
import type { SqlValue } from '../../platform-core/src/sqlite.ts'
import { decideLeaseClaim, decideLeaseRenewal, type LeaseStatusLite } from './domain.ts'
import { t } from '../../platform-i18n/src/index.ts'

/** 执行租约（结构镜像 plugin-workforce contract.ts RunLeaseRecord，冻结形状 V1.0）。 */
export interface RunLeaseRecord {
  id: string
  issueId: string
  runId: string
  employeeId: string
  agentKey: string
  principalId: string
  leaseVersion: number
  status: LeaseStatusLite
  acquiredAt: string
  renewedAt: string
  expiresAt: string
  releasedAt: string
  releaseReason: string
}

/** txnStore 最小结构面（SqliteTxnService 结构化满足；便于测试注入替身）。 */
export interface LeaseTxnStore {
  ensureTable(name: string, columns: Record<string, string>, options?: { primaryKey?: string[]; uniques?: string[][]; indexes?: string[][] }): void
  insert(table: string, row: Record<string, SqlValue>): void
  updateByKey(table: string, primaryKey: string[], keyValues: SqlValue[], patch: Record<string, SqlValue>): void
  all<T = Record<string, SqlValue>>(table: string, where?: Record<string, SqlValue>): T[]
  one<T = Record<string, SqlValue>>(table: string, where: Record<string, SqlValue>): T | undefined
  txn<T>(fn: () => T): T
}

export const EXEC_RUN_LEASES_TABLE = 'exec_run_leases'

export interface AcquireLeaseInput {
  issueId: string
  runId: string
  /** 受管员工 ID；legacy 机器直认领传空串（幂等判同退化为 agentKey）。 */
  employeeId: string
  agentKey: string
  principalId: string
  ttlMs?: number
}

export type AcquireLeaseResult =
  | { ok: true; lease: RunLeaseRecord; created: boolean }
  | { ok: false; code: 'LEASE_HELD_BY_OTHER'; holder: string }

export type RenewLeaseResult =
  | { ok: true; lease: RunLeaseRecord }
  | { ok: false; code: 'LEASE_STALE'; message: string }

export interface RenewLeaseInput {
  /** 二选一：leaseId 精确续租，或 runId 取该 run 最新租约。 */
  leaseId?: string
  runId?: string
  /** 提供时必须与租约主体一致（端口 renewLease 传）；缺省＝hub 内部幂等续期（裁决已在 claim 层完成）。 */
  principalId?: string
  ttlMs?: number
}

export class LeaseStoreService {
  readonly table = EXEC_RUN_LEASES_TABLE
  private readonly txn: LeaseTxnStore
  private readonly defaultTtlMs: number
  private readonly nowMs: () => number

  constructor(txn: LeaseTxnStore, options: { ttlMs?: number; now?: () => number } = {}) {
    this.txn = txn
    this.defaultTtlMs = options.ttlMs ?? 15 * 60_000
    this.nowMs = options.now ?? (() => Date.now())
  }

  /** 建表（幂等）：列按 contract.RunLeaseRecord 冻结形状；索引 issueId+status、runId。 */
  migrate(): void {
    this.txn.ensureTable(this.table, {
      id: 'TEXT NOT NULL',
      issueId: 'TEXT NOT NULL',
      runId: 'TEXT NOT NULL',
      employeeId: "TEXT NOT NULL DEFAULT ''",
      agentKey: "TEXT NOT NULL DEFAULT ''",
      principalId: 'TEXT NOT NULL',
      leaseVersion: 'INTEGER NOT NULL DEFAULT 1',
      status: "TEXT NOT NULL DEFAULT 'active'",
      acquiredAt: 'TEXT NOT NULL',
      renewedAt: 'TEXT NOT NULL',
      expiresAt: 'TEXT NOT NULL',
      releasedAt: "TEXT NOT NULL DEFAULT ''",
      releaseReason: "TEXT NOT NULL DEFAULT ''",
    }, { indexes: [['issueId', 'status'], ['runId']] })
  }

  /**
   * 原子获得租约（事务内检查-置位）：
   *   - 已有有效租约：同持有者（受管按 employeeId、legacy 按 agentKey）→ 幂等续期返回 created=false；
   *     不同持有者 → LEASE_HELD_BY_OTHER + holder。
   *   - 无有效租约（含 active 但已过期——先标 superseded 再新取）：leaseVersion = 该 issue max+1。
   */
  acquire(input: AcquireLeaseInput): AcquireLeaseResult {
    return this.txn.txn(() => {
      const now = this.nowMs()
      const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : this.defaultTtlMs
      const existing = this.activeLeaseRow(input.issueId, now)
      if (existing) {
        const lease = this.rowToLease(existing)
        const decision = decideLeaseClaim({
          activeLeasePresent: true,
          activeLeaseExpired: false,
          existingEmployeeId: lease.employeeId,
          existingAgentKey: lease.agentKey,
          requestedEmployeeId: input.employeeId,
          requestedAgentKey: input.agentKey,
        })
        if (decision.kind === 'idempotent') {
          const renewed: RunLeaseRecord = {
            ...lease,
            renewedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + ttlMs).toISOString(),
          }
          this.txn.updateByKey(this.table, ['id'], [lease.id], { renewedAt: renewed.renewedAt, expiresAt: renewed.expiresAt })
          return { ok: true, lease: renewed, created: false }
        }
        return { ok: false, code: 'LEASE_HELD_BY_OTHER' as const, holder: decision.holder }
      }
      // 过期未标脏的 active 租约：降级为被取代（权威口径：过期＝无人实际持有）
      for (const row of this.txn.all<LeaseRow>(this.table, { issueId: input.issueId, status: 'active' })) {
        if (new Date(String(row.expiresAt)).getTime() <= now) {
          this.markSettled(String(row.id), 'superseded', 'expired')
        }
      }
      const version = this.maxVersionForIssue(input.issueId) + 1
      const nowIso = new Date(now).toISOString()
      const lease: RunLeaseRecord = {
        id: newId('lease'),
        issueId: input.issueId,
        runId: input.runId,
        employeeId: input.employeeId,
        agentKey: input.agentKey,
        principalId: input.principalId,
        leaseVersion: version,
        status: 'active',
        acquiredAt: nowIso,
        renewedAt: nowIso,
        expiresAt: new Date(now + ttlMs).toISOString(),
        releasedAt: '',
        releaseReason: '',
      }
      this.txn.insert(this.table, this.leaseToRow(lease))
      return { ok: true, lease, created: true }
    })
  }

  /** 续租：同主体 + active + 未过期才能续（principalId 缺省＝hub 内部裁决后续期，不重复校验）。 */
  renew(input: RenewLeaseInput): RenewLeaseResult {
    return this.txn.txn(() => {
      const now = this.nowMs()
      const row = input.leaseId
        ? this.txn.one<LeaseRow>(this.table, { id: input.leaseId })
        : this.latestLeaseRowForRun(input.runId ?? '')
      if (!row) return { ok: false as const, code: 'LEASE_STALE' as const, message: t('执行租约不存在（未认领或已被清理），请先重新认领') }
      const lease = this.rowToLease(row)
      const decision = decideLeaseRenewal({
        status: lease.status,
        expired: new Date(lease.expiresAt).getTime() <= now,
        principalMatches: input.principalId === undefined ? true : lease.principalId === input.principalId,
      })
      if (decision.kind === 'stale') {
        return { ok: false as const, code: 'LEASE_STALE' as const, message: t('执行租约已过期或被更高版本取代（旧租约），请先重新认领') }
      }
      const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : this.defaultTtlMs
      const renewed: RunLeaseRecord = {
        ...lease,
        renewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      }
      this.txn.updateByKey(this.table, ['id'], [lease.id], { renewedAt: renewed.renewedAt, expiresAt: renewed.expiresAt })
      return { ok: true as const, lease: renewed }
    })
  }

  /** run 级批量释放（终态收尾/停职联动），返回释放条数。 */
  release(runId: string, reason: string): number {
    return this.releaseWhere({ runId }, reason)
  }

  /** issue 级批量释放（任务取消/改派联动），返回释放条数。 */
  releaseForIssue(issueId: string, reason: string): number {
    return this.releaseWhere({ issueId }, reason)
  }

  private releaseWhere(where: { runId?: string; issueId?: string }, reason: string): number {
    return this.txn.txn(() => {
      let released = 0
      for (const row of this.txn.all<LeaseRow>(this.table, where)) {
        if (row.status !== 'active') continue
        this.markSettled(String(row.id), 'released', reason)
        released += 1
      }
      return released
    })
  }

  /** issue 当前有效租约（active 且未过期）；无则 undefined。 */
  activeForIssue(issueId: string, nowMs = this.nowMs()): RunLeaseRecord | undefined {
    const row = this.activeLeaseRow(issueId, nowMs)
    return row ? this.rowToLease(row) : undefined
  }

  /** run 当前有效租约（active 且未过期）；无则 undefined。 */
  activeForRun(runId: string, nowMs = this.nowMs()): RunLeaseRecord | undefined {
    const row = this.activeLeaseRowForRun(runId, nowMs)
    return row ? this.rowToLease(row) : undefined
  }

  /** run 最新一条租约记录（任意状态，含 released/superseded——D07 旧租约判定依据）。 */
  latestForRun(runId: string): RunLeaseRecord | undefined {
    const row = this.latestLeaseRowForRun(runId)
    return row ? this.rowToLease(row) : undefined
  }

  // -- 内部 -------------------------------------------------------------------

  private activeLeaseRow(issueId: string, nowMs: number): LeaseRow | undefined {
    for (const row of this.txn.all<LeaseRow>(this.table, { issueId, status: 'active' })) {
      if (new Date(String(row.expiresAt)).getTime() > nowMs) return row
    }
    return undefined
  }

  private activeLeaseRowForRun(runId: string, nowMs: number): LeaseRow | undefined {
    for (const row of this.txn.all<LeaseRow>(this.table, { runId, status: 'active' })) {
      if (new Date(String(row.expiresAt)).getTime() > nowMs) return row
    }
    return undefined
  }

  private latestLeaseRowForRun(runId: string): LeaseRow | undefined {
    return this.txn.all<LeaseRow>(this.table, { runId })
      .sort((a, b) => Number(b.leaseVersion) - Number(a.leaseVersion) || String(b.acquiredAt).localeCompare(String(a.acquiredAt)))[0]
  }

  private maxVersionForIssue(issueId: string): number {
    return this.txn.all<LeaseRow>(this.table, { issueId })
      .reduce((max, row) => Math.max(max, Number(row.leaseVersion) || 0), 0)
  }

  private markSettled(id: string, status: LeaseStatusLite, reason: string): void {
    this.txn.updateByKey(this.table, ['id'], [id], {
      status,
      releasedAt: new Date(this.nowMs()).toISOString(),
      releaseReason: reason,
    })
  }

  private rowToLease(row: LeaseRow): RunLeaseRecord {
    return {
      id: String(row.id),
      issueId: String(row.issueId),
      runId: String(row.runId),
      employeeId: String(row.employeeId ?? ''),
      agentKey: String(row.agentKey ?? ''),
      principalId: String(row.principalId ?? ''),
      leaseVersion: Number(row.leaseVersion),
      status: (row.status === 'released' || row.status === 'superseded' ? row.status : 'active') as LeaseStatusLite,
      acquiredAt: String(row.acquiredAt),
      renewedAt: String(row.renewedAt),
      expiresAt: String(row.expiresAt),
      releasedAt: String(row.releasedAt ?? ''),
      releaseReason: String(row.releaseReason ?? ''),
    }
  }

  private leaseToRow(lease: RunLeaseRecord): Record<string, SqlValue> {
    return {
      id: lease.id,
      issueId: lease.issueId,
      runId: lease.runId,
      employeeId: lease.employeeId,
      agentKey: lease.agentKey,
      principalId: lease.principalId,
      leaseVersion: lease.leaseVersion,
      status: lease.status,
      acquiredAt: lease.acquiredAt,
      renewedAt: lease.renewedAt,
      expiresAt: lease.expiresAt,
      releasedAt: lease.releasedAt,
      releaseReason: lease.releaseReason,
    }
  }
}

/** exec_run_leases 行原貌（SqlValue 口径）。 */
interface LeaseRow extends Record<string, SqlValue> {
  id: string
  issueId: string
  runId: string
  employeeId: string
  agentKey: string
  principalId: string
  leaseVersion: number
  status: string
  acquiredAt: string
  renewedAt: string
  expiresAt: string
  releasedAt: string
  releaseReason: string
}
