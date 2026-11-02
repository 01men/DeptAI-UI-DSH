/**
 * Policy Decision Point（MCP 治理契约 §11，W3-T5）。
 *
 * 平台级策略裁决点：业务面（MCP 网关 / NAS / Connector）把各自的判定逻辑收敛为
 * PolicyModule 注册进本点，统一产出 PolicyDecision（allow / reasons / decisionId /
 * obligations）——「同一决策表达与登记」：任何放行/拒绝都能给出结构化决策与
 * decisionId，随调用记录与审计事件落库（审计可按决策链还原裁决依据）。
 *
 * 聚合语义（契约钉死）：
 *   - deny 优先：任一模块 deny 即整体 allow=false；
 *   - reasons 聚合：按模块注册序拼接全部模块的理由（首个 deny 模块的理由即主因，
 *     消费方以此保持既有领域拒绝文案不漂移）；
 *   - obligations 聚合：各模块放行时的结构化义务（如 {type:'read-only'}）原样汇总，
 *     供审计展示；本波不新增执行语义。
 *   - decisionId = `pd_<newId>`（platform-core newId，进程内递增可排序）。
 */
import { newId } from './ids.ts'
import type { UnifiedPrincipal } from './principal.ts'

/** 策略决策（契约 §11 类型逐字）。 */
export interface PolicyDecision {
  allow: boolean
  reasons: string[]
  decisionId: string
  obligations: Array<{ type: string; [k: string]: unknown }>
}

/** 策略裁决请求（契约 §11 类型逐字）。 */
export interface PolicyRequest {
  subject: UnifiedPrincipal
  action: string
  resource: { type: string; id: string; orgId?: string; dataClass?: string; [k: string]: unknown }
  tool?: { name: string; risk?: string }
  context: { environment?: string; traceId?: string; [k: string]: unknown }
}

/** 策略模块（契约 §11 类型逐字）：id + 同步/异步 decide。 */
export interface PolicyModule {
  id: string
  decide(req: PolicyRequest): Promise<PolicyDecision> | PolicyDecision
}

/** 模块级决策的便捷构造（各模块内部统一出口，保证 decisionId 形态一致）。 */
export function moduleDecision(
  allow: boolean,
  reasons: string[],
  obligations: Array<{ type: string; [k: string]: unknown }> = [],
): PolicyDecision {
  return { allow, reasons: [...reasons], decisionId: newId('pd'), obligations }
}

/**
 * 策略决策点：register 收编模块，decide 按注册序逐模块裁决并聚合。
 * 模块异常不放大为裁决失败（fail-safe：该模块记为 deny 并注明异常理由——
 * 与平台既有 fail-closed 口径一致，绝不因模块崩溃而静默放行）。
 */
export class PolicyDecisionPoint {
  private modules: PolicyModule[] = []

  register(m: PolicyModule): void {
    this.modules.push(m)
  }

  /** 已注册模块 id（只读视图，供装配面诊断）。 */
  moduleIds(): string[] {
    return this.modules.map((m) => m.id)
  }

  async decide(req: PolicyRequest): Promise<PolicyDecision> {
    const allowReasons: string[] = []
    const denyReasons: string[] = []
    const obligations: Array<{ type: string; [k: string]: unknown }> = []
    let allow = true
    for (const module of this.modules) {
      let decision: PolicyDecision
      try {
        decision = await module.decide(req)
      } catch (error) {
        // 模块抛错按该模块 deny 处理（fail-closed）：理由注明模块与异常，不阻断其余模块
        const message = error instanceof Error ? error.message : String(error)
        decision = { allow: false, reasons: [`模块 ${module.id} 裁决异常（fail-closed）：${message}`], decisionId: newId('pd'), obligations: [] }
      }
      ;(decision.allow ? allowReasons : denyReasons).push(...decision.reasons)
      if (Array.isArray(decision.obligations)) obligations.push(...decision.obligations)
      if (!decision.allow) allow = false
      // deny 优先：已有模块拒绝仍继续跑完其余模块（reasons 全量聚合，审计可见完整裁决链），
      // 但任何模块都不因后续模块的结论改变自身裁决——聚合只做与运算。
    }
    // reasons 聚合（deny 优先排序）：整体拒绝时 deny 理由在前（首个 deny 模块的理由即主因，
    // 消费方直接以 reasons[0] 作为领域拒绝文案，既有拒绝语义零漂移），放行模块的理由跟后在案。
    const reasons = allow ? allowReasons : [...denyReasons, ...allowReasons]
    return { allow, reasons, decisionId: newId('pd'), obligations }
  }
}

/**
 * 既有裁决出口 → 统一决策表达（契约 §11：NAS / Connector 不重写引擎，
 * 决策出口经本函数包装获得 decisionId + reasons，随既有审计 detail 落账）。
 */
export function wrapPolicyDecision(allow: boolean, reasons: string[]): PolicyDecision {
  return { allow, reasons: [...reasons], decisionId: newId('pd'), obligations: [] }
}
