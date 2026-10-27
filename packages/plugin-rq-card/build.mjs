#!/usr/bin/env node
/**
 * build.mjs —— 产出浏览器半 bundle lib/client.js（WP-06 交付物 4）。
 *
 * 【为什么必须构建（spike §4.4 构建门禁）】client-modules 对声明的 client 包
 * 伺服 /plugins/<包名>/client.js（issue #1 修复后包名=根包 @ybkk/gate-01）；产物缺失时
 * 宿主激活期响亮抛错（MissingClientBundleError → ClientPackageCompositionError），
 * `dsh web` 直接启动失败。因此启动前必须先跑本脚本。
 *
 * 【构建策略】等价复刻 dsh 检出的 tsdown.client.ts 预设
 * （packages/client/tsdown.client.ts，只读参照）：esbuild 单文件 CJS bundle，
 * banner/footer 拼 closure-factory 形状——
 *
 *     var module = { exports: {} }; var exports = module.exports;
 *     window.__ModuleLoader__.load({ id: "@ybkk/plugin-rq-card", factory: (require) => {
 *       ...bundle...
 *       return module.exports; } });
 *
 * 与预设的关键对齐点：
 *   - external = 平台模块表（packages/client/web/src/platform.ts 的
 *     PLATFORM_MODULES）+ dsh-client-runtime/client 豁免（tsdown.client.ts 的
 *     RUNTIME_STORE_EXEMPTION）——这些 require 由 loader 模块表在运行时供给；
 *   - 其余依赖全部内联（noExternal 语义）：本包浏览器半对 @deepseek-ai/* 只有
 *     type-only import（编译期擦除），零值导入，天然满足纯度门禁；
 *   - format cjs / platform browser / jsx automatic（react/jsx-runtime 走外部表）；
 *   - define 兜 process.env.NODE_ENV / import.meta.env（预设同款，防工厂执行期
 *     ReferenceError）。
 *
 * 【dsh 检出 diff=0 铁律】本脚本只**运行** dsh 检出内的 esbuild 二进制/JS API
 * （路径探测顺序：env DSH_CHECKOUT → D:\DSH\deepseek-harness），不写其任何文件。
 * 等价物也支持：若系统 PATH 有 esbuild（版本 ≥0.17）则直接用，不依赖 dsh 检出。
 *
 * 用法：node packages/plugin-rq-card/build.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { BUILD_ID_HEADER, computeClientBuildId } from './build-id.mjs'

const PKG_ROOT = fileURLToPath(new URL('.', import.meta.url))
// 浏览器半装载 id = 宿主 boot 图行 id = client-modules 解析出的 packageName。
// issue #1 修复（2026-10-27）后两个装配形态（cordis.patch.yml 根包名 / cordis.yml 根
// index.js 路径）都落在根包 @ybkk/gate-01 的元数据上——装载 id 必须与之一致，
// 否则 bundle 自注册的 id 与图行 id 不匹配，工厂永远不被物化。
const PLUGIN_ID = '@ybkk/gate-01'

/** 平台模块表（镜像 dsh packages/client/web/src/platform.ts，升级 dsh 时同步）。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/** tsdown.client.ts 的文档化临时豁免（快照存储引擎，runtime 的立即档行）。 */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

const EXTERNALS = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/** 比较两个 semver 字符串（足够 esbuild 版本挑选用）。 */
function semverGreater(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

/** 在 dsh 检出的 pnpm 布局里找 esbuild 包目录（返回含 package.json 的目录）。 */
function findEsbuildInPnpm(dshRoot) {
  const pnpmDir = join(dshRoot, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return null
  let best = null
  let bestVersion = ''
  for (const entry of readdirSync(pnpmDir)) {
    const match = /^esbuild@(\d+\.\d+\.\d+)$/.exec(entry)
    if (match === null) continue
    const candidate = join(pnpmDir, entry, 'node_modules', 'esbuild')
    if (existsSync(join(candidate, 'lib', 'main.js')) && semverGreater(match[1], bestVersion)) {
      best = candidate
      bestVersion = match[1]
    }
  }
  return best
}

/** 定位 esbuild 的 JS API 模块路径（优先 dsh 检出，其次本仓/上层 node_modules）。 */
async function resolveEsbuildApi() {
  const dshRoot = process.env.DSH_CHECKOUT ?? 'D:\\DSH\\deepseek-harness'
  const candidates = []
  const inPnpm = findEsbuildInPnpm(dshRoot)
  if (inPnpm !== null) candidates.push(inPnpm)
  candidates.push(join(dshRoot, 'node_modules', 'esbuild'))
  candidates.push(join(PKG_ROOT, '..', '..', 'node_modules', 'esbuild'))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'lib', 'main.js'))) {
      const main = join(candidate, 'lib', 'main.js')
      const api = await import(pathToFileURL(main).href)
      return { api, from: candidate }
    }
  }
  return null
}

/** 构建纯度门禁（tsdown.client.ts 的 dsh-client-bundle-purity 插件等价物）。 */
function purityGate() {
  const external = new Set(EXTERNALS)
  return {
    name: 'rq-client-bundle-purity',
    setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
        if (external.has(args.path)) return { path: args.path, external: true }
        throw new Error(
          `client bundle purity: "${args.path}" 不是平台模块（EXTERNALS 成员）——`
          + '@deepseek-ai/* 只允许 type-only import（编译期擦除）；跨插件协作走 cordis 服务',
        )
      })
    },
  }
}

async function main() {
  const resolved = await resolveEsbuildApi()
  if (resolved === null) {
    console.error('[rq-card/build] 未找到 esbuild JS API（探测过 dsh 检出与本仓 node_modules）。')
    console.error('[rq-card/build] 处置：安装 esbuild ≥0.17（npm i -D esbuild）或确认 dsh 检出路径（env DSH_CHECKOUT）。')
    process.exit(1)
  }
  const { api: esbuild, from: esbuildFrom } = resolved
  console.log(`[rq-card/build] esbuild @ ${esbuildFrom}`)

  const result = await esbuild.build({
    absWorkingDir: PKG_ROOT,
    entryPoints: ['src/client/index.ts'],
    outfile: 'lib/client.js',
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    jsx: 'automatic',
    jsxImportSource: 'react',
    sourcemap: true,
    external: EXTERNALS,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // closure-factory 形状（tsdown.client.ts 的 banner/intro/footer 等价物）：
    // loader 物化时执行一次工厂，返回 bundle 导出，require 解析平台模块表。
    // 首行 build-id 指纹（fresh-install 装机门禁）：selftest 用 build-id.mjs 重算比对，
    // 「改了 src/client 忘了重建」会在推送前被拦下。
    //
    // 【装载防御与失效可见化（QA 2026-09-08 BUG-G-01 / T-14）】此前 banner 直接
    // `window.__ModuleLoader__.load(...)`：装载器未就绪（脚本顺序竞态）即整脚本抛错、
    // apply 永不执行、无任何用户可见信号——真实 dsh web 上四项会话侧能力全数静默消失。
    // 现在三道防线：① 装载器未就绪 → 250ms×40 有界重试；② load() 被接受但工厂 5s 内
    // 未被物化 → 记录 registered-not-materialized（rc.7 消费链缺陷的可判读指纹）；
    // ③ 终局未安装 → 直接挂 DOM 诊断角标（不依赖 slots），并把台账留在
    // window.__RQ_CARD_DIAG__ 供运维/宿主侧取证。
    banner: {
      js: [
        `/* ${BUILD_ID_HEADER}: ${computeClientBuildId(PKG_ROOT)} */`,
        '(function () {',
        '  var PLUGIN_ID = "@ybkk/gate-01";',
        '  var DIAG = window.__RQ_CARD_DIAG__ = window.__RQ_CARD_DIAG__ || { installed: false, attempts: [] };',
        '  var note = function (stage, error) {',
        '    var entry = { at: new Date().toISOString(), stage: stage };',
        '    if (error !== undefined) entry.error = String((error && error.message) || error);',
        '    DIAG.attempts.push(entry);',
        '    if (DIAG.attempts.length > 50) DIAG.attempts.shift();',
        '  };',
        '  var badge = function (text) {',
        '    try {',
        '      if (document.querySelector(".rq-card-diag-badge")) return;',
        '      var el = document.createElement("button");',
        '      el.type = "button";',
        '      el.className = "rq-card-diag-badge";',
        '      el.textContent = text;',
        '      el.title = "01门卡片注入失败——诊断信息见 window.__RQ_CARD_DIAG__，请截图反馈给管理员。点击刷新重试。";',
        '      el.setAttribute("style", "position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:6px 12px;border-radius:14px;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;font-size:12px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.12)");',
        '      el.onclick = function () { location.reload(); };',
        '      (document.body || document.documentElement).appendChild(el);',
        '    } catch (e) { /* 无 document 环境（Node 自测）忽略 */ }',
        '  };',
        '  var mount = function () {',
        '    var loader = window.__ModuleLoader__;',
        '    if (!loader || typeof loader.load !== "function") return false;',
        '    try {',
        '      loader.load({ id: PLUGIN_ID, factory: function (require) {',
        '        var module = { exports: {} }; var exports = module.exports;',
        '        try { var stale = document.querySelector(".rq-card-diag-badge"); if (stale && stale.parentNode) stale.parentNode.removeChild(stale); } catch (e) {}',
      ].join('\n'),
    },
    footer: {
      js: [
        '        DIAG.installed = true; // 工厂体完整执行成功才记安装（bundle 抛错不算）',
        '        return module.exports;',
        '      } });',
        '      note(DIAG.installed ? "installed" : "registered-not-materialized");',
        '      return true;',
        '    } catch (error) {',
        '      note("factory-threw", error);',
        '      return true;',
        '    }',
        '  };',
        '  if (mount()) {',
        '    // load() 被接受 ≠ 工厂被物化：5s 后仍未安装即亮角标（rc.7 消费链缺陷指纹）',
        '    if (!DIAG.installed) {',
        '      setTimeout(function () {',
        '        if (!DIAG.installed) { note("materialize-missing"); badge("01门卡片未生效（宿主未装载插件）"); }',
        '      }, 5000);',
        '    }',
        '    return;',
        '  }',
        '  note("loader-missing");',
        '  var tries = 0;',
        '  var timer = setInterval(function () {',
        '    if (mount() || ++tries >= 40) {',
        '      clearInterval(timer);',
        '      if (!DIAG.installed) { note("loader-missing-persistent"); badge("01门卡片未生效（装载器不可达）"); }',
        '    }',
        '  }, 250);',
        '})();',
      ].join('\n'),
    },
    plugins: [purityGate()],
    logLevel: 'info',
  })
  if (result.errors.length > 0) process.exit(1)

  // ── 产物形状自检 ──
  const outfile = join(PKG_ROOT, 'lib', 'client.js')
  const head = readFileSync(outfile, 'utf8').slice(0, 4000) // 装载防御 banner 变长：取前 4k 覆盖 mount() 定义
  if (!head.includes('__ModuleLoader__') || !head.includes(PLUGIN_ID)) {
    console.error('[rq-card/build] 产物头部不含 closure-factory 形状，构建结果不可信。')
    process.exit(1)
  }
  if (!head.includes(`${BUILD_ID_HEADER}: ${computeClientBuildId(PKG_ROOT)}`)) {
    console.error('[rq-card/build] 产物头部 build-id 指纹缺失或不符，构建结果不可信。')
    process.exit(1)
  }
  const size = statSync(outfile).size
  console.log(`[rq-card/build] OK → packages/plugin-rq-card/lib/client.js（${(size / 1024).toFixed(1)} KiB）`)
  console.log('[rq-card/build] 提示：dsh web 启动会伺服 /plugins/@ybkk/gate-01/client.js（根包名，issue #1 修复后）；lib/ 建议纳入版本管理（激活期缺产物=宿主启动失败）。')
}

main().catch((error) => {
  console.error('[rq-card/build] 构建失败：', error?.message ?? error)
  process.exit(1)
})
