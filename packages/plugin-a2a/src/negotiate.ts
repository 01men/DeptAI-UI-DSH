/**
 * A0-A3 自治级别协商策略引擎（协作方案 §6.4，补 contract-c3 缺席项 3/4）。
 *
 * 纯函数、无副作用——输入「调用方级别 × 被调方级别」，输出交互模式。
 * 矩阵逐格对齐协作方案 §6.4 的协商矩阵表：
 *
 *   被调方＼调用方   A0 提示      A1 执行          A2 自主          A3 协商
 *   A0              单轮问答      拒绝             拒绝             拒绝
 *   A1              单轮问答      执行，人在环确认   执行+人在环       拒绝
 *   A2              单轮问答      执行，事后报告     执行，事后报告     降级为 A2 处理
 *   A3              单轮问答      执行             执行             双向 Task 协商
 *
 * 诚实边界（协作方案 §14.6）：协商引擎只保证协议行为真实（要约/还价/超限拒绝/审计），
 * 不承诺两个模型「谈得拢」——业务共识质量依赖提示词与人在环兜底，这是能力边界而非缺陷。
 */

export type Autonomy = 'A0' | 'A1' | 'A2' | 'A3'

export type NegotiationMode =
  | 'single_turn'      // 单轮问答（平台代答，v1 语义）
  | 'rejected'         // 矩阵拒绝（A0 不可被驱动执行等）
  | 'execute_confirm'  // 执行 + 人在环确认（走审批中心工单后执行）
  | 'execute_report'   // 执行 + 事后报告（直接派发 UHP）
  | 'negotiate'        // A3×A3 双向 Task 协商（要约/还价，超限拒绝）

export function normalizeAutonomy(value: unknown): Autonomy {
  const text = String(value ?? '').trim().toUpperCase()
  return text === 'A1' || text === 'A2' || text === 'A3' ? (text as Autonomy) : 'A0'
}

export function negotiateMode(caller: Autonomy, target: Autonomy): NegotiationMode {
  if (target === 'A0') return caller === 'A0' ? 'single_turn' : 'rejected'
  if (target === 'A1') {
    if (caller === 'A0') return 'single_turn'
    if (caller === 'A3') return 'rejected'
    return 'execute_confirm'
  }
  if (target === 'A2') {
    if (caller === 'A0') return 'single_turn'
    return 'execute_report'
  }
  // target = A3
  if (caller === 'A0') return 'single_turn'
  if (caller === 'A3') return 'negotiate'
  return 'execute_report'
}

/** 协商轮次上限（默认 3，超限 rejected——协作方案 §6.4）。 */
export const NEGOTIATION_MAX_ROUNDS = 3

/** 目标模型给出的协商决议（宽松解析：模型输出中抽取首个 JSON 对象）。 */
export type NegotiationDecision =
  | { decision: 'accept'; note?: string }
  | { decision: 'counter'; proposal?: unknown; note?: string }

export function parseNegotiationDecision(raw: string): NegotiationDecision {
  const match = raw.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { decision?: string; proposal?: unknown; note?: string }
      if (parsed.decision === 'accept') return { decision: 'accept', ...(parsed.note ? { note: String(parsed.note) } : {}) }
      if (parsed.decision === 'counter') {
        return { decision: 'counter', ...(parsed.proposal !== undefined ? { proposal: parsed.proposal } : {}), ...(parsed.note ? { note: String(parsed.note) } : {}) }
      }
    } catch { /* 落入宽松兜底 */ }
  }
  // 解析失败：按还价处理（原文作为附注），轮次上限自然收敛，不让协商悬挂
  return { decision: 'counter', note: raw.slice(0, 2000) }
}
