/**
 * 插件树组装：按依赖顺序挂载全部平台插件。
 * 这棵树等价于 cordis.yml 在完整 dsh 中加载的内容——一份插件代码，两种宿主。
 */
import type { Context } from '@deepseek-ai/cordis'
import * as platformCore from '@dsh-ops/platform-core'
import * as resourceCore from '@dsh-ops/plugin-resource-core'
import * as iam from '@dsh-ops/plugin-iam'
import * as authn from '@dsh-ops/plugin-authn'
import * as usage from '@dsh-ops/plugin-usage'
// plugin-billing 已下线封存（M0-2，2026-09-09）：钱包/复式分账功能面退出运行时，
// 存量流水经 scripts/billing-archive-export.mjs 导出 CSV 只读封存 90 天（见 docs/billing-archive-register.md）。
import * as audit from '@dsh-ops/plugin-audit'
import * as market from '@dsh-ops/plugin-market'
import * as connector from '@dsh-ops/plugin-connector'
import * as modelgw from '@dsh-ops/plugin-modelgw'
import * as mcp from '@dsh-ops/plugin-mcp'
import * as nas from '@dsh-ops/plugin-nas'
import * as skillhub from '@dsh-ops/plugin-skillhub'
import * as agent from '@dsh-ops/plugin-agent'
import * as app from '@dsh-ops/plugin-app'
import * as connect from '@dsh-ops/plugin-connect'
import * as update from '@dsh-ops/plugin-update'
import * as portal from '@dsh-ops/plugin-portal'
import * as consolePlugin from '@dsh-ops/plugin-console'
import * as panelCore from '@ybkk/plugin-panel-core'
import * as flowCore from '@dsh-ops/plugin-flow-core'
import * as execHub from '@dsh-ops/plugin-exec-hub'
import * as workforce from '@dsh-ops/plugin-workforce'
import * as dingtalkBridge from '@ybkk/plugin-dingtalk-bridge'
// 企业数字员工内网协作（A2A/UHP，协作方案 §4/§11）：UHP 执行驱动层（Server 协议面 + configured
// harness 注册表）先于 A2A 协作平面装配；两者间联动只走 ctx.platformBus（a2a.task.* 事件族）
import * as uhp from '@dsh-ops/plugin-uhp'
import * as a2a from '@dsh-ops/plugin-a2a'
// W2 启动健壮性：双实例断言 + 装配后插件树体检
import { assertSingleRoot, formatTreeHealth, probeTree } from '@dsh-ops/platform-core'

export interface BootOptions {
  dataDir: string
  port: number
}

export async function bootAll(ctx: Context, options: BootOptions): Promise<void> {
  // 装配前断言进程内只有一个 root（双实例会让 fiber 静默 PENDING，必须 fail-fast）
  assertSingleRoot(ctx)
  await ctx.plugin(platformCore, { dataDir: options.dataDir, http: { port: options.port } })
  const restored = await ctx.opsStorage.restoreAll()
  if (restored.length > 0) {
    ctx.logger('boot').info(`已从磁盘恢复 ${restored.length} 个数据集合`)
  }
  await ctx.plugin(resourceCore)
  await ctx.plugin(iam)
  await ctx.plugin(authn)
  await ctx.plugin(usage)
  await ctx.plugin(audit)
  await ctx.plugin(market)
  // 连接器纳管（open-connector 数据面网关适配）：依赖 iam/usage/audit，先于 mcp/modelgw
  await ctx.plugin(connector)
  await ctx.plugin(mcp)
  // NAS（FS 文件存储）资产：先于 skillhub 加载（skillhub 上架时经 nasRegistry 上传 skill.zip）
  await ctx.plugin(nas)
  await ctx.plugin(skillhub)
  await ctx.plugin(agent)
  await ctx.plugin(app)
  await ctx.plugin(modelgw)
  // 宿主角色：提供远程接入端点（接入码/enroll/客户端管理）与接入管理工具
  await ctx.plugin(connect, { role: 'host' })
  // 平台自更新：上游版本检查（自动+手动）与一键升级（source 形态）
  await ctx.plugin(update)
  // 门户数据通道（外部系统拉取端点，非核心；PORTAL_SYNC=off 可停用）：
  // 端点公开只读，必须先于 console 装配——在其鉴权中间件之前截获 /api/portal/* 请求
  await ctx.plugin(portal)
  await ctx.plugin(consolePlugin)
  // 部门面板（review-dsh-agent-panel-v2）：REST 依赖 console 鉴权中间件先行注册（/api/* Bearer 面）；
  // 自注册路由经 httpServer.routeMatrix 共享登记处汇入 RBAC 断言矩阵
  await ctx.plugin(panelCore)
  // 事务流引擎（IAW 交接 3-1..3-4，宿主新域）：/api/flow/* 自注册 guarded 路由，同样依赖 console 中间件先行
  await ctx.plugin(flowCore)
  // 执行中枢（ybkk-MATRIX 目标四「干活中枢」）：目标血缘/任务执行锁/心跳唤醒/例行调度，
  // /api/exec/* 自注册 guarded 路由——依赖 console 中间件、resourceCore/agentRegistry/modelgw/flow 先行
  await ctx.plugin(execHub)
  // 数字员工域（员工/任用/permit/受控调用/交付验收）：/api/workforce/* guarded 路由依赖 console 中间件，
  // 员工工作路径依赖 exec-hub 先行——须在其后、钉钉桥接之前装配；装配完成后经 platform-core 的
  // workforcePolicy 窄端口登记策略实现（artifact staging 与 SQLite 同底座，数据目录复用 options.dataDir）
  await ctx.plugin(workforce, { dataDir: options.dataDir })
  // 钉钉桥接（群桥/出向投递/审批推送/告警通道）：订阅 panel.message.created 与 audit.alert.fired
  await ctx.plugin(dingtalkBridge)
  // UHP 执行驱动（协作方案 §7）：/v1/uhp 协议面 + /api/uhp/* guarded 路由——依赖 console 中间件与
  // modelgw 先行；订阅 a2a.task.dispatch/cancel，发布 a2a.task.progress
  await ctx.plugin(uhp)
  // A2A 协作平面（协作方案 §5/§6）：well-known 卡片/目录/JSON-RPC 方法面/治理五查/协商引擎/
  // 验收/巡检——依赖 skillhub/mcp/agent 先行（卡片授权集投影），派发与执行只走事件总线
  await ctx.plugin(a2a)
  // 装配后体检：必须在全部 await ctx.plugin 之后（此刻 fiber 都应 ACTIVE）；
  // 必需服务不可达或存在拦启动的卡死 fiber 时直接拒绝启动，禁止降级为告警放行
  // （FAILED fiber 仅在声明 provide 已被其他 ACTIVE fiber 接管时豁免，见 boot-probe.ts）
  const health = probeTree(ctx, ['opsStorage', 'platformBus', 'httpServer', 'iam', 'authn', 'usage', 'audit'])
  if (!health.ok) {
    throw new Error(formatTreeHealth(health))
  }
}
