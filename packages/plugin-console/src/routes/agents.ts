/**
 * Agent 复合域路由：Agent 台账（机器身份读审计）/数据要素域（数据集/质量分/血缘/指标字典）/A2A 跨运行时调用（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出，处理器逐字搬运（行为与迁出前一致）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange, WorkforcePolicyRegistry } from '../../../platform-core/src/index.ts'
import { newId, PlatformEvents } from '../../../platform-core/src/index.ts'
import { AgentRegistryService } from '../../../plugin-agent/src/index.ts'
import { nonbillableUsage } from '../../../plugin-usage/src/index.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'
import { scopedOrgFilterOf } from './iam.ts'

export interface AgentRouteDeps extends ConsoleRouteDeps {
  requestOrigin: (exchange: HttpExchange) => string | undefined
  /** 分支权限判定（实现留 createRestGate，同 nas.ts 一端点多分支模式） */
  requirePermission: (exchange: HttpExchange, point: string) => boolean
  /** 拓扑节点名称/状态补全（skill/mcp_service 类型，定义留 index.ts） */
  enrichTopology: (node: any) => any
}

export function registerAgentRoutes(ctx: Context, deps: AgentRouteDeps): void {
  const { http, guarded, body, changeLog, caller, requestOrigin, requirePermission, enrichTopology } = deps
  // -- Agent --------------------------------------------------------------
  /** 机器身份读台账审计：接入提示词以「带机器令牌 GET /api/agents」为接入验证话术，此处让其成为事实。
   *  只记机器身份（人类控制台读操作高频，全量记录成噪音；机器读台账低频且带治理含义）。 */
  const machineAudit = (exchange: HttpExchange, resourceId: string, resourceName: string): void => {
    const info = caller(exchange)
    if (info.kind !== 'machine') return
    ctx.audit.record({
      type: 'auth', actorType: 'machine', actorId: info.principalId, actorName: info.name,
      action: 'agent.verify', resourceType: 'agent', resourceId, resourceName,
      result: 'ok', detail: t('机器身份访问 Agent 台账（接入验证/资产探测留痕）'),
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    })
  }

  /**
   * Agent 写操作归属守卫（镜像 app 域 QA A-04 守卫；QA-20261014 生命周期测试实测发现缺失）：
   * PATCH/删除/接入提示词/指标上报/状态流转此前仅校验 agent.write——本轮实测任意机器凭证
   * （hermes-agent）可 200 改写他人 Agent（zcode-agent）名称，onboarding-prompt 带 rotate 还可
   * 轮换他人凭证形成完全接管。现收敛为：平台管理员（'*'）、Agent owner（人类）、绑定本 Agent
   * 的机器主体（refType=agent 自助通道）之外一律 403 并落 audit.authz.denied。
   */
  const assertAgentOwner = (exchange: HttpExchange, agentId: string): boolean => {
    const info = caller(exchange)
    if (info.permissions.includes('*')) return true
    const agent = ctx.resourceCore.get('agent', agentId)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id: agentId }))
    const isOwner = info.kind === 'human' && info.userId !== undefined && agent.ownerId === info.userId
    const isBoundMachine = info.kind === 'machine' && info.refType === 'agent' && info.refId === agentId
    if (isOwner || isBoundMachine) return true
    ctx.platformBus.emit('audit.authz.denied', {
      actorId: info.userId ?? info.principalId,
      actorName: info.name,
      point: `agent.write(owner:${agentId})`,
      path: exchange.path,
    })
    exchange.fail(403, 'FORBIDDEN', t('仅平台管理员与 Agent 负责人可变更「{name}」（owner 校验，QA A-04 同款）', { name: agent.name }))
    return false
  }

  guarded('GET', '/api/agents', 'agent.read', (exchange) => {
    machineAudit(exchange, '-', t('Agent 台账'))
    // R11 多公司收口：非 `*` 管理员按本组织子树过滤（跨组织台账此前全平台可见）；
    // 显式 ?org= 且越界子树 → 403（不静默收窄，防误以为拿到了全量）
    const orgFilter = scopedOrgFilterOf(ctx, caller, exchange)
    const explicitOrg = exchange.query.get('org') ?? ''
    if (explicitOrg) {
      const scope = orgFilter
      if (scope && !scope(explicitOrg)) {
        exchange.fail(403, 'FORBIDDEN', t('org 超出你的组织子树范围（R11 多公司收口）'))
        return
      }
    }
    return {
      agents: ctx.resourceCore.list('agent')
        .filter((agent) => (explicitOrg ? agent.orgId === explicitOrg : orgFilter ? orgFilter(agent.orgId) : true))
        .map((agent) => ({
          ...agent,
          metrics: ctx.agentRegistry.metrics(agent.id),
          boundUserCount: ctx.agentRegistry.bindings().find((item) => item.agentId === agent.id).length,
          availableTransitions: ctx.resourceCore.availableTransitions('agent', agent.id),
        })),
      schema: ctx.resourceCore.typeSpec('agent')?.schema,
      lifecycle: ctx.resourceCore.typeSpec('agent')?.lifecycle,
    }
  })

  // -- 数据要素域（IAW 交接 2-1..2-4：数据集/质量分/血缘/指标字典） ----------------
  // 读面（panel.read）：面板场景抽屉/数据空间消费；写面（resource.dataset.write）：资源管理员治理。
  guarded('GET', '/api/resource/datasets', 'panel.read', (exchange) => ({
    datasets: ctx.resourceCore.listDatasets({
      ...(exchange.query.get('scene') ? { sceneCode: exchange.query.get('scene')! } : {}),
      ...(exchange.query.get('classification') ? { classification: exchange.query.get('classification')! } : {}),
      ...(exchange.query.get('org') ? { orgId: exchange.query.get('org')! } : {}),
      ...(exchange.query.get('q') ? { q: exchange.query.get('q')! } : {}),
    }),
  }))

  guarded('PUT', '/api/resource/datasets', 'resource.dataset.write', (exchange) => {
    const input = body<{ code: string; name: string; sourceSystem: string; classification: 'public' | 'internal' | 'secret'; refreshFrequency?: string; ownerOrgId?: string; sceneCodes?: string[]; note?: string }>(exchange)
    const dataset = ctx.resourceCore.upsertDataset(input)
    changeLog(exchange, 'resource.dataset.upsert', 'dataset', dataset.id, dataset.name, t('{code} 分级={classification} 场景={scenes}', { code: dataset.code, classification: dataset.classification, scenes: dataset.sceneCodes.join(',') || t('无') }))
    return dataset
  })

  guarded('PUT', '/api/resource/datasets/:code/quality', 'resource.dataset.write', (exchange) => {
    const input = body<{ completeness: number; accuracy: number; timeliness: number; consistency: number; note?: string }>(exchange)
    const dataset = ctx.resourceCore.scoreDataset(exchange.params['code']!, input)
    changeLog(exchange, 'resource.dataset.score', 'dataset', dataset.id, dataset.name, `overall=${dataset.quality?.overall}`)
    return dataset
  })

  guarded('GET', '/api/resource/lineage', 'panel.read', (exchange) => {
    const dataset = exchange.query.get('dataset') ?? ''
    if (!dataset) {
      exchange.fail(400, 'BAD_REQUEST', t('dataset 参数必填（数据集编号）'))
      return
    }
    return ctx.resourceCore.lineage(dataset)
  })

  guarded('PUT', '/api/resource/lineage', 'resource.dataset.write', (exchange) => {
    const input = body<{ derived: string; source: string; kind?: string }>(exchange)
    if (!input.derived?.trim() || !input.source?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', t('derived 与 source（数据集编号）必填'))
      return
    }
    const edge = ctx.resourceCore.addLineage(input.derived.trim(), input.source.trim(), input.kind ?? 'lineage')
    changeLog(exchange, 'resource.lineage.add', 'dataset_lineage', edge.id, `${input.source} → ${input.derived}`)
    return edge
  })

  guarded('GET', '/api/resource/metrics/:code/definitions', 'panel.read', (exchange) => ({
    code: exchange.params['code'],
    definitions: ctx.resourceCore.metricDefinitionsOf(exchange.params['code']!),
  }))

  guarded('PUT', '/api/resource/metrics/:code/definitions', 'resource.dataset.write', (exchange) => {
    const input = body<{ name: string; unit?: string; description?: string; payload?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    const result = ctx.resourceCore.putMetricDefinition({
      code: exchange.params['code']!,
      name: input.name,
      ...(input.unit ? { unit: input.unit } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      recordedBy: info.userId ?? info.principalId,
    })
    changeLog(exchange, 'resource.metric.define', 'metric_definition', result.definition.id, t('{code}：{name}', { code: exchange.params['code'], name: input.name }), result.conflict ? t('口径冲突留账（待仲裁）') : t('登记'))
    return result
  })

  guarded('POST', '/api/resource/metrics/:code/arbitrate', 'resource.dataset.write', (exchange) => {
    const input = body<{ definitionId: string }>(exchange)
    if (!input.definitionId?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', t('definitionId 必填（仲裁胜出的口径定义）'))
      return
    }
    const info = caller(exchange)
    const result = ctx.resourceCore.arbitrateMetric(exchange.params['code']!, input.definitionId, info.userId ?? info.principalId)
    changeLog(exchange, 'resource.metric.arbitrate', 'metric_definition', input.definitionId, exchange.params['code'] ?? '', t('取代 {n} 条旧口径', { n: result.superseded }))
    return result
  })

  /**
   * V16/D08 受管数字员工结构化探测（A2A「问答 vs 执行」分型）：按目标 agentId 反查受管员工。
   * 端口未就绪（ctx.workforcePolicy.port() 为 null）→ 保持现状（legacy，不标注）；
   * 端口执行异常 → 吞掉并按未命中处理（问答面 fail-open，不因治理端口故障阻塞 A2A 应答）。
   * 判定只依据服务端反查，与请求是否携带任何 work 上下文无关（冻结契约语义）。
   */
  const describeManagedAgentSafe = async (agentId: string): Promise<{ employeeId: string } | null> => {
    try {
      const registry = (ctx as unknown as { workforcePolicy?: WorkforcePolicyRegistry }).workforcePolicy
      const port = registry?.port?.() ?? null
      if (!port) return null
      return await port.describeManagedAgent(agentId)
    } catch {
      return null
    }
  }

  // -- A2A 跨运行时调用（IAW 交接 7-1 最小闭环） ---------------------------------
  // 平台原生 Agent 的 A2A 端点：外部运行时（Hermes/OpenClaw/WorkBuddy）凭机器凭证点名调用；
  // 响应回显 autonomy/runtime 供调用方做 A0-A3 交互深度协商（v1：级别随响应透出，深度协商留 v2）。
  // V16/D08 口径：A2A 是单轮「问答」（模型直答），不构成工具执行循环、不算任务执行或交付验收；
  // 目标 agent 命中受管数字员工时响应 additive 透出 workforce 分型字段（见下方成功分支）。
  guarded('POST', '/api/agents/:id/a2a/invoke', 'agent.a2a.invoke', async (exchange) => {
    const input = body<{ message: string; dataClass?: string; contextNote?: string }>(exchange)
    if (!input.message?.trim()) {
      exchange.fail(400, 'BAD_REQUEST', t('message 必填（A2A 点名调用内容）'))
      return
    }
    const ref = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', ref) ?? ctx.resourceCore.bySlug('agent', ref)
    if (!agent) {
      exchange.fail(404, 'NOT_FOUND', t('Agent 不存在：{id}', { id: ref }))
      return
    }
    if (agent.status !== 'online') {
      exchange.fail(400, 'BAD_REQUEST', t('Agent 未上线（{status}），A2A 仅对 online 开放', { status: agent.status }))
      return
    }
    const attrs = agent.attrs as Record<string, unknown>
    const model = String(attrs.model ?? '')
    if (!model) return { ok: false, reason: t('Agent 未配置模型（model 属性为空）') }
    const info = caller(exchange)
    const orgId = (info.userId ? ctx.iam.users().get(info.userId)?.orgId : undefined) ?? agent.orgId ?? ''
    const subject = info.refType === 'agent' && info.refId ? `agent:${info.refId}` : (info.userId ? `user:${info.userId}` : `a2a:${info.principalId}`)
    const dataClass = input.dataClass === 'public' || input.dataClass === 'internal' || input.dataClass === 'secret' ? input.dataClass : undefined
    const systemPrompt = String(attrs.systemPrompt ?? `你是企业数字同事「${agent.name}」。${String(attrs.description ?? '')}`)
    // V16/D08 分型探测：目标 agent 命中受管员工 → 响应 additive 透出 workforce 标注（问答 ≠ 任务执行）
    const managed = await describeManagedAgentSafe(agent.id)
    const workforce = managed ? { managed: true, employeeId: managed.employeeId, notice: t('问答结果，不构成任务执行或交付验收') } : undefined
    try {
      const result = await ctx.modelGateway.invoke({
        model,
        orgId,
        subject,
        ...(dataClass ? { dataClass } : {}),
        messages: [
          { role: 'system', content: input.contextNote ? `${systemPrompt}\n\n${input.contextNote}` : systemPrompt },
          { role: 'user', content: input.message },
        ],
      })
      try {
        // V16 计量口径：A2A 属「协作/问答」面（nonbillable calls 快照），不计任务完成、不进
        // agentRegistry 任务/执行口径（metrics-report 的 sessions 与执行中枢验收是另一条链）。
        ctx.usage.record(nonbillableUsage({
          org: orgId, subject, principal: orgId ? `org:${orgId}` : 'platform', resource: `agent:${agent.id}`,
          idempotency_key: `a2a:${agent.id}:${info.principalId}:${newId('a2a')}`,
        }))
      } catch { /* 计量面缺席不阻塞 A2A */ }
      ctx.audit.record({
        type: 'invoke', actorType: info.kind === 'human' ? 'human' : 'machine', actorId: subject, actorName: info.name,
        action: 'agent.a2a.invoke', resourceType: 'agent', resourceId: agent.id, resourceName: agent.name,
        result: 'ok', detail: `runtime=${String(attrs.runtime ?? 'dsh')} autonomy=${String(attrs.autonomy ?? 'A0')} model=${result.model}${workforce ? t('；workforce=受管员工({employeeId})，{notice}', { employeeId: workforce.employeeId, notice: workforce.notice }) : ''}`,
      })
      ctx.platformBus.emit(PlatformEvents.AgentA2aInvoked, {
        agentId: agent.id, slug: agent.slug, from: subject, model: result.model,
        autonomy: String(attrs.autonomy ?? 'A0'), runtime: String(attrs.runtime ?? 'dsh'),
        ...(workforce ? { workforce } : {}),
      })
      return {
        ok: true, reply: result.content, model: result.model,
        autonomy: String(attrs.autonomy ?? 'A0'), runtime: String(attrs.runtime ?? 'dsh'),
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        // V16/D08 additive 分型字段：命中受管数字员工才出现（legacy 路径无此键，消费方向后兼容）
        ...(workforce ? { workforce } : {}),
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      ctx.audit.record({
        type: 'invoke', actorType: info.kind === 'human' ? 'human' : 'machine', actorId: subject, actorName: info.name,
        action: 'agent.a2a.invoke', resourceType: 'agent', resourceId: agent.id, resourceName: agent.name,
        result: 'error', detail: t('失败：{reason}', { reason }),
      })
      return { ok: false, reason, autonomy: String(attrs.autonomy ?? 'A0'), runtime: String(attrs.runtime ?? 'dsh') }
    }
  })

  /** Agent 详情页 SSO 配置块（不含 secret；含 discovery，供前端与 dsh 免登接入使用）。 */
  const agentSsoView = (agentId: string, exchange: HttpExchange) => {
    const ssoClient = ctx.oidc.clientsForAgent(agentId)[0]
    if (!ssoClient) return null
    const { clientSecretHash: _hash, ...ssoSafe } = ssoClient
    void _hash
    return {
      ...ssoSafe,
      status: ssoSafe.status ?? 'active',
      clientType: ssoSafe.clientType ?? 'confidential',
      refAgentName: ctx.resourceCore.get('agent', ssoSafe.refId ?? '')?.name ?? undefined,
      discovery: {
        issuer: ctx.oidc.issuer(exchange),
        authorization_endpoint: `${ctx.oidc.issuer(exchange)}/oauth/authorize`,
        token_endpoint: `${ctx.oidc.issuer(exchange)}/oauth/token`,
        userinfo_endpoint: `${ctx.oidc.issuer(exchange)}/oauth/userinfo`,
      },
    }
  }

  guarded('GET', '/api/agents/:id', 'agent.read', (exchange) => {
    const id = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', id)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id }))
    // P1-02（安全审查 2026-10-31）：详情与列表同规的对象级组织校验——列表按组织过滤但
    // 详情按 ID 直读时未复核，跨组织账号可凭 ID 越界读取（含指标/绑定/SSO/审计）。
    const orgFilter = scopedOrgFilterOf(ctx, caller, exchange)
    if (orgFilter && !orgFilter(agent.orgId)) {
      exchange.fail(403, 'FORBIDDEN', t('目标 Agent 不在你的组织子树内（组织隔离）'))
      return
    }
    machineAudit(exchange, id, agent.name)
    const principal = ctx.agentRegistry.machinePrincipal(id)
    return {
      ...agent,
      metrics: ctx.agentRegistry.metrics(id),
      boundUsers: ctx.agentRegistry.boundUsers(id),
      availableTransitions: ctx.resourceCore.availableTransitions('agent', id),
      credential: principal ? { principalId: principal.id, clientId: principal.clientId, status: principal.status, activeTokens: ctx.authn.activeTokenCount(principal.id) } : null,
      topology: enrichTopology(ctx.resourceCore.topology('agent', id, 2)),
      impact: ctx.resourceCore.impact('agent', id),
      audit: ctx.audit.query({ resourceType: 'agent', resourceId: id, limit: 30 }).items,
      sso: agentSsoView(id, exchange),
      ssoEnforceMode: AgentRegistryService.ssoEnforceMode(),
    }
  })

  guarded('POST', '/api/agents', 'agent.write', (exchange) => {
    const input = body<{ name: string; slug?: string; attrs?: Record<string, unknown> }>(exchange)
    const info = caller(exchange)
    const user = info.userId ? ctx.iam.users().get(info.userId) : undefined
    const result = ctx.agentRegistry.register({
      ...input,
      ownerId: info.userId ?? info.principalId,
      ownerName: info.name,
      orgId: user?.orgId ?? ctx.iam.orgs().all()[0]?.id ?? 'org_unknown',
    })
    return { agent: result.agent, credential: result.credential ?? null }
  })

  guarded('PATCH', '/api/agents/:id', 'agent.write', (exchange) => {
    if (!assertAgentOwner(exchange, exchange.params['id']!)) return
    const input = body<{ name?: string; attrs?: Record<string, unknown> }>(exchange)
    // 模型目录单一事实源（issue #8）：PATCH 提供了 model 时校验目录存在性（未提供不动存量值）
    if (input.attrs && input.attrs['model'] !== undefined) ctx.agentRegistry.assertModelInCatalog(input.attrs['model'])
    const agent = ctx.resourceCore.update('agent', exchange.params['id']!, input)
    changeLog(exchange, 'agent.update', 'agent', agent.id, agent.name)
    return agent
  })

  // Agent 接入提示词（与 app 同构）：rotate=true 轮换机器凭证并随提示词返回完整凭证（旧值立即失效）。
  guarded('POST', '/api/agents/:id/onboarding-prompt', 'agent.write', (exchange) => {
    if (!assertAgentOwner(exchange, exchange.params['id']!)) return
    const { rotate } = body<{ rotate?: boolean }>(exchange)
    const id = exchange.params['id']!
    const result = ctx.agentRegistry.buildOnboardingPrompt(id, requestOrigin(exchange) ?? 'http://127.0.0.1:7300', { rotate: rotate === true })
    changeLog(exchange, 'agent.onboarding-prompt', 'agent', id, result.agentName, result.rotated ? t('轮换机器凭证并生成接入提示词（旧 secret 立即失效）') : t('生成接入提示词（未轮换，不含 secret）'))
    return result
  })

  // 运营数据提报（Agent 接入义务，与 AI 应用 metrics-report 同级）：dau 同日取最大、会话数累加、用户哈希去重并集
  guarded('POST', '/api/agents/:id/metrics-report', 'agent.write', (exchange) => {
    if (!assertAgentOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const input = body<{ dau?: number; sessions?: number; userIds?: string[]; uniqueUsers?: number; date?: string }>(exchange)
    ctx.agentRegistry.reportUsage(id, input)
    const agent = ctx.resourceCore.get('agent', id)!
    changeLog(exchange, 'agent.metrics.report', 'agent', id, agent.name,
      `dau=${input.dau ?? '-'} sessions=${input.sessions ?? '-'} users=${input.userIds?.length ?? input.uniqueUsers ?? '-'} date=${input.date ?? t('当日')}`)
    return ctx.agentRegistry.metrics(id)
  })

  guarded('POST', '/api/agents/:id/bindings', 'agent.write', (exchange) => {
    const { userId } = body<{ userId: string }>(exchange)
    const binding = ctx.agentRegistry.bindUser(exchange.params['id']!, userId, caller(exchange).name)
    changeLog(exchange, 'agent.bind_user', 'agent', binding.agentId, '', binding.userName)
    return binding
  })

  guarded('DELETE', '/api/agents/:id/bindings/:userId', 'agent.write', (exchange) => {
    ctx.agentRegistry.unbindUser(exchange.params['id']!, exchange.params['userId']!)
    return { unbound: true }
  })

  /** 删除 Agent：草稿（从未上线）或已归档可删；被未归档资源（如 AI 应用）引用时拒绝。 */
  guarded('DELETE', '/api/agents/:id', 'agent.write', (exchange) => {
    if (!assertAgentOwner(exchange, exchange.params['id']!)) return
    const id = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', id)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id }))
    const referencing = ctx.resourceCore.dependencies().find((record) => record.toType === 'agent' && record.toId === id)
      .map((record) => (ctx.resourceCore.typeSpec(record.fromType) ? ctx.resourceCore.get(record.fromType, record.fromId) : undefined))
      .filter((entity) => entity !== undefined && entity.status !== 'archived')
    if (referencing.length > 0) {
      throw new Error(t('该 Agent 仍被 {names} 引用，请先解除引用或归档引用方', { names: referencing.map((entity) => entity!.name).join('、') }))
    }
    ctx.resourceCore.remove('agent', id, { allowStates: ['draft', 'archived'] })
    ctx.agentRegistry.purge(id)
    changeLog(exchange, 'agent.delete', 'agent', id, agent.name)
    return { deleted: true }
  })

  // 生命周期流转：按动作分支权限（对齐工具面 agent_offline 的 agent.offline 口径——
  // 同一动作 REST/工具两面口径一致）：offline 守 agent.offline，其余（submit_trial/online/archive）
  // 守 agent.approve。绕过 guarded() 的统一包装需自带 try/catch（业务异常转 400）。
  http.register('POST', '/api/agents/:id/transition', async (exchange) => {
    const { action, note } = body<{ action: string; note?: string }>(exchange)
    if (!requirePermission(exchange, action === 'offline' ? 'agent.offline' : 'agent.approve')) return
    const info = caller(exchange)
    const id = exchange.params['id']!
    try {
      // owner 校验在 try 内（资源不存在的业务异常转 400 而非 500）；权限判定始终在最前（探针 403 语义）
      if (!assertAgentOwner(exchange, id)) return
      let result: unknown
      if (action === 'online') {
        const approval = ctx.agentRegistry.requestOnline(id, { id: info.userId ?? info.principalId, name: info.name })
        result = { approval, note: t('上线为 L4 操作，已创建审批单') }
      } else if (action === 'offline') {
        const approval = ctx.agentRegistry.requestOffline(id, { id: info.userId ?? info.principalId, name: info.name }, note ?? '')
        result = { approval, note: t('下线为 L4 操作，已创建审批单') }
      } else if (action === 'submit_trial') {
        result = ctx.agentRegistry.trial(id, info.name, [])
      } else if (action === 'archive') {
        result = ctx.agentRegistry.archive(id, info.name)
      } else {
        throw new Error(t('未知操作：{action}', { action }))
      }
      // 裸 http.register 不经 guarded() 的 ok 包装：返回值必须自行写响应（否则客户端挂起到超时）
      if (!exchange.res.writableEnded) exchange.ok(result)
    } catch (error) {
      exchange.fail(400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }, { access: 'guarded', permission: 'agent.approve,agent.offline' })

  guarded('POST', '/api/agents/:id/obo-token', 'agent.write', (exchange) => {
    const info = caller(exchange)
    const header = String(exchange.headers['authorization'] ?? '').slice(7)
    const verified = ctx.authn.verify(header)
    if (verified.principal.type !== 'human') throw new Error(t('on-behalf-of 令牌必须由用户身份发起'))
    // QA A-07：透传令牌是「以该用户身份行事」的高敏凭证——此前任意 agent.write 持有者
    // 可对他人 Agent 签发。收敛为：owner / 绑定用户 / 平台管理员（'*'）。
    const id = exchange.params['id']!
    const agent = ctx.resourceCore.get('agent', id)
    if (!agent) throw new Error(t('Agent 不存在：{id}', { id }))
    const isOwner = info.userId !== undefined && agent.ownerId === info.userId
    const isBound = ctx.agentRegistry.boundUsers(id).some((item) => item.userId === info.userId)
    if (!isOwner && !isBound && !info.permissions.includes('*')) {
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info.userId ?? info.principalId,
        actorName: info.name,
        point: `agent.obo(owner:${id})`,
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', t('仅 Agent 负责人或绑定用户可代「{name}」签发 on-behalf-of 令牌（QA A-07）', { name: agent.name }))
      return
    }
    const result = ctx.agentRegistry.issueOnBehalfOfToken(id, verified)
    changeLog(exchange, 'agent.obo_token', 'agent', id, '', t('链路：{chain}', { chain: result.actChain.map((item) => (item as { name: string }).name).join(' → ') }))
    return result
  })

}
