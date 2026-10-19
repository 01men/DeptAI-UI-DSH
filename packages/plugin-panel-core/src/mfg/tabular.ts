/**
 * 制造工具箱 —— 表格类工具共用内核（自「制造业 AI 工具集」server/tabular.ts 并入）。
 *
 * 为什么自写 CSV 解析而不引 csv-parse：随附包装机形态零运行时依赖（见 validate.ts 头注）。
 * 语义与源项目保持等价，且守住它刻意设计的严格面：
 *   - BOM 头剥离、空行跳过、字段 trim；
 *   - RFC4180 双引号包裹与 "" 转义（源项目断言「带逗号的供应商名」依赖此语义）；
 *   - 表头必须逐字匹配；行数 1–1000；列数不符或空值即拒；
 *   - 唯一键重复即拒（DUPLICATE_KEY）——防「先查后插」类静默错算。
 */
import type { Block } from './types.ts'
import { fail, requireCondition } from './validate.ts'

/** CSV 解析（RFC4180 子集）：支持引号包裹、内嵌逗号/换行、"" 转义、BOM 与 CRLF。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = 0
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  while (index < source.length) {
    const char = source[index]!
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 2; continue }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') { quoted = true; index += 1; continue }
    if (char === ',') { row.push(field); field = ''; index += 1; continue }
    if (char === '\r') { index += 1; continue }
    if (char === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
      index += 1
      continue
    }
    field += char
    index += 1
  }
  if (quoted) fail('TABLE_INVALID', '表格引号未闭合，请检查 CSV 格式')
  row.push(field)
  rows.push(row)
  // 空行（唯一空字段）跳过，与源项目 skip_empty_lines 同语义
  return rows.filter((cells) => !(cells.length === 1 && cells[0]!.trim() === ''))
}

/** 读取并校验表格：表头逐字匹配、行数与列数、空值一律拒绝。 */
export function readTable(text: string, columns: string[]): Record<string, string>[] {
  let parsed: string[][]
  try {
    parsed = parseCsv(text)
  } catch (error) {
    if (error instanceof Error && error.name === 'MfgError') throw error
    fail('TABLE_INVALID', '表格格式错误')
  }
  if (parsed.length < 2 || parsed.length > 1001) fail('TABLE_INVALID', '请提供表头和 1–1000 条数据')
  if (parsed[0]!.map((cell) => cell.trim()).join(',') !== columns.join(',')) {
    fail('TABLE_INVALID', `表头必须为 ${columns.join(',')}`)
  }
  return parsed.slice(1).map((cells, index) => {
    if (cells.length !== columns.length || cells.some((cell) => cell.trim() === '')) {
      fail('TABLE_INVALID', `第 ${index + 2} 行有空值或列数不正确`)
    }
    return Object.fromEntries(columns.map((key, position) => [key, cells[position]!.trim()]))
  })
}

const num = (value: string, label: string, min = 0): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min) fail('TABLE_INVALID', `${label}须为不小于 ${min} 的有限数字`)
  return parsed
}

const r = (value: number): number => Number(value.toFixed(2))

const unique = (rows: Record<string, string>[], key: string): void => {
  if (new Set(rows.map((row) => row[key])).size !== rows.length) {
    fail('DUPLICATE_KEY', `${key} 不能重复；请先按编码/单据汇总或拆分编码`)
  }
}

/** 严格日期解析（YYYY-MM-DD，且必须是真实存在的日期）。 */
function day(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_DATE', '日期必须使用 YYYY-MM-DD 格式')
  const parsed = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail('INVALID_DATE', `无效日期 ${value}`)
  }
  return parsed
}

/** 表格类工具执行入口（bom-diff / shortage / aging / maintenance / quote-compare）。 */
export function runTabular(id: string, input: Record<string, unknown>): { blocks: Block[]; warnings: string[] } {
  const warnings: string[] = []
  let blocks: Block[] = []
  if (id === 'bom-diff') {
    const a = readTable(String(input.before), ['code', 'quantity'])
    const b = readTable(String(input.after), ['code', 'quantity'])
    unique(a, 'code'); unique(b, 'code')
    const before = new Map(a.map((row) => [row.code!, num(row.quantity!, '用量')]))
    const after = new Map(b.map((row) => [row.code!, num(row.quantity!, '用量')]))
    const changes = [...new Set([...before.keys(), ...after.keys()])]
      .map((code) => ({ code, old: before.get(code), next: after.get(code) }))
      .filter((item) => item.old !== item.next)
    blocks = [
      { type: 'metrics', items: [{ label: '差异物料', value: changes.length, unit: '项' }, { label: '新版物料种数', value: after.size, unit: '种' }] },
      {
        type: 'table',
        title: 'BOM 差异明细',
        columns: ['物料编码', '旧版用量', '新版用量', '变化'],
        rows: changes.map((item) => [
          item.code,
          item.old ?? '不存在',
          item.next ?? '不存在',
          item.old === undefined ? '新增' : item.next === undefined ? '删除' : `用量 ${r(item.next - item.old) >= 0 ? '+' : ''}${r(item.next - item.old)}`,
        ]),
      },
      { type: 'text', title: '比较范围', content: '仅对比物料编码及用量，不解析图纸，不验证物料规格、版本替代关系或工程适用性。编码必须唯一。' },
    ]
  } else if (id === 'shortage') {
    const rows = readTable(String(input.data), ['code', 'required', 'available'])
    unique(rows, 'code')
    const values = rows.map((row) => ({ code: row.code!, required: num(row.required!, '需求量'), available: num(row.available!, '可用量') }))
    const shortage = values.filter((item) => item.available < item.required)
    blocks = [
      { type: 'metrics', items: [{ label: '缺料种数', value: shortage.length, unit: '种', tone: shortage.length ? 'warn' : 'good' }, { label: '物料项满足率', value: r((values.length - shortage.length) / values.length * 100), unit: '%' }] },
      { type: 'table', title: '逐项齐套检查', columns: ['物料编码', '需求量', '可用量', '缺口'], rows: values.map((item) => [item.code, item.required, item.available, r(Math.max(0, item.required - item.available))]) },
      { type: 'text', title: '计算口径', content: '逐项缺口 = max(需求 − 可用量, 0)。项满足率按物料种数计算，不是订单齐套率。请先从可用量扣除已预留、冻结及不合格库存。' },
    ]
  } else if (id === 'aging') {
    const date = day(String(input.asOf))
    const rows = readTable(String(input.data), ['id', 'dueDate', 'amount'])
    unique(rows, 'id')
    const buckets = ['未逾期', '逾期1–30天', '逾期31–60天', '逾期61–90天', '逾期90天以上'].map((label) => ({ label, value: 0 }))
    const detail = rows.map((row) => {
      const due = day(row.dueDate!)
      const days = Math.max(0, Math.floor((date - due) / 86400000))
      const amount = num(row.amount!, '未结余额')
      const index = days === 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4
      buckets[index]!.value += amount
      return [row.id!, row.dueDate!, days, amount, buckets[index]!.label]
    })
    const total = buckets.reduce((sum, item) => sum + item.value, 0)
    blocks = [
      { type: 'metrics', items: [{ label: '未结余额合计', value: r(total), unit: '元' }, { label: '逾期余额', value: r(total - buckets[0]!.value), unit: '元' }] },
      { type: 'bars', title: '逾期分层分布', unit: '元', items: buckets.map((item) => ({ ...item, value: r(item.value) })) },
      { type: 'table', title: '未结单据明细', columns: ['单据', '到期日', '逾期天数', '未结余额', '分层'], rows: detail },
    ]
    warnings.push('这是按到期日计算的逾期分层，不是按入账日计算的会计账龄。仅支持同币种、非负未结余额；应收和应付请分开导入。')
  } else if (id === 'maintenance') {
    const failures = Number(input.failures)
    if (!Number.isSafeInteger(failures)) fail('INVALID_INPUT', '故障次数必须为整数')
    requireCondition(failures > 0, '故障次数必须大于 0')
    blocks = [
      { type: 'metrics', items: [{ label: 'MTBF 平均故障间隔', value: r(Number(input.uptime) / failures), unit: 'h' }, { label: 'MTTR 平均修复时间', value: r(Number(input.repair) / failures), unit: 'h' }] },
      { type: 'text', title: '计算口径', content: 'MTBF = 同一观察期累计运行时间 / 故障次数；MTTR = 同期累计主动维修时间 / 故障次数。输入应保持设备范围与观察期一致，不将等待备件时间混入主动维修时间。' },
    ]
  } else if (id === 'quote-compare') {
    const quantity = Number(input.quantity)
    if (!Number.isSafeInteger(quantity)) fail('INVALID_INPUT', '采购数量必须为整数')
    const values = readTable(String(input.data), ['supplier', 'price', 'taxRate', 'freight'])
    unique(values, 'supplier')
    const ranked = values.map((row) => {
      const price = num(row.price!, '未税单价')
      const tax = num(row.taxRate!, '税率')
      const freight = num(row.freight!, '含税运费')
      if (tax > 1) fail('INVALID_INPUT', '税率用小数表示，例如 13% 填 0.13')
      return { supplier: row.supplier!, total: r(quantity * price * (1 + tax) + freight), price, tax, freight }
    }).sort((a, b) => a.total - b.total)
    blocks = [
      { type: 'metrics', items: [{ label: '最低含税到货总成本', value: ranked[0]!.total, unit: '元' }, { label: '最高与最低差额', value: r(ranked.at(-1)!.total - ranked[0]!.total), unit: '元' }] },
      { type: 'bars', title: '含税到货总成本对比', unit: '元', items: ranked.map((item) => ({ label: item.supplier, value: item.total })) },
      { type: 'table', title: '同口径报价明细', columns: ['供应商', '未税单价', '税率', '含税运费', '总成本'], rows: ranked.map((item) => [item.supplier, item.price, item.tax, item.freight, item.total]) },
    ]
    warnings.push('总成本 = 数量 × 未税单价 × (1 + 税率) + 含税运费。仅比较同币种同规格的现金支出，不考虑可抵扣税额、交期、质量、账期和汇率。')
  }
  return { blocks, warnings }
}