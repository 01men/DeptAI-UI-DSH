# 企业部署与 Agent 一键接入指引

> 适用对象：基于 **DeepSeek Harness（dsh）** 为企业部署本仓库（衡 · 企业 AI 资源统一管理平台）的工程师，
> 以及希望把部署/接入工作**直接下达给 dsh 自带 Agent 自动完成**的使用者。
> 日常运维（非部署）的 Agent 指引见 `skills/dsh-ops-admin/SKILL.md`（总控索引）。

---

## 一、部署形态与拓扑

| 形态 | 进程 | 说明 | 适用 |
|---|---|---|---|
| A. 独立宿主（默认） | `node src/main.ts` | 一个进程提供 REST 网关 + 控制台 SPA + 41 运维工具桥（含 4 个接入管理工具） | 企业生产最小形态，控制台人工使用 |
| B. 独立宿主 + dsh 运行时 | A 的进程 + `dsh web --patch cordis.yml` | dsh 侧插件树对模型暴露全部运维工具，Agent 可用自然语言运维平台；两进程**共享同一 `data/` 目录** | 需要 Agent 驱动运维的企业 |
| C. 远程 dsh 接入 | 宿主（A）+ 远程电脑 `dsh plugin add` | 远程电脑经插件市场安装本平台，凭**一次性接入码**向宿主申请机器凭证；运维工具全部远程代理到宿主执行（免源码、免共享 data） | 多办公点/多人用 dsh 协作运维同一平台 |

> 关键事实：`cordis.yml` 不挂载 console 插件——控制台 SPA 与 REST 始终由独立宿主进程提供；
> dsh 侧只挂业务插件（`provideToolRuntime: false`，使用 dsh 原生 ToolRuntime）。
> 因此**形态 B 也必须先完成形态 A**。

环境要求：Node ≥ 22.6（原生 TypeScript 运行，无构建步骤）；数据落盘在 `--data` 指定目录
（JSON 集合 + SQLite `txnstore.db`）。

---

## 二、人工部署 runbook（形态 A · 可执行 checklist）

> 每一步都给出「命令 + 预期输出」：预期不符即停，按右侧排障列处理后再继续。

### 步骤 0：环境预检

- [ ] `node -v` → **v22.6+**（原生跑 TS，无构建步骤）
      ✘ 低于 22.6：升级 Node 后继续，不要绕过（老版本无法直接执行 src/main.ts）

### 步骤 1：获取代码与依赖

```bash
git clone <仓库地址> ops-platform && cd ops-platform
npm install                # 预期：无 ERR 结尾；package-lock 未变时秒级完成
```

### 步骤 2：首次启动（基线初始化向导）

```bash
# 生产：口令必须显式指定（不设则随机生成一次性写入 data/admin-initial-password.txt）
export ADMIN_PASSWORD='<强口令>'            # Windows PowerShell: $env:ADMIN_PASSWORD='...'
npm start -- --port 7300 --data ./data
```

- [ ] 日志出现「平台基线初始化完成」+ 「上线三步走」引导框（首启一次性）
- [ ] 日志出现「元冰可|企业AI资源管理平台已启动」与「控制台地址：http://0.0.0.0:7300」
- [ ] `curl -s http://127.0.0.1:7300/api/health` → `{"status":"ok",...}`
- [ ] （若未设 ADMIN_PASSWORD）确认 `data/admin-initial-password.txt` 已生成，**读完立即转到步骤 4 改密**

### 步骤 3：功能验证

```bash
# 登录（预期返回 token 字段）
curl -s -X POST localhost:7300/api/auth/login -H 'content-type: application/json' \
     -d '{"username":"admin","password":"<口令>"}'
# 首启状态（预期 initialPasswordPending=true——口令文件还在服务器时为 true，改密删文件后变 false）
curl -s http://127.0.0.1:7300/api/platform/bootstrap
```

- [ ] 登录返回 token；浏览器打开控制台，登录页出现黄色「首次部署提示」横幅（口令文件未删时）
- [ ] 质量门（隔离实例，不碰生产数据）：`npm run selftest` 全绿、`npm run lint:manifests` 0 红

### 步骤 4：收尾（安全接管）

- [ ] 控制台修改 admin 口令（右上角头像 → 修改密码）
- [ ] 删除服务器 `data/admin-initial-password.txt` → `curl -s http://127.0.0.1:7300/api/platform/bootstrap` 变 `initialPasswordPending:false`，登录页横幅消失
- [ ] （供应链加固，可选但推荐）发布清单验签：

```bash
# 发布方（一次性）：生成密钥对 → 私钥自持，公钥登记平台
node scripts/release-manifest.mjs --generate-key --key-file /secure/release-key.pem
# 管理员侧（一次性）：登记公钥 + 开启强制（顺序不能反，未登记公钥时开启会被拒绝）
curl -X POST localhost:7300/api/update/settings -H "authorization: Bearer <token>" \
     -H 'content-type: application/json' -d '{"releasePublicKey":"<公钥 base64>"}'
curl -X POST localhost:7300/api/update/settings -H "authorization: Bearer <token>" \
     -H 'content-type: application/json' -d '{"requireSignedManifests":true}'
```

### 步骤 5：进程守护（Linux systemd 示例）

```ini
# /etc/systemd/system/ops-platform.service
[Service]
WorkingDirectory=/opt/ops-platform
Environment=ADMIN_PASSWORD=<强口令>
# 连接器网关门禁（缺失则连接器页持续「网关不可用」，探活失败刷审计——测试报告 DEF-02）
Environment=OOMOL_CONNECT_ADMIN_TOKEN=<强口令>
Environment=OOMOL_CONNECT_ENCRYPTION_KEY=<32 字节以上随机串>
# 端口占用守卫：孤儿进程抢占端口会让 restart 静默失效（测试报告 DEF-04），启动前先检测
ExecStartPre=/opt/ops-platform/scripts/guard-port.sh 7300
ExecStart=/usr/bin/node src/main.ts --port 7300 --data /opt/ops-platform/data
Restart=always
```

运维要点：

- **运维铁律**：一律经 `systemctl` 启停服务，禁止绕过 systemd 手工 `node src/main.ts` 拉起
  （孤儿进程抢端口后，`systemctl restart` 会失败或旧进程继续占端口，变更不生效且难以排查）。
- **备份**：冷备整个 `--data` 目录即可（JSON 原子落盘 + SQLite WAL）。资金/计量数据在 `txnstore.db`。
- **升级（v1.1+ 内置更新检查）**：平台默认每 24h 自动向上游 GitHub 仓库发起一次版本检查（可在控制台
  顶栏「平台更新」抽屉或 `dshctl update set` 调整/关闭）；发现新版本时控制台顶栏出现「可更新」徽标，
  并广播 `platform.update.available` 事件（审计留痕）。升级方式按安装形态二选一：
  - **源码检出（source）**：控制台抽屉「一键升级」或 `dshctl update apply --dry-run` 预演后
    `dshctl update apply --reason="…"`（内部执行 `git pull --ff-only` + `npm install`，本地有未提交
    修改会安全失败而非强改），随后 `systemctl restart ops-platform` 生效；先跑 `npm run selftest` 再切换流量。
  - **插件市场安装（bundle）**：在宿主 dsh 侧执行 `dsh plugin update github:01men/ybkkasi`，重启 dsh 宿主。
  - Agent 亦可在会话中直接说「检查平台更新」/「升级平台」（`update_status` / `update_check` / `update_apply` 工具）。
- **对外发布**：用 Nginx 等反代 7300 并做 TLS；平台自身按 Bearer 令牌鉴权。
- **企业定制**（按需）：钉钉真实连接器（`mode: real` + `apiBase`，控制台「组织与账号 → 三方集成」配置）。
  三方接入支持**同 provider 多主体多实例**：同一钉钉平台可接入多家企业主体（各自一套
  corpId/appKey/appSecret），配置以实例 id 寻址、按 `provider|corpId` 唯一（重复主体拒绝），
  各自独立配置/测试/同步/删除，同步部门按连接器实例隔离归属，登录/绑定可按主体发起。REST 面：
  `POST /api/iam/connectors` 创建实例、`DELETE /api/iam/connectors/:id` 删除实例（权限点
  `iam.connector.write`）；既有 `PUT/POST /api/iam/connectors/:param[/test|/sync]` 中 `:param`
  先按实例 id 解析、失败按 provider 取第一条（enabled 优先），旧调用零改动兼容。配置字段新增
  `name`（主体显示名，登录入口/列表按此区分）与 `targetOrgId`（同步树根挂载部门，空=平台根）。
  OIDC 对外声明 `OIDC_ISSUER` 环境变量；OIDC 私钥生产建议迁 KMS。
- **内网/限流环境**：更新检查走 GitHub API（未认证限额 60 次/时/IP，可设 `GITHUB_TOKEN` 提额）；
  私有镜像用 `DSH_UPDATE_API_BASE` / `DSH_UPDATE_RAW_BASE` 环境变量覆盖。
- **资金边界**：支付/对公/开票通道为手工过渡态，接入前请阅读 README「三A 资金红线」。

## 三、dsh 运行时接入（形态 B，启用 Agent 运维）

前提：deepseek-harness 源码检出可用（`pnpm dsh web`）。

```bash
# 1. 生成接入 overlay（替换 <PROJECT_ROOT> 为本仓库绝对路径）
sed 's|<PROJECT_ROOT>|/opt/ops-platform|g' cordis.yml > /tmp/ops-overlay.yml

# 2. 在 deepseek-harness 检出中启动（与独立宿主共享 data/，两进程同时在线）
pnpm dsh web --patch /tmp/ops-overlay.yml
```

Agent 运维凭据（环境变量）：`DSHCTL_URL`（默认 `http://127.0.0.1:7300`）、
`DSHCTL_USER` / `DSHCTL_PASS`（建议 ops 类账号，勿用 admin 常驻）、或 `DSHCTL_TOKEN`。
日常运维让 Agent 读 `skills/dsh-ops-admin/SKILL.md` 即可（诊断→取证→dry-run 预演→执行→验证闭环，L4 高危操作自动走审批单）。

---

## 四、远程 dsh 接入（形态 C：插件市场安装 → 接入码 → 自动申请凭证）

适用：其他电脑的 dsh 经 `dsh plugin --profile web add github:01men/ybkkasi` 安装本平台后，
不知道如何配置宿主签发的凭证/口令。整个流程**无需在远程电脑手工编辑任何配置文件**。

### 4.1 宿主侧：签发一次性接入码（管理员，控制台或 CLI）

```bash
# 控制台：登录 → 左侧「平台 → 平台接入」→ 创建接入码（选模板/TTL/备注，码仅展示一次）
# 或 CLI：
DSHCTL_URL=http://宿主IP:7300 DSHCTL_USER=admin DSHCTL_PASS=*** \
  node cli/dshctl.mjs connect code --template=operator --ttl=15 --remark="研发部小王"
```

权限模板（= 接入后远程客户端的权限边界）：

| 模板 | 权限 |
|---|---|
| `readonly`（默认） | 全部查询类权限点（list/get/metrics/logs） |
| `operator` | 只读 + MCP/Skill/Agent/应用运维与审批决策；**不含**账号与凭证管理 |
| `full` | 全部权限（`*`），仅可信环境使用 |

### 4.2 远程电脑：两条接入通道（任选其一）

```text
① Agent 通道（推荐）：在 dsh 界面直接对 Agent 说
   「接入宿主平台，地址 http://<宿主IP>:7300，接入码 <enr_…>」
   Agent 将调用 connect_setup 工具自动完成申请，并把 37 个运维工具切换为远程执行。

② 配置页通道：浏览器打开 http://127.0.0.1:7390（远程电脑本机，插件启动时自动监听）
   填写宿主地址 + 接入码 → 「申请接入」；后续随时可在此页更新配置、测试连接或断开。
   已有机器凭证（mc-/cs_ 开头）时切换到「已有机器凭证」页签直接配置。
```

### 4.3 验证与运维

- 远程侧：Agent 执行 `connect_status`（应显示 remote 模式、令牌有效）、`agent_list`（返回宿主数据）。
- 宿主侧：控制台「平台接入 → 已接入客户端」出现该电脑（名称/模板/主机名/最近使用）。
- 回收：宿主侧「禁用客户端」（原因必填留痕）→ 联动吊销全部机器令牌，远程工具调用立即 401；
  远程侧 `connect_reset` 仅清除本机凭证。
- 安全基线：接入码只存哈希（创建时一次性展示）、一次性消费、TTL 可配（默认 15 分钟）、
  按来源 IP 失败锁定（15 分钟窗口 5 次）；机器凭证等价口令仅存远程本机（0600）；
  客户端工具代理走宿主 `/api/tools/execute`，逐工具做 RBAC 校验并全程审计。

### 4.4 常见问题

| 现象 | 处置 |
|---|---|
| connect_setup 报「接入码无效」 | 码已用/过期/作废（一次性消费）；宿主侧重新创建 |
| 报「宿主服务不可达」 | 检查宿主监听 0.0.0.0 与防火墙；地址带 `http://` 与端口 |
| 工具执行报 403 缺权限点 | 权限模板不足；宿主侧禁用客户端后用更高模板接入码重新接入 |
| 禁用后远程仍显示已配置 | 本机凭证仍在但已失效；远程侧执行 `connect_reset` 清除 |

---

## 五、Agent 一键下达指引（可直接整段粘贴给 dsh 自带 Agent）

> 使用方法：把下面整段指令发给 dsh Agent，替换 `<...>` 占位符；Agent 将自行完成部署与验证并回报结果。
> 生产环境请先人工确认占位符与口令强度；指令内置护栏（禁演示数据、不覆盖已有数据目录、高危操作走审批）。

```text
【任务】在 <目标服务器，如 10.0.0.5 或本机> 上部署「衡 · 企业 AI 资源统一管理平台」并完成验证。
仓库：<git 克隆地址，如 git@github.com:01men/ybkkasi.git>；部署目录：<如 /opt/ops-platform>；
监听端口：<7300>；管理员口令：<ADMIN_PASSWORD 强口令>；部署后是否接入 dsh 运行时：<是/否>。

【执行步骤】
1. 环境检查：确认 Node ≥ 22.6（node -v）。不满足则停止并回报，不要自行升级系统 Node。
2. 获取代码：克隆（或若目录已存在则 git pull）到部署目录；记录当前 commit hash。
3. 安装依赖：npm install。
4. 生产初始化：设置 ADMIN_PASSWORD 环境变量；以 --port <端口> --data <部署目录>/data 启动
   （优先用 systemd/PM2 守护）。铁律：绝不设置 DEMO_SEED=1；若 data/ 目录已存在且非空，
   视为已有实例——停止并请求人工确认，不得覆盖。
5. 健康验证（全部通过才算成功）：
   a. GET / 返回 200；
   b. POST /api/auth/login（admin + 口令）返回 token；
   c. GET /api/overview（Bearer token）返回 200；
   d. npm run selftest 全部通过；npm run lint:manifests 70/70 通过。
6.（可选，仅当"接入 dsh"=是）按仓库 docs/deploy-enterprise.md 第三节生成 overlay 并以
   pnpm dsh web --patch 启动，验证两进程共享同一 data/。
7. 回报：commit hash、服务地址、admin 首登是否成功、自测结果、初始口令交付方式（不得明文贴在公开渠道）。

【护栏】
- 一切高危操作（下线/吊销/删除）必须走平台审批单并留痕，不得绕过；
- 只读命令可自由执行；任何变更前先 --dry-run 预演；
- 部署完成后建议立即改掉 admin 初始口令并创建企业自有账号（参考 skills/dsh-ops-iam）。
```

## 六、验收清单

- [ ] `GET /` 200，控制台可登录（admin + `ADMIN_PASSWORD`）
- [ ] `npm run selftest` 全绿、`npm run lint:manifests` 0 红
- [ ] 生产数据目录**不含**演示数据（`data/iam~users.json` 无 ops/hr/dev 等演示账号）
- [ ] `GET /api/platform/bootstrap` 返回 `initialPasswordPending:false`（初始口令已接管收尾）
- [ ] （形态 B）dsh web 启动且 Agent 能回答 `dshctl mcp list` 类问题
- [ ] （形态 C）远程电脑 `connect_status` 显示 remote 模式；宿主「平台接入」页可见该客户端
- [ ] 备份策略就位（data/ 目录定时冷备）
- [ ] admin 初始口令已更换，演示口令 `Ybk@2026` 无法登录
- [ ] （可选供应链加固）`GET /api/update/status` 显示 `releaseKeyConfigured:true`
