/**
 * MCP 工具可信风险登记（W 批次 W1 · V11 根治 · 决策 D-①（两级审批）/D-⑤（全量重审））。
 *
 * 背景（V11 根治）：远端 tools/list 同步的工具清单无法自证风险。旧口径把未申报工具隐式映射为
 * read（「未知即可读」），写能力可借同步通道绕过审批直接进入调用面。根治口径：
 *   - 网关闸门 facts.risk 一律取「本登记的生效值」（effectiveRisk）；无生效登记 → 'unknown'；
 *   - 'unknown' 的裁决在工作策略端口与网关只读语境：只读语境放行、写语境 RISK_UNREGISTERED 拒绝；
 *   - 写能力必须先经「登记 → 领域审批 → （write/admin）安全审批 → 生效」状态机（D-①）。
 *
 * 状态机（登记即提交，镜像 skillhub 两级审批形态）：
 *   pending_domain ─(domain approve, risk=read)──→ effective
 *   pending_domain ─(domain approve, risk=write|admin)──→ pending_security ─(security approve)──→ effective
 *   pending_domain / pending_security ─(reject)──→ rejected（终态，可重新登记开新单）
 *   effective ─(retire)──→ retired（退场后闸门回到 unknown，写语境即恢复拒绝——登记可生效也可收回）
 *
 * 唯一性：同一 (serviceId, toolName) 至多一条非 retired 记录——effective 必须先 retire 才能重新登记，
 * rejected 不阻断新登记（拒绝结论不锁定未来）。
 * 审批惯例（镜像 skillhub index.ts:265-269）：同人连审两级放开、同级别同人拒绝。
 *
 * 重审清单（D-⑤=a 全量重审后再开写）：枚举全部 external+real 服务的工具，逐工具对账
 * 「申报值 vs 生效登记值」，orphan 捕获登记指向已不存在的服务/工具（含服务滑出 external+real 范围）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type { McpServiceRecord, McpToolSpec } from './index.ts'

/** 可信风险登记的生效值域（申报值 additionally 允许 'unknown'——远端 tools/list 的诚实缺省）。 */
export type McpToolRiskLevel = 'read' | 'write' | 'admin'

/** 登记单状态：pending_* 审批中；effective 生效；rejected 驳回；retired 退场。 */
export type McpToolRiskStatus = 'pending_domain' | 'pending_security' | 'effective' | 'rejected' | 'retired'

/** 审批留痕条目（审批人身份一律来自服务端解析的 caller，不接受请求参数指定——防代审）。 */
export interface McpToolRiskApproval {
  level: 'domain' | 'security'
  approverId: string
  approverName: string
  opinion: string
  at: string
}

/** 风险登记单（opsStorage 集合 mcp:toolRisks）。 */
export interface McpToolRiskRecord {
  id: string
  serviceId: string
  toolName: string
  risk: McpToolRiskLevel
  status: McpToolRiskStatus
  registeredBy: string
  registeredByName: string
  registeredAt: string
  /** 登记理由（必填；write/admin 更须说明用途与影响面）。 */
  reason: string
  approvals: McpToolRiskApproval[]
  effectiveAt?: string
  retiredAt?: string
  /** 退场理由（additive：状态机契约外的留痕字段，重审与追溯依赖）。 */
  retireReason?: string
  updatedAt: string
}

/** 重审清单条目状态：unregistered=无生效登记（写能力一律已拒）；registered=申报与登记一致（或申报 unknown 而登记生效）；mismatch=生效登记值≠具体申报值；orphan=登记指向已不存在的服务/工具。 */
export type McpToolRiskReviewState = 'unregistered' | 'registered' | 'mismatch' | 'orphan'

export interface McpToolRiskReviewItem {
  serviceId: string
  serviceName: string
  toolName: string
  /** 工具清单申报值（orphan 且工具已消失时缺省）。 */
  declaredRisk?: McpToolSpec['riskLevel']
  /** 生效登记值（无生效登记时缺省）。 */
  registeredRisk?: McpToolRiskLevel
  state: McpToolRiskReviewState
}

export class McpToolRiskRegistry extends Service {
  static readonly provide = 'mcpToolRisks'

  constructor(ctx: Context) {
    super(ctx, 'mcpToolRisks')
  }

  /** 登记集合（照 index.ts services() 的 opsStorage getter 模式）。 */
  records(): Collection<McpToolRiskRecord> {
    return this.ctx.opsStorage.collection<McpToolRiskRecord>('mcp:toolRisks')
  }

  // -- 登记与审批 -----------------------------------------------------------

  /**
   * 登记即提交（D-①）：一律先落 pending_domain 领域审批；write/admin 在领域通过后自动升级安全审批。
   * reason 必填（护栏：无理由的写能力登记不受理）；身份来自服务端解析的 actor，不接受请求参数自报。
   */
  submit(input: { serviceId: string; toolName: string; risk: McpToolRiskLevel; reason: string; actor: { id: string; name: string } }): McpToolRiskRecord {
    if (!input.serviceId?.trim()) throw new Error(t('serviceId 必填'))
    if (!input.toolName?.trim()) throw new Error(t('toolName 必填'))
    if (!['read', 'write', 'admin'].includes(input.risk)) throw new Error(t('risk 须为 read/write/admin，收到 {value}', { value: String(input.risk) }))
    if (!input.reason?.trim()) throw new Error(t('登记必须填写原因（write/admin 风险更须说明用途与影响面）'))
    if (!input.actor?.id) throw new Error(t('登记人身份缺失（fail-closed：身份一律来自服务端解析）'))
    const service = this.ctx.mcpRegistry.services().get(input.serviceId)
    if (!service) throw new Error(t('MCP 服务不存在：{id}', { id: input.serviceId }))
    if (!service.tools.some((tool) => tool.name === input.toolName)) {
      throw new Error(t('服务 {service} 不存在工具 {tool}（请先同步工具清单再登记）', { service: service.name, tool: input.toolName }))
    }
    // 唯一性：同一 (serviceId, toolName) 至多一条「未结论」记录——effective 必须先 retire；
    // pending 等待审批；rejected/retired 已有结论，不阻断重新登记（拒绝与退场结论不锁定未来）。
    // findOne：集合 find 返回数组，空数组亦为真值，取单条须用 findOne。
    const existing = this.records().findOne((item) => item.serviceId === input.serviceId && item.toolName === input.toolName
      && item.status !== 'retired' && item.status !== 'rejected')
    if (existing) {
      if (existing.status === 'effective') throw new Error(t('工具已有生效登记（risk={risk}），变更须先退场（retire）再重新登记', { risk: existing.risk }))
      throw new Error(t('工具已有进行中的登记（status={status}），请等待审批完成或先行处理原单据', { status: existing.status }))
    }
    const at = now()
    return this.records().insert({
      id: newId('mtr'),
      serviceId: input.serviceId,
      toolName: input.toolName,
      risk: input.risk,
      status: 'pending_domain',
      registeredBy: input.actor.id,
      registeredByName: input.actor.name,
      registeredAt: at,
      reason: input.reason.trim(),
      approvals: [],
      updatedAt: at,
    })
  }

  /**
   * 两级审批裁决（D-①）。level 与当前 pending 级别不匹配即拒绝（顺序状态机不可跳级）；
   * 同人同级别不可重复审批（镜像 skillhub：同人连审两级放开、同级别同人拒绝）。
   */
  decide(id: string, input: { decision: 'approve' | 'reject'; level: 'domain' | 'security'; opinion?: string; actor: { id: string; name: string } }): McpToolRiskRecord {
    const record = this.requireRecord(id)
    if (record.status !== 'pending_domain' && record.status !== 'pending_security') {
      throw new Error(t('当前状态 {status} 不可审批（仅 pending 态可审批）', { status: record.status }))
    }
    if (record.status === 'pending_domain' && input.level !== 'domain') throw new Error(t('领域审批已完成，当前等待安全审批（level 须为 security）'))
    if (record.status === 'pending_security' && input.level !== 'security') throw new Error(t('当前等待安全审批（level 须为 security；write/admin 风险必须安全加签）'))
    if (!input.actor?.id) throw new Error(t('审批人身份缺失（fail-closed：身份一律来自服务端解析，防代审）'))
    if (record.approvals.some((item) => item.level === input.level && item.approverId === input.actor.id)) {
      throw new Error(t('同一审批人不可重复审批同一级'))
    }
    const approval: McpToolRiskApproval = {
      level: input.level,
      approverId: input.actor.id,
      approverName: input.actor.name,
      opinion: input.opinion ?? '',
      at: now(),
    }
    if (input.decision === 'reject') {
      // 任一 pending 态可 rejected：终态不阻断未来重新登记（拒绝结论不锁定工具一生）
      return this.records().update(id, { status: 'rejected', approvals: [...record.approvals, approval], updatedAt: now() })
    }
    // approve：domain 通过后 read 直接生效 / write|admin 必须转安全审批（D-① 两级）；security 通过后生效
    const nextStatus: McpToolRiskStatus = record.status === 'pending_domain'
      ? (record.risk === 'read' ? 'effective' : 'pending_security')
      : 'effective'
    const at = now()
    return this.records().update(id, {
      status: nextStatus,
      approvals: [...record.approvals, approval],
      ...(nextStatus === 'effective' ? { effectiveAt: at } : {}),
      updatedAt: at,
    })
  }

  /** 退场（仅 effective 可退）：退场后 effectiveRisk 回到 undefined，闸门回到 unknown——写语境即恢复拒绝。 */
  retire(id: string, input: { reason: string; actor: { id: string; name: string } }): McpToolRiskRecord {
    const record = this.requireRecord(id)
    if (record.status !== 'effective') throw new Error(t('当前状态 {status} 不可退场（仅生效登记可 retire）', { status: record.status }))
    if (!input.reason?.trim()) throw new Error(t('退场必须填写原因（护栏要求，重审与追溯依赖该口径）'))
    const at = now()
    return this.records().update(id, { status: 'retired', retiredAt: at, retireReason: input.reason.trim(), updatedAt: at })
  }

  // -- 查询与对账 -----------------------------------------------------------

  get(id: string): McpToolRiskRecord | undefined {
    return this.records().get(id)
  }

  list(filter: { serviceId?: string; status?: string; toolName?: string } = {}): { total: number; items: McpToolRiskRecord[] } {
    const items = this.records().find((item) => {
      if (filter.serviceId && item.serviceId !== filter.serviceId) return false
      if (filter.status && item.status !== filter.status) return false
      if (filter.toolName && item.toolName !== filter.toolName) return false
      return true
    }).sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))
    return { total: items.length, items }
  }

  /** 网关闸门的唯一可信风险来源：仅 effective 登记生效；pending/rejected/retired 一律视为未登记（unknown）。 */
  effectiveRisk(serviceId: string, toolName: string): McpToolRiskLevel | undefined {
    const record = this.records().findOne((item) => item.serviceId === serviceId && item.toolName === toolName && item.status === 'effective')
    return record?.risk
  }

  /**
   * 全量重审清单（D-⑤=a：全量重审后再开写）。范围 = 全部 mode==='external' && exec==='real' 服务的
   * 工具（演示/托管面不经真实远端同步通道，不在 V11 收敛范围）；另把指向已不存在服务/工具的
   * 非 retired 登记以 orphan 追加（清单外的事实同样必须可见，否则登记可悄悄悬空）。
   */
  reviewList(): { total: number; stats: Record<McpToolRiskReviewState, number>; items: McpToolRiskReviewItem[] } {
    const services = this.ctx.mcpRegistry.services().all()
      .filter((service: McpServiceRecord) => service.mode === 'external' && service.exec === 'real')
    const items: McpToolRiskReviewItem[] = []
    for (const service of services) {
      for (const tool of service.tools) {
        const registeredRisk = this.effectiveRisk(service.id, tool.name)
        const declared = tool.riskLevel
        // state 判定说明：declared==='unknown' 表示「未申报」（tools/list 同步的诚实缺省），
        // 与登记值不存在「矛盾」关系——有生效登记即 registered，不构成 mismatch；
        // mismatch 只留给「具体申报值 ≠ 生效登记值」的真实漂移（申报面被人为改过/登记过期）。
        let state: McpToolRiskReviewState
        if (!registeredRisk) state = 'unregistered'
        else if (!declared || declared === 'unknown') state = 'registered'
        else state = declared === registeredRisk ? 'registered' : 'mismatch'
        items.push({
          serviceId: service.id,
          serviceName: service.name,
          toolName: tool.name,
          declaredRisk: declared,
          ...(registeredRisk ? { registeredRisk } : {}),
          state,
        })
      }
    }
    for (const record of this.records().all()) {
      if (record.status === 'retired') continue
      // 服务不在 external+real 范围（被删/转托管/转演示）或工具已从清单消失 → orphan
      const service = services.find((item) => item.id === record.serviceId)
      if (service && service.tools.some((tool) => tool.name === record.toolName)) continue
      if (items.some((item) => item.serviceId === record.serviceId && item.toolName === record.toolName)) continue
      items.push({
        serviceId: record.serviceId,
        serviceName: service?.name ?? record.serviceId, // 服务已删除时无从取名，诚实落 ID
        toolName: record.toolName,
        ...(record.status === 'effective' ? { registeredRisk: record.risk } : {}),
        state: 'orphan',
      })
    }
    const stats: Record<McpToolRiskReviewState, number> = { unregistered: 0, registered: 0, mismatch: 0, orphan: 0 }
    for (const item of items) stats[item.state]++
    return { total: items.length, stats, items }
  }

  private requireRecord(id: string): McpToolRiskRecord {
    const record = this.records().get(id)
    if (!record) throw new Error(t('风险登记不存在：{id}', { id }))
    return record
  }
}

function now(): string {
  return new Date().toISOString()
}
