# hermes 本地直读 guard 改造件（仅产出代码，未部署）

对应开发计划 `dev-plan-nas-authz v1.1` §2.5（强制点②）与 §三 步骤 8。hermes 容器直接读 NAS 本地文件的通道不经网关，需单独设防。**本期只交付代码**，部署随 G2 灰度窗口执行。

## 交付物

| 文件 | 说明 |
|---|---|
| `nas_authz_guard.py` | guard 模块（hook 化核心）：身份取消息 `sender_staff_id`（钉钉 userId），机器凭证调平台 check；fail-closed / readonly 降级 / observeOnly 双通道同步观察；deny 抛 `AuthzDeny`（理由 + 申请入口提示，走 patch4 卡片链路渲染） |
| `apply_patch6.py` | 安装器：hash 锚点校验（不匹配拒绝应用并告警）→ 备份 → 幂等插入一行 import hook → `py_compile` 校验；`--selftest` 本地 fixture 两轮自测（当前通过）；`--rollback` 回滚 |

## 部署（G2 窗口执行）

1. 两个文件放入 `/opt/data/hermes-dingtalk-patch/`（6 实例共享同一脚本）；
2. 按实际 hermes 镜像版本回填 `apply_patch6.py` 的 `TARGET_HASHES`（调度层文件 sha256）与调度层锚点函数名；
3. 各实例 env：`HERMES_AUTHZ_PLATFORM_URL`、`HERMES_AUTHZ_CLIENT_ID/SECRET`（agent 专用机器凭证，最小权限 `nas.authz.check`）、`HERMES_AUTHZ_DEGRADE=deny|readonly`；
4. 灰度：先智造质量平台 0.195 单实例（组织层级最深、班组样本最全）3 天 → 全量；
5. 长期方向：本地直读工具下线、统一网关 MCP 通道后，本补丁退役为兜底（roadmap）。

## 关键语义（与计划 §2.5/§五 对齐）

- G0 双通道同步观察：平台 `observeOnly=true` 时本地 guard 同样不拦截（`HERMES_AUTHZ_OBSERVE_ONLY=1`），避免"网关先强制、本地通道成绕权后门"；
- fail-closed：平台不可达默认拒绝；灰度期可配 `HERMES_AUTHZ_DEGRADE=readonly`（放行读拒写）；
- 补丁应用前 hash 锚点校验，防止上游镜像升级后静默打在错误版本上。
