/**
 * Skill 市场域路由（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出——Skill 市场列表/详情/提交/两级审批/发布/编辑/
 * 资源包重传/弃用/删除/安装卸载/评分下载，以及 Skill 包存储配置（local/NAS 后端）。
 * 处理器逐字搬运（行为与迁出前一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../../platform-core/src/index.ts'
import type { SkillRecord } from '../../../plugin-skillhub/src/index.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'

export function registerSkillRoutes(ctx: Context, deps: ConsoleRouteDeps): void {
  const { guarded, body, changeLog, caller } = deps

  /**
   * Skill 可见性裁决（安全审查 P1-02，2026-10-31）：列表/详情/下载共用同一判定——
   * 平台超管与审批/发布权限持有者全量；作者本人全量；其余按 visibility 收敛：
   *   'all' → 公开；'orgs' → 仅 targetOrgs 内的调用者；'groups'（前端未提供编辑面，
   *   存量数据按 fail-closed 处理）与在途项（待审批/扫描中/驳回）→ 仅作者与管理面可见。
   * 返回 true=可见；对不可见 Skill 的详情/下载/安装按不存在处理（不泄露存在性）。
   */
  const skillVisibleTo = (skill: SkillRecord, exchange: HttpExchange): boolean => {
    const info = caller(exchange)
    const actorId = info.userId ?? info.principalId
    if (info.permissions.includes('*') || info.permissions.includes('skill.approve') || info.permissions.includes('skill.publish')) return true
    if (skill.authorId === actorId) return true
    if (skill.status !== 'published' && skill.status !== 'deprecated') return false
    if (skill.visibility === 'all') return true
    if (skill.visibility === 'orgs') {
      const orgId = info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined
      return Boolean(orgId && skill.targetOrgs.includes(orgId))
    }
    return false
  }

  /** 非管理面/作者视角剔除版本内嵌包体（packageBase64 可达数十 MB 且为受控分发物，P1-02）。 */
  const stripPackages = (skill: SkillRecord): SkillRecord => ({
    ...skill,
    versions: skill.versions.map(({ packageBase64, ...rest }) => {
      void packageBase64
      return { ...rest, hasPackage: true } as typeof rest & { hasPackage: boolean }
    }),
  })

  /** 视图出口：可见性裁决 + 按角色决定是否剔除包体（作者/审批/发布管理面保留完整记录）。 */
  const skillView = (skill: SkillRecord, exchange: HttpExchange): SkillRecord => {
    if (!skillVisibleTo(skill, exchange)) throw new Error(t('Skill 不存在：{id}', { id: skill.id }))
    const info = caller(exchange)
    const privileged = info.permissions.includes('*') || info.permissions.includes('skill.approve') || info.permissions.includes('skill.publish')
      || skill.authorId === (info.userId ?? info.principalId)
    return privileged ? skill : stripPackages(skill)
  }

  /**
   * 市场卡片热力（设计适配规格 5.3，2026-10-14）：每个 Skill 近 30 日每日调用次数 heat[30]。
   * 数据源=usage 真实聚合（callsTrend 只读方法，calls 口径=calls 米求和、无该米事件按 1 计）；
   * 计量管道接入前的下载流水不回填（与 /api/skills/usage-heatmap 的回填口径不同——
   * 台账口径只认计量事件，避免同一次使用在两处重复计）；无数据全 0 数组。
   */
  const heatBySkill = (): { axis: string[]; bySkill: Map<string, number[]> } => {
    const axis: string[] = []
    for (let i = 29; i >= 0; i--) axis.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const bySkill = new Map<string, number[]>()
    for (const row of ctx.usage.callsTrend(from, 'skill:')) {
      const skillId = row.resource.slice('skill:'.length)
      const dayIndex = axis.indexOf(row.day)
      if (dayIndex < 0) continue
      const cells = bySkill.get(skillId) ?? Array<number>(30).fill(0)
      cells[dayIndex]! += row.calls
      bySkill.set(skillId, cells)
    }
    return { axis, bySkill }
  }

  // -- Skill 市场 ---------------------------------------------------------
  guarded('GET', '/api/skills', 'skill.read', (exchange) => {
    // heat[30] 只在默认市场列表（无 mine/pending 收敛）时附带——两个子视图不渲染热力，省一次聚合
    const withHeat = exchange.query.get('mine') !== '1' && exchange.query.get('pending') !== '1'
    const heat = withHeat ? heatBySkill() : undefined
    const enrich = (skill: SkillRecord) => ({
      ...skill,
      ...(heat ? { heat: heat.bySkill.get(skill.id) ?? Array<number>(30).fill(0) } : {}),
    })
    if (exchange.query.get('mine') === '1') {
      const info = caller(exchange)
      return { skills: ctx.skillHub.skills().find((skill) => skill.authorId === (info.userId ?? info.principalId)).map(enrich) }
    }
    if (exchange.query.get('pending') === '1') {
      // P1-02：在途清单（待审批/扫描中/驳回）只对作者本人与审批/发布管理面开放——
      // 普通成员（skill.read）此前可见全部在途项及其完整内容
      const info = caller(exchange)
      const gatekeeper = info.permissions.includes('*') || info.permissions.includes('skill.approve') || info.permissions.includes('skill.publish')
      return { skills: ctx.skillHub.skills().find((skill) => ['pending_approval', 'scanning', 'rejected'].includes(skill.status))
        .filter((skill) => gatekeeper || skill.authorId === (info.userId ?? info.principalId)).map(enrich) }
    }
    // 市场列表含在途项（待审批/扫描中，排最前带状态徽标）：审批人无需切页即可看到待办；
    // P1-02：按调用者可见性裁决（visibility 收敛 + 在途项仅作者/管理面），并剔除版本包体
    const skills = ctx.skillHub.search({
      q: exchange.query.get('q') ?? undefined,
      category: exchange.query.get('category') ?? undefined,
      tag: exchange.query.get('tag') ?? undefined,
      sort: (exchange.query.get('sort') ?? 'downloads') as 'downloads' | 'rating' | 'updated',
      includePending: true,
    }).filter((skill) => skillVisibleTo(skill, exchange))
      .map((skill) => {
        const view = skillView(skill, exchange)
        return enrich(view)
      })
    return { skills, categories: ctx.skillHub.categories(), ...(heat ? { heatAxis: heat.axis } : {}) }
  })

  guarded('GET', '/api/skills/:id', 'skill.read', (exchange) => {
    // P1-02：详情按同一可见性裁决，不可见按不存在处理（不泄露存在性）；可见但非作者/
    // 管理面时剔除版本包体（内容分发走受控下载通道）
    return skillView(ctx.skillHub.detail(exchange.params['id']!), exchange)
  })

  guarded('POST', '/api/skills', 'skill.submit', (exchange) => {
    const input = body<{ name: string; category?: string; tags?: string[]; summary?: string; description?: string; content: string; version?: string; changelog?: string; visibility?: 'all' | 'orgs' | 'groups'; applicableModels?: string[]; deps?: string[]; packageBase64?: string }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const skill = ctx.skillHub.submit({
      ...input,
      authorId: info.userId ?? info.principalId,
      authorName: info.name,
      orgId: user?.orgId ?? 'org_unknown',
    })
    return { id: skill.id, status: skill.status, findings: skill.versions.at(-1)?.findings ?? [], hasPackage: Boolean(skill.versions.at(-1)?.packageBase64) }
  })

  guarded('POST', '/api/skills/:id/approve', 'skill.approve', (exchange) => {
    const input = body<{ version?: string; decision: 'approve' | 'reject'; level: 'domain' | 'security'; opinion: string }>(exchange)
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const version = input.version ?? skill.currentVersion
    const result = input.decision === 'approve'
      ? ctx.skillHub.approve(skill.id, version, input.level, { id: info.userId ?? info.principalId, name: info.name }, input.opinion)
      : ctx.skillHub.reject(skill.id, version, { id: info.userId ?? info.principalId, name: info.name }, input.opinion)
    changeLog(exchange, `skill.approve.${input.decision}`, 'skill', skill.id, skill.name, `${input.level}: ${input.opinion}`)
    return result
  })

  guarded('POST', '/api/skills/:id/publish', 'skill.publish', async (exchange) => {
    const { version } = body<{ version?: string }>(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const info = caller(exchange)
    // 真实账号标识（非显示名）：显示名（中文名）非账号，无法透传身份头，也会污染审计归属
    const result = await ctx.skillHub.publish(skill.id, version ?? skill.currentVersion, { id: info.userId ?? info.principalId, name: info.name })
    changeLog(exchange, 'skill.publish', 'skill', skill.id, skill.name)
    return result
  })

  /** 编辑已上架 Skill 的市场信息：仅作者本人或持 skill.publish 的管理员。 */
  guarded('PATCH', '/api/skills/:id', 'skill.submit', (exchange) => {
    const input = body<{ name?: string; category?: string; tags?: string[]; summary?: string; description?: string; visibility?: 'all' | 'orgs' | 'groups'; targetOrgs?: string[]; applicableModels?: string[]; deps?: string[]; cover?: string; authorName?: string }>(exchange)
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const asAdmin = info.permissions.includes('*') || info.permissions.includes('skill.publish')
    if (skill.authorId !== (info.userId ?? info.principalId) && !asAdmin) {
      exchange.fail(403, 'FORBIDDEN', t('仅 Skill 作者或平台管理员可编辑该 Skill 信息'))
      return
    }
    const result = ctx.skillHub.update(skill.id, input, { id: info.userId ?? info.principalId, name: info.name }, { asAdmin })
    changeLog(exchange, 'skill.update', 'skill', skill.id, result.name, t('编辑字段：{fields}', { fields: Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined).join('、') || t('无') }))
    return result
  })

  /** 重新手动上传当前已发布版本的 skill.zip 资源包（原地替换，版本号不变）。 */
  guarded('PUT', '/api/skills/:id/package', 'skill.submit', async (exchange) => {
    const { packageBase64 } = body<{ packageBase64?: string }>(exchange)
    if (!packageBase64) throw new Error(t('packageBase64 必填'))
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const asAdmin = info.permissions.includes('*') || info.permissions.includes('skill.publish')
    if (skill.authorId !== (info.userId ?? info.principalId) && !asAdmin) {
      exchange.fail(403, 'FORBIDDEN', t('仅 Skill 作者或平台管理员可更新该 Skill 资源包'))
      return
    }
    const result = await ctx.skillHub.replacePackage(skill.id, packageBase64, { id: info.userId ?? info.principalId, name: info.name }, { asAdmin })
    const pkg = result.versions.find((item) => item.version === result.currentVersion)?.package
    changeLog(exchange, 'skill.package.replace', 'skill', skill.id, skill.name, t('v{version} 资源包重传（{storage}{size}）', { version: result.currentVersion, storage: pkg?.storage === 'nas' ? 'NAS' : t('平台本地'), size: pkg?.sizeBytes !== undefined ? t(' · {bytes}B', { bytes: pkg.sizeBytes }) : '' }))
    return { skill: result, package: pkg }
  })

  guarded('POST', '/api/skills/:id/deprecate', 'skill.publish', (exchange) => {
    const { reason, force } = body<{ reason?: string; force?: boolean }>(exchange)
    if (!reason?.trim()) throw new Error(t('弃用必须填写原因（护栏要求，下架分析依赖该口径）'))
    const result = ctx.skillHub.deprecate(exchange.params['id']!, caller(exchange).name, reason, force)
    changeLog(exchange, 'skill.deprecate', 'skill', result.skill.id, result.skill.name, reason)
    return result
  })

  /** 删除 Skill：已弃用/强制下架/审批驳回可删；被未归档 Agent 引用时拒绝；审计数据保留。 */
  guarded('DELETE', '/api/skills/:id', 'skill.publish', (exchange) => {
    const id = exchange.params['id']!
    const skill = ctx.skillHub.skills().get(id)
    if (!skill) throw new Error(t('Skill 不存在：{id}', { id }))
    if (!['deprecated', 'offline', 'rejected'].includes(skill.status)) {
      throw new Error(t('当前状态 {status} 不可删除（仅已弃用/强制下架/审批驳回可删）', { status: skill.status }))
    }
    const referencing = ctx.resourceCore.dependencies().find((record) => record.kind === 'skill' && record.toId === id)
      .map((record) => ctx.resourceCore.get('agent', record.fromId))
      .filter((agent) => agent !== undefined && agent.status !== 'archived')
    if (referencing.length > 0) {
      throw new Error(t('该 Skill 仍被 {names} 引用，请先卸载或归档相关 Agent', { names: referencing.map((agent) => agent!.name).join('、') }))
    }
    ctx.skillHub.purge(id)
    changeLog(exchange, 'skill.delete', 'skill', id, skill.name)
    return { deleted: true }
  })

  guarded('POST', '/api/skills/:id/install', 'skill.install', (exchange) => {
    const { agentId, version } = body<{ agentId: string; version?: string }>(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    const result = ctx.skillHub.install(skill.id, version ?? skill.currentVersion, agentId, caller(exchange).name)
    changeLog(exchange, 'skill.install', 'skill', skill.id, skill.name, `→ ${agentId}`)
    return result
  })

  guarded('POST', '/api/skills/:id/uninstall', 'skill.install', (exchange) => {
    const { agentId } = body<{ agentId: string }>(exchange)
    ctx.skillHub.uninstall(exchange.params['id']!, agentId)
    return { uninstalled: true }
  })

  guarded('POST', '/api/skills/:id/rate', 'skill.read', (exchange) => {
    const { stars } = body<{ stars: number }>(exchange)
    const info = caller(exchange)
    return ctx.skillHub.rate(exchange.params['id']!, info.userId ?? info.principalId, stars)
  })

  guarded('POST', '/api/skills/:id/download', 'skill.read', (exchange) => {
    const { version } = body<{ version?: string }>(exchange)
    const info = caller(exchange)
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    // P1-02：包下载按同一可见性裁决（普通成员只能拿可见 Skill 的包，跨组织/受限项拒绝）
    if (!skillVisibleTo(skill, exchange)) throw new Error(t('Skill 不存在：{id}', { id: skill.id }))
    return ctx.skillHub.download(skill.id, version ?? skill.currentVersion, { id: info.userId ?? info.principalId, name: info.name })
  })

  /** skill.zip 包下载：与 NAS 上架产物同源（提交携带的原始包或 SKILL.md 现场打包）。 */
  guarded('GET', '/api/skills/:id/package', 'skill.read', (exchange) => {
    const skill = ctx.skillHub.detail(exchange.params['id']!)
    // P1-02：原始包下载按同一可见性裁决（与 download/install 同口径，不可见按不存在处理）
    if (!skillVisibleTo(skill, exchange)) throw new Error(t('Skill 不存在：{id}', { id: exchange.params['id'] }))
    const pkg = ctx.skillHub.packageOf(skill.id, exchange.query.get('version') ?? skill.currentVersion)
    // 中文 slug 文件名：ASCII 回退 + RFC 5987 UTF-8 形式（非 Latin1 字符直接进头会损坏响应）
    exchange.res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': pkg.buffer.length,
      'content-disposition': `attachment; filename="${pkg.filename.replace(/[^\x20-\x7e"]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(pkg.filename)}`,
      'cache-control': 'no-cache',
    })
    exchange.res.end(pkg.buffer)
  })

  // -- Skill 包存储配置（local / NAS 后端） --------------------------------
  guarded('GET', '/api/skill-storage', 'skill.read', () => {
    const config = ctx.nasRegistry.getSkillStorage()
    return {
      config,
      nasOptions: ctx.nasRegistry.list({ status: 'online' }).map((nas) => ({ id: nas.id, name: nas.name, slug: nas.slug, rootPath: nas.attrs['rootPath'] })),
    }
  })

  guarded('PUT', '/api/skill-storage', 'skill.storage.write', (exchange) => {
    const input = body<{ mode?: 'local' | 'nas'; nasId?: string; basePath?: string }>(exchange)
    const config = ctx.nasRegistry.setSkillStorage(input, caller(exchange).name)
    changeLog(exchange, 'skill.storage.update', 'skill_storage', config.id, t('Skill 包存储'), `${config.mode}${config.nasId ? ` → ${config.nasId}:${config.basePath}` : ''}`)
    return config
  })
}
