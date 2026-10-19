/**
 * 制造工具箱 —— 工具注册表（单一注册入口；自「制造业 AI 工具集」src/core/catalog.ts 并入）。
 *
 * 新增已实现工具只改本文件 + engine.ts 的分支；网页表单、导入模板、MCP/工具面、
 * 执行期校验全部由本定义生成（源项目设计原则，并入后语义不变）。
 */
import type { Field, ToolDefinition, Category } from './types.ts'

const n = (key: string, label: string, value: number, unit?: string, min = 0, max?: number): Field => ({
  key, label, type: 'number', default: value, ...(unit ? { unit } : {}), min, ...(max !== undefined ? { max } : {}),
})
const t = (key: string, label: string, value: string): Field => ({ key, label, type: 'textarea', default: value })

export const tools: ToolDefinition[] = [
  { id: 'oee', title: '设备综合效率 OEE', subtitle: '从时间、性能与质量三个维度，看清设备的真实产能。', category: '生产运营', icon: 'gauge', color: 'blue', mode: 'calculation', tags: ['效率分析', '可视化'], fields: [n('planned', '计划生产时间', 480, 'min', 1), n('running', '实际运行时间', 420, 'min'), n('cycle', '理想单件周期', 0.5, 'min/件', 0.001), n('total', '实际生产数量', 760, '件', 1), n('good', '合格数量', 735, '件')] },
  { id: 'cpk', title: '过程能力分析', subtitle: '计算 Cp / Cpk，识别过程波动与规格中心偏移。', category: '质量工程', icon: 'chart', color: 'purple', mode: 'calculation', tags: ['Cp / Cpk', '统计分析'], fields: [n('lsl', '规格下限 LSL', 9.8, 'mm', -1e9), n('usl', '规格上限 USL', 10.2, 'mm', -1e9), n('mean', '过程均值', 10.02, 'mm', -1e9), n('sigma', '组内标准差 σ', 0.04, 'mm', 0.000001)] },
  { id: 'takt', title: '节拍与产能测算', subtitle: '从客户需求出发，找到产线的目标节拍与产能缺口。', category: '生产运营', icon: 'timer', color: 'orange', mode: 'calculation', tags: ['产能规划', '节拍'], fields: [n('available', '净可用生产时间', 420, 'min/班', 1), n('demand', '每班客户需求', 800, '件', 1), n('cycle', '当前单件周期', 0.6, 'min/件', 0.001)] },
  { id: 'pareto', title: '缺陷帕累托分析', subtitle: '按缺陷频次排序，定位最值得优先改善的问题。', category: '质量工程', icon: 'bars', color: 'rose', mode: 'calculation', tags: ['80/20 分析', '数据导入'], fields: [t('data', '缺陷名称, 数量（每行一条）', '表面划伤,42\n尺寸偏差,28\n装配不良,15\n色差,9\n其他,6')], accepts: ['text/plain', 'text/csv'] },
  { id: 'eoq', title: '经济订货量 EOQ', subtitle: '平衡采购与持有成本，计算更合适的补货批量。', category: '供应链', icon: 'boxes', color: 'teal', mode: 'calculation', tags: ['库存优化', '采购'], fields: [n('demand', '年度需求量', 12000, '件', 1), n('orderCost', '每次订货成本', 200, '元/次', 0.01), n('holdingCost', '单位年度持有成本', 8, '元/件·年', 0.01)] },
  { id: 'material', title: '材料用量与重量', subtitle: '用尺寸和密度估算实心矩形毛坯重量，交互查看三维结构。', category: '研发设计', icon: 'box', color: 'blue', mode: 'calculation', tags: ['3D 预览', '用量估算'], fields: [n('length', '长度', 240, 'mm', 0.1), n('width', '宽度', 120, 'mm', 0.1), n('height', '高度', 60, 'mm', 0.1), n('density', '材料密度', 7.85, 'g/cm³', 0.001), n('quantity', '需求数量', 20, '件', 1)], accepts: ['application/vnd.ybkk.mfg-material+json'] },
  { id: 'fmea', title: 'FMEA 风险优先级', subtitle: '计算风险优先数 RPN，辅助排列改善顺序。', category: '质量工程', icon: 'shield', color: 'orange', mode: 'calculation', tags: ['风险评估', 'RPN'], fields: [n('severity', '严重度 S', 8, '1–10', 1, 10), n('occurrence', '发生度 O', 4, '1–10', 1, 10), n('detection', '探测度 D', 6, '1–10', 1, 10)] },
  { id: 'roi', title: '自动化投资测算', subtitle: '统一口径估算净年度收益和静态投资回收期。', category: '生产运营', icon: 'trend', color: 'teal', mode: 'calculation', tags: ['投资回收', '成本收益'], fields: [n('investment', '一次性总投资', 600000, '元', 0.01), n('saving', '年度节省总额', 240000, '元/年'), n('operating', '年度新增运营成本', 40000, '元/年')] },
  { id: 'bom-diff', title: 'BOM 版本差异核对', subtitle: '按物料编码对比两个版本，识别新增、删除与用量变化。', category: '研发设计', icon: 'layers', color: 'purple', mode: 'calculation', tags: ['版本对比', '数据导入'], fields: [t('before', '旧版 BOM（code,quantity）', 'code,quantity\nM001,4\nM002,2\nM003,1'), t('after', '新版 BOM（code,quantity）', 'code,quantity\nM001,6\nM002,2\nM004,1')] },
  { id: 'shortage', title: '物料齐套与缺料检查', subtitle: '核对物料需求与可用库存，列出明确的缺口数量。', category: '供应链', icon: 'boxes', color: 'orange', mode: 'calculation', tags: ['齐套检查', '数据导入'], fields: [t('data', '物料清单（code,required,available）', 'code,required,available\nM001,120,100\nM002,80,100\nM003,30,0')] },
  { id: 'aging', title: '应收应付逾期分层', subtitle: '以到期日为基准，按逾期天数汇总未结余额。', category: '经营财务', icon: 'chart', color: 'teal', mode: 'calculation', tags: ['逾期分析', '数据导入'], fields: [{ key: 'asOf', label: '统计基准日（YYYY-MM-DD）', type: 'text', default: '2026-10-19' }, t('data', '未结单据（id,dueDate,amount）', 'id,dueDate,amount\nAR001,2026-10-30,12000\nAR002,2026-10-01,8000\nAR003,2026-08-01,15000')] },
  { id: 'maintenance', title: 'MTBF / MTTR 测算', subtitle: '用运行与维修记录计算平均故障间隔和平均修复时间。', category: '设备运维', icon: 'gauge', color: 'blue', mode: 'calculation', tags: ['设备可靠性', '维修分析'], fields: [n('uptime', '观察期累计运行时间', 720, 'h'), n('failures', '观察期故障次数', 3, '次', 1), n('repair', '累计主动维修时间', 9, 'h')] },
  { id: 'quote-compare', title: '供应商报价同口径比较', subtitle: '统一数量、税率与运费，比较含税到货总成本。', category: '供应链', icon: 'bars', color: 'teal', mode: 'calculation', tags: ['比价分析', '数据导入'], fields: [n('quantity', '采购数量', 1000, '件', 1), t('data', '报价（supplier,price,taxRate,freight）', 'supplier,price,taxRate,freight\n供应商A,12.5,0.13,200\n供应商B,12.8,0.13,0\n供应商C,12.1,0.13,800')] },
  { id: 'sop', title: '标准作业指导书', subtitle: '描述工序与关键要求，整理为可审阅的标准作业指导书。', category: '知识与文档', icon: 'file', color: 'purple', mode: 'model', tags: ['AI + Skill', '文档生成'], skill: 'sop-writer', fields: [t('context', '工序、设备、操作步骤与质量要求', '工序：铝合金外壳装配。设备：定扭电批。要求：M3 螺钉交叉锁付，扭矩由工艺工程师确认；操作前检查外观，完成后记录检验结果。')] },
  { id: 'root-cause', title: '异常根因分析', subtitle: '结合 5 Why 分析路径，生成待验证的原因假设和行动项。', category: '质量工程', icon: 'sparkles', color: 'rose', mode: 'model', tags: ['AI + Skill', '5 Why'], skill: 'root-cause', fields: [t('context', '问题现象、数据与已采取的措施', '注塑车间本周产品毛边不良率由 1.2% 升至 3.8%，集中在夜班，近期更换过一批原料。请整理排查路径，区分事实与假设。')] },
  { id: 'rfq', title: '采购询价需求', subtitle: '把零散采购描述整理成结构清晰、可比较的询价需求。', category: '供应链', icon: 'file', color: 'teal', mode: 'model', tags: ['AI + Skill', '采购文档'], skill: 'rfq-writer', fields: [t('context', '采购物料、规格、数量、交期与约束', '需要采购 200 个铝合金外壳，材质 6061，表面阳极氧化，交期两周，要求提供材质证明和首件检验报告。')] },
]

export const categories: readonly Category[] = ['生产运营', '质量工程', '研发设计', '供应链', '设备运维', '经营财务', '知识与文档'] as const

/** 全部工具统一检索用文本（标题/副标题/标签/id）。 */
export const toolSearchText = (tool: ToolDefinition): string =>
  `${tool.title} ${tool.subtitle} ${tool.tags.join(' ')} ${tool.id} ${tool.category}`.toLowerCase()

export const findTool = (id: string): ToolDefinition | undefined => tools.find((tool) => tool.id === id)

/** 按 Skill 标识反查工具（评估与放行面用：Skill 注册键 ≠ 工具 id）。 */
export const findToolBySkill = (skill: string): ToolDefinition | undefined =>
  tools.find((tool) => tool.skill === skill)