/**
 * 台账维护服务（maintenance-service，W5 运维面，决策 D-③ three-in-one 最小集）。
 *
 * 职责（「定时器跑 + admin 手动跑同一函数」，与 plugin-usage 保留巡检、exec-hub tick 同款先例）：
 *   1. 过期 permit 落账：workforce_permits 内 status='active' 且 expiresAt<=now 的行
 *      逐个落 'expired'。调用校验（permit-service.verify / activeForRun）本就按 expiresAt
 *      即时拒绝，落账只是把「事实已发生」回写台账（「过期不落库」的历史口径自此收敛，
 *      诚实呈现）；本服务是仓库内唯一写 'expired' 的位置；不发事件、不动 exec-hub
 *      （过期不是撤销，无联动面）。
 *   2. 终态 run 台账盘点（只计数、不删行）：workforce_* 各表是审计账本（附录 A 决策 7），
 *      与租约「终态封存不删行」同口径——终态 run（exec-hub 结构化探测，
 *      status∈{completed,failed,timeout}）关联的 permit/invocation/deliverable 行
 *      只出计数报告，供运维评估归档策略，绝不就地删除历史事实。
 *
 * 定时器纪律（lint-timers 硬门禁，照 plugin-usage retention 形态）：
 * 构造期 setTimeout 首跑（20s，避开装配热路径）+ setInterval 巡检 + `.unref?.()`
 * + `ctx.effect(clearInterval)` 生命周期登记。
 * env 开关 WORKFORCE_MAINTENANCE_INTERVAL_MS：默认 6h=21600000；0=停用定时仅手动。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { t } from '../../platform-i18n/src/index.ts'
import type { WorkforceStore } from './contract.ts'

/** 默认巡检间隔：6 小时（与 usage 保留巡检同节奏）。 */
const DEFAULT_INTERVAL_MS = 6 * 3_600_000
/** 构造期首跑延迟（毫秒）：照 plugin-usage retention 的 20s。 */
const FIRST_SWEEP_DELAY_MS = 20_000

/** exec-hub run 集合的结构化探测形状（缺席＝盘点能力缺失，过期落账不受影响；不反向 import）。 */
interface ExecHubRunsProbe {
  runs?: () => { all(): Array<{ id: string; status: string }> }
}

/** run 终态全集（exec-hub RunStatus 除 running 外三态）；字面同步，结构化探测不产生依赖。 */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'timeout'])

export interface MaintenanceRunResult {
  ranAt: string
  /** 本轮落 'expired' 的 permit ID（调用校验此前已即时拒绝，落账为事后回写）。 */
  expiredPermits: string[]
  /** 终态 run 数（盘点基准）。 */
  terminalRunCount: number
  /** 挂在终态 run 上的台账行计数（只报告不删行）。 */
  permitsOnTerminalRuns: number
  invocationsOnTerminalRuns: number
  deliverablesOnTerminalRuns: number
}

export class MaintenanceService extends Service {
  static readonly provide = 'workforceMaintenance'

  /** 巡检间隔（毫秒）；0=定时停用，仅 admin 手动触发。 */
  readonly intervalMs: number

  private timer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context) {
    super(ctx, 'workforceMaintenance')
    const parsed = Number(process.env.WORKFORCE_MAINTENANCE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    this.intervalMs = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_INTERVAL_MS
    const logger = ctx.logger('workforce')
    if (this.intervalMs > 0) {
      logger.info(`workforce 台账巡检：每 ${this.intervalMs}ms（WORKFORCE_MAINTENANCE_INTERVAL_MS，0=停用定时仅手动）`)
      const first = setTimeout(() => void this.sweep(), FIRST_SWEEP_DELAY_MS)
      ctx.effect(() => () => clearTimeout(first))
      this.timer = setInterval(() => void this.sweep(), this.intervalMs)
      this.timer.unref?.() // OPT-P3-02：嵌入形态不挂起事件循环（lint-timers 硬门禁）
      ctx.effect(() => () => {
        if (this.timer) clearInterval(this.timer)
      })
    } else {
      logger.info('workforce 台账巡检定时器停用（WORKFORCE_MAINTENANCE_INTERVAL_MS=0），仅 admin 手动触发')
    }
  }

  // -- 依赖（结构化探测，不反向依赖 exec-hub；store 缺席按可观测错误处理） ------------------

  private get store(): WorkforceStore {
    const store = (this.ctx as unknown as { workforceStore?: WorkforceStore }).workforceStore
    if (!store || typeof store.txn !== 'function') {
      throw new Error(t('workforceStore 未就绪（迁移未完成），台账巡检无法执行'))
    }
    return store
  }

  private execHub(): ExecHubRunsProbe | undefined {
    return (this.ctx as unknown as { execHub?: ExecHubRunsProbe }).execHub
  }

  // -- 巡检主体（定时器与 admin 手动口共用同一函数） -----------------------------------------

  run(): MaintenanceRunResult {
    const now = new Date().toISOString()
    // 1. 过期 permit 落账：仓库内唯一写 'expired' 处（逐行短事务；不发事件、不动 exec-hub）
    const expiredPermits: string[] = []
    for (const permit of this.store.permits.findWhere({ status: 'active' })) {
      if (!permit.expiresAt || permit.expiresAt > now) continue
      this.store.txn(() => {
        this.store.permits.update(permit.id, { status: 'expired' })
      })
      expiredPermits.push(permit.id)
    }
    // 2. 终态 run 台账盘点（只计数不删行——审计账本「终态封存」，与租约同口径）
    const hub = this.execHub()
    const terminalRunIds = new Set<string>(
      (hub && typeof hub.runs === 'function' ? hub.runs().all() : [])
        .filter((run) => TERMINAL_RUN_STATUSES.has(run.status))
        .map((run) => run.id),
    )
    const onTerminal = (rows: Array<{ runId: string }>): number =>
      rows.filter((row) => row.runId !== '' && terminalRunIds.has(row.runId)).length
    return {
      ranAt: now,
      expiredPermits,
      terminalRunCount: terminalRunIds.size,
      permitsOnTerminalRuns: onTerminal(this.store.permits.all()),
      invocationsOnTerminalRuns: onTerminal(this.store.invocations.all()),
      deliverablesOnTerminalRuns: onTerminal(this.store.deliverables.all()),
    }
  }

  private async sweep(): Promise<void> {
    try {
      const result = this.run()
      this.ctx.logger('workforce').info(
        `workforce 台账巡检：过期 permit 落账 ${result.expiredPermits.length} 条；` +
          `终态 run ${result.terminalRunCount} 个（挂 permit ${result.permitsOnTerminalRuns}/` +
          `invocation ${result.invocationsOnTerminalRuns}/deliverable ${result.deliverablesOnTerminalRuns} 行，封存不删行）`,
      )
    } catch (error) {
      this.ctx.logger('workforce').warn('workforce 台账巡检失败', error)
    }
  }
}
