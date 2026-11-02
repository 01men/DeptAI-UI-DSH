# 应用外部凭证托管指南（credentials，issue #19 最小闭环）

> 面向对象：数字员工 / 接入应用需要调用「用长期固定凭据鉴权的外部自研服务」的接入方
> （内部服务 token、第三方 API key、共享密钥——非 OAuth 可授权形态）。
> 本文档随服务发布，可直接访问 `http://<平台地址>/docs/app-credentials.md`。

**分工记忆：登录打通（app-sso-integration.md）管「人怎么进来」，外部凭证（本文档）管
「应用出去调别人时拿什么身份」。** 平台机器凭证（`mc-` / `cs_`）是应用面向**本平台**的身份，
不是第三方服务的凭据——调外部服务的长期凭据落在本板块。

此前该场景无任何平台落点（明文散落各机器本地文件：无归属、轮换逐台改、审计断链）。现在：
登记即 AES-256-GCM 静态加密落平台密钥文件，数字员工凭**自身机器身份 + 独立权限点**在运行时取用，
每次取用落审计，轮换同键覆盖（旧值立即失效），应用删除联动清库。

## 一、安全模型（先读这个）

| 关注点 | 口径 |
|--------|------|
| 静态加密 | AES-256-GCM；每条目独立 12 字节 IV + auth tag；**主密钥独立文件**（`<dataDir>/secrets/app/.master.key`，0600），业务备份误拷密钥文件集也无法解密 |
| 密钥文件 | `<dataDir>/secrets/app/<appId>.json`，文件 0600 / 目录 0700；值不入任何业务集合与 API 响应 |
| 回显 | 列表/登记/轮换响应只回 `masked`（长度 ≥8 保留末 4 位）+ `rotatedAt` 等元数据，**值零回显** |
| 授权（登记/轮换/删除） | `app.write` + owner 校验（应用 owner / 平台管理员 / 绑定本应用的机器凭证，与能力绑定同口径） |
| 授权（取值，拿到明文） | **独立权限点 `app.credential.fetch`**：human 须应用 owner 或平台管理员（`*`）；机器凭证须绑定本应用（`refType:'app'`）且持该点。缺省无任何内置角色持有，按需显式授权 |
| 审计 | 每次取值落 `app.credential.access`（change 审计：谁、何时、取了哪把、结果——**值不入审计**） |
| 轮换 | 同键再登记即轮换：`rotatedAt`/`rotatedBy` 更新、`createdAt` 不变、旧值立即失效 |
| 删除 | 单条幂等删除；应用删除（purge）联动删除整个密钥文件（删除即销毁） |

## 二、端点与数据契约

```
PUT    /api/apps/<appId>/credentials/<key>       { value, description? }   （app.write + owner）
GET    /api/apps/<appId>/credentials                                       （app.write + owner）
DELETE /api/apps/<appId>/credentials/<key>                                 （app.write + owner）
GET    /api/apps/<appId>/credentials/<key>/value                             （app.credential.fetch + 对象级）
GET    /api/apps/<appId>/credentials/self-check                              （app.read + owner）
```

- **`<key>`**：URL 路径安全键名（字母/数字开头，仅字母数字 `._-`，1-64 位），如
  `kizuna-admin-token`、`github_api_key`。
- **`<value>`**：非空字符串，≤8192 字符；仅登记时经请求体提交一次，落库即加密。
- 取值未登记键 → `404 CREDENTIAL_NOT_FOUND`；键名非法/空值/超长 → `400`。

### 登记 / 轮换（owner 或管理员）

```sh
curl -X PUT "http://<平台地址>/api/apps/<appId>/credentials/kizuna-admin-token" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"value":"<长期凭据明文>","description":"Kizuna 产品服务管理令牌"}'
# → 200 { key, masked: "••••••••xxxx", createdAt, rotatedAt, rotatedBy, rotated }
#   rotated=false 首次登记；rotated=true 本次为轮换（旧值立即失效）。响应不含明文。
```

### 取值（数字员工运行时通道）

```sh
curl -s "http://<平台地址>/api/apps/<appId>/credentials/kizuna-admin-token/value" \
  -H "authorization: Bearer $MACHINE_TOKEN"
# → 200 { key, value: "<明文>", note }   ← 本次取用已落审计
```

**给机器凭证授权取值**（管理员操作，最小披露面）：

```sh
# 1) 签发/追加 scope：app.credential.fetch（须绑定该应用 refType:'app'）
curl -X POST http://<平台地址>/api/authn/principals \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"<应用名>-fetch","refType":"app","refId":"<appId>","scopes":["app.credential.fetch"]}'
# 2) 应用凭返回的 clientId/clientSecret 换牌后即可取值（client-credentials 流，同 org-sync 通道）
```

应用注册时自动签发的默认机器凭证（`app.read`/`app.write`/…）**不含**该点——取值授权必须显式给，
绑定而不授权同样 403（权限点闸门在前、对象级校验在后，双闸门）。

### 接入方自检（一条命令确认「托管在哪 / 谁能读 / 最近谁读过」）

```sh
curl -s "http://<平台地址>/api/apps/<appId>/credentials/self-check" -H "authorization: Bearer $TOKEN"
# → 200 {
#   storage:    { kind: "platform-managed", algorithm: "AES-256-GCM", note },
#   entries:    [{ key, masked, rotatedAt }],
#   whoCanRead: { permissionPoint: "app.credential.fetch",
#                 machinePrincipals: [{ id, name, clientId }],   // 绑定本应用且持点的活跃机器凭证
#                 humanRule },
#   recentAccess: [{ at, actorId, actorName, result, detail }]   // 最近 10 次取用审计
# }
```

控制台同款入口：**AI 应用 → 应用详情 → 「外部凭证」tab**（登记 / 轮换 / 删除 / 取值 / 自检卡片）。

## 三、与既有机能的边界

| 板块 | 分工 |
|------|------|
| 本板块（应用外部凭证） | 应用调用**外部**服务的长期凭据（存取 + 逐次审计） |
| 机器凭证（authn principals，`mc-`/`cs_`） | 应用/Agent 面向**本平台**的身份（换牌、吊销、scope 管理） |
| MCP Secret Broker（`PUT /api/mcp/services/:id/credential`） | 平台**代发** MCP 服务请求时的下游认证头（凭据不出保险库，平台代注）；本板块则是「把凭据交给数字员工去调外部服务」 |
| app attrs 白名单 | 治理元数据（appType/url/riskLevel/…），对 `app.read` 可见，**永不放凭据** |

## 四、运维提示

- **主密钥文件丢失 = 全部密文不可解**（fail-closed 显式报错，不静默返回垃圾值）：备份
  `<dataDir>/` 时 `.master.key` 与 `secrets/app/` 必须同批同权（0600/0700）保管。
- 解密失败（主密钥不匹配 / 密文损坏）同样 fail-closed：按报错指引重新登记即可。
- 演示态（DEMO_MODE=1）与本板块天然隔离：取值是特权读（非 `.read` 白名单点），演示访客不可达。
