#!/usr/bin/env node
/**
 * host-bridge 契约测试（EXEC-CHECKLIST W5）——node 直跑断言脚本（exit 0/1）。
 *
 * 覆盖 plugin-rq-card 浏览器半的「宿主桥窄端口」面：
 *   1. adapter（createClientHostPort）正确包装 mock ctx 的全部必须能力
 *      （slots.inject / slots.register / locale.register / effect 转发保真）；
 *   2. 可选能力 specDynamic：存在 + 返回对象 → 保真；返回 null / 抛错 → 折叠
 *      undefined；能力整体缺席 → 端口属性缺席（旧宿主不升级也可运行）；
 *   3. rq-card 经端口取 slots/locale：模拟 dsh slot 机的惰性注入流
 *      （inject 存工厂 → 宿主执行工厂 → register 落条目），断言词典与条目
 *      经端口落到 mock 宿主（等价 apply 的注册序列在端口面上的投影）；
 *   4. 源面收敛守卫：client/index.ts 不直接 import 任何 @deepseek-ai/* 包
 *      （dsh-client-runtime 三包类型依赖收敛到 host-port.ts 单点）；
 *      lib/client.js 产物形状（存在时）保持 closure-factory 契约。
 *
 * 说明：client/index.ts 引用链含 .tsx（JSX），Node 原生加载不解析 JSX——
 * 故全链注册行为经「mock 宿主 + 端口」按 index.ts 的注册序列投影验证，
 * 编译链路由 build.mjs（esbuild，纯度门禁 + 产物形状自检）把关。
 *
 * 运行：node packages/plugin-rq-card/tests/host-bridge.contract.mjs
 * （或 npm run test:contracts）
 */
import { readFileSync, existsSync } from 'node:fs'
import { createClientHostPort } from '../src/client/host-port.ts'
import { zh, en, ja } from '../src/client/locales.ts'
import {
  SLOT_TOOLVIEW, SLOT_ASSISTANT_ACTIONS, SLOT_OVERLAY,
  FEEDBACK_ENTRY_ID, TOOLVIEW_ENTRY_PREFIX, DEGRADED_BADGE_ID,
} from '../src/wire.ts'

// ── 轻量 check（selftest 同思路）────────────────────────────────────────────
const results = []
let failures = 0
function check(name, condition, detail = '') {
  const pass = Boolean(condition)
  results.push({ name, pass })
  if (!pass) failures++
  console.log(`  ${pass ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}${pass ? '' : `  ← ${detail}`}`)
  return pass
}

// ── mock 宿主（dsh 客户端 context 的结构化最小替身）─────────────────────────
/**
 * @param specDynamic - (name) => spec | null；省略 = 宿主不提供该 API。
 * @param options.lazy - true 时 inject 只存工厂不执行（贴近 dsh 真实惰性语义）。
 */
function makeMockCtx({ specDynamic, lazy = true } = {}) {
  const calls = {
    inject: [],       // { slot, factory }
    register: [],     // { spec, component }
    locale: [],       // { namespace, dictionaries }
    effect: [],       // { action, name }
    specDynamic: [],  // name
  }
  const runEffects = () => { for (const e of calls.effect) e.action() }
  const runInjects = () => {
    for (const inj of [...calls.inject]) {
      const produced = inj.factory()
      if (typeof produced === 'function') inj.dispose = produced
    }
  }
  const slots = {
    inject: (slot, factory) => {
      calls.inject.push({ slot, factory })
      if (!lazy) { const d = factory(); if (typeof d === 'function') calls.inject.at(-1).dispose = d }
    },
    register: (spec, component) => {
      calls.register.push({ spec, component })
      return () => { calls.register = calls.register.filter((e) => e.spec !== spec) }
    },
  }
  if (specDynamic !== undefined) {
    slots.specDynamic = (name) => { calls.specDynamic.push(name); return specDynamic(name) }
  }
  const ctx = {
    slots,
    locale: { register: (namespace, dictionaries) => { calls.locale.push({ namespace, dictionaries }) } },
    effect: (action, name) => { calls.effect.push({ action, name }) },
    __calls: calls,
    __runEffects: runEffects,
    __runInjects: runInjects,
  }
  return ctx
}

// ══ 1. adapter 必须能力转发保真 ══════════════════════════════════════════════
console.log('\n\x1b[36m━━ 1. adapter 必须能力：inject/register/locale/effect 转发 ━━\x1b[0m')
{
  const ctx = makeMockCtx()
  const port = createClientHostPort(ctx)
  const factory = () => {}
  port.slots.inject('tool.call.toolview', factory)
  check('slots.inject 转发（slot 名与工厂同引用）',
    ctx.__calls.inject.length === 1 && ctx.__calls.inject[0].slot === SLOT_TOOLVIEW
    && ctx.__calls.inject[0].factory === factory)
  const spec = { name: SLOT_TOOLVIEW, id: 'rq-tool-mcp_invoke', key: 'mcp_invoke', locale: 'rq-card' }
  const component = function Card() {}
  const dispose = port.slots.register(spec, component)
  check('slots.register 转发（spec 字段保真 + 组件同引用）',
    ctx.__calls.register.length === 1 && ctx.__calls.register[0].spec === spec
    && ctx.__calls.register[0].component === component)
  check('register 返回注销函数且可执行', typeof dispose === 'function' && (dispose(), true))
  port.locale.register('rq-card', { zh, en, ja })
  check('locale.register 转发（命名空间 + 三语词典对象同引用）',
    ctx.__calls.locale.length === 1 && ctx.__calls.locale[0].namespace === 'rq-card'
    && ctx.__calls.locale[0].dictionaries.en === en && ctx.__calls.locale[0].dictionaries.ja === ja)
  const action = () => {}
  port.effect(action, 'rq-card: dictionaries')
  check('effect 转发（副作用与名称保真）',
    ctx.__calls.effect.length === 1 && ctx.__calls.effect[0].action === action
    && ctx.__calls.effect[0].name === 'rq-card: dictionaries')
}

// ══ 2. 可选能力 specDynamic：保真 / 折叠 / 缺席 ══════════════════════════════
console.log('\n\x1b[36m━━ 2. 可选能力 specDynamic：保真、折叠、缺席降级 ━━\x1b[0m')
{
  const ok = createClientHostPort(makeMockCtx({ specDynamic: () => ({ kind: 'keyed', extra: 1 }) }))
  check('返回对象 → 原样（kind 保真）', ok.slots.specDynamic?.('tool.call.toolview')?.kind === 'keyed')

  const nullish = createClientHostPort(makeMockCtx({ specDynamic: () => null }))
  check('返回 null → 折叠 undefined（探测失败 = 降级信号）',
    nullish.slots.specDynamic?.('tool.call.toolview') === undefined)

  const throwing = createClientHostPort(makeMockCtx({ specDynamic: () => { throw new Error('host blew up') } }))
  check('宿主实现抛错 → 折叠 undefined（不向插件体泄漏异常）',
    throwing.slots.specDynamic?.('shell.overlay') === undefined)

  const bare = createClientHostPort(makeMockCtx({}))
  check('宿主不提供 specDynamic → 端口属性缺席（旧宿主免升级）', bare.slots.specDynamic === undefined)
}

// ══ 3. rq-card 经端口取 slots/locale（apply 注册序列的端口面投影）════════════
console.log('\n\x1b[36m━━ 3. 经端口注册：词典 + toolview 键位 + 反馈条 ━━\x1b[0m')
{
  // 完备宿主：toolview=keyed、assistant-actions=list、overlay=list。
  const ctx = makeMockCtx({ specDynamic: (name) => ({ kind: name === SLOT_TOOLVIEW ? 'keyed' : 'list' }) })
  const port = createClientHostPort(ctx)

  // —— 按 index.ts applyViaPort 的序列驱动端口（词典注册走 effect，惰性注入走工厂）——
  port.effect(() => port.locale.register('rq-card', { zh, en, ja }), 'rq-card: dictionaries')
  ctx.__runEffects()
  check('词典经 effect→locale.register 落宿主（rq-card 座位，zh/en/ja 三语）',
    ctx.__calls.locale.length === 1 && ctx.__calls.locale[0].dictionaries.zh === zh)

  const RQ_TOOLS = ['mcp_invoke', 'nas_get', 'skill_search'] // 名录抽样（代表三类资产）
  for (const tool of RQ_TOOLS) {
    port.slots.inject(SLOT_TOOLVIEW, () => port.slots.register({
      name: SLOT_TOOLVIEW, key: tool, id: `${TOOLVIEW_ENTRY_PREFIX}${tool}`, locale: 'rq-card',
      inject: () => ({ deriveState: true }),
    }, function ExecutionCard() {}))
  }
  check('toolview 键位注入按名录逐工具入列（inject 惰性存工厂）',
    ctx.__calls.inject.length === RQ_TOOLS.length
    && ctx.__calls.inject.every((e) => e.slot === SLOT_TOOLVIEW && typeof e.factory === 'function'))

  ctx.__runInjects()
  const toolviewSpecs = ctx.__calls.register.filter((e) => e.spec.name === SLOT_TOOLVIEW)
  check('宿主执行工厂 → 逐工具键位条目落 register（id=前缀+工具名、locale 座位）',
    toolviewSpecs.length === RQ_TOOLS.length
    && toolviewSpecs.every((e) => RQ_TOOLS.includes(e.spec.key) && e.spec.id === `${TOOLVIEW_ENTRY_PREFIX}${e.spec.key}` && e.spec.locale === 'rq-card'))

  // 反馈条：注入工厂返回清理函数（dispose 注销 + 会话控制器清空）
  let feedbackDisposed = false
  port.slots.inject(SLOT_ASSISTANT_ACTIONS, () => {
    const dispose = port.slots.register({
      name: SLOT_ASSISTANT_ACTIONS, id: FEEDBACK_ENTRY_ID, order: 20, locale: 'rq-card',
      inject: () => ({}),
    }, function RqFeedback() {})
    return () => { feedbackDisposed = true; dispose() }
  })
  ctx.__runInjects()
  const feedback = ctx.__calls.register.find((e) => e.spec.name === SLOT_ASSISTANT_ACTIONS)
  check('反馈条条目落 register（id=rq-feedback、order=20 排 dsh feedback 之后）',
    Boolean(feedback) && feedback.spec.id === FEEDBACK_ENTRY_ID && feedback.spec.order === 20)
  ctx.__calls.inject.at(-1).dispose()
  check('反馈条清理函数经端口回收（dispose 执行 + 条目注销）',
    feedbackDisposed && !ctx.__calls.register.some((e) => e.spec.name === SLOT_ASSISTANT_ACTIONS))
}

// ══ 4. 降级路径：spec 缺失 → 不注册业务条目（端口面不炸）════════════════════
console.log('\n\x1b[36m━━ 4. 降级路径：槽探测失败不注册、不抛错 ━━\x1b[0m')
{
  const ctx = makeMockCtx({ specDynamic: () => null }) // 全槽不可用
  const port = createClientHostPort(ctx)
  let threw = false
  try {
    const toolviewSpec = port.slots.specDynamic?.(SLOT_TOOLVIEW)
    if (toolviewSpec?.kind !== 'keyed') { /* 置降级标志（与 index.ts 同判定）*/ }
    else { port.slots.inject(SLOT_TOOLVIEW, () => {}) }
    const overlaySpec = port.slots.specDynamic?.(SLOT_OVERLAY)
    if (overlaySpec?.kind === 'list') {
      port.slots.inject(SLOT_OVERLAY, () => port.slots.register({
        name: SLOT_OVERLAY, id: DEGRADED_BADGE_ID, order: 90, locale: 'rq-card',
      }, function Badge() {}))
    }
  } catch {
    threw = true
  }
  check('探测折叠为 undefined → 判定降级且全程不抛错', threw === false)
  check('降级判定下未注册业务条目（卡片静默消失，宿主无感）',
    ctx.__calls.register.length === 0 && ctx.__calls.inject.length === 0)
}

// ══ 5. 源面收敛守卫 + 产物形状 ═══════════════════════════════════════════════
console.log('\n\x1b[36m━━ 5. 源面收敛守卫 + 产物形状 ━━\x1b[0m')
{
  const indexSource = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  check('client/index.ts 无 @deepseek-ai/* 直接依赖（三包类型收敛到 host-port.ts 单点）',
    !indexSource.includes('@deepseek-ai/'))
  const portSource = readFileSync(new URL('../src/client/host-port.ts', import.meta.url), 'utf8')
  check('host-port.ts 为三包收敛单点（runtime 类型 + ui-conversation/locale merge 齐备）',
    portSource.includes('@deepseek-ai/dsh-client-runtime/client')
    && portSource.includes('@deepseek-ai/dsh-client-ui-conversation/client')
    && portSource.includes('@deepseek-ai/dsh-client-locale/client'))
  const libFile = new URL('../lib/client.js', import.meta.url)
  if (existsSync(libFile)) {
    const libSource = readFileSync(libFile, 'utf8')
    check('lib/client.js 保持 closure-factory 形状（__ModuleLoader__ + 插件 id）',
      libSource.slice(0, 400).includes('__ModuleLoader__') && libSource.includes('@dsh-ops/plugin-rq-card'))
    if (!libSource.includes('createClientHostPort')) {
      console.log('  \x1b[33m⚠ lib/client.js 未含 createClientHostPort——产物为 W5 改造前构建，请在含 esbuild/dsh 检出的环境重跑 node packages/plugin-rq-card/build.mjs\x1b[0m')
    }
  } else {
    console.log('  \x1b[33m⚠ lib/client.js 不存在——浏览器半 bundle 未构建（dsh web 启动前必须先跑 build.mjs）\x1b[0m')
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const passed = results.length - failures
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}rq-card host-bridge 契约：${passed}/${results.length} 通过${failures === 0 ? '（全绿）' : `（${failures} 失败）`}\x1b[0m`)
process.exitCode = failures === 0 ? 0 : 1
