/**
 * 执行中枢纯决策层测试（对齐 Paperclip policy.test.ts 的表驱动穷举思路）。
 *
 * 运行方式（Node 直接加载）：
 *
 *     node --test packages/plugin-exec-hub/src/policy.test.mjs
 *
 * 覆盖面：
 *   - decideWakeAdmission 三态全组合穷举（2^6 事实组合）；
 *   - decideReleaseRecovery 僵尸锁裁决；
 *   - normalizeAgentKey / 血缘物化 / 上下文装配；
 *   - computeAgentHealth 五档边界；
 *   - 任务状态机与依赖解除语义；
 *   - 5 段 cron 词法与命中（含日/周 POSIX 或语义）；
 *   - 执行租约纯决策（附录 A 决策 3）：认领幂等（同主体幂等/他主体拒绝/过期可重取）、
 *     租约续期迁移（旧租约 stale）、complete 主体校验（D07）、run 采用裁决（V05）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  decideWakeAdmission, decideReleaseRecovery, normalizeAgentKey,
  materializeGoalAncestry, lineageSummary, buildIssueContextPack,
  computeAgentHealth, issueCanTransition, blockersResolved,
  cronMatches, cronIsValid, wakeIdempotencyKey,
  decideLeaseClaim, decideLeaseRenewal, decideCompleteOwnership, decideRunAdoption,
} from './domain.ts'

// ---------------------------------------------------------------------------
// decideWakeAdmission：2^6 全组合穷举
// ---------------------------------------------------------------------------

test('decideWakeAdmission：六事实全组合穷举与三态裁决', () => {
  const keys = [
    'isSameExecutionAgent', 'shouldDeferFollowupWake',
    'shouldQueueFollowupForRunningWake', 'availableActiveExecutionRunPresent',
    'allowRunCoalescing', 'sameDurableActor',
  ]
  let combinations = 0
  for (let mask = 0; mask < 64; mask += 1) {
    const facts = {}
    keys.forEach((key, index) => { facts[key] = Boolean((mask >> index) & 1) })
    const decision = decideWakeAdmission(facts)
    combinations += 1
    if (!facts.availableActiveExecutionRunPresent) {
      // 无活跃 run：一律 proceed（其余事实无关）
      assert.equal(decision.kind, 'proceed', `mask=${mask} 无活跃 run 应 proceed`)
    } else if (
      facts.isSameExecutionAgent && !facts.shouldDeferFollowupWake
      && !facts.shouldQueueFollowupForRunningWake && facts.allowRunCoalescing && facts.sameDurableActor
    ) {
      assert.equal(decision.kind, 'coalesce', `mask=${mask} 同 Agent 可合并应 coalesce`)
    } else {
      assert.equal(decision.kind, 'defer', `mask=${mask} 有活跃 run 不满足合并应 defer`)
    }
  }
  assert.equal(combinations, 64)
})

test('decideWakeAdmission：可选事实缺省语义（允许合并/同执行者）', () => {
  assert.equal(decideWakeAdmission({
    isSameExecutionAgent: true, shouldDeferFollowupWake: false,
    shouldQueueFollowupForRunningWake: false, availableActiveExecutionRunPresent: true,
  }).kind, 'coalesce')
  assert.equal(decideWakeAdmission({
    isSameExecutionAgent: true, shouldDeferFollowupWake: false,
    shouldQueueFollowupForRunningWake: false, availableActiveExecutionRunPresent: true,
    allowRunCoalescing: false,
  }).kind, 'defer')
  assert.equal(decideWakeAdmission({
    isSameExecutionAgent: true, shouldDeferFollowupWake: false,
    shouldQueueFollowupForRunningWake: false, availableActiveExecutionRunPresent: true,
    sameDurableActor: false,
  }).kind, 'defer')
})

// ---------------------------------------------------------------------------
// decideReleaseRecovery
// ---------------------------------------------------------------------------

test('decideReleaseRecovery：run 消失/终态强制释放，超时先终态，否则保持', () => {
  assert.equal(decideReleaseRecovery({ runMissing: true, runSettled: false, lockTimedOut: false }).kind, 'force-release')
  assert.equal(decideReleaseRecovery({ runMissing: false, runSettled: true, lockTimedOut: false }).kind, 'force-release')
  assert.equal(decideReleaseRecovery({ runMissing: false, runSettled: false, lockTimedOut: true }).kind, 'timeout-run')
  assert.equal(decideReleaseRecovery({ runMissing: false, runSettled: false, lockTimedOut: false }).kind, 'keep')
  // run 消失优先于超时判定（都为真也是 force-release，不做 timeout-run 画蛇添足）
  assert.equal(decideReleaseRecovery({ runMissing: true, runSettled: false, lockTimedOut: true }).kind, 'force-release')
})

// ---------------------------------------------------------------------------
// 名称归一化 / 血缘
// ---------------------------------------------------------------------------

test('normalizeAgentKey：大小写/首尾空白/连续空白归一', () => {
  assert.equal(normalizeAgentKey('  QC  Bot '), 'qc bot')
  assert.equal(normalizeAgentKey('QC Bot'), normalizeAgentKey('qc   bot'))
  assert.equal(normalizeAgentKey(''), '')
})

test('materializeGoalAncestry：目标链+项目物化，空链无项目为空数组', () => {
  assert.deepEqual(materializeGoalAncestry(['g_root', 'g_child'], 'p_1'), ['g_root', 'g_child', 'p_1'])
  assert.deepEqual(materializeGoalAncestry([], undefined), [])
  assert.deepEqual(materializeGoalAncestry(['g_root']), ['g_root'])
})

test('lineageSummary：标题回填与缺省', () => {
  assert.equal(lineageSummary(['g1', 'p1'], { g1: 'Q3 目标', p1: '视觉质检' }), 'Q3 目标 › 视觉质检')
  assert.equal(lineageSummary(['g1'], {}), 'g1')
  assert.equal(lineageSummary([], {}), '（未挂目标/项目）')
})

test('buildIssueContextPack：目标/前置/治理范围注记齐全', () => {
  const pack = buildIssueContextPack({
    goalTitle: '产线质检人效提升', goalMetric: '人均 1200 → 1600 件/日',
    projectNames: ['产线视觉质检改造'], issueTitle: '缺陷分类模型迭代 v2',
    blockerTitles: ['采集通道打通'], dataClass: 'internal',
    budgetNote: '本任务预算余量：¥42.50/日', permissionNote: '你被授予 exec.issue.run（生产部）',
  })
  assert.ok(pack.includes('目标：产线质检人效提升'))
  assert.ok(pack.includes('人均 1200 → 1600 件/日'))
  assert.ok(pack.includes('前置：等待「采集通道打通」完成'))
  assert.ok(pack.includes('internal'))
  assert.ok(pack.includes('¥42.50'))
  // 无阻塞依赖时前置行明确「无」
  const pack2 = buildIssueContextPack({ projectNames: [], issueTitle: 't' })
  assert.ok(pack2.includes('前置：无阻塞依赖'))
  assert.ok(pack2.includes('（未挂目标）'))
})

// ---------------------------------------------------------------------------
// computeAgentHealth
// ---------------------------------------------------------------------------

test('computeAgentHealth：五档裁决与阈值边界', () => {
  const now = 1_700_000_000_000
  assert.equal(computeAgentHealth({ agentStatus: 'offline', frozen: false, lastHeartbeatAt: now, lastMetricsReportAt: now, nowMs: now }), 'offline')
  assert.equal(computeAgentHealth({ agentStatus: 'archived', frozen: false, lastHeartbeatAt: null, lastMetricsReportAt: null, nowMs: now }), 'offline')
  assert.equal(computeAgentHealth({ agentStatus: 'online', frozen: true, lastHeartbeatAt: now, lastMetricsReportAt: now, nowMs: now }), 'frozen')
  // 配置心跳 10 分钟：新鲜窗口 3×10=30 分钟（容忍两轮漏报），迟滞窗口 9×10=90 分钟
  const base = { agentStatus: 'online', frozen: false, lastMetricsReportAt: null, heartbeatIntervalMinutes: 10 }
  assert.equal(computeAgentHealth({ ...base, lastHeartbeatAt: now - 30 * 60_000, nowMs: now }), 'healthy')
  assert.equal(computeAgentHealth({ ...base, lastHeartbeatAt: now - 31 * 60_000, nowMs: now }), 'stale')
  assert.equal(computeAgentHealth({ ...base, lastHeartbeatAt: now - 90 * 60_000, nowMs: now }), 'stale')
  assert.equal(computeAgentHealth({ ...base, lastHeartbeatAt: now - 91 * 60_000, nowMs: now }), 'silent')
  // 未配置心跳：24h 宽松口径，无心跳但有提报时用提报时点
  const loose = { agentStatus: 'online', frozen: false, heartbeatIntervalMinutes: 0 }
  assert.equal(computeAgentHealth({ ...loose, lastHeartbeatAt: null, lastMetricsReportAt: now - 3_600_000, nowMs: now }), 'healthy')
  assert.equal(computeAgentHealth({ ...loose, lastHeartbeatAt: null, lastMetricsReportAt: null, nowMs: now }), 'silent')
  // trial 也算运行态
  assert.equal(computeAgentHealth({ agentStatus: 'trial', frozen: false, lastHeartbeatAt: now, lastMetricsReportAt: null, nowMs: now }), 'healthy')
})

// ---------------------------------------------------------------------------
// 任务状态机 / 依赖解除
// ---------------------------------------------------------------------------

test('issueCanTransition：显式流转表与终态', () => {
  assert.ok(issueCanTransition('todo', 'in_progress'))
  assert.ok(issueCanTransition('in_progress', 'review'))
  assert.ok(issueCanTransition('review', 'done'))
  assert.ok(issueCanTransition('review', 'in_progress')) // 打回
  assert.ok(issueCanTransition('todo', 'cancelled'))
  assert.ok(issueCanTransition('review', 'cancelled'))
  assert.ok(!issueCanTransition('todo', 'done'))        // 不允许跳过执行/审阅
  assert.ok(!issueCanTransition('todo', 'review'))
  assert.ok(!issueCanTransition('done', 'todo'))
  assert.ok(!issueCanTransition('cancelled', 'todo'))
  assert.ok(!issueCanTransition('done', 'cancelled'))
})

test('blockersResolved：全部终态才解除，cancelled 视为解除（不无限挂起）', () => {
  assert.ok(blockersResolved([]))
  assert.ok(blockersResolved(['done']))
  assert.ok(blockersResolved(['done', 'cancelled']))
  assert.ok(!blockersResolved(['done', 'todo']))
  assert.ok(!blockersResolved(['in_progress']))
})

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

test('cronIsValid：词法校验', () => {
  assert.ok(cronIsValid('* * * * *'))
  assert.ok(cronIsValid('*/5 * * * *'))
  assert.ok(cronIsValid('30 9 * * 1-5'))
  assert.ok(cronIsValid('0 0 1 1 *'))
  assert.ok(!cronIsValid('* * * *'))           // 段数不足
  assert.ok(!cronIsValid('* * * * * *'))       // 段数过多
  assert.ok(!cronIsValid('60 * * * *'))        // 分钟越界
  assert.ok(!cronIsValid('*/0 * * * *'))       // 步进 0
  assert.ok(!cronIsValid('a * * * *'))         // 非数字
  assert.ok(!cronIsValid('5-1 * * * *'))       // 区间倒置
})

test('cronMatches：命中矩阵（UTC）', () => {
  const at = new Date('2026-10-14T09:30:00Z') // 周三
  assert.ok(cronMatches('* * * * *', at))
  assert.ok(cronMatches('30 * * * *', at))
  assert.ok(cronMatches('*/15 * * * *', at))  // 30 是 15 的倍数
  assert.ok(!cronMatches('*/7 * * * *', at))  // 30 不是 7 的倍数（0,7,14,21,28）
  assert.ok(cronMatches('30 9 * * *', at))
  assert.ok(!cronMatches('30 10 * * *', at))
  assert.ok(cronMatches('30 9 14 10 *', at))
  assert.ok(!cronMatches('30 9 15 10 *', at))
  assert.ok(cronMatches('30 9 * * 3', at))    // 周三
  assert.ok(!cronMatches('30 9 * * 0', at))   // 0=周日：不该命中周三（0 统一归一到 7 的值域之外）
  // 周日命中：2026-10-18 是周日
  const sunday = new Date('2026-10-18T09:30:00Z')
  assert.ok(cronMatches('30 9 * * 0', sunday))
  assert.ok(cronMatches('30 9 * * 7', sunday))
  assert.ok(!cronMatches('30 9 * * 3', sunday))
  // 日/周双收窄 POSIX 或语义：每月 13 号或每个周三（时刻取 00:00 以命中分/时字段）
  assert.ok(cronMatches('0 0 13 * 3', new Date('2026-10-14T00:00:00Z')))   // 10-14 周三命中（周满足）
  assert.ok(!cronMatches('0 0 13 * 3', new Date('2026-10-15T00:00:00Z'))) // 周四非 13 号
})

test('wakeIdempotencyKey：拼接稳定', () => {
  assert.equal(wakeIdempotencyKey('assign', ['i1', 'a1', 42]), 'assign:i1:a1:42')
  assert.equal(wakeIdempotencyKey('assign', ['i1', undefined]), 'assign:i1:')
})

// ---------------------------------------------------------------------------
// 执行租约纯决策（附录 A 决策 3：认领幂等 / 租约迁移 / complete 主体校验）
// ---------------------------------------------------------------------------

test('decideLeaseClaim：同主体重复认领=幂等，他主体=拒绝，过期=可重取', () => {
  // 受管员工：按 employeeId 判同（换绑 agentKey 不影响幂等——契约「同员工+同任务返回既有 run」）
  assert.deepEqual(decideLeaseClaim({
    activeLeasePresent: true, activeLeaseExpired: false,
    existingEmployeeId: 'emp_1', existingAgentKey: 'employee:emp_1',
    requestedEmployeeId: 'emp_1', requestedAgentKey: 'qc bot',
  }), { kind: 'idempotent' })
  // 他员工持有 → held-by-other（holder 取 agentKey 优先）
  assert.deepEqual(decideLeaseClaim({
    activeLeasePresent: true, activeLeaseExpired: false,
    existingEmployeeId: 'emp_1', existingAgentKey: 'employee:emp_1',
    requestedEmployeeId: 'emp_2', requestedAgentKey: 'employee:emp_2',
  }), { kind: 'held-by-other', holder: 'employee:emp_1' })
  // legacy 机器直认领（employeeId 空串）：按 agentKey 判同
  assert.deepEqual(decideLeaseClaim({
    activeLeasePresent: true, activeLeaseExpired: false,
    existingEmployeeId: '', existingAgentKey: 'qc bot',
    requestedEmployeeId: '', requestedAgentKey: 'qc bot',
  }), { kind: 'idempotent' })
  assert.deepEqual(decideLeaseClaim({
    activeLeasePresent: true, activeLeaseExpired: false,
    existingEmployeeId: '', existingAgentKey: 'qc bot',
    requestedEmployeeId: '', requestedAgentKey: 'pack bot',
  }), { kind: 'held-by-other', holder: 'qc bot' })
  // legacy 认领不得幂等接管受管租约（employeeId 口径不同即他主体）
  assert.equal(decideLeaseClaim({
    activeLeasePresent: true, activeLeaseExpired: false,
    existingEmployeeId: 'emp_1', existingAgentKey: 'employee:emp_1',
    requestedEmployeeId: '', requestedAgentKey: 'employee:emp_1',
  }).kind, 'held-by-other')
  // 过期租约＝无人实际持有 → acquire（新版本+1）
  assert.deepEqual(decideLeaseClaim({
    activeLeasePresent: true, activeLeaseExpired: true,
    existingEmployeeId: 'emp_1', existingAgentKey: 'employee:emp_1',
    requestedEmployeeId: 'emp_1', requestedAgentKey: 'employee:emp_1',
  }), { kind: 'acquire' })
  // 无租约 → acquire
  assert.deepEqual(decideLeaseClaim({
    activeLeasePresent: false, activeLeaseExpired: false,
    existingEmployeeId: '', existingAgentKey: '',
    requestedEmployeeId: 'emp_9', requestedAgentKey: 'employee:emp_9',
  }), { kind: 'acquire' })
})

test('decideLeaseRenewal：同主体+active+未过期才续，旧租约一律 stale', () => {
  assert.deepEqual(decideLeaseRenewal({ status: 'active', expired: false, principalMatches: true }), { kind: 'renew' })
  // 旧租约（被更高版本取代）
  assert.deepEqual(decideLeaseRenewal({ status: 'superseded', expired: false, principalMatches: true }), { kind: 'stale' })
  // 已释放
  assert.deepEqual(decideLeaseRenewal({ status: 'released', expired: false, principalMatches: true }), { kind: 'stale' })
  // 已过期（即使 active 且同主体）
  assert.deepEqual(decideLeaseRenewal({ status: 'active', expired: true, principalMatches: true }), { kind: 'stale' })
  // 他主体（fail-closed：主体缺席视为不一致）
  assert.deepEqual(decideLeaseRenewal({ status: 'active', expired: false, principalMatches: false }), { kind: 'stale' })
})

test('decideCompleteOwnership：无租约兼容放行；旧租约=LEASE_STALE；主体不符=RUN_NOT_OWNED', () => {
  // 旧路径 run（无租约记录）→ 兼容放行（D07 口径：有租约记录才强制主体一致）
  assert.deepEqual(decideCompleteOwnership({
    hasLeaseRecord: false, status: 'released', expired: true,
    callerPrincipalId: '', leasePrincipalId: '',
  }), { kind: 'allow' })
  // 主体一致 + active + 未过期 → allow
  assert.deepEqual(decideCompleteOwnership({
    hasLeaseRecord: true, status: 'active', expired: false,
    callerPrincipalId: 'prin_a', leasePrincipalId: 'prin_a',
  }), { kind: 'allow' })
  // 旧租约（superseded）→ LEASE_STALE（先于主体判定）
  assert.deepEqual(decideCompleteOwnership({
    hasLeaseRecord: true, status: 'superseded', expired: false,
    callerPrincipalId: 'prin_a', leasePrincipalId: 'prin_a',
  }), { kind: 'deny', code: 'LEASE_STALE', reason: '执行租约已过期或被更高版本取代（旧租约），请先重新认领' })
  // 过期 active → LEASE_STALE
  assert.equal(decideCompleteOwnership({
    hasLeaseRecord: true, status: 'active', expired: true,
    callerPrincipalId: 'prin_a', leasePrincipalId: 'prin_a',
  }).code, 'LEASE_STALE')
  // 主体不符 → RUN_NOT_OWNED（V06：员工用另一个 run 提交完成被拒）
  assert.equal(decideCompleteOwnership({
    hasLeaseRecord: true, status: 'active', expired: false,
    callerPrincipalId: 'prin_b', leasePrincipalId: 'prin_a',
  }).code, 'RUN_NOT_OWNED')
  // 调用主体缺席 + 有租约 → fail-closed 拒绝（不能匿名交回他人 run）
  assert.equal(decideCompleteOwnership({
    hasLeaseRecord: true, status: 'active', expired: false,
    callerPrincipalId: '', leasePrincipalId: 'prin_a',
  }).code, 'RUN_NOT_OWNED')
})

test('decideRunAdoption：投影运行中=adopt（V05 不因预持锁卡死），缺席/脏投影=create', () => {
  assert.deepEqual(decideRunAdoption({ projectedRunIdPresent: true, projectedRunRunning: true }), { kind: 'adopt' })
  assert.deepEqual(decideRunAdoption({ projectedRunIdPresent: false, projectedRunRunning: false }), { kind: 'create' })
  // 投影指向已终态/已消失的 run＝脏投影 → 新建
  assert.deepEqual(decideRunAdoption({ projectedRunIdPresent: true, projectedRunRunning: false }), { kind: 'create' })
})
