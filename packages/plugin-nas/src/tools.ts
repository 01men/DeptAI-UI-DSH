/**
 * nas 插件对模型暴露的工具（dsh ToolRuntime / REST 工具桥 / MCP /mcp 端点同一契约）。
 * 读类操作需 nas.read；写类操作需 nas.write（工具级权限点在网关统一校验）。
 *
 * 数字员工工作面（D12/D15，蓝本 §4.5、验收 V14/V15）：
 *   - 受管判定只按可信 caller 反查（gateManagedWork）：读类（list/search）过 risk='read' gate，
 *     写类（mkdir/delete/upload）过 risk='write' gate；拒绝为中文原因 + 领域 code。
 *   - gate 放行不跳过原有文件网关授权：目录约束仍由 NasAuthzService/文件网关执行（两层交集）。
 *   - 受管放行者的 nas_fs_upload 仅允许 workforce staging 目录（D12 白名单），其余路径
 *     中文拒绝（ARTIFACT_SCOPE_DENIED）并引导走 POST /api/workforce/artifacts。
 */
import { resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'
import { t as translate } from '../../platform-i18n/src/index.ts'
import { WORK_DENY_CODE_LABELS, gateManagedWork, type WorkCallerRef, type WorkforcePolicyRegistry } from '../../platform-core/src/workforce-port.ts'
import { WORKFORCE_ARTIFACTS_ROOT } from './index.ts'

export const name = 'nas-tools'
export const inject = ['tools', 'nasRegistry', 'workforcePolicy']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'nas_list',
    description: '列出纳管的 NAS（FS 文件存储）资产（含健康状态与生命周期）。',
    permission: 'nas.read',
    parameters: {
      status: { type: 'string', enum: ['draft', 'online', 'offline', 'archived'], description: '按状态过滤' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const items = ctx.nasRegistry.list(args.status ? { status: String(args.status) } : undefined)
      return {
        total: items.length,
        items: items.map((nas) => ({
          id: nas.id, name: nas.name, slug: nas.slug, status: nas.status,
          gateway: nas.attrs['gatewayUrl'], nasIp: nas.attrs['nasIp'], rootPath: nas.attrs['rootPath'],
          health: ctx.nasRegistry.healthOf(nas.id).status,
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'nas_get',
    description: '查看 NAS 资产详情（接入信息脱敏、健康、网关工具面）。',
    permission: 'nas.read',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const nas = ctx.nasRegistry.get(String(args.nasId))
      if (!nas) throw new Error(translate('NAS 资产不存在：{id}', { id: String(args.nasId) }))
      return {
        id: nas.id, name: nas.name, slug: nas.slug, status: nas.status,
        attrs: { ...nas.attrs, accessToken: mask(String(nas.attrs['accessToken'] ?? '')) },
        health: ctx.nasRegistry.healthOf(nas.id),
        gatewayTools: ctx.nasRegistry.toolsOf(nas.id).map((tool) => tool.name),
        availableTransitions: nas.status,
      }
    },
  }))

  t.register(defineTool({
    name: 'nas_health_check',
    description: '对 NAS 网关执行一次健康探测（MCP initialize 握手，返回延迟与状态）。',
    permission: 'nas.read',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return await ctx.nasRegistry.probe(String(args.nasId))
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_list',
    description: '列出 NAS 共享目录或指定路径下的文件（fs_list / fs_list_shares）。path 省略时列出全部共享。',
    permission: 'nas.read',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      path: { type: 'string', description: '绝对路径 /<共享名>/子路径；省略列出共享' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const nasId = String(args.nasId)
      const path = args.path === undefined || args.path === '' ? undefined : String(args.path)
      await gateNasWork(ctx, exec, nasId, 'read')
      return path === undefined
        ? await ctx.nasRegistry.listShares(nasId, actorOf(args, exec, ctx))
        : await ctx.nasRegistry.listFiles(nasId, path, actorOf(args, exec, ctx))
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_search',
    description: '在 NAS 指定路径下按关键字/通配符检索文件（fs_search）。',
    permission: 'nas.read',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      pattern: { type: 'string', required: true, description: '检索关键字或通配符' },
      path: { type: 'string', description: '起始路径（默认根 /）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const nasId = String(args.nasId)
      await gateNasWork(ctx, exec, nasId, 'read')
      return await ctx.nasRegistry.search(nasId, String(args.pattern), args.path ? String(args.path) : '/', actorOf(args, exec, ctx))
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_mkdir',
    description: '在 NAS 上创建目录（fs_create_folder），写操作审计留痕。',
    permission: 'nas.write',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      path: { type: 'string', required: true, description: '目标目录绝对路径' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const nasId = String(args.nasId)
      await gateNasWork(ctx, exec, nasId, 'write')
      return await ctx.nasRegistry.mkdir(nasId, String(args.path), actorOf(args, exec, ctx))
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_delete',
    description: '删除 NAS 上的文件或目录（fs_delete，可批量），写操作审计留痕。',
    permission: 'nas.write',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      paths: { type: 'array', items: { type: 'string' }, required: true, description: '目标绝对路径数组' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const nasId = String(args.nasId)
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [String(args.paths)]
      await gateNasWork(ctx, exec, nasId, 'write')
      return await ctx.nasRegistry.delete(nasId, paths, actorOf(args, exec, ctx))
    },
  }))

  t.register(defineTool({
    name: 'nas_fs_upload',
    description: '上传文件到 NAS（平台侧本地路径 → staging → 网关 fs_upload）。受管数字员工仅允许从 workforce 受控 artifact 区取文件，其余本地路径拒绝。',
    permission: 'nas.write',
    parameters: {
      nasId: { type: 'string', required: true, description: 'NAS 资产 ID' },
      localFile: { type: 'string', required: true, description: '平台侧可访问的本地文件绝对路径' },
      destPath: { type: 'string', required: true, description: 'NAS 目标绝对路径 /<共享名>/…/文件名' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args, exec) {
      const nasId = String(args.nasId)
      // D12/V15：受管数字员工（可信 caller 反查命中）过写类 gate 后，localFile 仍禁止任意平台路径
      // ——仅允许 workforce 受控 staging（WORKFORCE_ARTIFACTS_ROOT 前缀），引导走受控上传接口；
      // 真人管理员/legacy 路径保持现状（gate 未命中即不收紧）。
      const gate = await gateNasWork(ctx, exec, nasId, 'write')
      const localFile = String(args.localFile)
      if (gate === 'managed') {
        const candidate = resolve(localFile)
        if (candidate !== WORKFORCE_ARTIFACTS_ROOT && !candidate.startsWith(`${WORKFORCE_ARTIFACTS_ROOT}${sep}`)) {
          throw new Error(
            translate('上传被拒绝（ARTIFACT_SCOPE_DENIED）：受管数字员工禁止读取平台任意本地路径，localFile 仅允许 workforce 受控目录（{root}…）；请改走 POST /api/workforce/artifacts 受控上传后引用 artifact ID',
              { root: `${WORKFORCE_ARTIFACTS_ROOT}${sep}` }),
          )
        }
      }
      return await ctx.nasRegistry.uploadFile(nasId, {
        localFile,
        destPath: String(args.destPath),
        actor: actorOf(args, exec, ctx),
      })
    },
  }))
}

/**
 * 文件类工具的操作人（计量 subject 与审计 actor 共用）。
 * P0-2 教训（dev-plan-nas-authz §2.3）：身份一律来自入口从令牌解析的 exec.principal，
 * 禁止从 args 读取（schema 无身份参数）——缺失即 fail-closed，不降级到共享身份。
 *
 * D15 精确会话绑定：
 *   - dsh 形态（identityBinding 存在）：只认当前会话的显式绑定（bySession 命中）；
 *     无会话上下文 / 会话未绑定 / 绑定服务无法核验 → 一律中文拒绝，
 *     禁止回落「最近一次绑定」（多员工并发不串身份、不冒充他人）。
 *   - 独立形态（无 identityBinding）：行为不变（exec.principal 身份）；
 *     机器 principal 标注 kind:'machine'——onBehalfHeaders 据此绝不注入 X-On-Behalf-User；
 *     仅当 actChain 真人终点可被现有验证逻辑（IAM 反查）核验时，才以该真人作操作者。
 */
type NasToolActor = { id: string; name: string; kind: 'human' | 'machine' }

interface NasExecContext {
  callId: string
  principal?: {
    kind?: string
    userId?: string
    principalId: string
    name: string
    actChain?: Array<{ name: string; type: string; principalId?: string; userId?: string }>
  }
  agent?: { session?: { id?: string } }
}

interface NasIdentityBindingLike {
  identityForSession(sessionId?: string): { userId: string; name: string } | undefined
  /** dsh-bridge 内部会话绑定表（只读探测用）：sessionId → userId。 */
  bySession?: Map<string, string>
}

function actorOf(
  args: Record<string, unknown>,
  exec: NasExecContext,
  ctx?: Context,
): NasToolActor {
  void args
  // dsh 宿主形态（plugin-dsh-bridge 装配）：平台身份绑定优先——但只认「当前会话的显式绑定」。
  // 独立形态无 identityBinding 服务，行为不变（exec.principal 机器身份）。
  const binding = (ctx as { identityBinding?: NasIdentityBindingLike } | undefined)?.identityBinding
  if (binding) {
    const sessionId = exec.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error(translate('文件操作被拒绝：当前调用未携带已显式绑定平台身份的 dsh 会话（D15 精确会话绑定，禁止回落「最近一次绑定」）；请先在工作台完成身份绑定后重试'))
    }
    const identity = sessionBoundIdentity(binding, sessionId)
    if (!identity) {
      throw new Error(translate('文件操作被拒绝：当前会话未显式绑定平台身份（D15 禁止按「最近一次绑定」回落执行），请重新完成身份绑定后再试'))
    }
    return { id: identity.userId, name: identity.name, kind: 'human' }
  }
  const principal = exec.principal
  if (!principal) throw new Error(translate('缺少调用者身份（exec.principal），文件操作 fail-closed 拒绝执行'))
  if (principal.kind === 'human') {
    return { id: principal.userId ?? principal.principalId, name: principal.name, kind: 'human' }
  }
  // 机器 principal：绝不把机器 ID 当真人；仅当 OBO 代理链确有已验证真人终点、
  // 且其身份可解析（后续仍要过 onBehalfHeaders 的 IAM 反查认可）时，才以该真人作操作者。
  const human = humanDelegatorOf(principal, ctx)
  if (human) return { id: human.id, name: human.name, kind: 'human' }
  return { id: principal.userId ?? principal.principalId, name: principal.name, kind: 'machine' }
}

/**
 * dsh 会话精确绑定核验（D15）：只认 bySession 中登记的当前会话，并要求
 * identityForSession 返回的就是该绑定用户——「最近一次绑定」（current）回落一律不可信。
 * 绑定服务内部结构变化导致无法核验时按未绑定处理（fail-closed，不静默降级）。
 */
function sessionBoundIdentity(binding: NasIdentityBindingLike, sessionId: string): { userId: string; name: string } | undefined {
  const sessions = binding.bySession
  if (!(sessions instanceof Map)) return undefined
  const boundUserId = sessions.get(sessionId)
  if (!boundUserId) return undefined
  const identity = binding.identityForSession(sessionId)
  return identity && identity.userId === boundUserId ? identity : undefined
}

/**
 * OBO 代理链真人终点解析（D15）：从链尾向链头找最近一条真人条目，解析其平台用户 ID
 * （authn principal 反查 refId；条目自带 userId 时直接采用）。解析不到即返回 undefined
 * ——机器调用保持 machine 归因，绝不冒充真人。
 */
function humanDelegatorOf(
  principal: NonNullable<NasExecContext['principal']>,
  ctx?: Context,
): { id: string; name: string } | undefined {
  const chain = Array.isArray(principal.actChain) ? principal.actChain : []
  for (let index = chain.length - 1; index >= 0; index--) {
    const entry = chain[index]
    if (!entry || entry.type !== 'human') continue
    if (typeof entry.userId === 'string' && entry.userId !== '') {
      return { id: entry.userId, name: entry.name || entry.userId }
    }
    const principalId = typeof entry.principalId === 'string' ? entry.principalId : ''
    if (!principalId) continue
    try {
      const authn = (ctx as { authn?: { principals(): Map<string, { refId?: string; name?: string }> } } | undefined)?.authn
      const record = authn?.principals().get(principalId)
      const userId = record?.refId
      if (userId) return { id: userId, name: entry.name || record?.name || userId }
    } catch { /* 独立宿主无 authn：不认可该真人条目 */ }
  }
  return undefined
}

/**
 * 受管数字员工工作级准入（D12/D15/附录 D.5）：受管判定只按可信 caller 反查（exec.principal），
 * 与请求参数无关。denied → 中文拒绝（带领域 code）；legacy → 返回 'legacy' 原链照走；
 * managed → 返回 'managed'（调用方可继续追加受管专属约束，如 D12 上传白名单）。
 * 注意：gate 放行不跳过文件网关原有授权——目录约束仍由 NasAuthzService/网关执行。
 */
async function gateNasWork(
  ctx: Context,
  exec: NasExecContext,
  nasId: string,
  risk: 'read' | 'write',
): Promise<'legacy' | 'managed'> {
  const registry = (ctx as { workforcePolicy?: WorkforcePolicyRegistry } | undefined)?.workforcePolicy
  const caller = workCallerOf(exec, ctx)
  const gate = await gateManagedWork(registry, caller, {
    facts: { kind: 'nas', registryId: nasId, action: risk, risk },
  })
  if (gate.mode === 'denied') {
    throw new Error(`${WORK_DENY_CODE_LABELS[gate.code]}（${gate.code}）：${gate.message}`)
  }
  return gate.mode
}

/** exec.principal → 已验证工作调用者引用（只带服务端已核验字段；机器侧尽力补 refType/refId 供反查）。 */
function workCallerOf(exec: NasExecContext, ctx?: Context): WorkCallerRef | undefined {
  const principal = exec.principal
  if (!principal) return undefined
  if (principal.kind === 'human') {
    return {
      kind: 'human',
      principalId: principal.principalId,
      ...(principal.userId ? { userId: principal.userId } : {}),
      name: principal.name,
    }
  }
  let refType: string | undefined
  let refId: string | undefined
  try {
    const authn = (ctx as { authn?: { principals(): Map<string, { refType?: string; refId?: string }> } } | undefined)?.authn
    const record = authn?.principals().get(principal.principalId)
    if (record?.refType && record?.refId) {
      refType = record.refType
      refId = record.refId
    }
  } catch { /* 独立宿主无 authn：交由 workforce 端口按 principalId 反查 */ }
  return {
    kind: 'machine',
    principalId: principal.principalId,
    ...(refType ? { refType } : {}),
    ...(refId ? { refId } : {}),
    name: principal.name,
  }
}

function mask(token: string): string {
  if (!token) return ''
  return token.length > 8 ? `${token.slice(0, 6)}…` : '****'
}
