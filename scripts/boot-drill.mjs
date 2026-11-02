/**
 * 启动健壮性演练（EXEC-CHECKLIST W2）：纯进程内验证 boot-probe 三道防线。
 * 不占端口、不写 data 目录。用法：node scripts/boot-drill.mjs（退出码 0 = 演练通过）。
 *
 * 场景：
 *   ① 正常装配一棵最小插件树 → probeTree ok:true
 *   ② 另一个 root Context 注册同名服务（双实例病灶）→ 当前 ctx 报该服务不可达且 fiber PENDING
 *   ③ 污染 globalThis[root 键] → assertSingleRoot 抛「双实例」
 *   ④ FAILED 败者 fiber（声明 provide 已被接管，双注册习语）→ ok:true，仅入诊断清单
 *   ⑤ FAILED 真实故障（声明 provide 无人接管）→ ok:false 拦启动
 * 每个场景结束后清理 globalThis 污染。
 */
import { Context } from '@deepseek-ai/cordis'
import * as platformCore from '../packages/platform-core/src/index.ts'

const ROOT_KEY = Symbol.for('ybkk.cordis.root')
const clearRoot = () => Reflect.deleteProperty(globalThis, ROOT_KEY)

const outcomes = []
function record(name, pass, detail = '') {
  outcomes.push({ name, pass: Boolean(pass) })
  console.log(`  ${pass ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}${pass ? '' : `  ← ${detail}`}`)
}

/** 最小提供者/消费者插件对：演练只关心 fiber 状态，不承载任何业务。 */
const iamProvider = (source) => ({
  name: 'iam-provider',
  apply(ctx) { ctx.provide('iam', { source }) },
})
const iamConsumer = { name: 'iam-consumer', inject: ['iam'], apply() {} }

// 场景①：正常装配 → 体检全绿
async function scenario1() {
  console.log('\n\x1b[36m━━ 场景① 正常装配最小插件树 ━━\x1b[0m')
  const ctx = new Context()
  platformCore.assertSingleRoot(ctx)
  await ctx.plugin(iamProvider('drill-ok'))
  await ctx.plugin(iamConsumer)
  const health = platformCore.probeTree(ctx, ['iam'])
  record('probeTree ok:true', health.ok === true && health.unreachable.length === 0 && health.stuck.length === 0,
    JSON.stringify(health))
  clearRoot()
}

// 场景②：双实例病灶 → 当前 ctx 永远看不见另一个 root 上的同名服务
async function scenario2() {
  console.log('\n\x1b[36m━━ 场景② 另一 root 注册同名服务 ━━\x1b[0m')
  const ctx = new Context()
  const otherRoot = new Context()
  await otherRoot.plugin(iamProvider('other-root'))
  // 消费者 fiber 的 inject 解析不到实现 → 静默 PENDING（根因复现），不 await（挂起态即结论）
  ctx.plugin(iamConsumer)
  const health = platformCore.probeTree(ctx, ['iam'])
  record('probeTree 报 iam 不可达且 consumer 卡 PENDING',
    !health.ok && health.unreachable.includes('iam')
      && health.stuck.some((f) => f.plugin === 'iam-consumer' && f.state === 'PENDING' && f.waiting.includes('iam')),
    JSON.stringify(health))
  const text = platformCore.formatTreeHealth(health)
  record('formatTreeHealth 可读（拒绝启动 + 插件名 + 等待键）',
    text.includes('插件树未健康') && text.includes('iam-consumer') && text.includes('PENDING') && text.includes('iam'),
    text)
  clearRoot()
}

// 场景③：globalThis 污染 → 断言抛错；清理后恢复
function scenario3() {
  console.log('\n\x1b[36m━━ 场景③ 污染 globalThis 后断言双实例 ━━\x1b[0m')
  globalThis[ROOT_KEY] = { polluted: true }
  let thrown = null
  try { platformCore.assertSingleRoot(new Context()) } catch (error) { thrown = error }
  record('assertSingleRoot 抛错且消息含「双实例」',
    thrown instanceof Error && thrown.message.includes('双实例'), String(thrown))
  clearRoot()
  let afterClean = null
  const ctx = new Context()
  try { platformCore.assertSingleRoot(ctx) } catch (error) { afterClean = error }
  record('清理污染后恢复正常登记', afterClean === null && globalThis[ROOT_KEY] === ctx.root, String(afterClean))
  clearRoot()
}

// 场景④⑤：FAILED fiber 的两种形态——良性败者（provide 已被接管）与真实故障（无人接管）
async function scenario45() {
  console.log('\n\x1b[36m━━ 场景④ 双注册习语的良性败者 fiber ━━\x1b[0m')
  const ctx = new Context()
  platformCore.assertSingleRoot(ctx)
  // 复刻 panel-core/flow-core 习语（函数插件形态，provide 静态字段与 PanelService 类一致：
  // registry.resolve 对函数插件直接取函数体作 callback）——先 ctx.plugin 注册，再同步登记同名
  // 实现：同步方胜出，后者异步装载时 provide 撞车失败，留下 FAILED husk
  const decoy = (ctx) => ctx.provide('iam', { source: 'decoy' })
  decoy.provide = 'iam'
  await ctx.plugin({
    name: 'decoy-module',
    apply(ctx) {
      ctx.plugin(decoy)
      ctx.provide('iam', { source: 'module' })
    },
  })
  const health = platformCore.probeTree(ctx, ['iam'])
  const husk = health.stuck.find((f) => f.plugin === 'decoy')
  record('良性败者：ok:true 且 FAILED husk 仅入诊断清单',
    health.ok === true && !!husk && husk.state === 'FAILED' && husk.blocking === false,
    JSON.stringify(health))
  clearRoot()

  console.log('\n\x1b[36m━━ 场景⑤ FAILED 且 provide 无人接管 → 拦启动 ━━\x1b[0m')
  const ctx2 = new Context()
  platformCore.assertSingleRoot(ctx2)
  const broken = () => { throw new Error('boom') }
  broken.provide = 'iam'
  try { await ctx2.plugin(broken) } catch { /* 启动失败本身即场景前提 */ }
  const health2 = platformCore.probeTree(ctx2, [])
  const dead = health2.stuck.find((f) => f.plugin === 'broken')
  record('真实故障：ok:false 且 FAILED 标记 blocking',
    health2.ok === false && health2.unreachable.length === 0 && !!dead && dead.blocking === true,
    JSON.stringify(health2))
  clearRoot()
}

await scenario1()
await scenario2()
scenario3()
await scenario45()

console.log('\n—— 演练结论 ——')
for (const { name, pass } of outcomes) {
  console.log(`${pass ? '✔' : '✘'} ${name}`)
}
const failed = outcomes.filter((o) => !o.pass).length
if (failed > 0) {
  console.log(`\n演练未通过：${failed} 项`)
  process.exit(1)
}
console.log('\n演练全部通过')
