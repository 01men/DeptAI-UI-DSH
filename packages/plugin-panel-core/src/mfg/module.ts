/**
 * 制造工具箱 —— 面板装配面（自「制造业 AI 工具集」并入的接线层，2026-10-19）。
 *
 * 职责：把 mfg 域（工具目录 / 执行引擎 / 选题清单 / 放行门禁）挂进 01门 面板：
 *   1. /api/panel/mfg/* REST（guarded + 权限点；自注册路由进 routeMatrix 共享断言网）；
 *   2. panel_mfg_* 工具族（共享 tools 键 → dsh 下即原生 ToolRuntime，可被模型调用）；
 *   3. 模型面适配：把引擎的 ModelRuntime 接到平台模型网关（modelgw 优先 / dsh llm 桥兜底）；
 *   4. 放行存储：以 opsStorage 集合持久化 Skill 放行记录（替代源项目本机 .local 文件）。
 *
 * 边界（登记 docs/plan-mfg-toolkit-fusion-20261019.md）：
 *   - 面板不持有任何模型密钥（密钥只在平台侧）；无网关时 AI 工具诚实 503，不冒充成功；
 *   - 放行门禁 fail-closed：未评估/未审阅/已过期的 Skill 一律不开放普通调用；
 *   - 评估面（evaluateSkills）不自动写放行记录——放行必须经人工审阅签署。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../../platform-core/src/index.ts'
import { resolvePanelModelGateway } from '../llm-bridge.ts'
import { execute, type ModelRuntime } from './engine.ts'
import { tools as mfgTools, categories as mfgCategories, findTool, toolSearchText } from './catalog.ts'
import { loadRoadmap, roadmapGroups, ROADMAP_STATUS_LABELS } from './roadmap.ts'
import { toMarkdown, exportFileName } from './export.ts'
import { MfgError } from './validate.ts'
import { buildRelease, releaseReady, MemoryReleaseStore, skillHash, type ReleaseStore, type EvalReport } from './quality.ts'
import { skills as mfgSkills } from './skills.ts'
import { evaluateSkills, evaluationPlan, fixtures } from './evaluate.ts'

/** 放行记录持久化形态（opsStorage 集合记录）。 */
type ReleaseRecord = {
  id: string
  createdAt: string
  updatedAt: string
  skillId: string
  skillHash: string
  modelHash: string
  reportHash: string
  approvedBy: string
  reviewKind: 'domain' | 'technical'
  approvedAt: string
  expiresAt: string
}

/** 评估报告持久化形态（供人工审阅；报告本身不构成放行）。 */
type ReportRecord = {
  id: string
  createdAt: string
  updatedAt: string
  report: EvalReport
  reportText: string
}

/**
 * 放行存储：opsStorage 集合实现（01门装态与全量形态共用；集合缺席时回落内存实现，
 * 保证「存储面不可用」不会把门禁变成 fail-open——内存实现同样只读已签署记录）。
 */
function createReleaseStore(ctx: Context): ReleaseStore {
  const soft = (key: string): any => { try { return ctx.reflect.get(key, false) } catch { return undefined } }
  const storage = soft('opsStorage')
  if (!storage || typeof storage.collection !== 'function') return new MemoryReleaseStore()
  const collection = storage.collection<ReleaseRecord>('panel:mfgReleases')
  return {
    get(skillId: string) {
      const record = collection.findOne((item: ReleaseRecord) => item.skillId === skillId)
      return record ? {
        skillId: record.skillId, skillHash: record.skillHash, modelHash: record.modelHash,
        reportHash: record.reportHash, approvedBy: record.approvedBy, reviewKind: record.reviewKind,
        approvedAt: record.approvedAt, expiresAt: record.expiresAt,
      } : undefined
    },
    put(release) {
      const existing = collection.findOne((item: ReleaseRecord) => item.skillId === release.skillId)
      if (existing) collection.update(existing.id, { ...release })
      else collection.insert({ id: `mrel_${release.skillId}`, ...release })
    },
    remove(skillId: string) {
      const existing = collection.findOne((item: ReleaseRecord) => item.skillId === skillId)
      if (existing) collection.remove(existing.id)
    },
    list() {
      return collection.all().map((record: ReleaseRecord) => ({
        skillId: record.skillId, skillHash: record.skillHash, modelHash: record.modelHash,
        reportHash: record.reportHash, approvedBy: record.approvedBy, reviewKind: record.reviewKind,
        approvedAt: record.approvedAt, expiresAt: record.expiresAt,
      }))
    },
  }
}

/**
 * 模型运行时适配：引擎的 ModelRuntime ← 平台模型网关。
 *
 * identity()：网关目录首个在线模型的 slug（引擎用它算放行指纹——模型变化即放行失效）。
 * invoke()：走 gateway.invoke 真实出站（modelgw 的计量/预算/降级链，或 dsh llm 桥）。
 * 网关缺席 → identity()=null，引擎抛 MODEL_NOT_CONFIGURED（诚实降级）。
 */
function createModelRuntime(ctx: Context, releases: ReleaseStore): ModelRuntime {
  const resolve = () => resolvePanelModelGateway(ctx)?.gateway as any
  return {
    releases,
    identity() {
      const gateway = resolve()
      if (!gateway) return null
      const models = gateway.models?.().all?.() ?? []
      const online = models.find((model: { status?: string }) => model.status === 'online') ?? models[0]
      if (!online?.slug) return null
      return { model: online.slug, endpoint: online.endpoint }
    },
    async invoke(input) {
      const gateway = resolve()
      if (!gateway) throw new MfgError('MODEL_NOT_CONFIGURED', '模型网关未接入（01门演示态）——连接宿主并登录后在平台侧配置模型', 503)
      const models = gateway.models?.().all?.() ?? []
      const online = models.find((model: { status?: string }) => model.status === 'online') ?? models[0]
      if (!online?.slug) throw new MfgError('MODEL_NOT_CONFIGURED', '平台模型目录为空——请在 dsh 侧配置默认模型或登记模型渠道', 503)
      const result = await gateway.invoke({
        model: online.slug,
        subject: 'panel:mfg-toolkit',
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        ...(input.signal ? { signal: input.signal } : {}),
      })
      return { content: String(result.content ?? ''), model: String(result.model ?? online.slug) }
    },
  }
}

export interface MfgDeps {
  /** guarded 路由包装（与 panel-core 同规：权限点 + 审计 + 演示态标记）。 */
  guarded: (method: string, path: string, permission: string, handler: (exchange: HttpExchange) => unknown | Promise<unknown>) => void
  /** 审计留痕（审计中心缺席时空操作）。 */
  changeLog: (exchange: HttpExchange, action: string, resourceType: string, resourceId: string, resourceName: string, detail?: string) => void
  /** 通用 JSON 渲染（工具输出面）。 */
  renderJson: (args: unknown, value: unknown) => any
}

/** 制造工具箱装配：目录/执行/清单/放行四组路由 + 工具族。 */
export function applyMfgModule(ctx: Context, deps: MfgDeps): void {
  const { guarded, changeLog, renderJson } = deps
  // 工具注册直调 ctx.tools.register({...})：契约 lint 以字面量 `tools.register({` 前缀提取
  // 工具名（scripts/contract-lint.mjs extractCodeSurface）——经中间函数转发会使 manifest
  // 双向比对误判 tool_ghost（2026-10-19 实证），故调用点保持字面量写法。
  const releases = createReleaseStore(ctx)
  const runtime = createModelRuntime(ctx, releases)

  // ---- 目录面 -------------------------------------------------------------------

  guarded('GET', '/api/panel/mfg/catalog', 'panel.read', () => {
    const identity = runtime.identity()
    const skills = Object.keys(mfgSkills).map((skillId) => {
      const tool = mfgTools.find((item) => item.skill === skillId)
      const verdict = identity ? releaseReady(releases, skillId, identity) : { ready: false, reason: '平台未配置可用模型' }
      return {
        skillId,
        skillVersion: mfgSkills[skillId]!.version,
        toolId: tool?.id ?? '',
        released: verdict.ready,
        reason: verdict.ready ? '' : verdict.reason,
        skillHash: skillHash(skillId),
      }
    })
    return {
      tools: mfgTools.map((tool) => ({ ...tool, released: tool.mode === 'calculation' ? true : Boolean(skills.find((item) => item.skillId === tool.skill)?.released) })),
      categories: [...mfgCategories],
      skills,
      modelReady: Boolean(identity),
      model: identity?.model ?? '',
      targetCount: 100,
      status: '100 个工具已选型，13 个计算内核已实现，3 个 AI 工具按模型独立验收，84 个规划中',
    }
  })

  guarded('GET', '/api/panel/mfg/roadmap', 'panel.read', () => {
    const roadmap = loadRoadmap()
    return {
      version: roadmap.version,
      sourceWorkbook: roadmap.sourceWorkbook,
      sourceRows: roadmap.sourceRows,
      sourceStatusCounts: roadmap.sourceStatusCounts,
      pdfSource: roadmap.pdfSource,
      pdfPages: roadmap.pdfPages,
      groups: roadmapGroups(roadmap),
      statusLabels: ROADMAP_STATUS_LABELS,
      tools: roadmap.tools,
    }
  })

  // ---- 执行面 -------------------------------------------------------------------

  guarded('POST', '/api/panel/mfg/tools/:id/run', 'panel.write', async (exchange) => {
    const id = String(exchange.params.id ?? '')
    try {
      const result = await execute(id, exchange.body ?? {})
      changeLog(exchange, 'mfg.tool.run', 'mfg-tool', id, findTool(id)?.title ?? id, `blocks=${result.blocks.length} mode=${result.mode}`)
      return result
    } catch (error) {
      if (error instanceof MfgError) exchange.fail(error.status, error.code, error.message)
      else exchange.fail(500, 'INTERNAL_ERROR', error instanceof Error ? error.message : '执行失败')
      return null
    }
  })

  guarded('GET', '/api/panel/mfg/tools/:id/template', 'panel.read', (exchange) => {
    const tool = findTool(String(exchange.params.id ?? ''))
    if (!tool) return { fields: [] }
    return { toolId: tool.id, fields: tool.fields.map((field) => ({ key: field.key, label: field.label, default: field.default, unit: field.unit ?? '' })) }
  })

  guarded('POST', '/api/panel/mfg/tools/:id/export', 'panel.read', (exchange) => {
    const body = (exchange.body ?? {}) as { result?: unknown; format?: string }
    const result = body.result as Parameters<typeof toMarkdown>[0] | undefined
    if (!result || typeof result !== 'object' || !Array.isArray((result as { blocks?: unknown }).blocks)) {
      exchange.fail(400, 'BAD_REQUEST', '缺少可导出的运行结果')
      return null
    }
    const format = body.format === 'md' ? 'md' : 'json'
    return format === 'md'
      ? { filename: exportFileName(result, 'md'), content: toMarkdown(result), mime: 'text/markdown' }
      : { filename: exportFileName(result, 'json'), content: JSON.stringify(result, null, 2), mime: 'application/json' }
  })

  // ---- 放行与评估面（写动词需 config 权限：放行是治理动作，不是普通使用） -----------------

  guarded('GET', '/api/panel/mfg/releases', 'panel.read', () => {
    const identity = runtime.identity()
    return {
      identity: identity ?? null,
      releases: releases.list().map((release) => ({
        ...release,
        valid: identity ? releaseReady(releases, release.skillId, identity).ready : false,
      })),
    }
  })

  guarded('GET', '/api/panel/mfg/evaluation-plan', 'panel.read', () => ({
    plan: evaluationPlan(3),
    fixtures: Object.fromEntries(Object.entries(fixtures).map(([skillId, suite]) => [skillId, suite.map((item) => ({ id: item.id, context: item.context }))])),
    note: '评估计划不发起模型调用。真实评估经 POST /api/panel/mfg/evaluate 执行并产生 live 报告；报告须经人工审阅后另行签署放行。',
  }))

  guarded('POST', '/api/panel/mfg/evaluate', 'panel.config.write', async (exchange) => {
    const body = (exchange.body ?? {}) as { skills?: string[]; repetitions?: number }
    if (!runtime.identity()) {
      exchange.fail(503, 'MODEL_NOT_CONFIGURED', '平台未配置可用模型，无法执行真实评估（mock 结果不构成验收）')
      return null
    }
    const reports = await evaluateSkills({
      runtime,
      ...(Array.isArray(body.skills) && body.skills.length ? { skillIds: body.skills } : {}),
      repetitions: Number.isInteger(body.repetitions) ? Math.min(5, Math.max(1, body.repetitions!)) : 3,
    })
    const storage = (() => { try { return ctx.reflect.get('opsStorage', false) } catch { return undefined } })()
    if (storage?.collection) {
      const collection = storage.collection<ReportRecord>('panel:mfgReports')
      for (const report of reports) {
        collection.insert({ id: `mrp_${report.skillId}_${Date.now()}`, report, reportText: JSON.stringify(report, null, 2) })
      }
    }
    changeLog(exchange, 'mfg.evaluate', 'mfg-skill', reports.map((item) => item.skillId).join(','), '制造工具箱 Skill 评估', `reports=${reports.length}`)
    return {
      reports: reports.map((report) => ({ skillId: report.skillId, status: report.status, live: report.live, model: report.model, repetitions: report.repetitions, cases: report.cases })),
      note: '评估报告不构成放行。请人工审阅通过后，经 POST /api/panel/mfg/releases 由审核人签署放行。',
    }
  })

  guarded('POST', '/api/panel/mfg/releases', 'panel.config.write', (exchange) => {
    const body = (exchange.body ?? {}) as { report?: EvalReport; reviewer?: string; reviewKind?: string }
    const report = body.report
    if (!report || typeof report !== 'object') {
      exchange.fail(400, 'BAD_REQUEST', '缺少评估报告')
      return null
    }
    const reviewKind = body.reviewKind === 'domain' ? 'domain' : 'technical'
    try {
      const release = buildRelease(report, JSON.stringify(report, null, 2), String(body.reviewer ?? ''), reviewKind)
      releases.put(release)
      changeLog(exchange, 'mfg.release', 'mfg-skill', release.skillId, `放行 ${release.skillId}`, `reviewer=${release.approvedBy} kind=${reviewKind} expires=${release.expiresAt}`)
      return { release }
    } catch (error) {
      if (error instanceof MfgError) exchange.fail(error.status, error.code, error.message)
      else exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : '放行失败')
      return null
    }
  })

  guarded('DELETE', '/api/panel/mfg/releases/:skillId', 'panel.config.write', (exchange) => {
    const skillId = String(exchange.params.skillId ?? '')
    releases.remove(skillId)
    changeLog(exchange, 'mfg.release.revoke', 'mfg-skill', skillId, `撤回放行 ${skillId}`)
    return { revoked: skillId }
  })

  // ---- panel_mfg_* 工具族（共享 tools 键；dsh 下即原生 ToolRuntime） -----------------

  ctx.tools.register({
    name: 'panel_mfg_tools_list',
    description: '列出制造工具箱的全部工具（13 个计算内核 + 3 个 AI 工具，共 100 项选题），含分类、执行方式与放行状态',
    permission: 'panel.read',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '可选检索词（标题/副标题/标签/分类）' } } },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args) {
      const query = String((args as { query?: string }).query ?? '').trim().toLowerCase()
      const identity = runtime.identity()
      const found = query ? mfgTools.filter((tool) => toolSearchText(tool).includes(query)) : mfgTools
      return found.map((tool) => {
        const skillId = tool.skill
        const released = tool.mode === 'calculation'
          ? true
          : Boolean(skillId && identity && releaseReady(releases, skillId, identity).ready)
        return { id: tool.id, title: tool.title, category: tool.category, mode: tool.mode, tags: tool.tags, released }
      })
    },
  })

  ctx.tools.register({
    name: 'panel_mfg_tool_run',
    description: '执行一个制造工具（13 个确定性计算内核；AI 工具需平台配置模型且该 Skill 已放行）。返回统一结构化结果（metrics/bars/table/text/scene）。',
    permission: 'panel.write',
    parameters: {
      type: 'object',
      properties: {
        tool_id: { type: 'string', description: '工具 id（如 oee / cpk / pareto / bom-diff / quote-compare）' },
        input: { type: 'object', description: '工具输入（字段见 panel_mfg_tools_list 对应的定义；未知字段会被拒绝）' },
      },
      required: ['tool_id'],
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args) {
      const input = args as { tool_id: string; input?: Record<string, unknown> }
      return execute(String(input.tool_id), input.input ?? {})
    },
  })

  ctx.tools.register({
    name: 'panel_mfg_roadmap',
    description: '查询 100 项制造 AI 工具选题清单（来源追溯：PMO 场景清单行号 + 行业 PDF 页码；状态：13 已实现计算内核 / 3 待模型验收 / 84 规划）',
    permission: 'panel.read',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '可选业务场景分组（如 生产制造 / 质量工程）' },
        status: { type: 'string', description: '可选状态筛选（implemented-calculation / model-validation-pending / planned）' },
      },
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args) {
      const input = args as { group?: string; status?: string }
      const roadmap = loadRoadmap()
      let items = roadmap.tools
      if (input.group) items = items.filter((item) => item.group === input.group)
      if (input.status) items = items.filter((item) => item.status === input.status)
      return {
        total: roadmap.tools.length,
        matched: items.length,
        groups: roadmapGroups(roadmap),
        statusLabels: ROADMAP_STATUS_LABELS,
        items: items.map((item) => ({
          id: item.id, title: item.title, group: item.group, priority: item.priority,
          status: item.status, statusLabel: ROADMAP_STATUS_LABELS[item.status] ?? item.status,
          implementation: item.implementation ?? '', acceptance: item.acceptance,
          sources: item.sources.map((source) => ({ row: source.row, department: source.department, scenario: source.originalScenario })),
        })),
      }
    },
  })
}