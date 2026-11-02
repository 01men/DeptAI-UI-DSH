---
name: dsh-ops-authn
description: 管理机器身份、令牌与凭证的签发、撤销和轮换。
---

# Skill: dsh-ops-authn

## 何时使用
机器凭证签发与管理（Agent/应用/外部系统接入；权限范围调整、密钥轮换）、令牌签发与吊销、
签名密钥轮换、on-behalf-of 链路验证、OIDC 客户端（应用 SSO 接入）管理与排障。


## 调用方式（工具优先）
平台已把运维能力注册为 dsh 工具，**回答现状问题（查询/盘点/排障）必须直接调用工具获取真实数据，禁止凭记忆回答**：
- authn_token_issue / authn_token_revoke / authn_token_list / authn_credential_create
  / authn_credential_scopes（调整权限范围）/ authn_credential_rotate（轮换 clientSecret）
（工具参数见各工具 schema；下文手册中的 `dshctl ...` 为「平台独立部署 + HTTP API 运维」场景的 CLI 备选，需 DSHCTL_TOKEN/DSHCTL_USER，在 dsh 会话内一般用不到。）

## 前置条件
需要 authn.* 权限组令牌；OIDC 客户端管理面需 authn.oidc.read（查看）/ authn.oidc.write（签发/轮换/禁用）。

## 操作手册

### 场景 1：为外部系统签发机器凭证
1. `dshctl credential create --name="external:ci-system" --scope=mcp.invoke`（--scope 支持逗号多值与 `*`）
2. clientSecret 仅返回一次——立即转存密钥管理系统
3. 对方用法：POST /api/auth/client-credentials 换取访问令牌（2h 有效）

### 场景 1b：机器凭证治理（权限调整 / 密钥轮换）
- 列出凭证：`dshctl credential list`（principalId/clientId/scopes/状态/活跃令牌）
- 调整权限范围：`dshctl credential scopes <principalId> --scopes=agent.read,usage.write`
  （或控制台「认证与令牌 → 身份主体 → 编辑权限」，按权限目录分组勾选；调整后**存量令牌全部联动吊销**，机器侧需重新换牌）
- 密钥丢失/泄露：`dshctl credential rotate <principalId>` —— clientId 不变、旧 clientSecret 立即失效、
  新值仅此一次返回、存量令牌全部吊销。**无需重新注册 Agent/重新签发凭证**
- 启用/禁用主体：`POST /api/authn/principals/:id/enable|disable`（禁用联动吊销令牌）
- scopes 合法性：必须全部命中权限目录（或恰为 `['*']`），拼错（如 usage.wrtie）会被 400 拒绝

### 场景 2：疑似泄露应急
1. `dshctl credential rotate <principalId>` 一键轮换（旧 secret 失效 + 存量令牌全吊销）
2. 需要定位令牌时：`dshctl token list --principalId=<id>`，`dshctl token revoke <jti> --reason="疑似泄露"` 逐个吊销
3. 严重时禁用主体（控制台认证与令牌页）或轮换签名密钥（吊销全部令牌）

### 场景 3：验证 on-behalf-of 链
POST /api/agents/<id>/obo-token（用户令牌发起）→ 返回 act 链：
用户 → Agent。审计日志的「令牌链」字段可还原完整链路。

### 场景 4：应用接入 SSO（OIDC 客户端）
1. 应用 owner 在控制台「AI 应用 → 详情 → SSO 配置」签发客户端（或管理员在「认证与令牌 → OIDC 客户端」全局登记）
2. client_secret 仅展示一次；回调地址允许 https:// 任意主机，或 http:// 内网地址（localhost / 127.0.0.1 / 10.x / 172.16-31.x / 192.168.x，纯内网部署可 APP_SSO_ALLOW_HTTP=1 放开）；纯前端 SPA 选 public 类型（免 secret、强制 PKCE、无 refresh）
3. 应用侧按 docs/app-sso-integration.md 接入（openid-client / oidc-client-ts，discovery 驱动一行式）
4. web/h5 形态应用上线门禁：未签发有效客户端时 requestOnline 直接拒绝（APP_SSO_ENFORCE 可调）

### 场景 5：OIDC 令牌/客户端排障
- 「回跳后报 invalid_client」→ secret 已轮换（旧值立即失效）或客户端被禁用（应用下架/归档联动）
- 「id_token 调 userinfo 401」→ 预期行为：userinfo 仅接受 access token（token_use 校验）
- 「refresh 换发 400」→ 检查：旧值重放（整链已吊销）、scope 扩大（只允许收窄）、账号冻结（实时校验）、public 客户端（本就不发 refresh）
- 「上线审批通过但执行失败留痕」→ 门禁点 2：审批挂单期间客户端被禁用，重新启用后再发起
- JWKS 密钥轮换（控制台「认证与令牌」）：新 key 立即签名，旧 key 24h 宽限验签，在途令牌不掉线

## 护栏
- clientSecret 任何情况下不得明文落库/入日志
- 轮换签名密钥会使全部存量令牌失效，需提前公告
- OIDC 私钥存 data 目录（oidc-keys.json，数组化多 key），生产建议迁 KMS
