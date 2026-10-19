# dsh 插件化充分落地 —— 架构定版与操作规程（2026-09-08）

> 本文档是「业务交互端充分 dsh 插件化」三项要求的定版设计：装机铁律、连接与登录向导
> （B/C 双形态）、dsh 标准对话与看板双向打通。实施完成于 `custom/dsh-rq`（M1→M2→M3 一轮交付），
> 全部改动落在面板面（plugin-panel-core / plugin-rq-card）+ 仓库级测试与治理文档；
> 底座面零新增（北极星 diff 不变），底座侧增强走交接清单 G 节（docs/handoff-f-remainder-to-main.md）。

---

## 一、三项要求 → 落地形态

| 要求 | 落地 |
|---|---|
| ① 铁律：每次功能/面板更新，全新 dsh 装插件即可安装、启动、完整体验 | AGENTS.md 铁律 7 + selftest「fresh-install 装机模拟」段（patch entry 逐个解析导入 / 三链一致 / bundle build-id 新鲜度 / files 覆盖） |
| ② 装好插件后主动连接、配置宿主（选 IP），完成钉钉/账号登录 | `plugin-rq-card` 宿主半 HostLinkService（`/rqcard/*` 免登向导命名空间）+ 面板首启连接向导（wizard.js）+ dsh 设置分区「元冰可宿主」+ 未连接角标 |
| ③ dsh 标准模式对话与看板打通，作为默认 Agent 对话界面，其他 Agent 协作调用 | dsh 会话「元冰可工作台」视图 Tab（内嵌 /rq/panel/）+ 面板「Agent 对话」默认内嵌 dsh 根对话（嵌套防护/可退回内置）+ `panel_agent_invoke` / `panel_board_digest` 工具族 |

## 二、连接与登录（M2）—— B/C 双形态

### 2.1 连接状态机

`<dataDir>/rq-host-link.json`（0600）记录 `{ mode, hubBase?, hubMountPrefix?, label?, savedAt }`：

- **none**：全新 dsh 首启态。面板 boot 链探测 `GET /rqcard/link`（带 `x-rqcard-call: 1` 头）
  得到 none 且浏览器无会话 → 渲染连接向导（wizard.js）。
- **local**（形态 B，本机即宿主）：面板直连同源 `/api`，登录走本机控制台（钉钉扫码+账号，既有链路）。
  首启时可向导内设置 admin 口令（`POST /rqcard/local-init/admin`：服务端读取一次性初始口令文件完成
  首登+改密+重登，口令不出服务端；成功后删除文件防重放）。
- **remote**（形态 C，连接远端宿主）：面板全部 `/api/*` 经本机插件代理
  `${BASE}/rqcard/proxy/api/*` 转发 `${hubBase}${hubMountPrefix}/api/*`，浏览器零跨域；
  令牌按连接命名空间隔离（`heng_ops_token@<hubBase>`）。

### 2.2 向导端点（`/rqcard/*`，非 `/api` 命名空间）

console 鉴权中间件只拦 `/api/*`——向导必须在**持令牌之前**可用（选宿主、设 admin 口令都发生在
登录前），故走 `/rqcard/*` 免登命名空间 + 自带防线（与 `/api/panel/stream` 内部 token 自校验、
`/api/connect/enroll` 接入码即凭证同一安全族）：

| 端点 | 作用 |
|---|---|
| `GET /rqcard/link` | 连接状态 + 远端探活摘要 + 本机首启标记 |
| `POST /rqcard/link/local · /remote · /reset` | 三通道（remote 先探活才落盘，自动判定挂载前缀 `/rq` 或 ''） |
| `POST /rqcard/link/scan` | 局域网扫描：各 IPv4 /24 × 候选端口（7300/3080）并行短超时探活；可注入候选（测试/历史地址） |
| `ALL /rqcard/proxy/*`（中间件） | 远端数据代理：白名单（auth 族 + `/api/panel/*` + `/api/health`），透传 Authorization、`redirect: 'manual'`、SSE 不透传（前端走既有 30s 轮询降级） |
| `GET /rqcard/local-init` | 首启检测（admin 初始口令文件在场）+ 本机网卡清单（「选择 IP」数据源） |
| `POST /rqcard/local-init/admin` | 首启 admin 口令初始化（一次性消费初始口令文件） |
| `POST /rqcard/local-init/listen-plan` | 对外监听指引（`--trusted-host <ip>:<port>` 命令文本；插件不热改 dsh webServer 监听） |

**自带防线**：① 向导头 `x-rqcard-call: 1`（自定义头跨站发不出——CORS 预检不放行，挡住恶意网页
对 127.0.0.1 向导端点的 drive-by CSRF 改指向）；② 代理白名单 + 只透传 Authorization（不带 Cookie）
+ manual redirect（令牌不随 302 外泄）；③ 白名单校验先于模式校验（未连接时白名单外同样 403）。

**Agent 工具**：`rq_host_status`（会话里能问「连的哪个宿主」+ 面板入口）。

### 2.3 登录

- **账号密码**：向导表单 → `POST /rq/rqcard/proxy/api/auth/login`（白名单内）→ 会话按连接隔离保存 → reload。
- **钉钉扫码**：向导按钮新标签打开 `${hubBase}${prefix}/?next=<本机面板绝对地址>#/login`（宿主登录页）。
  本项目侧消费链已就绪（2026-09-08）：next 前向兼容携带、boot 按连接形态经代理兑换宿主回跳票据
  （query/fragment 双形态，会话落连接作用域）、未支持回跳的宿主提供「我已完成扫码」回导校验诚实降级。
  自动回跳闭环的最后一步依赖底座侧增强（交接清单 **G1**：登录页可信跨源 next + 自助 entry_ticket），
  main 侧采纳后本项目侧零改动闭环；本机形态（B）同源直登，无此限制。

## 三、对话与看板双向打通（M3）

- **dsh 侧**（rq-card 浏览器半，`conversation.view` list 条目 id `rq-workbench`）：
  会话视图 Tab「元冰可工作台」整页内嵌 `/rq/panel/?embed=1`（同源 iframe，顶栏保留浏览器外链兜底）。
- **面板侧**（app.js）：「Agent 对话」= 默认交互面——`hostBridge` 且非嵌入态时 chat 视图渲染
  同源 iframe `/`（dsh 标准模式对话）；`?embed=1` / `window.self !== window.top` / 用户显式退回
  （`panel_chat_embed_off`）时回落内置协作会话（panelAgentRuntime），at-row 提供「改用 dsh 对话」。
  嵌套防护：面板被 dsh 内嵌时不再内嵌 dsh（防 iframe 递归），侧栏「Agent 对话」入口隐藏。
- **上下文携带（MVP，诚实降级）**：嵌入条「携带部门上下文」把部门/行业上下文复制剪贴板（dsh
  深链预填能力未经 spike 核实，核实支持后再升级，不假装支持）。
- **协作调用**：`panel_agent_invoke {dept, agent, message}`——dsh 标准对话点名调用面板 Agent 阵容
  （复用 askAgent：资产解析/模型取向/场景摘要组装/modelgw 单轮/计量；失败诚实 ok:false，不造假回复）；
  `panel_board_digest {platform?}`——战略看板聚合摘要（对话接地）。写通道沿用既有
  `panel_msg_send` / `panel_task_*` / `panel_scene_diag`；平台即 MCP Server（`POST /mcp`）对外不变。
- **主动连接提醒**：宿主连接为 none 时 `shell.overlay` 挂「未连接宿主」角标，点击打开面板（即向导入口）；
  dsh 设置页 `settings.section`「元冰可宿主」分区常驻显示连接状态与入口。

## 四、fresh-install 装机铁律（M1）—— 门禁怎么工作

selftest 首段「fresh-install 装机模拟」把「全新 dsh + `dsh plugin add` → 安装、启动、完整体验」
拆成推送前可自动断言的不变量：

1. **patch entry 逐个解析导入**：解析 cordis.patch.yml 全部 entry（`dsh-enterprise-ops/...` → 仓库
   相对路径；`@dsh-ops/*` → packages/<dir> + exports），existsSync + dynamic import——装机包缺文件/
   坏导出即红。
2. **三链一致**：cordis.patch.yml ↔ cordis.yml 插件 id 集合相等；boot-all ↔ patch 服务面插件一一对应
   （dsh 专属条目 rq-card/dsh-bridge 豁免——独立宿主形态无 dsh web UI）。
3. **bundle 新鲜度**：`build-id.mjs` 对 src/client/**（排除 *.test.mjs）+ wire.ts + build.mjs +
   package.json 计算 sha256 指纹，build.mjs 写入 lib/client.js 头部 banner，selftest 重算比对——
   **改了浏览器半忘重建 = 推送前拦下**。
4. **files 覆盖**：根 package.json `files` 根下关键运行期资产在场（SPA 静态资源/卡片包/场景图谱/
   lib bundle/plugin.yaml+manifest 成对）。

**操作规程（每次功能/面板更新）**：

```bash
node packages/plugin-rq-card/build.mjs   # 浏览器半（src/client/** 等）有任何改动必须先跑
npm run selftest                          # 含 fresh-install 装机模拟段，全绿
npm run lint:manifests                    # 新端点/工具登记 manifest
git push                                  # 交付（origin push → RQ-DSH main）
```

## 五、边界与后续

- 底座侧增强走交接清单 **G 节**（G1 登录回跳闭环 / G2 modelgw 流式化 / G3 拷贝形态 TS 装载），未采纳前本项目侧按降级路径运行。
- LAN 扫描为有界探测（/24 × 双端口 × 350ms 超时，上限 600 候选）；防火墙/多网卡环境以手输兜底，
  扫描失败不阻断向导。
- 远程形态的面板 SSE 不透传（代理不持流），由前端既有 30s 轮询降级承接（realtime.js 契约不变）。
- dsh 客户端 slot（settings.section / conversation.view）实现对照 dsh rc.7 检出范本（ui-auth /
  ui-trajectory），全部走 specDynamic 探测 + safely 降级——上游升级改名时注入面静默消失、不崩宿主
  （spike §5 机制）。

## 六、真机冒烟记录（2026-09-08，dsh rc.7 检出实测）

### 6.1 源码/链接形态（web profile + `--patch overlay`）——8/8 全绿 ✅

全新数据目录（`localFirstRun=true` 首启态）起服 `dsh --profile web --patch overlay.yml --port 3099`：

| # | 检查 | 结果 |
|---|---|---|
| ① | `GET /` dsh web UI | 200 |
| ② | `GET /plugins/@dsh-ops/plugin-rq-card/client.js` | 200，build-id 新鲜，新注入面（工作台 Tab/设置分区/未连接角标）标记 7 处命中 |
| ③ | `GET /rq/panel/` 面板 SPA（经 dsh-bridge 挂载） | 200 |
| ④ | `GET /rq/panel/js/wizard.js` 向导新文件 | 200 |
| ⑤ | `GET /rq/api/health` | 200 ok |
| ⑥ | `GET /rq/rqcard/link`（带向导头） | 200 `{mode:none, localFirstRun:true}`（首启向导态） |
| ⑦ | 缺 `x-rqcard-call` 头 | 403（CSRF 防线生效） |
| ⑧ | `POST /rq/rqcard/link/local` | 200（本机模式落盘） |

### 6.2 真安装拷贝形态（`dsh plugin add file:` → 全新 profile）——已核实两处边界

在全新 `rq-smoke` profile 上执行真实安装链 `dsh plugin --profile rq-smoke add file:D:/DSH-RQ`：

- ✅ **装机链本身健康**：pnpm 安装成功；`dsh-enterprise-ops` 因 `dsh.bundle` 声明自动进 bundle 层；
  装机包关键文件（cordis.patch.yml / lib/client.js / wizard.js / scenegraphs / src）全部在位。
- ✅ **rq-card 包名解析已修复**：安装形态下 profile node_modules 原本解析不到 `@dsh-ops/plugin-rq-card`
  （根包无 dependencies）——本补丁在根 package.json 声明
  `"dependencies": { "@dsh-ops/plugin-rq-card": "file:packages/plugin-rq-card" }`，
  重装后实测 `require.resolve('@dsh-ops/plugin-rq-card/package.json')` 通过、`./client` → `lib/client.js`。
- ⚠ **已知边界（交接 G3，上游层面）**：拷贝安装把 TS 源码放进 `node_modules`，Node（≥22.6，含 24）
  **拒绝对其做类型剥离**（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，实测
  `--experimental-transform-types` 亦不解除）——所有 `…/src/index.ts` 形式的 loader entry 在拷贝
  形态下不可执行。这是**全仓架构级**限制（底座面包同样适用），非本插件化改造引入：
  - 本地装机绕过：`dsh plugin --profile X add link:D:/DSH-RQ`（link: 符号链接的真实路径在
    node_modules 之外，TS 正常装载）；
  - registry/GitHub 拷贝形态的彻底解法需上游决策（G3）：dsh loader 预剥离 TS，或平台侧提供
    预构建分发（构建 JS 镜像 + 指向 .js 的安装补丁）。
  - 在 G3 落地前，「全新 dsh 装插件完整体验」以**源码/链接形态为准**（本文 §6.1 已闭环验证）。
