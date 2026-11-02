# 贡献指南

感谢关注元冰可（ybkkasi）。本文面向想给平台贡献代码或插件的开发者。

## 环境要求

- **Node ≥ 22.6**（原生 TypeScript 运行，无构建步骤；`node:sqlite` 为内置能力）
- `npm install`（workspace 安装全部 packages）

已验证版本：**v24.21.0 与 v22.14.0 实测全绿**（selftest + 全部 lint 门禁，CI 双版本轨）。
`engines` 的 `>=22.6` 是「零构建、原生跑 TypeScript」硬约束给出的声明，建议贡献者用
**v22.14+ 或 v24** 等实测过的版本线。`node:sqlite` 在 Node 22 / 24 下仍打印 Experimental
警告，属上游正常状态，无害。

> **Node 22.6–22.17 注意**：这些版本的 TypeScript 类型剥离尚未默认开启（22.18 / 23.6 起才默认）。
> 仓库的 npm 脚本（`start` / `lint:manifests` / `lint:boot-order` / `test:contracts`）已内联
> `--experimental-strip-types`，`npm run selftest` 会检测版本并以 `NODE_OPTIONS` 带 flag 自动重启
> （子进程一并继承）。只有绕开脚本直接 `node <file>.ts` / `node <直接装载 .ts 的脚本>.mjs` 时
> 才需要自己加 flag：`NODE_OPTIONS=--experimental-strip-types node …`。该 flag 在 Node ≥ 22.18 上是
> 静默 no-op，脚本里保留它不影响新版本。

## 开发闭环

```bash
npm start                       # 独立宿主启动 → http://127.0.0.1:7300
DEMO_SEED=1 npm start           # 注入演示数据
npm run selftest                # 端到端断言（隔离实例，全绿才算完成）
npm run lint:manifests          # 插件清单五面 YAML 校验
npm run lint:boot-order         # 插件装配顺序门禁
npm run lint:cjk                # 中文文案 i18n 覆盖门禁
node scripts/storage-bench.mjs  # 存储后端基准（改存储相关代码后建议跑）
```

CI（`.github/workflows/quality-gate.yml`）在每次 push / PR 于 Node 22.14 与 24 双版本轨跑契约 lint + 全量自测 + P95 闸门。
**selftest 不全绿、lint 有错的 PR 不予合并。**

## 改动约束（架构不变量）

1. **一切皆插件**：新业务域 = 新插件包（`packages/plugin-*`），声明自己的权限点/事件/路由；
   不改基础层就别动 `platform-core`。
2. **协作铁律**：状态变更必发事件；跨插件联动只走事件总线或扩展点，禁止直连对方集合。
3. **存储**：业务数据一律走 `Collection<T>`（`ctx.opsStorage`），不绕过存储层直读写文件；
   计量/资金类流水走 `ctx.txnStore`。
4. **协议键**：对外协议键保持 ASCII 不改写；面向用户的文案走 `t()` 并补齐 en/ja 词典。
5. **诚实边界**：降级/演示能力必须显式标注，绝不静默充数。
6. **权限**：每个 REST 端点与 MCP 工具声明最小权限 permission；新增权限点同步更新 manifest。

## 提交规范

Conventional Commits，中文正文，格式参考现有历史：

```
feat(mcp,console): 简述能力增量——关键行为/动机/验收口径
fix(iam,authn): 简述缺陷与根因——修复方式/影响面
docs(architecture): 文档批次说明
```

## 文档

- 对外文档放 `docs/` 根（README / 架构 / 部署与接入指南 / 契约）；改动对外行为时同步更新。
- 过程物料（QA 报告、交接单、批次计划）放 `docs/internal/`，不进对外文档。
- 架构相关决策写 ADR（`docs/adr-*.md`），状态与落地记录保持同步。
