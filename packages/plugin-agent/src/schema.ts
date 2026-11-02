/**
 * Agent 本体属性表与生命周期声明（方案 §5.1 / §5.6）。
 * schema 同时驱动：控制台注册表单（分「基本/技术/治理」三组）、属性校验、详情页展示。
 */
import type { ResourceTypeSpec } from '../../platform-core/src/index.ts'
import { ASSET_CATEGORIES } from '../../platform-core/src/index.ts'

/** 各资产板块统一业务分类选项（口径见 platform-core/src/taxonomy.ts）。 */
const CATEGORY_OPTIONS = ASSET_CATEGORIES.map((value) => ({ value, label: value }))

export const AGENT_TYPE_SPEC: ResourceTypeSpec = {
  type: 'agent',
  label: 'Agent',
  plugin: 'agent',
  idPrefix: 'agt',
  schema: {
    groups: [
      { key: 'basic', label: '基本属性', description: '身份与归属信息' },
      { key: 'tech', label: '技术属性', description: '模型、提示词与能力依赖' },
      { key: 'governance', label: '治理属性', description: '风险与数据密级（上线审批依据）' },
      { key: 'collab', label: '协作属性', description: 'A2A 协作面（Agent Card / UHP 执行驱动）' },
    ],
    fields: [
      { key: 'description', label: '描述', type: 'text', group: 'basic', required: true, placeholder: '这个 Agent 做什么、适用什么场景', hint: '展示在市场与详情页' },
      { key: 'avatar', label: '头像', type: 'string', group: 'basic', defaultValue: '🤖', hint: '一个 emoji 即可' },
      { key: 'category', label: '业务分类', type: 'enum', group: 'basic', defaultValue: '其他', options: CATEGORY_OPTIONS, hint: '各资产板块统一口径（财务/行政/人事/销售/运营/战略/生产/研发/质量/制造/其他）；列表页按此筛选' },
      { key: 'tags', label: '标签', type: 'tags', group: 'basic', defaultValue: [] },
      // 模型目录单一事实源（issue #8）：不再维护静态枚举——可选值 = 模型网关目录（modelgw:models），
      // 登记/编辑时校验存在性，上线门禁复核；控制台表单从目录动态取选项。目录中不存在的 slug 一律 400。
      { key: 'model', label: '底层模型', type: 'string', group: 'tech', required: true, placeholder: '模型目录中的 slug，如 deepseek-chat', hint: '取值 = 模型网关目录（GET /api/modelgw/models）已登记的 slug；未登记的模型在保存时被拒绝' },
      { key: 'entryUrl', label: '交互界面地址', type: 'url', group: 'tech', placeholder: 'https://…', hint: 'Agent 面向用户的真实交互入口；接入后由 Agent 凭自身凭证提报（接入义务），控制台据此提供直达入口' },
      // headless 第三纳管通道（2026-10-31）：Work Body 等纯后台执行体没有任何交互界面，
      // 既签发不了带回调的 OIDC 客户端、也没有 entryUrl 可登记——显式声明后上线门禁凭
      // 已颁发的机器身份凭证放行（见 AgentRegistryService.assertOnlineGate；AGENT_SSO_ENFORCE=oidc 不放行）。
      { key: 'headless', label: '无交互界面（纯后台）', type: 'boolean', group: 'tech', defaultValue: false, hint: '纯后台执行体声明（无任何面向用户的交互界面，如 Work Body / 定时任务型）：声明后上线门禁凭已颁发的机器身份凭证放行，免签发 OIDC 客户端与 entryUrl；AGENT_SSO_ENFORCE=oidc 严格模式不适用' },
      { key: 'skills', label: '关联 Skill', type: 'tags', group: 'tech', defaultValue: [], hint: '从市场安装后自动回填' },
      { key: 'mcpPermGroupIds', label: 'MCP 权限组', type: 'tags', group: 'tech', defaultValue: [], hint: '授予该 Agent 的工具访问范围' },
      { key: 'riskLevel', label: '风险等级', type: 'enum', group: 'governance', required: true, options: [
        { value: 'low', label: '低', hint: '只读检索类' },
        { value: 'medium', label: '中', hint: '可写业务数据' },
        { value: 'high', label: '高', hint: '外联或资金相关' },
      ] },
      { key: 'dataClass', label: '数据密级', type: 'enum', group: 'governance', requiredForOnline: true, options: [
        { value: 'public', label: '公开', hint: '可对外展示' },
        { value: 'internal', label: '内部', hint: '仅限员工可见' },
        { value: 'confidential', label: '机密', hint: '机密：Agent 处理需审批（业务审批先行，处理前挂审批单）。业务语义说明：本枚举是 Agent 业务密级口径，与模型渠道分级（modelgw 的 public/internal/secret）是两套同名不同义的口径，同名键含义不互等——到统一业务密级（platform-core WorkDataClass）的映射必须由 workforce 适配器显式完成，禁止按名直译或静默回落（D14）' },
        { value: 'secret', label: '绝密', hint: '绝密：禁止 Agent 直接处理（模型/资源调用前直接拒绝，不存在「审批后处理」）。业务语义说明：本枚举是 Agent 业务密级口径，与模型渠道分级（modelgw 的 public/internal/secret）是两套同名不同义的口径，同名键含义不互等——到统一业务密级（platform-core WorkDataClass）的映射必须由 workforce 适配器显式完成，禁止按名直译或静默回落（D14）' },
      ], hint: '高密级资源的调用需额外审批（方案 §七）。注意：本字段是 Agent 业务密级口径，与模型渠道分级（modelgw：public/internal/secret）是两套同名不同义的枚举，由 workforce 适配器显式映射（D14）；绝密=禁止 Agent 直接处理，机密=Agent 处理需审批' },
      { key: 'autonomy', label: '自治级别', type: 'enum', group: 'governance', defaultValue: 'A0', options: [
        { value: 'A0', label: 'A0 提示', hint: '仅建议/提示，不执行动作' },
        { value: 'A1', label: 'A1 执行', hint: '可执行低风险动作（人在环）' },
        { value: 'A2', label: 'A2 自主', hint: '自主执行并事后报告' },
        { value: 'A3', label: 'A3 协商', hint: '跨 Agent 协商自治（A2A 双向）' },
      ], hint: '自治级别协商（PRD §7.6）：面板数字同事卡展示位的数据源（IAW 交接 7-1）' },
      { key: 'runtime', label: '运行时', type: 'enum', group: 'tech', defaultValue: 'dsh', options: [
        { value: 'dsh', label: 'dsh（平台原生）' },
        { value: 'hermes', label: 'Hermes' },
        { value: 'openclaw', label: 'OpenClaw' },
        { value: 'workbuddy', label: 'WorkBuddy' },
        { value: 'external', label: '外部运行时' },
      ], hint: 'A2A 跨运行时互调的登记维度（IAW 交接 7-1）' },
      { key: 'trialGroups', label: '试运行用户组', type: 'tags', group: 'governance', hint: '试运行阶段限定可用的用户组' },
      // R7 组织化（Agent 组织架构）：汇报线与心跳调度参数。全部选填、不设 requiredForOnline——
      // 既有 Agent 不带这些字段照常流转；managerId 填另一 Agent 的 ID，环校验见
      // AgentRegistryService.assertOrgChartAcyclic（create/update 涉及 managerId 时强制校验）。
      { key: 'orgRole', label: '组织角色', type: 'enum', group: 'governance', options: [
        { value: 'ceo', label: 'CEO' },
        { value: 'cto', label: 'CTO' },
        { value: 'manager', label: '经理' },
        { value: 'engineer', label: '工程师' },
        { value: 'analyst', label: '分析师' },
      ], hint: 'Agent 在组织架构中的角色（CEO/CTO/经理/工程师/分析师）' },
      { key: 'rank', label: '职级', type: 'string', group: 'governance', placeholder: '如 L4/P6', hint: '自由文本' },
      { key: 'managerId', label: '汇报上级 Agent', type: 'string', group: 'governance', placeholder: '另一 Agent 的 ID（agt-…）', hint: '汇报线（组织下达与上浮通道），填另一 Agent 的 ID' },
      { key: 'heartbeatIntervalMinutes', label: '心跳间隔（分钟）', type: 'number', group: 'governance', hint: '执行中枢按此间隔定时唤醒该 Agent 拉取待办（0 或留空=不参与心跳调度）' },
      // C4 A2A/UHP 协作面（additive，红线 2 结构变更登记见 docs/contract-c3-agent-a2a-v2-release-notes.md）：
      // 存量登记无这些字段按缺省口径处理（退化为 v1 点名调用行为），不设 requiredForOnline。
      { key: 'a2aDataClassCeiling', label: '协作密级天花板', type: 'enum', group: 'collab', defaultValue: 'internal', options: [
        { value: 'public', label: '公开', hint: '仅可承接公开级任务' },
        { value: 'internal', label: '内部', hint: '可承接内部级任务（默认）' },
        { value: 'secret', label: '秘密（渠道口径）', hint: '可承接秘密级任务（仍受模型渠道分级锁死约束）' },
      ], hint: '该员工可接收的最高任务数据密级（A2A 协作治理第 3 项检查；渠道口径 public/internal/secret，与 Agent 业务密级 dataClass 是两套口径，不互译）' },
      { key: 'uhpHarnessRef', label: 'UHP harness 引用', type: 'string', group: 'collab', placeholder: 'UHP 注册表中的 harness id（留空=按本 Agent attrs 临时投影）', hint: '指向 plugin-uhp 的 configured harness 注册项（模型渠道组/步数预算/工具白名单）；留空时 UHP 按本 Agent 属性临时投影执行' },
      { key: 'uhpSessionPolicy', label: '会话续接策略', type: 'enum', group: 'collab', defaultValue: 'task-bound', options: [
        { value: 'task-bound', label: '任务级（结束即焚）', hint: '会话生命周期与任务绑定，任务结束会话不复用' },
        { value: 'employee-bound', label: '员工级（长期会话）', hint: '同一调用方对该员工的多次任务共享长期会话上下文' },
      ], hint: 'UHP 执行会话的续接策略（协作方案 §5.1）' },
    ],
  },
  lifecycle: {
    initial: 'draft',
    states: [
      { key: 'draft', label: '开发中', tone: 'muted' },
      { key: 'trial', label: '试运行', tone: 'info' },
      { key: 'online', label: '已上线', tone: 'ok' },
      { key: 'offline', label: '已下线', tone: 'warn' },
      { key: 'archived', label: '已归档', tone: 'muted', terminal: true },
    ],
    transitions: [
      {
        action: 'submit_trial', label: '进入试运行', from: ['draft'], to: 'trial',
        guard: (entity) => {
          const groups = entity.attrs['trialGroups']
          if (!Array.isArray(groups) || groups.length === 0) return '试运行需指定限定用户组（trialGroups）'
          return undefined
        },
      },
      { action: 'online', label: '上线', from: ['draft', 'trial'], to: 'online', approval: true },
      { action: 'offline', label: '下线', from: ['trial', 'online'], to: 'offline', approval: true },
      { action: 'retrial', label: '恢复试运行', from: ['offline'], to: 'trial' },
      { action: 'archive', label: '归档', from: ['offline'], to: 'archived' },
    ],
  },
}
