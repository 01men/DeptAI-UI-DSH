# 审批逻辑调整说明（2026-09-15）

> 来源：业务方三项需求——① Skill 两级审批允许同一人完成（同人二次审批）；
> ② 审批驳回单支持删除（Skill 驳回记录 + 审批中心驳回审批单）；
> ③ 审批中心提交人与审批人允许同一账号（自审自批拦截取消）。本文记录改动、验证与回滚方式。

## 一、改动清单

| 编号 | 需求 | 改动位置 | 修法一句话 |
|---|---|---|---|
| APR-01 | 同人二次审批 | `plugin-skillhub/src/index.ts` approve | 移除原 REL-03「security 加签人须 ≠ domain 审批人」限制，允许同一审批人依次通过 domain 与 security 两级；两级顺序与状态机不变，同级别重复审批仍拦截 |
| APR-02 | Skill 驳回可删 | `plugin-console/src/index.ts` DELETE /api/skills/:id | 可删状态由 {deprecated, offline} 扩为 {deprecated, offline, rejected}（审批驳回记录可清理，被 Agent 引用仍拒绝） |
| APR-03 | 驳回审批单可删 | `plugin-audit/src/index.ts` deleteApproval + `plugin-console/src/index.ts` DELETE /api/approvals/:id | 新增审批单删除（服务层仅放行 status=rejected；pending/approved/executed/failed 含执行事实一律不可删）；权限沿用 approval.decide，删除写 change 审计（action=approval.delete） |
| APR-04 | 前端入口 | `plugin-console/public/js/pages/approvals.js` · `skills.js` | 审批中心：驳回单卡片与详情抽屉新增「删除」按钮（二次确认）；Skill 详情：驳回状态新增「删除」按钮；审批弹窗提示「允许同一人连审两级」 |
| APR-05 | 提交人可自审 | `plugin-audit/src/index.ts` decideApproval | 移除原 QA A-05「提交人与审批人不得为同一账号（自审自批）」拦截（approve/reject 一并放开）；审批权限点（approval.decide）与高风险二次确认（confirmed）校验不变 |

### 行为口径

- **两级审批（Skill 上架）**：domain 审批通过后，同一账号可继续完成 security 加签（高风险 Skill 两级均须通过的要求不变）。原 QA 修复 REL-03（2026-09-13）的四眼原则限制按业务决策取消；`tests/full-chain-drill.mjs` 原本即以同一 admin 账号连审两级，本次调整后与实现一致。
- **审批中心同人审批（APR-05）**：提交人可自行通过/驳回自己的审批单（Agent/应用/MCP/连接器/NAS 等全部 kind 通用）；高风险审批通过仍须显式二次确认（confirmed=true，服务端强制），审批权限点不变。原 QA 修复 A-05（2026-09-12）的职责分离限制按业务决策取消。
- **删除范围**：仅「已驳回」终态可删——Skill 驳回记录（含扫描阻断自动驳回）与审批中心驳回审批单。驳回单未执行任何动作，删除仅清理列表；审计日志（audit.logs）与业务资产本身不受影响、保留。
- **前端权限**：审批单删除按钮要求 `approval.decide`；Skill 删除按钮要求 `skill.publish`（与服务端权限点一致）。

## 二、验证

- `node --test packages/plugin-audit/src/approval.test.mjs`：9/9 通过（审批引擎既有口径无回归）。
- `npm run selftest`：全绿（结果见部署记录）。
- 全链路演练 `tests/full-chain-drill.mjs` 资产一 Skill 段：L1 领域审批与 L2 安全加签以同一 admin 连审，L2 不再 400。

## 三、回滚

- APR-01：恢复 `plugin-skillhub/src/index.ts` approve 中 REL-03 校验块即可（改动为删一段 if）。
- APR-05：恢复 `plugin-audit/src/index.ts` decideApproval 中 QA A-05 校验块即可（改动为删一段 if）。
- APR-02/03/04：均为追加式小改（路由白名单数组 +1 项、新增 deleteApproval 方法与 DELETE 路由、前端按钮条件 +1 状态），可按 hunk 独立回滚。
