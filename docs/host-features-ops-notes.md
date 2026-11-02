# 宿主平台功能 · 升级与运维须知（对应 handoff 移植 4d882f1 + RQ 澄清 2026-09-08）

> 本文承接 `handoff-host-features-to-main.md`（移植差异清单）与 `handoff-host-features-clarification.md`
> （RQ 团队对 8 项风险/疑点的澄清），落地其中的文档层动作：升级指引、CORS 行为说明、
> SSE 日志脱敏、多用户归因声明，以及留档待议项（澄清第 3/5/7 条）。

## 1. 升级指引：AGENT_SSO_ENFORCE 默认 '1'（Agent 上线身份纳管门禁）

升级后，Agent 申请上线（挂单与审批执行**双点**校验）前必须完成「身份纳管」，三选一
（2026-10-31 起新增第 3 条 headless 通道）：

- **签发 OIDC 客户端**：控制台「Agent 本体 → 详情 → SSO 配置」自助签发（owner 或持 `authn.oidc.write`）；
- **登记 entryUrl**（零成本逃生门）：任何有交互界面的存量 Agent，在属性中登记
  `entryUrl`（如 `PATCH /api/agents/:id {"attrs":{"entryUrl":"https://…"}}`）即满足门禁；
  控制台 SSO 配置页现支持负责人直接登记（此前仅 Agent 侧自助提报）；
- **声明 headless**（无交互界面）：Work Body 等纯后台执行体没有任何界面与回调，由负责人声明
  `PATCH /api/agents/:id {"attrs":{"headless":true}}` 后凭已颁发的机器凭证放行；
  未颁发凭证不放行，`oidc` 严格模式下不适用。

存量影响面：门禁只拦「新增上线申请」，**已在线 Agent 不会被强制下线**；被拒文案自带三条指路。
开发环境确需跳过时显式设 `AGENT_SSO_ENFORCE=0`（仅建议开发环境）。最严档位 `oidc`：必须签发
OIDC 客户端，entryUrl / headless 均不再放行。

## 2. CORS 行为说明（数据面跨域放行）

默认 `corsAllowOrigins=['*']`，仅作用于 `/api/*`，且以下子面**豁免 blanket `*`**：

- `/api/portal/*`、`/api/authn/oidc/*`：自管 CORS（按登记来源精确放行）；
- `/api/auth/*`（login/refresh/票据兑换等令牌铸造与交换面）：**`*` 永不发放**
  （防任意网页跨站读取登录响应做 drive-by 凭证探测，RQ 澄清第 1 条）。

配置具体来源列表（如 `http: corsAllowOrigins: ['http://A机:7300']`）时，`/api/auth/*`
按精确来源回显放行——**远程宿主的在线登录与令牌续期需要 B 侧（数据面所在机）显式配置
A 机来源**；这是有意为之的零信任默认（跨机器部署本就应显式放行）。

## 3. SSE 通道日志脱敏（/api/panel/stream?token=）

EventSource 无法携带 Bearer 头，面板 SSE 以 `?token=` 查询参数自校验（fail-closed，
token 为 30 分钟时效 access token，撤销/过期即时失效）。**查询串可能进访问日志**，部署层要求：

- Nginx/反代 `log_format` 对 `/api/panel/stream` 的查询串脱敏，或对该路径设置短日志保留期；
- 应用层访问日志同口径处理。

硬化方向（backlog）：挂载形态改用 dsh-bridge 会话 Cookie 鉴权，或以 fetch 流式读取替代
EventSource（可带 Bearer 头，需重做降级轮询联动）。

## 4. 多用户并发宿主的归因声明

dsh 宿主形态下，工具出站归因（on-behalf-of → `X-On-Behalf-User`）在会话未绑定时回落
「最近一次绑定身份」（单操作者工作站姿态）。**多用户并发使用宿主时，该归因链路
不作为计费与追责的事实源**；面板协作面的归因不受影响（走平台自身会话，与 dsh 绑定无关）。
硬化方向（backlog）：dsh 会话级绑定（session ↔ 平台身份随会话传递），替换进程级 current 回落。

## 5. 留档待议（澄清第 3/5/7 条）

- **模型目录权限口径**：`/api/panel/models` 写操作用 `panel.config.write`（org_admin 持有），
  v1 维持（面板定位即部门级自助；计量/计费链路不旁路）。**多租户收敛点**：出现跨组织共享
  modelgw 的部署形态时，模型目录写入应引入组织作用域（`modelgw.admin` 按组织分域，或新增
  `panel.model.write` 且默认不授 org_admin）。
- **F 范围待议项**：钉钉 H5 降级链路（realtime.js/UA 探测）、五平台卡片包主题及其配套测试
  （`dingtalk-h5-smoke.mjs`、`walkthrough.mjs`）随 F 范围功能单独评估合并时一并补入。
- **文档偏差**：上游历史以 main 实测 `git log` 为准（RQ 侧 origin/main 快照含已改写的
  e8c0421）；selftest 保持 `scripts/selftest.mjs` 布局，RQ 侧引用以 main 布局为准。
