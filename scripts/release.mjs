#!/usr/bin/env node
/**
 * release.mjs —— @ybkk/gate-01 npm 通道一键发布（docs/release-gate01.md 定版流程的自动化）。
 *
 * 一条命令走完定版「版本节奏」（docs/release-gate01.md 注意事项节）：
 *   git 护栏 → npmjs 登录校验（失效自动拉起 npm login 浏览器 2FA）→ 版本决策与落盘 →
 *   build:dist + rq-card 浏览器半重建 → lint:manifests + selftest → npm pack 校验 →
 *   publish（官方源，scope 包显式 --access public）→ npm view 发布验证 →
 *   发布记录回填手册 → 提交 + 推送交付（铁律 3：推送即交付）。
 *
 * 用法：
 *   npm run release                        # 常规发布：树版本 > npm latest 直接复用；相等自动 patch
 *   npm run release -- patch|minor|major   # 强制升位
 *   npm run release -- --version 1.3.0     # 指定版本
 *   npm run release -- --note "备注"       # 发布记录表备注（默认「常规发布」）
 *   npm run release -- --skip-tests        # 跳过 selftest（lint:manifests 仍必跑）
 *   npm run release -- --dry-run           # 演练：构建+检查真实执行，发版/发布/提交/推送只打印
 *   npm run release -- --no-login          # 未登录时不自动拉起 login（CI/后台场景）
 *
 * 凭证边界：npm 账号属本人资产（docs/release-gate01.md §用户侧配合）。granular token 绕行
 * 已被 npm 限制（发布手册实证），脚本只在登录态失效时代为拉起
 * `npm login --registry=https://registry.npmjs.org/`（浏览器本人完成授权），token 由 npm
 * 写回 ~/.npmrc；官方源发布触发的 web 浏览器确认（npm 2026 政策）同理，publish 以
 * inherit stdio 运行、终端可见授权链接。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NPMJS = 'https://registry.npmjs.org/'
const PKG_NAME = '@ybkk/gate-01'
const RELEASE_BRANCH = 'custom/dsh-rq'
const RELEASE_DOC = 'docs/release-gate01.md'

/* ---------- 参数 ---------- */
const opts = { bump: null, version: null, note: '常规发布', skipTests: false, dryRun: false, noLogin: false }
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--dry-run') opts.dryRun = true
  else if (a === '--skip-tests') opts.skipTests = true
  else if (a === '--no-login') opts.noLogin = true
  else if (a === '--note') opts.note = process.argv[++i] ?? opts.note
  else if (a.startsWith('--note=')) opts.note = a.slice('--note='.length)
  else if (a === '--version') opts.version = process.argv[++i]
  else if (a.startsWith('--version=')) opts.version = a.slice('--version='.length)
  else if (['patch', 'minor', 'major'].includes(a)) opts.bump = a
}

/* ---------- 小工具 ---------- */
function sh(cmd, { capture = false } = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

function die(msg) {
  console.error(`\n[release] ✗ ${msg}`)
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const localDate = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const semver = (v) => v.split('.').map(Number)
function cmpVersion(a, b) {
  const x = semver(a)
  const y = semver(b)
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  }
  return 0
}
function bumpVersion(v, kind) {
  const [ma, mi, pa] = semver(v)
  if (kind === 'major') return `${ma + 1}.0.0`
  if (kind === 'minor') return `${ma}.${mi + 1}.0`
  return `${ma}.${mi}.${pa + 1}`
}

/** 版本决策：显式指定 > 强制升位 > 树版本领先直接复用 > 同版自动 patch。 */
function decideTarget(treeV, latestV) {
  if (opts.version) {
    if (!/^\d+\.\d+\.\d+$/.test(opts.version)) die(`--version 非法：${opts.version}（须 x.y.z）`)
    return opts.version
  }
  if (opts.bump) return bumpVersion(treeV, opts.bump)
  if (!latestV) return treeV
  const rel = cmpVersion(treeV, latestV)
  if (rel > 0) return treeV
  if (rel === 0) return bumpVersion(treeV, 'patch')
  die(`树版本 ${treeV} 低于 npm latest ${latestV}——不能发旧版本；先同步仓库，或 --version 指定更高版本`)
}

/** 版本落盘：根 package.json + package-lock.json（根 "" 与 packages."" 两处版本字段）。 */
function writeVersion(version) {
  const edits = [
    ['package.json', (p) => { p.version = version }],
    ['package-lock.json', (p) => {
      if (typeof p.version === 'string') p.version = version
      const root = p.packages?.['']
      if (root && typeof root.version === 'string') root.version = version
    }],
  ]
  for (const [file, mutate] of edits) {
    const path = join(ROOT, file)
    const obj = JSON.parse(readFileSync(path, 'utf8'))
    mutate(obj)
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
  }
}

/** 发布记录回填 docs/release-gate01.md（幂等：同版本已登记即跳过）。 */
function backfillReleaseDoc(version, note) {
  const path = join(ROOT, RELEASE_DOC)
  const text = readFileSync(path, 'utf8')
  if (text.includes(`${PKG_NAME}@${version}`)) return
  const sep = '|---|---|---|---|'
  const sepAt = text.indexOf(sep)
  if (sepAt < 0) {
    console.warn(`[release] ⚠ ${RELEASE_DOC} 发布记录表定位失败，请手工回填`)
    return
  }
  const lineEnd = text.indexOf('\n', sepAt) + 1
  const row = `| ${PKG_NAME}@${version} | ${localDate()} | npm（latest） | ${note} |\n`
  writeFileSync(path, text.slice(0, lineEnd) + row + text.slice(lineEnd))
  console.log(`[release] 发布记录已回填 ${RELEASE_DOC}`)
}

async function main() {
  console.log(`[release] ${PKG_NAME} 一键发布${opts.dryRun ? '（dry-run 演练）' : ''}`)

  /* 1. git 护栏：铁律 1（唯一开发分支）+ 干净工作树 */
  const branch = sh('git rev-parse --abbrev-ref HEAD', { capture: true })
  if (!branch.ok || branch.out !== RELEASE_BRANCH) {
    die(`当前分支「${branch.out}」≠ ${RELEASE_BRANCH}（AGENTS.md 铁律 1：唯一开发分支）`)
  }
  const dirty = sh('git status --porcelain --untracked-files=no', { capture: true })
  if (dirty.out) {
    die(`工作树有未提交改动，先提交/清理再发布：\n${dirty.out}\n` +
        '（若上次发布中断——npm 已发出但未提交——请先 git add -A && git commit && git push 再重跑）')
  }

  /* 2. npmjs 登录态（失效即自动拉起浏览器 login；granular token 绕行已被 npm 封死） */
  let who = sh(`npm whoami --registry ${NPMJS}`, { capture: true })
  if (!who.ok) {
    if (opts.dryRun) {
      console.log('[release] 登录态校验：未登录（dry-run 放行；实际发布将自动拉起 npm login）')
    } else if (opts.noLogin) {
      die('npmjs 未登录——先执行 npm login --registry=https://registry.npmjs.org/')
    } else {
      console.log('[release] npmjs 登录态失效/缺失 → 拉起 npm login（浏览器 2FA，请本人完成授权）')
      if (!sh(`npm login --registry ${NPMJS}`).ok) die('npm login 未完成，中止')
      who = sh(`npm whoami --registry ${NPMJS}`, { capture: true })
      if (!who.ok) die('login 后 whoami 仍失败——检查 ~/.npmrc 中 //registry.npmjs.org/:_authToken 行')
    }
  }
  if (who.ok) console.log(`[release] npmjs 账号：${who.out}`)

  /* 3. 版本决策 */
  const treeV = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const view = sh(`npm view ${PKG_NAME} version --prefer-online --registry ${NPMJS}`, { capture: true })
  const latestV = view.ok ? view.out : null
  const target = decideTarget(treeV, latestV)
  console.log(`[release] 版本决策：树 ${treeV} / npm latest ${latestV ?? '(未发布)'} → 目标 ${target}` +
      (target === treeV ? '（复用树版本）' : ''))
  if (latestV && cmpVersion(target, latestV) <= 0) {
    die(`目标 ${target} ≤ npm latest ${latestV}——npm 不允许覆盖已发布版本`)
  }
  const needBump = target !== treeV

  /* 4. 构建产物（fresh-install 铁律：dist 与浏览器半必须与 src 同步） */
  console.log('[release] 构建随附包 dist（npm run build:dist）…')
  if (!sh('npm run build:dist').ok) die('build:dist 失败')
  console.log('[release] 构建 rq-card 浏览器半（build.mjs）…')
  if (!sh('node packages/plugin-rq-card/build.mjs').ok) die('rq-card 浏览器半构建失败')

  /* 5. 检查（铁律 6：全量回归全绿才可发布/推送） */
  if (!sh('npm run lint:manifests').ok) die('lint:manifests 失败')
  if (opts.skipTests) console.log('[release] --skip-tests：跳过 selftest')
  else if (!sh('npm run selftest').ok) die('selftest 失败（全量回归必须全绿）')

  if (opts.dryRun) {
    console.log('\n[release][dry-run] 演练通过。实际执行将依次：')
    console.log(`  - ${needBump ? `版本落盘 ${treeV} → ${target}（package.json + package-lock.json）` : `版本保持 ${target}（树版本已领先 npm latest）`}`)
    console.log('  - npm pack 校验 → npm publish --access public --registry https://registry.npmjs.org/')
    console.log('  - npm view 发布验证 → docs/release-gate01.md 发布记录回填 → git add/commit → git push（交付）')
    return
  }

  /* 6. 版本落盘（publish 失败自动回滚，保证重跑幂等；顺带同步可能滞后的 lockfile 版本） */
  writeVersion(target)
  console.log(`[release] 版本落盘：package.json/package-lock.json → ${target}${needBump ? `（${treeV} 升级）` : '（lockfile 版本同步）'}`)

  /* 7. pack 校验 + 发布（scope 包显式 --access public；官方源 web 浏览器确认在终端可见） */
  let failed = null
  if (!sh('npm pack --dry-run').ok) failed = 'npm pack 校验失败'
  if (!failed) {
    const otp = process.env.NPM_OTP ? ` --otp ${process.env.NPM_OTP}` : ''
    if (!sh(`npm publish --access public --registry ${NPMJS}${otp}`).ok) {
      failed = 'npm publish 失败（若是浏览器认证中断，完成授权后直接重跑 npm run release）'
    }
  }
  if (failed) {
    sh('git checkout -- package.json package-lock.json')
    console.error('[release] 版本落盘已回滚')
    die(failed)
  }

  /* 8. 发布验证（--prefer-online 绕开 npm 本地请求缓存——packument 带 max-age≈60s，
       发布后裸 view 会命中缓存造成「未即时查到」假警报；CDN 边缘最坏也只滞后 ~60s） */
  let published = false
  for (let i = 0; i < 10 && !published; i++) {
    await sleep(3000)
    const v = sh(`npm view ${PKG_NAME} version --prefer-online --registry ${NPMJS}`, { capture: true })
    published = v.ok && v.out === target
  }
  if (!published) {
    console.warn(`[release] ⚠ 30s 内未查到 ${target}——publish 的「+ ${PKG_NAME}@${target}」行已表明 registry 受理，` +
        `此处多为 CDN 缓存滞后（≤60s）。人工复核：npm view ${PKG_NAME} version --prefer-online --registry ${NPMJS}`)
  }

  /* 9. 发布记录回填 */
  backfillReleaseDoc(target, opts.note)

  /* 10. 提交 + 推送交付（铁律 3：推送即交付） */
  sh('git add package.json package-lock.json docs/release-gate01.md packages')
  const hasStaged = !sh('git diff --cached --quiet', { capture: true }).ok
  if (hasStaged) {
    if (!sh(`git commit -m "chore(release): ${PKG_NAME}@${target} —— npm 通道一键发布（release.mjs）"`).ok) {
      die(`npm 版本已发布但 git commit 失败——请手工提交并 git push 完成交付`)
    }
    if (!sh('git push').ok) {
      console.warn('[release] ⚠ git push 失败——npm 已发布但交付未推（铁律 3），请手工 git push')
    }
  }

  console.log(`\n[release] ✓ ${PKG_NAME}@${target} 发布完成 → https://www.npmjs.com/package/${PKG_NAME.replace('/', '%2f')}`)
  console.log('[release] 收尾提醒（docs/release-gate01.md §开发侧执行 5）：真机冒烟 dsh plugin add --profile <全新profile> @ybkk/gate-01')
}

main().catch((error) => {
  console.error('[release] 失败：', error?.message ?? error)
  process.exit(1)
})
