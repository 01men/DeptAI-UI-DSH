/**
 * 首次启动种子（二选一，空库时执行一次）：
 * - 基线（默认，生产形态）：内置角色 + 根组织 + 平台管理员 admin——口令取 ADMIN_PASSWORD 环境变量，
 *   缺省则随机生成并一次性写入 data/admin-initial-password.txt。不含任何演示业务数据。
 * - 演示（DEMO_SEED=1）：完整演示数据——组织树 / 演示账号（口令统一 Ybk@2026，仅限演示环境）/
 *   钉钉 mock 连接器 / MCP 服务与权限组 / Skill 市场 / Agent / 应用 / 28 天历史用量
 *   （成本由 usage 事件×价格簿经正式管道派生）/ 告警规则 / 待办审批。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { newId } from '../../platform-core/src/index.ts'
import { SYSTEM_ACTOR } from '../../plugin-iam/src/index.ts'
import { recordBootstrap } from './routes/platform.ts'

/** 演示种子账号统一口令（仅限演示环境；本仓库公开，语义上就是「无需保密的演示口令」）。 */
export const DEMO_SEED_PASSWORD = 'Ybk@2026'
/** 演示一键入场默认账号（种子超管，见 seedDemo mkUser('admin', …)）。 */
export const DEMO_ENTRY_USERNAME = 'admin'

export async function seedAll(ctx: Context): Promise<void> {
  if (ctx.iam.orgs().count() === 0) {
    if (process.env.DEMO_SEED === '1') {
      await seedDemo(ctx)
    } else {
      seedBaseline(ctx)
    }
  }
  // ARC-01（QA A-02 修正到位）：内置角色权限迁移必须排在种子完成之后——此前调用挂在
  // seedAll 顶部，仍在 ensureBuiltinRoles 之前，全新部署首次启动角色表为空 → 迁移空跑
  // （connector 装配期兜底调用更早，同样空跑并先落 connector-permissions-v1 标记），
  // 静态 BuiltinRoles 种出的角色缺迁移批次新增的权限点（audit 缺 nas.authz.read/panel.read
  // 等），直到第二次重启迁移才真正生效。此处每次启动幂等重跑：迁移实现为「缺则补、永不
  // 删改」，重跑不会覆盖管理员对角色的人工改权；iam:migrations 标记仅作观测、不拦截重跑，
  // 故存量受损库（已落空跑标记、角色缺点）代码更新后下一次启动即自动补齐，无需清 marker。
  try {
    ctx.iam.ensureConnectorPermissionsMigration()
  } catch { /* 迁移失败不阻断启动；connector 装配期兜底调用仍在 */ }
  // 解绑护栏配套回填（2026-10-22）：存量账号补 passwordKnown，避免「缺字段」被当成
  // 「只能靠三方登录」而让解绑对既有账号全程被拒。幂等，失败同样不阻断启动。
  try {
    ctx.iam.backfillPasswordKnown()
  } catch { /* 回填失败不阻断启动；下次启动重试 */ }
  // 身份链 kind 回填（2026-10-22）：区分登录链与任职链，否则解绑会连带抹掉任职事实，
  // 断掉部门负责人反查与 NAS 数据权限身份反查。幂等，失败同样不阻断启动。
  try {
    ctx.iam.backfillIdentityLinkKinds()
  } catch { /* 回填失败不阻断启动；下次启动重试 */ }
}

/** 生产基线：可上线的最小初始化（零演示数据）。 */
function seedBaseline(ctx: Context): void {
  const logger = ctx.logger('seed')
  logger.info('首次启动，正在初始化平台基线（内置角色 + 根组织 + 平台管理员）…')
  ctx.iam.ensureBuiltinRoles()
  const orgName = process.env.ORG_NAME ?? '元冰可集团'
  const root = ctx.iam.createOrg({ name: orgName }, SYSTEM_ACTOR)
  const roleSuper = ctx.iam.roles().findOne((role) => role.code === 'super_admin')!
  // ADMIN_PASSWORD 空串视为未设置：显式空串会触发口令强度校验令首启失败，
  // 即使放行也等价于空口令把 admin 锁死——统一回落随机生成路径
  const adminPassword = process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD : undefined
  const { user: admin, initialPassword } = ctx.iam.createUser({
    username: 'admin',
    displayName: '平台管理员',
    orgId: root.id,
    title: '平台管理员',
    roleIds: [roleSuper.id],
    password: adminPassword,
  }, SYSTEM_ACTOR)
  ctx.iam.users().update(admin.id, { status: 'active' })
  void admin
  let passwordFile: string | undefined
  if (initialPassword) {
    const file = join(ctx.opsStorage.dataDirPath, 'admin-initial-password.txt')
    if (!existsSync(file)) {
      // mode 0600：初始口令文件仅属主可读写，防同机其他账号经组/全局可读位取得管理员口令
      writeFileSync(file, `平台管理员 admin 的初始口令（仅生成一次；首次登录后请妥善保管并删除本文件）：\n${initialPassword}\n`, { encoding: 'utf8', mode: 0o600 })
    }
    passwordFile = file
    logger.info(`平台管理员 admin 初始口令已生成，写入 ${file}（请立即登录并妥善保管）`)
  } else {
    logger.info('平台管理员 admin 已按 ADMIN_PASSWORD 环境变量初始化')
  }
  recordBootstrap(ctx, { mode: 'baseline', orgName, ...(passwordFile ? { initialPasswordFile: passwordFile } : {}) })
  // 首启引导（M2 部署产品化）：管理员打开控制台前的「三步走」，对齐 docs/deploy-enterprise.md checklist
  logger.info([
    '',
    '┌─ 首次启动完成 · 上线三步走（详见 docs/deploy-enterprise.md）────────────',
    '│ ① 用上方初始口令以 admin 登录控制台（地址见启动日志「控制台地址」行）',
    '│ ② 立即修改 admin 口令，并删除服务器上的 admin-initial-password.txt',
    '│ ③ 从「资产登记」接入第一类 AI 资产（模型路由 / MCP / Agent / 应用 / Skill / NAS）',
    '└──────────────────────────────────────────────────────────────────────',
  ].join('\n'))
  logger.info('平台基线初始化完成。如需完整演示数据：设 DEMO_SEED=1 并清空数据目录后重启')
}

/** 演示数据（DEMO_SEED=1）：为评估/培训环境准备的完整样例。 */
async function seedDemo(ctx: Context): Promise<void> {
  const logger = ctx.logger('seed')
  logger.info('首次启动（DEMO_SEED=1），正在初始化演示数据…')
  recordBootstrap(ctx, { mode: 'demo', orgName: '元冰可集团' })

  // -- 组织树 --------------------------------------------------------------
  const root = ctx.iam.createOrg({ name: '元冰可集团' }, SYSTEM_ACTOR)
  const tech = ctx.iam.createOrg({ name: '技术中心', parentId: root.id }, SYSTEM_ACTOR)
  const aiDept = ctx.iam.createOrg({ name: 'AI 平台部', parentId: tech.id }, SYSTEM_ACTOR)
  const beDept = ctx.iam.createOrg({ name: '后端部', parentId: tech.id }, SYSTEM_ACTOR)
  const feDept = ctx.iam.createOrg({ name: '前端部', parentId: tech.id }, SYSTEM_ACTOR)
  const prodDept = ctx.iam.createOrg({ name: '产品运营部', parentId: root.id }, SYSTEM_ACTOR)
  ctx.iam.createOrg({ name: '市场部', parentId: root.id }, SYSTEM_ACTOR)

  // -- 角色与账号 ------------------------------------------------------------
  ctx.iam.ensureBuiltinRoles()
  const roleSuper = ctx.iam.roles().findOne((role) => role.code === 'super_admin')!
  const roleOrgAdmin = ctx.iam.roles().findOne((role) => role.code === 'org_admin')!
  const roleResource = ctx.iam.roles().findOne((role) => role.code === 'resource_admin')!
  const roleDev = ctx.iam.roles().findOne((role) => role.code === 'developer')!
  const roleAuditor = ctx.iam.roles().findOne((role) => role.code === 'auditor')!

  const mkUser = (username: string, displayName: string, orgId: string, title: string, roleIds: string[]) => {
    const { user } = ctx.iam.createUser({ username, displayName, orgId, title, roleIds, password: DEMO_SEED_PASSWORD }, SYSTEM_ACTOR)
    ctx.iam.users().update(user.id, { status: 'active' })
    return ctx.iam.users().get(user.id)!
  }

  const admin = mkUser('admin', '沈亦澜', root.id, '平台负责人', [roleSuper.id])
  const opsAdmin = mkUser('ops', '韩若飞', aiDept.id, '资源管理员', [roleResource.id])
  const orgAdmin = mkUser('hr', '顾星阑', prodDept.id, '组织管理员', [roleOrgAdmin.id])
  const dev1 = mkUser('dev', '陈默', aiDept.id, '算法工程师', [roleDev.id])
  const dev2 = mkUser('linxm', '林小满', aiDept.id, '算法工程师', [roleDev.id])
  // 预置三方身份链接（演示钉钉免密登录；事实源为 identityLinks）
  ctx.iam.users().update(dev2.id, { jobNumber: 'DD0002' })
  ctx.iam.linkIdentity(dev2.id, { provider: 'dingtalk', providerUserId: 'dd_u002', corpId: 'ding-yuanbingke', displayName: '林小满', kind: 'login' }, 'seed')
  const auditor = mkUser('audit', '楚天阔', root.id, '审计专员', [roleAuditor.id])
  mkUser('suyq', '苏砚秋', beDept.id, '后端工程师', [roleDev.id])
  mkUser('heqw', '何青梧', feDept.id, '前端工程师', [roleDev.id])
  mkUser('yqz', '叶栖迟', prodDept.id, '运营专员', [])
  const { user: pendingUser } = ctx.iam.createUser({ username: 'newcomer', displayName: '周明澜', orgId: feDept.id, title: '前端工程师（试用期）', password: DEMO_SEED_PASSWORD }, SYSTEM_ACTOR)
  void pendingUser

  // -- 用户组 --------------------------------------------------------------
  const aiGroup = ctx.iam.createGroup({
    name: 'AI 平台部全员',
    type: 'dynamic',
    rule: { orgIds: [aiDept.id] },
    description: '按部门自动圈人',
  })
  const grayGroup = ctx.iam.createGroup({
    name: '灰度试点组',
    type: 'static',
    memberIds: [dev1.id, dev2.id],
    description: '新功能灰度首批用户',
  })
  void aiGroup
  void grayGroup

  // -- 连接器 --------------------------------------------------------------
  ctx.iam.upsertConnectorConfig({
    provider: 'dingtalk',
    name: '元冰可集团（演示）',
    corpId: 'ding-yuanbingke',
    appKey: 'demo-app-key',
    appSecret: 'demo-secret-do-not-use',
    enabled: true,
    loginEnabled: true,
    conflictStrategy: 'manual',
    intervalMinutes: 60,
  })

  // -- MCP 服务（演示数据：exec 显式 demo，SLO/计费不统计） --------------------
  // W1-T2（治理契约 §5）：演示服务带治理字段（ownerEntity 默认 platform 占位=治理待办 unowned，
  // 待 W2-T4 能力绑定回写 app/agent 归属；dataClass/exposureMode/environment/visibility 按业务拟真）。
  const mkMcp = (input: Parameters<typeof ctx.mcpRegistry.createService>[0]) => {
    const service = ctx.mcpRegistry.createService({ ...input, exec: 'demo' })
    return ctx.mcpRegistry.services().get(service.id)!
  }

  const kb = mkMcp({
    // visibility='org'：AI 部门内服务，跨组织调用需权限组显式授权（PDP org-constraint 裁决）。
    // 'cross-org' 保留「逐次审批单」强语义，仅供确有跨租户开放需求的服务显式声明——
    // 演示数据不设该形态，避免治理门禁误伤常规演示路径（三态覆盖见 plugin-mcp policy.test.mjs）。
    name: '企业知识库检索', slug: 'knowledge-base', orgId: aiDept.id,
    description: '对制度文档、技术 Wiki、会议纪要做语义检索与引用定位。', category: '行政',
    icon: 'kb', endpoint: 'mcp+http://platform-hosted/knowledge-base',
    ownerEntity: { type: 'platform' }, dataClass: 'public', exposureMode: 'gateway',
    environment: 'prod', visibility: 'org',
    tools: [
      { name: 'kb_search', description: '语义检索知识库', inputSchema: { type: 'object' }, riskLevel: 'read' },
      { name: 'kb_fetch_doc', description: '获取文档全文', inputSchema: { type: 'object' }, riskLevel: 'read' },
    ],
    stability: 0.985,
  })
  const dw = mkMcp({
    name: '数据分析引擎', slug: 'datawise', orgId: aiDept.id,
    description: 'SQL 生成与执行、指标查询、报表导出。', category: '运营',
    icon: 'chart', endpoint: 'mcp+http://platform-hosted/datawise',
    ownerEntity: { type: 'platform' }, dataClass: 'confidential', exposureMode: 'gateway',
    environment: 'prod', visibility: 'org',
    tools: [
      { name: 'dw_query_metrics', description: '查询业务指标', inputSchema: { type: 'object' }, riskLevel: 'read' },
      { name: 'dw_run_sql', description: '执行只读 SQL', inputSchema: { type: 'object' }, riskLevel: 'read' },
      { name: 'dw_export_report', description: '导出报表', inputSchema: { type: 'object' }, riskLevel: 'write' },
    ],
    stability: 0.96,
  })
  const ticket = mkMcp({
    name: '客服工单系统', slug: 'ticket-service', orgId: prodDept.id,
    description: '工单创建、流转、催办与满意度回访。', category: '销售',
    icon: 'ticket', endpoint: 'https://ticket-mcp.yuanbingke.com/mcp', mode: 'external', transport: 'sse',
    ownerEntity: { type: 'platform' }, dataClass: 'internal', exposureMode: 'direct',
    environment: 'prod', visibility: 'org',
    credentialRef: 'env:TICKET_MCP_TOKEN',
    tools: [
      { name: 'ticket_create', description: '创建工单', inputSchema: { type: 'object' }, riskLevel: 'write' },
      { name: 'ticket_search', description: '查询工单', inputSchema: { type: 'object' }, riskLevel: 'read' },
      { name: 'ticket_escalate', description: '工单升级/催办', inputSchema: { type: 'object' }, riskLevel: 'admin' },
    ],
    stability: 0.93,
  })
  const hrSvc = mkMcp({
    name: 'HR 人事服务', slug: 'hr-service', orgId: root.id,
    description: '人事档案查询、假期余额、考勤异常处理。', category: '人事',
    icon: 'hr', endpoint: 'mcp+http://platform-hosted/hr-service',
    ownerEntity: { type: 'platform' }, dataClass: 'confidential', exposureMode: 'gateway',
    environment: 'prod', visibility: 'org',
    tools: [
      { name: 'hr_query_profile', description: '查询员工档案', inputSchema: { type: 'object' }, riskLevel: 'read' },
      { name: 'hr_leave_balance', description: '查询假期余额', inputSchema: { type: 'object' }, riskLevel: 'read' },
    ],
    stability: 0.99,
  })
  const fx = mkMcp({
    name: '汇率与结算（灰度中）', slug: 'fx-settlement', orgId: beDept.id,
    description: '跨境结算汇率查询与批量打款指令（灰度验证中）。', category: '财务',
    icon: 'fx', endpoint: 'mcp+http://platform-hosted/fx-settlement',
    ownerEntity: { type: 'platform' }, dataClass: 'confidential', exposureMode: 'gateway',
    environment: 'staging', visibility: 'tenant',
    tools: [
      { name: 'fx_rate_query', description: '查询实时汇率', inputSchema: { type: 'object' }, riskLevel: 'read' },
      { name: 'fx_batch_pay', description: '批量打款指令', inputSchema: { type: 'object' }, riskLevel: 'admin' },
    ],
    stability: 0.9,
  })
  // W1-T2（契约 §6）凭证引用演示：env: 形态——seed 不落任何明文，取值来自进程环境变量
  // TICKET_MCP_TOKEN（未设置时 resolve 自然 miss 返回 null，调用链不受影响）。
  // P1-04：演示种子自行把该变量名并入 env 凭证白名单（仅本进程内存），与白名单 fail-closed 兼容。
  if (process.env.DEMO_SEED === '1') {
    const allowKey = 'MCP_ENV_SECRET_ALLOWLIST'
    const current = String(process.env[allowKey] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    if (!current.includes('TICKET_MCP_TOKEN')) {
      process.env[allowKey] = [...current, 'TICKET_MCP_TOKEN'].join(',')
    }
  }
  try {
    ctx.mcpRegistry.secretBroker()?.put({
      serviceId: ticket.id, credentialRef: 'env:TICKET_MCP_TOKEN', headerName: 'Authorization',
    })
  } catch { /* 种子非关键路径：broker 未装配/无数据目录时跳过 */ }

  const deploy = async (id: string, gray?: number, version?: string, changelog?: string) => {
    try {
      const service = ctx.mcpRegistry.services().get(id)!
      if (service.status === 'draft') {
        await ctx.mcpRegistry.verifyService(id)
      }
      await ctx.mcpRegistry.deployService(id, { grayPercent: gray, version, changelog, actor: admin.displayName })
    } catch (error) {
      ctx.logger('seed').warn(`MCP ${id} 部署演示数据失败（跳过）`, error)
    }
  }
  await deploy(kb.id, 100, '2.3.1', '混合检索召回优化')
  await deploy(kb.id, 100, '2.4.0', '支持表格问答') // 演进两版
  await deploy(dw.id, 100, '1.8.0', '指标缓存')
  await deploy(ticket.id, 100, '3.0.2', 'SLA 催办策略')
  await deploy(hrSvc.id, 100, '1.2.0', '初始化')
  await deploy(fx.id, 15, '0.9.0-rc1', '灰度：新增批量打款')

  // -- MCP 权限组 ------------------------------------------------------------
  ctx.mcpRegistry.createPermGroup({
    name: '知识库·只读', description: '全员可检索，禁止写入',
    policies: { [kb.id]: { allowedTools: '*', constraints: { readOnly: true } } },
    subjects: [{ type: 'user_group', id: aiGroup.id, name: 'AI 平台部全员' }],
  })
  const financeGroup = ctx.mcpRegistry.createPermGroup({
    name: '数据与工单·标准', description: '指标查询 + 工单读写（不含升级）',
    policies: {
      [dw.id]: { allowedTools: '*', constraints: {} },
      [ticket.id]: { allowedTools: ['ticket_create', 'ticket_search'], constraints: {} },
    },
    subjects: [{ type: 'user_group', id: grayGroup.id, name: '灰度试点组' }],
  })
  void financeGroup

  // -- NAS 文件存储资产（演示：草稿态，指向真实网关后可探活上线） ----------------
  ctx.nasRegistry.register({
    name: '群晖文件网关（机房 A）', slug: 'synology-dc-a',
    attrs: {
      description: '技术中心共享文件存储（演示草稿：通过 nas import 或编辑接入信息指向真实 synology-filestation-mcp 网关后上线）',
      vendor: 'Synology DS920+', capacity: '4×4TB',
      tags: ['文件存储', '演示'],
      gatewayUrl: 'http://192.168.0.7:3000/mcp', accessToken: 'demo-token-replace-me', nasIp: '192.168.0.196',
      rootPath: '/', stagingDir: '/volume1/dsh-staging',
      dataClass: 'internal',
    },
    ownerId: opsAdmin.id, orgId: aiDept.id,
  })
  // 第二台 NAS（设计适配 2026-10-14：六类资产各≥2 条的演示覆盖要求；同草稿态诚实降级）
  ctx.nasRegistry.register({
    name: '档案冷存储（机房 B）', slug: 'archive-dc-b',
    attrs: {
      description: '历史归档与合规留存的冷存储网关（演示草稿：接入真实网关后探活上线）',
      vendor: 'QNAP TS-873A', capacity: '8×8TB',
      tags: ['归档存储', '演示'],
      gatewayUrl: 'http://192.168.1.9:3000/mcp', accessToken: 'demo-token-replace-me', nasIp: '192.168.1.9',
      rootPath: '/archive', stagingDir: '/archive/dsh-staging',
      dataClass: 'internal',
    },
    ownerId: opsAdmin.id, orgId: beDept.id,
  })
  const nasAssets = ctx.nasRegistry.list()

  // -- Skill 市场 ------------------------------------------------------------
  const mkSkill = async (input: Parameters<typeof ctx.skillHub.submit>[0]) => {
    const skill = ctx.skillHub.submit(input)
    const target = skill.versions.find((item) => item.version === skill.currentVersion)!
    if (target.status === 'pending_domain') {
      ctx.skillHub.approve(skill.id, target.version, skill.riskLevel === 'high' ? 'domain' : 'domain', { id: opsAdmin.id, name: opsAdmin.displayName }, '业务适用性确认')
      if (skill.riskLevel === 'high') {
        ctx.skillHub.approve(skill.id, target.version, 'security', { id: admin.id, name: admin.displayName }, '安全团队加签通过')
      }
    }
    const published = await ctx.skillHub.publish(skill.id, target.version, { id: opsAdmin.id, name: opsAdmin.displayName })
    return ctx.skillHub.skills().get(published.id)!
  }

  const skillWeekly = await mkSkill({
    // 分类对齐平台标准口径（platform-core ASSET_CATEGORIES）；旧分类值保留进 tags
    name: '周报生成器', category: '行政', tags: ['文档', '自动化', '办公提效'],
    summary: '汇总本周会话与项目进展，一键生成结构化周报',
    content: '# 周报生成器\n\n## 何时使用\n每周五 17:00 汇总个人与团队进展。\n\n## 步骤\n1. 读取本周所有会话摘要\n2. 按项目分组提炼结论\n3. 生成分节周报并发出确认\n\n## 输出格式\nMarkdown，含【本周结论】【风险】【下周计划】三节。',
    authorId: dev1.id, authorName: dev1.displayName, orgId: aiDept.id, version: '1.2.0', changelog: '支持自定义模板',
  })
  const skillSql = await mkSkill({
    name: 'SQL 审查助手', category: '研发', tags: ['数据库', '评审', '研发效能'],
    summary: '对 SQL 变更做索引/风险审查并给出改写建议',
    content: '# SQL 审查助手\n\n## 何时使用\n提交含 SQL 变更的 MR 时触发。\n\n## 检查项\n- 全表扫描风险\n- 索引命中分析\n- 事务与锁范围\n\n## 输出\n审查意见 + 改写示例。',
    authorId: dev2.id, authorName: dev2.displayName, orgId: aiDept.id, version: '2.0.1', changelog: '适配新解析器',
  })
  const skillCs = await mkSkill({
    name: '客诉安抚话术库', category: '销售', tags: ['客服', '话术', '客户服务'],
    summary: '按情绪等级与场景匹配备选安抚话术',
    content: '# 客诉安抚话术库\n\n## 何时使用\n客服 Agent 识别到用户负面情绪时调用。\n\n## 分级\nL1 失望 / L2 愤怒 / L3 投诉升级\n\n## 原则\n先共情，后解释，给出可执行补偿选项。',
    authorId: orgAdmin.id, authorName: orgAdmin.displayName, orgId: prodDept.id, version: '1.0.3',
  })
  const skillData = await mkSkill({
    name: '指标异动归因', category: '运营', tags: ['BI', '归因', '数据分析'],
    summary: '对指标波动做多维下钻归因，输出结论卡片',
    content: '# 指标异动归因\n\n## 何时使用\n看板指标同比/环比异常时。\n\n## 流程\n1. 确认异动显著性\n2. 按渠道/地区/客群下钻\n3. 输出 Top3 归因与置信度。',
    authorId: dev1.id, authorName: dev1.displayName, orgId: aiDept.id, version: '0.9.0',
  })
  const skillOnboard = await mkSkill({
    name: '新人入职引导', category: '人事', tags: ['HR', '流程', '人事行政'],
    summary: '按入职清单引导新同学完成账号、设备、培训',
    content: '# 新人入职引导\n\n## 何时使用\n新员工入职首日。\n\n## 清单\n- 账号激活与三方绑定\n- 设备领用\n- 安全培训考试\n- 导师匹配',
    authorId: orgAdmin.id, authorName: orgAdmin.displayName, orgId: prodDept.id, version: '1.1.0',
  })

  // 高风险 Skill（含外联）演示两级审批 + 安全加签
  const skillWeb = await mkSkill({
    name: '竞品舆情监控', category: '销售', tags: ['外联', '监控', '市场情报'],
    summary: '定时抓取公开舆情并生成竞品日报（高风险：外部网络）',
    content: '# 竞品舆情监控\n\n## 何时使用\n每日 08:00 定时任务。\n\n## 行为\n- 通过 https://news.example.com 获取公开新闻\n- 关键词过滤与情感标注\n- 生成日报',
    authorId: dev2.id, authorName: dev2.displayName, orgId: aiDept.id, version: '1.0.0',
  })

  // 待审批版本（供审批中心演示）
  const pendingSkill = ctx.skillHub.submit({
    name: '合同条款审查', category: '行政', tags: ['法务', '法务合规'],
    summary: '标注合同风险条款并给出修改建议',
    content: '# 合同条款审查\n\n## 何时使用\n上传合同文件后触发。\n\n## 检查项\n- 违约责任对称性\n- 付款节点合理性\n- 知识产权归属',
    authorId: dev1.id, authorName: dev1.displayName, orgId: aiDept.id, version: '0.5.0',
  })
  void pendingSkill

  ctx.skillHub.rate(skillWeekly.id, dev2.id, 5)
  ctx.skillHub.rate(skillWeekly.id, orgAdmin.id, 4)
  ctx.skillHub.rate(skillSql.id, dev1.id, 5)
  ctx.skillHub.rate(skillCs.id, dev2.id, 4)
  ctx.skillHub.rate(skillData.id, orgAdmin.id, 5)
  ctx.skillHub.rate(skillOnboard.id, dev1.id, 4)

  // -- 模型路由台账（先于 Agent 注册：attrs.model 校验以模型目录为单一事实源，issue #8） ------
  // 演示形态 offline 待接入——诚实降级不伪装可调用，但内部采购成本参考费率照配（成本穿透口径）；
  // upsertModel 同时播种价格簿 model:<slug> 与 model:<slug>:input（#14 双米计价），计量事件才有计价规则
  ctx.modelGateway.upsertModel({ slug: 'deepseek-chat', displayName: 'DeepSeek Chat（待接入）', provider: 'deepseek', endpoint: '', apiKey: '', costCentsPerKTokens: 8, inputCostCentsPerKTokens: 2, status: 'offline' })
  ctx.modelGateway.upsertModel({ slug: 'qwen-plus', displayName: 'Qwen Plus（待接入）', provider: 'qwen', endpoint: '', apiKey: '', costCentsPerKTokens: 12, inputCostCentsPerKTokens: 3, status: 'offline' })
  ctx.modelGateway.upsertModel({ slug: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner（待接入）', provider: 'deepseek', endpoint: '', apiKey: '', costCentsPerKTokens: 16, inputCostCentsPerKTokens: 4, status: 'offline' })
  ctx.modelGateway.upsertModel({ slug: 'deepseek-coder', displayName: 'DeepSeek Coder（待接入）', provider: 'deepseek', endpoint: '', apiKey: '', costCentsPerKTokens: 8, inputCostCentsPerKTokens: 2, status: 'offline' })

  // -- Agent --------------------------------------------------------------
  const mkAgent = (input: Parameters<typeof ctx.agentRegistry.register>[0]) => {
    const result = ctx.agentRegistry.register(input)
    return result.agent as any
  }

  const agentFinance = mkAgent({
    name: '财务报告助手', slug: 'finance-report',
    attrs: {
      description: '自动汇总财务数据，生成月度经营分析报告初稿。',
      avatar: '💰', tags: ['财务', '报告'], category: '财务',
      model: 'deepseek-reasoner',
      skills: ['sql-review', 'metric-attribution'], mcpPermGroupIds: [], env: 'sandbox',
      riskLevel: 'medium', dataClass: 'confidential',
    },
    ownerId: dev1.id, ownerName: dev1.displayName, orgId: aiDept.id,
  })
  const agentCoder = mkAgent({
    name: '研发编码助手', slug: 'dev-coder',
    attrs: {
      description: '代码评审、SQL 审查与单测生成的研发搭档。',
      avatar: '🧑‍💻', tags: ['研发'], category: '研发',
      model: 'deepseek-coder',
      skills: [], mcpPermGroupIds: [], env: 'sandbox',
      riskLevel: 'low', dataClass: 'internal',
    },
    ownerId: dev2.id, ownerName: dev2.displayName, orgId: aiDept.id,
  })
  const agentCs = mkAgent({
    name: '智能客服', slug: 'smart-cs',
    attrs: {
      description: '7×24 客户咨询应答与工单流转。',
      avatar: '🎧', tags: ['客服'], category: '销售',
      model: 'deepseek-chat',
      skills: ['cs-soothe'], mcpPermGroupIds: [], env: 'shared',
      riskLevel: 'medium', dataClass: 'internal',
    },
    ownerId: orgAdmin.id, ownerName: orgAdmin.displayName, orgId: prodDept.id,
  })
  const agentHr = mkAgent({
    name: 'HR 问答助手', slug: 'hr-assistant',
    attrs: {
      description: '人事制度问答、假期查询与入职引导。',
      avatar: '📋', tags: ['HR'], category: '人事',
      model: 'deepseek-chat',
      skills: ['onboarding-guide'], mcpPermGroupIds: [], env: 'sandbox',
      riskLevel: 'low', dataClass: 'internal',
    },
    ownerId: orgAdmin.id, ownerName: orgAdmin.displayName, orgId: prodDept.id,
  })
  const agentAnalyst = mkAgent({
    name: '数据分析师', slug: 'data-analyst',
    attrs: {
      description: '指标归因、异动检测与 BI 报表生成。',
      avatar: '📊', tags: ['数据'], category: '运营',
      model: 'deepseek-reasoner',
      skills: ['metric-attribution'], mcpPermGroupIds: [], env: 'dedicated',
      riskLevel: 'medium', dataClass: 'internal',
    },
    ownerId: dev1.id, ownerName: dev1.displayName, orgId: aiDept.id,
  })
  const agentPilot = mkAgent({
    name: '汇率结算试点', slug: 'fx-pilot',
    attrs: {
      description: '跨境结算打款指令试点（灰度验证）。',
      avatar: '💱', tags: ['财务', '灰度'], category: '财务',
      model: 'deepseek-chat',
      // 身份纳管（AGENT_SSO_ENFORCE=1）：entryUrl 免登通道即满足上线门禁
      entryUrl: 'https://fx-pilot.example.com/chat',
      skills: [], mcpPermGroupIds: [], env: 'sandbox',
      riskLevel: 'high', dataClass: 'confidential', trialGroups: ['灰度试点组'],
    },
    ownerId: opsAdmin.id, ownerName: opsAdmin.displayName, orgId: beDept.id,
  })

  // 生命周期推进 + 依赖登记
  for (const [agent, skills] of [[agentFinance, [skillSql, skillData]], [agentCoder, [skillSql]], [agentCs, [skillCs]], [agentHr, [skillOnboard]], [agentAnalyst, [skillData, skillWeekly]]] as const) {
    for (const skill of skills) {
      ctx.skillHub.install(skill.id, skill.currentVersion, agent.id, admin.displayName)
    }
    ctx.agentRegistry.online(agent.id, admin.displayName)
  }
  ctx.agentRegistry.trial(agentPilot.id, admin.displayName, ['灰度试点组'])

  ctx.agentRegistry.bindUser(agentFinance.id, orgAdmin.id, admin.displayName)
  ctx.agentRegistry.bindUser(agentFinance.id, dev1.id, admin.displayName)
  ctx.agentRegistry.bindUser(agentCs.id, dev2.id, admin.displayName)
  ctx.agentRegistry.bindUser(agentHr.id, auditor.id, admin.displayName)

  // MCP 权限组授予 Agent
  ctx.mcpRegistry.createPermGroup({
    name: 'Agent·标准工具集', description: 'Agent 主体可用的 MCP 工具',
    policies: {
      [kb.id]: { allowedTools: '*', constraints: { readOnly: true } },
      [dw.id]: { allowedTools: ['dw_query_metrics', 'dw_run_sql'], constraints: {} },
      [ticket.id]: { allowedTools: ['ticket_search'], constraints: {} },
    },
    subjects: [
      { type: 'agent', id: agentFinance.id, name: agentFinance.name },
      { type: 'agent', id: agentAnalyst.id, name: agentAnalyst.name },
      { type: 'agent', id: agentCs.id, name: agentCs.name },
    ],
  })

  // -- 应用 --------------------------------------------------------------
  const mkApp = (input: Parameters<typeof ctx.appRegistry.register>[0]) => {
    const result = ctx.appRegistry.register(input)
    return result.app as any
  }
  const appCs = mkApp({
    name: '智能客服门户', slug: 'cs-portal',
    attrs: {
      description: '面向客户的在线客服门户，编排客服 Agent 与工单系统。',
      icon: '🛎️', appType: 'web', url: 'https://cs.yuanbingke.com', category: '销售',
      agentIds: [agentCs.id], channels: ['官网', '小程序'], publishVersion: 'v3.2.1',
      riskLevel: 'medium', dataClass: 'internal',
    },
    ownerId: orgAdmin.id, ownerName: orgAdmin.displayName, orgId: prodDept.id, agentIds: [agentCs.id],
  })
  const appBi = mkApp({
    name: '数据洞察 BI', slug: 'insight-bi',
    attrs: {
      description: '经营指标看板与归因分析工作台。',
      icon: '📈', appType: 'web', url: 'https://bi.yuanbingke.com', category: '运营',
      agentIds: [agentAnalyst.id, agentFinance.id], channels: ['内网'], publishVersion: 'v2.0.0',
      riskLevel: 'medium', dataClass: 'confidential',
    },
    ownerId: dev1.id, ownerName: dev1.displayName, orgId: aiDept.id, agentIds: [agentAnalyst.id, agentFinance.id],
  })
  const appHr = mkApp({
    name: 'HR 助手小程序', slug: 'hr-mini',
    attrs: {
      description: '员工自助：制度问答、假期查询、入职引导。',
      icon: '📱', appType: 'miniapp', url: 'https://m.yuanbingke.com/hr', category: '人事',
      agentIds: [agentHr.id], channels: ['企业微信'], publishVersion: 'v1.4.0',
      riskLevel: 'low', dataClass: 'internal',
    },
    ownerId: orgAdmin.id, ownerName: orgAdmin.displayName, orgId: prodDept.id, agentIds: [agentHr.id],
  })
  for (const app of [appCs, appBi, appHr]) {
    ctx.appRegistry.online(app.id, admin.displayName)
  }

  // W2-T4（MCP 治理契约 §10）应用能力绑定演示：HR 小程序 → HR 人事服务（required）、
  // 数据洞察 BI → 数据分析引擎（required）+ 企业知识库检索（非 required）。
  // 绑定走服务层方法（同步 ownerEntity 回写 app 归属 + capability 依赖边；幂等可重入——
  // 重复绑定返回现态）。与 mkMcp 五服务 id 对齐：ticket/fx 保持 platform 占位（治理待办样例）。
  try {
    ctx.appRegistry.bindCapability(appHr.id, { serviceId: hrSvc.id, required: true, boundBy: admin.displayName })
    ctx.appRegistry.bindCapability(appBi.id, { serviceId: dw.id, required: true, boundBy: admin.displayName })
    ctx.appRegistry.bindCapability(appBi.id, { serviceId: kb.id, required: false, boundBy: admin.displayName })
  } catch (error) {
    logger.warn('应用能力绑定演示数据失败（跳过）', error)
  }

  // -- 历史用量 / MCP 调用 ----------------------------------------------------
  // 成本不在此直写：下方计量历史经 usage.record 入正式管道，audit 消费方按价格簿
  // （mcp:*/model:* 的内部成本费率）归集出 audit:costs，工作台/FinOps 成本同源可溯。
  const rand = mulberry32(20260821)
  const usage = ctx.agentRegistry.usage()
  const appUsage = ctx.appRegistry.usage()
  const today = new Date()
  for (let day = 29; day >= 0; day--) {
    const date = new Date(today.getTime() - day * 86400_000).toISOString().slice(0, 10)
    for (const agent of [agentFinance, agentCoder, agentCs, agentHr, agentAnalyst]) {
      const calls = 40 + Math.floor(rand() * 160)
      const okCalls = calls - Math.floor(rand() * 8)
      const tokens = calls * (300 + Math.floor(rand() * 900))
      usage.insert({
        id: newId('agu'), agentId: agent.id, date,
        sessions: Math.floor(calls / 4), calls, okCalls, tokens,
        // DAU 提报（设计适配 2026-10-14）：台账/单位 DAU 成本的运营口径数据源
        dau: Math.max(8, Math.floor(calls / 6)),
        totalLatencyMs: calls * (200 + Math.floor(rand() * 600)),
      })
    }
    for (const [app, base] of [[appCs, 320], [appBi, 140], [appHr, 210]] as const) {
      const dau = base + Math.floor(rand() * 120) - 60 + Math.floor((27 - day) * 3)
      appUsage.insert({
        id: newId('apu'), appId: app.id, date,
        dau: Math.max(30, dau), sessions: Math.floor(dau * 1.6),
        avgDepth: Math.round((2 + rand() * 4) * 10) / 10,
        retention7: Math.round((0.3 + rand() * 0.3) * 100) / 100,
      })
    }
    for (const service of [kb, dw, ticket, hrSvc]) {
      const calls = 30 + Math.floor(rand() * 120)
      for (let i = 0; i < Math.min(calls, 6); i++) {
        const ok = rand() < service.stability
        ctx.mcpRegistry.calls().insert({
          id: newId('call'),
          at: `${date}T${String(8 + Math.floor(rand() * 12)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00.000Z`,
          serviceId: service.id, serviceName: service.name,
          tool: service.tools[Math.floor(rand() * service.tools.length)]!.name,
          callerType: rand() < 0.6 ? 'agent' : 'user',
          callerId: [agentFinance.id, agentAnalyst.id, agentCs.id][Math.floor(rand() * 3)]!,
          callerName: [agentFinance.name, agentAnalyst.name, agentCs.name][Math.floor(rand() * 3)]!,
          version: service.currentVersion,
          ok, status: ok ? 'ok' : 'error',
          latencyMs: 40 + Math.floor(rand() * 500),
          tokens: ok ? 200 + Math.floor(rand() * 1500) : 0,
          exec: 'demo',
        })
      }
    }
  }

  // -- 演示计量历史（经真实 usage 管道：可对账/可报表；零价快照口径，M0-2 起无钱包） ----
  // 设计适配（2026-10-14，规格 5.x 演示覆盖要求）：近 30 天 × 六类资产 × 多部门 的计量事件——
  // 台账 calls30d/tokens30d/cost30d、trend/heat、用量报表、模型网关 30d 消耗全部由此真实聚合；
  // 成本演示数值同源：事件经 audit 消费方按价格簿费率（mcp:* 15 分/千 tokens、
  // model:<slug> 内部采购费率）归集进 audit:costs，不再管道外自造数。
  // 确定性原则：所有数值由「资产:日期」锚定的 mulberry32 派生（同款防幂等键跨日重种冲突的写法），
  // 幂等键 seed:<resource>:<date> 绑定内容，重种 = 幂等重放；不使用裸随机。

  // 模型路由台账已在前（Agent 注册之前）登记——此处价格簿已就绪，计量事件直接计价
  /** 「键:日期」锚定的确定性数值（0-1），幂等键内容稳定跨重种。 */
  const dayRandom = (anchor: string): number => mulberry32([...anchor].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 0))()
  const seedUsage = (input: { resource: string; orgId: string; date: string; meters: Array<{ key: string; value: number; unit: string }> }) => {
    ctx.usage.record({
      org: input.orgId,
      subject: 'agent:seed-demo',
      principal: `org:${input.orgId}`,
      resource: input.resource,
      meters: input.meters,
      occurred_at: `${input.date}T12:00:00.000Z`,
      idempotency_key: `seed:${input.resource}:${input.date}`,
    })
  }
  const seedAgents = [agentFinance, agentCoder, agentCs, agentHr, agentAnalyst]
  const seedSkills = [skillWeekly, skillSql, skillCs, skillData, skillOnboard]
  const seedApps = [[appCs, prodDept.id], [appBi, aiDept.id], [appHr, prodDept.id]] as const
  for (let day = 29; day >= 0; day--) {
    const date = new Date(today.getTime() - day * 86400_000).toISOString().slice(0, 10)
    // MCP：tokens 计价（价格簿 mcp:* meter=tokens），calls 米随事件携带（台账调用数口径）
    for (const service of [kb, dw, ticket, hrSvc]) {
      const tokens = 20_000 + Math.floor(dayRandom(`${service.slug}:${date}`) * 160_000)
      const calls = 30 + Math.floor(dayRandom(`calls:${service.slug}:${date}`) * 150)
      seedUsage({
        resource: `mcp:${service.slug}`, orgId: service.orgId, date,
        meters: [
          { key: 'tokens', value: tokens, unit: 'token' },
          { key: 'calls', value: calls, unit: 'call' },
        ],
      })
    }
    // 模型路由：output_tokens 计价（价格簿 model:<slug>），归口组织轮转多部门
    for (const slug of ['deepseek-chat', 'qwen-plus'] as const) {
      const orgId = [aiDept.id, beDept.id, prodDept.id][Math.floor(dayRandom(`org:${slug}:${date}`) * 3)]!
      const inputTokens = 8_000 + Math.floor(dayRandom(`in:${slug}:${date}`) * 60_000)
      const outputTokens = 2_000 + Math.floor(dayRandom(`out:${slug}:${date}`) * 24_000)
      seedUsage({
        resource: `model:${slug}`, orgId, date,
        meters: [
          { key: 'input_tokens', value: inputTokens, unit: 'token' },
          { key: 'output_tokens', value: outputTokens, unit: 'token' },
          { key: 'calls', value: 10 + Math.floor(dayRandom(`calls:${slug}:${date}`) * 90), unit: 'call' },
        ],
      })
    }
    // Skill：calls 计价（skill:*），resource 用 skill ID（slug 含非 ASCII，见 skillhub 计量注释）
    for (const skill of seedSkills) {
      seedUsage({
        resource: `skill:${skill.id}`, orgId: skill.orgId, date,
        meters: [{ key: 'calls', value: 3 + Math.floor(dayRandom(`skill:${skill.id}:${date}`) * 25), unit: 'call' }],
      })
    }
    // AI 应用：calls 计价（app:*，零费率观测口径）
    for (const [app, orgId] of seedApps) {
      seedUsage({
        resource: `app:${app.slug}`, orgId, date,
        meters: [{ key: 'calls', value: 120 + Math.floor(dayRandom(`app:${app.slug}:${date}`) * 600), unit: 'call' }],
      })
    }
    // Agent 本体：calls 计价（agent:*，宿主数字员工可观测资源）
    for (const agent of seedAgents) {
      seedUsage({
        resource: `agent:${agent.id}`, orgId: agent.orgId, date,
        meters: [{ key: 'calls', value: 60 + Math.floor(dayRandom(`agent:${agent.id}:${date}`) * 240), unit: 'call' }],
      })
    }
    // NAS：calls 计价（nas:*，resource 用 NAS ID——与既有 nas 计量/台账口径一致）
    for (const nas of nasAssets) {
      seedUsage({
        resource: `nas:${nas.id}`, orgId: nas.orgId, date,
        meters: [{ key: 'calls', value: 15 + Math.floor(dayRandom(`nas:${nas.id}:${date}`) * 90), unit: 'call' }],
      })
    }
  }

  // -- 告警规则与告警 ----------------------------------------------------------
  ctx.audit.createAlertRule({ name: 'MCP 服务熔断', metric: 'mcp_unhealthy', operator: 'gt', threshold: 2, windowMinutes: 5, severity: 'critical', channels: ['dingtalk', 'email'], enabled: true, description: '健康探活连续失败超过阈值' })
  ctx.audit.createAlertRule({ name: '越权尝试检测', metric: 'permission_denied', operator: 'gt', threshold: 5, windowMinutes: 10, severity: 'critical', channels: ['dingtalk'], enabled: true, description: '同一主体 10 分钟内越权超过 5 次' })
  ctx.audit.createAlertRule({ name: 'Agent 调用突增', metric: 'agent_burst', operator: 'gt', threshold: 120, windowMinutes: 10, severity: 'warning', channels: ['dingtalk'], enabled: true, description: 'Agent 10 分钟调用量异常' })
  ctx.audit.fire({
    severity: 'warning',
    title: 'Skill「客诉安抚话术库」版本 1.0.2 待更新提醒',
    message: '该版本引用的话术模板已过期，建议升级到 1.0.3。',
    resourceType: 'skill',
    resourceId: skillCs.id,
  })
  ctx.audit.fire({
    severity: 'info',
    title: '钉钉通讯录同步完成',
    message: '全量同步成功：新建 0，更新 2，冲突 0，离职冻结 0。',
  })

  // -- 待办审批（工作台演示）----------------------------------------------------
  ctx.agentRegistry.requestOnline(agentPilot.id, { id: opsAdmin.id, name: opsAdmin.displayName })
  void skillWeb
  void auditor

  // 连接器纳管演示数据（env 门禁：OOMOL_CONNECT_DEMO_SEED=1 时才注入——
  // 网关指向 OOMOL_CONNECT_STUB_URL（selftest stub / 真实 sidecar），避免生产基线出现死连接噪音）
  seedConnectorDemo(ctx)

  logger.info('演示数据初始化完成')
}

/** 连接器纳管演示种子：网关引用 + no_auth 虚拟连接 + 只读权限组模板（dev-plan-connector 工作单 #13）。 */
function seedConnectorDemo(ctx: Context): void {
  if (process.env.OOMOL_CONNECT_DEMO_SEED !== '1') return
  const hub = ctx.connectorHub
  if (hub.gateways().all().length === 0) {
    void hub.configureGateway({
      baseUrl: process.env.OOMOL_CONNECT_STUB_URL ?? 'http://127.0.0.1:7363',
      adminToken: 'env:OOMOL_CONNECT_ADMIN_TOKEN',
      autoCatalogSyncMinutes: 0,
    }, 'demo-seed').catch(() => undefined)
  }
  const rootOrg = ctx.iam.orgs().findOne((org) => org.parentId === null)
  if (!rootOrg) return
  const existing = hub.connections().findOne((item) => item.provider === 'hackernews' && item.ownerOrgId === rootOrg.id)
  if (!existing) {
    void hub.createConnection({
      orgId: rootOrg.id,
      actor: { id: 'system', name: 'demo-seed' },
      provider: 'hackernews',
      aliasSuffix: 'seed-noauth',
      authType: 'no_auth',
    }).catch(() => undefined)
  }
  // 告警规则播种（③ 运营口径）：错误率 critical + 延迟 warning——幂等播种，不覆盖运营已调阈值
  if (!ctx.audit.alertRules().findOne((item) => item.metric === 'connector_error_rate')) {
    ctx.audit.createAlertRule({
      name: '连接器调用错误率', metric: 'connector_error_rate', operator: 'gt',
      threshold: 5, windowMinutes: 10, severity: 'critical', channels: ['dingtalk'], enabled: true,
      description: '10 分钟内 invoke 失败/自动恢复仍失败/审计补记计分超阈',
    })
  }
  if (!ctx.audit.alertRules().findOne((item) => item.metric === 'connector_latency')) {
    ctx.audit.createAlertRule({
      name: '连接器调用延迟', metric: 'connector_latency', operator: 'gt',
      threshold: 3000, windowMinutes: 10, severity: 'warning', channels: ['dingtalk'], enabled: true,
      description: '单次调用耗时超 3s（p95 运营关注口径；evaluateAlerts 逐调用评估）',
    })
  }
  const group = hub.permGroups().findOne((item) => item.name === '连接器只读模板（演示）')
  if (!group && rootOrg) {
    const everyoneGroup = ctx.iam.groups().findOne((item) => item.type === 'static')
    try {
      hub.createPermGroup({
        name: '连接器只读模板（演示）',
        description: 'riskCap=read + readOnly 的安全起步模板：仅允许读取类 action',
        orgId: rootOrg.id,
        policies: { hackernews: { allowedActions: ['hackernews.*'], riskCap: 'read', constraints: { readOnly: true } } },
        subjects: [...(everyoneGroup ? [{ type: 'user_group' as const, id: everyoneGroup.id, name: everyoneGroup.name }] : [])],
        rateLimitPerMin: 60,
        // precheckCents 种子写入已废止（M0-2 billing 下线，OPT-P0-02）：legacy 字段运行时不读
      })
    } catch { /* 种子非关键路径：缺组织/成员时静默跳过 */ }
  }
}

/** 确定性伪随机（种子固定，保证每次演示数据一致）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
