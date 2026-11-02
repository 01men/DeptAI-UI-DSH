/**
 * 装配顺序与模块边界校验（R3，REFACTOR-2026-10-13，2026-10-13）。
 *
 * 背景：插件加载顺序契约此前只存在于 boot-all.ts 注释与 cordis yml 顺序中；
 * inject 声明缺提供者时插件会静默 INACTIVE，无任何门禁拦截。本工具把隐式
 * 契约变为机器可校验（吸收 paperclip scripts/check-module-boundaries.mjs 模式）。
 *
 * 校验项：
 *   [A] 依赖先于使用：对 boot-all 与 cordis.yml 两个装配序列，逐插件校验其
 *       inject 键的提供者（代码内 static provide 声明）均先于该插件装配；
 *       无任何提供者的 inject 键 = 静默 INACTIVE 风险，直接红。
 *   [B] plugin.yaml depends 对账：dsh-plugin-* 引用必须映射到真实包且先于
 *       使用；非 id 自然语言条目须登记豁免；inject×provide 推导出的真实
 *       依赖未登记进 depends 时给补录提示（warn）。
 *   [C] cordis.yml ↔ cordis.patch.yml：两份宿主装配文件的插件序列必须一致
 *       （成员与顺序；name 形态差异 file:///包名+子路径 不在校验范围）。
 *   [D] boot-all ↔ yml 公共序列一致：去掉登记的宿主形态差异项后，公共插件
 *       相对顺序必须一致（已知豁免：connect 的 host/client 角色时序差异）。
 *   [E] provides.services 对账：plugin.yaml 声明的服务键必须有代码 provide 实现
 *       （幽灵声明红）；代码 provide 键未登记进清单给补录提示（warn）。
 *
 * 结构性登记（宿主形态差异，非债，改动须同步脚本常量与理由）：
 *   - yml 独有：plugin-dsh-bridge（dsh webServer 桥接，独立宿主不需要）、
 *               plugin-rq-card（浏览器半插件，仅 dsh 会话侧）；
 *   - boot 独有：无。
 *
 * 豁免：scripts/check-boot-order.exemptions.json（{exemptions:[{kind,key,reason}]}，
 * 与 contract-lint 相同机制），每条必须写明销账条件。
 *
 * 用法：node scripts/check-boot-order.mjs（红即 exit 1）；npm run lint:boot-order。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseYaml } from '../packages/platform-core/src/yaml.ts'

/** dsh 宿主提供的服务键（独立宿主形态由 platform-core 等价提供或该插件不装配）；
 *  slots/locale 为 dsh client 运行时（浏览器半插件会话槽位与语言环境），仅 yml 形态存在 */
const HOST_PROVIDED_KEYS = new Set(['webServer', 'slots', 'locale'])

/** yml 形态独有插件（结构性登记，见文件头注释） */
const YML_ONLY_PKGS = new Set(['plugin-dsh-bridge', 'plugin-rq-card'])
/** boot 形态独有插件（结构性登记） */
const BOOT_ONLY_PKGS = new Set([])

const PROVIDE_RE = /static\s+(?:readonly\s+)?provide\s*=\s*'([^']+)'/
const INJECT_RE = /export\s+const\s+inject\s*(?::\s*string\s*\[\]\s*)?=\s*\[([^\]]*)\]/

/** 解析 boot-all.ts：import 别名 → @dsh-ops 包名映射 + ctx.plugin(x) 装配序列（包目录名） */
export function parseBootAll(text) {
  const aliasToPkg = new Map()
  for (const m of text.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+'@dsh-ops\/([\w-]+)'/g)) {
    aliasToPkg.set(m[1], m[2])
  }
  const sequence = []
  for (const m of text.matchAll(/ctx\.plugin\((\w+)/g)) {
    const pkg = aliasToPkg.get(m[1])
    if (pkg) sequence.push(pkg)
  }
  return { sequence, aliasCount: aliasToPkg.size }
}

/**
 * 解析 cordis yml：提取 insert 列表的 (id, name) 序列，name 归一化为包目录名。
 * 支持三种 name 形态：file:// 绝对路径 / 包名+子路径（安装形态）/ 纯包名（浏览器半）。
 */
export function parseCordisYml(text) {
  const sequence = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const idMatch = lines[i].match(/^\s*-\s*id:\s*(\S+)/)
    if (!idMatch) continue
    let name = ''
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const nameMatch = lines[j].match(/^\s*name:\s*(.+)$/)
      if (nameMatch) {
        name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
        break
      }
    }
    let dir = undefined
    const pkgPath = name.match(/\/packages\/([\w-]+)\//)
    if (pkgPath) dir = pkgPath[1]
    else if (name.startsWith('@dsh-ops/')) dir = name.slice('@dsh-ops/'.length)
    sequence.push({ id: idMatch[1], name, dir })
  }
  return sequence
}

/** 扫描一个包的 src 下全部 .ts（递归），返回 { provides:Set, injects:Set }（服务键） */
export async function scanPackageFaces(srcDir) {
  const provides = new Set()
  const injects = new Set()
  let files = []
  try {
    files = await readdir(srcDir, { recursive: true })
  } catch {
    return { provides, injects }
  }
  for (const rel of files) {
    if (!rel.endsWith('.ts')) continue
    let text = ''
    try {
      text = await readFile(join(srcDir, rel), 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(new RegExp(PROVIDE_RE.source, 'g'))) provides.add(m[1])
    const inj = text.match(INJECT_RE)
    if (inj) for (const m of inj[1].matchAll(/'([^']+)'/g)) injects.add(m[1])
  }
  return { provides, injects }
}

/** dsh-plugin-X id → 包目录名 */
export function yamlIdToDir(id) {
  if (id === 'dsh-plugin-platform-core') return 'platform-core'
  return id.replace(/^dsh-plugin-/, 'plugin-')
}

/** depends 归一化：parseYaml 不支持内联 flow 数组（返回原字符串），此处统一提取为字符串数组 */
export function normalizeDepends(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  const inner = value.replace(/^\[/, '').replace(/\]$/, '')
  if (!inner.trim()) return []
  return [...inner.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

export async function loadExemptions(root) {
  const parsed = JSON.parse(await readFile(join(root, 'scripts', 'check-boot-order.exemptions.json'), 'utf8'))
  return new Map((parsed.exemptions ?? []).map((item) => [`${item.kind}::${item.key}`, item]))
}

/**
 * 主校验：返回 { ok, diffs, stats }。diffs 条目 { severity:'red'|'warn', kind, message }。
 */
export async function runBootOrderCheck(root) {
  const diffs = []
  const pushRed = (kind, message) => diffs.push({ severity: 'red', kind, message })
  const pushWarn = (kind, message) => diffs.push({ severity: 'warn', kind, message })

  // -- 采集：三份装配文件 --
  const bootText = await readFile(join(root, 'src', 'boot-all.ts'), 'utf8')
  const boot = parseBootAll(bootText)
  const ymlEntries = parseCordisYml(await readFile(join(root, 'cordis.yml'), 'utf8'))
  const patchEntries = parseCordisYml(await readFile(join(root, 'cordis.patch.yml'), 'utf8'))
  const ymlSeq = ymlEntries.map((e) => e.dir).filter(Boolean)
  const patchSeq = patchEntries.map((e) => e.dir).filter(Boolean)

  // -- 采集：包目录、plugin.yaml、代码 provide/inject 面 --
  // 「清单挂靠目录」：有 plugin.yaml 但无 src（如 plugin-platform-core 挂靠 platform-core
  // 的五面清单，P2-04 补齐前的分离形态）——其清单归属对应代码目录参与对账。
  const allDirs = (await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  const faces = new Map()
  const manifests = new Map()
  for (const pkg of allDirs) {
    faces.set(pkg, await scanPackageFaces(join(root, 'packages', pkg, 'src')))
  }
  for (const pkg of allDirs) {
    let text
    try {
      text = await readFile(join(root, 'packages', pkg, 'plugin.yaml'), 'utf8')
    } catch {
      continue
    }
    let owner = pkg
    if ((faces.get(pkg)?.provides.size ?? 0) === 0 && (faces.get(pkg)?.injects.size ?? 0) === 0) {
      const bare = pkg.replace(/^plugin-/, '')
      if (allDirs.includes(bare)) owner = bare
      else pushWarn('manifest_orphan', `目录 ${pkg} 有 plugin.yaml 但无 src 且找不到挂靠代码目录（孤儿清单）`)
    }
    manifests.set(owner, parseYaml(text))
  }

  // 键 → 提供者包集合
  const provideMap = new Map()
  for (const [pkg, face] of faces) {
    for (const key of face.provides) {
      if (!provideMap.has(key)) provideMap.set(key, [])
      provideMap.get(key).push(pkg)
    }
  }

  const exemptions = await loadExemptions(root)
  const isExempt = (kind, key) => exemptions.has(`${kind}::${key}`)

  // -- [A] 依赖先于使用（boot 与 yml 两个序列各自校验）--
  const checkOrder = (sequence, label) => {
    const pos = new Map(sequence.map((pkg, i) => [pkg, i]))
    for (const pkg of sequence) {
      for (const key of faces.get(pkg)?.injects ?? []) {
        if (HOST_PROVIDED_KEYS.has(key)) continue
        const providers = provideMap.get(key) ?? []
        const loaded = providers.filter((d) => pos.has(d))
        if (loaded.length === 0) {
          pushRed('inject_no_provider', `[${label}] ${pkg} 注入的服务键「${key}」无已装配提供者（providers=${providers.join(',') || '无'}）——插件将静默 INACTIVE`)
        } else if (loaded.every((d) => pos.get(d) > pos.get(pkg))) {
          pushRed('inject_order', `[${label}] ${pkg} 注入「${key}」但提供者（${loaded.join(',')}）均晚于其装配——依赖必须先于使用`)
        }
      }
    }
  }
  checkOrder(boot.sequence, 'boot-all')
  checkOrder(ymlSeq, 'cordis.yml')

  // -- [B] plugin.yaml depends 对账（以 boot-all 序列为基准序）--
  const bootPos = new Map(boot.sequence.map((pkg, i) => [pkg, i]))
  for (const [pkg, manifest] of manifests) {
    for (const dep of normalizeDepends(manifest.depends)) {
      if (!dep.startsWith('dsh-plugin-')) {
        if (!isExempt('depends_free_text', dep)) {
          pushRed('depends_free_text', `${pkg} depends 含非插件 id 条目「${dep}」且未登记豁免`)
        }
        continue
      }
      const depDir = yamlIdToDir(dep)
      if (!allDirs.includes(depDir)) {
        pushRed('depends_unknown', `${pkg} depends 引用不存在的插件「${dep}」（映射目录 ${depDir}）`)
        continue
      }
      if (bootPos.has(pkg) && bootPos.has(depDir) && bootPos.get(depDir) > bootPos.get(pkg)) {
        pushRed('depends_order', `${pkg} depends「${dep}」晚于其装配（boot-all 序列）`)
      }
    }
    // inject×provide 推导的真实依赖未登记 → 补录提示
    const declared = new Set(normalizeDepends(manifest.depends).filter((d) => d.startsWith('dsh-plugin-')).map(yamlIdToDir))
    for (const key of faces.get(pkg)?.injects ?? []) {
      for (const provider of provideMap.get(key) ?? []) {
        if (provider !== pkg && !declared.has(provider) && manifests.has(provider) && !isExempt('depends_undeclared', `${pkg}→${provider}`)) {
          pushWarn('depends_undeclared', `${pkg} 注入「${key}」实际依赖 ${provider}，但 plugin.yaml depends 未登记（建议补录）`)
        }
      }
    }
  }

  // -- [C] cordis.yml ↔ cordis.patch.yml 序列一致 --
  const ymlIds = ymlEntries.map((e) => e.id)
  const patchIds = patchEntries.map((e) => e.id)
  if (ymlIds.join('|') !== patchIds.join('|')) {
    pushRed('yml_pair_divergence', `cordis.yml 与 cordis.patch.yml 插件序列不一致：\n    cordis.yml       = ${ymlIds.join(' → ')}\n    cordis.patch.yml = ${patchIds.join(' → ')}`)
  }

  // -- [D] boot-all ↔ yml 公共序列一致 --
  const ymlSet = new Set(ymlSeq)
  const bootSet = new Set(boot.sequence)
  for (const pkg of boot.sequence) {
    if (!ymlSet.has(pkg) && !BOOT_ONLY_PKGS.has(pkg)) {
      pushRed('boot_only_unregistered', `boot-all 装配了 ${pkg} 但 cordis yml 未装配，且未在 BOOT_ONLY_PKGS 登记`)
    }
  }
  for (const pkg of ymlSeq) {
    if (!bootSet.has(pkg) && !YML_ONLY_PKGS.has(pkg)) {
      pushRed('yml_only_unregistered', `cordis yml 装配了 ${pkg} 但 boot-all 未装配，且未在 YML_ONLY_PKGS 登记`)
    }
  }
  const alignFilter = (seq, otherSet) => seq.filter((p) => otherSet.has(p) && !isExempt('boot_yml_order', p))
  const bootAligned = alignFilter(boot.sequence, ymlSet)
  const ymlAligned = alignFilter(ymlSeq, bootSet)
  for (let i = 0; i < Math.max(bootAligned.length, ymlAligned.length); i++) {
    if (bootAligned[i] !== ymlAligned[i]) {
      pushRed('boot_yml_divergence', `boot-all 与 cordis.yml 公共序列在第 ${i + 1} 位分歧：${bootAligned[i] ?? '（结束）'} ↔ ${ymlAligned[i] ?? '（结束）'}（豁免插件已过滤；序列差异或位置漂移）`)
      break
    }
  }

  // -- [E] provides.services 对账 --
  for (const [pkg, manifest] of manifests) {
    const codeProvides = faces.get(pkg)?.provides ?? new Set()
    for (const key of manifest.provides?.services ?? []) {
      if (!codeProvides.has(key)) {
        pushRed('provides_ghost', `${pkg} plugin.yaml 声明服务「${key}」无代码 provide 实现（幽灵声明）`)
      }
    }
    for (const key of codeProvides) {
      if (!(manifest.provides?.services ?? []).includes(key)) {
        pushWarn('provides_undeclared', `${pkg} 代码提供服务「${key}」未登记进 plugin.yaml provides.services（建议补录）`)
      }
    }
  }

  const stats = {
    bootCount: boot.sequence.length,
    ymlCount: ymlSeq.length,
    patchCount: patchSeq.length,
    pkgCount: allDirs.length,
    serviceKeys: provideMap.size,
  }
  const reds = diffs.filter((item) => item.severity === 'red')
  return { ok: reds.length === 0, diffs, stats, exemptions }
}

// -- CLI 入口 --
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check-boot-order.mjs')) {
  const root = process.cwd()
  const { ok, diffs, stats, exemptions } = await runBootOrderCheck(root)
  console.log('━━ 装配顺序与模块边界校验（R3，REFACTOR-2026-10-13）━━')
  console.log(`  装配序列：boot-all ${stats.bootCount} 插件 / cordis.yml ${stats.ymlCount} / cordis.patch.yml ${stats.patchCount}；包 ${stats.pkgCount} 个，服务键 ${stats.serviceKeys} 个`)
  for (const item of diffs) {
    const tag = item.severity === 'red' ? '❌' : '⚠ '
    console.log(`  ${tag} [${item.kind}] ${item.message}`)
  }
  if (exemptions.size > 0) {
    console.log(`  🔖 豁免登记 ${exemptions.size} 条：`)
    for (const [key, item] of exemptions) console.log(`     - ${key} —— ${item.reason}`)
  }
  const reds = diffs.filter((item) => item.severity === 'red').length
  const warns = diffs.length - reds
  console.log(`  结果：${reds} 错误 / ${warns} 提示 ${reds === 0 ? '✔' : '✘'}`)
  process.exit(ok ? 0 : 1)
}
