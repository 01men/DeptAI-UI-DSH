# 发布说明 · 2026-09-16 M2 迭代（FinOps 报告 v1 + 平台级筑基）

> 对应《元冰可-开发迭代详细规划》**M2 · 部署产品化 + FinOps 报告 v1**（S1–S2）。
> 交付批次：`366cd92`（主批次）+ `2b9d21b`（GUI 演练修复）。

## 一、主线功能

### 1. FinOps 报告 v1：成本穿透 + 空转检测（CFO 视图）

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/finops/overview?month=YYYY-MM&window=分钟` | usage.read | 一次取全：成本穿透 + 空转检测 |
| `GET /api/finops/idle?month=YYYY-MM&window=分钟` | usage.read | 空转检测独立查询（窗口可调，1–1440 分钟） |
| `GET /api/finops/report/monthly?month=YYYY-MM[&format=csv]` | usage.read | CFO 成本报表；CSV 为 Excel 友好 UTF-8 BOM |

- **成本穿透**（`UsageService.costPenetration()`）：月度窗口内部门（org）×模型（model）成本交叉矩阵（Top8×Top8 + 「其他」行列，**总计恒等于 model 域全口径成本**）、上月环比（prev=0 且 cur>0 时 delta_pct=null，不硬造百分比）、Top 10 消耗主体、部门行 Top3 模型拆分。金额口径与 J4 一致：内部成本参考（cost_cents），charge_cents 零价快照恒 0。
- **空转检测 v1**（`UsageService.idleAnalysis()`）：规划口径的近似实现——「模型调用后 N 分钟（默认 30）内同一主体无任何非模型资源动作、且无同 trace_id 关联动作」计为疑似空转。输出空转事件/成本/tokens、按模型与部门拆分、最近 20 条样本供人工复核。**已知误报（纯对话）已在页面显式标注「近似口径、需人工复核、不作为考核依据」；精确口径待 M4 证据引擎的 task_success/task_fail 结果回传替换。**
- **SPA「财务视图」页**（`#/finops`，治理与运营分区，usage.read 可见）：指标卡（本月成本+环比/计量事件/空转成本/参与维度）、部门穿透表、模型成本排行、交叉热力矩阵、空转复核样本折叠表、一键 CSV 导出、月份切换、友好空态。

### 2. 首启体验（部署产品化）

- 首启种子登记 `platform:bootstrap` 集合（mode/orgName/seededAt/初始口令文件路径，幂等只记首次）。
- 新端点：`GET /api/platform/bootstrap`（公开，仅回 `initialPasswordPending` 一个布尔，登录页部署提示用）；`GET /api/platform/bootstrap/detail`（authenticated；存量库返回 `mode:'legacy'`，不与空库混淆）。
- 首启日志输出「上线三步走」引导框；登录页在初始口令文件未删时显示黄色接管提示横幅（改密+删文件后自动消失）。
- `docs/deploy-enterprise.md` 升级为**可执行 checklist**（步骤 0–5，每步带验证命令与预期输出）。

## 二、技术债收尾

| 编号 | 内容 | 落点 |
|---|---|---|
| T5 | Ed25519 签名基建抽升平台（`platform-core/src/signature.ts`：verifyEd25519/signEd25519/generateEd25519KeyPair/isValidEd25519PublicKeyBase64），market 以市场语境别名 re-export（dshctl 等外部引用零改动） | 发布清单签名工具 `scripts/release-manifest.mjs`（生成密钥对/签清单/校验/防篡改）；plugin-update 增 `releasePublicKey`/`requireSignedManifests` 设置（写入口格式校验、未登记公钥禁止开启强制的防呆）、`applyUpdate` 按 pin 目标 commit 拉取 release-manifest.json 验签；status 透出 `releaseKeyConfigured` |
| T2 | plugin-audit 订阅 `connect.degraded` 落审计（type=change/result=error）——降级显式留痕，接线半程收口 | plugin-audit/src/index.ts |
| T6 | precheckCents/计费预检集成面残留清零（dshctl 用法、connector-integration.md 示例、connector 工具描述、risk.ts ADMIN_SCOPE 词根）；selftest 加防复发扫描断言 | 见 git diff |

## 三、契约变更登记（additive-only）

- plugin-console/manifest/api.yaml：新增 `/api/finops/overview|idle|report/monthly`、`/api/platform/bootstrap[/detail]` 六行端点摘要。
- plugin-console/manifest/ui.yaml：`#/finops` 路由 + 「财务视图」菜单项。
- plugin-usage：新增 `FinOpsCostPenetration`/`FinOpsDimRow`/`FinOpsIdleAnalysis` 类型与两个 Service 方法（schema v1 未动，additive）。
- plugin-update：`UpdateStateRecord` 增两个可选字段（additive）；`/api/update/settings` 接受新字段。
- PUBLIC_PATHS 增 `/api/platform/bootstrap`（只回布尔，泄露评估见 routes/platform.ts 头注）。

## 四、质量门

- **selftest：1173/1173 全绿，断言净增 41（1126→1167，≥40 达标）**。新增断言组：FinOps 穿透/空转（19）、bootstrap（4）、T2 接线（2）、T6 防复发（3）、T5 验签（12，含 CLI e2e 与进程内三路径验签）。
- **lint:manifests 契约比对 0 红**（路由 360/清单 376 · 工具 83/83 · 9 警 8 豁免均为既有项）。
- **测试环境真实演练**（http://mdzx.fun:8801）：
  - API 轨 `qa-systematic-test/scripts/m2-fullclass-drill.mjs`：**41/41 通过**——六类资产（模型路由/MCP/Skill/Agent/AI应用/NAS）真实登记（含 attrs 治理属性）、六类计量回传、FinOps 三端点真实数据、CSV 字节级 BOM 验证、T5 验签设置（公钥登记/防呆/强制开关）、审计链留痕。脚本对真实环境字段口径的三轮修正（attrs 结构、modelgw 自动播种价格簿的 output_tokens 计量键、fetch 剥 BOM）本身就是对平台字段级防呆的验证。
  - GUI 黑盒走查（browser-use）：登录页→工作台→财务视图（数据渲染/月份切换/空态文案/CSV 按钮）→资产运营→Agent/MCP/NAS 页→资产登记分诊页，全部正常；发现并修复穿透表「主要模型」列长标识断行（`2b9d21b`）。
  - 演练资产已清理 13 个；残留 6 个 draft 态 MCP 与 6 张 m2drill 待审批 Skill 单（状态机防呆正确拒绝 API 直删，留测试环境人工处理）。

## 五、排障实证（三起，已修复并写入代码注释）

1. **market re-export 别名不创建模块内绑定**：`export { verifyEd25519 as verifySignature }` 后模块内调用 `verifySignature(...)` 是 ReferenceError——内部调用点全部改用新名。
2. **catch 引用 try 内 const 的 TDZ**：`seedOfficialPlugins` 的 catch 用了 try 内定义的 `ctx`，种子一旦抛错即二次 ReferenceError 并升级为 MarketService 构造失败 → console 的 inject `market` 缺失 → **cordis 静默挂起 console（0ms、零日志）**，实例 `/api/health` 404。修复：`const ctx = market.ctx` 提到 try 外。
3. **非 guarded 路由只 return 不写响应**：`/api/platform/bootstrap/detail` 初版 handler return 对象未调 `exchange.ok`，连接永久挂起。修复并在 routes/platform.ts 头注写明规则。

## 六、升级与回滚

- 升级：`dshctl update apply --pin=<tag/commit> --reason="M2 FinOps v1"` → 重启进程。可选供应链加固：`node scripts/release-manifest.mjs --generate-key` → 公钥登记 `/api/update/settings` → 按需开启 `requireSignedManifests`。
- 回滚：`POST /api/update/rollback`（需 apply 登记的快照）或 git reset 到 `366cd92~1`。
- 兼容性：全部变更 additive；无 schema v1 变更、无破坏性端点变更；存量库升级后 bootstrap detail 返回 `mode:'legacy'` 属预期。
