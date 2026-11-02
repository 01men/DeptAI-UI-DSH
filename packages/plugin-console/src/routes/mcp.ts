/**
 * MCP 服务与连接器纳管域路由（R4 巨石拆分，REFACTOR-2026-10-13，2026-10-13）：
 * 自 plugin-console/index.ts 拆出——MCP 服务 CRUD/导入/工具同步/终审/灰度部署/回滚/
 * 下线审批/删除/探活/指标/调用台账/权限组/invoke（含 resolveMcpCaller 身份反查，随迁），
 * 以及 open-connector 融合的连接器纳管（网关配置/目录/连接/执行网关/权限组/运行日志对账台账）。
 * 处理器逐字搬运（行为与迁出前一致）；maskServiceHeaders 属中间件层回显脱敏，定义留
 * index.ts、经依赖注入。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CallerInfo, HttpExchange, UnifiedPrincipal } from '../../../platform-core/src/index.ts'
import { toInvokeCaller } from '../../../platform-core/src/index.ts'
import { workRefFromArgs } from '../../../plugin-mcp/src/tools.ts'
import { envSecretAllowed, plainSensitiveHeaderViolation } from '../../../plugin-mcp/src/secret-broker.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type { ConsoleRouteDeps } from './deps.ts'

export interface McpRouteDeps extends ConsoleRouteDeps {
  /** 服务记录对外回显脱敏（存储保留原文；定义留 index.ts 中间件层） */
  maskServiceHeaders: <T extends { headers?: Record<string, string> }>(service: T) => T
}

export function registerMcpRoutes(ctx: Context, deps: McpRouteDeps): void {
  const { guarded, body, changeLog, caller, maskServiceHeaders } = deps

  /**
   * MCP 网关调用方身份解析（MCP 治理契约 §2，W2-T3 收敛）：优先读鉴权中间件写入的
   * exchange.principal.unified 经 toInvokeCaller 投影——与平台 /mcp bridge、服务级数据面
   * （routes/mcp-dataplane.ts）单点同源，消除最后一份手工映射；unified 缺席（理论不可达，
   * 中间件恒写入）回落既有手工映射保底，行为不变。权限组 subjects 以 agent/app 资源 ID
   * 授权，机器令牌须经 principal 的 refType/refId 反查归属资源，否则 agent 主体命中不了。
   */
  const resolveMcpCaller = (info: CallerInfo): { type: 'user' | 'agent' | 'app'; id: string; name: string; onBehalfOf?: string; actChain?: Array<{ name: string; type: string }>; subjects?: Array<{ type: 'user' | 'agent' | 'app'; id: string }> } => {
    const unified = (info as { unified?: UnifiedPrincipal }).unified
    if (unified) return toInvokeCaller(unified)
    if (info.kind === 'human') return { type: 'user', id: info.userId ?? info.principalId, name: info.name }
    const principal = ctx.authn.principals().get(info.principalId)
    if (principal?.refType === 'agent' && principal.refId) return { type: 'agent', id: principal.refId, name: info.name }
    if (principal?.refType === 'app' && principal.refId) return { type: 'app', id: principal.refId, name: info.name }
    return { type: 'app', id: info.principalId, name: info.name }
  }

  /**
   * Secret Broker 取用（W1-T2 §6）：与 riskRegistry 同款结构化取用——console 的 inject 清单
   * 未含 secretBroker，cordis 严格注入下直访 ctx.secretBroker 会被拦（without inject）。
   */
  const credentials = () => {
    const broker = ctx.mcpRegistry.secretBroker()
    if (!broker) throw new Error(t('Secret Broker 未装配（请确认 plugin-mcp 版本）'))
    return broker
  }

  /** 明文敏感头写入门禁（契约 §6）：命中即 400 SENSITIVE_HEADERS_FORBIDDEN，引导走 credential API。 */
  const rejectPlainSensitiveHeaders = (exchange: HttpExchange, headers: Record<string, string> | undefined): boolean => {
    const violations = plainSensitiveHeaderViolation(headers)
    if (violations.length === 0) return false
    exchange.fail(400, 'SENSITIVE_HEADERS_FORBIDDEN', t('请求头含敏感键（{keys}），禁止明文写入服务记录；请改用 PUT /api/mcp/services/:id/credential 下发凭证（迁移期逃生门：env MCP_ALLOW_PLAIN_HEADERS=1）', { keys: violations.join('、') }))
    return true
  }
  // -- MCP ----------------------------------------------------------------
  guarded('GET', '/api/mcp/services', 'mcp.service.read', () => ({
    services: ctx.mcpRegistry.services().all().map(maskServiceHeaders),
    overview: ctx.mcpRegistry.metricsOverview(),
  }))

  guarded('POST', '/api/mcp/services', 'mcp.service.write', (exchange) => {
    const input = body<{ name: string; slug?: string; description?: string; icon?: string; category?: string; endpoint?: string; transport?: 'stdio' | 'sse' | 'http'; mode?: 'hosted' | 'external'; orgId?: string; headers?: Record<string, string>; tools?: Array<{ name: string; description: string; riskLevel?: 'read' | 'write' | 'admin' | 'unknown'; inputSchema?: Record<string, unknown> }>; ownerEntity?: { type: 'platform' | 'app' | 'agent' | 'connector'; id?: string }; capabilityId?: string; exposureMode?: 'gateway' | 'direct' | 'internal'; dataClass?: 'public' | 'internal' | 'confidential'; environment?: 'dev' | 'staging' | 'prod'; visibility?: 'org' | 'tenant' | 'cross-org'; credentialRef?: string }>(exchange)
    // 契约 §6：显式写路径敏感 headers 一律拒绝（明文密钥不入业务集合）；
    // /api/mcp/import 为连接器桥接机器流程，走 importServices「导入即入保险箱」语义
    if (rejectPlainSensitiveHeaders(exchange, input.headers)) return
    // orgId 缺省回落根组织（与 /api/mcp/import 同口径）：外部推送方（机器凭证）无需 iam.org.read 即可注册
    const orgId = input.orgId ?? ctx.iam.orgs().findOne((org) => org.parentId === null)?.id
    const service = ctx.mcpRegistry.createService({
      ...input,
      ...(orgId ? { orgId } : {}),
      owner: caller(exchange).name,
      ...(input.tools ? { tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // W1/V11 根治：REST 创建服务的风险缺省不再隐式 read——未申报即 unknown（写能力须先经风险登记）
        riskLevel: tool.riskLevel ?? 'unknown',
        // 完整透传外部工具的 inputSchema（导入链路的关键信息），仅缺省时兜底空对象
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' && Object.keys(tool.inputSchema).length > 0
          ? tool.inputSchema
          : { type: 'object', properties: {}, additionalProperties: true },
      })) } : {}),
    })
    changeLog(exchange, 'mcp.service.create', 'mcp_service', service.id, service.name)
    return maskServiceHeaders(service)
  })

  /** mcpServers JSON 一键导入：解析 → 注册外部服务 → 自动发现工具 →（默认）验证上线。 */
  guarded('POST', '/api/mcp/import', 'mcp.service.write', async (exchange) => {
    const input = body<{ config: string | object; autoDeploy?: boolean }>(exchange)
    const rootOrg = ctx.iam.orgs().findOne((org) => org.parentId === null)
    if (!rootOrg) throw new Error(t('组织数据未初始化，无法导入'))
    const result = await ctx.mcpRegistry.importServices({
      config: input.config,
      orgId: rootOrg.id,
      owner: caller(exchange).name,
      ...(input.autoDeploy !== undefined ? { autoDeploy: input.autoDeploy } : {}),
    })
    for (const item of result.results) {
      if (item.ok && item.serviceId) changeLog(exchange, 'mcp.service.import', 'mcp_service', item.serviceId, item.name, `tools=${item.tools ?? 0} reachable=${item.reachable}`)
    }
    return result
  })

  /** 外部服务工具同步：以远端 tools/list 为准刷新本地工具清单。 */
  guarded('POST', '/api/mcp/services/:id/sync-tools', 'mcp.service.write', async (exchange) => {
    const service = await ctx.mcpRegistry.syncTools(exchange.params['id']!)
    changeLog(exchange, 'mcp.service.syncTools', 'mcp_service', service.id, service.name, `tools=${service.tools.length}`)
    return maskServiceHeaders(service)
  })

  guarded('PATCH', '/api/mcp/services/:id', 'mcp.service.write', (exchange) => {
    const patch = body<{ headers?: Record<string, string> } & Record<string, unknown>>(exchange)
    // 契约 §6：PATCH 写入敏感 headers 同样拒绝（明文迁移未完成前不给明文回潮入口）
    if (rejectPlainSensitiveHeaders(exchange, patch.headers)) return
    const service = ctx.mcpRegistry.updateService(exchange.params['id']!, patch)
    changeLog(exchange, 'mcp.service.update', 'mcp_service', service.id, service.name)
    return maskServiceHeaders(service)
  })

  guarded('POST', '/api/mcp/services/:id/verify', 'mcp.service.deploy', async (exchange) => {
    const service = await ctx.mcpRegistry.verifyService(exchange.params['id']!)
    changeLog(exchange, 'mcp.service.verify', 'mcp_service', service.id, service.name)
    return service
  })

  /**
   * MCP 服务公司级终审标记（WP-10/L1）：终审通过后，该服务全部调用记录附带水印
   * （watermark.finalReview），标记与水印在审计/调用台账双侧可追溯。
   */
  guarded('POST', '/api/mcp/services/:id/final-review', 'mcp.service.deploy', (exchange) => {
    const id = exchange.params['id']!
    const service = ctx.mcpRegistry.services().get(id)
    if (!service) throw new Error(t('MCP 服务不存在：{id}', { id }))
    const info = caller(exchange)
    const mark = { approverId: info.userId ?? info.principalId, approverName: info.name, at: new Date().toISOString() }
    const updated = ctx.mcpRegistry.services().update(id, { finalReview: mark })
    changeLog(exchange, 'mcp.final_review', 'mcp_service', id, service.name, t('公司级终审标记：后续调用将附带水印'))
    return { id, finalReview: updated.finalReview }
  })

  guarded('POST', '/api/mcp/services/:id/deploy', 'mcp.service.deploy', async (exchange) => {
    const input = body<{ grayPercent?: number; version?: string; changelog?: string; dryRun?: boolean }>(exchange)
    const id = exchange.params['id']!
    const impact = ctx.resourceCore.impact('mcp_service', id)
    if (input.dryRun) return { dryRun: true, impact }
    const service = await ctx.mcpRegistry.deployService(id, { ...input, actor: caller(exchange).name })
    changeLog(exchange, 'mcp.service.deploy', 'mcp_service', service.id, service.name, `v${service.currentVersion} gray=${service.grayPercent}%`)
    return service
  })

  guarded('POST', '/api/mcp/services/:id/rollback', 'mcp.service.deploy', async (exchange) => {
    const { targetVersion } = body<{ targetVersion: string }>(exchange)
    const service = await ctx.mcpRegistry.rollbackService(exchange.params['id']!, targetVersion, caller(exchange).name)
    changeLog(exchange, 'mcp.service.rollback', 'mcp_service', service.id, service.name, targetVersion)
    return service
  })

  guarded('POST', '/api/mcp/services/:id/offline', 'mcp.service.offline', (exchange) => {
    const { reason, viaApproval } = body<{ reason?: string; viaApproval?: boolean }>(exchange)
    if (!reason?.trim()) throw new Error(t('下线必须填写原因（护栏要求，下架分析依赖该口径）'))
    const id = exchange.params['id']!
    if (viaApproval !== false) {
      const impact = ctx.resourceCore.impact('mcp_service', id)
      const approval = ctx.mcpRegistry.requestOfflineApproval(id, { id: caller(exchange).userId ?? caller(exchange).principalId, name: caller(exchange).name }, reason ?? '', impact.map((item) => t('{name}（{type}）', { name: item.name, type: item.type })))
      return { approval, note: t('已创建 L4 审批单') }
    }
    const service = ctx.mcpRegistry.offlineService(id, caller(exchange).name, reason ?? '')
    changeLog(exchange, 'mcp.service.offline', 'mcp_service', service.id, service.name, reason ?? '')
    return service
  })

  /** 删除 MCP 服务：仅已下线可删；被权限组引用时拒绝；调用明细与审计数据保留。 */
  guarded('DELETE', '/api/mcp/services/:id', 'mcp.service.write', (exchange) => {
    const id = exchange.params['id']!
    const service = ctx.mcpRegistry.services().get(id)
    if (!service) throw new Error(t('MCP 服务不存在：{id}', { id }))
    if (service.status !== 'offline') throw new Error(t('当前状态 {status} 不可删除，请先下线服务', { status: service.status }))
    const referencingGroups = ctx.mcpRegistry.permGroups().find((group) => Object.keys(group.policies).includes(id))
    if (referencingGroups.length > 0) {
      throw new Error(t('该服务仍被权限组引用（{groups}），请先从权限组中移除', { groups: referencingGroups.map((group) => group.name).join('、') }))
    }
    ctx.mcpRegistry.purgeService(id)
    changeLog(exchange, 'mcp.service.delete', 'mcp_service', id, service.name)
    return { deleted: true }
  })

  guarded('POST', '/api/mcp/services/:id/health', 'mcp.service.deploy', async (exchange) => {
    return await ctx.mcpRegistry.healthCheck(exchange.params['id']!)
  })

  guarded('GET', '/api/mcp/services/:id/metrics', 'mcp.service.read', (exchange) => {
    return ctx.mcpRegistry.serviceMetrics(exchange.params['id']!)
  })

  guarded('GET', '/api/mcp/calls', 'mcp.service.read', (exchange) => {
    return ctx.mcpRegistry.callLog({
      serviceId: exchange.query.get('serviceId') ?? undefined,
      callerId: exchange.query.get('callerId') ?? undefined,
      status: exchange.query.get('status') ?? undefined,
      limit: Number(exchange.query.get('limit') ?? 100),
    })
  })

  // -- W1-T2 MCP 治理：归属指派 / 治理待办 / 下游凭证（契约 §5/§6） --------------------------
  /** 归属指派（§5）：type=app/agent 时校验资源存在（resourceCore 已在 console inject 清单）。 */
  guarded('POST', '/api/mcp/services/:id/owner-entity', 'mcp.service.write', (exchange) => {
    const id = exchange.params['id']!
    const input = body<{ type: 'platform' | 'app' | 'agent' | 'connector'; id?: string }>(exchange)
    if (input.type === 'app' || input.type === 'agent') {
      // connector 形态本期无 resource-core spec，不做资源存在性校验（W2-T4 能力绑定将回写 app 归属）
      const spec = ctx.resourceCore.typeSpec(input.type)
      const entity = spec && input.id ? ctx.resourceCore.get(input.type, input.id) : undefined
      if (!entity) throw new Error(t('{type} 资源不存在或未指定 id：{id}', { type: input.type, id: input.id ?? '' }))
    }
    const service = ctx.mcpRegistry.setOwnerEntity(id, input.id ? { type: input.type, id: input.id } : { type: input.type })
    changeLog(exchange, 'mcp.owner_entity.set', 'mcp_service', id, service.name, `owner=${input.type}${input.id ? `:${input.id}` : ''}`)
    return maskServiceHeaders(service)
  })

  /** 治理待办摘要（§5，只读）：unowned / 明文敏感头 / 非 gateway 暴露 + 总量。 */
  guarded('GET', '/api/mcp/governance/summary', 'mcp.service.read', () => ctx.mcpRegistry.governanceSummary())

  /**
   * 下游凭证保存（§6）：值写 SecretBroker 密钥文件（0600），服务记录只回写 credentialRef 引用；
   * env: 形态不落明文（secret 必须缺省）；credentialRef 与 secret 均缺省 = 清空（删凭证文件 + 清字段）。
   * 任何响应与 changeLog 绝不出现 secret 原文。
   */
  guarded('PUT', '/api/mcp/services/:id/credential', 'mcp.service.write', (exchange) => {
    const id = exchange.params['id']!
    const service = ctx.mcpRegistry.services().get(id)
    if (!service) throw new Error(t('MCP 服务不存在：{id}', { id }))
    const input = body<{ credentialRef?: string; headerName?: string; secret?: string }>(exchange)
    // P1-04（安全审查 2026-10-31）：env: 引用须命中 MCP_ENV_SECRET_ALLOWLIST 白名单——
    // 凭证引用与外呼地址同由 mcp.service.write 持有者指定，不加白名单即构成
    // 「把任意进程环境变量注入自选外呼头」的密钥外传链路。拒绝时给出登记指引。
    const ref = input.credentialRef?.trim() ?? ''
    if (ref.startsWith('env:')) {
      const varName = ref.slice(4).trim()
      if (!varName || !envSecretAllowed(varName)) {
        exchange.fail(400, 'ENV_CREDENTIAL_NOT_ALLOWED', t('env: 凭证引用「{ref}」未登记 MCP_ENV_SECRET_ALLOWLIST 白名单，已拒绝（防进程密钥外传）；请在部署环境登记该变量名后重试', { ref }))
        return
      }
    }
    if (!input.credentialRef?.trim() && !input.secret?.trim()) {
      credentials().delete(id)
      ctx.mcpRegistry.services().update(id, { credentialRef: undefined })
      changeLog(exchange, 'mcp.credential.clear', 'mcp_service', id, service.name)
      return { cleared: true, hasSecret: false }
    }
    const description = credentials().put({
      serviceId: id,
      ...(input.credentialRef?.trim() ? { credentialRef: input.credentialRef.trim() } : {}),
      ...(input.headerName?.trim() ? { headerName: input.headerName.trim() } : {}),
      ...(input.secret?.trim() ? { secret: input.secret } : {}),
    })
    ctx.mcpRegistry.services().update(id, { credentialRef: description.credentialRef })
    changeLog(exchange, 'mcp.credential.put', 'mcp_service', id, service.name, `ref=${description.credentialRef} headers=${description.headerNames.join(',')}`)
    return { credentialRef: description.credentialRef, headerName: description.headerNames[0], hasSecret: true, updatedAt: description.updatedAt }
  })

  /** 凭证描述（§6，只读）：只有引用与元数据，永不返回 secret 原文。 */
  guarded('GET', '/api/mcp/services/:id/credential', 'mcp.service.read', (exchange) => {
    const id = exchange.params['id']!
    const service = ctx.mcpRegistry.services().get(id)
    if (!service) throw new Error(t('MCP 服务不存在：{id}', { id }))
    const description = credentials().describe(id)
    return {
      credentialRef: service.credentialRef ?? description?.credentialRef,
      headerName: description?.headerNames[0],
      hasSecret: Boolean(description && description.headerNames.length > 0),
      updatedAt: description?.updatedAt,
    }
  })

  /** 明文敏感头迁移（§6）：dryRun 预检报告；执行态逐服务迁入 SecretBroker 并从 headers 删除敏感键。 */
  guarded('POST', '/api/mcp/credentials/migrate', 'mcp.service.write', (exchange) => {
    const input = body<{ dryRun?: boolean }>(exchange)
    const result = ctx.mcpRegistry.migratePlainHeaders({ dryRun: input.dryRun === true })
    if (!result.dryRun) {
      for (const item of result.candidates) {
        changeLog(exchange, 'mcp.credential.migrate', 'mcp_service', item.serviceId, item.serviceName, `keys=${item.keys.join(',')}`)
      }
    }
    return result
  })

  guarded('GET', '/api/mcp/perm-groups', 'mcp.service.read', () => ({ groups: ctx.mcpRegistry.permGroups().all() }))

  guarded('POST', '/api/mcp/perm-groups', 'mcp.permgroup.write', (exchange) => {
    const input = body<{ name: string; description?: string; policies: Record<string, { allowedTools: '*' | string[]; constraints?: { readOnly?: boolean } }>; subjects: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }> }>(exchange)
    const group = ctx.mcpRegistry.createPermGroup({
      name: input.name,
      description: input.description,
      policies: Object.fromEntries(Object.entries(input.policies).map(([serviceId, policy]) => [
        serviceId,
        { allowedTools: policy.allowedTools, constraints: policy.constraints ?? {} },
      ])),
      subjects: input.subjects,
    })
    changeLog(exchange, 'mcp.permgroup.create', 'mcp_perm_group', group.id, group.name)
    return group
  })

  guarded('PATCH', '/api/mcp/perm-groups/:id', 'mcp.permgroup.write', (exchange) => {
    const group = ctx.mcpRegistry.updatePermGroup(exchange.params['id']!, body(exchange))
    changeLog(exchange, 'mcp.permgroup.update', 'mcp_perm_group', group.id, group.name)
    return group
  })

  guarded('DELETE', '/api/mcp/perm-groups/:id', 'mcp.permgroup.write', (exchange) => {
    ctx.mcpRegistry.deletePermGroup(exchange.params['id']!)
    changeLog(exchange, 'mcp.permgroup.delete', 'mcp_perm_group', exchange.params['id']!, '')
    return { deleted: true }
  })

  // W2（D11 additive）：REST 面与工具面同一套 work 引用白名单口径（workRefFromArgs）——
  // 仅 permitId/runId/stepKey 三键作索引透传（空串剔除、其余键一律忽略），授权事实一律服务端回查；
  // 身份解析链不动（仍令牌解析 resolveMcpCaller，不接受请求参数自报身份）。
  // 【兼容层（MCP 治理契约 §9，W2-T3）】行为不变：Agent 标准默认路径是服务级数据面
  // POST /mcp/services/:serviceSlug（委托令牌 aud=mcp:service:<slug>，见 routes/mcp-dataplane.ts），
  // 本端点仅供存量 REST 调用方过渡使用。
  // W3-T5（契约 §11/§12/§13/§14）：统一 Principal 事实附加投影（org/租户/委托链用户/scopes/
  // 审批引用）供 PDP org-constraint 与 iam-permission 第一层消费；traceId 从 X-Trace-Id 头取
  // （32hex 形态校验，非法即由网关入口新生成），body.approvalId 供 cross-org 审批引用。
  guarded('POST', '/api/mcp/invoke', 'mcp.invoke', async (exchange) => {
    const input = body<{ serviceId: string; tool: string; args?: Record<string, unknown>; work?: { permitId?: string; runId?: string; stepKey?: string }; approvalId?: string }>(exchange)
    const info = caller(exchange)
    const unified = (info as { unified?: UnifiedPrincipal }).unified
    const headerTraceId = String(exchange.headers['x-trace-id'] ?? '')
    return await ctx.mcpRegistry.invoke({
      ...resolveMcpCaller(info),
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
      ...(info.actChain.length > 0 ? { onBehalfOf: info.actChain[0]!.name } : {}),
      ...(unified?.orgId !== undefined ? { orgId: unified.orgId } : {}),
      ...(unified?.tenantId !== undefined ? { tenantId: unified.tenantId } : {}),
      ...(unified?.subjectUserId !== undefined ? { subjectUserId: unified.subjectUserId } : {}),
      ...(unified ? { scopes: [...unified.scopes] } : {}),
      ...(/^[0-9a-f]{32}$/.test(headerTraceId) ? { traceId: headerTraceId } : {}),
      ...(typeof input.approvalId === 'string' && input.approvalId.trim() !== '' ? { approvalId: input.approvalId.trim() } : {}),
    }, input.serviceId, input.tool, input.args ?? {}, workRefFromArgs(input.work))
  })

  // -- W3-T5（契约 §12/§14）：资源限定 scope 模板 / 策略模拟（dry 语义，不落库） ---------------
  /** scope 模板（§12）：按权限组 policies 生成建议资源限定 scope 集（控制台 W3-T6 消费展示）。 */
  guarded('POST', '/api/mcp/perm-groups/:id/scope-template', 'mcp.permgroup.read', (exchange) => {
    return ctx.mcpRegistry.scopeTemplate(exchange.params['id']!)
  })

  /** 策略模拟（§14）：body=完整权限组草稿，不落库，返回影响报告四维 + 主体展开。 */
  guarded('POST', '/api/mcp/perm-groups/dry-run', 'mcp.permgroup.write', (exchange) => {
    const input = body<{ name?: string; policies: Record<string, { allowedTools: '*' | string[]; constraints?: { readOnly?: boolean } }>; subjects?: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }> }>(exchange)
    return ctx.mcpRegistry.dryRunPermGroup({
      ...(input.name !== undefined ? { name: input.name } : {}),
      policies: Object.fromEntries(Object.entries(input.policies ?? {}).map(([serviceId, policy]) => [
        serviceId,
        { allowedTools: policy.allowedTools, constraints: policy.constraints ?? {} },
      ])),
      ...(input.subjects !== undefined ? { subjects: input.subjects } : {}),
    })
  })

  // -- MCP 工具风险登记（W 批次 W1 · V11 根治：登记→两级审批→生效→重审清单→退场） ------------
  // 全域权限点 mcp.risk.admin；审批人身份一律取 caller（body 不收审批人，防代审）；全部动作 changeLog 留痕。
  // 取用口径：经 ctx.mcpRegistry.riskRegistry()（同插件直连引用）——console 的 inject 清单未含
  // mcpToolRisks，cordis 严格注入下直接访问 ctx.mcpToolRisks 会被拦（without inject）。
  const risks = () => {
    const registry = ctx.mcpRegistry.riskRegistry()
    if (!registry) throw new Error(t('MCP 工具风险登记服务未装配（请确认 plugin-mcp 版本）'))
    return registry
  }
  guarded('POST', '/api/mcp/risk-registry', 'mcp.risk.admin', (exchange) => {
    const input = body<{ serviceId: string; toolName: string; risk: 'read' | 'write' | 'admin'; reason: string }>(exchange)
    if (!input.reason?.trim()) throw new Error(t('登记必须填写原因（write/admin 风险更须说明用途与影响面）'))
    const info = caller(exchange)
    const record = risks().submit({
      serviceId: input.serviceId,
      toolName: input.toolName,
      risk: input.risk,
      reason: input.reason,
      actor: { id: info.userId ?? info.principalId, name: info.name },
    })
    changeLog(exchange, 'mcp.risk.submit', 'mcp_tool_risk', record.id, `${record.serviceId}/${record.toolName}`, `risk=${record.risk} status=${record.status}`)
    return record
  })

  guarded('POST', '/api/mcp/risk-registry/:id/decide', 'mcp.risk.admin', (exchange) => {
    const input = body<{ decision: 'approve' | 'reject'; level: 'domain' | 'security'; opinion?: string }>(exchange)
    const id = exchange.params['id']!
    const record = risks().get(id)
    if (!record) {
      exchange.fail(404, 'RISK_RECORD_NOT_FOUND', t('风险登记不存在：{id}', { id }))
      return
    }
    // level 与当前 pending 级别不匹配 → 400 中文错误（顺序状态机不可跳级，D-①）
    const pendingLevel = record.status === 'pending_domain' ? 'domain' : record.status === 'pending_security' ? 'security' : undefined
    if (!pendingLevel) {
      exchange.fail(400, 'RISK_NOT_PENDING', t('当前状态 {status} 不可审批（仅 pending 态可审批）', { status: record.status }))
      return
    }
    if (input.level !== pendingLevel) {
      exchange.fail(400, 'RISK_LEVEL_MISMATCH', pendingLevel === 'domain'
        ? t('当前等待领域审批（level 须为 domain）')
        : t('当前等待安全审批（level 须为 security；write/admin 风险必须安全加签）'))
      return
    }
    const info = caller(exchange)
    const updated = risks().decide(id, {
      decision: input.decision,
      level: input.level,
      opinion: input.opinion ?? '',
      actor: { id: info.userId ?? info.principalId, name: info.name },
    })
    changeLog(exchange, `mcp.risk.${input.decision}`, 'mcp_tool_risk', updated.id, `${updated.serviceId}/${updated.toolName}`, `${input.level} → ${updated.status}`)
    return updated
  })

  guarded('GET', '/api/mcp/risk-registry', 'mcp.risk.admin', (exchange) => {
    return risks().list({
      serviceId: exchange.query.get('serviceId') ?? undefined,
      status: exchange.query.get('status') ?? undefined,
    })
  })

  // D-⑤=a 全量重审清单：external+real 服务全工具「申报值 vs 生效登记值」逐一对账（含 orphan）
  guarded('GET', '/api/mcp/risk-registry/review-list', 'mcp.risk.admin', () => risks().reviewList())

  guarded('POST', '/api/mcp/risk-registry/:id/retire', 'mcp.risk.admin', (exchange) => {
    const input = body<{ reason: string }>(exchange)
    if (!input.reason?.trim()) throw new Error(t('退场必须填写原因（护栏要求，重审与追溯依赖该口径）'))
    const info = caller(exchange)
    const record = risks().retire(exchange.params['id']!, {
      reason: input.reason,
      actor: { id: info.userId ?? info.principalId, name: info.name },
    })
    changeLog(exchange, 'mcp.risk.retire', 'mcp_tool_risk', record.id, `${record.serviceId}/${record.toolName}`, input.reason)
    return record
  })

  // -- 连接器纳管（open-connector 融合） ------------------------------------
  // 路由集中在 console（仓内铁律），业务逻辑全在 plugin-connector；OcError 的错误码/状态
  // 原样透传（oauth_client_config_required→向导指引、connection_not_allowed→403 等）。
  const runWithOcErrors = async (exchange: HttpExchange, handler: () => Promise<unknown> | unknown): Promise<unknown> => {
    try {
      return await handler()
    } catch (error) {
      const status = (error as { status?: unknown }).status
      const code = (error as { code?: unknown }).code
      const message = error instanceof Error ? error.message : String(error)
      const guidance = (error as { guidance?: unknown }).guidance
      if (typeof status === 'number' && typeof code === 'string' && typeof guidance !== 'undefined'
        || (typeof status === 'number' && typeof code === 'string' && (error as { name?: string }).name === 'OcError')) {
        exchange.fail(status, code.toUpperCase(), guidance ? `${message} ${String(guidance)}` : message)
        return undefined
      }
      throw error
    }
  }

  /**
   * 连接器域组织可见范围：超管可带 ?orgId= 查任意组织；普通用户锁定在自身归属组织；
   * 机器收敛到绑定资源的归属组织，外部机器无归属 → 无可见数据（fail-closed）。
   * 与工具路径共用 connectorHub.orgScopeFor，REST/工具一套标准（审查 P0-1）。
   */
  const restrictOrgScope = (exchange: HttpExchange): string | null | undefined => {
    const info = caller(exchange)
    const requested = exchange.query.get('orgId') ?? undefined
    if (info.permissions.includes('*')) return requested
    const scope = ctx.connectorHub.orgScopeFor(info)
    if (scope === undefined) return requested
    return scope
  }

  /** 连接引用对外回显：无凭证字段（结构保证），maskedProfile 已在服务侧脱敏。 */
  const maskReference = <T extends { maskedProfile?: Record<string, string> }>(ref: T): T => ref

  const requireBodyOrg = (orgId: string | undefined): string => {
    if (!orgId) throw new Error(t('orgId 必填（连接归属组织，org:<orgId>: 别名前缀由此而来）'))
    return orgId
  }

  const resolveConnectorCaller = (info: CallerInfo): { type: 'user' | 'agent' | 'app'; id: string; name: string } => {
    if (info.kind === 'human') return { type: 'user', id: info.userId ?? info.principalId, name: info.name }
    const principal = ctx.authn.principals().get(info.principalId)
    if (principal?.refType === 'agent' && principal.refId) return { type: 'agent', id: principal.refId, name: info.name }
    if (principal?.refType === 'app' && principal.refId) return { type: 'app', id: principal.refId, name: info.name }
    return { type: 'app', id: info.principalId, name: info.name }
  }

  // -- 网关配置 -------------------------------------------------------------
  guarded('GET', '/api/connector/gateway', 'connector.gateway.write', (exchange) => {
    // ?assumeEnv=JSON：只读「预演探针」——评估强制 env 门禁各分支的 fail-closed 文案
    // （不改动进程真实环境；selftest T-02 依赖此确定性断言路径）。
    const assumeRaw = exchange.query.get('assumeEnv')
    if (assumeRaw) {
      try {
        const parsed = JSON.parse(assumeRaw) as Record<string, boolean>
        return ctx.connectorHub.gatewayStatus(parsed)
      } catch {
        throw new Error(t('assumeEnv 必须是 {"ENV_NAME": boolean} 形态的 JSON'))
      }
    }
    return ctx.connectorHub.gatewayStatus()
  })

  /** org 巡检手动触发（T-21 确定性断言；定时器周期外的一致性复核入口）。 */
  guarded('POST', '/api/connector/patrol', 'connector.gateway.write', async (exchange) => {
    return await runWithOcErrors(exchange, () => ctx.connectorHub.runPatrols(exchange.query.get('catalog') === '1' ? true : undefined))
  })

  guarded('PUT', '/api/connector/gateway', 'connector.gateway.write', async (exchange) => {
    const input = body<{ baseUrl: string; adminToken?: string; autoCatalogSyncMinutes?: number }>(exchange)
    const record = await ctx.connectorHub.configureGateway(input, caller(exchange).name)
    changeLog(exchange, 'connector.gateway.configure', 'connector_gateway', record.id, record.baseUrl)
    return { ok: true, baseUrl: record.baseUrl, versionPin: record.versionPin, autoCatalogSyncMinutes: record.autoCatalogSyncMinutes }
  })

  guarded('POST', '/api/connector/gateway/health', 'connector.gateway.write', async (exchange) => {
    const result = await ctx.connectorHub.probeGateway()
    changeLog(exchange, 'connector.gateway.probe', 'connector_gateway', 'gateway', '', result.ok ? `healthy ${result.latencyMs}ms` : `${result.reason ?? ''}`)
    return result
  })

  // connector.offline：网关维护下线（默认 L4 审批；viaApproval=false 需管理员显式绕行并留痕）
  guarded('POST', '/api/connector/gateway/offline', 'connector.gateway.write', async (exchange) => {
    const input = body<{ reason?: string; viaApproval?: boolean }>(exchange)
    if (!input.reason?.trim()) throw new Error(t('下线必须填写原因（护栏要求，处置复盘依赖该口径）'))
    const info = caller(exchange)
    if (input.viaApproval === false) {
      const record = await ctx.connectorHub.offlineGateway(input.reason)
      changeLog(exchange, 'connector.gateway.offline', 'connector_gateway', record?.id ?? 'gateway', input.reason, t('直连模式（无审批）'))
      return { offlined: true, mode: 'direct' }
    }
    const approval = ctx.audit.createApproval({
      kind: 'connector.offline',
      title: t('连接器网关维护下线：{reason}', { reason: input.reason.slice(0, 40) }),
      payload: { scope: 'gateway', reason: input.reason, requesterId: info.userId ?? info.principalId, requesterName: info.name },
      requesterId: info.userId ?? info.principalId,
      requesterName: info.name,
    })
    changeLog(exchange, 'connector.gateway.offline.request', 'approval_center', approval.id, input.reason, t('L4 审批单已创建'))
    return { approvalRequired: true, approvalId: approval.id }
  })

  // 恢复上线：低风险运维动作（清除维护标记并立即探活），不设审批
  guarded('POST', '/api/connector/gateway/online', 'connector.gateway.write', async (exchange) => {
    const result = await ctx.connectorHub.onlineGateway()
    changeLog(exchange, 'connector.gateway.online', 'connector_gateway', 'gateway', '', result.ok ? `healthy ${result.latencyMs}ms` : (result.reason ?? ''))
    return { ...result, online: true }
  })

  // -- 目录 -----------------------------------------------------------------
  guarded('GET', '/api/connector/catalog', 'connector.catalog.read', (exchange) => {
    const q = (exchange.query.get('q') ?? '').toLowerCase()
    const service = exchange.query.get('service')
    const kind = exchange.query.get('kind')
    const limit = Math.min(Number(exchange.query.get('limit') ?? 100), 500)
    const catalog = ctx.connectorHub.catalogs().all()[0]
    if (!catalog) return { providers: [], actions: [], skippedServices: [] as Array<{ service: string; reason: string }> }
    const filterProvider = (provider: Record<string, unknown>): boolean =>
      (!service || String(provider['service']) === service)
      && (!q || JSON.stringify(provider).toLowerCase().includes(q))
    const filterAction = (action: { id: string; service: string; description?: string }): boolean =>
      (!service || action.service === service)
      && (!q || `${action.id} ${action.service} ${action.description ?? ''}`.toLowerCase().includes(q))
    return {
      ...(catalog.syncedAt ? { syncedAt: catalog.syncedAt } : {}),
      providers: kind === 'actions' ? [] : catalog.providers.filter(filterProvider).slice(0, limit),
      actions: kind === 'providers' ? [] : catalog.actions.filter(filterAction).slice(0, limit),
      skippedServices: catalog.skippedServices,
    }
  })

  guarded('GET', '/api/connector/catalog/actions/:id/guide', 'connector.catalog.read', async (exchange) => {
    const { client } = ctx.connectorHub['requireClient']()
    const text = await client.getActionGuide(exchange.params['id']!)
    return { actionId: exchange.params['id'], guide: text }
  })

  guarded('GET', '/api/connector/catalog/actions/:id', 'connector.catalog.read', (exchange) => {
    const action = ctx.connectorHub.requireAction(exchange.params['id']!)
    return { action }
  })

  guarded('POST', '/api/connector/catalog/sync', 'connector.gateway.write', async (exchange) => {
    const result = await runWithOcErrors(exchange, () => ctx.connectorHub.syncCatalog(caller(exchange).name))
    if (!result) return // 错误响应已由处理器写出（如网关 fail-closed 503）
    changeLog(exchange, 'connector.catalog.sync', 'connector_catalog', 'catalog', '', `providers/actions=${(result as { providers?: number }).providers ?? 0}/${(result as { actions?: number }).actions ?? 0}`)
    return result
  })

  // -- 连接 -----------------------------------------------------------------
  guarded('GET', '/api/connector/connections', 'connector.connection.read', (exchange) => {
    const restrictedOrg = restrictOrgScope(exchange)
    if (restrictedOrg === null) return { total: 0, connections: [] }
    const refs = ctx.connectorHub.connections().find((item) =>
      (restrictedOrg === undefined || item.ownerOrgId === restrictedOrg))
    return { total: refs.length, connections: refs.map(maskReference) }
  })

  guarded('POST', '/api/connector/connections/oauth', 'connector.connection.write', async (exchange) => {
    const input = body<{ provider: string; aliasSuffix: string; requestedScopes?: string[]; requireApproval?: boolean; approvalId?: string; actorName?: string }>(exchange)
    const info = caller(exchange)
    const result = await runWithOcErrors(exchange, () => ctx.connectorHub.createConnection({
      orgId: requireBodyOrg(input.orgId),
      actor: { id: info.userId ?? info.principalId, name: input.actorName ?? info.name },
      provider: input.provider,
      aliasSuffix: input.aliasSuffix,
      authType: 'oauth',
      ...(input.requestedScopes?.length ? { requestedScopes: input.requestedScopes } : {}),
      ...(input.requireApproval !== undefined ? { requireApproval: input.requireApproval } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    }))
    if ((result as { reference?: { id: string } }).reference) {
      changeLog(exchange, 'connector.connection.oauth.start', 'connector_connection', (result as { reference: { id: string } }).reference.id, input.provider, input.orgId)
    } else if ((result as { approvalRequired?: boolean }).approvalRequired) {
      changeLog(exchange, 'connector.connection.approval', 'approval_center', (result as { approvalId?: string }).approvalId ?? '', input.provider, t('连接创建进入审批门禁'))
    }
    return result
  })

  guarded('POST', '/api/connector/connections/api-key', 'connector.connection.write', async (exchange) => {
    // 表单值过手直达 sidecar，不落任何集合、不打日志（红线一）
    const input = body<{ provider: string; aliasSuffix: string; values: Record<string, unknown>; authType?: 'api_key' | 'custom_credential'; requireApproval?: boolean; approvalId?: string; actorName?: string }>(exchange)
    const info = caller(exchange)
    const result = await runWithOcErrors(exchange, () => ctx.connectorHub.createConnection({
      orgId: requireBodyOrg(input.orgId),
      actor: { id: info.userId ?? info.principalId, name: input.actorName ?? info.name },
      provider: input.provider,
      aliasSuffix: input.aliasSuffix,
      authType: input.authType ?? 'api_key',
      values: input.values,
      ...(input.requireApproval !== undefined ? { requireApproval: input.requireApproval } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    }))
    const ref = (result as { reference?: { id: string } }).reference
    if (ref) changeLog(exchange, 'connector.connection.create', 'connector_connection', ref.id, input.provider, t('{authType} 直达 sidecar', { authType: input.authType ?? 'api_key' }))
    else if ((result as { approvalRequired?: boolean }).approvalRequired) {
      changeLog(exchange, 'connector.connection.approval', 'approval_center', (result as { approvalId?: string }).approvalId ?? '', input.provider, t('连接创建进入审批门禁'))
    }
    return result
  })

  guarded('POST', '/api/connector/connections/no-auth', 'connector.connection.write', async (exchange) => {
    const input = body<{ provider: string; aliasSuffix: string; actorName?: string }>(exchange)
    const info = caller(exchange)
    const result = await runWithOcErrors(exchange, () => ctx.connectorHub.createConnection({
      orgId: requireBodyOrg(input.orgId),
      actor: { id: info.userId ?? info.principalId, name: input.actorName ?? info.name },
      provider: input.provider,
      aliasSuffix: input.aliasSuffix,
      authType: 'no_auth',
    }))
    const ref = (result as { reference?: { id: string } }).reference
    if (ref) changeLog(exchange, 'connector.connection.create', 'connector_connection', ref.id, input.provider, t('no_auth 虚拟连接登记'))
    return result
  })

  guarded('GET', '/api/connector/connections/oauth/:requestId/status', 'connector.connection.write', async (exchange) => {
    return await runWithOcErrors(exchange, () => ctx.connectorHub.confirmConnectionStatus({ requestId: exchange.params['requestId'] }))
  })

  guarded('POST', '/api/connector/connections/refresh', 'connector.connection.read', async (exchange) => {
    const orgFilter = exchange.query.get('orgId') ?? undefined
    return await runWithOcErrors(exchange, () => ctx.connectorHub.refreshConnections(orgFilter))
  })

  guarded('POST', '/api/connector/connections/:id/offline', 'connector.connection.write', async (exchange) => {
    const input = body<{ reason?: string; viaApproval?: boolean }>(exchange)
    if (!input.reason?.trim()) throw new Error(t('下线必须填写原因（护栏要求）'))
    const id = exchange.params['id']!
    const info = caller(exchange)
    if (input.viaApproval === false) {
      const ref = await runWithOcErrors(exchange, () => ctx.connectorHub.offlineConnection(id, { actorName: info.name, reason: input.reason! }))
      if (!ref) return
      changeLog(exchange, 'connector.connection.offline', 'connector_connection', id, ref.alias, input.reason)
      return { offlined: true, mode: 'direct', reference: maskReference(ref) }
    }
    const approval = ctx.audit.createApproval({
      kind: 'connector.offline',
      title: t('下线连接：{id}', { id }),
      payload: { scope: 'connection', connectionId: id, reason: input.reason, requesterId: info.userId ?? info.principalId, requesterName: info.name },
      requesterId: info.userId ?? info.principalId,
      requesterName: info.name,
    })
    changeLog(exchange, 'connector.connection.offline.request', 'approval_center', approval.id, id, input.reason)
    return { approvalRequired: true, approvalId: approval.id }
  })

  guarded('POST', '/api/connector/connections/:id/online', 'connector.connection.write', async (exchange) => {
    const restored = await runWithOcErrors(exchange, () => ctx.connectorHub.onlineConnection(exchange.params['id']!))
    if (!restored) return
    changeLog(exchange, 'connector.connection.online', 'connector_connection', restored.id, restored.alias, '')
    return { online: true, reference: maskReference(restored) }
  })

  guarded('DELETE', '/api/connector/connections/:id', 'connector.connection.write', async (exchange) => {
    const input = body<{ force?: boolean }>(exchange)
    const deleteOutcome = await runWithOcErrors(exchange, () => ctx.connectorHub.deleteConnection(exchange.params['id']!, {
      actor: caller(exchange).name, ...(input.force ? { force: true } : {}),
    }))
    if (!deleteOutcome) return // 错误响应已由处理器写出（如 connection_in_use 409）
    const result = deleteOutcome as Awaited<ReturnType<typeof ctx.connectorHub.deleteConnection>>
    changeLog(exchange, 'connector.connection.delete', 'connector_connection', exchange.params['id']!, '', `released=${result.releasedGroups.join(',') || 'none'}`)
    return result
  })

  // -- 执行网关 --------------------------------------------------------------
  guarded('POST', '/api/connector/execute', 'connector.invoke', async (exchange) => {
    const input = body<{ actionId: string; input?: Record<string, unknown>; connection?: string; dryRun?: boolean }>(exchange)
    const info = caller(exchange)
    const resolved = resolveConnectorCaller(info)
    return await runWithOcErrors(exchange, () => ctx.connectorHub.invokeAction({
      ...resolved,
      ...(info.actChain.length > 0 ? { actChain: info.actChain } : {}),
    }, {
      actionId: input.actionId,
      input: input.input ?? {},
      ...(input.connection ? { alias: input.connection } : {}),
      ...(input.dryRun ? { dryRun: true } : {}),
    }))
  })

  // -- 权限组 -----------------------------------------------------------------
  guarded('GET', '/api/connector/perm-groups', 'connector.connection.read', (exchange) => {
    const orgFilter = restrictOrgScope(exchange)
    if (orgFilter === null) return { total: 0, groups: [] }
    const groups = ctx.connectorHub.permGroups().find((group) => (orgFilter === undefined || group.orgId === orgFilter))
    return { total: groups.length, groups }
  })

  guarded('POST', '/api/connector/perm-groups', 'connector.permgroup.write', async (exchange) => {
    const input = body<{ name: string; description?: string; orgId: string; policies: Record<string, { allowedActions: '*' | string[]; riskCap?: 'read' | 'write' | 'admin'; connections?: string[]; constraints?: { readOnly?: boolean; denyParams?: string[] } }>; subjects: Array<{ type: 'user_group' | 'agent' | 'app'; id: string; name?: string }>; rateLimitPerMin?: number; odd?: Record<string, unknown> }>(exchange)
    const createdGroup = await runWithOcErrors(exchange, () => ctx.connectorHub.createPermGroup({
      name: input.name,
      description: input.description,
      orgId: input.orgId,
      policies: input.policies,
      subjects: input.subjects,
      rateLimitPerMin: input.rateLimitPerMin,
      ...(input.odd !== undefined ? { odd: input.odd } : {}),
      // precheckCents 入参已废止（M0-2 billing 下线，OPT-P0-02）：legacy 记录字段运行时不读，新写请求不再透传
    }))
    if (!createdGroup) return // 错误响应已由处理器写出（如 invalid_alias_prefix 400）
    const group = createdGroup as Awaited<ReturnType<typeof ctx.connectorHub.createPermGroup>>
    changeLog(exchange, 'connector.permgroup.create', 'connector_perm_group', group.id, group.name)
    return group
  })

  guarded('PATCH', '/api/connector/perm-groups/:id', 'connector.permgroup.write', async (exchange) => {
    const updated = await runWithOcErrors(exchange, () => ctx.connectorHub.updatePermGroup(exchange.params['id']!, body(exchange)))
    if (!updated) return // 错误响应已由处理器写出
    const group = updated as Awaited<ReturnType<typeof ctx.connectorHub.updatePermGroup>>
    changeLog(exchange, 'connector.permgroup.update', 'connector_perm_group', group.id, group.name)
    return group
  })

  guarded('DELETE', '/api/connector/perm-groups/:id', 'connector.permgroup.write', (exchange) => {
    const removed = ctx.connectorHub.deletePermGroup(exchange.params['id']!)
    changeLog(exchange, 'connector.permgroup.delete', 'connector_perm_group', exchange.params['id']!, '')
    return { deleted: removed }
  })

  guarded('POST', '/api/connector/perm-groups/:id/impact', 'connector.connection.read', (exchange) => {
    return ctx.connectorHub.permGroupImpact(exchange.params['id']!)
  })

  // -- 运行日志 / 对账 / 台账 ---------------------------------------------------
  guarded('GET', '/api/connector/runs', 'connector.runs.read', async (exchange) => {
    return await runWithOcErrors(exchange, () => ctx.connectorHub.listRunsView({
      ...(exchange.query.get('service') ? { service: exchange.query.get('service')! } : {}),
      ...(exchange.query.get('ok') !== null ? { ok: exchange.query.get('ok') === 'true' } : {}),
      limit: Number(exchange.query.get('limit') ?? 100),
    }))
  })

  guarded('POST', '/api/connector/reconcile', 'connector.runs.read', async (exchange) => {
    const outcome = await runWithOcErrors(exchange, () => ctx.connectorHub.reconcileRuns())
    if (!outcome) return // 错误响应已由处理器写出
    const result = outcome as Awaited<ReturnType<typeof ctx.connectorHub.reconcileRuns>>
    changeLog(exchange, 'connector.reconcile.runs', 'connector_reconcile', 'runs', '', `checked=${result.checkedRuns} bypass=${result.bypassRuns.length}`)
    return result
  })

  guarded('GET', '/api/connector/tokens', 'connector.permgroup.write', (exchange) => {
    // 台账只读：永不返回 token 值（值仅创建时返回一次且平台不落盘）
    const ledgers = ctx.connectorHub.tokens().all().map((item) => ({
      permGroupId: item.permGroupId,
      ocTokenId: item.ocTokenId,
      policySnapshotHash: item.policySnapshotHash.slice(0, 12),
      createdAt: item.createdAt,
      lastSyncedAt: item.lastSyncedAt,
    }))
    return { total: ledgers.length, tokens: ledgers }
  })
}
