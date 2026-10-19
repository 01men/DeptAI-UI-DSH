/**
 * 制造工具箱 —— 版本化 Skill 注册表（自「制造业 AI 工具集」server/skills.ts 并入）。
 *
 * 铁律（源项目 docs/skill-quality.md，并入后不变）：候选 Skill 不会因为「能安装、能返回文本、
 * 市场有排名」就进入普通调用入口。本注册表只登记项目自撰写的提示词内核——不加载、不执行
 * 任何上传的指令文本（提示注入的第一道边界）。
 */

export type Skill = {
  version: string
  origin: 'project-authored'
  license: string
  /** 固定章节序列：模型输出必须按此顺序齐全，缺项或乱序即判不合格。 */
  sections: string[]
  instructions: string
}

export const skills: Record<string, Skill> = {
  'sop-writer': {
    version: '1.1.0',
    origin: 'project-authored',
    license: 'project-internal',
    sections: ['目的与范围', '准备条件', '操作步骤', '质量检查', '异常处理'],
    instructions: '你是制造业标准作业指导书编辑。只使用用户提供的技术参数。扭矩、温度、安全措施等缺失参数必须列为待工艺工程师确认。不得编造标准编号或声称已审批。步骤中的未知参数用待确认占位，禁止自行选择数值。',
  },
  'root-cause': {
    version: '1.1.0',
    origin: 'project-authored',
    license: 'project-internal',
    sections: ['已知事实', '原因假设', '验证计划', '临时遏制', '长期改善'],
    instructions: '你是制造业质量改善助手。使用5 Why形成可证伪假设。严格区分已知事实、原因假设、需要采集的证据和验证实验。缺少证据时不得宣称找到根因。每个行动标注建议角色及验收方法。临时遏制与长期改善均为建议，禁止声称已执行。',
  },
  'rfq-writer': {
    version: '1.1.0',
    origin: 'project-authored',
    license: 'project-internal',
    sections: ['物料规格', '数量与交付', '质量文件', '报价口径', '供应商回复要求'],
    instructions: '你是制造业采购需求编辑。不虚构价格、供应商、标准或承诺。数量、交期、规格没有明确提供时必须标为待确认，不自动引用行业惯例补值。',
  },
}

export const skillIds = Object.keys(skills)