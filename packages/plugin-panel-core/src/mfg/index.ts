/**
 * 制造工具箱（MFG Toolkit）—— 自「制造业 AI 工具集」并入 01门 的域模块（2026-10-19）。
 *
 * 并入来源与边界登记于 docs/plan-mfg-toolkit-fusion-20261019.md。
 * 对外导出面：目录与协议（types/catalog）、执行引擎（engine）、表格内核（tabular）、
 * 质量门禁与放行（quality）、评估（evaluate）、选题清单（roadmap）、导出（export）、装配（module）。
 */
export * from './types.ts'
export * from './catalog.ts'
export * from './tabular.ts'
export * from './skills.ts'
export * from './quality.ts'
export * from './export.ts'
export * from './roadmap.ts'
export * from './evaluate.ts'
export * from './engine.ts'
export * from './module.ts'