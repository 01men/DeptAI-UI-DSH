/**
 * modelgw 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'

export const name = 'modelgw-tools'
export const inject = ['tools', 'modelGateway']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'model_list',
    description: '列出模型网关目录（接入模型、内部成本参考与状态）。',
    permission: 'modelgw.read',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      const models = ctx.modelGateway.models().all()
      return {
        total: models.length,
        models: models.map((item) => ({
          slug: item.slug, provider: item.provider, status: item.status,
          costCentsPerKTokens: item.costCentsPerKTokens, configured: item.endpoint !== '',
        })),
      }
    },
  }))
}
