/**
 * NAS 文件资源适配器（§4.5/D.3：文件能力 ≠ 知识检索能力；逐动作授权）。
 *
 * 身份纪律（§4.5-1）：
 *   - 无人值守：岗位服务主体——actor.id 用 `agent:<agentId>`（含冒号，nasRegistry
 *     onBehalfHeaders 不产生 X-On-Behalf-User 头，不冒充真人权限）；
 *   - 人代办：args.onBehalfUser 仅在 work.requesterUserId 校验一致时透传
 *     （requesterUserId 由 port 层从 human 链服务端写入；缺失一律忽略并注释）。
 * 写入纪律（§4.5-2）：write 内容仅允许来自受控 artifact（args.artifactId →
 * workforceArtifacts 读受控 staging），禁止本地路径（args.localPath 出现即拒绝）。
 */
import { readFile } from 'node:fs/promises'
import type {
  AdapterInvokeInput,
  AdapterInvokeResult,
  AdapterProbeResult,
  ResourceAdapter,
  ArtifactRecord,
  WorkforceArtifacts,
} from '../contract.ts'
import type { IdentityResolution, ResourceGrantSpec } from '../contract.ts'
import { ARTIFACT_MAX_BYTES } from '../contract.ts'
import { t } from '../../../platform-i18n/src/index.ts'
import type { WorkExecutionContext } from '../../../platform-core/src/workforce-port.ts'

/** nasRegistry 结构化探测面（真实签名见 plugin-nas/src/index.ts NasRegistryService）。 */
interface NasRegistryProbe {
  get?: (id: string) => { id: string; name: string; status: string } | undefined
  listFiles?: (id: string, path?: string, actor?: { id: string; name: string }) => Promise<unknown>
  search?: (id: string, pattern: string, path?: string, actor?: { id: string; name: string }) => Promise<unknown>
  downloadFile?: (id: string, path: string, actor: { id: string; name: string }) => Promise<{ localFile: string; bytes: number; savedTo?: string }>
  uploadFile?: (id: string, input: { buffer?: Buffer; localFile?: string; destPath: string; actor: { id: string; name: string }; onBehalf?: boolean }) => Promise<{ path: string; sizeBytes: number }>
}

/** workforceArtifacts 结构化探测面（本插件服务，readBase64 真实签名）。 */
interface ArtifactsProbe {
  readBase64?: (caller: { kind: 'machine'; principalId: string; refType?: string; refId?: string }, artifactId: string) => Promise<string>
  get?: (caller: { kind: 'machine'; principalId: string; refType?: string; refId?: string }, artifactId: string) => Promise<ArtifactRecord>
}

const MACHINE_CALLER = (work: WorkExecutionContext) => ({
  kind: 'machine' as const,
  principalId: work.principalId,
  refType: 'agent',
  refId: work.agentId,
})

export function createNasAdapter(ctx: {
  nasRegistry?: NasRegistryProbe
  workforceArtifacts?: ArtifactsProbe
}): ResourceAdapter {
  const registry = (): NasRegistryProbe => ctx.nasRegistry ?? {}
  const artifacts = (): ArtifactsProbe => ctx.workforceArtifacts ?? {}

  const denied = (message: string, gatewayRef?: Record<string, unknown>): AdapterInvokeResult =>
    ({ ok: false, message, gatewayRef: { outcome: 'denied', ...gatewayRef } })

  /** pathPrefixes 业务范围复核（invocation 层校验 args.path，此处对全部路径参数再复核）。 */
  const assertPathScope = (tool: AdapterInvokeInput['tool'], path: string): string | null => {
    const prefixes = tool.constraints?.['pathPrefixes']
    if (!Array.isArray(prefixes) || prefixes.length === 0) return null
    if (prefixes.some((prefix) => typeof prefix === 'string' && path.startsWith(prefix))) return null
    return t('路径 {path} 超出授权目录范围', { path })
  }

  /** 人代办主体：仅当 work.requesterUserId 存在且与 args.onBehalfUser 一致才透传真人链。 */
  const actorFor = (work: WorkExecutionContext, args: Record<string, unknown>): { id: string; name: string; onBehalf: boolean } => {
    const requested = typeof args['onBehalfUser'] === 'string' ? args['onBehalfUser'] as string : ''
    // requesterUserId 缺失时忽略 onBehalfUser（防伪造真人链）；岗位服务主体不带身份头
    if (requested && work.requesterUserId && requested === work.requesterUserId) {
      return { id: work.requesterUserId, name: t('人代办:{id}', { id: work.employeeId }), onBehalf: true }
    }
    return { id: `agent:${work.agentId}`, name: t('数字员工:{id}', { id: work.employeeId }), onBehalf: false }
  }

  return {
    kind: 'nas',

    async probeGrant(spec: ResourceGrantSpec, _resolution: IdentityResolution): Promise<AdapterProbeResult> {
      const hub = registry()
      if (typeof hub.get !== 'function') {
        return { ok: false, message: t('nasRegistry 未提供资产查询能力') }
      }
      const nas = hub.get(spec.registryId)
      if (!nas) return { ok: false, message: t('NAS 资产不存在：{id}', { id: spec.registryId }) }
      const prefixes = spec.constraints?.['pathPrefixes']
      return {
        ok: true,
        ref: `nas-scope:${JSON.stringify(Array.isArray(prefixes) ? prefixes : [])}`,
      }
    },

    async invoke(input: AdapterInvokeInput): Promise<AdapterInvokeResult> {
      const hub = registry()
      const work = input.work
      const action = input.tool.action
      const actor = actorFor(work, input.args)
      const path = typeof input.args['path'] === 'string' ? input.args['path'] as string : '/'
      const pathDenial = assertPathScope(input.tool, path)
      if (pathDenial && action !== 'search' && action !== 'list') return denied(pathDenial)

      try {
        switch (action) {
          case 'read': {
            if (typeof hub.downloadFile !== 'function') return denied(t('nasRegistry 未提供文件下载能力，未支持'))
            const result = await hub.downloadFile(input.tool.registryId, path, actor)
            // 内容经受控 staging 读取回传（≤8MB 文本）；不向员工暴露平台本地路径
            let content: string | undefined
            if (result.bytes > 0 && result.bytes <= ARTIFACT_MAX_BYTES) {
              try {
                const buffer = await readFile(result.localFile)
                content = buffer.toString('utf8')
              } catch {
                content = undefined
              }
            }
            return {
              ok: true,
              ...(content !== undefined ? { content } : {}),
              value: {
                path,
                bytes: result.bytes,
                ...(content === undefined ? { note: t('内容超限或读取失败，已落平台受控 staging，请经 artifact 通道获取') } : {}),
              },
              gatewayRef: { nasId: input.tool.registryId, path, bytes: result.bytes, onBehalf: actor.onBehalf },
            }
          }
          case 'search': {
            if (typeof hub.search !== 'function') return denied(t('nasRegistry 未提供文件检索能力，未支持'))
            const pattern = typeof input.args['pattern'] === 'string' ? input.args['pattern'] as string : ''
            if (!pattern) return denied(t('检索缺少 pattern 参数'))
            const result = await hub.search(input.tool.registryId, pattern, path, actor)
            return { ok: true, value: result, gatewayRef: { nasId: input.tool.registryId, pattern, path, onBehalf: actor.onBehalf } }
          }
          case 'list': {
            if (typeof hub.listFiles !== 'function') return denied(t('nasRegistry 未提供目录列举能力，未支持'))
            const result = await hub.listFiles(input.tool.registryId, path, actor)
            return { ok: true, value: result, gatewayRef: { nasId: input.tool.registryId, path, onBehalf: actor.onBehalf } }
          }
          case 'write': {
            // 写入只认受控 artifact 来源（V15：员工调用面拒绝任意本地路径）
            if (typeof input.args['localPath'] === 'string' || typeof input.args['localFile'] === 'string') {
              return denied(t('禁止本地路径写入：write 内容仅允许来自受控 artifact'))
            }
            if (typeof hub.uploadFile !== 'function') return denied(t('nasRegistry 未提供文件上传能力，未支持'))
            const artifactId = typeof input.args['artifactId'] === 'string' ? input.args['artifactId'] as string : ''
            if (!artifactId) return denied(t('NAS 写入必须引用受控 artifact（args.artifactId）'))
            const probe = artifacts()
            if (typeof probe.get !== 'function' || typeof probe.readBase64 !== 'function') {
              return denied(t('workforceArtifacts 未就绪，无法读取受控 artifact'))
            }
            const caller = MACHINE_CALLER(work)
            const artifact = await probe.get(caller, artifactId)
            const base64 = await probe.readBase64(caller, artifactId)
            const destPath = path
            const result = await hub.uploadFile(input.tool.registryId, {
              buffer: Buffer.from(base64, 'base64'),
              destPath,
              actor,
              // 无人值守：岗位服务主体（不带 X-On-Behalf-User）；人代办：透传真人链
              onBehalf: actor.onBehalf ? true : false,
            })
            return {
              ok: true,
              value: { path: result.path, sizeBytes: result.sizeBytes, artifactId },
              gatewayRef: {
                nasId: input.tool.registryId,
                path: result.path,
                bytes: result.sizeBytes,
                sha256: artifact.sha256,
                onBehalf: actor.onBehalf,
                workRef: `${work.runId}/${input.invocationId}`,
              },
            }
          }
          case 'share':
            // 分享是独立权限动作（§4.5）；一期未开放（分享链接服务不在受控调用面）
            return denied(t('NAS 分享动作适配一期未开放（外发分享需独立授权与人工通道）'))
          default:
            return denied(t('未知 NAS 动作：{action}', { action }))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 写超时/网络不确定 → 结果未知（§11.5-4）
        const uncertain = action === 'write' && /超时|timeout|abort|ECONNRESET|ETIMEDOUT/i.test(message)
        return {
          ok: false,
          message,
          ...(uncertain ? { outcomeUnknown: true } : {}),
          gatewayRef: { nasId: input.tool.registryId, path, ...(uncertain ? { outcome: 'unknown' } : {}) },
        }
      }
    },
  }
}
