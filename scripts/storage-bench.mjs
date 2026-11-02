/**
 * 存储后端基准：JSON 集合 vs SQLite 集合（ADR-0001 验收配套）。
 *
 * 用法：
 *   node scripts/storage-bench.mjs                     # 两后端各 10k 写入
 *   node scripts/storage-bench.mjs --writes 50000      # 加大写入量
 *   node scripts/storage-bench.mjs --backend sqlite    # 只跑单后端
 *
 * 口径说明（诚实基准）：
 *   - JSON 后端单写延迟 = 内存 Map 写入 + 防抖标记（落盘异步在后台发生，不计入单写延迟）；
 *   - SQLite 后端单写延迟 = 完整事务提交（WAL + synchronous=FULL，含 fsync）——
 *     这是「写入即持久」的代价，也是「返回 200 即落盘」的收益。
 *   - 验收线（ADR-0001 §八）：SQLite 串行 10k 写 P99 < 50ms；常驻内存不随写入量线性增长。
 *     口径为「串行」而非并发：node:sqlite 是同步 API、单进程单写者，本基准的写入循环
 *     即串行发射；「10k 并发写入」在本后端形态下不构成可真并发的口径（正式改口径
 *     见 ADR-0001 §五/§八，2026-10-16 批次；不做多进程压测——单进程单写者是其部署形态上限）。
 */
import { Context } from '@deepseek-ai/cordis'
import { StorageService } from '../packages/platform-core/src/storage.ts'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
function argValue(flag, fallback) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}
const WRITES = Number(argValue('--writes', '10000'))
const ONLY = argValue('--backend', 'both')

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}
const rssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024)

async function benchBackend(kind) {
  const dataDir = join(tmpdir(), `ybkk-storage-bench-${kind}-${process.pid}-${Date.now()}`)
  const ctx = new Context()
  const svc = new StorageService(ctx, { dataDir, backend: kind })
  const col = svc.collection('bench:calls')

  const writeLatencies = []
  const payload = { service: 'svc-demo', tool: 'search', status: 'ok', caller: 'agent:42', dept: 'dept:7', meta: { tokens: 812, latencyMs: 233, day: '2026-10-16' } }
  const t0 = performance.now()
  for (let i = 0; i < WRITES; i++) {
    const s = performance.now()
    col.insert({ id: `call-${i}`, ...payload })
    writeLatencies.push(performance.now() - s)
  }
  const totalMs = performance.now() - t0

  const readGetStart = performance.now()
  for (let i = 0; i < 1000; i++) col.get(`call-${(i * 7919) % WRITES}`)
  const readGetMs = performance.now() - readGetStart

  const scanStart = performance.now()
  const hits = col.find((r) => r.status === 'ok').length
  const scanMs = performance.now() - scanStart

  const allStart = performance.now()
  const all = col.all()
  const allMs = performance.now() - allStart

  const rssBefore = rssMB()
  writeLatencies.sort((a, b) => a - b)
  console.log(`\n━━ ${kind} 后端（${WRITES} 次写入）━━`)
  console.log(`  写入吞吐      ：${Math.round(WRITES / (totalMs / 1000))} 写/秒（总耗时 ${(totalMs / 1000).toFixed(2)}s）`)
  console.log(`  单写延迟 P50  ：${writeLatencies[Math.floor(writeLatencies.length / 2)].toFixed(3)} ms`)
  console.log(`  单写延迟 P95  ：${writeLatencies[Math.floor(writeLatencies.length * 0.95)].toFixed(3)} ms`)
  console.log(`  单写延迟 P99  ：${writeLatencies[Math.floor(writeLatencies.length * 0.99)].toFixed(3)} ms`)
  console.log(`  单写延迟 max  ：${writeLatencies[writeLatencies.length - 1].toFixed(3)} ms`)
  console.log(`  点读 1000 次  ：${readGetMs.toFixed(1)} ms`)
  console.log(`  全表 find     ：${scanMs.toFixed(1)} ms（命中 ${hits}）`)
  console.log(`  全表 all()    ：${allMs.toFixed(1)} ms（${all.length} 条）`)
  console.log(`  RSS           ：${rssBefore} MB（写入前 ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB 基线见进程启动）`)

  // 触发 StorageService 的 dispose 钩子（关 DB 连接/停防抖定时器）；旧版 cordis 无 dispose 则跳过
  try {
    await ctx.dispose?.()
  } catch { /* 生命周期 API 差异不影响基准结果 */ }
  rmSync(dataDir, { recursive: true, force: true })
  return { kind, p99: writeLatencies[Math.floor(writeLatencies.length * 0.99)] }
}

console.log(`存储后端基准 · Node ${process.version} · 写入量 ${WRITES}`)
const results = []
if (ONLY === 'both' || ONLY === 'json') results.push(await benchBackend('json'))
if (ONLY === 'both' || ONLY === 'sqlite') results.push(await benchBackend('sqlite'))

const sqlite = results.find((r) => r.kind === 'sqlite')
if (sqlite) {
  const pass = sqlite.p99 < 50
  console.log(`\nADR-0001 验收线：SQLite 串行写入 P99 < 50ms（串行口径，见文件头说明）→ ${pass ? '✔ 通过' : `✘ 未过（${sqlite.p99.toFixed(2)}ms）`}`)
  if (!pass) process.exitCode = 1
}
