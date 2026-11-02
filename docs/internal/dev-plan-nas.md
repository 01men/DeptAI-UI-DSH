# 开发计划：NAS（FS 文件存储）资产纳管 + Skill 包 NAS 存储 + 平台三端调用（CLI / API / MCP）

> 版本：v1.0（2026-08-24）· 关联需求：新增 NAS 资产类型、skill.zip 上架上传 NAS、确认并实现 CLI/API/MCP 三端调用
> 参考实现：[01men/synology-filestation-mcp](https://github.com/01men/synology-filestation-mcp)（Streamable HTTP MCP 网关，`/mcp` + `Authorization: Bearer` + `X-NAS-IP` 路由）

---

## 〇、需求 3 可行性确认结论（先回答，再实施）

| 调用方式 | 现状 | 结论 |
|---|---|---|
| **dsh 插件调用** | 已实现：全部运维工具注册进 `ctx.tools`（独立宿主 ToolRuntime-lite / 完整 dsh 原生 ToolRuntime 双宿主） | ✅ 已有，保持 |
| **CLI 调用** | 已有骨架 `examples/dshctl.mjs`（REST 工具桥 + 账号自动登录） | ✅ 可行，本次扩展 `nas` 命令组、`skill submit --package`、`skill storage` |
| **API 调用** | 已有 REST 网关（console 插件统一 Bearer 鉴权 + RBAC 权限点） | ✅ 可行，本次新增 `/api/nas/*`、`/api/skill-storage` 端点 |
| **MCP 调用** | 平台只做过 MCP **客户端**（plugin-mcp 真实 JSON-RPC 传输层）；作为 MCP **服务端**对外暴露尚不存在 | ✅ 可行，本次新增 `POST /mcp` Streamable HTTP 端点：`initialize` / `tools/list` / `tools/call`，把平台全部运维工具（40+）以标准 MCP 协议暴露给任意 MCP 客户端（ZCode / Claude / Cursor 等），复用同一套 Bearer 令牌与工具级权限点 |

MCP 端点接入示例（与用户提供的 synology-filestation 配置同构）：

```json
{
  "mcpServers": {
    "dsh-ops-platform": {
      "url": "http://<平台地址>:7300/mcp",
      "headers": { "Authorization": "Bearer <平台令牌>" }
    }
  }
}
```

---

## 一、背景与目标

1. **NAS 成为第六类受管资产（FS 文件存储类）**：以 synology-filestation-mcp 这类「MCP 文件网关」为访问通道——平台持有网关地址 + Bearer 令牌 + 设备 IP（`X-NAS-IP`），所有文件操作经网关 `tools/call` 完成（fs_list / fs_upload / fs_mkdir / fs_delete / fs_search 等）。纳入资产运营台账、健康巡检、审计与 RBAC。
2. **Skill 上架（publish）支持把 skill.zip 上传到 NAS**：服务后台可直接配置「NAS 存储空间 + 访问凭证」（指向已纳管 NAS 资产 + 根路径），上架时自动打包上传、把包位置写回版本记录。
3. **平台能力三端可调**：dsh 插件（已有）+ CLI + REST API + MCP（平台即 MCP Server）。

## 二、总体设计

### 2.1 新插件 `plugin-nas`（业务域：NAS 文件存储）

沿用「每个业务域 = 一个插件包」的铁律，采用 resource-core Pattern A（与 agent/app 同构）：

```
packages/plugin-nas/
  src/schema.ts    NAS_TYPE_SPEC：属性表（基本/接入/治理三组）+ 生命周期状态机
  src/client.ts    NasMcpClient：轻量 MCP Streamable HTTP 客户端（initialize 会话缓存、
                   tools/list、tools/call，JSON/SSE 双响应形态——与 plugin-mcp 传输层同构）
  src/index.ts     NasRegistryService（ctx.nasRegistry）+ 插件装配
  src/tools.ts     nas_* 运维工具（对模型/CLI/MCP 三端同一契约）
  manifest/…       契约五面（gen-manifests 生成）
```

- **属性表**：`description`（必填）、`vendor`、`capacity`、`tags` | `gatewayUrl`（必填，上线必须）、`accessToken`（上线必须）、`nasIp`（上线必须，`X-NAS-IP`）、`rootPath`（默认 `/`）、`stagingDir`（上传中转目录，须网关侧可读） | `dataClass`。
- **生命周期**：`draft → online → offline → archived`；`online` 迁移前由 REST/工具层先做 initialize 探活（可达才允许上线）。
- **文件操作**（全部经网关 `tools/call`，读类需 `nas.read`、写类需 `nas.write`）：
  `listShares / list / getInfo / search / mkdir / rename / copyMove / delete / upload / download / taskStatus`——覆盖 synology-filestation-mcp 的 fs_* 工具面。
- **健康**：`probe()` = MCP initialize 握手测延迟；结果（healthy/degraded/down + latencyMs）存 `nas:health` 集合；接入资产运营「一键健康巡检」。
- **事件**：`nas.registered / nas.onlined / nas.offlined`（bus 保留前缀新增 `nas.`）。
- **审计**：全部写类操作 `audit.record` 留痕；网关调用失败同样留痕。

### 2.2 NAS 访问凭证与 mcpServers JSON 导入

- 凭证保存在 NAS 资产 attrs（`accessToken`），控制台/REST 回显一律脱敏（同 MCP 服务 headers 脱敏策略）。
- `POST /api/nas/import`：直接吃用户提供的 mcpServers JSON（synology-filestation 形态），解析
  `url + headers.Authorization + headers["X-NAS-IP"]` → 自动创建 NAS 资产 + 探活 + 上线 + 工具发现（复用既有 `parseMcpServersConfig` 归一化思路，但落在 NAS 域）。

### 2.3 Skill 包 NAS 存储（skillhub 扩展）

- **提交扩展**：`submit()` 增加可选 `packageBase64`（skill.zip 内容，base64；HTTP 入站体为 JSON，沿用 base64 避免引入 multipart）。CLI `skill submit --package=<path>`；控制台提交弹窗可选附件。
- **存储配置**：`skill:storage` 单例记录（opsStorage 集合，运行期可改）：
  `{ mode: 'local' | 'nas', nasId?, basePath? }`；`GET/PUT /api/skill-storage`（读 `skill.read` / 写 `skill.storage.write` 新权限点）。访问凭证不重复配置——直接引用已纳管 NAS 资产（token 在资产里）。
- **上架钩子**（`publish()` 内联，服务注入是官方协作模式——console 即如此）：
  1. `mode=nas` 且配置的 NAS 资产 online：取 `packageBase64`；没有则用零依赖 ZIP 打包器由 SKILL.md 内容现场生成 `<slug>-<version>.zip`（platform-core 新增 `zip.ts`，deflate + CRC32，无第三方依赖）。
  2. 写平台 staging 目录（`<dataDir>/nas-staging/` 或资产 `stagingDir`）→ 经网关 `fs_upload` 上传到 `<basePath>/<slug>/<slug>-<version>.zip` → `fs_get_info` 复核。
  3. 成功：版本记录写回 `package { storage:'nas', nasId, path, sizeBytes, uploadedAt }`；失败：**上架失败（fail-closed）**，错误信息明确提示网关/路径约束。
  - 部署约束（如实声明）：`fs_upload` 在网关进程侧读本地路径——平台与网关需同机或共享卷；跨机场景请将 `stagingDir` 配置为共享挂载点。
- **下载**：`download()` 返回内容不变；新增 `GET /api/skills/:id/package?version=` 拉取 zip（本地生成或经网关 `fs_download` 中转）。

### 2.4 平台 MCP Server 端点（`POST /mcp`，console 插件）

- **协议**：MCP Streamable HTTP（JSON-RPC 2.0 over POST）。支持 `initialize`（回 `mcp-session-id` 头 + serverInfo/capabilities）、`notifications/initialized`（202）、`tools/list`（`ctx.tools.schemas()` → `{name, description, inputSchema}`）、`tools/call`（execute → content blocks / isError）、`ping`；未带 id 的通知类消息一律 202；`GET /mcp` 返回 405（不提供 SSE 长流，纯 JSON 响应形态合法）。
- **鉴权**：每请求校验 `Authorization: Bearer`（复用 `ctx.authn.verify`，人/机器令牌皆可）；无 token → HTTP 401。
- **权限**：与 REST 工具桥完全一致——工具声明 `permission` 则按点校验（403 → JSON-RPC error），并复用工具桥的**身份注入**（`mcp_invoke` 强制 caller 身份、`approval_decide` 强制 approver 等，防参数伪造）。因此一个低权限令牌经 MCP 也无法越权。
- **意义**：外部 MCP 客户端（ZCode/Claude/Cursor/自研 Agent）无需 dsh 运行时即可自然语言运维平台；与「远程 dsh 接入」互补。

### 2.5 权限与角色（iam）

新增权限点：`nas.read` / `nas.write`（组：NAS 存储）、`skill.storage.write`（组：Skill 市场）。
内置角色：`resource_admin += nas.*`；`developer += nas.read`；`auditor += nas.read`。

### 2.6 CLI（dshctl）

```
nas     list | get <id> | create --name= --gateway-url= --token= --nas-ip= [--root-path=]
        import --config=<mcpServers JSON 或 @文件>   （用户测试配置直接粘贴）
        health <id> | online <id> | offline <id> --reason=
        shares <id> | files <id> [--path=] | mkdir <id> --path= | delete <id> --path=
        upload <id> --file=<本地路径> --dest=<NAS路径> | search <id> --pattern=
skill   submit … [--package=<skill.zip>]             （随提交上传包内容）
        storage get | storage set --mode=nas --nas-id= --base-path=
```

## 三、实施步骤（执行序）

| # | 步骤 | 落点 |
|---|---|---|
| 1 | ZIP 打包器（零依赖） | platform-core `src/zip.ts` |
| 2 | plugin-nas 插件四件套 | packages/plugin-nas |
| 3 | 插件挂载 | src/boot-all.ts、cordis.yml、cordis.patch.yml |
| 4 | 权限点/角色/事件 | plugin-iam、platform-core bus、gen-manifests |
| 5 | skillhub 包支持与上架上传 | plugin-skillhub |
| 6 | REST 网关扩展 | plugin-console（/api/nas、/api/skill-storage、/mcp、台账/巡检） |
| 7 | 控制台页面 | public/js（nas.js、app.js、assets.js、skills.js） |
| 8 | CLI 扩展 | examples/dshctl.mjs |
| 9 | 演示种子 + 自测 | seed.ts、selftest.mjs（进程内真实 MCP stub 复刻 synology-filestation 契约） |
| 10 | 文档与验收 | README、本文档、lint:manifests、selftest 全绿 |

## 四、测试计划

1. **selftest 新增分节**（stub = 进程内真实 HTTP 服务，复刻 synology-filestation-mcp 的 initialize/tools/list/tools/call 与 fs_* 契约，校验 Bearer + X-NAS-IP 头）：
   - mcpServers JSON（用户测试配置原样）→ NAS 资产导入/探活/上线/工具发现；
   - 文件全链：shares/list/mkdir/upload/download/search/delete；
   - RBAC：member 无 `nas.read` 403；developer 只读可读不可写；
   - Skill 包：配置 nas 存储 → 提交（带 zip）→ 审批 → 上架 → stub 收到 fs_upload（校验路径与 zip 合法性）→ 版本 package 回写；无 zip 时由 SKILL.md 自动打包；NAS 不可达 → 上架 fail-closed；
   - 台账 inventory 含 nas 类型 + 一键巡检覆盖；token 回显脱敏；
   - `/mcp` 端点：401 / initialize / tools/list（40+）/ tools/call 成功 / 工具级越权拒绝 / 未知方法 -32601。
2. **真实环境联调**（同网段，本仓库外）：用测试配置 `http://192.168.0.7:3000/mcp` + `X-NAS-IP: 192.168.0.196` 走 `nas import` → `nas files` 验证（本开发机与该网段不连通，已在计划中注明由部署环境执行）。
3. `npm run lint:manifests` 契约五面校验通过。

## 五、边界与后续

- 本期不暴露 fs_compress/fs_extract/fs_task_status 以外的任务类工具面（stub 契约保留 taskStatus）；
- NAS 权限组治理（按主体收敛 fs 写操作）复用 MCP 权限组模型，后续按需映射；
- `/mcp` 端点暂不提供 GET SSE 长连接（纯 JSON 响应，主流客户端兼容），后续按需补全；
- fs_upload 的网关侧路径约束见 §2.3——跨机部署需共享 staging 卷（已在配置项与文档中显式化）。

---

## 六、真实网关契约对齐 + 文件浏览/上传/下载全链（v1.2 增补 · 2026-08-27）

> 结论：宿主平台层对 NAS 存储目录的**真实连接访问**已实现并上线自测通过——逐级点击浏览、
> 多文件/文件夹结构上传、浏览器端原生文件下载全部打通。

### 6.1 真实网关契约（关键修正）

此前 fs_* 映射按想象中的 `{share, path}` 形态传参，与真实 synology-filestation-mcp
（tools/list 实测）不一致，是"列目录报 folder_path undefined"的根因。现已全面对齐：

| 平台操作 | 真实网关工具与参数形态 |
|---|---|
| listShares | `fs_list_shares {}` |
| listFiles(path) | `fs_list { folder_path }`（完整 DSM 路径字符串） |
| getInfo(path) | `fs_get_info { path: [..] }` |
| search | `fs_search { folder_path, pattern, recursive, limit }` |
| mkdir | `fs_create_folder { folder_path: [父目录], name: [新名], force_parent }` |
| rename | `fs_rename { path: [原路径], name: [新名] }` |
| copyMove / delete | `{ path: [...] , dest_folder_path / remove_src }`、`fs_delete { path: [...] }` |
| uploadFile | `fs_upload { local_file, dest_path=目标目录 }`，超时随字节数放宽 |
| downloadFile | `fs_download { path: [...], local_dir, mode: 'download' }` → 回执 `{saved_to, bytes}` |

`splitPath` 已替换为 `toFullPath`（rootPath 越权收敛保留）+ `parentAndName`。

### 6.2 新增端点

- `GET /api/nas/:id/fs/file?path=&inline=`：流式文件直出（content-disposition attachment/inline）。
  鉴权支持两种形态：Bearer 头；或 `POST /api/nas/:id/fs/download-ticket` 签发的 **15 秒一次性票据**
  （`?ticket=`，一次性消费、绑定 nasId+path）——浏览器 `<a>` 原生下载无需自定义头。
- `POST /api/nas/:id/fs/upload-many`：批量上传（relativePath 保留目录结构，>50 个文件走该端点）。

### 6.3 前端（nas.js）

- 面包屑逐级点击浏览 + 行内 下载/重命名/删除；
- 上传弹窗支持多选文件与 webkitdirectory 整文件夹（相对路径结构保留），带待上传清单与进度；
- 大小/修改时间列兼容网关 `additional.{size,time.mtime}` 结构。

### 6.4 部署排障记录（重要教训）

部署后曾出现「服务监听正常但所有路由 404」：console 插件 inject 声明了 `connectorHub`，
而部署树缺少提供方 `@dsh-ops/plugin-connector` ——cordis 对缺失依赖的 fiber 是**静默保持 INACTIVE**
（无日志、await 正常返回）。修复：部署 plugin-connector 包 + boot-all 挂载。教训：
① 新增 inject 服务必须确认对应插件已在部署树；② 排障利器是逐步 ctx.plugin 探针脚本。

### 6.5 自测结果（2026-08-27 · http://192.168.0.7:7300）

- 本地 selftest：543/543 通过（含 ticket 签发/消费/重放拒绝/未知票据 401）；lint:manifests 70/70；
- 真机 Playwright 全链：登录 → NAS 板块加载 → 详情抽屉 → 共享层/test/dsh-e2e 逐级点击（截图齐全）→
  UI 双文件上传 → 文件夹结构上传（sub-dir 自动建链）→ 原生下载 e2e-payload-v2.zip
  （content-disposition UTF-8 文件名，47B 字节比对一致）→ 测试数据自动清理；
- API 冒烟：shares/list/mkdir/upload/verify/download 字节比对全通；RBAC 403 与无票据 401 保持。

### 6.6 已知边界

- 网关侧 fs_download 对不存在路径会把 DSM 错误页落成同名文件（上游行为）；平台在 downloadFile
  后以 stat 兜底，但内容校验需依赖 fs_get_info 预检（后续可加 size 比对二次防呆）；
- 浏览器上传仍走 base64 JSON（单文件建议 <100MB）；更大文件后续换 multipart 直传；
- 跨机部署时 staging 共享卷约束不变（见 §2.3）。
