# AGENTS.md —— 新会话/新开发者必读：本仓库工作方式与同步铁律

> 每个新会话（agent 窗口）、每位新开发者在做任何 git 操作前，先完整读完本文件。
> 本文件是定制化分支的**最高行为约束**，与 `PROJECT.md`（项目背景）配套；
> 冲突时以本文件为准。设计全文见 `docs/dev-plan-agent-host-unification.md`。
>
> **产品决策约束**：任何规划、排期、需求评审任务，先读 `docs/pm-outline.md`
> （《产品经理agent.md》精要纲要，含五问门禁/红线清单/协作 Agent 执行规程），按其思路完成。

## 这个仓库是什么（双轨模型）

`D:\DSH-RQ` 是围绕上游平台 `01men/ybkkasi`（元冰可 · 企业AI资源管理平台）的**定制化项目工作区**，
项目产权归属 **杭州元冰可科技有限公司**；全仓品牌口径为「元冰可」（英文 Yuanbingke），
不得残留更名前的中文旧称与旧仓库名（更名决策与规则见 `docs/rebrand-yuanbingke-20261014.md`）。
开发分支为 `custom/dsh-rq`。

自 2026-09 起实行**双轨开发模型**（定版文档：`docs/plan-dual-track-custom.md`）：

| 轨道 | 分支 | 职责 |
|---|---|---|
| **宿主轨** | 上游 `01men/ybkkasi` main | 宿主平台/控制台开发：platform-core、console、authn/oidc、agent、portal、iam、usage、skillhub、nas-authz、plugin-dsh-bridge（宿主桥）；API/事件**契约所有者** |
| **定制轨** | `custom/dsh-rq`（本分支） | **唯一交付物＝「01门」**（AI 代理与人类的协作前台，2026-09-10 定版）：@ybkk/gate-01 一键装进 dsh（6×dist 预构建产物，`/gate01` 挂载；2026-09-11 可用性补环 4→6：+iam/+authn 登录与身份面），包内随附 ops-platform-core/ops-iam/ops-authn/ops-dsh-bridge 基座 + ops-panel-core/ops-rq-card 定制面；产品定版 `docs/plan-gate01.md` |

宿主平台功能已于 2026-09 整体移植进上游 main（89074d9/80a65e3/ff1a8de，交接清单
`docs/handoff-host-features-to-main.md`）。此后：**控制台/宿主面的需求与缺陷一律去主分支做**，
定制分支只通过 merge 吸收，不再携带宿主面补丁。

## 仓库同步铁律（违反任何一条即为事故）

1. **本仓库唯一开发分支是 `custom/dsh-rq`**。本仓库的一切开发、提交都在它上面；
   不要在本地 `main` 上开发（本地 `main` 只是上游镜像，只快进、不开发）。
   宿主面的开发发生在**上游仓库自己的开发线**上，不在本仓库进行。
2. **本仓库对上游 git 层面只读**：只 `fetch`，绝不 `push`（pre-push 钩子硬拦截）。
   定制分支的改动需要回流上游时，**唯一通道是「交接清单文档」**：写 `docs/handoff-*-to-main.md`
   （模板：`docs/handoff-host-features-to-main.md`），由主分支侧 cherry-pick/重放落地。
   直接把定制代码推回上游 main = 主分支污染，仍是本项目最严重的事故。
3. **`01men/RQ-DSH` 是唯一推送目标（备份仓库）**：`custom/dsh-rq` 的全部提交（含合并提交）
   都要推送到它的 `main`。推送即备份，交付未推送 = 未交付。
4. **合并方向唯一**：同步永远是 `上游 main → custom/dsh-rq`（merge 进定制分支）。
   绝不存在整分支反向合并；定制→上游只允许铁律 2 的受控回流通道。
5. **冲突以主分支为准**：合并上游时，同一处双方都改过的代码，宿主面（见下方所有权表）
   以上游实现为准吸收；定制面（定制自有包 + F 域余量）必须保留。
6. **合并必须全量回归**：每次合并上游后跑 `npm run selftest`（当前 961+ 项）与
   `npm run lint:manifests`，全绿才能推送备份。
7. **插件装机不变量（fresh-install 铁律）**：每一次功能、面板更新，都必须保持在
   「**全新安装的 dsh** 上通过插件方式（`dsh plugin add`）安装、启动、完整体验本项目功能」
   成立。推送备份前的硬性义务：
   - rq-card 浏览器半（`src/client/**`、`src/wire.ts`、build.mjs、package.json）有任何改动，
     必须先 `node packages/plugin-rq-card/build.mjs` 重建 `lib/client.js`——selftest
     「fresh-install 装机模拟」段校验 build-id 指纹，忘重建即红；
   - 6 随附包（platform-core、plugin-iam、plugin-authn、plugin-dsh-bridge、plugin-panel-core、plugin-rq-card）的
     `src/**` 有任何改动，必须先 `npm run build:dist` 重建 `packages/*/dist/`（预构建产物
     提交入库，安装形态零 TS 装载，plan-gate01 G3 自解）——selftest 装机段校验
     `dist/.build-id` 指纹（scripts/dist-build-id.mjs），忘重建即红；
     上游 merge 碰到随附包 src 同理（见「标准同步节奏」）；
   - 面板静态资源/业务数据（public/、cardpacks/、scenegraphs）必须落在根 package.json
     `files` 覆盖范围内（`packages` 根之下），否则装机包缺文件、全新 dsh 上静默缺功能；
   - selftest「fresh-install 装机模拟」段（patch entry 逐个解析导入、cordis.patch.yml ↔
     cordis.yml ↔ boot-all 三链一致、bundle 新鲜度、dist 新鲜度、files 覆盖）必须全绿。

## 目录所有权（三区，双轨的边界线）

| 区 | 目录/文件 | 规则 |
|---|---|---|
| **宿主面**（主分支拥有并演进） | `packages/platform-core`、`packages/plugin-console`、`packages/plugin-authn`、`packages/plugin-agent`、`packages/plugin-audit`、`packages/plugin-portal`、`packages/plugin-iam`、`packages/plugin-usage`、`packages/plugin-skillhub`、`packages/plugin-app`、`packages/plugin-mcp`、`packages/plugin-nas`、`src/boot-all.ts`、`cordis.yml` | 定制分支**原则上禁止修改**；缺陷/需求走交接清单回流；合并冲突以 main 为准。**受控漂移例外**（plan-gate01 改名/收缩的必然后果，登记 docs/handoff-f-remainder-to-main.md I/J 节）：platform-core/src/version.ts:12 PLATFORM_PACKAGE 值、boot-all.ts 定制包 import 行（2 行）、cordis.yml 装配字段（externalBase/mountPath=/gate01、rq-card entry name）、plugin-dsh-bridge inject 收缩（8→3 键，运行期防御式访问已对齐） |
| **01门 装配（本分支拥有并演进）** | `cordis.patch.yml`（6×dist 产物装配）、根 `package.json`（@ybkk/gate-01，files 精确闭包）、`packages/*/dist/**`（预构建产物，随 src 变更经 `npm run build:dist` 重建） | 01门 产品装配，主分支不消费 |
| **定制面**（本分支拥有并演进） | `packages/plugin-panel-core`、`packages/plugin-rq-card`、`packages/plugin-dingtalk-bridge`、`scenegraphs/*.json` 业务数据 | 自由演进；主分支侧仅接收性维护 |
| **治理/文档**（本分支所有） | `AGENTS.md`、`PROJECT.md`、`scripts/hooks/`、`docs/handoff-*`、`docs/plan-*` | 本分支维护，主分支不消费 |

**修改纪律（北极星护栏）**：每次推送备份前跑一次收敛检查——

```bash
# 锚点=真上游 main 头（当前 6a19706＝M1-1 契约冻结 v1 齐套 + 安全/数据治理加固 + llms.txt 维护，2026-09-11；上游前进后更新锚点哈希）。
# 不用 origin/main 追踪引用——它在 push/fetch 之间摇摆（见下文「已知无害怪象」），自比较会假绿。
git diff 6a19706 custom/dsh-rq -- \
  packages/platform-core packages/plugin-console packages/plugin-portal \
  packages/plugin-authn packages/plugin-agent packages/plugin-audit packages/plugin-iam \
  packages/plugin-usage packages/plugin-skillhub packages/plugin-app \
  packages/plugin-mcp packages/plugin-nas packages/plugin-dsh-bridge \
  src/boot-all.ts README.md cordis.yml cordis.patch.yml
```

输出应趋于为空（F 域余量在 `docs/handoff-f-remainder-to-main.md` 闭环前允许存在，
但每一项都必须登记在该清单中并有明确归属：主分支采纳→merge 吸收；不采纳→定制侧拆除）。
当前已知非空项＝I/J 节登记的受控漂移（version.ts PLATFORM_PACKAGE、boot-all 定制包 import 2 行、
cordis.yml 装配字段、plugin-dsh-bridge inject 收缩 8→3 键），均为 plan-gate01 改名/收缩的
必然后果，语义上与 main 等价（全量形态行为不变）。

## 标准同步节奏（上游有更新时）

```bash
git fetch origin main                      # 拉上游（origin fetch 指向 ybkkasi）
git log --oneline custom/dsh-rq..origin/main   # 看上游新增了什么
git merge origin/main                      # 合并进定制分支（冲突按铁律 5 解决）
npm install                                # 依赖/包名若有变化先同步（workspace 包改名等）
npm run build:dist                         # 上游 merge 碰随附包 src 即令 dist 过期——重建预构建产物
node packages/plugin-rq-card/build.mjs     # 上游 merge 碰浏览器半 src/wire.ts 同理——重建 lib/client.js
npm run selftest && npm run lint:manifests # 全量回归，必须全绿
git push                                   # 备份（origin push 指向 RQ-DSH，自动推到其 main）
```

## 远程配置（已固化，不要改动）

```
origin  fetch → https://github.com/01men/ybkkasi.git   # 上游，只进不出
origin  push  → https://github.com/01men/RQ-DSH.git      # 备份，push 即备份到其 main
```

- 默认 `git push` 经 `remote.origin.push = refs/heads/custom/dsh-rq:refs/heads/main`
  自动把定制分支推到 RQ-DSH 的 main——不要改这个 refspec。
- 已知无害怪象：`origin/main` 追踪引用在「push 后=备份仓库的 main」与「fetch 后=上游 main」
  之间摇摆（fetch/push 分离的副作用）。判断同步状态永远以 `git ls-remote` 两仓库实测为准。
- 本地已装 `.git/hooks/pre-push` 钩子（脚本版本化在 `scripts/hooks/pre-push`）：
  任何指向 ybkkasi 的推送会被**直接拦截**。换机器/重克隆后需重装：
  `cp scripts/hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push`

## 网络说明

本机访问 GitHub 需走本地代理 `127.0.0.1:7890`，已配置 git 仅对 github.com 生效：

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:7890
```
