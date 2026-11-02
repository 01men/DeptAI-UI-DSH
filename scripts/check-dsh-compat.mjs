#!/usr/bin/env node
/**
 * dsh 兼容性断言（EXEC-CHECKLIST 3.3）。
 *
 * 声明：本脚本是根 package.json `dsh.compatibility.dshReleases` 字段唯一的
 * 自动化验证来源；人工手改该字段视为无效声明——只有以下五项断言全部通过，
 * 对应版本的 "compatible" 才会由本脚本写入。
 *
 * 用法：node scripts/check-dsh-compat.mjs <dsh-version>
 *   例：node scripts/check-dsh-compat.mjs 0.1.0-rc.7
 *
 * 五项断言（按序执行，任一步失败立即输出「卡在哪一步 + 证据」并退出非零）：
 *   ① 版本确认：npx --yes @deepseek-ai/dsh@<version> --version 输出含该版本号。
 *   ② 拉取 dsh 的 cordis 实体到临时目录，确认 vendor/cordis 存在（见下「来源链」）。
 *   ③ 临时项目副本内把 @deepseek-ai/cordis 解析指向该实体（POSIX ln -s /
 *      Windows junction），使后续装配全程跑在 dsh 侧 cordis 上。
 *   ④ 在该解析下装配最小插件树并跑 probeTree（packages/platform-core/src/
 *      boot-probe.ts，启动组并行交付；缺失时友好报错），断言 ok:true 且
 *      registry 无插件重复注册。
 *   ⑤ 全部通过后向根 package.json 的 dshReleases 写入 "<version>": "compatible"
 *      （fs 读改写，2 空格缩进；失败绝不写）。
 *
 * ② 的来源链（实测依据，2026-10-16）：
 *   - 首选 git clone deepseek-ai/deepseek-harness 对应 tag 的源码树，校验其
 *     vendor/cordis 实体目录（该仓库当前为私库/不可达时自动降级）；
 *   - 降级走 npm：@deepseek-ai/dsh 的 CLI 包本身不含 vendor/cordis（其 tarball
 *     只有 lib/config），但 @deepseek-ai/cordis 的 npm 包即 harness 仓库
 *     vendor/cordis 目录的发布构建（其 package.json repository.directory 字段
 *     为证）。脚本解析 dsh@<version> 所声明的 cordis 依赖范围，pack 该版本并
 *     校验来源字段后，等价充当 vendor/cordis 实体。
 *
 * 退出码：0 = 已验证兼容；1 = 断言失败（不兼容/结构不符/探针缺失）；
 *         2 = 环境不可达，兼容性未验证（禁止在未验证时谎报兼容）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_RE = /^\d+\.\d+\.\d+[-+.\w]*$/
const NET_MARKERS = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPROTO|EPIPE|self-signed|certificate|network|ETARGET|E404|404|Not Found|timed? ?out|socket hang up/i

const IS_WIN = process.platform === 'win32'
const EX_UNVERIFIED = 2

/** 控制流信号：携带既定退出码抛出，由 main 统一收尾（保证临时目录清理后再退出）。 */
class ExitSignal extends Error {
  constructor(code) {
    super(`exit-${code}`)
    this.exitCode = code
  }
}

function printEvidence(evidence) {
  console.error(String(evidence).split('\n').map((l) => `    ${l}`).join('\n'))
}
function die(step, message, evidence) {
  console.error(`\n[x] 断言失败 · 卡在第 ${step} 步：${message}`)
  if (evidence) printEvidence(evidence)
  throw new ExitSignal(1)
}
function unreachable(message, evidence) {
  console.error(`\n[!] 环境不可达，兼容性未验证：${message}`)
  if (evidence) printEvidence(evidence)
  throw new ExitSignal(EX_UNVERIFIED)
}
function ok(step, message) {
  console.log(`[✓] 第 ${step} 步：${message}`)
}

/** 带超时的子进程执行；返回 {code, stdout, stderr, timedOut}。 */
function run(cmd, args, { timeoutMs = 120_000, cwd, env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: IS_WIN,
      env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false', ...env },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut })
    })
  })
}

/** 创建目录符号链接；Windows 用 junction（无需特权、可指向目录）。 */
function symlinkDir(target, linkPath) {
  fs.mkdirSync(dirname(linkPath), { recursive: true })
  fs.symlinkSync(target, linkPath, IS_WIN ? 'junction' : 'dir')
}

/** 递归拷贝目录，跳过 node_modules / .git / data。 */
function copyTree(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => !/(^|[/\\])(node_modules|\.git|data)([/\\]|$)/.test(src),
  })
}

// ─── ① 版本确认 ────────────────────────────────────────────────────────────────
async function assertVersion(version) {
  console.log(`\n[①] 版本确认：npx --yes @deepseek-ai/dsh@${version} --version`)
  const r = await run('npx', ['--yes', `@deepseek-ai/dsh@${version}`, '--version'], { timeoutMs: 480_000 })
  const output = `${r.stdout}\n${r.stderr}`.trim()
  if (r.timedOut || r.code !== 0) {
    const reason = r.timedOut ? `npx 执行超时（480s）` : `npx 退出码 ${r.code}（可能私包/网络/平台不匹配）`
    unreachable(`拉取 @deepseek-ai/dsh@${version} 失败：${reason}`, output)
  }
  if (!r.stdout.includes(version) && !r.stderr.includes(version)) {
    die('①', `dsh CLI 可执行，但 --version 输出不含 ${version}，实际版本不符`, output)
  }
  ok('①', `dsh CLI 版本确认输出含 ${version}`)
}

// ─── ② 拉取 dsh 的 cordis 实体（vendor/cordis）────────────────────────────────
async function acquireVendorCordis(version, tmpRoot) {
  console.log('\n[②] 拉取 dsh 源码树 / cordis 实体到临时目录')

  // 链 A：源码树。仓库若可达且 tag 存在，直接校验 vendor/cordis 实体目录。
  // GIT_TERMINAL_PROMPT=0：私库/不可达时快速失败，不做交互式凭据等待。
  const vendorRoot = join(tmpRoot, 'dsh', 'vendor', 'cordis')
  for (const tag of [`v${version}`, `dsh-v${version}`, `dsh@${version}`]) {
    const r = await run('git', ['clone', '--depth', '1', '--branch', tag,
      'https://github.com/deepseek-ai/deepseek-harness.git', join(tmpRoot, 'dsh', 'src')],
      { timeoutMs: 45_000, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } })
    if (r.code === 0) {
      const dir = join(tmpRoot, 'dsh', 'src', 'vendor', 'cordis')
      if (!fs.statSync(dir).isDirectory()) {
        die('②', `源码树 ${tag} 已拉取，但其中不存在 vendor/cordis 实体目录`, `期望路径：${dir}`)
      }
      symlinkDir(dir, vendorRoot)
      ok('②', `git tag ${tag} 源码树内 vendor/cordis 实体目录存在`)
      return { vendorRoot, source: `git:${tag}`, cordisVersion: null }
    }
    console.log(`    git 链 ${tag} 未成功（${r.timedOut ? '超时' : `退出码 ${r.code}`}），尝试下一来源`)
  }

  // 链 B：npm 发布构建。@deepseek-ai/cordis 即 harness 仓库 vendor/cordis 的发布产物，
  // 以 package.json 的 repository.directory 字段证明来源。
  const rangeView = await run('npm', ['view', `@deepseek-ai/dsh@${version}`, 'dependencies.@deepseek-ai/cordis', '--json'], { timeoutMs: 60_000 })
  if (rangeView.code !== 0) {
    unreachable(`npm registry 不可达（无法解析 dsh@${version} 的 cordis 依赖范围）`, rangeView.stderr)
  }
  const range = JSON.parse(rangeView.stdout.trim() || 'null')
  if (typeof range !== 'string') {
    die('②', `dsh@${version} 未声明 @deepseek-ai/cordis 依赖，无法定位其 cordis 实体`, rangeView.stdout)
  }
  const listView = await run('npm', ['view', `@deepseek-ai/cordis@${range}`, 'version', '--json'], { timeoutMs: 60_000 })
  if (listView.code !== 0) unreachable(`npm registry 不可达（解析 ${range} 失败）`, listView.stderr)
  const versions = JSON.parse(listView.stdout.trim())
  const cordisVersion = (Array.isArray(versions) ? versions.at(-1) : versions)
  console.log(`    dsh@${version} 声明 cordis ${range} → 取发布版 ${cordisVersion}`)

  fs.mkdirSync(join(tmpRoot, 'dsh', 'vendor'), { recursive: true })
  const packed = await run('npm', ['pack', `@deepseek-ai/cordis@${cordisVersion}`], { timeoutMs: 120_000, cwd: tmpRoot })
  if (packed.code !== 0) unreachable(`npm pack cordis@${cordisVersion} 失败`, packed.stderr)
  const tgz = join(tmpRoot, packed.stdout.trim().split('\n').at(-1))
  fs.mkdirSync(vendorRoot, { recursive: true })
  await run('tar', ['-xzf', tgz, '-C', vendorRoot, '--strip-components', '1'], { timeoutMs: 60_000 })

  // 来源证明：该实体必须自证来自 harness 仓库 vendor/cordis 目录
  const manifest = JSON.parse(fs.readFileSync(join(vendorRoot, 'package.json'), 'utf8'))
  const directory = manifest?.repository?.directory
  if (manifest?.name !== '@deepseek-ai/cordis' || directory !== 'vendor/cordis') {
    die('②', '拉取到的 cordis 实体无法证明其来自 vendor/cordis（来源字段不符）',
        `name=${manifest?.name} repository.directory=${directory}`)
  }
  if (!fs.statSync(vendorRoot).isDirectory()) die('②', 'vendor/cordis 实体目录不存在')
  ok('②', `vendor/cordis 实体就绪（npm 发布构建 ${cordisVersion}，来源字段 repository.directory=vendor/cordis）`)
  return { vendorRoot, source: `npm:@deepseek-ai/cordis@${cordisVersion}`, cordisVersion }
}

// ─── ③ 临时项目副本 + node_modules 覆盖 ──────────────────────────────────────
function buildOverlayProject(tmpRoot, vendorRoot) {
  console.log('\n[③] 临时副本内把 @deepseek-ai/cordis 解析指向 vendor/cordis')
  const proj = join(tmpRoot, 'project')
  for (const entry of ['package.json', 'src', 'packages', 'cordis.yml', 'cordis.patch.yml']) {
    const from = join(PROJECT_ROOT, entry)
    if (fs.existsSync(from)) copyTree(from, join(proj, entry))
  }

  const realNm = join(PROJECT_ROOT, 'node_modules')
  const tmpNm = join(proj, 'node_modules')
  fs.mkdirSync(tmpNm, { recursive: true })

  // 第三方依赖：整条链接真实安装（不含两个 scope，下面单独处理）
  for (const entry of fs.readdirSync(realNm, { withFileTypes: true })) {
    if (entry.name === '@deepseek-ai' || entry.name === '@dsh-ops' || entry.name.startsWith('.')) continue
    symlinkDir(join(realNm, entry.name), join(tmpNm, entry.name))
  }
  // workspace 包：指向临时副本内的包本体（保证其 cordis import 也走覆盖层）
  const wsScope = join(realNm, '@dsh-ops')
  if (fs.existsSync(wsScope)) {
    for (const entry of fs.readdirSync(wsScope, { withFileTypes: true })) {
      const real = realpathSync(join(wsScope, entry.name))
      const under = resolve(real).startsWith(resolve(PROJECT_ROOT, 'packages') + sep)
      const target = under ? join(proj, 'packages', entry.name) : real
      if (!under) console.log(`    警告：workspace 链接 ${entry.name} 不在 packages/ 下，退化为直连真实路径`)
      symlinkDir(target, join(tmpNm, '@dsh-ops', entry.name))
    }
  }
  // 断言核心：cordis 一键切换到 dsh 侧实体；其依赖（cosmokit 等）落到 tmpRoot/node_modules 兜底
  symlinkDir(vendorRoot, join(tmpNm, '@deepseek-ai', 'cordis'))
  for (const dep of ['@deepseek-ai/cosmokit', '@standard-schema/spec']) {
    const real = join(realNm, dep)
    if (fs.existsSync(real)) symlinkDir(real, join(tmpRoot, 'node_modules', dep))
  }
  ok('③', `node_modules 覆盖完成（POSIX symlink / Windows junction），cordis → ${vendorRoot}`)
  return proj
}

// ─── ④ probeTree 装配 + 重复注册断言 ─────────────────────────────────────────
// 探针契约（boot-probe.ts 已交付，W2）：probeTree(ctx, required) → { ok, unreachable, stuck }，
// 另有 assertSingleRoot(ctx) 双实例哨兵。最小树由本 runner 装配：
//   provider 插件 apply 内 ctx.provide 注册服务，consumer 插件 inject 消费——
//   接线在 vendor/cordis 解析下全通即证明双轨宿主共用一棵隔离树成立。
const RUNNER_SOURCE = String.raw`
// 由 check-dsh-compat.mjs 生成，在临时副本内执行——③ 的解析覆盖只在此树内生效。
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'

const VENDOR_REAL = resolve(process.env.DSH_VENDOR_CORDIS_REAL)
const fail = (msg, evidence) => {
  console.error('[runner] ' + msg)
  if (evidence) console.error(String(evidence))
  process.exit(1)
}
const ok = (m) => console.log('[runner] ' + m)

// [4a] 单副本断言：本进程内的 @deepseek-ai/cordis 必须真实落在 vendor/cordis 树内
const resolved = realpathSync(fileURLToPath(import.meta.resolve('@deepseek-ai/cordis')))
const rel = relative(VENDOR_REAL, resolved)
if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
  fail('cordis 解析未落在 vendor/cordis 树内', 'resolved=' + resolved + '\nvendor=' + VENDOR_REAL)
}
ok('cordis 解析确认：' + resolved)
const cordis = await import('@deepseek-ai/cordis')

// [4b] 装配最小插件树并跑 probeTree（探针缺失/契约未定时友好报错，不谎报兼容）
let probeMod
try {
  probeMod = await import(new URL('./packages/platform-core/src/boot-probe.ts', import.meta.url).href)
} catch (err) {
  console.error('[runner] probeTree 探针不可用：packages/platform-core/src/boot-probe.ts 导入失败（启动组并行交付中）')
  console.error(String(err?.message || err))
  process.exit(2)
}
const probeTree = probeMod?.probeTree
if (typeof probeTree !== 'function') {
  console.error('[runner] 探针已存在但未导出 probeTree(ctx, required)，契约以启动组交付为准')
  process.exit(2)
}

const SERVICE = 'dshCompatProbeService'
const ctx = new cordis.Context()
try {
  probeMod.assertSingleRoot(ctx)
} catch (err) {
  fail('assertSingleRoot 双实例断言失败（vendor/cordis 单副本被破坏）', err?.stack || String(err))
}
await ctx.plugin({ name: 'dsh-compat-provider', apply(c) { c.provide(SERVICE, { origin: 'dsh-compat' }) } })
await ctx.plugin({ name: 'dsh-compat-consumer', inject: [SERVICE], apply() {} })

const health = probeTree(ctx, [SERVICE])
if (health?.ok !== true) fail('probeTree 未返回 ok:true（必需服务不可达或有拦启动的卡死 fiber）', JSON.stringify(health, null, 2))
ok('probeTree ok:true（required=[' + SERVICE + ']，stuck=' + health.stuck.length + '）')

// [4c] 重复注册断言（对照 cordis 4.0.4 src/registry.ts 真实结构）：
//   RegistryService._internal 是 Map<Function, Plugin.Runtime>——同一 Function 键在
//   单 registry 内不可能出现两个 runtime，因此可观测的重复特征是：
//   a) 两个 runtime 携同一插件名（同一插件经两份模块副本各注册一次）；
//   b) keys() 与 values() 数目失衡（Map 语义被破坏时的健全性哨兵）。
//   Runtime 形状：{ name?, callback: Function, fibers: DisposableList, Config? }。
const registry = ctx.registry
if (!registry || typeof registry.forEach !== 'function') fail('无法取得 cordis RegistryService 实例')
const runtimes = []
registry.forEach((rt, key) => runtimes.push({
  name: rt?.name ?? null,
  callbackFn: typeof rt?.callback === 'function',
  fibers: rt?.fibers?.length ?? 0,
  keyName: key?.name ?? null,
}))
const badShape = runtimes.filter((rt) => !rt.callbackFn)
if (badShape.length > 0) fail('存在 callback 非函数的 runtime，registry 结构与 cordis 4.0.4 不符', JSON.stringify(badShape))

const byName = new Map()
for (const rt of runtimes) {
  if (rt.name == null) continue
  const list = byName.get(rt.name) ?? []
  list.push(rt)
  byName.set(rt.name, list)
}
const dups = [...byName.entries()].filter(([, list]) => list.length > 1)
if (dups.length > 0) fail('发现插件重复注册：同一插件名出现多个 runtime', JSON.stringify(dups.map(([n, l]) => ({ name: n, count: l.length }))))

let keyCount = 0
for (const _ of registry.keys()) keyCount++
if (keyCount !== runtimes.length) fail('registry keys() 与 values() 数目失衡', keyCount + ' vs ' + runtimes.length)

ok('重复注册断言通过：' + runtimes.length + ' 个 runtime，无同名冲突')
console.log('PROBE_OK ' + JSON.stringify({ runtimes: runtimes.length, service: SERVICE }))
`

async function assertProbe(proj, vendorRoot) {
  console.log('\n[④] 覆盖解析下装配最小插件树并跑 probeTree + 重复注册断言')
  const runnerPath = join(proj, 'dsh-compat-runner.mjs')
  fs.writeFileSync(runnerPath, RUNNER_SOURCE)
  const r = await run(process.execPath, [runnerPath], {
    timeoutMs: 120_000,
    cwd: proj,
    env: { ...process.env, DSH_VENDOR_CORDIS_REAL: realpathSync(vendorRoot) },
  })
  const output = `${r.stdout}\n${r.stderr}`.trim()
  if (r.code !== 0) {
    die('④', r.timedOut ? 'probeTree 执行超时（120s）' : `探针进程退出码 ${r.code}`, output)
  }
  const marker = r.stdout.split('\n').find((l) => l.startsWith('PROBE_OK '))
  if (!marker) die('④', '探针进程成功但缺少 PROBE_OK 结论行', output)
  ok('④', marker.replace('PROBE_OK ', '装配结论 '))
}

// ─── ⑤ 写入 dshReleases ──────────────────────────────────────────────────────
function recordCompatibility(version) {
  console.log('\n[⑤] 记录 dsh.compatibility.dshReleases')
  const pkgPath = join(PROJECT_ROOT, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const releases = pkg?.dsh?.compatibility?.dshReleases
  if (releases?.[version] === 'compatible') {
    ok('⑤', `${version} 已记录为 compatible，本次运行复核通过（机器确认）`)
    return
  }
  const next = structuredClone(pkg)
  next.dsh ??= {}
  next.dsh.compatibility ??= {}
  next.dsh.compatibility.dshReleases ??= {}
  next.dsh.compatibility.dshReleases[version] = 'compatible'
  try {
    fs.writeFileSync(pkgPath, JSON.stringify(next, null, 2) + '\n')
  } catch (err) {
    die('⑤', '兼容性已验证，但写入 package.json 失败（按约定失败绝不写，请人工核对）', err.stack || String(err))
  }
  ok('⑤', `已写入 "${version}": "compatible"`)
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const version = process.argv[2]
  if (!version || !VERSION_RE.test(version)) {
    console.error('用法：node scripts/check-dsh-compat.mjs <dsh-version>   例：0.1.0-rc.7')
    return 1
  }
  const tmpRoot = fs.mkdtempSync(join(os.tmpdir(), 'dsh-compat-'))
  let exitCode = 0
  try {
    await assertVersion(version)
    const { vendorRoot } = await acquireVendorCordis(version, tmpRoot)
    const proj = buildOverlayProject(tmpRoot, vendorRoot)
    await assertProbe(proj, vendorRoot)
    recordCompatibility(version)
    console.log(`\n[PASS] dsh@${version} 五项断言全部通过，已确认兼容。`)
  } catch (err) {
    if (err instanceof ExitSignal) {
      exitCode = err.exitCode
    } else {
      console.error(`\n[x] 未预期异常`)
      printEvidence(err?.stack || String(err))
      exitCode = 1
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
  return exitCode
}

process.exit(await main())
