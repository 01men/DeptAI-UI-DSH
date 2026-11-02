# ADR-0001:存储层从 JSON 集合迁移到事务型数据库

|         |                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------ |
| **状态**  | **Accepted（第一期 SQLite 集合后端已于 2026-10-16 落地，见 §十 落地记录）**                          |
| **日期**  | 2026-10-16（提出）· 2026-10-16（第一期交付）                                                              |
| **决策人** | 平台架构组                                                                                            |
| **相关**  | `packages/platform-core/src/storage.ts` · `packages/platform-core/src/storage-sqlite.ts` · README「诚实边界」节 |

---

## 一、背景

平台当前的双层存储:

- **业务配置**——50 个 JSON 集合,全量驻内存 `Map`,250ms 防抖原子落盘(`storage.ts`)
- **计量与事务**——SQLite(`data/txnstore.db`),WAL + `synchronous=FULL` + `BEGIN IMMEDIATE`

`storage.ts` 的文件头注释写着:「替换为数据库实现时只需重写本服务」。

**本文的结论是:这句话成立,而且迁移风险比预期低得多。** 下面给出依据和分批方案。

---

## 二、现状实测

以 v1.1.0 演示实例(`DEMO_SEED=1`)实测:

| 指标              | 实测值                        | 含义                    |
| --------------- | -------------------------- | --------------------- |
| JSON 集合数        | 50+                        | 迁移的工作面                |
| SQLite 表数       | 16                         | **迁移模板已经存在**          |
| 最大集合            | 720 条(`mcp:calls`)         | 当前**容量完全不是瓶颈**        |
| `uniqueOn()` 声明 | 30 处                       | 需映射为 SQL UNIQUE INDEX |
| `onChange()` 订阅 | **1 处**(仅 `authn:tokens`)  | 响应式耦合极低——迁移最大风险点几乎不存在 |
| 运行时依赖           | 1 个(`@deepseek-ai/cordis`) | 加 DB 驱动是第一个真实运行时依赖    |

### 问题不是容量,是三个结构性上限

1. **无高可用**——单进程,单写者。进程挂掉即全站不可用。
2. **内存线性增长**——全量业务数据常驻 `Map`。1000 人企业 + 完整调用流水,常驻内存不可接受。
3. **无法水平扩展**——每个实例持有自己的内存副本,多副本必然数据发散。

这三条决定了:**当前形态可以做 POC、做试点、做单团队私有化;做不了企业级多节点部署。**
而「企业级私有化」正是本项目的商业定位。

---

## 三、关键洞察:这个迁移已经被做过两次

`packages/platform-core/src/sqlite.ts` 已经是一个**可用的存储抽象**,不是裸 SQL:

```ts
class SqliteTxnService extends Service {
  // PRAGMA journal_mode = WAL / synchronous = FULL / foreign_keys = ON
  ensureTable(name, columns, { primaryKey?, uniques?, indexes? })   // DDL
  transaction(fn)   // BEGIN IMMEDIATE —— 立即取写锁,避免升级死锁
}
```

已用它承载的域:

- `workforce_*` —— **16 张表**(employee / appointment / permit / invocation / artifact / usage_links / outbox …)
- `usage_*` —— `usage_events` · `usage_consumptions`
- `exec_run_leases` · `behavior_events` · `behavior_consumptions`

**结论:不需要引入新范式,需要的是把 workforce 域验证过的模式,推广到剩下 50 个集合。**
这是本 ADR 最重要的判断——它把「架构改造」降级成了「批量应用既有模式」。

---

## 四、决策

### 4.1 接口零变更(硬约束)

`storage.ts` 已定义的 `Collection<T>` 接口是天然的接缝,**迁移期间必须保持不变**:

```ts
interface Collection<T> {
  all() / get(id) / find(pred) / findOne(pred)
  insert(data) / update(id, patch) / remove(id) / replaceAll(records)
  count()
  onChange(cb): () => void
  uniqueOn(label, keyOf)          // → CREATE UNIQUE INDEX
}
```

**所有 27 个插件的代码一行不改。** 任何需要改插件的迁移方案一律否决。

### 4.2 后端可插拔

```
StorageService
  ├── CollectionImpl            (json,默认——内存 Map + 防抖原子落盘,原实现)
  └── SqliteCollectionImpl      (sqlite,企业单节点推荐——写入即事务)
        └── PostgresCollectionImpl (可选,多节点 / HA,二期)
```

通过 `PLATFORM_STORAGE=json|sqlite` 切换,默认 `json` 保证向后兼容。
`StorageConfig` 增加 `backend?` 字段;未显式配置时读环境变量(独立宿主与 dsh 宿主两种形态通用)。

### 4.3 为什么先做 SQLite 而不是直接上 Postgres

|                | SQLite(node:sqlite) | PostgreSQL     |
| -------------- | ------------------- | -------------- |
| 运维成本           | 零,内置于 Node 22.5+    | 独立服务 + 高可用配置   |
| 与现有代码同底座       | ✅ `sqlite.ts` 已在用   | ❌ 需换驱动与 SQL 方言 |
| 单节点企业(≤5000 人) | 足够                  | 足够             |
| 多节点 / HA       | ❌                   | ✅              |

**建议:先做 SQLite 后端。** 它能解掉「内存线性增长」和「数据完整性」两个真问题,
且复用已验证的底座,零新依赖。多节点 HA 作为可选 Postgres 后端二期交付。

> ⚠️ 注意:`node:sqlite` 在 Node 22/24 仍是 Experimental 警告。当前单进程使用无碍,
> 但**跨 Node 大版本升级时需重新验证**。若对此敏感,改用 `better-sqlite3`(引入第一个原生依赖)。

### 4.4 事务边界的诚实说明

`Collection.insert()` / `update()` 是**单记录原子操作**,不是跨集合事务。
迁移到 SQL 后:

- ✅ 单记录写 → 真正的 DB 事务
- ⚠️ 跨集合/跨表的复合操作(如「创建服务 + 写数据范围 + 记审计」)仍需显式 `transaction()` 包裹

**这不会比现状更差**——现状连单文件写都是防抖的,复合操作存在更宽的窗口。
但要在迁移后**逐个插件审计复合写路径**,这是迁移工作量的大头,不是存储层本身。

---

## 五、分批迁移

按「增长性 × 一致性敏感度」排序,分三批:

### 第 1 批:写入密集型(优先,增长最快)

| 集合                                            | 理由                   |
| --------------------------------------------- | -------------------- |
| `audit:logs` · `audit:costs` · `audit:alerts` | 持续追加,无界增长            |
| `mcp:calls`                                   | 单次调用一条,最高写入频         |
| `agent:usage` · `app:usage`                   | 计量投影,持续追加            |
| `panel:messages` · `panel:tasks`              | 会话与任务,高频写            |
| `usage:projection~*`                          | 已有 SQLite 同源数据,迁顺理成章 |

**验收:压测串行 10k 写入下 P99 < 50ms,内存占用不随写入线性增长。**
（口径 2026-10-16 批次正式修订:「10k 并发写入」改为「串行 10k 写」——`node:sqlite` 是同步 API、
单进程单写者,并发写在本后端形态下会被序列化,不构成可真并发的口径;也不做多进程压测重写 bench,
因为「单进程单写者」本就是 SQLite 形态的部署上限,多进程扩展属 Postgres 二期范畴。）

### 第 2 批:治理型(一致性敏感,需谨慎)

`iam:users` · `iam:orgs` · `iam:identityLinks` · `authn:tokens` · `authn:principals`

- `iam:identityLinks` 有 `uniqueOn(provider + providerUserId)`——
  这是「一人一号」红线的执行点,**必须落为真正的 UNIQUE INDEX**,不能退回应用层检查
- `authn:tokens` 是唯一使用 `onChange()` 的集合,也是唯一用 `durability: 'durable'` 的集合。
  迁移后其事件语义需保持:吊销事件必须可靠广播

**验收:selftest 中 auth-identity 全批次攻击演练(state/code/refresh 重放、一人一号)全绿。**

### 第 3 批:低频配置型(默认保留 JSON)

`resource:dependencies` · `update:state` · `oidc-keys` · `market~*` · `platform:bootstrap`
· 各插件的 `migrations` / `snapshot` 集合

这批读多写少、体积小,**保留 JSON 完全合理**。不建议为「一致性」统一迁——那是没有收益的工程债。

> **落地修订(2026-10-16 W4 批次)**:本批不是「建议保留」,而是 sqlite 后端下的**默认行为**——
> `PLATFORM_STORAGE_JSON_KEEP` 未设置时,内置默认名单 `DEFAULT_JSON_KEEP`
> (`packages/platform-core/src/storage.ts` 导出常量,与本文同名可查)自动生效,覆盖上述集合
> (代码内集合名用 `:`、文件名转义为 `~`;名单按注册点真实集合名书写:
> `resource:dependencies` · `update:state` · `oidc-keys` · `market:*` · `platform:bootstrap`
> · `agent:migrations` · `app:migrations` · `iam:migrations` · `iam:groupSnapshots`)。
> 环境变量显式设置时完全覆盖默认名单(显式给空串 = 一个都不豁免)。

---

## 六、迁移执行方式:双写 → 回填 → 切换

单集合粒度推进,每批独立可回滚:

```
1. 双写   JSON 集合 + SQL 表同时写,JSON 仍为准(read path 不变)
2. 回填   启动时把 JSON 全量导入 SQL,校验条数与关键字段哈希
3. 影子读 读路径切到 SQL,JSON 保留只读副本,观察 N 天
4. 切换   读路径指向 SQL,JSON 转只读(保留 30 天作为回滚源)
5. 清理   观察期结束后移除该集合的 JSON 写路径
```

**~~每批独立开关~~**:`~~PLATFORM_STORAGE_MIGRATED=iam,mcp,audit,usage~~`
~~可任意组合,出问题把某个名字从列表去掉即刻回退到 JSON。~~

> **已废止(2026-10-16 W4 批次)**:`PLATFORM_STORAGE_MIGRATED` 零实现,且实际落地路径
> (整后端切换 + 原子回填,见 §十偏差说明)不需要逐集合开关。回滚诉求由既有机制覆盖:
> **后端级开关**(`PLATFORM_STORAGE=json|sqlite`)+ **JSON_KEEP 豁免名单**(`DEFAULT_JSON_KEEP`
> 默认名单 + 环境变量完全覆盖)——任一批集合出问题,把集合名加进
> `PLATFORM_STORAGE_JSON_KEEP` 重启即回退 JSON,无需新增开关面。

---

## 七、风险与回滚

| 风险                       | 缓解                                             |
| ------------------------ | ---------------------------------------------- |
| 复合写路径遗漏事务                | 逐插件审计;迁移期 JSON 双写作为事实上的兜底                      |
| `onChange` 事件丢失          | 全项目仅 1 处,且已在第 2 批单独验收                          |
| `uniqueOn` 语义漂移          | 30 处逐一对应 UNIQUE INDEX,selftest 已覆盖「并发下不产生重复」断言 |
| node:sqlite Experimental | 锁定 Node 版本;提供 `better-sqlite3` 备选实现            |
| 迁移期双写不一致                 | 影子读期设对账任务,每日比对两边条数与内容哈希                        |

**回滚**:任一批集合出问题,把集合名(或其 `前缀:*` 模式)加入 `PLATFORM_STORAGE_JSON_KEEP`
重启即回到 JSON 路径(未设置环境变量时 `DEFAULT_JSON_KEEP` 默认名单持续兜底,
见 §五第 3 批落地修订;`PLATFORM_STORAGE_MIGRATED` 逐批开关已废止,见 §六)。
第 5 步(清理)之前,JSON 文件始终是完整可用的回滚源。

---

## 八、验收标准(全部可自动化)

- [x] `npm run selftest` **1467 项全绿**(含 IAM 攻击演练、计量幂等、执行锁 CAS;2026-10-16 实测)
- [x] `uniqueOn` 全部映射为真实 UNIQUE 索引(`collection_uniques` 引擎级主键),
      且 selftest 断言「绕过先查后插的重复键写入被引擎拒绝」「update 抢键被拒」
- [x] 10k 写入压测:P99 < 50ms(**实测 P99 = 0.077ms**,NVMe 本地盘;
      `scripts/storage-bench.mjs` 可复跑),常驻内存不随写入量线性增长(压测期 RSS 平稳)。
      口径 2026-10-16 W4 批次修订为**串行 10k 写**(node:sqlite 同步 API、单进程单写者,
      「并发写入」不可真并发,见 §五第 1 批口径修订;bench 不重写为多进程)
- [x] 进程 `kill -9` 后重启数据零丢失(`synchronous=FULL` 验证——selftest 平台级子实例断言:
      崩溃前创建的账号可登录、回填数据完整)
- [x] 全部业务插件代码零改动(存储迁移相关 diff 仅 `platform-core`;`plugin-console` 的
      改动属文档重组联动,与存储无关)
- [ ] ~~双写对账任务连续 7 天零差异~~ → 见 §十 偏差说明(双写阶段被原子回填替代,该项不适用)

---

## 九、不做什么

- ❌ 不改 `Collection<T>` 接口
- ❌ 不引入 ORM——当前 DDL 需求简单,单表 JSON 文档 + 唯一键表够用,ORM 是净增负担
- ❌ 不强行把低频配置集合迁到 DB(`PLATFORM_STORAGE_JSON_KEEP` 提供例外名单机制)
- ❌ 不在本次同时做水平扩展——那是数据库选型确定之后的下一阶段(Postgres 后端,二期)

---

## 十、落地记录(2026-10-16 第一期交付)

### 交付物

| 组件 | 说明 |
| --- | --- |
| `packages/platform-core/src/storage-sqlite.ts` | `SqliteCollectionBackend` + `SqliteCollectionImpl`:与 JSON 版严格同一 `Collection<T>` 契约。单表 `collection_docs(name,id,doc)` + 唯一键表 `collection_uniques(name,label,key,id)` + 元数据表 `collection_meta`;每次写入独立事务(WAL + `synchronous=FULL`);`onChange` 在事务提交后触发 |
| `storage.ts` 改造 | `StorageConfig.backend` + `PLATFORM_STORAGE` / `PLATFORM_STORAGE_JSON_KEEP` 环境变量;`restore()`/`restoreAll()` 双后端分支;`flushNow`/`flushDurable` 跳过 sqlite 集合(写入即事务,无防抖窗口) |
| `scripts/storage-bench.mjs` | 双后端基准(写入吞吐/P50/P95/P99/max、点读、全表扫描、RSS) |
| `scripts/storage-export.mjs` | SQLite → JSON 导出(回滚工具;旧回滚源先挪开绝不无痕覆盖) |
| selftest 新节「存储 SQLite 后端契约(ADR-0001)」 | 23 项断言:双后端同序列对拍(含错误文案逐字一致)、引擎级唯一、回填幂等/DB 为准/回滚源保留、环境开关、平台级 kill -9 零丢失;W4 批次追加 11 项(默认 JSON_KEEP 名单 + iam 一人一号 sqlite 攻击演练,见下方收尾修订),合计 34 项 |

### 与 §六 的偏差:双写阶段被「原子回填」替代(有意决策)

§六 原方案按集合粒度双写→影子读→切换,服务于「生产环境不停车迁移」。
第一期交付选择更简单且同样安全的路径:

- **切换以整个后端为单位**(`PLATFORM_STORAGE=sqlite`),而非逐集合;
- **首启自动回填**:某集合首次在 sqlite 后端下 restore 时,若 DB 无记录且存在同名
  JSON 文件,则在**单个事务内**整表导入并标记 `collection_meta.backfilled_at`——
  崩溃要么发生在事务前(下次启动重试)、要么发生在事务后(数据已在 DB),不存在「半套数据」;
- **JSON 文件永不删除/改写**,天然成为回滚源;回退 = `storage-export.mjs` 导出最新数据
  + 去掉环境变量重启;
- 因此「影子读 7 天对账」不再需要,§八对应验收项不适用。

风险收益判断:本项目当前全部部署形态为单进程单写者,「不停车」要求不存在;
原子回填把双写对账的长期运维成本换成了首启一次性的确定性操作。多节点 HA(二期)
上线时再引入真正的在线迁移流程。

### 遗留与二期

- Postgres 集合后端(多节点 HA)——`SqliteCollectionBackend` 的接口面已按可替换设计;
- 复合写路径的事务包裹审计(§4.4)——JSON 双写兜底已不存在,列为二期专项;
- `node:sqlite` 跨 Node 大版本升级验证项(每次升级 Node 跑 `npm run selftest` + `storage-bench`)。

### W4 收尾修订(2026-10-16 QA 验收批次)

第一期落地后 QA 复核出五个缺口,本轮全部收口,按「双侧回写」原则代码与本文同步修订:

1. **默认 JSON_KEEP 名单(缺口①)**:§五第 3 批原只是「建议保留 JSON」,代码却默认把
   低频配置集合也迁入 sqlite,与结论相悖。修复:`storage.ts` 导出 `DEFAULT_JSON_KEEP`
   (内容见 §五第 3 批落地修订,按全仓注册点真实集合名核对),`PLATFORM_STORAGE_JSON_KEEP`
   未设置时自动生效;显式设置(含空串)完全覆盖默认。
2. **回填对账断言(缺口②)**:首启 JSON→SQL 回填在**导入事务内、标记 `backfilled_at` 前**
   增加对账——逐集合比较 JSON 源条数与 SQL 落库条数 + 每条记录按「键递归排序的规范化
   序列化」算 SHA-256 哈希逐条比对(`storage.ts` `assertBackfillParity`);不一致即抛错,
   错误消息含集合名与差异数,整个回填事务回滚(导入与标记一并撤销),下次启动重试并再次
   响亮失败——带病数据永远不会拿到 `backfilled_at` 标记,崩溃安全语义不变。
3. **sqlite 后端 iam 一人一号攻击演练(缺口③)**:selftest「存储 SQLite 后端契约」节内新增
   子块,进程内以 sqlite 后端装配 platform-core + iam + authn,演练:同
   `provider+providerUserId+corpId` 二次绑定被引擎拒绝、同 tick `Promise.all` 连发 6 次重复
   插入恰一条成功(其余被真实 UNIQUE INDEX 拒绝)、绕过服务层直插集合同键记录被拒、
   跨 corpId 放行(唯一键含 corpId 维度)、authn refresh 轮转经 onChange 维护 refreshIndex、
   吊销广播(带 `revokedAt` 的 update 事件)在 sqlite 事务提交后仍逐条送达且 refresh 即刻失效。
4. **压测口径正式改口径(缺口④)**:「10k 并发写入 P99<50ms」→「串行 10k 写 P99<50ms」
   (理由见 §五第 1 批口径修订;`scripts/storage-bench.mjs` 文案同步,bench 不重写为多进程)。
5. **`PLATFORM_STORAGE_MIGRATED` 正式废止(缺口⑤)**:代码零实现,且后端级开关 +
   JSON_KEEP 豁免名单已覆盖回滚诉求(见 §六废止注记、§七回滚修订),不补实现。
