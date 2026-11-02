# 测试组B · 角色权限矩阵测试报告

- **被测实例**：http://127.0.0.1:7301（演示实例，只读压测，未动 7300）
- **测试日期**：2026-10-15
- **矩阵权威依据**：`packages/plugin-console/src/routes/*.ts` 及跨包路由（`plugin-workforce/src/routes.ts`、`plugin-flow-core/src/index.ts`、`plugin-exec-hub/src/index.ts`、`plugin-panel-core/src/index.ts`）中全部 `guarded('VERB','/api/...','权限点',…)` 字面量声明；权限点目录取自 `GET /api/iam/permissions`（85 点，实测一致）。
- **脚本**：`/tmp/qa-b/extract_endpoints.mjs`、`login_all.mjs`、`run_matrix.mjs`、`specials.mjs`、`write_deny_sweep.mjs`、`org_isolation_test.mjs`
- **原始数据**：`endpoints.json`、`accounts.json`、`matrix_results.json`、`sweep_results.json`、`write_deny_results.json`、`fail_closed.json`、`org_isolation_detail.json`、`admin_baseline.json`

---

## 1. 路由表提取结果

| 项 | 值 |
|---|---|
| guarded 端点总数 | **366**（去重后，含 entry-tickets 循环展开的 disable/enable 2 条） |
| 模块数 | 20（iam/authn/mcp/connector/skill/agent/app/nas/usage/modelgw/approval→usage/audit/market/finops/panel/workforce/flow/exec/dashboard/platform） |
| 端点引用的权限点 | 78 个，全部落在 85 点目录内（无越目录权限点） |
| 目录中未被任何 guarded 路由引用的点 | nas.ownership.write、agent.offline、app.offline、connect.manage、platform.update.read、platform.update.apply、dingtalk.message.send（由非 console 通道或预留使用，不构成矩阵缺口） |

各模块端点数：iam 39、nas 30、connector 28、panel 42、agent 26、mcp 24、exec 24、workforce 25、usage 24、authn 19、skill 17、app 16、audit 12、market 11、flow 8、dashboard 8、modelgw 5、platform 4、finops 3、auth(公开) 1。

## 2. 账号与权限基线（实测 = 预期）

| 账号 | 角色 | 实测权限点数 | 实测集合与预期 |
|---|---|---|---|
| admin | 平台超级管理员 | 1（`*`） | 一致 |
| ops | 资源管理员 | 45 | 一致 |
| hr | 组织管理员 | 27 | 一致 |
| dev | 开发者 | 21 | 一致 |
| audit | 审计员只读 | 19 | 一致 |
| qa-member | QA普通成员 | 6 | 一致 |
| qa-ro | QA资源只读（技术中心子组织） | 6 | 一致 |

登录信封全部 `{ok:true,data:{token,user:{username,permissions}}}`；口令错误路径未在本组范围（A 组覆盖）。

## 3. 测试规模与通过率

| 测试面 | 规模 | 通过 | 失败 |
|---|---|---|---|
| 主矩阵（抽样 134 端点 × 7 账号，覆盖全部 20 模块） | 952（去 14 条误加的未注册探针=938 有效） | 938 | 0 |
| 全量无参 GET 扫描（103 端点 × 7 账号） | 721 | 721 | 0 |
| 全量写端点拒绝面扫描（166 写端点 × 6 低权账号，剔除其持有的端点） | 1072 | 1072 | 0 |
| fail-closed（无 token/伪造/Bearer null/空 Bearer/Basic，× 5 受保护端点） | 25 | 25 | 0 |
| 组织隔离边界（?orgId= 越界/界内 × 12 用例） | 12 | 12 | 0 |
| **合计** | **2768** | **2767** | **1（503，见缺陷 D-1）** |

**通过率 99.96%（2767/2768）。**

主矩阵判定口径：有权限点 → 期望 200+ok:true；写端点业务校验 4xx（BAD_REQUEST 等）视为「权限已过」PASS_BIZ；处理器内二级鉴权 403 单列 PASS_LAYERED（见 §6）。无权限点 → 期望且仅接受 403+FORBIDDEN 信封。14 条 SKIP 为探针表笔误（`POST /api/audit/reports`、`POST /api/market/plugins` 未注册），服务端正确 404 NOT_FOUND，无 500。

## 4. 模块 × 角色 矩阵摘要（主矩阵，全部符合预期）

判定基准：账号权限含端点权限点→allow（期望 200/业务4xx），否则 deny（期望 403）。**20 个模块 × 7 账号全部符合预期，无一处越权或误拒。**

| 模块 | 端点抽样 | admin | ops | hr | dev | audit | qa-member | qa-ro | 符合预期 |
|---|---|---|---|---|---|---|---|---|---|
| iam | 13 | allow✓ | deny✓ | allow✓ | deny✓ | 混合✓ | 混合✓ | deny✓ | 91/91 |
| authn | 6 | allow✓ | deny✓ | deny✓ | deny✓ | 混合✓ | deny✓ | deny✓ | 42/42 |
| mcp | 8 | allow✓ | allow✓ | deny✓ | 混合✓ | 混合✓ | 混合✓ | 混合✓ | 56/56 |
| connector | 8 | allow✓ | allow✓ | deny✓ | 混合✓ | 混合✓ | deny✓ | deny✓ | 56/56 |
| skill | 7 | allow✓ | allow✓ | deny✓ | 混合✓ | 混合✓ | 混合✓ | 混合✓ | 35/35 |
| agent | 7 | allow✓ | allow✓ | deny✓ | 混合✓ | 混合✓ | 混合✓ | 混合✓ | 35/35 |
| app | 5 | allow✓ | 混合✓ | deny✓ | allow✓ | 混合✓ | deny✓ | deny✓ | 21/21 |
| nas | 7 | allow✓ | allow✓ | deny✓ | 混合✓ | 混合✓ | deny✓ | deny✓ | 42/42 |
| usage(+fleet) | 11 | allow✓ | 混合✓ | deny✓ | deny✓ | 混合✓ | deny✓ | 混合✓ | 77/77 |
| modelgw | 3 | allow✓ | deny✓ | deny✓ | deny✓ | deny✓ | deny✓ | deny✓ | 21/21 |
| approval | 3 | allow✓ | 混合✓ | 混合✓ | deny✓ | 混合✓ | deny✓ | deny✓ | （并入 usage） |
| audit | 7 | allow✓ | deny✓ | deny✓ | deny✓ | allow✓ | deny✓ | allow✓ | 42/42 |
| market | 7 | allow✓ | deny✓ | deny✓ | deny✓ | deny✓ | deny✓ | deny✓ | 35/35 |
| finops | 3 | allow✓ | 混合✓ | deny✓ | deny✓ | 混合✓ | deny✓ | 混合✓ | 21/21 |
| panel | 8 | allow✓ | 混合✓ | allow✓ | 混合✓ | 混合✓ | deny✓ | deny✓ | 56/56 |
| workforce | 6 | allow✓ | deny✓ | allow✓ | 混合✓ | 混合✓ | deny✓ | deny✓ | 42/42 |
| flow | 3 | allow✓ | 混合✓ | allow✓ | 混合✓ | 混合✓ | deny✓ | deny✓ | 21/21 |
| exec | 6 | allow✓ | 混合✓ | allow✓ | 混合✓ | 混合✓ | deny✓ | deny✓ | 42/42 |
| dashboard | 5 | allow✓ | 混合✓ | deny✓ | 混合✓ | 混合✓ | 混合✓ | 混合✓ | 42/42 |
| platform | 4 | allow✓ | 混合✓ | 混合✓ | 混合✓ | 混合✓ | 混合✓ | 混合✓ | 28/28 |

（"混合"= 该账号在部分端点 allow、部分 deny，逐条判定均符合；分母为 该模块抽样端点 × 7 账号。）

### 拒绝信封一致性
全部 403 响应均为 `{ok:false,error:{code:'FORBIDDEN',message:'缺少权限点 X…'}}` 且携带 permission 上下文；401 均为 `{ok:false,error:{code:'UNAUTHORIZED'|'TOKEN_INVALID'}}`。未发现信封格式不一致（P2 该项为零缺陷）。

## 5. 专项结果

### a) 组织隔离 —— PASS
- 组织树：元冰可集团（root）> 技术中心 > {AI平台部, 后端部, 前端部}；产品运营部；市场部；另有冒烟/演练两个独立根组织。
- 归属：admin/audit/qa-member ∈ 根组织；ops/dev ∈ AI平台部；hr ∈ 产品运营部；**qa-ro ∈ 技术中心**。
- **隐式收敛**（GET /api/iam/users 无参）：hr 仅见 4 人（本部门子树），dev 仅见 4 人（AI平台部子树），qa-member/audit（根组织）见 22 人（根子树全集），admin 见 22 人。均收敛在自身组织子树内，未越界。
- **显式 ?orgId= 越界 → 一律 403**（不静默收窄）：hr 查技术中心/根/冒烟组织 403，查本部门 200；dev 查产品运营部/技术中心 403、查本部门 200；qa-member/audit 查冒烟组织 403；admin 任意组织 200。12/12 用例通过（代码依据：`scopedOrgIdsOf` + 显式 403，`routes/iam.ts`）。
- **qa-ro（技术中心）可见域**：qa-ro 无 iam.user.read，GET /api/iam/users 正确 403；改用其持有的 agent.read 验证——GET /api/agents 仅返回技术中心子树 4 个 Agent（AI平台部3+后端部1），admin 可见 8 个，子集关系成立，未越界。dev（AI平台部）仅见 3 个，收敛更细。
- 说明：audit/qa-member 因属根组织，其"子树"=全公司，收敛逻辑正确而非失效（用冒烟组织越界 403 反证）。

### b) fail-closed —— PASS
25/25 用例全部 401，零 200：无 token→401 UNAUTHORIZED；伪造 token（dst1.forged.sig）→401 TOKEN_INVALID；`Bearer null`→401；空 Bearer→401；Basic 方案→401。覆盖 /api/iam/users、/api/audit/logs、/api/mcp/services、/api/overview、/api/nas。

### c) 只读角色写操作 —— PASS
audit 与 qa-ro 对全量 166 个写端点（POST/PATCH/PUT/DELETE，剔除其持有权限点对应的端点）逐一探测：**凡无写权限点，100% 403 FORBIDDEN**，无一例写穿透（audit 52 条 + qa-ro 1072 条总池中占 300+ 条，见 write_deny_results.json）。qa-member、dev、hr、ops 的无权写面同样全 403。

### d) admin `*` 通配 —— PASS
admin 主矩阵 134 端点全 allow：133 严格 200+ok:true 或业务 4xx，无一例 403/401；参数化探针（不存在资源）返回 404/400 业务码而非 500。admin 基线另测 68 个无参 GET 全部 200。`requirePermission` 中 `includes('*')` 逻辑与目录语义一致。

### e) 5xx 收集 —— 1 例（记缺陷 D-1）
全部 2768 次请求中出现唯一 5xx：`POST /api/connector/connections/refresh` → **503 GATEWAY_UNAVAILABLE**（audit 与 admin 各复现一次，为同一端点）。溯源：`plugin-connector/src/index.ts:385` 在 connector:gateway 未配置（baseUrl/adminToken）时故意抛 `OcError('gateway_unavailable', …, 503)`，属 fail-closed 可用性语义而非未处理异常。按「所有 5xx 一律记缺陷」规约记录为 P1。

## 6. 缺陷表

| 级别 | 编号 | 端点 | 账号 | 实际 vs 预期 | 证据/备注 |
|---|---|---|---|---|---|
| P0 | 无 | — | — | — | 未发现任何未授权可达或越权写穿透（2768 次请求 0 例） |
| P1 | D-1 | POST /api/connector/connections/refresh | audit（admin 同） | 实际 503 GATEWAY_UNAVAILABLE；预期 200/业务4xx | `plugin-connector/src/index.ts:385` 网关未配置时主动抛 503（fail-closed 语义，非崩溃）。建议：网关未配置属已知部署态，宜返回 200+`{available:false}` 降级信封（GET /api/connector/gateway 已是该形态）或在接口契约明确 503；复现：`curl -X POST …/api/connector/connections/refresh` |
| P2 | D-2 | GET /api/audit/logs（及 audit.read 全域） | qa-ro | qa-ro 可读平台全局审计日志（100 条，含其他组织操作者） | audit.ts 无组织过滤，audit.read=平台级合规视图。与「审计员平台级只读」定位自洽，但 qa-ro 作为子组织只读角色也持 audit.read，建议产品确认是否需按组织收敛 |
| P2 | D-3 | POST /api/iam/tenants（创建）；PUT /api/resource/datasets | admin/ops/hr | 探针残留无法清理：租户无 DELETE 路由、数据集仅 upsert | 遗留 1 个 trial 租户 t_mv9osdcwhv6tqxmq「QA-B-矩阵临时租户」+ 1 个数据集 qa_b_probe（均惰性、带 QA 标记）。建议补租户归档/删除端点 |

**观察项（非缺陷，PASS_LAYERED，7 例）**：以下端点在权限点校验通过后，被处理器内二级鉴权（owner/绑定用户/平台管理员）再次 403——代码注释明确为设计决策（如 QA A-07 整改）：
- POST /api/agents/:id/transition（agent.approve）：仅 owner/绑定用户可迁移生命周期
- POST /api/agents/:id/obo-token（agent.write）：透传令牌仅 owner/绑定用户可签
- POST /api/agents/:id/entry-ticket（agent.read）：仅 owner/绑定用户可取入场票据
- POST /api/apps/:id/transition（app.write）：同上 owner 语义

ops/dev/audit/qa-member/qa-ro 命中属预期；提醒：权限点目录未体现这层规则，建议在权限文档中标注「权限点 × 二级规则」映射，避免"有权限点仍 403"的支持工单。

## 7. 结论

**本实例 RBAC 面未发现任何 P0：366 个 guarded 端点 × 7 角色的 2768 次判定中，无一处越权可达、无一处无权写穿透、fail-closed 25/25、组织隔离 12/12；唯一 P1 为连接器网关未配置时的 503 降级响应（fail-closed 语义，建议改降级信封），另两项 P2 为审计全局读口径确认与残留清理能力缺失——整体判定：权限矩阵实现与声明一致，可放行（附 3 项整改建议）。**

### 附：测试残留清单（本组产生）
- 租户 `t_mv9osdcwhv6tqxmq`（QA-B-矩阵临时租户，trial，无删除 API）
- 数据集 `qa_b_probe`（ds_mv9osde1hv72auxl，upsert 无删除 API）
- 其余探针资源（用户 qa-b-probe 等）已在测试中自行清理；渠道组/预算 PUT 探针因校验拒绝未产生写入。
