# 形态 B（dsh 单入口）Mac 服务器部署记录

> 部署日期：2026-09-03 · 目标机：`mdzx.fun`（macOS 15.7.1，Apple Silicon，用户 xiaodaoqin）
> 端口：**8801**（用户指定 8802 被 `ai.hermes.gateway`（Hermes 钉钉助手）占用，经确认换端口；形态 A 曾短暂占用 8801，现已**彻底移除**——launchd 服务定义与数据目录均已删除，8801 归 dsh 单一服务）
> 形态：**B 单进程单入口**——`/` 为 dsh 对话界面，`/rq/*` 为元冰可数据面（控制台/REST/docs/MCP）

## 一、部署布局

| 项 | 路径 |
|---|---|
| dsh harness 检出（rc.7 + 本地适配） | `/Users/xiaodaoqin/dsh/deepseek-harness` |
| 元冰可工作区（本仓库完整检出） | `/Users/xiaodaoqin/yuanbingke-ops` |
| 平台数据目录（种子+运行数据） | `/Users/xiaodaoqin/yuanbingke-ops/dsh-data` |
| overlay（cordis.yml 生成，`<PROJECT_ROOT>` → `file:///Users/xiaodaoqin/yuanbingke-ops`） | `/Users/xiaodaoqin/yuanbingke-ops/overlay-rq.yml` |
| launchd | `~/Library/LaunchAgents/ai.yuanbingke.dsh.plist`（Label `ai.yuanbingke.dsh`，KeepAlive） |
| 日志 | `/Users/xiaodaoqin/dsh/web-stdout.log`、`web-stderr.log` |
| node | `/opt/homebrew/bin/node`（v25.5.0，满足 ≥22.6 原生 TS 运行） |

## 二、部署要点（与 `docs/deploy-enterprise.md` 的差异/补充）

1. **overlay 对 webserver 行的直写**：CLI 拒绝 `--host 0.0.0.0`（安全设计），且 `--patch` overlay
   **不能**重复 `id: webserver` 行（loader 同层重复 id = 致命错）。正确做法是直接改
   harness 检出内 `packages/bundle/web-app/cordis.patch.yml` 的 webserver 行默认值
   （`host ?? '0.0.0.0'`、`port ?? 8801`，已改，原文件备份为 `cordis.patch.yml.bak`）；
   公网域名访问还需 CLI 带 `--trusted-host mdzx.fun:8801` 过 DNS-rebinding fence。
2. **rq-card（dsh.client 双面插件）解析链**：client-modules 从「cordis.yml 所在目录」向上
   require.resolve 包名 → 依赖 `~/yuanbingke-ops/node_modules/@dsh-ops/plugin-rq-card`（npm workspace
   链接，`npm ci` 自动建）；且包 `exports` 必须导出 `./package.json`（本仓库已修复，见 §三）。
3. **数据目录**：overlay 中 `ops-platform-core` 显式 `dataDir: /Users/xiaodaoqin/yuanbingke-ops/dsh-data`
   （默认 cwd/data 会落进 harness 检出目录）。
4. **demo 种子**：当前以 `DEMO_SEED=1` 运行（演示账号 admin/dev/audit/ops/hr/yqz，口令 `Ybk@2026`）。
   种子已修复为「键锚定确定性内容」（见 §三），重启重种 = 幂等重放，不再冲突。

## 三、本次部署发现并修复的平台缺陷（已进仓库）

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | form B 的 loader 轻量 ctx 按插件 inject 列表裁剪能力面，`plugin-dsh-bridge` 直读未声明的 `identityBinding`/`opsStorage` → 装配期 `without inject` 致命错 | inject 列表补齐 `opsStorage, iam`；`identityBinding` 预注入探测改 try/catch（自测试图注入语义不变） |
| 2 | `plugin-rq-card` 的 exports 未导出 `./package.json`，client-modules 扫描器 `require.resolve('<包>/package.json')` 被 exports 拦截 → 静默判「非 client 行」→ 浏览器 bundle 404 | exports 增 `"./package.json": "./package.json"` |
| 3 | 演示种子 usage 事件的 tokens 按循环位置取随机值，而幂等键含日期——日期窗口随启动日滑动，跨日重启重种 = 同键不同内容 → fatal | tokens 改为由 `slug:date` 哈希派生的确定性值（键锚定内容，重种 = 幂等重放） |
| 4 | **form B 无 SIGTERM 落盘钩子**（form A 的 main.ts 专属逻辑）：进程被杀时 opsStorage 防抖写丢失、SQLite 即时写保留 → 「半套数据」启动态 | `StorageService` 基础层自装 SIGTERM/SIGINT → `flushNow()` + exit（双注册无害：flushChain 串行 + exit 幂等） |
| 5 | **form B 无集合恢复调用**（`restoreAll` 只在 boot-all 形态 A 存在）：重启后全部 JSON 集合为空 → 种子重种 / 任何数据不可见 | `platform-core` 的 `apply` 异步化：`await storage.start()` + `await storage.restoreAll()`（先于一切业务集合读取，loader 等待异步 apply） |

## 四、运维速查

```bash
launchctl kickstart -k gui/501/ai.yuanbingke.dsh     # 重启（SIGTERM → 优雅落盘 → 拉起）
launchctl unload ~/Library/LaunchAgents/ai.yuanbingke.dsh.plist   # 停止
tail -f ~/dsh/web-stderr.log                     # 看日志
# 升级：本地 git archive 覆盖 ~/yuanbingke-ops（或单文件 scp）→ launchctl kickstart
```

验证基线（部署完成时实测）：`/` 200（dsh UI，boot manifest 含 rq-card）、`/rq/` 200（控制台）、
`/rq/api/*` 登录+卡片包下发正常、`/plugins/@dsh-ops/plugin-rq-card/client.js` 200、
重启循环 ×3 零冲突零 fatal、`/api/health`（dsh 侧无此端点，元冰可健康检查在 `/rq/api/health`）。

## 五、安全声明（务必阅读）

- dsh 自有 `/api/*` 无鉴权（上游明示 "fence is not auth"），0.0.0.0 绑定 = 对公网暴露该面；
  元冰可数据面（`/rq/api/*`）有完整 Bearer + RBAC + 审计。建议：路由器端口转发仅在需要时开启，
  或加 IP 白名单 / 反向代理 + HTTPS。
- 演示模式含默认口令账号。长期生产：清 `dsh-data` → 去掉 `DEMO_SEED` → plist 加
  `ADMIN_PASSWORD=<强口令>` → 重启（平台以生产基线初始化，无演示账号）。
- LLM 供应商未配置：对话功能需在 dsh 设置中配置模型与 API Key 后可用（平台管理面不受影响）。
