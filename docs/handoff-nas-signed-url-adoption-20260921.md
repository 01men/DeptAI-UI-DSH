# 采纳回执：NAS 下载链接签名化 → main（2026-09-21 批次）

> 回执对象：《NAS 下载链接签名化（HMAC 签名 URL + 权限复核 + 可吊销）· 交接清单》
> （归档于 `D:\DSH-07\docs-20260921-NAS签名URL/handoff-nas-signed-url-to-main.md`，定制轨 → main，2026-09-21）
> 结论：**全量采纳落地**（§4 落地顺序第 1–5 步全部完成；第 6 步放权推进为运营动作，按决策 ③ 默认形态上线）。

## 一、交付范围（对照交接清单 §4 落地顺序）

| 步骤 | 状态 | 落点 |
|---|---|---|
| 1. 独立长期密钥（决策 ①） | ✅ | `packages/plugin-nas/src/share-link.ts`：`nas-share-link-secret`（0600，首启生成、幂等不覆盖）；存在但不可读 → 故障态，签发/验签 fail-closed 响亮报错（`SHARE_LINK_KEY_UNAVAILABLE`），绝不静默换新；`POST /api/nas/authz/share-link-secret/rotate` 显式轮换，旧钥进**永久退役集合** `nas-share-link-secret-history.json`（决策 ① (a)）持续用于验签 |
| 2. `nas:shareLinks` 集合 + 档位策略 + 签发/清单/吊销端点 | ✅ | 集合 `durability: 'durable'`；策略载体=**方案 (a)** `AuthzRulesRecord.shareLinkPolicy`（与数据权限治理面同源）；`POST /api/nas/:id/fs/share-link`（nas.write）、`GET /api/nas/:id/fs/share-links`（nas.authz.read）、`POST …/share-links/:jti/revoke` 与 `…/share-links/revoke`（nas.authz.write，幂等/批量按人/按路径/all） |
| 3. 取流改造三关 | ✅ | `GET /api/nas/:id/fs/file` 新增 `?exp=&sub=&jti=&sig=` 分支：签名关（独立长期密钥，`exp=0` 永久）→ 吊销关（jti 记录存在且未吊销，nasId/path/sub 与载荷一致）→ 权限复核关（签发者身份实时 `nasAuthz.check op='download'`，deny → 403 且 `nas.authz.decision` 留痕，caller=`nas.share-link`）；成功后 `useCount/lastUsedAt` 画像更新 |
| 4. 前端有效期选择 + 链接管理 | ✅ | `nas.js`：「复制下载链接」弹有效期选择（1h / **24h 默认选中** / 7d / 30d / 永久；30 天与永久不预选；永久项按 `nas.authz.write` 权限与 `allowPermanent` 策略显因置灰，签发前二次确认）；文件浏览工具栏新增「链接管理」（nas.authz.read 显隐）：清单含状态/剩余有效期/使用计数/签发人 + 单条吊销；toast 读响应 `ttlLabel` 动态生成 |
| 5. 契约同步 + 发布说明 | ✅ | `scripts/gen-manifests.mjs` NAS 段 + `packages/plugin-nas/manifest/api.yaml` 同步（复用既有权限点，**未新增权限点/事件**；manifest 存在生成器滞后的既有漂移，本次仅增量手同步 NAS 段，未全量重生成以免回退他人契约文档）；发布说明见本文 §四 |
| 6. 放权推进（决策 ③，运营动作） | 按默认上线 | `allowPermanent=false` 上线（默认形态下不存在永久链接）；永久档先只对 `nas.authz.write` 持有者开放（开启策略后）；按 A0–A3 阶梯观测 30 天证据再加宽 |

## 二、决策落实对照（§0.0 三条拍板）

| 决策 | 落实 | 断言 |
|---|---|---|
| ① 独立长期密钥（泛化到全部档位） | share-link 全档位用独立密钥签名，与令牌密钥完全解耦；轮换后旧钥永久保留验签 | 轮换令牌密钥（`/api/authn/rotate-secret`）后未过期链接仍可取流；长期密钥 rotate 后旧链接仍可取流、新签发 `keyId` 更替 |
| ② 默认 24h；30 天/永久显式选择 | 缺省 `ttlSec=86400`；`ttlSec>maxTtlSec` → 400 `TTL_EXCEEDS_POLICY` 不回落；`permanent` 与 `ttlSec` 互斥 → 400 | selftest 断言全覆盖 |
| ③ A1 起步 | `allowPermanent` 默认 **false**（策略开关优先于权限点，关时即使 admin 也 403 `PERMANENT_DISABLED_BY_POLICY`）；开启后无 `nas.authz.write` → 403 `PERMANENT_REQUIRES_AUTHZ_WRITE`；机器身份签发一律拒绝（403 `MACHINE_ISSUANCE_UNSUPPORTED`，收紧而非放宽） | selftest 断言全覆盖 |

## 三、验收口径

- `npm run selftest`：**1199/1199** 全绿（fresh 隔离实例；本批次净增 16 项断言，见 selftest「签名分享链接」段：档位/策略/越权/互斥/签名篡改/过期/独立密钥隔离/长期密钥轮换/吊销即时/批量吊销/权限复核留痕/机器拒绝/永久吊销/策略回关；既有 `mode=once`/`mode=link` 6 条断言不回归）；
- `npm run lint:manifests`：**0 红**（契约比对 代码369/清单385，定时器卫生 0 违规）；
- 双目标部署：按 `D:\DSH-07\daily-sync-deploy.py` 例行双发（测试环境自动重启+健康检查；正式环境只传文件，重启单独安排）。

## 四、发布说明（对外口径）

**NAS 分享链接升级（2026-09-21）**：控制台「复制下载链接」由固定 10 分钟票据升级为**签名分享链接**——有效期可选（1 小时 / 24 小时默认 / 7 天 / 30 天 / 永久），链接重启不失效、可随时吊销；每次下载实时复核签发人数据权限（权限回收即失效），全程审计留痕。永久档默认关闭，开启与签发限管理员（`nas.authz.write`），独立签名密钥与令牌体系隔离，支持显式轮换且轮换不影响已发链接。

安全基线（继承清单 §3 评审要点）：默认档 24 小时；吊销体系为最终防线（按人/按路径批量吊销支撑离职场景）；密钥历史文件按凭证对待（0600、凭证扫描红线覆盖、备份与日志不得出现明文）；`useCount/lastUsedAt` 使用画像支撑异常发现。

## 五、诚实缺席声明（本批次不做，对齐清单非目标）

- DSM 原生 share link 对接、对外匿名分享、下载次数/水印等内容级管控（清单 §5 取舍说明）；
- 复核缓存（清单 §3.3：如出现热点再做 ≤60s 短 TTL，当前每次取流一次 `nasAuthz.check`，与大文件传输相比开销可忽略）；
- 重启存活断言的 fresh 实例形态（清单 §4 预留项）：重启存活由无状态签名设计保证（载荷全在 URL），selftest 未单独构造双进程断言；
- 永久档放权（决策 ③ 第 6 步）为运营动作，不在代码交付范围。

—— main 轨 ybkkasi · 2026-09-21 · NAS 签名链接批次
