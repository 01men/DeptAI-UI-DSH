/**
 * plugin-workforce —— 数字员工域装配入口。
 *
 * 职责三分（实施路径 §3.1，不复制三套身份系统）：
 *   - 本插件：员工档案、任用版本、运行绑定、能力清单、permit、受控调用账本、交付验收；
 *   - exec-hub：目标/项目/任务/run 与执行租约（经 ExecHubWorkIntegration 集成端口消费）；
 *   - 各资源网关：实际资源调用与原有授权链（经 adapters 复用，不重写）。
 *
 * 防循环装配（§10.2）：本插件在既有基础服务之后装配；对外的唯一横切面是
 * platform-core 的窄端口（ctx.workforcePolicy，apply 即存在）——本插件 ready 后
 * register() 登记实现；exec-hub 与资源网关仅依赖端口类型，不反向依赖本插件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { WorkforceStoreService } from './repositories.ts'
import { EmployeeService } from './employee-service.ts'
import { AppointmentService } from './appointment-service.ts'
import { IdentityResolverService } from './identity-resolver.ts'
import { AdmissionService } from './admission-service.ts'
import { PermitService } from './permit-service.ts'
import { CapabilityManifestService } from './capability-manifest.ts'
import { InvocationService } from './invocation-service.ts'
import { ArtifactService } from './artifact-service.ts'
import { DeliveryService } from './acceptance-service.ts'
import { MaintenanceService } from './maintenance-service.ts'
import { AdapterRegistryService } from './adapters/index.ts'
import { createWorkforcePolicyPort } from './port.ts'
import { registerWorkforceTools } from './tools.ts'
import { registerWorkforceRoutes } from './routes.ts'
import type { WorkforceGrayConfig } from './contract.ts'

export * from './contract.ts'

export interface WorkforceConfig extends WorkforceGrayConfig {
  /** 数据目录（artifact staging 与 SQLite 同底座）；默认 <cwd>/data。 */
  dataDir?: string
  /** permit 默认有效期（毫秒），默认 30 分钟。 */
  permitTtlMs?: number
  /** 租约默认有效期（毫秒），默认 15 分钟。 */
  leaseTtlMs?: number
}

export const name = 'workforce'

// 提供者均在本插件之前装配（boot-all.ts / cordis.yml 同序）：基础层→网关→agent→exec-hub→workforce
export const inject = [
  'httpServer', 'opsStorage', 'platformBus', 'iam', 'authn', 'audit', 'txnStore', 'usage',
  'resourceCore', 'agentRegistry', 'mcpRegistry', 'connectorHub', 'modelGateway', 'skillHub', 'nasRegistry',
  'execHub', 'tools', 'workforcePolicy',
]

export async function apply(ctx: Context, config: WorkforceConfig = {}) {
  // 服务直构（与 plugin-mcp/plugin-connector 同形态）：new Service(ctx) 把 provide 登记进
  // 本插件自身 fiber——apply 内的端口/工具/路由得以同步读取同插件服务键（ctx.plugin(类) 会
  // 产生独立子 fiber，同插件键未经 inject 声明不可见，且 await 挂载不保证子 apply 时序）。
  // 构造序即依赖序：adapters 构造期即读 workforceArtifacts 探测面，故 artifacts 先于 adapters。
  // 1. 权威存储迁移（幂等建表：WORKFORCE_TABLES）
  new WorkforceStoreService(ctx, config)
  // 2. 员工域服务（服务间依赖经 ctx 惰性解析——各服务 getter 在请求期读取，无构造顺序耦合）
  new EmployeeService(ctx)
  new AppointmentService(ctx)
  new IdentityResolverService(ctx)
  new PermitService(ctx)
  new CapabilityManifestService(ctx)
  new ArtifactService(ctx, config)
  new AdapterRegistryService(ctx)
  new InvocationService(ctx)
  new DeliveryService(ctx)
  // 灰度开关（W7 契约 D-②）：admission 构造接收灰度配置，认领/续租入口按组织拒绝
  new AdmissionService(ctx, config)
  // 台账维护（W5 运维面 D-③）：过期 permit 落账 + 终态 run 盘点（封存不删行）；
  // 构造期起定时巡检（env 可停用），REST /api/workforce/admin/maintenance/run 手动触发
  new MaintenanceService(ctx)
  // 3. 登记窄端口实现（platform-core 登记器）：本插件 fiber 已持有全部同插件服务，同步登记
  //    （灰度配置随端口进入 authorizeWorkAction：关闭组织在工作级授权入口显式拒绝）
  ctx.workforcePolicy.register(createWorkforcePolicyPort(ctx, config))
  // 4. 运行时薄工具（workforce_claim/invoke/renew/submit；身份取 exec.principal，禁止 args 传入）
  registerWorkforceTools(ctx)
  // 5. REST 工作面（/api/workforce/*，guarded 路由依赖 console 中间件先行）
  registerWorkforceRoutes(ctx)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workforceStore: WorkforceStoreService
    workforceEmployees: EmployeeService
    workforceAppointments: AppointmentService
    workforceIdentity: IdentityResolverService
    workforceAdmission: AdmissionService
    workforcePermits: PermitService
    workforceCapabilities: CapabilityManifestService
    workforceInvocations: InvocationService
    workforceArtifacts: ArtifactService
    workforceDelivery: DeliveryService
    workforceAdapters: AdapterRegistryService
    workforceMaintenance: MaintenanceService
  }
}
