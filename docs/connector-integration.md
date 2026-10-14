# open-connector 集成指南（M0 桥接 + M1+ 原生纳管）

> 版本：v0.2（2026-08-27）· 工作单：#1（M0 桥接验证 + 集成指南初稿）
> 关联：`docs/dev-plan-connector.md` v1.0（设计全文）· 落点插件 `packages/plugin-connector`
> 依据与代码基线：平台端点与参数已对照真实代码核验（console/src/index.ts、plugin-mcp/src/index.ts、plugin-connector/src/index.ts、examples/dshctl.mjs，行号见文内标注）。
> 适用对象：平台运维 / 集成工程师。§二~§六为 M0 桥接（零代码）所需；§七为 M1+ 原生纳管速览。
> **本环境无 docker/sidecar 运行时**：本指南交付部署拓扑、compose 内容与操作步骤；真实桥接联调留给生产环境执行（§八 验证清单）。

---

## 一、定位与适用范围

open-connector v1.4.0（Apache-2.0）作为**连接器数据面网关 + 凭证保险库**以 sidecar 形态与元冰可平台同机部署：1,000+ Provider / 10,000+ Action 目录、OAuth 全流程、oct_ 运行时令牌、`/v1/actions/:actionId` 执行面。

两条接入路径：
- **M0 桥接（本文 §五）**：零代码。把 sidecar 的 `POST /mcp`（stateless JSON-RPC，与平台 `/mcp` 同形态）经平台既有 `POST /api/mcp/import`（console L1279-1293 + plugin-mcp `importServices()` L350-418）注册为 external MCP 服务，即刻获得平台 Bearer 鉴权、MCP 服务级权限组、计量（`mcp:<slug>` 口径）、熔断探活。**仅用于连通性验证与过渡期**（治理降级声明见 §六）。
- **M1+ 原生纳管（本文 §七）**：`plugin-connector` 七步 invoke 链 + oct 令牌策略镜像，生产形态。

三条红线（全路径有效）：
1. **凭证零进平台**——provider 凭证只存 open-connector 保险库（AES-256-GCM）；平台连接引用无凭证字段；oct_ 值仅进程内存。
2. **授权双出验证**——平台权限组与 oct_ 策略两层各自独立拒绝（绕过平台直连 sidecar 同样会被令牌策略拦下）。
3. **actChain 审计 + 计量对账**——每次调用可由 runId（= `meta.executionId`）反查审计链；`GET /api/connector/runs` 按 runtimeTokenId 与 usage trace_id 交叉校验，「有 run 无 meter」即绕行 critical 告警。

---

## 二、部署拓扑

```
┌────────────────────────────────────────────────────────────────┐
│                    调用方（人 / Agent / App）                     │
│        REST 网关 · REST 工具桥 · 平台 MCP Server（三端同契约）      │
└───────────────────────────┬────────────────────────────────────┘
                            │ 平台 Bearer 令牌（双轨身份）
                            │ M0：RBAC mcp.invoke → MCP 权限组 → 限流/熔断
                            │ M1+：①authn ②RBAC connector.invoke ③权限组
                            │      ④admin 审批 ⑤限流 ⑥billing.precheck
┌───────────────────────────▼────────────────────────────────────┐
│               元冰可平台（治理控制面，node src/main.ts）              │
│   plugin-console guarded 路由 · plugin-mcp · plugin-connector     │
└─────────┬─────────────────────────────────────┬────────────────┘
 【管理面】 │ M0：POST /api/mcp/import 注册桥接服务   │ 【数据面】M0：POST /api/mcp/invoke
 （运维，  │      POST …/sync-tools · …/health     │   → 转发 sidecar POST /mcp
  内网）   │ M1+：PUT /api/connector/gateway 等     │ M1+：POST /api/connector/execute
          │ （均需平台 Bearer + 对应权限点）          │   → POST /v1/actions/:actionId
          │                                       │   （headers 预置 Bearer oct_）
┌─────────▼─────────────────────────────────────▼────────────────┐
│             open-connector sidecar（连接器数据面网关）              │
│          ghcr.io/oomol-lab/open-connector:v1.4.0（生产 pin）       │
│  :3000  POST /mcp（M0 数据面，Bearer oct_）                        │
│         POST /v1/actions/:actionId（M1+ 数据面，Bearer oct_）      │
│         GET /v1/health（探活，免鉴权）                              │
│         /api/*（管理面，Bearer ADMIN_TOKEN，仅内网）                │
│         GET /oauth/callback（OAuth 回调，按 §四 拓扑暴露）           │
│         凭证保险库 connect.sqlite（AES-256-GCM，volume 持久化）      │
└─────────────────────────────┬──────────────────────────────────┘
                              │ 数据面出站（HTTPS）：action 调用 + OAuth 授权
┌─────────────────────────────▼──────────────────────────────────┐
│             SaaS Providers（1,000+ / 10,000+ Actions）           │
│        HackerNews（no_auth）· GitHub（OAuth / API Key）· …        │
└────────────────────────────────────────────────────────────────┘
```

- **管理面**（左侧）：运维操作——服务注册/同步/探活（M0）或网关配置/目录/连接/权限组管理（M1+ `/api/connector/*`），以及 sidecar 自身的 `/api/*`（连接、运行时令牌、runs、OAuth 配置）。sidecar 管理面只应内网可达，**不暴露公网**。
- **数据面**（右侧）：真实 action 调用链——平台 invoke → sidecar `/mcp`（M0）或 `/v1/actions/:actionId`（M1+）→ SaaS Provider，全程 Bearer `oct_` 运行时令牌。
- **凭证边界**：所有 provider 凭证只进 sidecar 凭证保险库（加密落盘），平台零凭证（红线一）。

---

## 三、sidecar 部署

### 3.1 docker compose（推荐）

```yaml
# deploy/connector-gw.compose.yml —— open-connector sidecar（连接器数据面网关）
# 镜像 pin v1.4.0：禁 latest/tip；升级前必须先跑契约锁定测试组（selftest T-01）
services:
  open-connector:
    image: ghcr.io/oomol-lab/open-connector:v1.4.0
    container_name: open-connector
    restart: unless-stopped
    ports:
      # 数据面 /mcp、执行面 /v1/*、探活 /v1/health 与管理面 /api/* 同端口 3000。
      # 直连拓扑（§4.1）：企业浏览器需可达回调，绑定 0.0.0.0（默认写法）。
      # 反代拓扑（§4.2）：建议改绑 "127.0.0.1:3000:3000"，回调经平台域名反代进入。
      - "3000:3000"
    environment:
      # —— 强制 env（P0 修正①：缺任一即部署不合格，平台侧 fail-closed）——
      # AES-256-GCM 凭证加密密钥（不设置则凭证明文落盘 + 启动告警不阻断）
      OOMOL_CONNECT_ENCRYPTION_KEY: "${OOMOL_CONNECT_ENCRYPTION_KEY:?必须在 .env 提供 OOMOL_CONNECT_ENCRYPTION_KEY}"
      # 管理面 /api/*、/docs、Web Console 的 Bearer 鉴权（不设置则管理面裸奔）
      OOMOL_CONNECT_ADMIN_TOKEN: "${OOMOL_CONNECT_ADMIN_TOKEN:?必须在 .env 提供 OOMOL_CONNECT_ADMIN_TOKEN}"
      # OAuth 回调公共 origin —— 按拓扑二选一（§四）：
      #   直连：http://<sidecar-host>:3000     反代：https://<平台域>/connector-gw
      OOMOL_CONNECT_ORIGIN: "${OOMOL_CONNECT_ORIGIN:-http://127.0.0.1:3000}"
      # 允许连接级自备 OAuth App（'*' 或 service 清单，如 github）；需要 OAuth 自备 App 的企业必配
      OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH: "${OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH:-}"
      # runs 保留上限（默认 5000，轮转窗口）：对账周期（默认 5 分钟）必须远短于轮转周期
      OOMOL_CONNECT_RUN_LIMIT: "${OOMOL_CONNECT_RUN_LIMIT:-5000}"
    volumes:
      # connect.sqlite：凭证 / OAuth 配置 / pending state / 幂等响应 / runs
      - connector-data:/app/data

volumes:
  connector-data:
```

配套 `.env`（与 compose 同目录，**不进版本库**）：

```bash
# 生成建议：openssl rand -base64 32（ENCRYPTION_KEY）；openssl rand -hex 24（ADMIN_TOKEN）
OOMOL_CONNECT_ENCRYPTION_KEY=<32 字节随机密钥，base64>
OOMOL_CONNECT_ADMIN_TOKEN=<随机管理令牌>
OOMOL_CONNECT_ORIGIN=http://<sidecar-host>:3000
OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH=github
OOMOL_CONNECT_RUN_LIMIT=5000
```

> compose 的 `${VAR:?…}` 语法在变量缺失时**直接拒绝启动**（fail-closed 在编排层先兜一层）；仍须按 §八 清单核对容器内 env 实际生效。

### 3.2 node 直跑（备选）

```bash
git clone https://github.com/oomol-lab/open-connector && cd open-connector && git checkout v1.4.0
OOMOL_CONNECT_DATA_DIR=./data OOMOL_CONNECT_ENCRYPTION_KEY=$(openssl rand -base64 32) \
OOMOL_CONNECT_ADMIN_TOKEN=$(openssl rand -hex 24) OOMOL_CONNECT_ORIGIN=http://<sidecar-host>:3000 \
npm start     # SQLite 默认（<DATA_DIR>/connect.sqlite），打开自动迁移；PG 需 OOMOL_CONNECT_DATABASE_URL + npm run runtime:migrate（本期不默认）
```

### 3.3 强制环境变量（计划书 §2.2 表）

| env | 作用 | sidecar 侧缺失后果（原生行为） | 平台侧规则 |
|---|---|---|---|
| `OOMOL_CONNECT_ENCRYPTION_KEY` | AES-256-GCM 加密凭证/OAuth 配置/pending state/幂等响应 | 不阻断启动，仅打印警告，**凭证明文落盘** | 平台进程缺此 env → `connector:gateway` 不可用 + **拒绝一切原生 invoke**（503 fail-closed，见 §3.4） |
| `OOMOL_CONNECT_ADMIN_TOKEN` | `/api/*`、`/docs`、Web Console 管理面 Bearer 鉴权 | 管理面裸奔 | 同上 fail-closed；网关 adminToken 走 `env:` 间接引用时，引用值缺失 →「管理口令未解析」拒绝 |
| `OOMOL_CONNECT_ORIGIN` | OAuth 回调公共 origin | 回调 URL 错误 | 按部署拓扑配置（§四），部署前必查 |
| `OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH` | 允许连接级自备 OAuth App（`*` 或 service 清单） | 企业无法自带 client | 需要 OAuth 自备 App 时必配（§4.4） |
| `OOMOL_CONNECT_RUN_LIMIT`（默认 5000） | runs 保留上限（轮转窗口） | — | 对账周期必须远短于轮转周期（M2 对账依赖） |

### 3.4 平台侧接入与 fail-closed 行为

**两强制项（`ENCRYPTION_KEY` / `ADMIN_TOKEN`）缺失时的平台侧 fail-closed 行为**（`gatewayStatus()`，plugin-connector/src/index.ts L208-233）：`GET /api/connector/gateway` 的 `envChecks` 报缺失，网关 available=false，原生 `connector.execute` 一律经 `requireClient()` 抛 503 `gateway_unavailable`（不降级、不绕过）；探活连续失败 ≥3 发 `connector.gateway.unhealthy` 事件。M0 桥接路径不经该网关（走 plugin-mcp），但**部署不合格同样禁止用于任何真实凭证**——明文落盘与管理面裸奔直接违反红线一。

平台进程 env 要求 + 网关登记（M1+；`PUT /api/connector/gateway` 实测存在，console L1490-1495）：

```bash
# 平台进程需可读到（与 sidecar 共享同名 env，或经网关 adminToken 的 env: 引用）：
#   OOMOL_CONNECT_ENCRYPTION_KEY   —— 平台 fail-closed 门禁读取项（存在即视为合规）
#   OOMOL_CONNECT_ADMIN_TOKEN      —— 平台调 sidecar /api/* 的管理口令
dshctl connector gateway set --base-url=http://127.0.0.1:3000 --admin-token-env=OOMOL_CONNECT_ADMIN_TOKEN
dshctl connector gateway health           # 期望 ok=true
```

fail-closed 行为对照表（均已随 #2 实现，可用 `?assumeEnv=` 只读预演，console L1470-1483）：

| 触发条件 | 表现 |
|---|---|
| `connector:gateway` 未配置 baseUrl | `GET /api/connector/gateway` available=false（status=unconfigured）；execute 拒绝 |
| `OOMOL_CONNECT_ENCRYPTION_KEY` 缺失 | 拒绝 invoke（503）；探活置 unavailable；连续失败 ≥3 发 `connector.gateway.unhealthy` 告警 |
| `OOMOL_CONNECT_ADMIN_TOKEN` 无法解析（env: 引用缺失值） | 同上 fail-closed，文案「管理口令未解析」 |
| sidecar 探活连续失败 | `unavailableReason` 落库「连接器网关不可达：<err>」，恢复后自动回 healthy |
| 只读预演探针 | `GET /api/connector/gateway?assumeEnv={"OOMOL_CONNECT_ENCRYPTION_KEY":false}` 在不改真实环境的前提下评估各分支文案 |

### 3.5 启动与健康探活

```bash
docker compose up -d
# 探活（免鉴权）——期望 {"success":true,"data":{"ok":true,"runtime":"oomol-connect"}}
curl -s http://127.0.0.1:3000/v1/health
# 管理面鉴权自检（Bearer ADMIN_TOKEN）——期望返回连接列表信封
curl -s -H "Authorization: Bearer $OOMOL_CONNECT_ADMIN_TOKEN" http://127.0.0.1:3000/api/connections
```

---

## 四、OAuth 回调两拓扑 runbook（部署前必查 `OOMOL_CONNECT_ORIGIN`）

open-connector OAuth 全程在 sidecar 完成：发起授权 → 返回 `{authorizationUrl, state}` → 用户浏览器跳 provider 授权 → provider 回调 sidecar `GET /oauth/callback?state=&code=` → 凭证存入保险库。**回调可达性是首要联调风险**（计划书 §五 风险 1），部署前必须先定拓扑。

### 4.1 拓扑 A：直连 sidecar 回调

**适用**：企业内网/VPN 内办公，用户浏览器可直接访问 sidecar 主机。

**步骤**：
1. **DNS**：内网 DNS 或 hosts 登记 `<sidecar-host>`（如 `connect.internal.corp`）→ sidecar 所在主机 IP；
2. **端口**：compose `ports` 保持默认 `0.0.0.0:3000`；防火墙放行内网段访问 3000/tcp；
3. **配置**：`.env` 设 `OOMOL_CONNECT_ORIGIN=http://connect.internal.corp:3000`，`docker compose up -d` 生效；
4. **验证**：按 §3.5 探活；浏览器访问 origin 根路径确认可达；
5. **provider 侧**：注册 OAuth App 时回调地址填 `http://connect.internal.corp:3000/oauth/callback`（个别 provider 强制 HTTPS 回调——见拓扑 B）。

**取舍**：链路最短、无额外组件；但回调 URL 为 HTTP 明文 + 主机端口直暴，部分 provider（强制 HTTPS 回调）不接受，公网/混合办公场景不适用。

### 4.2 拓扑 B：经平台反代回调

**适用**：企业要求统一域名出口、provider 强制 HTTPS 回调、用户不在内网。

**步骤**：
1. **DNS**：公共/企业 DNS 登记 `<平台域>`（如 `ops.corp.com`）→ nginx 入口；
2. **反代**：nginx 增加 location——**只转发回调与探活，管理面 `/api/*` 不暴露公网**：

```nginx
# /etc/nginx/conf.d/connector-gw.conf 片段
location /connector-gw/oauth/callback {
    proxy_pass http://127.0.0.1:3000/oauth/callback;
    proxy_set_header Host $host;
}
location /connector-gw/v1/health {
    proxy_pass http://127.0.0.1:3000/v1/health;
}
```

3. **端口**：compose `ports` 改绑 `"127.0.0.1:3000:3000"`（sidecar 只接受本机反代流量）；
4. **配置**：`.env` 设 `OOMOL_CONNECT_ORIGIN=https://ops.corp.com/connector-gw`（sidecar 按该 origin 拼回调 URL）；
5. **provider 侧**：OAuth App 回调地址填 `https://ops.corp.com/connector-gw/oauth/callback`。

**取舍**：HTTPS 合规、管理面天然隔离在内网；代价是多一跳 nginx 与证书运维，且 `OOMOL_CONNECT_ORIGIN` 配错时回调 404（症状：provider 授权完成后 sidecar 无连接生成——排查先看 origin）。

### 4.3 拓扑速查

| 维度 | A 直连 | B 反代 |
|---|---|---|
| 回调 URL | `http://<sidecar-host>:3000/oauth/callback` | `https://<平台域>/connector-gw/oauth/callback` |
| `OOMOL_CONNECT_ORIGIN` | `http://<sidecar-host>:3000` | `https://<平台域>/connector-gw` |
| sidecar 端口绑定 | `0.0.0.0:3000` | `127.0.0.1:3000` |
| `/api/*` 管理面 | 仅内网可达 | 仅内网可达（nginx 不转发） |
| provider HTTPS 强制 | 不满足 | 满足 |

### 4.4 自备 App（企业自带 client）

自托管形态下多数 OAuth provider 需要企业先注册 App 并把 client 配置存入 sidecar：

1. provider 后台创建 OAuth App（回调地址按 §4.1/§4.2）；
2. client 配置写入网关：`PUT /api/oauth/configs/:service`（Bearer ADMIN_TOKEN）；并确认该 service 已列入 `OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH`；
3. 未配置就发起授权 → `400 oauth_client_config_required`（平台透传并附向导指引文案——**这是预期护栏，不是故障**）。

---

## 五、M0 桥接操作步骤（step-by-step）

> 端点与参数均对照真实代码：`POST /api/mcp/import` = console/src/index.ts L1279-1293；导入实现 = plugin-mcp/src/index.ts `importServices()` L350-418；工具同步 = L339-348；invoke = L731+。平台侧请求带登录令牌，sidecar 侧带 ADMIN_TOKEN / oct_。

### 5.0 前置条件

- sidecar 已按 §三 部署且 `/v1/health` 探活通过；
- 平台已启动（`node src/main.ts`），持有具备 `mcp.service.write`、`mcp.permgroup.write`、`mcp.invoke` 权限点的账号（admin / resource_admin）；
- 已按 §四 确定 OAuth 拓扑（M0 冒烟用 no_auth provider 可暂不配 OAuth，但 origin 建议先定）。

### 5.1 铸造 oct_ 运行时令牌（sidecar 管理面）

平台对桥接服务的每次 MCP 调用都要携带 sidecar 认可的 Bearer。M0 用一枚最小策略的 oct_ 运行时令牌（**仅用于连通性验证，生产禁用**——见 §六）：

```bash
curl -s -X POST http://127.0.0.1:3000/api/runtime-tokens \
  -H "Authorization: Bearer $OOMOL_CONNECT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "allowedActions": ["hackernews.*"],
    "blockedActions": [],
    "allowedProxies": [],
    "allowedConnections": []
  }'
```

响应信封 `data.token` 即 oct_ 值（**仅此一次返回**，库中只存 sha256 哈希）——请立即保存到密文渠道，并记下 `data.id` 供 §5.7 回收。

### 5.2 平台登录取令牌

```bash
curl -s -X POST http://<平台地址>/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"…"}'
# → { "token": "…", "refreshToken": "…", "expiresAt": …, "user": { "id": "…", "orgId": "…", "permissions": […] } }
```

后续所有平台请求带 `-H "Authorization: Bearer <平台token>"`。

### 5.3 注册 external 服务（POST /api/mcp/import）

请求体是 mcpServers JSON（Claude Desktop / Cursor / Cherry Studio 通行形态；支持 `{"mcpServers":{…}}` 包装、裸映射、单对象三种输入；`type` 用 `streamableHttp`/`http`/`sse`，stdio/command 形态会被拒并回原因）：

```bash
curl -s -X POST http://<平台地址>/api/mcp/import \
  -H "Authorization: Bearer <平台token>" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "mcpServers": {
        "open-connector": {
          "type": "streamableHttp",
          "url": "http://127.0.0.1:3000/mcp",
          "headers": {
            "Authorization": "Bearer oct_xxxxxxxx",
            "x-bridged-from": "open-connector v1.4.0"
          },
          "description": "open-connector 数据面网关（M0 桥接过渡）"
        }
      }
    },
    "autoDeploy": true
  }'
```

关键点（与代码逐一对应）：
- `config` 接受 JSON 字符串或对象（`config: string | object`，console L1281）；
- `url` 指向 sidecar 的 **`/mcp`**（数据面 JSON-RPC 端点），不是管理面；
- `headers.Authorization` 携带 §5.1 铸造的 **oct_ 运行时令牌**（sidecar `/mcp` 数据面鉴权）；
- **`x-bridged-from` 请求头是打标开关**：导入实现读取它写入服务记录 `bridgeFrom` 字段（plugin-mcp L368-380），控制台据此打「桥接过渡」徽章（§六）；
- `autoDeploy` 缺省视为 `true`（plugin-mcp L399）：导入成功即自动 verify + deploy（灰度 100%，changelog「mcpServers 配置导入自动发布」）；`false` 则保留草稿人工发布；
- 服务自动落根组织（代码取 parentId 为 null 的根 org），mode=`external`、exec=`real`。

响应（`McpImportResult` 形状，plugin-mcp L129-138）：

```json
{
  "imported": 1,
  "results": [
    {
      "name": "open-connector",
      "ok": true,
      "slug": "open-connector",
      "serviceId": "mcp_srv_xxxxxxxx",
      "tools": 5,
      "reachable": true,
      "status": "online"
    }
  ]
}
```

失败语义：远端不可达时该条 `ok:true` 但 `reachable:false`、`error` 附原因（服务保留草稿、工具清单清空，避免伪工具进权限组）；条目配置非法（如 stdio）则 `ok:false`。**记下 `serviceId` 供后续步骤。**

### 5.4 工具发现与同步

导入时已自动 `initialize → tools/list` 发现工具（plugin-mcp L312-332）。此后 sidecar 工具集变化时手动刷新：

```bash
# 以远端 tools/list 为准刷新本地清单（仅 external + exec=real 服务支持，plugin-mcp L339-348）
curl -s -X POST http://<平台地址>/api/mcp/services/mcp_srv_xxxxxxxx/sync-tools \
  -H "Authorization: Bearer <平台token>"

# 查看服务与工具清单（headers 展示层已脱敏 maskServiceHeaders）
curl -s http://<平台地址>/api/mcp/services \
  -H "Authorization: Bearer <平台token>"
```

健康探活由平台后台自动执行：**30s 一轮，连续 3 次失败开熔断**（plugin-mcp L236-238、L521-535；服务转 unhealthy，invoke 拒绝，恢复后自动回 healthy）。

### 5.5 配置 MCP 权限组（invoke 的授权前提）

invoke 链要求调用主体命中某权限组且策略覆盖目标工具（`authorize()`，plugin-mcp L699-727）。用户主体经用户组授予：

```bash
# ① 查用户组，取全员组 id（seed 内置静态全员组）
curl -s http://<平台地址>/api/iam/groups -H "Authorization: Bearer <平台token>"

# ② 建权限组：对该桥接服务放开工具（冒烟期可 '*'；生产收紧为工具白名单）
curl -s -X POST http://<平台地址>/api/mcp/perm-groups \
  -H "Authorization: Bearer <平台token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "M0 桥接冒烟",
    "description": "open-connector 桥接服务连通性验证（临时）",
    "policies": {
      "mcp_srv_xxxxxxxx": { "allowedTools": "*", "constraints": { "readOnly": true } }
    },
    "subjects": [
      { "type": "user_group", "id": "<全员组id>", "name": "全员" }
    ]
  }'
```

### 5.6 execute_action 冒烟（no-auth：hackernews.get_top_stories）

```bash
curl -s -X POST http://<平台地址>/api/mcp/invoke \
  -H "Authorization: Bearer <平台token>" \
  -H "Content-Type: application/json" \
  -d '{
    "serviceId": "mcp_srv_xxxxxxxx",
    "tool": "execute_action",
    "args": { "actionId": "hackernews.get_top_stories", "input": {} }
  }'
```

- 工具名与参数以 §5.4 `tools/list` 发现结果为准：open-connector `/mcp` 以 action 执行类工具为核心，`args` 的确切字段名**执行时先读该工具 `inputSchema` 再拼参**——上例为通行形态（tool=`execute_action`，args 含 `actionId`/`input`）。
- 平台响应（`InvokeResult`，plugin-mcp L108-115）：`{"ok":true,"status":"ok","latencyMs":…,"version":"v…","result":…}`；`result` 为 MCP `tools/call` 结果（content 数组包裹的 action 原始返回，具体形状以真实联调为准）。
- **通过判据（= M0 DoD + selftest T-25 口径）**：桥接服务 online；`mcp_invoke` 经平台权限组成功调用 1 个 no-auth action；无权限主体调用被拒（`denied`）。

### 5.7 回收（冒烟完成后）

避免 M0 宽松令牌与临时权限组长期存活：

```bash
# 平台侧：下线（必须填原因，默认走 L4 审批单，console L1332-1344）→ 审批通过后删除
curl -s -X POST http://<平台地址>/api/mcp/services/mcp_srv_xxxxxxxx/offline \
  -H "Authorization: Bearer <平台token>" -H "Content-Type: application/json" \
  -d '{"reason":"M0 冒烟完成"}'
# sidecar 侧：吊销冒烟令牌（oct_ id 来自 §5.1 响应）
curl -s -X DELETE http://127.0.0.1:3000/api/runtime-tokens/<oct_token_id> \
  -H "Authorization: Bearer $OOMOL_CONNECT_ADMIN_TOKEN"
```

---

## 六、治理降级声明（P2 修正⑬ · 防「长期捷径」）

**M0 桥接只有 MCP 服务级粒度**：

1. **无 action 级授权**——MCP 权限组的 `allowedTools` 只能管到「桥接服务暴露的 MCP 工具」（如 `execute_action` 整体放行/拒绝），无法约束到 open-connector 目录里的具体 action；
2. **无连接级绑定**——无法把调用限制到指定 provider 连接（对照 M1+ 的 `allowedConnections` 稳定 ID 绑定）；
3. **无 oct 令牌镜像**——令牌策略不随平台权限组快照联动更新（对照 M2 的 PUT 四数组同步与 401/403 自动恢复）；
4. **无连接器域计量/审计语义**——计量落 `mcp:<slug>` 口径而非 `connector:<provider>`，审计无 actChain/runId（= executionId）对账链；
5. **oct_ 令牌经 mcp 服务 `headers` 字段落库**（明文 JSON，仅展示层脱敏）——M0 过渡形态的已知缺口，M1+ 已改为 `env:` 间接引用 + 进程内存缓存、永不落盘。

**结论：M0 仅用于连通性验证与过渡期；生产纳管必须走 M1+ 原生链路（§七）。**

**控制台打标**：经 MCP 桥接导入的 open-connector 服务（带 `x-bridged-from` → `bridgeFrom` 字段），在 `#/mcp` 与 `#/connectors` 页面均打**「桥接过渡」徽章**，hover 展示上述治理降级说明（计划书 §2.9 M0 打标；徽章数据字段已随 importServices 落地，UI 呈现随工作单 #9 交付后复验）。

---

## 七、M1+ 原生纳管操作速览（CLI）

> 以下命令与路由均已对照代码核验存在（console `/api/connector/*` L1470-1704；examples/dshctl.mjs L743+）。

```bash
# 网关与目录
dshctl connector gateway set --base-url=http://127.0.0.1:3000 --admin-token-env=OOMOL_CONNECT_ADMIN_TOKEN
dshctl connector gateway health                       # 期望 ok=true
curl -X POST $API/api/connector/catalog/sync -H "authorization: Bearer $TOKEN"

# 连接三形态
cat > values.json <<'JSON'
{"apiKey":"ghp_xxx"}
JSON
dshctl connector connections create --provider=hackernews --auth-type=no_auth --org=$ORG_ID
dshctl connector connections create --provider=github --auth-type=api_key --org=$ORG_ID --values=@values.json
rm values.json                                        # 平台已即刻转发完毕，本地不留副本
dshctl connector connections list                     # 校验 maskedProfile 为脱敏形态

# 权限组（双层授权第一层；oct_ 令牌随之铸出/更新，四数组全发）
cat > pg.json <<'JSON'
{"name":"dev-read-only","orgId":"ORG_ID",
 "policies":{"hackernews":{"allowedActions":["hackernews.*"],"riskCap":"read","constraints":{"readOnly":true}}},
 "subjects":[{"type":"user_group","id":"USER_GROUP_ID"}],
 "rateLimitPerMin":60}
JSON
dshctl connector perm-groups create --file=@pg.json
dshctl connector tokens                                # 台账可见 ocTokenId + 快照哈希（无令牌值）

# 调用与对账
dshctl connector execute --action=hackernews.get_top_stories --dry-run
dshctl connector execute --action=hackernews.get_top_stories --input=@input.json
dshctl connector runs                                  # runId 即 executionId
dshctl connector reconcile                             # 绕行检测：有 run 无 meter 即 critical 告警（人工复核）
```

审批双场景：
- **高危 action（riskLevel=admin）**：execute 直接返回 `approval_required + approvalId`；同一意图的 pending 单复用不重复开单。批准后 executor 自动完成调用/计量/审计：`dshctl approval decide <approvalId> --decision=approve`。
- **受控连接**：第一段生成 `connector.connect` 审批单（负载零凭证字段）；批准后携 approvalId 以相同参数重新提交（服务端校验 approvalId/provider/org/requester 一致性）完成实际创建。

OAuth 连接（原生链路）：`POST /api/connector/connections/oauth` 得 `{authorizationUrl, state}` → 浏览器授权（回调拓扑 §四）→ `GET /api/connector/connections/oauth/:requestId/status` 轮询至 active。

---

## 八、生产环境验证清单（供真实环境执行人勾选）

**A. sidecar 部署**
- [ ] compose 使用 `ghcr.io/oomol-lab/open-connector:v1.4.0`（非 latest/tip），volume `connector-data:/app/data` 挂载成功
- [ ] `OOMOL_CONNECT_ENCRYPTION_KEY` 已设置（容器内 env 核对），`/app/data` 凭证文件非明文
- [ ] `OOMOL_CONNECT_ADMIN_TOKEN` 已设置；无 token 访问 `/api/connections` 被拒、带 token 成功
- [ ] `GET /v1/health` 返回 `{"success":true,"data":{"ok":true,"runtime":"oomol-connect"}}`
- [ ] `OOMOL_CONNECT_ORIGIN` 与所选拓扑一致（§四）；浏览器实测回调路径可达
- [ ] 管理面 `/api/*` 不暴露公网（反代拓扑下 nginx 无转发规则）

**B. M0 桥接（对应 selftest T-25）**
- [ ] 铸造 oct_（策略收敛到冒烟所需最小 action 集），值已密文保存
- [ ] `POST /api/mcp/import` 注册成功：`reachable:true`、`tools>0`、`status:online`
- [ ] 导入 headers 含 `x-bridged-from`；`GET /api/mcp/services` 可见 `bridgeFrom` 字段
- [ ] `POST /api/mcp/services/:id/sync-tools` 幂等刷新正常
- [ ] 建权限组并授予测试主体；被授权主体 `POST /api/mcp/invoke` 调 `execute_action`（hackernews.get_top_stories）成功返回
- [ ] 未授权主体调用返回 `denied`（授权闭环反向验证）
- [ ] 控制台 `#/mcp` 服务列表可见「桥接过渡」徽章（依赖 #9 UI 交付后复验）
- [ ] 冒烟令牌、临时权限组与桥接服务已按 §5.7 回收

**C. 三类 provider 全谱系联调（计划书 §4.2）**
- [ ] no_auth：HackerNews 目录可见 + invoke 成功 + 平台调用日志/计量可见（`mcp:` 口径）
- [ ] OAuth：GitHub 自备 App（`PUT /api/oauth/configs/:service` + `ALLOWED_CUSTOM_OAUTH`）→ 发起授权 → 回调 → `GET /api/connections` 出现 configured 连接；未配 client 时 `400 oauth_client_config_required` 复现（预期护栏）
- [ ] API Key 型：`PUT /api/connections/:service` 建命名连接 → invoke 经 `x-oo-connector-alias` 路由成功
- [ ] runs 留痕：`GET /api/connector/runs`（Bearer ADMIN_TOKEN）可见上述调用，`runtimeTokenId`/`policy` 字段正确

**D. 平台侧 fail-closed / 逃生验证**
- [ ] `GET /api/connector/gateway` envChecks 正常上报强制 env 状态；`?assumeEnv={"OOMOL_CONNECT_ENCRYPTION_KEY":false}` 预演文案正确
- [ ] 停 sidecar → 原生 execute 拒绝（503 gateway_unavailable）+ 探活连续失败 ≥3 触发 `connector.gateway.unhealthy`；恢复后自动回 healthy
- [ ] 停 sidecar → M0 桥接服务 3 轮探活内熔断（unhealthy），恢复后自动回 healthy

---

## 九、升级与边界

- **版本锁定 v1.4.0**：升级前先跑 `npm run selftest`（契约锁定测试组 T-01 对统一信封/ConnectionSummary 八字段/RuntimeTokenSummary/`{authorizationUrl,state}`/RunLog 字段做 schema 断言）；所有上游契约知识集中在 `packages/plugin-connector/src/client.ts` 单文件。
- **上游文档未载项**：PUT connections / POST authorizations 成功状态码未载（按 200 + 信封 `success:true` 断言）；action 无 risk 分级字段（平台启发式映射，无法判定默认 admin 兜底）。
- **不做**：本地密钥库（sidecar 即密钥库）、自研 provider 目录、K8s 编排（单机 runbook 惯例）、`allowedProxies` 能力开放（后续候选）、transit files（按 action 需求另启）。
- **故障排查速查**

  | 症状 | 处置 |
  |---|---|
  | gateway.available=false 且 reason 含 ENCRYPTION_KEY | 给 sidecar 与平台进程补齐 env 后 `dshctl connector gateway health` 复核 |
  | execute 报 `connection_not_allowed` 且平台自动恢复重试仍失败 | 权限组 connections[] 与连接归属 org 不一致 → 修组或重建连接（alias 必须带 `org:<orgId>:` 前缀） |
  | reconcile 大量 bypass 告警 | 有人持合法 oct_ 直连 sidecar 绕开平台；先吊销对应台账令牌，再按审计 runId 追责 |
  | `oauth_client_config_required` | 见 §4.4 自备 App 步骤 |
  | OAuth 授权完成后 sidecar 无连接生成 | `OOMOL_CONNECT_ORIGIN` 与实际回调路径不符（§四），改 origin 后重新发起 |
  | M0 导入 `reachable:false` | oct_ 无效/过期、URL 误指管理面（应为 `/mcp`）或网络不通；查 §5.1/§5.3 |

---

## 十、撰写说明

本指南由 **cto-doc-agent**（2026-08-27，工作单 #1）依据 `docs/dev-plan-connector.md` v1.0 与当前代码撰写；撰写时发现仓库已有一份随 M1 实现顺带产出的运维向草稿，本版在其基础上按 #1 交付要求重构补全（部署拓扑数据面/管理面标注、OAuth 两拓扑 runbook、M0 step-by-step 真实请求/响应示例、治理降级声明、生产验证清单），并对草稿中与计划书不符的 M0 调用示例作了更正（sidecar `/mcp` 数据面应携带 oct_ 运行时令牌而非管理口令；工具名以 `tools/list` 发现结果为准）。平台侧端点、参数、响应形状均经真实代码核验；open-connector 侧契约以其 v1.4.0 官方文档为准（计划书 §〇 核验表）。**真实桥接联调待生产环境执行**（本环境无 docker/sidecar 运行时），执行结果回填 §八 清单后本指南转正式版（工作单 #14 完稿）。
