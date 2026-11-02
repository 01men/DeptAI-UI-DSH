---
name: dsh-ops-iam
description: 管理组织、账号、角色、用户组及身份同步。
---

# Skill: dsh-ops-iam

## 何时使用
组织架构调整、账号生命周期（创建/冻结/注销）、角色与用户组维护、三方通讯录同步与冲突处理。


## 调用方式（工具优先）
平台已把运维能力注册为 dsh 工具，**回答现状问题（查询/盘点/排障）必须直接调用工具获取真实数据，禁止凭记忆回答**：
- iam_org_tree / iam_org_create / iam_org_update / iam_user_list / iam_user_create / iam_user_reset_password / iam_user_freeze / iam_role_list / iam_sync_run / iam_conflict_list
（工具参数见各工具 schema；下文手册中的 `dshctl ...` 为「平台独立部署 + HTTP API 运维」场景的 CLI 备选，需 DSHCTL_TOKEN/DSHCTL_USER，在 dsh 会话内一般用不到。）

## 前置条件
需要 iam.* 权限组令牌。

## 操作手册

### 场景 1：员工离职联动
1. `dshctl user list --q=<姓名>` → 定位账号
2. `dshctl user freeze <userId> --reason="离职：<日期>" --yes`
   （联动：名下全部令牌立即吊销；若由三方同步触发则为自动流程）
3. `dshctl token list --principalId=<principalId>` 验证令牌已吊销
4. `dshctl audit logs --resourceId=<userId>` 留痕验证

### 场景 2：三方通讯录同步冲突处理
1. `dshctl sync run --provider=dingtalk` → 触发全量同步
2. `dshctl conflict list` → 查看待处理冲突
3. 逐条决策：`dshctl conflict resolve <id> --keep=third_party`（或 platform）
4. 复查：`dshctl user list --org=<orgId>`

### 场景 3：新部门组建
`dshctl org create --name=<部门名> --parent=<父orgId>`
随后批量导账号：`dshctl user create --username= --displayName= --orgId= <userId>`

### 场景 3b：组织改名 / 调整层级
1. `iam_org_tree` 定位目标组织 ID
2. `iam_org_update`：传 `name` 重命名（同级重名会被拒绝）；传 `parentId` 调整上级（空字符串=提升为顶级，服务端带组织环检测）
   （控制台亦可：组织树节点右键 → 重命名 / 调整上级组织；HTTP 对应 `PATCH /api/iam/orgs/:id`）

### 场景 4：权限调整
`dshctl role list` 查看现有角色；通过控制台「角色权限」页勾选权限点（CLI 修改角色走 PATCH /api/iam/roles/:id）。
权限变更实时生效（权限缓存随 iam.permission.changed 事件失效）。

## 护栏
- freeze/deactivate 必须给 `--reason`（审计要求）
- 一人一号：同一三方身份只能绑定一个平台账号
- 删除组织前必须先清空账号与子组织
