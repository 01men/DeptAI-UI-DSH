# 控制台前端完整性测试报告（测试组C · 前端完整性组）

- 被测实例：http://127.0.0.1:7301（DEMO_SEED=1 演示数据）
- 代码基线：仓库 /Users/ybkk/Documents/元冰可可产品/ybkkasi（只读，未修改任何源码）
- 测试日期：2026-10-15 · 测试人：测试组C
- 方法：仓库自带 jsdom 冒烟（page-smoke / dom-smoke）+ 自研深化逐页断言脚本 /tmp/qa-c/deep-pages.mjs（admin / audit / qa-member / 匿名四种身份，共 153 页面实例），逐页捕获全部 /api/ 请求、DOM 内容证据（表格行/数字指标卡/实质卡片/正文文本）、JS 错误与 console.error。

## 一、结论速览

| 维度 | 结果 |
| --- | --- |
| page-smoke（渲染冒烟） | **31/31 通过** |
| dom-smoke（DOM 交互冒烟） | **14/15 通过（1 条件跳过 T6a：当前 Skill 无安装按钮）** |
| admin 深化测试（49 页面实例） | **49/49 全绿**（含 2 页「空态合理」：服务端即空） |
| audit 弱权限（49 实例） | 30/49 全绿，19 页无权限降级（无一例白屏/JS错误/403刷屏） |
| qa-member 弱权限（49 实例） | 20/49 全绿，29 页无权限降级（同上） |
| 匿名页（home/login/oauth×4） | 5/6 直接通过；oauth/authorize?req=无效票 按设计返回友好协议错误页（预期行为） |
| 缺陷计数 | **P0=0，P1=0，P2=6，备注(P3)=6** |

## 二、admin 全量逐页明细（49 实例）

图例：构建OK=builder 渲染未抛错；请求=该页发出的 /api/ 请求全部 ok；内容=DOM 出现非「加载中/暂无/空态」的实际内容（表格行/指标卡/实质卡片/正文）；JS错误=jsdomError 与 console.error 合计。

| 页面 | 构建OK | 请求全部ok | 内容非空 | JS错误 | 判定 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| dashboard | 是 | 是（6条） | 是 | 无 | ✅ |  |
| dashboard?tab=goals | 是 | 是（3条） | 是 | 无 | ✅ |  |
| dashboard?tab=actions | 是 | 是（4条） | 是 | 无 | ✅ |  |
| dashboard?tab=collab | 是 | 是（4条） | 是 | 无 | ✅ |  |
| dashboard?tab=ops | 是 | 是（5条） | 是 | 无 | ✅ |  |
| register（资产登记） | 是 | 是（0条） | 是 | 无 | ✅ |  |
| iam?tab=members | 是 | 是（6条） | 是 | 无 | ✅ |  |
| iam?tab=roles | 是 | 是（1条） | 是 | 无 | ✅ |  |
| iam?tab=groups | 是 | 是（2条） | 是 | 无 | ✅ |  |
| iam?tab=connectors | 是 | 是（2条） | 是 | 无 | ✅ |  |
| iam?tab=conflicts | 是 | 是（2条） | 空态 | 无 | ✅ | 空态合理（服务端即空） |
| authn（认证与令牌） | 是 | 是（3条） | 是 | 无 | ✅ |  |
| mcp | 是 | 是（1条） | 是 | 无 | ✅ |  |
| nas | 是 | 是（1条） | 是 | 无 | ✅ |  |
| nas-authz（数据权限） | 是 | 是（7条） | 是 | 无 | ✅ |  |
| connectors?tab=catalog | 是 | 是（2条） | 是 | 无 | ✅ |  |
| connectors?tab=connections | 是 | 是（2条） | 是 | 无 | ✅ |  |
| connectors?tab=perm-groups | 是 | 是（2条） | 是 | 无 | ✅ |  |
| connectors?tab=runs | 是 | 是（2条） | 空态 | 无 | ✅ | 空态合理（服务端即空） |
| skills（AI 市场） | 是 | 是（4条） | 是 | 无 | ✅ |  |
| agents | 是 | 是（1条） | 是 | 无 | ✅ |  |
| apps | 是 | 是（1条） | 是 | 无 | ✅ |  |
| assets（台账·全部） | 是 | 是（1条） | 是 | 无 | ✅ |  |
| assets?type=mcp | 是 | 是（1条） | 是 | 无 | ✅ |  |
| assets?type=agent | 是 | 是（1条） | 是 | 无 | ✅ |  |
| assets?type=app | 是 | 是（1条） | 是 | 无 | ✅ |  |
| assets?type=skill | 是 | 是（1条） | 是 | 无 | ✅ |  |
| assets?type=model | 是 | 是（1条） | 是 | 无 | ✅ |  |
| assets?type=nas | 是 | 是（1条） | 是 | 无 | ✅ |  |
| assets?tab=report（报表） | 是 | 是（4条） | 是 | 无 | ✅ |  |
| finops（财务视图） | 是 | 是（4条） | 是 | 无 | ✅ |  |
| exec?tab=overview | 是 | 是（1条） | 是 | 无 | ✅ |  |
| exec?tab=goals | 是 | 是（2条） | 是 | 无 | ✅ |  |
| exec?tab=issues | 是 | 是（2条） | 是 | 无 | ✅ |  |
| exec?tab=routine | 是 | 是（2条） | 是 | 无 | ✅ |  |
| audit?tab=logs | 是 | 是（1条） | 是 | 无 | ✅ |  |
| audit?tab=alerts | 是 | 是（1条） | 是 | 无 | ✅ |  |
| audit?tab=rules | 是 | 是（1条） | 是 | 无 | ✅ |  |
| audit?tab=cost | 是 | 是（1条） | 是 | 无 | ✅ |  |
| approvals（审批中心） | 是 | 是（3条） | 是 | 无 | ✅ |  |
| platform（插件与工具） | 是 | 是（1条） | 是 | 无 | ✅ |  |
| connections（宿主服务连接） | 是 | 是（0条） | 是 | 无 | ✅ |  |
| gateway（模型网关） | 是 | 是（11条） | 是 | 无 | ✅ |  |
| usage?dim=tokens | 是 | 是（1条） | 是 | 无 | ✅ |  |
| usage?dim=cost | 是 | 是（1条） | 是 | 无 | ✅ |  |
| access?tab=enroll | 是 | 是（4条） | 是 | 无 | ✅ |  |
| access?tab=hosts | 是 | 是（0条） | 是 | 无 | ✅ |  |
| access?tab=catalog | 是 | 是（4条） | 是 | 无 | ✅ |  |
| connect（薄壳→#/access） | 是 | 是（0条） | — | 无 | ✅ | 薄壳重定向 #/access?tab=enroll |

> 亮点数据：dashboard 总览 12 指标卡+7 SVG 图表；iam 成员表 30 行；审计日志表 100 行；资产台账 31 行；平台插件页 90 卡片；所有页面 API 响应均 ok:true，0 JS 错误，0 console.error。
> 两个「空态合理」页：iam?tab=conflicts（服务端 conflicts=[]，展示「没有待处理的同步冲突」+批量处理按钮）；connectors?tab=runs（演示实例 connector gateway 未配置 status=unconfigured，runs=[]，页面如实展示「网关不可用/接入指引/暂无数据」）。

## 三、弱权限视角抽查

### audit（口令 Ybk@2026，19 个只读权限点，缺 usage.read / connect.manage / connector.gateway 等）
- 30/49 页全绿。19 个无权限页面**无一例白屏、无 JS 错误、无 403 刷屏（单页最多 4 个 403）**。
- 降级形态分三类：① 页内内联权限提示（usage「无用量报表读取权限…需要 usage.read」、gateway「无模型网关读取权限…需要 modelgw.read」）——体验良好；② 内联错误文案（assets 台账「台账数据加载失败（缺少权限点 usage.read）」、finops「报表加载失败：缺少权限点 usage.read」）——信息完整但措辞像故障；③ 走通用「页面加载失败 🚫 + 权限点说明 + 重试」壳错误卡（assets?tab=report、access?tab=enroll）。
- connectors 四个 tab：gateway 状态接口 403 → 显示「网关状态未知（无 connector.gateway.write 权限点？）」，列表区空白，缺少明确的无权限/申请入口指引。

### qa-member（口令 Qa@Member2026，最小权限 6 个只读点）
- 20/49 页全绿。29 个无权限页面同样**0 白屏、0 JS 错误、0 403 刷屏**。
- 13 页走通用壳错误卡（authn/nas/nas-authz/apps/audit 四 tab/approvals/access?tab=enroll/connectors 连接与权限组/assets 报表），卡片文案均带「缺少权限点 X，请联系管理员调整角色」，可理解但呈现为「页面加载失败」。
- exec 执行中枢有专门的 🔒「无访问权限（需要 exec.read）」卡片——这是最佳实践，建议推广到全部页面。
- dashboard 五 tab 对 qa 全部渲染成功且带权限提示；collab/ops 两个 tab 各发出 1 个注定 403 的面板请求（/api/panel/depts、/api/fleet/ledger），未刷屏但可由 session.can 前端短路。

## 四、登录前页面

| 页面 | 匿名可访问 | 内容 | JS错误 | 结论 |
| --- | --- | --- | --- | --- |
| home 营销落地页（#/home，含 canvas 动画/懒加载） | 是 | 18.6KB DOM、9 数字位、19 SVG | 无 | ✅ |
| login 登录页 | 是 | 表单+登录方式（/api/platform/bootstrap、/api/auth/providers 均 200） | 无 | ✅ |
| oauth/authorize（缺 req） | 是 | 友好协议错误页 | 无 | ✅ 按设计 |
| oauth/authorize?req=无效票 | 是 | 「授权无法完成 invalid_request 授权请求无效、已使用或已过期」 | 无 | ✅ 服务端 404 被正确接住 |
| oauth/error | 是 | 协议错误页 | 无 | ✅ |
| oauth/logout | 是 | 登出确认页 | 无 | ✅ |
- 说明：路由表中的 pages/register.js 是「资产登记」页（需登录态，匿名访问会被 app.js 路由导去登录页）；用户注册入口内嵌于登录页的钉钉 SSO 绑定/注册分支（需 pendingTicket），无独立匿名注册页——与代码注释一致，非缺陷。

## 五、缺陷表

| 级别 | 编号 | 页面/范围 | 描述 | 建议 |
| --- | --- | --- | --- | --- |
| P0 白屏/渲染抛错 | — | — | **无**（153 个页面实例 0 白屏、0 未接住的渲染异常） | — |
| P1 数据未显示/请求失败 | — | — | **无**（admin 49 页 API 全部 ok:true 且内容非空；弱权限页的 403 均为越权访问被正确拒绝并提示） | — |
| P2 体验 | P2-1 | 约 15 页（弱权限） | 无权限降级呈现不统一：exec 有专门 🔒 权限卡，usage/gateway 有内联提示，assets/finops 用「加载失败」措辞，其余 13 页（qa）走通用「页面加载失败 🚫」错误卡 | 统一为专门「无权限」态组件（对齐 exec.js 样式） |
| P2 体验 | P2-2 | connectors 四 tab（audit/qa） | 缺 connector.gateway 权限时仅显示「网关状态未知」chip，列表区空白，无明确无权限说明/申请入口 | 列表区补权限提示与申请指引 |
| P2 体验 | P2-3 | connectors（admin 视角） | 演示实例 connector gateway 未配置（status=unconfigured），目录/连接/运行日志均为空态，AI 市场区之外的「数据面纳管」故事在演示数据下不可见 | DEMO_SEED 补 connector gateway 假数据或页内引导配置 |
| P2 体验 | P2-4 | 全局路由 | 未知 hash（如 #/workforce，该路由不存在）静默回落 dashboard（app.js builders[page] ?? renderDashboard），无 404 提示 | 增加 404/未找到页面提示 |
| P2 体验 | P2-5 | dashboard collab/ops（弱权限） | 每页发出 1 个注定 403 的面板请求（/api/panel/depts、/api/fleet/ledger），可由 session.can 前端短路；面板本身有权限提示未刷屏 | 面板渲染前按权限点短路 |
| P2 体验 | P2-6 | assets 台账（弱权限） | 无权限时以「台账数据加载失败（缺少权限点…）+重试」呈现，形似故障；表头/导出按钮仍展示 | 改为权限空态，隐藏无意义操作钮 |
| 备注 | P3-1 | home.js | canvas 动画依赖浏览器全局（getComputedStyle 等），jsdom 需全量打桩才能跑；真实浏览器无碍（自动化环境适配项） | 可忽略 |
| 备注 | P3-2 | scripts/page-smoke.mjs | P07 '' tab 标注「总览」但 dashboard 默认渲染 cockpit（测试文案偏差，非产品缺陷） | 修文案 |
| 备注 | P3-3 | 路由表 | 任务背景提到的「workforce」路由不存在于 app.js（无此页面） | 确认需求来源 |
| 备注 | P3-4 | oauth | oauth/authorize 无效 req 返回 404 + 友好错误页，属预期协议行为（本次记为通过） | — |
| 备注 | P3-5 | dom-smoke | T6a 为条件跳过（当前 Skill 状态无安装按钮），非失败 | — |
| 备注 | P3-6 | iam?tab=groups | 用户组数据以自定义结构渲染（非 table/card），自动化内容探针需正文文本兜底才能识别；数据实际正常显示 | 可忽略（本报告已按正文体量判定） |

## 六、测试产物

- /tmp/qa-c/deep-pages.mjs（深化脚本，支持 admin/audit/qa/anon 四身份）
- /tmp/qa-c/deep-{admin,audit,qa,anon}.json（逐页明细：API 清单/响应/内容证据/JS错误）
- /tmp/qa-c/page-smoke.out、dom-smoke.out、deep-*.out（原始输出）
- /tmp/qa-c/inspect-text.mjs、weak-text.mjs、anon-text.mjs（人工核对用文本抓取脚本）
- 未修改仓库任何源码；未触碰 7300 实例与 7301 进程。

## 七、结论

控制台前端「每页能渲染、数据取得到、无 JS 错误」的完整性目标达成：admin 视角 49/49 页面实例全绿（0 白屏、0 请求失败、0 JS 错误、0 内容缺失），双冒烟全过；弱权限视角 0 白屏/0 崩溃/0 403 刷屏、降级信息可理解，遗留 6 项 P2 均为降级呈现一致性与演示数据配置类体验问题，不阻塞发布。
