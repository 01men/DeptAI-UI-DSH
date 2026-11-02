# 元冰可 AIOS · Agent 视图

<p><strong>简体中文</strong> · <a href="docs/i18n/en/README.md">English</a> · <a href="docs/i18n/en/README.agent.md">Agent (EN)</a> · <a href="README.md">中文主视图</a></p>

> 本页面向自动化调用方（MCP 客户端、dsh Agent、CI 脚本、远程执行器），只陈述接入所需的事实与安全边界。
> 产品定位、界面与商务信息见[中文主视图](README.md)。所有接口、权限点、环境变量名均为协议键，任何语言版都不翻译。

## 一、这是什么

元冰可是面向企业的 AI 运行与治理平台，自身即一个 MCP 服务端与 REST 数据面。Agent 既可以是平台的**使用者**（调用平台运维工具），也可以是平台的**管理对象**（登记为数字员工，受组织、权限、审批与计量约束）。

## 二、接入点

| 入口 | 形态 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `POST /mcp` | Streamable HTTP JSON-RPC（无会话、无 GET SSE） | Bearer | 平台运维工具面；工具发现结果按调用方权限过滤 |
| `GET /api/openapi.json` | REST 描述（OpenAPI 3.0.3） | Bearer | 当前实例真实路由投影，不写死版本 |
| `GET /api/health` | JSON | 匿名 | 健康检查与面板契约版本 |
| `POST /mcp/services/:slug` | JSON-RPC | Bearer | 面向已登记 MCP 服务的调用面 |
| `/docs/<name>.md` | 静态 Markdown 白名单 | 匿名 | 随包发布的集成文档，可直接取用 |
| CLI `node cli/dshctl.mjs` | 命令行 | Bearer | `--output json` 供机器消费；`--lang` 控制输出语言 |

dsh 挂载形态下，以上路径统一加 `/rq` 前缀。独立实例默认 `http://127.0.0.1:7300`。

**不要假设固定数量。** 工具数、路由数、权限点随版本与调用方权限变化，请以目标实例的运行时返回为准。

## 三、操作边界（必须先满足）

1. **先读后写**：先用只读接口确认目标、状态与自身权限，再进行写入、删除、发布、升级类操作。
2. **授权前置**：写操作需要对应权限点；生命周期类高风险操作（上线/下线/下架/吊销）走 L4 强制审批，Agent 无法自行绕过。
3. **`--dry-run` 是 fail-closed 的**：只有服务端明确实现预演的操作才返回变更预览，其余写请求会被直接拒绝而非静默执行。不要把 `--dry-run` 当作通用的安全检查开关。
4. **凭据是敏感信息**：令牌、口令、密钥、一次性接入码不得写入公开文档、日志或对话回复。
5. **演示态不可写入**：`DEMO_MODE=1` 会把实例全部只读数据面开放给匿名访客，写操作返回 403/405。演示数据不代表真实调用结果。

## 四、身份与权限模型

- **两种主体**：人类用户（Console/Panel 登录）与机器主体（Agent 机器凭据、远程 dsh 接入客户端）。
- **一套授权**：所有调用落到统一的权限点矩阵，`/mcp` 的工具列表按调用方权限过滤；未声明的工具默认拒绝。
- **on-behalf-of**：`X-On-Behalf-User` 头传递真实用户身份，形成用户 → Agent 的令牌链，链路可全量审计。
- **组织血缘**：数据归属到组织；组织缺失时按「调用方组织 → 部门绑定组织 → 平台根组织」兜底，并记录 `orgSource`。显式传入空串 `orgId` 会被拒绝（400），而不是静默写入空归属。

## 五、计量与成本

- 每次能力调用产生 usage 事件，幂等写入（重复投递零重复副作用）。
- 计量键必须在价格簿登记（如 `mcp:*` 用 `tokens`、`model:*` 用 `output_tokens`），不匹配会被显式拒绝，**没有静默零费率兜底**。
- **资产使用凭证**（2026-10-31 起）：Agent 使用平台 skill/MCP 后应主动向 `POST /api/assets/usage-reports` 提报使用事实（幂等键防重；机器主体须已获取该资产，未获取先报 403）。凭证进资产台账与审计，是资产经营侧的使用证据，与计量事件口径互补、互不替代。字段与错误语义见 `docs/agent-onboarding.md` §4.7。
- 平台不提供任何货币结算语义：对外是「透明用量计量 + 内部成本参考」，没有钱包、充值、分成。
- 计费口径缺失时以 `cost_status=not_priced` 显式表达，**未知不等于零成本**。

## 六、失败语义

- REST 统一信封：`ok` / `data` / `error`；错误含稳定 reason code，不要按文案匹配。
- 未匹配的 `/api/*` 对匿名调用方返回 401（鉴权中间件先于路由），不通过 404/401 差异泄露路由是否存在。
- 模型网关只向已配置端点转发；缺端点是被拒绝的调用，不会伪造补全。
- 登录、SSO、客户端凭据均有失败锁定（默认 5 次/15 分钟，可升级至 24 小时）。

## 七、在哪里继续

| 需求 | 去处 |
| --- | --- |
| 机器可读项目概要 | [llms.txt](llms.txt) |
| 按领域查运维手册 | [skills/dsh-ops-admin/SKILL.md](skills/dsh-ops-admin/SKILL.md) |
| 独立部署 / dsh 挂载 / 远程接入 | [docs/deploy-enterprise.md](docs/deploy-enterprise.md) |
| 插件体系与服务边界 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 用量与成本报告口径 | [docs/i18n/en/usage-reporting.md](docs/i18n/en/usage-reporting.md) |
| 接口契约变更历史 | [CHANGELOG.md](CHANGELOG.md) |

本项目采用 [MIT License](LICENSE)。