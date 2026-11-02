# 演进路线：OS-skill 模块融合决策

> 来源：[01men/OS-skill](https://github.com/01men/OS-skill)（企业级 AI 应用可复用功能模块集锦）
> 原则：**选择性融合**——只吸收对插件化平台有长远建设价值、且符合 dsh「一切皆插件」规范的设计；
> 暂缓项明确记录触发条件与实施手册出处，避免盲目堆功能。

## 一、已融合（v1.1）

| # | 融合项 | 来源模块 | 落点（dsh 插件） | 长远价值 |
|---|---|---|---|---|
| 1 | **IdentityProviderAdapter 统一抽象**：`buildAuthorizeUrl / exchangeCode / getUserInfo / normalizeProfile` + 三场景归一（web_qr/h5/in_app）+ NormalizedProfile | auth-identity docs/03 | `plugin-iam/src/providers.ts` | 登录主流程面向接口编程；接入真实钉钉/飞书/企微只需替换 Adapter 实现与凭证配置，零改主流程 |
| 2 | **身份链接事实源 + 引擎级唯一约束**：`iam:identityLinks` 集合，`collection.uniqueOn()` 模拟数据库部分唯一索引（`provider+providerUserId` 活跃唯一）；「禁止先查后插」红线工程化到存储引擎，users/orgs 同受益 | auth-identity docs/01/02 红线 | `platform-core/src/storage.ts`、`plugin-iam` | 一人一号由引擎兜底，并发/竞态下不可能产生重复绑定——平台数据完整性的通用底座能力 |
| 3 | **refresh_token 轮转链 + sid 会话**：access 30min + refresh 7d（仅存 SHA-256 哈希）、单次轮转、重放检测→整链吊销；sid 贯穿会话，登出/封禁按会话即时吊销 | auth-identity docs/06 | `plugin-authn` | 令牌体系达到生产基线；前端 401 静默续期，体验与安全兼得 |
| 4 | **OAuth state 防 CSRF + code 一次性消费**：`beginSso` 签发一次性 state（10min），`completeSso` 消费校验；授权码 5 分钟窗口内单次消费 | auth-identity docs/07 攻击演练 | `plugin-authn` | 登录攻击面收敛，自测覆盖三类重放演练 |
| 5 | **未命中三分支**：三方登录未命中 → 待绑定票据（5min 一次性）→「绑定已有账号（验密）/ 注册新账号」 | auth-identity docs/04/05 | `plugin-authn` + `plugin-console`（REST + 登录页 UI） | 首次三方登录的标准产品化流程，而非直接报错 |

自测新增 **15 项安全演练断言**（state 重放/伪造、code 重放、refresh 重放整链吊销、
密码错误不烧票据、一人一号引擎拒绝、注册分支），合计 **97/97 通过**。

## 二、暂缓项（记录触发条件与实施手册）

| 暂缓项 | 来源 | 触发条件 | 实施要点（届时照做） |
|---|---|---|---|
| **多租户三层隔离**（网关注入 X-Tenant-Id + 剥离客户端伪造头 + ORM 强制 scope；「不存在全局角色」，角色只挂 organization_members） | auth-identity docs/06 | 平台从「单组织树」演进为「多租户 SaaS」时 | 先改 ER（organization_members 中间表），再三层依次落地；本平台 users.orgId+orgSubtreeIds 数据权限是它的单租户简化形态 |
| **非对称签名 RS256/ES256 + JWKS 轮换**（私钥不出身份服务） | auth-identity docs/06 | 网关/多服务分别验签成为需求时 | 当前单服务 HMAC 已够用；升级路径：authn 插件内换库 + 暴露 /.well-known/jwks.json |
| **账号合并（人工确认 + 事务迁移）** | auth-identity docs/05 | 出现真实重复账号治理需求时 | 两活跃账号禁止自动合并；迁移 membership/资源需事务 + 审计 |
| **最后登录方式保护** | auth-identity docs/05 红线 | 引入「无密码纯三方账号」时 | 当前平台账号必有密码（密码即保底登录方式），红线天然满足 |
| **钉钉机器人渠道（OAuth 识别 → 单聊推送 → jumprobot 唤起）** | dingtalk-robot-oauth 全模块 | AI 应用「渠道接入」排期时（app.attrs.channels 已预留） | 实施手册：OS-skill `modules/dingtalk-robot-oauth/SKILL.md`（含 5 个实测坑：企业 token 仅 POST、chatbotUserId 获取、webhook 公网要求、整页跳转、端口残留）；建议以 `dsh-plugin-channel-dingtalk` 新插件落地，向 app 插件注册渠道扩展点 |

## 三、融合过程沉淀的工程规范

- **存储引擎唯一约束**（`collection.uniqueOn(label, keyOf)`）已成为平台通用能力：
  后续任何集合需要业务唯一性时，在访问器中声明即可，insert/update 自动校验并抛错。
- **Service 内跨服务访问必须在插件 `inject` 声明**（cordis 严格服务隔离）；插件不得 inject
  自己提供的服务（循环等待）——执行器闭包直持服务实例（见 agent/app/mcp 插件 apply）。
- **异步边界三查**：Adapter 链路（exchangeCode/getUserInfo）必须逐级 `await`；
  HTTP 处理器调用 async 服务方法必须 `await`；Node 原生 TS 运行不支持参数属性语法。
