# 01门 npm 发布手册（@ybkk/gate-01 双通道之 npm 通道）

> 前置状态（2026-09-10 已就绪）：安装产物为预构建 dist（G3 自解）、零生命周期脚本、
> rq-card 经 bundledDependencies 随包自包含（file: 依赖在 npm/tgz 通道不可移植，真机实证）。
> github 通道（`dsh plugin add github:01men/RQ-DSH`）不依赖 npm，已随仓库推送天然可用。

## 发布记录

| 版本 | 日期 | 通道 | 备注 |
|---|---|---|---|
| @ybkk/gate-01@1.2.1 | 2026-09-14 | npm（latest） | 补齐 1.2.0 后演进（钉钉设备流登录面 ddws 等 15 文件）+ T-04 无群桥回执竞态修复（dws 前置校验前移 + 终态轮询） |
| @ybkk/gate-01@1.2.0 | 2026-09-11 | npm（latest） | 常规发布 |
| @ybkk/gate-01@1.1.1 | 2026-09-10 | npm（latest） | 首个可用版本：幂等演示播种修复 + @ybkk scope 定版（npm org `01men` 已被占用，用户创建 `ybkk`） |
| @ybkk/gate-01@1.1.0 | 2026-09-10 | npm | **已 deprecated**（演示播种缺陷，消息指向 1.1.1）——不要安装 |

发布流程实证（2026-09-10）：`npm login` → `npm publish --access public` 触发 **web 浏览器认证**
（npm 2026 政策：发布必须本人 2FA 浏览器确认，Enter 开链接 → Authorize → 终端自动继续；
granular token 绕行方案已被 npm 限制，不再可用）。npm org 占用名检查：`npm view <name>` 404
仅说明未发布过，org 占用需在 npmjs.com/org/create 实测。

## 用户侧配合（仅 2 步，涉及凭据必须本人操作）

1. **npm 组织**：在 npmjs.com 确认/创建 org **`01men`**（名称必须与包 scope 完全一致，免费 plan 即可），
   并将发布用账号设为 org 成员（owner）。若不想用 `@01men` scope，先告知开发侧改包名再发布。
2. **登录官方源**（本机 npm 默认指向 npmmirror 淘宝镜像，publish 必须走官方源）：

   ```bash
   npm login --registry=https://registry.npmjs.org/
   ```

   浏览器交互完成（可能触发 2FA/OTP）。
   备选：npmjs.com → Access Tokens → 生成 Granular Token（仅勾选 `@01men` 包 read-write、
   有效期设短），交付开发侧用于发布，**发布完成后立即撤销**。

## 开发侧执行（收到「登录完成」后）

```bash
# 1. 允许发布（根 package.json private:true → false），提交推送
# 2. 最终校验
npm run build:dist && npm run selftest && npm pack
# 3. 发布（scope 包必须显式 --access public）
npm publish --access public --registry=https://registry.npmjs.org/
# 4. 发布验证
npm view @ybkk/gate-01 version
# 5. 真机冒烟（四通道之 npm 通道闭环）
dsh plugin add --profile <全新profile> @ybkk/gate-01
# 6. 发布记录回填本手册 + 推送交付
```

## 自动化发布（2026-09-11 定版）

`npm run release`（scripts/release.mjs）一条命令完成上面「开发侧执行」全流程并自动回填本手册：

```
git 护栏（custom/dsh-rq + 干净树）→ npmjs 登录校验（失效自动拉起 npm login 浏览器 2FA）
→ 版本决策（树版本 > npm latest 直接复用；相等自动 patch；patch/minor/major/--version 可覆盖）
→ build:dist + 浏览器半重建 → lint:manifests + selftest → npm pack 校验
→ npm publish（官方源，--access public）→ npm view 验证 → 发布记录回填
→ 提交 + 推送交付（铁律 3）
```

演练：`npm run release -- --dry-run --skip-tests`。发布中断重跑即续（版本决策幂等；
publish 失败自动回滚版本落盘）。真机冒烟仍需人工执行（§开发侧执行 5）。

## 注意事项

- **file:/tgg 本地安装的刷新陷阱**：pnpm 对 `file:` 目录依赖取 inode 快照，源 `dist/` 重写后
  必须 `pnpm remove + add` 或改用 tgz 安装才会刷新；npm/github 内容寻址通道天然新鲜。
- **profile bundles**：`pnpm remove` 会把 bundles 列表里的 `@ybkk/gate-01` 一并移除，
  重装后需确认 profile `package.json` 的 `dsh.profile.bundles` 含 `@ybkk/gate-01`。
- **版本节奏**：每次发布 = bump 版本号 → `npm run build:dist` + 浏览器半重建 → selftest 全绿 →
  pack → publish → 推送交付（安装产物 dist/** 提交入库，发布包与仓库一致）。
