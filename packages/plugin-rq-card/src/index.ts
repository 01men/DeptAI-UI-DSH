/**
 * @ybkk/plugin-rq-card —— dsh 会话侧注入插件，宿主半（WP-06 + M2 宿主连接）。
 *
 * 双面结构：
 *   - 浏览器半（src/client/** → lib/client.js）：四态执行卡 + 👍/👎 反馈条 +（M2/M3）
 *     设置分区「01门宿主连接」、会话视图 Tab「01门工作台」、未连接角标；
 *   - 宿主半（本文件）：WP-06 时代是纯占位（空 apply）；M2 起承担「装好插件即可用」的
 *     连接半部——HostLinkService 的免登向导端点 /rqcard/*（连接宿主/选 IP/本机初始化/
 *     远端数据代理），详见 hostlink.ts 文件头。
 *
 * 【构建门禁（spike §4.4，硬约束）】激活期缺 bundle 会响亮抛错
 * （MissingClientBundleError → ClientPackageCompositionError → 宿主启动失败）。
 * 因此 `dsh web` 启动前必须先执行：
 *
 *     node packages/plugin-rq-card/build.mjs     # 产出 lib/client.js（含 build-id 指纹）
 *
 * cordis 装配条目的 name（issue #1 修复，2026-10-27）：安装形态（cordis.patch.yml）
 * 写根包名 '@ybkk/gate-01'，源码开发形态（cordis.yml）写根出口路径
 * '<PROJECT_ROOT>/index.js'——两条链的包元数据都落在根包 dsh.client 声明上
 * （client-modules 取「解析文件向上最近的 package.json」），浏览器半装载 id 同为
 * '@ybkk/gate-01'。旧写法（裸包名 '@ybkk/plugin-rq-card'）依赖 file: 依赖顶层物化，
 * git/registry 安装形态不可达，已废弃。
 *
 * 【markdown 兜底契约（spike §5 降级预案第 5 条，宿主工具侧义务）】
 * 01门工具的 tool/result 文本内容必须始终携带纯 markdown 摘要 + /gate01 控制台链接：
 * 客户端富卡片只是把同一信息「升级」呈现；上游升级导致注入面失效时，用户
 * 体验自动回落为该文本，无需发版。summarizeForToolResult() 是该契约的参考
 * 实现，供工具侧（platform-core / plugin-mcp 等）在组织工具结果时复用——
 * 建议把摘要文本放在结果首块，富卡片与纯文本两个世界读同一份信息。
 */

import type { HttpExchange } from '../../platform-core/src/index.ts'
import { defineTool } from './tool.ts'
import { CONSOLE_BASE } from './wire.ts'
import { HostLinkService, RQCARD_CALL_HEADER } from './hostlink.ts'
export { HostLinkService, RQCARD_CALL_HEADER } from './hostlink.ts'
export type { HostLinkConfig, HubProbe, HostLinkOptions } from './hostlink.ts'
export { normalizeHubBase, proxyPathAllowed } from './hostlink.ts'

/** summarizeForToolResult 的输入。 */
export interface ToolResultSummaryInput {
  /** 工具名（如 mcp_invoke），首行加粗呈现。 */
  toolName: string
  /** 一句话业务摘要（用户最关心的那件事）。 */
  summary: string
  /** /gate01 控制台对应资源页 hash 路由（如 #/mcp）；缺省不生成链接。 */
  consoleHash?: string
  /** 关键明细（键值对，逐行渲染；保持精炼，摘要不是日志）。 */
  details?: Readonly<Record<string, string | number>>
  /** 是否异常结果：异常时首行加「⚠」前缀，提示用户进控制台处理。 */
  isError?: boolean
}

/**
 * 组装工具结果的 markdown 兜底摘要（宿主工具侧契约的参考实现）。
 *
 * 形态示例：
 *
 *   **mcp_invoke** ⚠ 执行受阻 —— 无访问权限
 *   - 服务：inventory（online）
 *   - 原因：nas-authz deny
 *   👉 [到01门控制台处理](/gate01#/nas-authz)
 *
 * 返回值直接作为 tool/result 文本内容的一部分（不依赖任何客户端插件）。
 */
export function summarizeForToolResult(input: ToolResultSummaryInput): string {
  const lines: string[] = []
  const flag = input.isError ? '⚠ ' : ''
  lines.push(`**${input.toolName}** ${flag}${input.summary}`)
  for (const [key, value] of Object.entries(input.details ?? {})) {
    lines.push(`- ${key}：${String(value)}`)
  }
  if (input.consoleHash !== undefined) {
    lines.push(`👉 [到01门控制台处理](${CONSOLE_BASE}${input.consoleHash})`)
  }
  return lines.join('\n')
}

export interface RqCardConfig {
  /** 连接配置文件目录（默认与平台存储同目录）。 */
  dataDir?: string
  /** LAN 扫描候选端口（默认 [7300, 3080]；测试可注入）。 */
  scanPorts?: number[]
}

export const name = 'rq-card'
// plan-gate01 Phase 2.3 瘦身：去掉 authn/iam——它们仅被已删除的「本机初始化」链路
// （形态 B 设口令）使用；连接统一为「连接宿主」流程（本机=localhost 连接目标），登录在宿主侧完成。
// cordis inject 是装载级硬依赖（缺提供者=永久挂起，spike 定稿），01门装态无宿主面包，必须能缺席。
export const inject = ['httpServer', 'tools', 'opsStorage']

/**
 * 宿主插件体：装配 HostLinkService（/rqcard/* 免登向导端点 + 远端代理）与 rq_host_status 工具。
 * 浏览器半的注入面全部在 src/client/（构建产物 lib/client.js）。
 */
export function apply(ctx: Context, config: RqCardConfig = {}) {
  const http = ctx.httpServer
  const link = new HostLinkService(ctx, { dataDir: config.dataDir, scanPorts: config.scanPorts })

  /** 向导调用头校验（CSRF 防线，见 hostlink.ts 文件头「自带防线」第 1 条）。 */
  const wizardGuard = (exchange: HttpExchange): boolean => {
    const raw = exchange.headers[RQCARD_CALL_HEADER]
    const value = String(Array.isArray(raw) ? raw[0] : (raw ?? ''))
    if (value !== '1') {
      exchange.fail(403, 'WIZARD_CALL_HEADER_REQUIRED', '向导端点要求 x-rqcard-call: 1 请求头（跨站防御）')
      return false
    }
    return true
  }

  const json = <T extends Record<string, any>>(exchange: HttpExchange): T => (exchange.body ?? {}) as T
  const fail = (exchange: HttpExchange, code: string, error: unknown): void => {
    exchange.fail(400, code, error instanceof Error ? error.message : String(error))
  }

  // -- 连接状态与三通道（local / remote / reset）+ 局域网扫描 -------------------
  http.register('GET', '/rqcard/link', async (exchange) => {
    if (!wizardGuard(exchange)) return
    const cfg = link.getConfig()
    const probe = cfg.mode === 'remote' && cfg.hubBase ? await link.probeHub(cfg.hubBase).catch(() => null) : null
    exchange.ok({
      mode: cfg.mode,
      hubBase: cfg.hubBase ?? null,
      hubMountPrefix: cfg.hubMountPrefix ?? null,
      label: cfg.label ?? null,
      savedAt: cfg.savedAt ?? null,
      probe,
    })
  })

  http.register('POST', '/rqcard/link/local', (exchange) => {
    if (!wizardGuard(exchange)) return
    const input = json<{ label?: string }>(exchange)
    exchange.ok({ config: link.setLocal(input.label) })
  })

  http.register('POST', '/rqcard/link/remote', async (exchange) => {
    if (!wizardGuard(exchange)) return
    const input = json<{ hubBase?: string; label?: string }>(exchange)
    try {
      exchange.ok(await link.setRemote(String(input.hubBase ?? ''), input.label))
    } catch (error) {
      fail(exchange, 'LINK_REMOTE_FAILED', error)
    }
  })

  http.register('POST', '/rqcard/link/reset', (exchange) => {
    if (!wizardGuard(exchange)) return
    exchange.ok({ config: link.reset() })
  })

  http.register('POST', '/rqcard/link/scan', async (exchange) => {
    if (!wizardGuard(exchange)) return
    const input = json<{ candidates?: string[] }>(exchange)
    try {
      exchange.ok(await link.scan(input.candidates))
    } catch (error) {
      fail(exchange, 'LINK_SCAN_FAILED', error)
    }
  })

  // -- 远端数据代理：通配路径走中间件拦截（路由表按段精确匹配表达不了任意深度） --
  http.use(async (exchange) => {
    if (!exchange.path.startsWith('/rqcard/proxy')) return
    if (!wizardGuard(exchange)) return // 已写 403 响应
    await link.proxy(exchange)
  })

  // -- Agent 工具：会话里能问「连的哪个宿主」 ----------------------------------
  ctx.tools.register(defineTool({
    name: 'rq_host_status',
    description: '查看01门宿主连接状态：本机即宿主（local）/ 连接远端宿主（remote，含地址与面板入口）/ 未配置（none，打开面板会进入连接向导）。',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      const cfg = link.getConfig()
      return {
        mode: cfg.mode,
        hubBase: cfg.hubBase ?? null,
        panelUrl: cfg.mode === 'remote' && cfg.hubBase
          ? `${cfg.hubBase}${cfg.hubMountPrefix ?? ''}/panel/`
          : `${CONSOLE_BASE}/panel/`,
        ...(cfg.mode === 'none' ? { notice: '尚未配置宿主连接：打开面板 /panel/ 会进入连接向导（也可让使用者在浏览器完成配置）' } : {}),
      }
    },
  }))
}
