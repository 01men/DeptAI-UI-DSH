#!/usr/bin/env node
/**
 * dist-build-id —— 6 随附包预构建产物（dist/）的新鲜度指纹（plan-gate01 Phase 1.2；2026-09-11 扩容）。
 *
 * 机制仿 packages/plugin-rq-card/build-id.mjs（浏览器半 build-id）：对「随附包 src 树 +
 * 构建脚本自身」做 sha256 指纹，写入各包 dist/.build-id；tests/selftest.mjs 装机段重算比对，
 * 「改了随附包 src 忘跑 npm run build:dist」会在推送交付前被拦下（与浏览器半同规格）。
 *
 * 指纹输入（双端一致，改这里 = 同时改 build-dist.mjs 的转译清单语义）：
 *   - packages/<pkg>/src/**（按扩展名 .ts/.tsx 转译；plugin-rq-card 排除 src/client/**
 *     ——浏览器半归 build.mjs/lib/client.js 管，服务端 dist 不含它）；
 *   - 非 TS 运行期资产同布局拷贝：packages/plugin-panel-core/src/seed/demo-content.json
 *     （seed.ts 经 import.meta 同级解析，esbuild 不拷贝 JSON）——它就在 src/** 内，天然入指纹；
 *   - scripts/build-dist.mjs 自身（构建语义变化 → 全部产物过期重建）；
 *   - 全部文件内容 \r 归一后哈希：Windows autocrlf 工作区（CRLF）与 Linux CI 检出（LF）
 *     必须算出同值——否则指纹变成平台相关的假新鲜（2026-09-16 CI 实证，双端各红一次）。
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 6 随附包（plan-gate01 §一 产物构成 + 2026-09-11 可用性补环）：底座面基座 4 + 面板面 2。 */
export const DIST_PACKAGES = [
  'platform-core',
  'plugin-iam',
  'plugin-authn',
  'plugin-dsh-bridge',
  'plugin-panel-core',
  'plugin-rq-card',
]

/** rq-card 浏览器半目录：不进服务端 dist（由 build.mjs → lib/client.js 单独交付）。 */
const CLIENT_EXCLUDE = 'plugin-rq-card/src/client'

/** BUILD_ID 头标（写入 dist/.build-id 首行注释位）。 */
export const DIST_BUILD_ID_HEADER = 'gate01-dist-build-id'

/** 递归收集目录下文件（相对路径用 POSIX 斜杠，排序保证确定性）。 */
function collectFiles(rootDir, base, out) {
  const dir = join(rootDir, base)
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const rel = base ? `${base}/${entry}` : entry
    const abs = join(rootDir, rel)
    if (statSync(abs).isDirectory()) collectFiles(rootDir, rel, out)
    else out.push(rel)
  }
  return out
}

/** 计算 dist 形态指纹：随附包 src 树 + 构建脚本，sha256 前 16 hex。 */
export function computeDistBuildId(rootDir) {
  const hash = createHash('sha256')
  const files = []
  for (const pkg of DIST_PACKAGES) {
    collectFiles(rootDir, join('packages', pkg, 'src').split(sep).join('/'), files)
  }
  files.push('scripts/build-dist.mjs')
  const relevant = files
    .filter((rel) => !rel.includes(CLIENT_EXCLUDE.split('/').join(sep)) && !rel.includes(CLIENT_EXCLUDE))
    .sort()
  for (const rel of relevant) {
    hash.update(rel)
    hash.update('\0')
    hash.update(stripCr(readFileSync(join(rootDir, rel))))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/** 内容 \r 归一：Windows autocrlf 工作区（CRLF）与 Linux CI 检出（LF）必须算出同值。 */
function stripCr(buf) {
  return Buffer.from(buf.toString('utf8').replace(/\r/g, ''), 'utf8')
}

/** 读取某包 dist/.build-id 的指纹值（缺失/坏文件返回 null）。 */
export function readDistBuildId(rootDir, pkg) {
  const file = join(rootDir, 'packages', pkg, 'dist', '.build-id')
  if (!existsSync(file)) return null
  const raw = readFileSync(file, 'utf8')
  const match = new RegExp(`${DIST_BUILD_ID_HEADER}: ([0-9a-f]{16})`).exec(raw)
  return match?.[1] ?? null
}

/** 生成 .build-id 文件内容。 */
export function buildIdFileContent(id) {
  return `${DIST_BUILD_ID_HEADER}: ${id}\n（预构建产物指纹——src 树或构建脚本变更后须重跑 npm run build:dist，selftest 装机段比对此值）\n`
}
