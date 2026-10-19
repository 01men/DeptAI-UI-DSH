/**
 * 制造工具箱 —— Skill 放行门禁与执行期质量检查（自「制造业 AI 工具集」server/quality.ts 并入）。
 *
 * 源项目铁律（docs/skill-quality.md，并入后语义不变）：
 *   1. 配了模型 ≠ 开放 AI 工具。必须真实模型评估 → 领域人员审阅 → 版本放行，三步齐全才可普通调用；
 *   2. 自动结构/引文检查不等于专业结论正确，报告里如实写明；
 *   3. 质量检查不合格一律按错误交付（502），绝不降级成「看起来成功」的结果。
 *
 * 并入改编点（平台化，登记于 docs/plan-mfg-toolkit-fusion-20261019.md）：
 *   - 放行记录从源项目 `.local/quality/releases.json` 文件改为面板存储集合（ReleaseStore 接口，
 *     由 index.ts 用 opsStorage 实现；测试用内存实现）——平台形态下无「本机 .local」概念；
 *   - 源项目的「协议维度」（openai/anthropic 各一套放行）收敛为平台模型标识维度：模型选择、
 *     密钥与出站现在由平台模型网关（modelgw / dsh llm 桥）拥有，面板不再持协议配置；
 *   - 评估执行的调用面从源项目自带 env 客户端改为平台模型网关（见 evaluate.ts），
 *     面板不持有任何密钥（源项目「密钥只在服务端」的边界在平台形态下进一步收紧为「密钥只在平台」）。
 */
import { createHash } from 'node:crypto'
import { skills } from './skills.ts'
import { checkModelOutputSchema, fail, type ModelOutput } from './validate.ts'

/** Skill 内容指纹：内核改动即指纹变化 → 既有放行立即失效。 */
export const skillHash = (id: string): string =>
  createHash('sha256').update(JSON.stringify(skills[id] ?? null)).digest('hex')

/** 模型标识指纹：模型名或服务地址变化即指纹变化 → 既有放行立即失效。 */
export const modelIdentityHash = (identity: { model: string; endpoint?: string }): string =>
  createHash('sha256').update(JSON.stringify({ model: identity.model, endpoint: identity.endpoint ?? '' })).digest('hex')

/** 放行记录：报告指纹 + Skill 指纹 + 模型指纹 + 审核人 + 期限（任一不符即失效）。 */
export type SkillRelease = {
  skillId: string
  skillHash: string
  modelHash: string
  reportHash: string
  approvedBy: string
  reviewKind: 'domain' | 'technical'
  approvedAt: string
  expiresAt: string
}

/** 真实模型评估报告：live=false 的 mock 报告永远不足以放行。 */
export type EvalReport = {
  skillId: string
  skillHash: string
  modelHash: string
  model: string
  protocol: string
  status: 'passed' | 'failed'
  live: boolean
  repetitions: number
  cases: Array<{ id: string; passed: boolean; missing: string[]; forbidden: string[]; durationMs: number }>
  startedAt: string
  finishedAt: string
}

/** 放行记录存储面（index.ts 以 opsStorage 集合实现；测试用内存实现）。 */
export interface ReleaseStore {
  get(skillId: string): SkillRelease | undefined
  put(release: SkillRelease): void
  remove(skillId: string): void
  list(): SkillRelease[]
}

/** 内存实现（单测与无存储形态）。 */
export class MemoryReleaseStore implements ReleaseStore {
  private map = new Map<string, SkillRelease>()
  get(skillId: string): SkillRelease | undefined { return this.map.get(skillId) }
  put(release: SkillRelease): void { this.map.set(release.skillId, release) }
  remove(skillId: string): void { this.map.delete(skillId) }
  list(): SkillRelease[] { return [...this.map.values()] }
}

/** 默认放行期（源项目同为 30 天）。 */
export const RELEASE_TTL_DAYS = 30

/**
 * 放行判定（fail-closed）：报告指纹、真实调用标记、通过状态、Skill 指纹、模型指纹、审核人、
 * 期限——任一不满足即未放行。这是「配了模型也不自动开放」的运行时强制点。
 */
export function releaseReady(
  store: ReleaseStore,
  skillId: string,
  identity: { model: string; endpoint?: string },
  now = Date.now(),
): { ready: boolean; reason?: string } {
  const release = store.get(skillId)
  if (!release) return { ready: false, reason: '尚无放行记录：需先完成真实模型评估与领域审阅' }
  if (release.skillHash !== skillHash(skillId)) return { ready: false, reason: 'Skill 内核已变更，原放行记录失效，需重新评估' }
  if (release.modelHash !== modelIdentityHash(identity)) return { ready: false, reason: '模型配置已变更，原放行记录失效，需重新评估' }
  if (!release.approvedBy?.trim()) return { ready: false, reason: '放行记录缺少审核人' }
  const expires = Date.parse(release.expiresAt)
  if (!Number.isFinite(expires) || expires <= now) return { ready: false, reason: '放行记录已到期，需重新评估与审阅' }
  return { ready: true }
}

/**
 * 由评估报告 + 审核人签署生成放行记录。
 * 拒绝面（与源项目 approve-skill 等价）：报告未通过、非真实调用、指纹不符、重复次数不足、审核人为空。
 */
export function buildRelease(
  report: EvalReport,
  reportText: string,
  reviewer: string,
  reviewKind: 'domain' | 'technical',
  now = Date.now(),
): SkillRelease {
  if (!reviewer?.trim() || reviewer.startsWith('--')) fail('REVIEW_REQUIRED', '审核人不能为空', 400)
  if (report.status !== 'passed') fail('REPORT_NOT_PASSED', '评估报告未通过，拒绝放行', 400)
  if (report.live !== true) fail('REPORT_NOT_LIVE', '报告非真实模型调用产生（mock 或未执行），拒绝放行', 400)
  if (report.repetitions < 3) fail('REPORT_INSUFFICIENT', '评估重复次数不足（每用例至少 3 次），拒绝放行', 400)
  if (report.skillHash !== skillHash(report.skillId)) fail('REPORT_STALE', '报告中的 Skill 指纹与当前内核不符，拒绝放行', 400)
  const reportHash = createHash('sha256').update(reportText).digest('hex')
  return {
    skillId: report.skillId,
    skillHash: report.skillHash,
    modelHash: report.modelHash,
    reportHash,
    approvedBy: reviewer.trim(),
    reviewKind,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RELEASE_TTL_DAYS * 86400000).toISOString(),
  }
}

/** 输出门禁提示词（与源项目逐字一致：固定章节 + 逐字证据 + 待确认项 + 禁 HTML）。 */
export function qualityInstructions(skillId: string): string {
  const skill = skills[skillId]
  if (!skill) fail('SKILL_NOT_FOUND', `未找到工具对应的 Skill：${skillId}`, 404)
  return `你必须只输出一个 JSON 对象，不输出 Markdown 代码围栏。格式：{"sections":[{"title":"章节名","content":"纯文本内容","evidence":["输入中的逐字证据片段"]}],"missingInformation":["需要补充或确认的信息"]}。\nsections 必须依次包含且仅包含这些章节：${skill.sections.join('、')}。evidence 必须逐字摘自用户输入；假设或建议可以为空数组，不能虚构引文；整份结果至少一处输入证据。信息不足时明确写待确认，并填入 missingInformation。禁止 HTML。`
}

/**
 * 执行期输出检查（源项目 checkModelOutput 等价）：结构 → 章节齐全与顺序 → 引文可在输入中定位
 * → 禁止 HTML。任何一项不合格抛 502，结果不交付。
 */
export function checkModelOutput(skillId: string, raw: unknown, source: string): ModelOutput {
  const parsed = checkModelOutputSchema(raw)
  const skill = skills[skillId]
  if (!skill) fail('SKILL_NOT_FOUND', `未找到工具对应的 Skill：${skillId}`, 404)
  if (parsed.sections.map((section) => section.title).join('\n') !== skill.sections.join('\n')) {
    fail('QUALITY_SECTIONS', '模型输出缺少必需章节或顺序不正确，本次结果未交付。', 502)
  }
  const evidence = parsed.sections.flatMap((section) => section.evidence)
  if (evidence.length === 0 || evidence.some((quote) => !source.includes(quote))) {
    fail('QUALITY_EVIDENCE', '模型引用无法在输入中定位，本次结果未交付。', 502)
  }
  if (parsed.sections.some((section) => /<\/?[a-z][^>]*>/i.test(section.content))) {
    fail('QUALITY_CONTENT', '模型输出包含不允许的 HTML，本次结果未交付。', 502)
  }
  return parsed
}