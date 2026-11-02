/**
 * 能力清单服务（实施路径 §8.1/§9.2，附录 A 决策 5）。
 *
 * 清单只下发任务允许的工具句柄（`<registryId>.<action>`）；运行时只能引用句柄，
 * 不能自带资源键。未知风险工具默认不得作写能力开放；参数约束（parameters schema）
 * 由调用层服务端执行（invocation-service），不依赖提示词。
 *
 * skill 授权 → skillPins（固定版本 + 内容摘要，组5 resolveSkillPin 结构化探测，
 * 缺失则 build 抛错使 activate 失败——fail-closed），同时生成一个 `.load` 句柄
 * 供运行时经 workforce_invoke 加载固定版本文本（§4.4 指令型技能，绝不执行程序）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  WorkforceError,
  type AppointmentRecord,
  type ManifestRecord,
  type ManifestToolHandle,
  type ResourceGrantRecord,
  type SkillPin,
  type WorkforceCapabilities,
  type WorkforceStore,
} from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'

/** NAS 动作级风险映射（§4.5：知识读取与向外分享必须是不同权限）。 */
const NAS_WRITE_ACTIONS = new Set(['write', 'share'])

function parseJson<T>(text: string, fallback: T): T {
  try {
    const value = JSON.parse(text) as T
    return value ?? fallback
  } catch {
    return fallback
  }
}

export class CapabilityManifestService extends Service implements WorkforceCapabilities {
  static readonly provide = 'workforceCapabilities'

  constructor(ctx: Context) {
    super(ctx, 'workforceCapabilities')
  }

  private get store(): WorkforceStore {
    const store = (this.ctx as unknown as { workforceStore?: WorkforceStore }).workforceStore
    if (!store || typeof store.txn !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceStore 未就绪（迁移未完成）'), 503)
    }
    return store
  }

  /** skillHub 版本锁定能力探针（组5 additive：resolveSkillPin(skillId, version?)）。 */
  private resolveSkillPin(skillId: string, version?: string): SkillPin {
    const skillHub = (this.ctx as unknown as {
      skillHub?: { resolveSkillPin?: (skillId: string, version?: string) => SkillPin }
    }).skillHub
    if (!skillHub || typeof skillHub.resolveSkillPin !== 'function') {
      // fail-closed：无版本锁定能力不得激活任用（§4.4/D09——安装不等于可核验的加载）
      throw new Error(t('skillHub 未提供版本锁定能力，任用无法激活'))
    }
    return skillHub.resolveSkillPin(skillId, version)
  }

  // -- 构建 -------------------------------------------------------------

  buildForAppointment(appointmentId: string): ManifestRecord {
    const store = this.store
    const appointment = store.appointments.get(appointmentId)
    if (!appointment) throw new WorkforceError('APPOINTMENT_NOT_EFFECTIVE', t('任用不存在：{id}', { id: appointmentId }))
    // 只消费已生效授权（探针通过回填 ref）；preparing/failed 授权不产生句柄
    const grants = store.grants.findWhere({ appointmentId }).filter((grant) => grant.status === 'effective')

    const tools: ManifestToolHandle[] = []
    const skillPins: SkillPin[] = []
    for (const grant of grants) {
      const actions = parseJson<string[]>(grant.actionsJson, [])
      const constraints = parseJson<Record<string, unknown>>(grant.constraintsJson, {})
      if (grant.kind === 'skill') {
        // skill：固定版本锁定（版本可由 grant.constraints.version 指定，缺省取当前发布版）
        const pin = this.resolveSkillPin(grant.registryId, typeof constraints['version'] === 'string' ? constraints['version'] as string : undefined)
        skillPins.push(pin)
        // 同时下发一个加载句柄（§4.4 指令型：加载固定版本文本，不执行程序）
        tools.push({
          handle: `${grant.registryId}.load`,
          kind: 'skill',
          resourceRef: `skill:${grant.registryId}`,
          registryId: grant.registryId,
          action: 'load',
          risk: 'read',
          constraints: { version: pin.version, contentHash: pin.contentHash },
          description: t('加载技能 {skillId} 固定版本 {version} 的指令文本（不执行程序）', { skillId: grant.registryId, version: pin.version }),
        })
        continue
      }
      if (grant.kind === 'model') {
        // 模型：单句柄 invoke；allowedModels 约束随句柄下发并在 port/adapter 双侧校验
        tools.push({
          handle: `${grant.registryId}.invoke`,
          kind: 'model',
          resourceRef: `model:${grant.registryId}`,
          registryId: grant.registryId,
          action: 'invoke',
          risk: grant.risk,
          constraints,
          description: t('调用模型 {modelId}（密级与预算经模型网关原有链路）', { modelId: grant.registryId }),
        })
        continue
      }
      if (grant.kind === 'nas') {
        // NAS：逐动作句柄（read/search/list/write/share 风险分级）
        for (const action of actions) {
          const risk = NAS_WRITE_ACTIONS.has(action) ? (grant.risk === 'admin' ? 'admin' : 'write') : 'read'
          tools.push({
            handle: `${grant.registryId}.${action}`,
            kind: 'nas',
            resourceRef: `nas:${grant.registryId}`,
            registryId: grant.registryId,
            action,
            risk,
            constraints,
            description: t('NAS 文件动作 {action}（目录范围约束服务端执行）', { action }),
          })
        }
        continue
      }
      // mcp / connector / app：逐动作句柄
      for (const action of actions) {
        tools.push({
          handle: `${grant.registryId}.${action}`,
          kind: grant.kind,
          resourceRef: `${grant.kind}:${grant.registryId}`,
          registryId: grant.registryId,
          action,
          risk: grant.risk,
          constraints,
        })
      }
    }

    return store.txn(() => {
      const existing = store.manifests.findWhere({ appointmentId })
      const version = existing.reduce((max, item) => Math.max(max, item.version), 0) + 1
      // 旧 active 清单 retired（版本滚动：调岗/授权升级后旧句柄不再可用）
      for (const item of existing.filter((manifest) => manifest.status === 'active')) {
        store.manifests.update(item.id, { status: 'retired' })
      }
      return store.manifests.insert({
        id: `wfmanifest_${appointmentId}_v${version}`,
        appointmentId,
        version,
        toolsJson: JSON.stringify(tools),
        skillPinsJson: JSON.stringify(skillPins),
        status: 'active',
        createdAt: new Date().toISOString(),
      })
    })
  }

  // -- 查询 -------------------------------------------------------------

  get(manifestId: string): ManifestRecord {
    const manifest = this.store.manifests.get(manifestId)
    if (!manifest) throw new WorkforceError('TOOL_UNKNOWN', t('能力清单不存在：{id}', { id: manifestId }), 404)
    return manifest
  }

  activeForAppointment(appointmentId: string): ManifestRecord | undefined {
    return this.store.manifests.findWhere({ appointmentId })
      .filter((manifest) => manifest.status === 'active')
      .sort((a, b) => b.version - a.version)[0]
  }

  toolsFor(manifestId: string): ManifestToolHandle[] {
    return parseJson<ManifestToolHandle[]>(this.get(manifestId).toolsJson, [])
  }

  /** 句柄解析：handle 形如 `<registryId>.<action>`，kind/registryId/action 全匹配才算命中（§9.2）。 */
  resolveTool(manifestId: string, handle: string): ManifestToolHandle | undefined {
    return this.toolsFor(manifestId).find((tool) => tool.handle === handle
      && `${tool.registryId}.${tool.action}` === handle)
  }

  /** 任用当前生效记录（admission 组合校验用）。 */
  appointmentOf(appointmentId: string): AppointmentRecord | undefined {
    return this.store.appointments.get(appointmentId)
  }

  /** grant 读取（probe 回填 ref 由 appointment-service 消费，此处供诊断）。 */
  grantsFor(appointmentId: string): ResourceGrantRecord[] {
    return this.store.grants.findWhere({ appointmentId })
  }
}
