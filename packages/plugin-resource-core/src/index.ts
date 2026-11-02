/**
 * @dsh-ops/plugin-resource-core —— 资源本体通用底座。
 *
 * Agent 与 AI 应用模块的属性模型、权限、生命周期逻辑高度一致（方案 §八），
 * 本插件把它们抽象为「资源本体」引擎：
 *   - 属性表引擎：声明式 schema（分组 + 字段），创建/更新时统一校验，
 *     同一份 schema 驱动控制台表单与 dshctl/工具参数。
 *   - 生命周期状态机：draft → trial → online → offline → archived，
 *     迁移带 guard、审批标记、历史留痕，并发布平台事件。
 *   - 依赖图：应用 → Agent → MCP/Skill 的依赖拓扑与影响面分析。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId, slugify, type Collection, type RecordBase } from '../../platform-core/src/index.ts'
import { t } from '../../platform-i18n/src/index.ts'

// ---------------------------------------------------------------------------
// 属性表 schema DSL
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'text' | 'number' | 'boolean' | 'enum' | 'tags' | 'url' | 'model'

export interface FieldSpec {
  key: string
  label: string
  type: FieldType
  group: string
  required?: boolean
  options?: Array<{ value: string; label: string; hint?: string }>
  hint?: string
  placeholder?: string
  defaultValue?: unknown
  /** 创建后不可修改（如 slug）。 */
  immutable?: boolean
  /** 上线（online）前必须补全。 */
  requiredForOnline?: boolean
}

export interface AttributeSchema {
  groups: Array<{ key: string; label: string; description?: string }>
  fields: FieldSpec[]
}

// ---------------------------------------------------------------------------
// 生命周期状态机
// ---------------------------------------------------------------------------

export interface LifecycleState {
  key: string
  label: string
  /** 状态徽章色调：ok | info | warn | danger | muted */
  tone: 'ok' | 'info' | 'warn' | 'danger' | 'muted'
  terminal?: boolean
}

export interface LifecycleTransition {
  action: string
  label: string
  from: string[]
  to: string
  /** 迁移前守卫：返回文案则拒绝。 */
  guard?: (entity: ResourceEntity, ctx: Context) => string | undefined
  /** 高危迁移需走审批中心（L4）。 */
  approval?: boolean
  /** 迁移完成后发布的平台事件名（如 agent.offlined）。 */
  event?: string
}

export interface LifecycleSpec {
  initial: string
  states: LifecycleState[]
  transitions: LifecycleTransition[]
}

// ---------------------------------------------------------------------------
// 资源类型声明
// ---------------------------------------------------------------------------

export interface ResourceTypeSpec {
  type: string
  label: string
  plugin: string
  idPrefix: string
  schema: AttributeSchema
  lifecycle: LifecycleSpec
}

export interface LifecycleHistoryEntry {
  at: string
  from: string
  to: string
  action: string
  actor: string
  note?: string
}

export interface ResourceEntity extends RecordBase {
  type: string
  slug: string
  name: string
  attrs: Record<string, unknown>
  status: string
  ownerId: string
  orgId: string
  lifecycleHistory: LifecycleHistoryEntry[]
}

export interface DependencyRecord extends RecordBase {
  fromType: string
  fromId: string
  toType: string
  toId: string
  kind: string
}

export interface TransitionResult {
  entity: ResourceEntity
  event?: string
}

// ---------------------------------------------------------------------------
// 数据要素域（IAW 交接 2-1..2-4：数据集登记 / 质量分 / 血缘 / 指标字典）
// ---------------------------------------------------------------------------

/** 数据分级（与 modelgw DataClass 同值域）：渠道分级路由（1-1）按此选路。 */
export type DatasetClassification = 'public' | 'internal' | 'secret'

/** 质量分四维（PRD §7.3）：完整性/准确性/时效性/一致性，等权均值=overall（v1 口径）。 */
export interface DatasetQualityScore {
  completeness: number
  accuracy: number
  timeliness: number
  consistency: number
  overall: number
  scoredAt: string
  note?: string
}

export interface DatasetRecord extends RecordBase {
  /** 数据集编号（业务唯一键，如 ds_qb01_market）。 */
  code: string
  name: string
  /** 来源系统（如 钉钉/ERP/NAS/手工台账）。 */
  sourceSystem: string
  classification: DatasetClassification
  /** 刷新频率描述（实时/每小时/每日/每周/手工）。 */
  refreshFrequency?: string
  ownerOrgId?: string
  /** 关联场景编号（ScenegraphScene.code）。 */
  sceneCodes: string[]
  quality?: DatasetQualityScore
  /** 质量分版本号（C-11）：每次登记自增；expectedVersion 条件更新据此判冲突。 */
  qualityRevision?: number
  note?: string
}

/**
 * 指标定义（2-4 指标字典）：同一指标码允许多条定义并存——口径冲突按「记录人/时间」
 * 全量留账（不覆盖不合并），仲裁动作把某条置 active、其余 superseded。
 */
export interface MetricDefinitionRecord extends RecordBase {
  code: string
  name: string
  unit?: string
  description?: string
  /** 口径明细（计算公式/来源表字段/统计窗口等，生产方契约）。 */
  payload?: Record<string, unknown>
  recordedBy: string
  recordedAt: string
  status: 'active' | 'superseded'
  /** 仲裁时被其取代的定义 id 链。 */
  supersedes?: string
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class ResourceCoreService extends Service {
  static readonly provide = 'resourceCore'

  private types = new Map<string, ResourceTypeSpec>()

  constructor(ctx: Context) {
    super(ctx, 'resourceCore')
  }

  /** 插件注册资源类型（幂等：重复注册覆盖，供开发期热载）。 */
  registerType(spec: ResourceTypeSpec): () => void {
    this.types.set(spec.type, spec)
    return () => this.types.delete(spec.type)
  }

  typeSpec(type: string): ResourceTypeSpec | undefined {
    return this.types.get(type)
  }

  typesSpecs(): ResourceTypeSpec[] {
    return [...this.types.values()]
  }

  collection(type: string): Collection<ResourceEntity> {
    const spec = this.requireSpec(type)
    return this.ctx.opsStorage.collection<ResourceEntity>(`entity:${spec.type}`)
  }

  private requireSpec(type: string): ResourceTypeSpec {
    const spec = this.types.get(type)
    if (!spec) throw new Error(t('未注册的资源类型：{type}', { type }))
    return spec
  }

  // -- 属性校验 -----------------------------------------------------------

  validateAttrs(type: string, attrs: Record<string, unknown>, mode: 'create' | 'update' | 'online'): string[] {
    const spec = this.requireSpec(type)
    const errors: string[] = []
    for (const field of spec.schema.fields) {
      const value = attrs[field.key]
      const present = value !== undefined && value !== null && value !== ''
      // update 校验的是合并后的完整 attrs，required 与 create 同等强制——否则 PATCH 空值可绕过
      // 创建期必填（外部 QA-20261014 QA-04：PATCH description:'' 曾返回 200 清空描述）
      if ((mode === 'create' || mode === 'update') && field.required && !present) {
        errors.push(t('缺少必填字段「{label}」({key})', { label: field.label, key: field.key }))
      }
      if (mode === 'online' && field.requiredForOnline && !present) {
        errors.push(t('上线前必须补全「{label}」({key})', { label: field.label, key: field.key }))
      }
      if (!present) continue
      switch (field.type) {
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(t('「{label}」必须是数字', { label: field.label }))
          break
        case 'boolean':
          if (typeof value !== 'boolean') errors.push(t('「{label}」必须是布尔值', { label: field.label }))
          break
        case 'enum':
          if (!field.options?.some((option) => option.value === value)) {
            errors.push(t('「{label}」的取值必须是：{values}', { label: field.label, values: field.options?.map((o) => o.value).join(' / ') }))
          }
          break
        case 'tags':
          if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            errors.push(t('「{label}」必须是字符串数组', { label: field.label }))
          }
          break
        case 'url':
          if (typeof value !== 'string' || !/^https?:\/\//.test(value)) errors.push(t('「{label}」必须是 http(s) 地址', { label: field.label }))
          break
        default:
          if (typeof value !== 'string') errors.push(t('「{label}」必须是字符串', { label: field.label }))
          else if (looksLikeCorruptedText(value)) {
            // 测试 DEF-06：注册端编码错误（如 GBK 字节流按 UTF-8 解码）产生的乱码不再入库上架
            errors.push(t('「{label}」含乱码字符（疑似编码错误），请以 UTF-8 编码重新提交', { label: field.label }))
          }
      }
    }
    return errors
  }

  // -- 实体 CRUD ----------------------------------------------------------

  create(type: string, input: {
    name: string
    slug?: string
    attrs?: Record<string, unknown>
    ownerId: string
    orgId: string
  }): ResourceEntity {
    const spec = this.requireSpec(type)
    if (!input.name || !String(input.name).trim()) throw new Error(t('{label}名称不能为空', { label: spec.label }))
    const attrs: Record<string, unknown> = {}
    for (const field of spec.schema.fields) {
      const provided = input.attrs?.[field.key]
      if (provided !== undefined) attrs[field.key] = provided
      else if (field.defaultValue !== undefined) attrs[field.key] = field.defaultValue
    }
    const errors = this.validateAttrs(type, attrs, 'create')
    if (errors.length > 0) throw new Error(t('属性校验失败：{errors}', { errors: errors.join('；') }))
    const slug = input.slug || slugify(input.name)
    const collection = this.collection(type)
    if (collection.findOne((entity) => entity.slug === slug)) {
      throw new Error(t('{label}标识 {slug} 已存在', { label: spec.label, slug }))
    }
    const now = new Date().toISOString()
    return collection.insert({
      id: newId(spec.idPrefix),
      type: spec.type,
      slug,
      name: input.name,
      attrs,
      status: spec.lifecycle.initial,
      ownerId: input.ownerId,
      orgId: input.orgId,
      lifecycleHistory: [{ at: now, from: '', to: spec.lifecycle.initial, action: 'create', actor: input.ownerId }],
    })
  }

  update(type: string, id: string, patch: { name?: string; attrs?: Record<string, unknown> }): ResourceEntity {
    const spec = this.requireSpec(type)
    const collection = this.collection(type)
    const entity = collection.get(id)
    if (!entity) throw new Error(t('{label}不存在：{id}', { label: spec.label, id }))
    const mergedAttrs = { ...entity.attrs }
    if (patch.attrs) {
      for (const field of spec.schema.fields) {
        if (patch.attrs[field.key] === undefined) continue
        if (field.immutable && entity.attrs[field.key] !== patch.attrs[field.key]) {
          throw new Error(t('字段「{label}」创建后不可修改', { label: field.label }))
        }
        mergedAttrs[field.key] = patch.attrs[field.key]
      }
    }
    const errors = this.validateAttrs(type, mergedAttrs, 'update')
    if (errors.length > 0) throw new Error(t('属性校验失败：{errors}', { errors: errors.join('；') }))
    return collection.update(id, {
      attrs: mergedAttrs,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    })
  }

  get(type: string, id: string): ResourceEntity | undefined {
    return this.collection(type).get(id)
  }

  bySlug(type: string, slug: string): ResourceEntity | undefined {
    return this.collection(type).findOne((entity) => entity.slug === slug)
  }

  list(type: string, filter?: { status?: string; orgId?: string; q?: string }): ResourceEntity[] {
    const q = filter?.q?.toLowerCase()
    return this.collection(type).find((entity) => {
      if (filter?.status && entity.status !== filter.status) return false
      if (filter?.orgId && entity.orgId !== filter.orgId) return false
      if (q) {
        const haystack = `${entity.name} ${entity.slug} ${JSON.stringify(entity.attrs)}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }

  /**
   * 删除资源：默认仅终态可删；调用方可经 allowStates 放宽（如 NAS 允许草稿直删——
   * 草稿从未上线，无法经 下线→归档 到达终态）。
   */
  remove(type: string, id: string, opts?: { allowStates?: string[] }): boolean {
    const spec = this.requireSpec(type)
    const entity = this.collection(type).get(id)
    if (!entity) return false
    const allowed = opts?.allowStates ?? spec.lifecycle.states.filter((state) => state.terminal).map((state) => state.key)
    if (!allowed.includes(entity.status)) {
      throw new Error(t('当前状态 {status} 不可删除（可删状态：{allowed}）', { status: entity.status, allowed: allowed.join(' / ') }))
    }
    return this.collection(type).remove(id)
  }

  // -- 生命周期 -----------------------------------------------------------

  stateLabel(type: string, status: string): { label: string; tone: string } {
    const spec = this.requireSpec(type)
    const state = spec.lifecycle.states.find((item) => item.key === status)
    return { label: state?.label ?? status, tone: state?.tone ?? 'muted' }
  }

  availableTransitions(type: string, id: string): Array<{ action: string; label: string; to: string; approval?: boolean }> {
    const spec = this.requireSpec(type)
    const entity = this.collection(type).get(id)
    if (!entity) return []
    return spec.lifecycle.transitions
      .filter((transition) => transition.from.includes(entity.status))
      .map(({ action, label, to, approval }) => ({ action, label, to, approval }))
  }

  /** 执行状态迁移：guard → 状态更新 → 历史留痕 → 平台事件。 */
  transition(type: string, id: string, action: string, actor: string, note?: string): TransitionResult {
    const spec = this.requireSpec(type)
    const collection = this.collection(type)
    const entity = collection.get(id)
    if (!entity) throw new Error(t('{label}不存在：{id}', { label: spec.label, id }))
    const transition = spec.lifecycle.transitions.find((item) => item.action === action)
    if (!transition) throw new Error(t('未知操作：{action}', { action }))
    if (!transition.from.includes(entity.status)) {
      const fromState = this.stateLabel(type, entity.status).label
      throw new Error(t('当前状态「{from}」不允许执行「{action}」', { from: fromState, action: transition.label }))
    }
    if (transition.to === 'online') {
      const errors = this.validateAttrs(type, entity.attrs, 'online')
      if (errors.length > 0) throw new Error(errors.join('；'))
    }
    if (transition.guard) {
      const reason = transition.guard(entity, this.ctx)
      if (reason) throw new Error(reason)
    }
    const entry: LifecycleHistoryEntry = {
      at: new Date().toISOString(),
      from: entity.status,
      to: transition.to,
      action,
      actor,
      ...(note !== undefined ? { note } : {}),
    }
    const updated = collection.update(id, {
      status: transition.to,
      lifecycleHistory: [...entity.lifecycleHistory, entry],
    })
    const event = transition.event
    if (event) {
      this.ctx.platformBus.emit(event, { type, id, slug: updated.slug, name: updated.name, from: entry.from, to: entry.to, actor })
    }
    return { entity: updated, event }
  }

  // -- 依赖图 -------------------------------------------------------------

  dependencies(): Collection<DependencyRecord> {
    return this.ctx.opsStorage.collection<DependencyRecord>('resource:dependencies')
  }

  addDependency(input: { fromType: string; fromId: string; toType: string; toId: string; kind: string }): DependencyRecord {
    const existing = this.dependencies().findOne((record) =>
      record.fromType === input.fromType && record.fromId === input.fromId
      && record.toType === input.toType && record.toId === input.toId)
    if (existing) return existing
    return this.dependencies().insert({
      id: newId('dep'),
      fromType: input.fromType,
      fromId: input.fromId,
      toType: input.toType,
      toId: input.toId,
      kind: input.kind,
    })
  }

  removeDependency(input: { fromType: string; fromId: string; toType: string; toId: string }): void {
    const record = this.dependencies().findOne((item) =>
      item.fromType === input.fromType && item.fromId === input.fromId
      && item.toType === input.toType && item.toId === input.toId)
    if (record) this.dependencies().remove(record.id)
  }

  /** 拓扑：从某资源向下展开依赖树（应用 → Agent → MCP/Skill）。未注册类型按叶节点呈现。 */
  topology(type: string, id: string, depth = 4): TopologyNode {
    const spec = this.types.get(type)
    const entity = spec ? this.collection(type).get(id) : undefined
    const node: TopologyNode = {
      type,
      id,
      name: entity?.name ?? id,
      status: entity?.status ?? 'unknown',
      statusLabel: entity && spec ? this.stateLabel(type, entity.status).label : t('外部节点'),
      children: [],
    }
    if (depth <= 0) return node
    for (const record of this.dependencies().find((item) => item.fromType === type && item.fromId === id)) {
      node.children.push(this.topology(record.toType, record.toId, depth - 1))
    }
    return node
  }

  /** 影响面：谁直接/间接依赖了该资源（下线前预览）。未注册类型仅登记 id。 */
  impact(type: string, id: string): Array<{ type: string; id: string; name: string; status: string; depth: number }> {
    const result: Array<{ type: string; id: string; name: string; status: string; depth: number }> = []
    const visit = (t: string, i: string, depth: number): void => {
      if (depth > 4) return
      for (const record of this.dependencies().find((item) => item.toType === t && item.toId === i)) {
        const spec = this.types.get(record.fromType)
        const entity = spec ? this.collection(record.fromType).get(record.fromId) : undefined
        if (result.some((item) => item.id === record.fromId)) continue
        result.push({ type: record.fromType, id: record.fromId, name: entity?.name ?? record.fromId, status: entity?.status ?? 'unknown', depth })
        visit(record.fromType, record.fromId, depth + 1)
      }
    }
    visit(type, id, 1)
    return result.sort((a, b) => a.depth - b.depth)
  }

  // -- 数据要素域（IAW 交接 2-1..2-4） ---------------------------------------

  datasets(): Collection<DatasetRecord> {
    const collection = this.ctx.opsStorage.collection<DatasetRecord>('resource:datasets')
    collection.uniqueOn('dataset_code', (item) => item.code)
    return collection
  }

  /** 数据集登记（upsert by code）：来源系统/分级/刷新频率/关联场景（2-1）。 */
  upsertDataset(input: {
    code: string
    name: string
    sourceSystem: string
    classification: DatasetClassification
    refreshFrequency?: string
    ownerOrgId?: string
    sceneCodes?: string[]
    note?: string
  }): DatasetRecord {
    if (!input.code?.trim() || !/^[A-Za-z0-9._-]{2,64}$/.test(input.code)) {
      throw new Error(t('数据集 code 非法（字母/数字/._-，2-64 位）：{code}', { code: String(input.code) }))
    }
    if (!input.name?.trim()) throw new Error(t('数据集名称必填'))
    if (!input.sourceSystem?.trim()) throw new Error(t('来源系统必填（sourceSystem）'))
    if (!['public', 'internal', 'secret'].includes(input.classification)) {
      throw new Error(t('数据分级非法：{value}（public/internal/secret）', { value: String(input.classification) }))
    }
    const sceneCodes = [...new Set((input.sceneCodes ?? []).map((code) => code.trim()).filter(Boolean))]
    const existing = this.datasets().findOne((item) => item.code === input.code)
    if (existing) {
      const updated = this.datasets().update(existing.id, {
        name: input.name.trim(),
        sourceSystem: input.sourceSystem.trim(),
        classification: input.classification,
        ...(input.refreshFrequency !== undefined ? { refreshFrequency: input.refreshFrequency } : {}),
        ...(input.ownerOrgId !== undefined ? { ownerOrgId: input.ownerOrgId } : {}),
        sceneCodes,
        ...(input.note !== undefined ? { note: input.note } : {}),
      })
      this.ctx.platformBus.emit('resource.dataset.changed', { code: updated.code, action: 'updated', sceneCodes })
      return updated
    }
    const created = this.datasets().insert({
      id: newId('ds'),
      code: input.code.trim(),
      name: input.name.trim(),
      sourceSystem: input.sourceSystem.trim(),
      classification: input.classification,
      ...(input.refreshFrequency ? { refreshFrequency: input.refreshFrequency } : {}),
      ...(input.ownerOrgId ? { ownerOrgId: input.ownerOrgId } : {}),
      sceneCodes,
      ...(input.note ? { note: input.note } : {}),
    })
    this.ctx.platformBus.emit('resource.dataset.changed', { code: created.code, action: 'created', sceneCodes })
    return created
  }

  /** 数据集列表（2-1 面板最小接口口径）：按场景/分级/组织/关键词过滤。 */
  listDatasets(filter: { sceneCode?: string; classification?: string; orgId?: string; q?: string } = {}): Array<DatasetRecord & { sceneCount: number }> {
    const q = filter.q?.toLowerCase()
    return this.datasets().all()
      .filter((item) => {
        if (filter.sceneCode && !item.sceneCodes.includes(filter.sceneCode)) return false
        if (filter.classification && item.classification !== filter.classification) return false
        if (filter.orgId && item.ownerOrgId !== filter.orgId) return false
        if (q && !`${item.name} ${item.code} ${item.sourceSystem}`.toLowerCase().includes(q)) return false
        return true
      })
      .map((item) => ({ ...item, sceneCount: item.sceneCodes.length }))
      .sort((a, b) => a.code.localeCompare(b.code))
  }

  /**
   * 质量分登记（2-2）：四维 0-100，overall 等权均值；登记快照不回写历史引用。
   * 并发语义（C-11）：score.expectedVersion 缺省=最后写入（存量调用方不受影响）；
   * 携带时与当前 qualityRevision 比对，不一致即拒绝（防并发登记互相覆盖）。
   */
  scoreDataset(code: string, score: {
    completeness: number
    accuracy: number
    timeliness: number
    consistency: number
    note?: string
    /** 乐观锁：携带时必须等于当前 qualityRevision，否则拒绝。 */
    expectedVersion?: number
  }): DatasetRecord {
    const dataset = this.datasets().findOne((item) => item.code === code)
    if (!dataset) throw new Error(t('数据集不存在：{code}（请先登记）', { code }))
    const dims = ['completeness', 'accuracy', 'timeliness', 'consistency'] as const
    for (const dim of dims) {
      const value = score[dim]
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(t('质量分 {dim} 应为 0-100，收到 {value}', { dim, value: String(value) }))
    }
    const currentRevision = dataset.qualityRevision ?? 0
    if (score.expectedVersion !== undefined && score.expectedVersion !== currentRevision) {
      throw new Error(t('质量分版本冲突：当前 revision={current}，请求基于 revision={expected}（已被并发登记更新，请读取最新分后重试）', { current: currentRevision, expected: score.expectedVersion }))
    }
    const overall = Math.round(((score.completeness + score.accuracy + score.timeliness + score.consistency) / 4) * 10) / 10
    const quality: DatasetQualityScore = {
      completeness: score.completeness, accuracy: score.accuracy,
      timeliness: score.timeliness, consistency: score.consistency,
      overall, scoredAt: new Date().toISOString(),
      ...(score.note ? { note: score.note } : {}),
    }
    const updated = this.datasets().update(dataset.id, { quality, qualityRevision: currentRevision + 1 })
    this.ctx.platformBus.emit('resource.dataset.changed', { code, action: 'quality_scored', overall, revision: currentRevision + 1 })
    return updated
  }

  /**
   * 数据血缘（2-3）：复用依赖图，边语义「派生集 --依赖--> 源集」（fromType/toType='dataset'，kind='lineage'）。
   * 反向追溯=谁派生自我（downstream）；顺向=我来自谁（upstream）。
   */
  lineage(code: string): {
    dataset: string
    upstream: Array<{ code: string; name: string; kind: string }>
    downstream: Array<{ code: string; name: string; kind: string }>
  } {
    const nameOf = (datasetCode: string): string => this.datasets().findOne((item) => item.code === datasetCode)?.name ?? datasetCode
    const collect = (edgeFrom: boolean): Array<{ code: string; name: string; kind: string }> => {
      const rows = edgeFrom
        ? this.dependencies().find((item) => item.fromType === 'dataset' && item.fromId === code)
        : this.dependencies().find((item) => item.toType === 'dataset' && item.toId === code)
      return rows.map((row) => ({ code: edgeFrom ? row.toId : row.fromId, name: nameOf(edgeFrom ? row.toId : row.fromId), kind: row.kind }))
    }
    return { dataset: code, upstream: collect(true), downstream: collect(false) }
  }

  /** 登记血缘边（派生集 derived 依赖源集 source）。成环拒绝（C-08）：沿既有 dataset 血缘边 DFS，source 已可达 derived 即环。 */
  addLineage(derived: string, source: string, kind = 'lineage'): DependencyRecord {
    if (derived === source) throw new Error(t('血缘边两端不能是同一数据集'))
    for (const code of [derived, source]) {
      if (!this.datasets().findOne((item) => item.code === code)) throw new Error(t('数据集未登记：{code}（请先登记再建血缘）', { code }))
    }
    if (this.lineageReaches(source, derived)) {
      throw new Error(t('血缘成环拒绝：{source} 经既有血缘已可达 {derived}，再登记 {derived}→{source} 将形成循环依赖', { source, derived }))
    }
    return this.addDependency({ fromType: 'dataset', fromId: derived, toType: 'dataset', toId: source, kind })
  }

  /** 沿 dataset 依赖边（from→to）向下 DFS：判断 from 是否可达 target（成环判定的可达性查询）。 */
  private lineageReaches(from: string, target: string): boolean {
    const seen = new Set<string>([from])
    const stack = [from]
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const edge of this.dependencies().find((item) => item.fromType === 'dataset' && item.fromId === current)) {
        if (edge.toId === target) return true
        if (!seen.has(edge.toId)) {
          seen.add(edge.toId)
          stack.push(edge.toId)
        }
      }
    }
    return false
  }

  metricDefinitions(): Collection<MetricDefinitionRecord> {
    return this.ctx.opsStorage.collection<MetricDefinitionRecord>('resource:metricDefinitions')
  }

  /**
   * 指标口径登记（2-4）：同码不覆盖不合并——内容相同的重复登记幂等返回既有条目；
   * 内容不同即新定义并存（口径冲突按记录人/时间全量留账），仲裁决定 active。
   * 指纹键序归一（C-09）：payload 递归排序键后序列化，同内容不同键序不再误判为口径冲突。
   */
  putMetricDefinition(input: {
    code: string
    name: string
    unit?: string
    description?: string
    payload?: Record<string, unknown>
    recordedBy: string
  }): { definition: MetricDefinitionRecord; conflict: boolean } {
    if (!input.code?.trim()) throw new Error(t('指标码 code 必填（如 gm_revenue）'))
    if (!input.name?.trim()) throw new Error(t('指标名称必填'))
    if (!input.recordedBy?.trim()) throw new Error(t('记录人 recordedBy 必填（口径问责）'))
    const fingerprint = stableStringify([input.name, input.unit ?? '', input.description ?? '', input.payload ?? {}])
    const existing = this.metricDefinitions().all().filter((item) => item.code === input.code)
    const same = existing.find((item) => stableStringify([item.name, item.unit ?? '', item.description ?? '', item.payload ?? {}]) === fingerprint)
    if (same) return { definition: same, conflict: false }
    const activeCount = existing.filter((item) => item.status === 'active').length
    const definition = this.metricDefinitions().insert({
      id: newId('mdef'),
      code: input.code.trim(),
      name: input.name.trim(),
      ...(input.unit ? { unit: input.unit } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      recordedBy: input.recordedBy.trim(),
      recordedAt: new Date().toISOString(),
      // 首条定义默认 active；已有 active 的新口径并存为 superseded（待仲裁）
      status: existing.length === 0 ? 'active' : 'superseded',
    })
    this.ctx.platformBus.emit('resource.metric.changed', { code: definition.code, definitionId: definition.id, action: 'recorded', activeCount })
    return { definition, conflict: existing.filter((item) => item.status === 'active').length > 0 }
  }

  metricDefinitionsOf(code: string): Array<MetricDefinitionRecord & { conflictCount: number }> {
    const all = this.metricDefinitions().all().filter((item) => item.code === code)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    return all.map((item) => ({ ...item, conflictCount: all.length }))
  }

  /** 口径仲裁（2-4）：指定某条定义为 active，其余同码定义置 superseded。 */
  arbitrateMetric(code: string, definitionId: string, actor: string): { active: MetricDefinitionRecord; superseded: number } {
    const all = this.metricDefinitions().all().filter((item) => item.code === code)
    const target = all.find((item) => item.id === definitionId)
    if (!target) throw new Error(t('指标定义不存在：{id}（code={code}）', { id: definitionId, code }))
    let superseded = 0
    for (const item of all) {
      if (item.id === definitionId) continue
      // C-09：非目标的同码定义统一把 supersedes 指向本次赢家（含此前已 superseded 的陈旧指针）
      if (item.status !== 'superseded' || item.supersedes !== definitionId) {
        this.metricDefinitions().update(item.id, { status: 'superseded', supersedes: definitionId })
        if (item.status === 'active') superseded++
      }
    }
    this.metricDefinitions().update(definitionId, { status: 'active', supersedes: undefined })
    this.ctx.platformBus.emit('resource.metric.changed', { code, definitionId, action: 'arbitrated', actor, superseded })
    return { active: this.metricDefinitions().get(definitionId)!, superseded }
  }
}

export interface TopologyNode {
  type: string
  id: string
  name: string
  status: string
  statusLabel: string
  children: TopologyNode[]
}

/**
 * 键序归一化序列化（C-09）：对象键递归排序后再序列化——同一口径 payload 因键插入顺序不同
 * 不再被判为口径冲突（伪冲突）。数组保持原序（元素顺序通常有语义），仅对象键无序。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * 文本乱码检测（测试 DEF-06）：识别注册端编码错误入库的文本。
 * 判定依据（命中任一即视为乱码）：
 *   1. U+FFFD 替换符——字节流非合法 UTF-8 被解码时产生；
 *   2. 控制字符（除 \t \n \r）或私用区/非字符码位——正常业务文案不会出现；
 *   3. 经典乱码标记串（锟斤拷/烫烫烫/连续 ?? 占位）。
 */
export function looksLikeCorruptedText(value: string): boolean {
  if (!value) return false
  for (const ch of value) {
    const code = ch.codePointAt(0)!
    if (code === 0xfffd) return true
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true
    if (code >= 0xe000 && code <= 0xf8ff) return true
    if (code >= 0xfff0 && code <= 0xffff) return true
  }
  return /锟斤拷|烫烫烫|\?{6,}/.test(value)
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    resourceCore: ResourceCoreService
  }
}

export const name = 'resource-core'
export const inject = ['opsStorage', 'platformBus']

export function apply(ctx: Context) {
  ctx.plugin(ResourceCoreService)
}
