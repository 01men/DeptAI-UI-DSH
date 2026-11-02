/**
 * 资源适配器注册表（契约 AdapterRegistry；adapters/* 六个内建适配器在此装配）。
 *
 * 适配器职责：把受控调用映射到既有网关（mcpRegistry/connectorHub/modelGateway/
 * skillHub/nasRegistry），网关原有授权链一项不少（两层授权取交集，§9.5）；
 * 缺席能力返回未支持，不以空实现冒充成功。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {
  AdapterRegistry,
  ResourceAdapter,
  ResourceGrantSpec,
} from '../contract.ts'
import { createMcpAdapter } from './mcp.ts'
import { createConnectorAdapter } from './connector.ts'
import { createModelAdapter } from './model.ts'
import { createSkillAdapter } from './skill.ts'
import { createNasAdapter } from './nas.ts'
import { createAppAdapter } from './app.ts'

export class AdapterRegistryService extends Service implements AdapterRegistry {
  static readonly provide = 'workforceAdapters'

  private readonly adapters = new Map<ResourceGrantSpec['kind'], ResourceAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'workforceAdapters')
    // 六个内建适配器（ctx 以结构化探测面传入，适配器不依赖具体服务类；
    // 探测面形状即各适配器文件内的 Probe 接口——网关 additive 扩展由组4/5 落地）
    const probeCtx = ctx as unknown as {
      mcpRegistry?: Parameters<typeof createMcpAdapter>[0]['mcpRegistry']
      connectorHub?: Parameters<typeof createConnectorAdapter>[0]['connectorHub']
      modelGateway?: Parameters<typeof createModelAdapter>[0]['modelGateway']
      skillHub?: Parameters<typeof createSkillAdapter>[0]['skillHub']
      nasRegistry?: Parameters<typeof createNasAdapter>[0]['nasRegistry']
      workforceArtifacts?: Parameters<typeof createNasAdapter>[0]['workforceArtifacts']
    }
    for (const adapter of [
      createMcpAdapter({ mcpRegistry: probeCtx.mcpRegistry }),
      createConnectorAdapter({ connectorHub: probeCtx.connectorHub }),
      createModelAdapter({ modelGateway: probeCtx.modelGateway }),
      createSkillAdapter({ skillHub: probeCtx.skillHub }),
      createNasAdapter({ nasRegistry: probeCtx.nasRegistry, workforceArtifacts: probeCtx.workforceArtifacts }),
      createAppAdapter(ctx),
    ]) {
      this.register(adapter)
    }
  }

  get(kind: ResourceGrantSpec['kind']): ResourceAdapter | undefined {
    return this.adapters.get(kind)
  }

  register(adapter: ResourceAdapter): void {
    this.adapters.set(adapter.kind, adapter)
  }
}
