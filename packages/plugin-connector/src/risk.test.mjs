/**
 * 连接器风险目录单元测试（R6 声明式化，2026-10-13）。
 *
 * 运行方式（Node 直接加载）：
 *
 *     node packages/plugin-connector/src/risk.test.mjs
 *
 * 覆盖面：
 *   - resolveRiskLevel 优先级链：显式 riskLevel > 声明 actions > 声明 defaultRisk
 *     > 启发式（含 admin 兜底 fail-closed）；
 *   - service 入参优先于 action.service 字段；
 *   - riskTierOf 分层读取（有声明/无声明）；
 *   - 生成物 risk-overrides.generated.ts 与事实源 catalog/risk-overrides.json 逐键一致
 *     （防「改了 JSON 忘跑 gen-connector-catalog.mjs」的漂移）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { RISK_OVERRIDES } from './risk-overrides.generated.ts'
import { heuristicRiskLevel, resolveRiskLevel, riskTierOf } from './risk.ts'

// -- 优先级链：显式 riskLevel > 声明 actions > 声明 defaultRisk > 启发式 ------------

test('优先级① action 显式 riskLevel 胜过声明目录（前向兼容上游加字段）', () => {
  // github.create_issue 在声明目录为 write，显式 read 直接采信
  assert.equal(resolveRiskLevel({ id: 'github.create_issue', service: 'github', riskLevel: 'read' }), 'read')
  assert.equal(resolveRiskLevel({ id: 'github.delete_webhook', service: 'github', riskLevel: 'write' }), 'write')
})

test('优先级② 声明 actions 级胜过 provider defaultRisk', () => {
  // github defaultRisk=write，delete_webhook 显式声明 admin
  assert.equal(resolveRiskLevel({ id: 'github.delete_webhook', service: 'github' }), 'admin')
  // hackernews defaultRisk=read，do_the_thing 显式声明 admin（fail-closed 面保留）
  assert.equal(resolveRiskLevel({ id: 'hackernews.do_the_thing', service: 'hackernews' }), 'admin')
})

test('优先级③ 声明 defaultRisk 胜过名称/作用域启发式（声明即口径）', () => {
  // 未声明 action：名称含 delete/destroy 启发式会给 admin，但 github defaultRisk=write 生效
  const undeclared = { id: 'github.destroy_organization', name: 'destroy organization', service: 'github' }
  assert.equal(heuristicRiskLevel(undeclared), 'admin', '启发式对照面：本应 admin')
  assert.equal(resolveRiskLevel(undeclared), 'write', '声明 defaultRisk 覆盖启发式')
})

test('优先级④ 无声明 provider 回落启发式（scope/名称判定仍生效）', () => {
  assert.equal(resolveRiskLevel({ id: 'zapp.list_widgets', service: 'zapp', requiredScopes: ['data:read'] }), 'read')
  assert.equal(resolveRiskLevel({ id: 'zapp.push_event', service: 'zapp', requiredScopes: ['events:write'] }), 'write')
})

test('优先级⑤ 无声明且无可判定依据 → admin 兜底 fail-closed', () => {
  assert.equal(resolveRiskLevel({ id: 'zapp.do_the_thing', service: 'zapp' }), 'admin')
  assert.equal(resolveRiskLevel({ id: 'zapp.do_the_thing' }), 'admin')
})

// -- service 解析口径 ----------------------------------------------------------

test('service 入参优先于 action.service 字段；缺省时取 action.service', () => {
  assert.equal(resolveRiskLevel({ id: 'github.delete_webhook', service: 'hackernews' }, 'github'), 'admin', '显式入参 github 生效')
  assert.equal(resolveRiskLevel({ id: 'github.delete_webhook', service: 'hackernews' }), 'read', '无入参回落 action.service=hackernews 的 defaultRisk')
  assert.equal(resolveRiskLevel({ id: 'github.delete_webhook' }), 'admin', '两者皆缺 → 无声明回落启发式（名称 delete → admin）')
})

// -- riskTier 分层读取 ----------------------------------------------------------

test('riskTierOf：有声明返回 S1/S2，无声明返回 undefined', () => {
  assert.equal(riskTierOf('github'), 'S2')
  assert.equal(riskTierOf('hackernews'), 'S1')
  assert.equal(riskTierOf('zapp'), undefined)
  assert.equal(riskTierOf(''), undefined)
  assert.equal(riskTierOf(undefined), undefined)
})

// -- 生成物与事实源一致性（防忘跑 gen-connector-catalog.mjs 漂移） ------------------

test('生成物与 catalog/risk-overrides.json 逐键一致', () => {
  const jsonPath = fileURLToPath(new URL('../catalog/risk-overrides.json', import.meta.url))
  const declared = JSON.parse(readFileSync(jsonPath, 'utf8'))
  assert.deepEqual(RISK_OVERRIDES, declared.providers, 'RISK_OVERRIDES 必须等于 JSON 的 providers 面（键序无关）')
})

test('声明目录自身取值合法（风险级 read|write|admin、tier S1|S2、provider 名规范）', () => {
  const providerName = /^[a-z0-9-]+$/
  for (const [service, entry] of Object.entries(RISK_OVERRIDES)) {
    assert.match(service, providerName, `provider 名须满足 ${providerName.source}`)
    assert.ok(['read', 'write', 'admin'].includes(entry.defaultRisk), `${service}.defaultRisk 取值合法`)
    assert.ok(['S1', 'S2'].includes(entry.riskTier), `${service}.riskTier 取值合法`)
    for (const [actionId, level] of Object.entries(entry.actions ?? {})) {
      assert.ok(actionId.length > 0, `${service} 存在空 action id`)
      assert.ok(['read', 'write', 'admin'].includes(level), `${service}.${actionId} 风险级取值合法`)
    }
  }
})
