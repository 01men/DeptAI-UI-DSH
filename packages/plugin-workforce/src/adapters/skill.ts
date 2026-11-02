/**
 * Skill 资源适配器（§4.4 分型：指令/方法技能＝加载固定版本文本，绝不执行任意程序）。
 *
 * probeGrant：skillPins 版本锁定证据（版本 + 内容摘要，capability-manifest 经
 * skillHub.resolveSkillPin 固定；此处核验 skillHub 探测能力在位）。
 * invoke：结构化探测 skillHub.download(skillId, version, user)（真实签名，返回已发布
 * 版本 { content }）→ 返回文本内容 + 版本/摘要证据；程序/脚本型技能一期不支持，
 * 缺失能力诚实报未支持，不以空实现冒充成功。
 */
import { createHash } from 'node:crypto'
import { t } from '../../../platform-i18n/src/index.ts'
import type {
  AdapterInvokeInput,
  AdapterInvokeResult,
  AdapterProbeResult,
  ResourceAdapter,
} from '../contract.ts'
import type { IdentityResolution, ResourceGrantSpec } from '../contract.ts'

/** skillHub 结构化探测面（真实签名见 plugin-skillhub/src/index.ts SkillHubService）。 */
interface SkillHubProbe {
  download?: (skillId: string, version: string, user: { id: string; name: string }) => { content: string }
  resolveSkillPin?: (skillId: string, version?: string) => { skillId: string; version: string; contentHash: string }
}

export function createSkillAdapter(ctx: {
  skillHub?: SkillHubProbe
}): ResourceAdapter {
  const hub = (): SkillHubProbe => ctx.skillHub ?? {}

  return {
    kind: 'skill',

    async probeGrant(spec: ResourceGrantSpec, _resolution: IdentityResolution): Promise<AdapterProbeResult> {
      const probe = hub()
      if (typeof probe.resolveSkillPin !== 'function') {
        return { ok: false, message: t('skillHub 未提供版本锁定能力（resolveSkillPin 缺席）') }
      }
      try {
        const version = typeof spec.constraints?.['version'] === 'string' ? spec.constraints['version'] as string : undefined
        const pin = probe.resolveSkillPin(spec.registryId, version)
        if (!pin || !pin.version) return { ok: false, message: t('技能 {skillId} 无法锁定发布版本', { skillId: spec.registryId }) }
        // ref＝版本 + 摘要证据（D.3：固定版本与摘要、加载证明）
        return { ok: true, ref: `skill:${spec.registryId}@${pin.version} sha256:${String(pin.contentHash).slice(0, 16)}` }
      } catch (error) {
        return { ok: false, message: t('技能版本锁定失败：{message}', { message: error instanceof Error ? error.message : String(error) }) }
      }
    },

    async invoke(input: AdapterInvokeInput): Promise<AdapterInvokeResult> {
      const probe = hub()
      if (typeof probe.download !== 'function') {
        return { ok: false, message: t('skillHub 未提供固定版本文本读取能力（download 缺席），未支持'), gatewayRef: { outcome: 'denied' } }
      }
      const constraints = input.tool.constraints ?? {}
      const version = typeof constraints['version'] === 'string' ? constraints['version'] : ''
      if (!version) {
        return { ok: false, message: t('能力清单未锁定技能版本，拒绝加载'), gatewayRef: { outcome: 'denied' } }
      }
      try {
        const { content } = probe.download(input.tool.registryId, version, {
          id: input.work.agentId || input.work.principalId,
          name: t('数字员工:{id}', { id: input.work.employeeId }),
        })
        const contentHash = createHash('sha256').update(content).digest('hex')
        // 摘要核验（§4.4：加载证据——实际加载内容必须与版本锁定一致）
        const pinnedHash = typeof constraints['contentHash'] === 'string' ? constraints['contentHash'] : ''
        if (pinnedHash && pinnedHash !== contentHash) {
          return {
            ok: false,
            message: t('技能内容摘要与版本锁定不一致（pin={pinned} 实际={actual}），拒绝加载', { pinned: pinnedHash.slice(0, 16), actual: contentHash.slice(0, 16) }),
            gatewayRef: { outcome: 'denied', skillId: input.tool.registryId, version },
          }
        }
        // 指令/工具组合型：只回传文本内容（作为指令素材），绝不执行任意程序
        return {
          ok: true,
          content,
          value: { skillId: input.tool.registryId, version, content },
          gatewayRef: { skillId: input.tool.registryId, version, contentHash, workRef: `${input.work.runId}/${input.invocationId}` },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, message: t('技能文本加载失败：{message}', { message }), gatewayRef: { skillId: input.tool.registryId, version, outcome: 'denied' } }
      }
    },
  }
}
