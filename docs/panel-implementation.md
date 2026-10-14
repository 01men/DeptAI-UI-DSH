# DSH 部门 Agent 工作台面板——实施记录（review-dsh-agent-panel-v2 落地）

> 依据：`docs/review-dsh-agent-panel-v2.md`（六大领域差距分析 + 四阶段计划）
> 物料：`dsh-agent-panel-design/`（DESIGN.md + index.html 878 行可交互原型）
> 分支：`custom/dsh-rq`；门禁：`npm run selftest`（871/871）+ `npm run lint:manifests`（85 清单 + 5 卡片包 + 2 图谱包）全绿。

---

## 一、Phase 0 裁决定稿（评审七项冲突的最终口径）

| # | 评审裁决建议 | 实施定稿 |
|---|------------|---------|
| D1 | 计量键改 `panel:<dept>.<code>` | ✅ `panel:mfg.qb01`（无激活行业回落 `.core`）；价格簿播种 `panel:*` 零费率（usage `ensureDefaultPriceBook`） |
| D2 | iam 扫码绑定为事实源，砍掉绑定码第 3 步 | ✅ 绑定向导第 2 步直接跳 `POST /api/auth/sso/bind/authorize`（iam identityLinks）；桥接 status 如实声明 bindPath |
| D3 | 权限点/事件名对齐仓库 | ✅ `PermissionCatalog` 新增 `panel.read/panel.write/panel.task.write/panel.config.write/scenegraph.read/scenegraph.activate/dingtalk.message.send`；事件沿用 `approval.created`；总线订阅不需权限点 |
| D4 | 1 个 plugin-panel-core + 5 部门数据包 | ✅ `plugin-panel-core`（骨架+数据面+运行时）；五部门=种子数据（`DEPT_META` 一比一剥离），差异全在 `panel:deptConfigs`（纯配置，皮肤由 `data-dept` CSS 变量驱动） |
| D5 | 图谱走内置资产通道 | ✅ `platform-core/src/scenegraph.ts`（validateScenegraph + ScenegraphService，克隆 cardpacks 模式）+ `packages/platform-core/scenegraphs/{qb01,gcjx}.json`；lint:manifests 联动校验；市场上架（content.scenegraph）留 Phase 4 |
| D6 | 复用审批链 + grantCapabilities | ✅ `industry.activation` 审批单（riskLevel=high，二次确认服务端强制）→ executor 置 active + `usage.grantCapabilities` + `panel.industry.activated` 事件；Ed25519 license 签发链路未建（如实留待） |
| D7 | 面板前缀 `panel.<dept>.*`，主题自管 | ✅ PlatformEvents 新增 `panel.*`（message.created/card.action/task.updated/industry.activated）、`scenegraph.updated`、`dingtalk-bridge.delivered`，全部入 `PLATFORM_RESERVED_PREFIXES`；前端主题 `data-dept` 与 console `data-platform` 完全隔离 |

**数据实况修正**：评审文档引用设计稿「QB01 27 场景 / GCJX 18 场景」；原型内实际建模为 **QB01 24 场景 / GCJX 14 场景**（`scripts/extract-panel-seed.mjs` 确定性剥离，锁定行业 JQR/NEV/PCB 仅登记未建模）。以原型数据为准。

## 二、交付清单

### 新增插件

**`packages/plugin-panel-core`**（骨架 + 数据面 + 运行时）
- 集合：`panel:deptConfigs / channels / messages / tasks / artifacts / readCursors / activations`（messages 带 `uniqueOn` 桥接去重键）
- REST（32 条，全部 guarded + 权限点，自注册路由推入 `httpServer.routeMatrix` 共享矩阵）：depts / overview / board / widgets·kpis·agents（配置抽屉）/ channels / messages / card-action / tasks·transition / artifacts / scenes diagnose·sync-dingtalk / industries 三态 + activate-requests / scenegraph + reload / poll
- SSE：`GET /api/panel/stream?dept=&token=`（console PUBLIC_PATHS 白名单 + 内部 `authn.verify` 自校验 fail-closed；事件名进 data 帧以便 EventSource.onmessage）+ 降级轮询 `GET …/poll`（30s，钉钉 webview 铁律）
- **panelAgentRuntime**（MVP 单轮）：@Agent（名册全名匹配，支持带空格名）→ Agent 资产（agentRef）→ modelgw.invoke → 回包落库 + `panel.message.created`；未绑定资产/模型不可用 → **诚实降级**回包 + 转人工待办，不造假 completion；成功路径计量 `panel:<dept>.<code>`
- **widget 求值** `resolveWidgetSource`：manual/mock 直出 + 来源徽标；connector/mcp 源显式降级（业务连接器生态缺位，绝不冒充真实业务面）
- 工具 6 个：`panel_agents_list / panel_msg_send / panel_task_create / panel_task_transition / panel_scene_diag / panel_widget_data`
- 行业激活执行器（audit approvals executor）+ DingtalkDelivered 回执联动（ddSync 状态回写）
- 前端（零构建 vanilla ESM，`/panel` 静态挂载，对外 `/rq/panel/`）：顶栏（行业三态选择器/⌘K 动态源/钉钉状态胶囊/LIVE 徽标）+ 部门 rail + 三栏（名册频道 / 协作会话·任务看板·部门知识·场景图谱四 Tab / widget 看板）；`data-dept` 五主题；消息白名单渲染（esc 后仅放行 `<b>` 与 mention span）；票据免登（?entry_ticket=）+ 控制台同源会话复用；复用 console `ui.js`/`realtime.js`（同源动态 import，零代码复制）
- **响应式布局**（实测修复）：`#app` 接管 100vh 高度链（此前工作区坍缩成内容自然高度——消息少时页面下方大片留白、内部滚动失效）；`#tabBody` 续接 flex 链（composer 贴底）；消息气泡限宽 780px（超宽屏阅读线）；三档断点——≤1360px 两翼收窄、≤1180px 右看板转抽屉（部门头 📊 开关）、≤980px 左名册转抽屉（👥 开关 + 选频道自动收起）+ 精简 KPI/隐藏全局搜索、≥1800px 两翼加宽；抽屉关闭钮仅在抽屉打开时出现。几何验证：2000/1720/1120 宽三档 .body/.composer 均贴满视口

**`packages/plugin-dingtalk-bridge`**（出向优先，R-SPIKE 未决不入向）
- 集合：`dingtalk:bridgeChannels`（purpose=channel/alerts）+ `dingtalk:bridgeMessages`（dedupKey 去重回执）
- REST：status（连接器形态/个人绑定/入向停用声明）/ bridges / channels/:id/bridge 建解绑 / approvals/:id/push / bridge/callback（staffId↔identityLinks 反查 + approval.decide 权限复核 + high 风险必须 confirmed，四重 fail-closed）
- 事件联动：`panel.message.created`（ddSync=pending）→ 出向投递（凭证单一来源=iam 连接器，零凭证存储）→ 回执 emit；`panel.card.action`（dd.push）→ 卡片/场景卡推群；`audit.alert.fired` → purpose=alerts 群桥投递（**坐实告警 channels:['dingtalk'] 仓库欠账**）
- 入向 Stream 刻意停用（status 如实声明），官方连接器暴露面核对（R-SPIKE）后才可启用

### 平台改动（additive）

- `platform-core`：`HttpServerService.routeMatrix` 共享登记处（评审指出的「自注册路由逃出 RBAC 断言网」欠账补齐）；scenegraph 模块；PlatformEvents 扩展
- `plugin-iam`：权限点目录 + BuiltinRoles（member 直用面板）+ `BUILTIN_ROLE_MIGRATION`（存量库幂等补点）
- `plugin-usage`：`panel:*` 零费率播种
- `plugin-console`：guarded 双写共享矩阵 + route-matrix 端点合并插件条目；`/api/platform/info` 插件清单；PUBLIC_PATHS 加 `/api/panel/stream`（白名单冻结清单走查覆盖）；NAV「部门面板」外链入口；审批中心 kind 映射（行业激活/面板卡片动作）
- 装配三处同步：`boot-all.ts` / `cordis.yml` / selftest mountCtx（panel-core → dingtalk-bridge → dsh-bridge 序）
- `gen-manifests.mjs` 两个新插件条目（声明已生成）；`lint-manifests.mjs` 场景图谱校验联动

### 数据与脚本

- `packages/platform-core/scenegraphs/{qb01,gcjx}.json`——从原型剥离的行业图谱（24+14 场景，四清单全字段）
- `packages/plugin-panel-core/src/seed/{demo-content.json, seed.ts}`——五部门演示内容（KPI/widget 均带来源徽标）+ 基线骨架种子 + 内置行业激活（QB01/GCJX 默认授权根组织）
- `scripts/extract-panel-seed.mjs`——原型数据确定性剥离脚本（原型变更可重跑）

## 三、selftest 新增断言（+49 项）

- **部门面板**（24 项）：五部门骨架 / 总览（行业+阵容+KPI+widget 徽标）/ 401 / 消息闭环 / 卡片动作纯平台链（task.create + 幂等）/ 任务状态机（迁移+非法泳道）/ 部门知识 / QB01 图谱全字段下发 + 未装载 honest 400 / 行业三态 + 激活审批链（申请→high 二次确认强制→执行器生效→重复申请拒绝）/ @Agent 诚实降级 + 转人工 / stub 模型真实单轮调用回包 / **计量落账 panel:mfg.qb01（D1 键格式 E2E）** / widget 配置写入 + connector 源显式降级 / SSE 建立推流 + 无 token fail-closed / 降级轮询 / 成员读写权限行为抽检
- **钉钉桥接**（13 项）：状态胶囊（real + R-SPIKE 声明 + bindPath）/ 频道群桥 + 告警群桥绑定 / 列表 / 出向投递 ddSync pending→sent 回执回写 / 场景卡 dd.push 推群 / **告警经 alerts 群桥投递（usage reconcile 触发 AlertFired）** / 审批单推送 / 回决 fail-closed 三连（未绑定 staffId 拒、高风险缺 confirmed 拒、合规回决执行）/ 解绑 / 连接器恢复 mock
- mountCtx：`/rq/panel/` 挂载形态 SPA 可达（宿主 web diff=0）

## 四、实测验证（独立形态 + 浏览器端到端）

- 冒烟实例（DEMO_SEED=1）+ 浏览器实测：登录引导页（过期 token 401 路径）→ 会话注入 → 面板完整渲染（截图核对：顶栏行业选择器/五部门 rail/主题切换/KPI/名册/频道未读/四类消息气泡/操作卡片/dd 徽标/widget 来源徽标+LIVE）→ 任务看板泳道推进 → 场景图谱（活动分组/评级统计/四清单 chips）→ 派 Agent 诊断联动（会话+任务+toast）→ @Agent 降级回包经 **SSE 实时上屏** → 绑定资产后走模型网关（模型缺失诚实报错转人工）
- 独立发现的缺陷已在实现内修复：SSE 处理器缺 `authn` inject、@提及全名匹配、启动路径白屏（先渲染骨架+401 显式引导）、origin 徽标重复、行业按钮数据后刷新

## 五、宿主侧深度打通（第二轮：登录 / 账号组织 / 权限控制）

1. **登录打通——宿主会话直通**：dsh-bridge 新增 `POST /dsh-bridge/session`（同源收紧沿用 fence 语义）：
   `rq_sid` Cookie 绑定身份 → `ensureHumanPrincipal + issueSessionPair` → 平台会话对（含 permissions），
   与票据免登同安全语义（账号状态实时校验、审计留痕 `dsh_bridge.cookie.session`）。面板 boot 会话链升级为
   **已有令牌 → ?entry_ticket= → 宿主 Cookie 直通** 三级：dsh 宿主内点入 `/rq/panel/` 零二次登录；
   独立形态 `/dsh-bridge/*` 不存在时静默跳过。fail-closed：未绑定 401 NOT_BOUND / 账号停用 401。
2. **账号组织打通——部门↔组织绑定**：`deptConfig.orgId`（基线种子按组织名与部门名同名自动绑定；
   管理员经 `PUT /api/panel/:dept/config` 手工绑定/解绑，配置抽屉下发组织树选择器）。
   总览随下发绑定组织名 + **部门名册**（组织子树 active 成员，最小 PII：姓名/职务/组织名），
   输入区 @同事 chips 与 ⌘K 同事源即真实名册。
3. **权限控制——部门范围权限（组织治理双通道）**：部门绑定组织后，除 `panel.read` 权限点外追加
   组织子树归属校验（`'*'` 管理员、机器凭证、org_admin 角色豁免），未授权者 403 `部门范围受限`；
   部门清单带 `allowed` 徽标，rail 对越界部门显式锁定。
4. **Agent 阵容 × 资产底座联动**：名册卡实时解析 agentRef 指向的 Agent 资产（状态/模型），
   在线状态点显色；运行时、面板、资源底座三方同一事实源。

**selftest 新增 10 项**：宿主会话直通（兑换/直通面板 RBAC 面/无 Cookie 拒）+ 部门绑定组织、
组织子树成员放行、组织外成员 403、allowed 徽标、'*' 豁免、解绑恢复、资产状态联动。合计 881/881。

## 六、已上线宿主（192.168.0.7:7300）真实性测试现状

实测（本会话，无凭据可达面）：
- `GET /api/health` ✔；`GET /api/auth/providers` ✔ ——**两个真实钉钉企业连接器在案**：
  杭州元冰可（`ding8e17…`）、金华聚杰电器（`ding9f3d…`）
- 公开门户契约 ✔：真实资产盘点 = 2 个已上线 AI 应用（能耗与碳排管理系统、企业AI门户）、
  8 名数字员工、3 个上架 Skill、1 个在线 MCP 服务
- 演示账号口令已按部署清单全部轮换（`Ybk@2026` 全部失效——符合 `docs/deploy-enterprise.md` 凭证纪律），
  仓内零真实口令/密钥（红线一 T-24 同款约束）

**凭证面测试交接运维一步执行**（凭证不出运维环境）：
```bash
DSHCTL_URL=http://192.168.0.7:7300 DSHCTL_USER=admin DSHCTL_PASS='***' \
  node scripts/verify-live-host.mjs
```
脚本依次验证：真钉钉 OpenAPI 健康检查（宿主内存凭证拉真实 accessToken+部门树）→ 真实资产/名册盘点 →
面板侧就绪（/panel/ + 五部门 + 行业三态；宿主未部署本分支时如实报缺）。钉钉桥接出向真实发消息需在
宿主部署本分支后，绑定真实群 openConversationId + robotCode 再验（脚本与面板 UI 均已就绪）。

## 七、明确不做 / 后续项（对齐评审 C 节与 Phase 4）

1. **入向钉钉 Stream**：R-SPIKE 未决（官方连接器暴露面 + 同 clientId 单连接约束），出向已可用，入向在 status 端点如实声明停用
2. **Ed25519 license 签发链路**：激活走审批+能力授权，市场 license 资产化（content.scenegraph 契约扩展）留 Phase 4
3. **业务连接器生态**：演示期数据全部 manual/mock + 来源徽标，connector/mcp 源显式降级；接入为显性运营工作项
4. **DWS 数字员工增强**：status 如实声明未启用
5. 其余 13 行业图谱数据建模：市场契约扩展后复制
