import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import {
  PlatformEvents,
  newId,
  sha256Hex,
  generateSecret,
  mask
} from "../../platform-core/dist/index.js";
import { t } from "../../platform-i18n/dist/index.js";
import * as iamTools from "./tools.js";
import { DingTalkAuthAdapter, RealDingTalkAuthAdapter } from "./providers.js";
const DEFAULT_TENANT_ID = "t_default";
const SYSTEM_ACTOR = { permissions: ["*"] };
class OrgScopeDeniedError extends Error {
  status = 403;
  code = "FORBIDDEN";
  constructor(message) {
    super(message);
    this.name = "OrgScopeDeniedError";
  }
}
const DEFAULT_GROUP_DRIFT_THRESHOLD = 5;
const AUTO_SYNC_TICK_MS = 6e4;
const AUTO_SYNC_BOOT_DELAY_MS = 9e4;
const AUTO_SYNC_MIN_INTERVAL_MINUTES = 5;
const PermissionCatalog = [
  { point: "console.login", label: "\u767B\u5F55\u63A7\u5236\u53F0", group: "\u57FA\u7840" },
  // 控制台只读基线（2026-10-17 演示模式批次）：工作台聚合/通知/平台信息/工具目录/最近调用
  // 五个纯读路由的声明点。被 console.login 蕴含（判定面规则见 platform-core rest-gate.ts
  // IMPLIED_POINTS），任何可登录角色无需显式授予即通过；单独授予本点不构成登录能力。
  // 免登演示态的只读白名单收录本点（访客可读工作台，拿不到 console.login 本身）。
  { point: "console.read", label: "\u63A7\u5236\u53F0\u53EA\u8BFB\uFF08\u5DE5\u4F5C\u53F0/\u901A\u77E5/\u5E73\u53F0\u4FE1\u606F/\u5DE5\u5177\u76EE\u5F55\uFF09", group: "\u57FA\u7840" },
  { point: "iam.org.read", label: "\u67E5\u770B\u7EC4\u7EC7", group: "\u7EC4\u7EC7\u8D26\u53F7" },
  { point: "iam.org.write", label: "\u7BA1\u7406\u7EC4\u7EC7", group: "\u7EC4\u7EC7\u8D26\u53F7" },
  { point: "iam.user.read", label: "\u67E5\u770B\u8D26\u53F7", group: "\u7EC4\u7EC7\u8D26\u53F7" },
  { point: "iam.user.write", label: "\u7BA1\u7406\u8D26\u53F7", group: "\u7EC4\u7EC7\u8D26\u53F7" },
  { point: "iam.user.freeze", label: "\u51BB\u7ED3/\u6CE8\u9500\u8D26\u53F7", group: "\u7EC4\u7EC7\u8D26\u53F7" },
  { point: "iam.role.write", label: "\u7BA1\u7406\u89D2\u8272", group: "\u7EC4\u7EC7\u8D26\u53F7" },
  { point: "iam.connector.write", label: "\u7BA1\u7406\u4E09\u65B9\u63A5\u5165", group: "\u7EC4\u7EC7\u8D26\u53F7" },
  { point: "iam.scene.write", label: "\u7BA1\u7406\u573A\u666F\u7EA7\u6388\u6743\u7B56\u7565\uFF08\u573A\u666F ABAC\uFF09", group: "\u7EC4\u7EC7\u8D26\u53F7" },
  { point: "iam.roster.read", label: "\u8BFB\u53D6\u5168\u5458\u540D\u518C\uFF08\u7EC4\u7EC7\u6570\u636E\u901A\u9053\uFF0C\u63A5\u5165\u5E94\u7528\u62C9\u53D6\uFF09", group: "\u7EC4\u7EC7\u8D26\u53F7" },
  { point: "authn.principal.read", label: "\u67E5\u770B\u8EAB\u4EFD/\u51ED\u8BC1", group: "\u7EDF\u4E00\u8BA4\u8BC1" },
  { point: "authn.principal.write", label: "\u7BA1\u7406\u673A\u5668\u51ED\u8BC1", group: "\u7EDF\u4E00\u8BA4\u8BC1" },
  { point: "authn.token.issue", label: "\u7B7E\u53D1\u4EE4\u724C", group: "\u7EDF\u4E00\u8BA4\u8BC1" },
  { point: "authn.token.revoke", label: "\u540A\u9500\u4EE4\u724C", group: "\u7EDF\u4E00\u8BA4\u8BC1" },
  { point: "authn.oidc.read", label: "\u67E5\u770B OIDC \u5BA2\u6237\u7AEF", group: "\u7EDF\u4E00\u8BA4\u8BC1" },
  { point: "authn.oidc.write", label: "\u7BA1\u7406 OIDC \u5BA2\u6237\u7AEF\uFF08\u7B7E\u53D1/\u8F6E\u6362/\u7981\u7528\uFF09", group: "\u7EDF\u4E00\u8BA4\u8BC1" },
  { point: "mcp.service.read", label: "\u67E5\u770B MCP \u670D\u52A1", group: "MCP" },
  // W3-T5（MCP 治理契约 §12/§15）：scope 模板读取点（POST /api/mcp/perm-groups/:id/scope-template，
  // dry 语义不落库）——目录缺此点时 resource_admin 的 mcp.* 通配无法展开到它（全量 403）
  { point: "mcp.permgroup.read", label: "\u8BFB\u53D6 MCP \u6743\u9650\u7EC4\u4E0E scope \u6A21\u677F", group: "MCP" },
  { point: "mcp.service.write", label: "\u7BA1\u7406 MCP \u670D\u52A1", group: "MCP" },
  { point: "mcp.service.deploy", label: "\u90E8\u7F72/\u7070\u5EA6 MCP", group: "MCP" },
  { point: "mcp.service.offline", label: "\u4E0B\u7EBF MCP", group: "MCP" },
  { point: "mcp.permgroup.write", label: "\u7BA1\u7406 MCP \u6743\u9650\u7EC4", group: "MCP" },
  { point: "mcp.invoke", label: "\u8C03\u7528 MCP \u7F51\u5173", group: "MCP" },
  // W 批次 W1（2026-10-15，V11 根治）：MCP 工具可信风险登记审批面——登记/两级审批/重审清单/退场
  { point: "mcp.risk.admin", label: "MCP \u5DE5\u5177\u98CE\u9669\u767B\u8BB0\u5BA1\u6279\uFF08\u767B\u8BB0/\u4E24\u7EA7\u5BA1\u6279/\u91CD\u5BA1\u6E05\u5355\uFF09", group: "MCP" },
  // 连接器纳管（SaaS 数据面网关；invoke 独立权限点对齐 mcp.invoke 先例）
  { point: "connector.gateway.write", label: "\u914D\u7F6E\u8FDE\u63A5\u5668\u7F51\u5173\u4E0E\u5065\u5EB7\u64CD\u4F5C", group: "\u8FDE\u63A5\u5668" },
  { point: "connector.catalog.read", label: "\u6D4F\u89C8\u8FDE\u63A5\u5668\u76EE\u5F55", group: "\u8FDE\u63A5\u5668" },
  { point: "connector.connection.read", label: "\u67E5\u770B\u8FDE\u63A5\u5668\u8FDE\u63A5\uFF08org \u5185\uFF09", group: "\u8FDE\u63A5\u5668" },
  { point: "connector.connection.write", label: "\u521B\u5EFA/\u5220\u9664\u8FDE\u63A5\u5668\u8FDE\u63A5\uFF08\u542B OAuth \u53D1\u8D77\uFF09", group: "\u8FDE\u63A5\u5668" },
  { point: "connector.invoke", label: "\u8C03\u7528\u8FDE\u63A5\u5668 action", group: "\u8FDE\u63A5\u5668" },
  { point: "connector.permgroup.write", label: "\u7BA1\u7406\u8FDE\u63A5\u5668\u6743\u9650\u7EC4", group: "\u8FDE\u63A5\u5668" },
  { point: "connector.runs.read", label: "\u67E5\u770B\u8FDE\u63A5\u5668\u8FD0\u884C\u65E5\u5FD7/\u5BF9\u8D26\u89C6\u56FE", group: "\u8FDE\u63A5\u5668" },
  // connector.market.publish 移除（E-06 权限点卫生）：全仓无任何消费闸门（无 guarded/requirePermission/
  // hasPermission 引用），亦无内置角色持有；上架动作由 market.submit 契约 + 市场审批流承载。
  { point: "skill.read", label: "\u6D4F\u89C8 Skill \u5E02\u573A", group: "Skill \u5E02\u573A" },
  { point: "skill.submit", label: "\u63D0\u4EA4 Skill", group: "Skill \u5E02\u573A" },
  { point: "skill.approve", label: "\u5BA1\u6279 Skill", group: "Skill \u5E02\u573A" },
  { point: "skill.publish", label: "\u4E0A\u67B6/\u4E0B\u67B6 Skill", group: "Skill \u5E02\u573A" },
  { point: "skill.install", label: "\u5B89\u88C5 Skill", group: "Skill \u5E02\u573A" },
  { point: "skill.storage.write", label: "\u914D\u7F6E Skill \u5305\u5B58\u50A8\u540E\u7AEF\uFF08\u672C\u5730/NAS\uFF09", group: "Skill \u5E02\u573A" },
  { point: "nas.read", label: "\u67E5\u770B NAS \u5B58\u50A8", group: "NAS \u5B58\u50A8" },
  { point: "nas.write", label: "\u7BA1\u7406 NAS \u5B58\u50A8\uFF08\u7EB3\u7BA1/\u4E0A\u7EBF/\u6587\u4EF6\u8BFB\u5199\uFF09", group: "NAS \u5B58\u50A8" },
  // NAS 数据权限（dev-plan-nas-authz §2.3）：check 供网关/hermes 专用资源账号调用，read/write 供规则管理
  { point: "nas.authz.check", label: "NAS \u6570\u636E\u6743\u9650\u5224\u5B9A\uFF08check/scope\uFF09", group: "NAS \u5B58\u50A8" },
  { point: "nas.authz.read", label: "\u67E5\u770B NAS \u6570\u636E\u6743\u9650\u89C4\u5219\u4E0E\u5224\u5B9A\u7559\u75D5", group: "NAS \u5B58\u50A8" },
  { point: "nas.authz.write", label: "\u7BA1\u7406 NAS \u6570\u636E\u6743\u9650\u89C4\u5219/\u4F8B\u5916\uFF08\u542B\u7834\u7A97 override\uFF09", group: "NAS \u5B58\u50A8" },
  // 孤儿权限点补录（R10 总表发现，2026-10-13）：plugin-nas/manifest/permissions.yaml 已声明、
  // console 两处 guarded 路由（所有权登记/改写）实际校验，但目录此前未收录——自定义角色无法勾选
  { point: "nas.ownership.write", label: "\u7BA1\u7406 NAS \u6587\u4EF6\u6240\u6709\u6743\uFF08\u4E0A\u4F20\u767B\u8BB0/\u91CD\u547D\u540D\u6539\u5199/\u5220\u9664\u79FB\u9664\uFF09", group: "NAS \u5B58\u50A8" },
  { point: "agent.read", label: "\u67E5\u770B Agent", group: "Agent \u672C\u4F53" },
  { point: "agent.write", label: "\u7BA1\u7406 Agent", group: "Agent \u672C\u4F53" },
  { point: "agent.approve", label: "\u5BA1\u6279 Agent \u4E0A\u7EBF", group: "Agent \u672C\u4F53" },
  { point: "agent.offline", label: "\u4E0B\u7EBF Agent", group: "Agent \u672C\u4F53" },
  { point: "agent.a2a.invoke", label: "A2A \u8DE8\u8FD0\u884C\u65F6\u70B9\u540D\u8C03\u7528\uFF08IAW 7-1\uFF09", group: "Agent \u672C\u4F53" },
  { point: "app.read", label: "\u67E5\u770B AI \u5E94\u7528", group: "AI \u5E94\u7528" },
  { point: "app.write", label: "\u7BA1\u7406 AI \u5E94\u7528", group: "AI \u5E94\u7528" },
  { point: "app.offline", label: "\u4E0B\u7EBF AI \u5E94\u7528", group: "AI \u5E94\u7528" },
  // 应用外部凭证取值（issue #19，2026-10-31）：独立权限点——登记/轮换沿用 app.write，
  // 取值（拿到明文）单独授权 + 逐次审计；缺省无内置角色持有（按需显式授权，最小披露面）
  { point: "app.credential.fetch", label: "\u53D6\u7528\u5E94\u7528\u5916\u90E8\u51ED\u8BC1\uFF08\u6BCF\u6B21\u53D6\u7528\u843D\u5BA1\u8BA1\uFF09", group: "AI \u5E94\u7528" },
  // 数据要素域（IAW 交接 2-1..2-4）：数据集登记/质量分/血缘/指标字典
  { point: "resource.dataset.write", label: "\u7BA1\u7406\u6570\u636E\u8981\u7D20\uFF08\u6570\u636E\u96C6/\u8D28\u91CF\u5206/\u8840\u7F18/\u6307\u6807\u5B57\u5178\uFF09", group: "\u6570\u636E\u8981\u7D20" },
  { point: "audit.read", label: "\u67E5\u770B\u5BA1\u8BA1\u65E5\u5FD7", group: "\u5BA1\u8BA1" },
  { point: "audit.rule.write", label: "\u7BA1\u7406\u544A\u8B66\u89C4\u5219", group: "\u5BA1\u8BA1" },
  { point: "approval.read", label: "\u67E5\u770B\u5BA1\u6279\u4E2D\u5FC3", group: "\u5BA1\u6279" },
  { point: "approval.decide", label: "\u5BA1\u6279\u51B3\u7B56", group: "\u5BA1\u6279" },
  { point: "usage.read", label: "\u67E5\u770B\u8BA1\u91CF\u6D41\u6C34", group: "\u7528\u91CF\u8BA1\u91CF" },
  { point: "usage.write", label: "\u767B\u8BB0\u8BA1\u91CF\u4E8B\u4EF6", group: "\u7528\u91CF\u8BA1\u91CF" },
  { point: "usage.admin", label: "\u7BA1\u7406\u4EF7\u683C\u7C3F/\u5BF9\u8D26/\u80FD\u529B\u6388\u6743", group: "\u7528\u91CF\u8BA1\u91CF" },
  { point: "modelgw.read", label: "\u67E5\u770B\u6A21\u578B\u7F51\u5173", group: "\u6A21\u578B\u7F51\u5173" },
  { point: "modelgw.invoke", label: "\u8C03\u7528\u6A21\u578B\u7F51\u5173", group: "\u6A21\u578B\u7F51\u5173" },
  { point: "modelgw.admin", label: "\u7BA1\u7406\u6A21\u578B\u76EE\u5F55", group: "\u6A21\u578B\u7F51\u5173" },
  { point: "market.read", label: "\u6D4F\u89C8\u63D2\u4EF6\u5E02\u573A", group: "\u63D2\u4EF6\u5E02\u573A" },
  // market.submit 移除（E-06 权限点卫生）：提交面 POST /api/market/submit 走开发者身份自校验
  // （access=authenticated + developerCaller），该权限点全仓无消费、无角色持有。
  { point: "market.approve", label: "\u5BA1\u6279\u63D2\u4EF6", group: "\u63D2\u4EF6\u5E02\u573A" },
  { point: "market.install", label: "\u5B89\u88C5\u63D2\u4EF6", group: "\u63D2\u4EF6\u5E02\u573A" },
  { point: "market.developer", label: "\u5F00\u53D1\u8005\u95E8\u6237", group: "\u63D2\u4EF6\u5E02\u573A" },
  { point: "connect.manage", label: "\u7BA1\u7406\u5E73\u53F0\u63A5\u5165\uFF08\u63A5\u5165\u7801/\u8FDC\u7A0B\u5BA2\u6237\u7AEF\uFF09", group: "\u5E73\u53F0\u63A5\u5165" },
  { point: "platform.update.read", label: "\u67E5\u770B/\u89E6\u53D1\u5E73\u53F0\u66F4\u65B0\u68C0\u67E5", group: "\u5E73\u53F0\u7EF4\u62A4" },
  { point: "platform.update.apply", label: "\u6267\u884C\u5E73\u53F0\u5347\u7EA7\uFF08git pull + npm install\uFF09", group: "\u5E73\u53F0\u7EF4\u62A4" },
  // 部门面板（review-dsh-agent-panel-v2 Phase 0：D3 裁决——无 dingtalk.* 事件权限点、总线订阅不需权限点）
  { point: "panel.read", label: "\u67E5\u770B\u90E8\u95E8\u9762\u677F\uFF08\u4F1A\u8BDD/\u770B\u677F/\u77E5\u8BC6/\u56FE\u8C31\uFF09", group: "\u90E8\u95E8\u9762\u677F" },
  { point: "panel.write", label: "\u9762\u677F\u534F\u4F5C\uFF08\u53D1\u6D88\u606F/\u5EFA\u9891\u9053/\u5361\u7247\u52A8\u4F5C/\u6FC0\u6D3B\u7533\u8BF7\uFF09", group: "\u90E8\u95E8\u9762\u677F" },
  { point: "panel.task.write", label: "\u9762\u677F\u4EFB\u52A1\u6D41\u8F6C\uFF08\u521B\u5EFA/\u6CF3\u9053\u8FC1\u79FB\uFF09", group: "\u90E8\u95E8\u9762\u677F" },
  { point: "panel.config.write", label: "\u9762\u677F\u914D\u7F6E\uFF08widget/KPI \u5E03\u5C40/\u56FE\u8C31\u91CD\u8F7D\uFF09", group: "\u90E8\u95E8\u9762\u677F" },
  { point: "scenegraph.read", label: "\u67E5\u770B\u884C\u4E1A\u573A\u666F\u56FE\u8C31", group: "\u90E8\u95E8\u9762\u677F" },
  // scenegraph.activate 移除（E-06 权限点卫生）：行业激活的实际闸门是 panel.write（激活申请）
  // 与 market.approve（审批执行），该点全仓无消费；org_admin 迁移批次同步摘除（存量库已
  // 落库的点由管理员按角色编辑回收，迁移只补缺不删改）。
  { point: "dingtalk.message.send", label: "\u9489\u9489\u6865\u63A5\u6D88\u606F\u6295\u9012\uFF08\u7FA4\u6865\u7ED1\u5B9A/\u63A8\u9001/\u56DE\u51B3\u56DE\u8C03\uFF09", group: "\u90E8\u95E8\u9762\u677F" },
  // 事务流引擎（IAW 交接 3-1..3-4，宿主新域 flow）
  { point: "flow.read", label: "\u67E5\u770B\u4E8B\u52A1\u6D41\uFF08\u7F16\u6392/\u6A21\u677F/SLA\uFF09", group: "\u4E8B\u52A1\u6D41" },
  { point: "flow.write", label: "\u4E8B\u52A1\u6D41\u6D41\u8F6C\uFF08\u521B\u5EFA\u5B9E\u4F8B/\u6B65\u9AA4\u63A8\u8FDB/\u53D6\u6D88\uFF09", group: "\u4E8B\u52A1\u6D41" },
  { point: "flow.admin", label: "\u7BA1\u7406\u4E8B\u52A1\u6D41\u6A21\u677F\u5E93", group: "\u4E8B\u52A1\u6D41" },
  // 执行中枢（2026-10-14 路线图 R5/R10 前置，plugin-exec-hub 域）：权限点此前只在
  // plugin-exec-hub/plugin.yaml 声明、目录未收录（自定义角色无法勾选，同 nas.ownership.write
  // 孤儿点先例）——收录后内置角色与自定义角色才能按粒度授权
  { point: "exec.read", label: "\u67E5\u770B\u6267\u884C\u4E2D\u67A2\uFF08\u76EE\u6807/\u4EFB\u52A1/\u5524\u9192/\u5FC3\u8DF3\uFF09", group: "\u6267\u884C\u4E2D\u67A2" },
  { point: "exec.write", label: "\u64CD\u4F5C\u6267\u884C\u4E2D\u67A2\u4EFB\u52A1", group: "\u6267\u884C\u4E2D\u67A2" },
  { point: "exec.admin", label: "\u6267\u884C\u4E2D\u67A2\u8FD0\u7EF4\uFF08\u624B\u52A8 tick \u7B49\uFF09", group: "\u6267\u884C\u4E2D\u67A2" },
  // 数字员工域（W 批次，plugin-workforce）：权限点此前只在 plugin.yaml/permissions.yaml 声明、
  // 目录未收录（exec.* 孤儿点同先例）——收录后 authn 机器凭证才能签发 workforce.* scope、
  // 内置角色与自定义角色才能按粒度授权（W5 运维面 workforce.admin 同批销账）
  { point: "workforce.read", label: "\u67E5\u770B\u6570\u5B57\u5458\u5DE5\u57DF\uFF08\u5458\u5DE5/\u4EFB\u7528/\u8C03\u7528/\u4EA4\u4ED8\uFF09", group: "\u6570\u5B57\u5458\u5DE5" },
  { point: "workforce.write", label: "\u7BA1\u7406\u6570\u5B57\u5458\u5DE5\u57DF\uFF08\u5458\u5DE5/\u7ED1\u5B9A/\u4EFB\u7528\uFF09", group: "\u6570\u5B57\u5458\u5DE5" },
  { point: "workforce.admin", label: "\u6570\u5B57\u5458\u5DE5\u8FD0\u7EF4\uFF08\u6279\u91CF\u505C\u590D\u804C/\u5BA1\u8BA1\u62A5\u8868/\u53F0\u8D26\u6E05\u7406\uFF09", group: "\u6570\u5B57\u5458\u5DE5" },
  { point: "workforce.invoke", label: "\u6570\u5B57\u5458\u5DE5\u53D7\u63A7\u8C03\u7528\uFF08\u8BA4\u9886/\u7EED\u79DF/\u53D7\u63A7\u6267\u884C\uFF09", group: "\u6570\u5B57\u5458\u5DE5" },
  { point: "workforce.accept", label: "\u6570\u5B57\u5458\u5DE5\u4EA4\u4ED8\u9A8C\u6536\uFF08\u63D0\u4EA4/\u51B3\u5B9A\uFF09", group: "\u6570\u5B57\u5458\u5DE5" }
];
const BuiltinRoles = [
  { code: "super_admin", name: "\u5E73\u53F0\u8D85\u7EA7\u7BA1\u7406\u5458", builtin: true, description: "\u62E5\u6709\u5168\u90E8\u6743\u9650\u70B9", permissions: ["*"] },
  // org_admin 补 exec.*（2026-10-14 执行中枢纳管）：组织管理员对本组织执行中枢全权（与 iam.* 同口径）
  // + workforce.*（W 批次 2026-10-15）：本组织数字员工域全权（与 BUILTIN_ROLE_MIGRATION 两处同步）
  { code: "org_admin", name: "\u7EC4\u7EC7\u7BA1\u7406\u5458", builtin: true, description: "\u7BA1\u7406\u672C\u7EC4\u7EC7\u8D26\u53F7\u4E0E\u7528\u6237\u7EC4", permissions: ["console.login", "iam.*", "approval.read", "exec.*", "workforce.*"] },
  // resource_admin 补 exec.read + modelgw.read（2026-10-14）：资源管理员可查看执行中枢（操作 Agent 的运行面）
  // 与模型目录（R2-B：渠道分级/预算治理需要看到模型清单，写面仍归 modelgw.admin）
  // + workforce.read（W 批次 2026-10-15）：资源管理员可查看数字员工域（员工消费其所管资源，运维面仍归 org_admin）
  { code: "resource_admin", name: "\u8D44\u6E90\u7BA1\u7406\u5458", builtin: true, description: "\u7BA1\u7406 MCP/Skill/Agent/\u5E94\u7528/NAS/\u8FDE\u63A5\u5668\u8D44\u6E90\u4E0E\u6570\u636E\u8981\u7D20", permissions: ["console.login", "mcp.*", "skill.*", "agent.*", "app.*", "nas.*", "authn.oidc.*", "connector.*", "resource.dataset.write", "panel.read", "flow.read", "approval.read", "modelgw.read", "exec.read", "workforce.read"] },
  { code: "developer", name: "\u5F00\u53D1\u8005", builtin: true, description: "\u63D0\u4EA4\u4E0E\u8C03\u8BD5\u8D44\u6E90\uFF08\u5E94\u7528\u9650\u81EA\u8EAB owner \u8303\u56F4\uFF0C\u670D\u52A1\u7AEF\u6821\u9A8C\uFF09", permissions: ["console.login", "iam.user.read", "iam.org.read", "mcp.service.read", "mcp.invoke", "skill.read", "skill.submit", "skill.install", "agent.read", "agent.write", "app.read", "app.write", "nas.read", "connector.catalog.read", "connector.connection.read", "connector.invoke", "exec.read", "exec.write"] },
  { code: "member", name: "\u666E\u901A\u7528\u6237", builtin: true, description: "\u6D4F\u89C8\u5E02\u573A\u4E0E\u53EF\u7528\u8D44\u6E90", permissions: ["console.login", "skill.read", "agent.read", "app.read", "panel.read", "panel.write", "panel.task.write", "scenegraph.read", "flow.read", "flow.write", "exec.read", "exec.write"] },
  { code: "auditor", name: "\u5BA1\u8BA1\u5458\uFF08\u53EA\u8BFB\uFF09", builtin: true, description: "\u5168\u5E73\u53F0\u53EA\u8BFB\u5BA1\u8BA1", permissions: ["console.login", "iam.org.read", "iam.user.read", "authn.principal.read", "authn.oidc.read", "mcp.service.read", "skill.read", "agent.read", "app.read", "nas.read", "audit.read", "approval.read", "connector.runs.read", "connector.connection.read", "exec.read"] }
];
const BUILTIN_ROLE_MIGRATION = {
  // resource_admin 补治理读面（外部 QA-20261014 QA-03）：数据集/指标/血缘等读路由挂 panel.read、
  // 事务流模板与实例列表挂 flow.read——此前资源管理员"能写（resource.dataset.write/flow.admin）不能读"
  // + exec.read/modelgw.read（2026-10-14 执行中枢与模型目录读面，与 BuiltinRoles 两处必须同步）
  resource_admin: ["connector.gateway.write", "connector.catalog.read", "connector.connection.read", "connector.connection.write", "connector.invoke", "connector.permgroup.write", "connector.runs.read", "resource.dataset.write", "flow.admin", "panel.read", "flow.read", "modelgw.read", "exec.read"],
  // developer 补 agent.write：与 app.write 对称——开发者应能注册/提报更新 Agent（2026-08 修复"总是报没有 agent.write 权限"）
  // + exec.read/exec.write（2026-10-14）：开发者可在执行中枢查看与操作自己发起的任务
  developer: ["connector.catalog.read", "connector.connection.read", "connector.invoke", "agent.write", "panel.read", "scenegraph.read", "flow.read", "exec.read", "exec.write"],
  // auditor 补 nas.authz.read：审计员可查看 NAS 数据权限规则与判定留痕（dev-plan-nas-authz §2.3）
  // + exec.read（2026-10-14）：执行中枢任务/唤醒留痕纳入只读审计面
  auditor: ["connector.runs.read", "connector.connection.read", "nas.authz.read", "panel.read", "scenegraph.read", "flow.read", "exec.read"],
  // 部门面板（review-dsh-agent-panel-v2 Phase 0）：业务成员=member 直用面板；org_admin 增配置；
  // 存量库经迁移补点，新装库直接来自 BuiltinRoles 定义（两处必须同步）
  // + exec.read/exec.write（2026-10-14）：普通用户可在执行中枢发起/查看自己的任务
  member: ["panel.read", "panel.write", "panel.task.write", "scenegraph.read", "flow.read", "flow.write", "exec.read", "exec.write"],
  // org_admin 增 exec.*（2026-10-14）：本组织执行中枢全权（读/写/运维 tick，与 iam.* 通配同口径）
  // scenegraph.activate 摘除（E-06）：全仓无消费死点（见 PermissionCatalog 内注）
  // + workforce.*（W 批次 2026-10-15）：本组织数字员工域全权（运维面 workforce.admin 与 exec.admin 同口径）
  org_admin: ["panel.read", "panel.write", "panel.task.write", "panel.config.write", "scenegraph.read", "flow.read", "flow.write", "flow.admin", "exec.*", "workforce.*"]
};
const CONNECTOR_ROLE_MIGRATION = BUILTIN_ROLE_MIGRATION;
class DingTalkConnector {
  provider = "dingtalk";
  label = "\u9489\u9489";
  directory = {
    orgs: [
      { remoteId: "dd_root", name: "\u5143\u51B0\u53EF\u96C6\u56E2", parentRemoteId: null, managerRemoteIds: ["staff_001"] },
      { remoteId: "dd_tech", name: "\u6280\u672F\u4E2D\u5FC3", parentRemoteId: "dd_root", managerRemoteIds: ["staff_001"] },
      { remoteId: "dd_ai", name: "AI \u5E73\u53F0\u90E8", parentRemoteId: "dd_tech", managerRemoteIds: ["staff_002"] },
      { remoteId: "dd_be", name: "\u540E\u7AEF\u90E8", parentRemoteId: "dd_tech", managerRemoteIds: ["staff_004"] },
      { remoteId: "dd_fe", name: "\u524D\u7AEF\u90E8", parentRemoteId: "dd_tech", managerRemoteIds: ["staff_005"] },
      { remoteId: "dd_prod", name: "\u4EA7\u54C1\u8FD0\u8425\u90E8", parentRemoteId: "dd_root", managerRemoteIds: ["staff_006"] },
      { remoteId: "dd_mkt", name: "\u5E02\u573A\u90E8", parentRemoteId: "dd_root", managerRemoteIds: ["staff_008"] }
    ],
    users: [
      { remoteId: "dd_u001", remoteUserId: "staff_001", name: "\u9648\u8FDC\u821F", jobNumber: "DD0001", title: "\u6280\u672F\u603B\u76D1", orgRemoteId: "dd_tech", email: "chenyz@yuanbingke.com", active: true },
      { remoteId: "dd_u002", remoteUserId: "staff_002", name: "\u6797\u5C0F\u6EE1", jobNumber: "DD0002", title: "\u7B97\u6CD5\u5DE5\u7A0B\u5E08", orgRemoteId: "dd_ai", email: "linxm@yuanbingke.com", active: true },
      { remoteId: "dd_u003", remoteUserId: "staff_003", name: "\u5468\u65E2\u767D", jobNumber: "DD0003", title: "\u7B97\u6CD5\u5DE5\u7A0B\u5E08", orgRemoteId: "dd_ai", email: "zhoujb@yuanbingke.com", active: true },
      { remoteId: "dd_u004", remoteUserId: "staff_004", name: "\u82CF\u781A\u79CB", jobNumber: "DD0004", title: "\u540E\u7AEF\u5DE5\u7A0B\u5E08", orgRemoteId: "dd_be", email: "suyq@yuanbingke.com", active: true },
      { remoteId: "dd_u005", remoteUserId: "staff_005", name: "\u4F55\u9752\u68A7", jobNumber: "DD0005", title: "\u524D\u7AEF\u5DE5\u7A0B\u5E08", orgRemoteId: "dd_fe", email: "heqw@yuanbingke.com", active: true },
      { remoteId: "dd_u006", remoteUserId: "staff_006", name: "\u987E\u661F\u9611", jobNumber: "DD0006", title: "\u4EA7\u54C1\u7ECF\u7406", orgRemoteId: "dd_prod", email: "guxl@yuanbingke.com", active: true },
      { remoteId: "dd_u007", remoteUserId: "staff_007", name: "\u53F6\u6816\u8FDF", jobNumber: "DD0007", title: "\u8FD0\u8425\u4E13\u5458", orgRemoteId: "dd_prod", email: "yqz@yuanbingke.com", active: true },
      { remoteId: "dd_u008", remoteUserId: "staff_008", name: "\u5B5F\u758F\u6850", jobNumber: "DD0008", title: "\u5E02\u573A\u4E13\u5458", orgRemoteId: "dd_mkt", email: "mst@yuanbingke.com", active: true },
      { remoteId: "dd_u009", remoteUserId: "staff_009", name: "\u5468\u660E\u6F9C", jobNumber: "DD0009", title: "\u524D\u7AEF\u5DE5\u7A0B\u5E08", orgRemoteId: "dd_fe", extraOrgRemoteIds: ["dd_be"], email: "zhml@yuanbingke.com", active: true },
      { remoteId: "dd_u010", remoteUserId: "staff_010", name: "\u59DC\u53D9\u767D", jobNumber: "DD0010", title: "\u6570\u636E\u5DE5\u7A0B\u5E08", orgRemoteId: "dd_be", email: "jxb@yuanbingke.com", active: false }
    ]
  };
  async fetchDirectory() {
    await delay(120 + Math.floor(Math.random() * 80));
    return structuredClone(this.directory);
  }
  async healthCheck() {
    const started = Date.now();
    await delay(40);
    return { ok: true, latencyMs: Date.now() - started, message: t("\u964D\u7EA7\u6A21\u5F0F\uFF1A\u672A\u914D\u7F6E\u9489\u9489\u4F01\u4E1A\u51ED\u8BC1\uFF0C\u4F7F\u7528\u5185\u7F6E\u6F14\u793A\u76EE\u5F55"), mock: true };
  }
}
class RealDingTalkConnector {
  provider = "dingtalk";
  label = "\u9489\u9489";
  corpTokenCache;
  credentials;
  /** 同步根部门 ID（缺省 1=企业根）。 */
  syncOrgRoot;
  constructor(credentials, options = {}) {
    this.credentials = credentials;
    this.syncOrgRoot = options.syncOrgRoot?.trim() || "1";
  }
  get apiBase() {
    return this.credentials.apiBase ?? "https://api.dingtalk.com";
  }
  get oapiBase() {
    return this.credentials.oapiBase ?? "https://oapi.dingtalk.com";
  }
  async corpAccessToken() {
    if (this.corpTokenCache && this.corpTokenCache.expiresAt > Date.now() + 6e4) {
      return this.corpTokenCache.token;
    }
    const response = await fetch(`${this.apiBase}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: this.credentials.appKey, appSecret: this.credentials.appSecret })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.accessToken) {
      throw new Error(t("\u9489\u9489\u4F01\u4E1A accessToken \u83B7\u53D6\u5931\u8D25\uFF08HTTP {status}\uFF09", { status: response.status }));
    }
    this.corpTokenCache = { token: payload.accessToken, expiresAt: Date.now() + (payload.expireIn ?? 7200) * 1e3 };
    return payload.accessToken;
  }
  /** 调 oapi topapi：access_token 走 query；errcode != 0 即抛错（不静默吞错）。 */
  async topapi(path, body) {
    const token = await this.corpAccessToken();
    const response = await fetch(`${this.oapiBase}${path}?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (payload.errcode ?? 0) !== 0) {
      throw new Error(t("\u9489\u9489\u63A5\u53E3 {path} \u8C03\u7528\u5931\u8D25\uFF08HTTP {status}\uFF0Cerrcode {errcode}\uFF1A{errmsg}\uFF09", { path, status: response.status, errcode: payload.errcode ?? "-", errmsg: payload.errmsg ?? t("\u65E0\u9519\u8BEF\u4FE1\u606F") }));
    }
    return payload;
  }
  async fetchDirectory() {
    const rootId = this.syncOrgRoot;
    const rootInfo = await this.getDepartment(rootId);
    const orgs = [{ remoteId: rootId, name: rootInfo.name, parentRemoteId: null, ...rootInfo.managerRemoteIds ? { managerRemoteIds: rootInfo.managerRemoteIds } : {} }];
    const users = [];
    let frontier = [rootId];
    for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
      const next = [];
      for (const deptId of frontier.slice(0, 50)) {
        for (const childId of await this.listSubDepartmentIds(deptId)) {
          const child = await this.getDepartment(childId);
          orgs.push({ remoteId: childId, name: child.name, parentRemoteId: deptId, ...child.managerRemoteIds ? { managerRemoteIds: child.managerRemoteIds } : {} });
          next.push(childId);
        }
      }
      frontier = next;
    }
    for (const org of orgs) {
      const members = await this.listUsers(org.remoteId);
      for (const member of members) {
        const existing = users.find((user) => user.remoteId === member.remoteId);
        if (existing) {
          if (existing.orgRemoteId !== org.remoteId && !(existing.extraOrgRemoteIds ?? []).includes(org.remoteId)) {
            existing.extraOrgRemoteIds = [...existing.extraOrgRemoteIds ?? [], org.remoteId];
          }
          continue;
        }
        users.push({ ...member, orgRemoteId: org.remoteId });
      }
    }
    for (const user of users) {
      const deptIds = (user.deptRemoteIds ?? []).filter((id) => id === user.orgRemoteId || orgs.some((org) => org.remoteId === id));
      if (deptIds.length > 0 && deptIds[0] !== user.orgRemoteId) {
        const rest = [user.orgRemoteId, ...user.extraOrgRemoteIds ?? []].filter((id) => id !== deptIds[0]);
        user.orgRemoteId = deptIds[0];
        user.extraOrgRemoteIds = [...new Set(rest)];
      }
    }
    return { orgs, users };
  }
  /** 部门详情（取名 + 负责人列表；根部门 dept_id=1 返回企业名）。 */
  async getDepartment(deptId) {
    const payload = await this.topapi("/topapi/v2/department/get", { dept_id: Number(deptId) });
    const managerRemoteIds = (payload.result?.dept_manager_userid_list ?? []).filter((id) => Boolean(id));
    return { name: payload.result?.name ?? t("\u90E8\u95E8 {deptId}", { deptId }), ...managerRemoteIds.length > 0 ? { managerRemoteIds } : {} };
  }
  /** 下一级子部门 ID 列表（不受授权范围限制）。 */
  async listSubDepartmentIds(deptId) {
    const payload = await this.topapi("/topapi/v2/department/listsubid", { dept_id: Number(deptId) });
    return (payload.result?.dept_id_list ?? []).map(String);
  }
  async listUsers(deptId) {
    const users = [];
    let cursor = 0;
    for (let page = 0; page < 10; page++) {
      const payload = await this.topapi("/topapi/v2/user/list", { dept_id: Number(deptId), cursor, size: 100 });
      const result = payload.result ?? {};
      for (const item of result.list ?? []) {
        const remoteId = item.unionid ?? item.userid;
        if (!remoteId) continue;
        const deptRemoteIds = (item.dept_id_list ?? []).map(String).filter(Boolean);
        users.push({
          remoteId,
          ...item.userid && item.userid !== remoteId ? { remoteUserId: item.userid } : {},
          name: item.name ?? remoteId,
          jobNumber: item.job_number || remoteId,
          title: item.title ?? "",
          orgRemoteId: deptId,
          ...deptRemoteIds.length > 1 ? { deptRemoteIds } : {},
          email: item.email || item.org_email || "",
          active: item.active ?? true
        });
      }
      if (!result.has_more) break;
      cursor = Number(result.next_cursor ?? cursor + 100);
    }
    return users;
  }
  async healthCheck() {
    const started = Date.now();
    try {
      await this.corpAccessToken();
      return { ok: true, latencyMs: Date.now() - started, message: t("\u9489\u9489 OpenAPI \u8FDE\u901A\u6B63\u5E38\uFF08\u771F\u5B9E\u6A21\u5F0F\uFF09"), mock: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, latencyMs: Date.now() - started, message, mock: false };
    }
  }
}
function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
class IamService extends Service {
  static provide = "iam";
  /**
   * 内置连接器实现范围（applyConnectorMode 能直接实例化的 provider）。
   * 配置保存以「可实现」为准放行，而非「当前已注册」——否则生产基线（无 DEMO_SEED、
   * 注册表为空）首次保存钉钉凭证会被守卫拦死，形成「先有配置才能注册、先注册才能存配置」死锁。
   */
  static BUILTIN_CONNECTOR_PROVIDERS = /* @__PURE__ */ new Set(["dingtalk"]);
  /** 运行时注册表：key 为配置实例 ID（DEMO_SEED 内置 mock 用 'demo:dingtalk'），provider 仅表示平台类型。 */
  connectors = /* @__PURE__ */ new Map();
  authProviders = /* @__PURE__ */ new Map();
  /** 自动同步去重：同一配置实例上一轮尚未结束时跳过（同步耗时超过巡检周期时不叠加并发）。 */
  autoSyncing = /* @__PURE__ */ new Set();
  autoSyncTimer;
  constructor(ctx) {
    super(ctx, "iam");
    if (process.env.DEMO_SEED === "1") {
      this.registerConnector("demo:dingtalk", new DingTalkConnector());
      this.registerAuthProvider("demo:dingtalk", new DingTalkAuthAdapter());
    }
    this.ensureDefaultTenant();
    for (const config of this.connectorConfigs().all()) {
      this.applyConnectorMode(config.id);
    }
    this.autoSyncTimer = setInterval(() => void this.runDueAutoSyncs(), AUTO_SYNC_TICK_MS);
    this.autoSyncTimer.unref?.();
    setTimeout(() => void this.runDueAutoSyncs(), AUTO_SYNC_BOOT_DELAY_MS);
    ctx.effect(() => () => {
      if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
    });
  }
  /** 注册连接器实例：key 为配置实例 id（多主体各自独立注册/注销）。 */
  registerConnector(key, connector) {
    this.connectors.set(key, connector);
    return () => this.connectors.delete(key);
  }
  /** 注册身份源 Adapter 实例：登录主流程面向接口编程，新增平台零侵入。 */
  registerAuthProvider(key, adapter) {
    this.authProviders.set(key, adapter);
    return () => this.authProviders.delete(key);
  }
  /**
   * 按平台类型取身份源（旧调用兼容；多主体请用 getAuthProviderByConfig）。
   * 优先配置实例注册的身份源（按配置创建顺序取第一）；`demo:` 前缀的 DEMO_SEED 引导注册
   * 仅作「尚无配置」窗口的兜底——否则演示实例长期占据首位，会遮蔽配置切换后的真实/新 mock 实例。
   */
  getAuthProvider(type) {
    let demoFallback;
    for (const [key, adapter] of this.authProviders) {
      if (adapter.type !== type) continue;
      if (key.startsWith("demo:")) {
        demoFallback ??= adapter;
        continue;
      }
      return adapter;
    }
    if (demoFallback) return demoFallback;
    throw new Error(t("\u672A\u6CE8\u518C\u7684\u8EAB\u4EFD\u6E90\uFF1A{type}", { type }));
  }
  /** 按配置实例 id 取身份源（多主体登录/绑定按主体发起）。 */
  getAuthProviderByConfig(configId) {
    const adapter = this.authProviders.get(configId);
    if (!adapter) throw new Error(t("\u672A\u6CE8\u518C\u7684\u8EAB\u4EFD\u6E90\uFF1A{type}", { type: configId }));
    return adapter;
  }
  /** 三方身份链接集合（活跃唯一约束：同一主体下的同一三方身份只能映射一个平台账号）。 */
  identityLinks() {
    const collection = this.ctx.opsStorage.collection("iam:identityLinks");
    collection.uniqueOn("identity_link_active", (record) => `${record.provider}|${record.corpId}|${record.providerUserId}`);
    return collection;
  }
  /**
   * 命中查找：按归一化档案定位已绑定的平台账号。
   * 传 corpId 时精确命中优先；无精确命中回落任意 corp 的同三方身份——钉钉 unionId 跨企业同人，
   * 且兼容单主体部署在 mock/real 间切换（corpId 变化）后的身份连续性。多主体下同身份多链接时精确匹配生效。
   */
  findLinkByProfile(provider, providerUserId, corpId) {
    const links = this.identityLinks().find((link) => link.provider === provider && link.providerUserId === providerUserId);
    if (corpId === void 0) return links[0];
    return links.find((link) => link.corpId === corpId) ?? links[0];
  }
  /** 建立身份链接（唯一约束兜底；user.bindings 保持为投影，便于列表展示）。 */
  linkIdentity(userId, profile, actor) {
    const user = this.users().get(userId);
    if (!user) throw new Error(t("\u8D26\u53F7\u4E0D\u5B58\u5728\uFF1A{id}", { id: userId }));
    const link = this.identityLinks().insert({
      id: newId("idl"),
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      corpId: profile.corpId,
      userId,
      displayName: profile.displayName,
      linkedAt: (/* @__PURE__ */ new Date()).toISOString(),
      linkedBy: actor,
      ...profile.kind ? { kind: profile.kind } : {}
    });
    if (profile.kind !== "staff") {
      this.clearBindingExemption(userId, profile.provider, profile.corpId);
    }
    this.rebuildBindingsProjection(userId);
    return link;
  }
  /**
   * 解除身份链接（同时按事实源重建投影）。
   *
   * 四个必须做对的点（2026-10-22 解绑/更换能力上线时的整改）：
   *   1. 多主体：同一 provider 可能有多个 corpId 的链接（unionId 链 + userid 链），
   *      传 corpId 只删该主体的链接；不传=删该 provider 全部（显式语义，调用方负责确认）。
   *   2. 事实源：`findOne` + `remove` 只删到一条，其余同 provider 链接会变成幽灵——按 provider
   *      （或 provider+corpId）全量删除。
   *   3. 投影：bindings 必须由剩余 identityLinks 重算，不能按 provider 一刀切过滤——
   *      否则「解绑一个主体」会把另一个主体的展示行一起清掉，而链接还在。
   *   4. 链路角色：只解「登录身份链」（kind≠staff）。任职身份链（staff）描述的是此人在组织里的
   *      岗位事实（部门负责人映射、NAS 数据权限身份反查都依赖它），不是登录凭据——
   *      连带抹掉会让部门负责人反查断链、审批路由回退到父部门（实测回归）。
   */
  unlinkIdentity(userId, provider, corpId, kind) {
    const targets = this.identityLinks().find((item) => item.userId === userId && item.provider === provider && (corpId === void 0 || (item.corpId ?? "") === corpId) && (kind === void 0 ? item.kind !== "staff" : item.kind === kind));
    if (targets.length === 0) return false;
    const exempted = new Set(this.users().get(userId)?.bindingExemptions ?? []);
    for (const link of targets) exempted.add(`${provider}|${link.corpId ?? ""}`);
    for (const link of targets) this.identityLinks().remove(link.id);
    this.users().update(userId, { bindingExemptions: [...exempted] });
    this.rebuildBindingsProjection(userId);
    return true;
  }
  /** 清除绑定豁免（重新扫码/手工绑定成功时调用：人工绑定的意图覆盖此前的解绑决定）。 */
  clearBindingExemption(userId, provider, corpId) {
    const user = this.users().get(userId);
    if (!user?.bindingExemptions?.length) return;
    const key = `${provider}|${corpId}`;
    if (!user.bindingExemptions.includes(key)) return;
    const next = user.bindingExemptions.filter((item) => item !== key);
    this.users().update(userId, { bindingExemptions: next.length ? next : void 0 });
  }
  /** 由 identityLinks（事实源）重建 user.bindings 投影：多主体按 provider+corpId 一行。 */
  rebuildBindingsProjection(userId) {
    const user = this.users().get(userId);
    if (!user) return;
    const links = this.identityLinks().find((item) => item.userId === userId);
    const exempted = new Set(this.users().get(userId)?.bindingExemptions ?? []);
    const visible = links.filter((link) => !exempted.has(`${link.provider}|${link.corpId ?? ""}`));
    const seen = /* @__PURE__ */ new Map();
    for (const link of visible) {
      const key = `${link.provider}|${link.corpId ?? ""}`;
      const current = seen.get(key);
      if (!current) {
        seen.set(key, link);
        continue;
      }
      if (current.kind === "staff" && link.kind !== "staff") seen.set(key, link);
    }
    this.users().update(userId, {
      bindings: [...seen.values()].map((link) => ({
        provider: link.provider,
        unionId: link.providerUserId,
        displayName: link.displayName,
        boundAt: link.linkedAt,
        ...link.corpId ? { corpId: link.corpId } : {}
      }))
    });
  }
  /** 已注册连接器实例清单（多主体：携带 configId/主体名，provider 仅表示平台类型）。 */
  connectorProviders() {
    return [...this.connectors.entries()].map(([configId, connector]) => {
      const name2 = this.connectorConfigById(configId)?.name;
      return { configId, provider: connector.provider, label: t(connector.label), ...name2 !== void 0 ? { name: name2 } : {} };
    });
  }
  // -- 集合 ---------------------------------------------------------------
  orgs() {
    const collection = this.ctx.opsStorage.collection("iam:orgs");
    collection.uniqueOn("org_same_level_name", (org) => `${String(org.customFields["connectorId"] ?? "")}|${org.parentId ?? "-"}|${org.name}`);
    return collection;
  }
  users() {
    const collection = this.ctx.opsStorage.collection("iam:users");
    collection.uniqueOn("user_username", (user) => user.username);
    return collection;
  }
  roles() {
    return this.ctx.opsStorage.collection("iam:roles");
  }
  groups() {
    return this.ctx.opsStorage.collection("iam:groups");
  }
  connectorConfigs() {
    const collection = this.ctx.opsStorage.collection("iam:connectors");
    collection.uniqueOn("connector_provider_corp", (config) => `${config.provider}|${config.corpId}`);
    return collection;
  }
  conflicts() {
    return this.ctx.opsStorage.collection("iam:conflicts");
  }
  tenants() {
    const collection = this.ctx.opsStorage.collection("iam:tenants");
    collection.uniqueOn("tenant_name", (tenant) => tenant.name);
    return collection;
  }
  /** 多租户最小集：默认租户兜底（存量数据全部落 t_default）。 */
  ensureDefaultTenant() {
    const existing = this.tenants().get(DEFAULT_TENANT_ID);
    if (existing) return existing;
    return this.tenants().insert({
      id: DEFAULT_TENANT_ID,
      name: "\u9ED8\u8BA4\u79DF\u6237",
      status: "active",
      plan: "standard"
    });
  }
  // -- 场景级授权（IAW 交接 6-1） ---------------------------------------------
  scenePolicies() {
    const collection = this.ctx.opsStorage.collection("iam:scenePolicies");
    collection.uniqueOn("scene_org", (policy) => `${policy.sceneCode}|${policy.orgId ?? ""}`);
    return collection;
  }
  /**
   * 登记场景授权策略（upsert by sceneCode+orgId，version 乐观锁）：
   * expectedVersion 与存量 version 不一致时拒绝（并发编辑对账）；新建不带 expectedVersion。
   */
  upsertScenePolicy(input) {
    if (!input.sceneCode?.trim()) throw new Error(t("\u573A\u666F\u7B56\u7565 sceneCode \u5FC5\u586B\uFF08\u5982 QB01-A-2-5\uFF09"));
    if (!Array.isArray(input.entries) || input.entries.length === 0) throw new Error(t("\u573A\u666F\u7B56\u7565 entries \u81F3\u5C11\u4E00\u6761\uFF08\u7A7A\u7B56\u7565\u8BF7\u7528 DELETE \u79FB\u9664\uFF09"));
    for (const entry of input.entries) {
      if (!["role", "user"].includes(entry.principalType)) throw new Error(t("\u7B56\u7565\u6761\u76EE principalType \u975E\u6CD5\uFF1A{value}\uFF08role/user\uFF09", { value: entry.principalType }));
      if (!entry.principalId?.trim()) throw new Error(t("\u7B56\u7565\u6761\u76EE principalId \u5FC5\u586B\uFF08roleId/userId/*\uFF09"));
      if (!Array.isArray(entry.actions) || entry.actions.length === 0) throw new Error(t("\u7B56\u7565\u6761\u76EE actions \u81F3\u5C11\u4E00\u9879"));
      if (!["allow", "deny"].includes(entry.effect)) throw new Error(t("\u7B56\u7565\u6761\u76EE effect \u975E\u6CD5\uFF1A{value}\uFF08allow/deny\uFF09", { value: entry.effect }));
      if (entry.principalType === "role" && entry.principalId !== "*" && !this.roles().get(entry.principalId)) {
        throw new Error(t("\u7B56\u7565\u6761\u76EE\u5F15\u7528\u7684\u89D2\u8272\u4E0D\u5B58\u5728\uFF1A{id}", { id: entry.principalId }));
      }
      if (entry.principalType === "user" && entry.principalId !== "*" && !this.users().get(entry.principalId)) {
        throw new Error(t("\u7B56\u7565\u6761\u76EE\u5F15\u7528\u7684\u7528\u6237\u4E0D\u5B58\u5728\uFF1A{id}", { id: entry.principalId }));
      }
    }
    const existing = this.scenePolicies().findOne((item) => item.sceneCode === input.sceneCode && (item.orgId ?? "") === (input.orgId ?? ""));
    if (existing) {
      if (input.expectedVersion !== void 0 && input.expectedVersion !== existing.version) {
        throw new Error(t("\u573A\u666F\u7B56\u7565\u7248\u672C\u51B2\u7A81\uFF1A\u5F53\u524D v{current}\uFF0C\u8BF7\u6C42\u57FA\u4E8E v{expected}\uFF08\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\uFF09", { current: existing.version, expected: input.expectedVersion }));
      }
      const updated = this.scenePolicies().update(existing.id, {
        entries: input.entries,
        ...input.note !== void 0 ? { note: input.note } : {},
        version: existing.version + 1
      });
      this.ctx.platformBus.emit(PlatformEvents.IamScenePolicyChanged, { sceneCode: input.sceneCode, orgId: input.orgId ?? null, policyId: updated.id, version: updated.version, action: "updated" });
      return updated;
    }
    const created = this.scenePolicies().insert({
      id: newId("scp"),
      sceneCode: input.sceneCode,
      ...input.orgId ? { orgId: input.orgId } : {},
      entries: input.entries,
      ...input.note ? { note: input.note } : {},
      version: 1
    });
    this.ctx.platformBus.emit(PlatformEvents.IamScenePolicyChanged, { sceneCode: input.sceneCode, orgId: input.orgId ?? null, policyId: created.id, version: 1, action: "created" });
    return created;
  }
  deleteScenePolicy(id) {
    const policy = this.scenePolicies().get(id);
    if (!policy) throw new Error(t("\u573A\u666F\u7B56\u7565\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    this.scenePolicies().remove(id);
    this.ctx.platformBus.emit(PlatformEvents.IamScenePolicyChanged, { sceneCode: policy.sceneCode, orgId: policy.orgId ?? null, policyId: id, action: "deleted" });
    return { deleted: true };
  }
  /**
   * iam.check(scene, action)（IAW 交接 6-1）：场景维度 ABAC 判定。
   * 判定序：①场景无策略 → default（回落 hasPermission 角色链路，存量行为不变）；
   * ②deny 条目命中（用户/角色/通配 × 动作）→ deny；③allow 命中 → allow；④其余 → deny（fail-closed）。
   * 本判定是场景维度的**细粒度收敛**，不替代角色 RBAC：调用方应同时满足 hasPermission(基础权限点)。
   */
  checkScene(userId, sceneCode, action) {
    const user = this.users().get(userId);
    if (!user) {
      return { decision: "deny", reason: t("\u7528\u6237\u4E0D\u5B58\u5728\uFF1A{userId}", { userId }), sceneCode, action };
    }
    const policies = this.scenePolicies().all().filter((item) => item.sceneCode === sceneCode && ((item.orgId ?? "") === "" || item.orgId === user.orgId));
    if (policies.length === 0) {
      return { decision: "default", reason: t("\u573A\u666F\u672A\u914D\u7F6E\u6388\u6743\u7B56\u7565\uFF0C\u56DE\u843D\u89D2\u8272 RBAC \u4E0E\u90E8\u95E8\u8303\u56F4\u6743\u9650\uFF08\u5B58\u91CF\u53E3\u5F84\uFF09"), sceneCode, action };
    }
    const matches = (entry) => entry.principalId === "*" && entry.principalType === "role" || entry.principalType === "user" && (entry.principalId === "*" || entry.principalId === userId) || entry.principalType === "role" && user.roleIds.includes(entry.principalId);
    const actionHit = (entry) => entry.actions.includes("*") || entry.actions.includes(action);
    for (const policy2 of policies) {
      for (const entry of policy2.entries) {
        if (entry.effect === "deny" && matches(entry) && actionHit(entry)) {
          return { decision: "deny", reason: t("\u573A\u666F\u7B56\u7565 deny \u547D\u4E2D\uFF08policy={policyId}\uFF09", { policyId: policy2.id }), policyId: policy2.id, sceneCode, action };
        }
      }
    }
    for (const policy2 of policies) {
      for (const entry of policy2.entries) {
        if (entry.effect === "allow" && matches(entry) && actionHit(entry)) {
          return { decision: "allow", reason: t("\u573A\u666F\u7B56\u7565 allow \u547D\u4E2D\uFF08policy={policyId}\uFF09", { policyId: policy2.id }), policyId: policy2.id, sceneCode, action };
        }
      }
    }
    const policy = policies[0];
    return { decision: "deny", reason: t("\u573A\u666F\u5DF2\u914D\u7F6E\u6388\u6743\u7B56\u7565\u4E14\u65E0\u547D\u4E2D\u6761\u76EE\uFF08fail-closed\uFF0Cpolicy={policyId}\uFF09", { policyId: policy.id }), policyId: policy.id, sceneCode, action };
  }
  createTenant(input) {
    if (!input.name?.trim()) throw new Error(t("\u79DF\u6237\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A"));
    if (this.tenants().findOne((tenant) => tenant.name === input.name)) throw new Error(t("\u79DF\u6237\u5DF2\u5B58\u5728\uFF1A{name}", { name: input.name }));
    return this.tenants().insert({
      id: newId("t"),
      name: input.name,
      status: "active",
      plan: input.plan ?? "trial"
    });
  }
  /** 租户解析：org → tenant；缺省 t_default（usage/用量报表统一入口）。 */
  tenantOfOrg(orgId) {
    return this.orgs().get(orgId)?.tenantId ?? DEFAULT_TENANT_ID;
  }
  // -- 组织 ---------------------------------------------------------------
  orgTree() {
    const nodes = /* @__PURE__ */ new Map();
    for (const org of this.orgs().all()) {
      nodes.set(org.id, { ...org, children: [] });
    }
    const roots = [];
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) {
        nodes.get(node.parentId).children.push(node);
      } else {
        roots.push(node);
      }
    }
    const sortRec = (list) => {
      list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "zh"));
      for (const item of list) sortRec(item.children);
      return list;
    };
    return sortRec(roots);
  }
  createOrg(input, actor) {
    if (!input.name?.trim()) throw new Error(t("\u7EC4\u7EC7\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A"));
    const parentId = input.parentId ?? null;
    if (parentId && !this.orgs().get(parentId)) throw new Error(t("\u7236\u7EC4\u7EC7\u4E0D\u5B58\u5728\uFF1A{id}", { id: parentId }));
    this.assertManageScope(actor, parentId ?? void 0, t("\u521B\u5EFA\u7EC4\u7EC7"));
    const ownerKey = input.customFields?.["connectorId"] ?? "";
    const duplicate = this.orgs().findOne((org) => org.name === input.name && org.parentId === parentId && (org.customFields["connectorId"] ?? "") === ownerKey);
    if (duplicate) throw new Error(t("\u540C\u7EA7\u4E0B\u5DF2\u5B58\u5728\u540C\u540D\u7EC4\u7EC7\u300C{name}\u300D", { name: input.name }));
    const record = this.orgs().insert({
      id: newId("org"),
      name: input.name.trim(),
      parentId,
      order: input.order ?? this.orgs().count() + 1,
      status: "active",
      customFields: input.customFields ?? {},
      ...input.tenantId !== void 0 ? { tenantId: input.tenantId } : {},
      ...input.leaderUserIds !== void 0 ? { leaderUserIds: input.leaderUserIds, leaderSource: "manual" } : {}
    });
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: "create", orgId: record.id, name: record.name });
    return record;
  }
  /** 维护组织负责人（控制台补录 / leaderVacant 告警后的处置入口）。传空数组即清空并恢复跟随同步。 */
  setOrgLeaders(id, leaderUserIds) {
    this.requireOrg(id);
    const unique = [...new Set(leaderUserIds)];
    for (const userId of unique) {
      if (!this.users().get(userId)) throw new Error(t("\u8D1F\u8D23\u4EBA\u8D26\u53F7\u4E0D\u5B58\u5728\uFF1A{id}", { id: userId }));
    }
    return unique.length > 0 ? this.orgs().update(id, { leaderUserIds: unique, leaderSource: "manual" }) : this.orgs().update(id, { leaderUserIds: [], leaderSource: "sync" });
  }
  /** 兼容读取：负责人历史口径 customFields['leaderUserIds']（逗号分隔），结构化字段优先。 */
  leadersOf(orgId) {
    const org = this.orgs().get(orgId);
    if (!org) return [];
    if (Array.isArray(org.leaderUserIds)) return org.leaderUserIds;
    const legacy = String(org.customFields?.["leaderUserIds"] ?? "").trim();
    return legacy ? legacy.split(",").map((item) => item.trim()).filter(Boolean) : [];
  }
  renameOrg(id, name2, actor) {
    const org = this.requireOrg(id);
    this.assertManageScope(actor, id, t("\u91CD\u547D\u540D\u7EC4\u7EC7"));
    if (!name2?.trim()) throw new Error(t("\u7EC4\u7EC7\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A"));
    const trimmed = name2.trim();
    const duplicate = this.orgs().findOne((item) => item.id !== id && item.name === trimmed && item.parentId === org.parentId && (item.customFields["connectorId"] ?? "") === (org.customFields["connectorId"] ?? ""));
    if (duplicate) throw new Error(t("\u540C\u7EA7\u4E0B\u5DF2\u5B58\u5728\u540C\u540D\u7EC4\u7EC7\u300C{name}\u300D", { name: trimmed }));
    const updated = this.orgs().update(id, { name: trimmed });
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: "rename", orgId: id, name: trimmed });
    return updated;
  }
  /** 移动组织（拖拽调岗），含环检测；组织与新上级均须落在操作者子树内（防借移动越界挂载）。 */
  moveOrg(id, newParentId, actor) {
    this.requireOrg(id);
    this.assertManageScope(actor, id, t("\u79FB\u52A8\u7EC4\u7EC7"));
    this.assertManageScope(actor, newParentId ?? void 0, t("\u79FB\u52A8\u7EC4\u7EC7\u5230\u76EE\u6807\u4E0A\u7EA7"));
    if (newParentId) {
      if (newParentId === id) throw new Error(t("\u4E0D\u80FD\u5C06\u7EC4\u7EC7\u79FB\u52A8\u5230\u81EA\u8EAB\u4E4B\u4E0B"));
      if (!this.orgs().get(newParentId)) throw new Error(t("\u7236\u7EC4\u7EC7\u4E0D\u5B58\u5728\uFF1A{id}", { id: newParentId }));
      let cursor = newParentId;
      while (cursor) {
        if (cursor === id) throw new Error(t("\u4E0D\u5141\u8BB8\u5F62\u6210\u7EC4\u7EC7\u73AF"));
        cursor = this.orgs().get(cursor)?.parentId ?? null;
      }
    }
    const updated = this.orgs().update(id, { parentId: newParentId });
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: "move", orgId: id });
    return updated;
  }
  /**
   * 删除组织。默认仅允许空组织（无子组织且无直属账号）；
   * cascade=true 一键删除整棵子树：子树内组织全部移除，直接挂载的账号上移到
   * 存活的最近上级组织（被删根的父组织；删除根组织时上移到首个存活根组织）。
   */
  deleteOrg(id, options, actor) {
    const org = this.requireOrg(id);
    this.assertManageScope(actor, id, t("\u5220\u9664\u7EC4\u7EC7"));
    if (!options?.cascade) {
      if (this.orgs().find((item) => item.parentId === id).length > 0) throw new Error(t("\u5B58\u5728\u5B50\u7EC4\u7EC7\uFF0C\u65E0\u6CD5\u5220\u9664\uFF1B\u8BF7\u6539\u7528\u300C\u8FDE\u540C\u5B50\u7EC4\u7EC7\u4E00\u952E\u5220\u9664\u300D"));
      if (this.users().find((user) => user.orgId === id).length > 0) throw new Error(t("\u7EC4\u7EC7\u4E0B\u4ECD\u6709\u8D26\u53F7\uFF0C\u65E0\u6CD5\u5220\u9664\uFF1B\u8BF7\u6539\u7528\u300C\u8FDE\u540C\u5B50\u7EC4\u7EC7\u4E00\u952E\u5220\u9664\u300D\uFF08\u8D26\u53F7\u5C06\u4E0A\u79FB\u5230\u4E0A\u7EA7\u7EC4\u7EC7\uFF09"));
      this.orgs().remove(id);
      this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: "delete", orgId: id, name: org.name });
      return { deleted: true, removedOrgs: 1, movedUsers: 0 };
    }
    const subtree = this.orgSubtreeIds(id);
    const subtreeSet = new Set(subtree);
    const fallbackOrgId = org.parentId ?? this.orgs().find((item) => !subtreeSet.has(item.id) && !item.parentId)[0]?.id ?? null;
    const movedUsers = this.users().find((user) => subtreeSet.has(user.orgId));
    if (!fallbackOrgId && movedUsers.length > 0) throw new Error(t("\u5220\u9664\u540E\u5C06\u6CA1\u6709\u4EFB\u4F55\u7EC4\u7EC7\u53EF\u6302\u8F7D\u8D26\u53F7\uFF0C\u8BF7\u5148\u628A\u8D26\u53F7\u8FC1\u79FB\u5230\u5176\u4ED6\u7EC4\u7EC7\u518D\u5220\u9664"));
    if (fallbackOrgId) {
      for (const user of movedUsers) this.users().update(user.id, { orgId: fallbackOrgId });
    }
    for (const orgId of subtree) {
      if (this.orgs().get(orgId)) this.orgs().remove(orgId);
    }
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, {
      kind: "delete",
      orgId: id,
      name: org.name,
      cascade: true,
      removedOrgs: subtree.length,
      movedUsers: movedUsers.length
    });
    return { deleted: true, removedOrgs: subtree.length, movedUsers: movedUsers.length, ...fallbackOrgId ? { fallbackOrgId } : {} };
  }
  requireOrg(id) {
    const org = this.orgs().get(id);
    if (!org) throw new Error(t("\u7EC4\u7EC7\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    return org;
  }
  /** 组织子树 id 集合（数据权限范围）。 */
  orgSubtreeIds(rootId) {
    const result = [rootId];
    const walk = (parentId) => {
      for (const org of this.orgs().find((item) => item.parentId === parentId)) {
        result.push(org.id);
        walk(org.id);
      }
    };
    walk(rootId);
    return result;
  }
  // -- 账号 ---------------------------------------------------------------
  /**
   * 组织归属校验（QA A-03/N1 fail-closed）：非平台管理员（无 '*'）只允许管理本组织子树内的
   * 账号/组织；机器主体与无法定位组织归属者一律拒绝。actor.orgId（工具桥 `_actor` 注入）
   * 优先，缺省按 userId 反查账号档案。actor 缺失一律拒绝：外部入口（REST 管理路由与工具桥）
   * 必须携带真实调用者身份，服务内部链路（种子/三方同步/SSO 自注册）显式传 SYSTEM_ACTOR。
   */
  assertManageScope(actor, targetOrgId, action) {
    if (!actor) {
      throw new OrgScopeDeniedError(t("\u8D26\u53F7\u7BA1\u7406\u64CD\u4F5C\u7F3A\u5C11\u64CD\u4F5C\u8005\u8EAB\u4EFD\uFF08{action}\uFF09\uFF1A\u5916\u90E8\u5165\u53E3\u5FC5\u987B\u643A\u5E26\u53EF\u5F52\u56E0\u8C03\u7528\u8005\uFF0C\u5185\u90E8\u7CFB\u7EDF\u94FE\u8DEF\u8BF7\u663E\u5F0F\u4F20\u5165\u7CFB\u7EDF\u8EAB\u4EFD\uFF08\u7EC4\u7EC7\u9694\u79BB\uFF0CQA A-03\uFF09", { action }));
    }
    if (actor.permissions.includes("*")) return;
    const actorOrgId = actor.orgId ?? (actor.userId ? this.users().get(actor.userId)?.orgId : void 0);
    if (!actorOrgId || !targetOrgId || !this.orgSubtreeIds(actorOrgId).includes(targetOrgId)) {
      throw new OrgScopeDeniedError(t("\u8DE8\u7EC4\u7EC7\u8D26\u53F7\u64CD\u4F5C\u88AB\u62D2\u7EDD\uFF08{action}\uFF09\uFF1A\u76EE\u6807\u4E0D\u5728\u64CD\u4F5C\u8005\u7684\u7EC4\u7EC7\u5B50\u6811\u5185\uFF08\u7EC4\u7EC7\u9694\u79BB\uFF0CQA A-03\uFF09", { action }));
    }
  }
  /** 口令强度（QA A-08）：建号与重置统一口径——≥8 位且不含中文（此前建号无校验，'123' 可建可登）。 */
  assertPasswordStrength(password) {
    if (password.trim().length < 8) throw new Error(t("\u53E3\u4EE4\u957F\u5EA6\u4E0D\u5F97\u5C11\u4E8E 8 \u4F4D"));
    if (/[\u4e00-\u9fff]/.test(password)) throw new Error(t("\u53E3\u4EE4\u4E0D\u5F97\u5305\u542B\u4E2D\u6587"));
  }
  /** 创建账号：未显式指定口令时生成随机初始口令（仅本次调用返回，须安全传达给本人）。 */
  createUser(input, actor) {
    if (!input.username?.trim()) throw new Error(t("\u7528\u6237\u540D\u4E0D\u80FD\u4E3A\u7A7A"));
    if (!/^[a-z0-9_.-]+$/i.test(input.username)) throw new Error(t("\u7528\u6237\u540D\u4EC5\u652F\u6301\u5B57\u6BCD\u3001\u6570\u5B57\u4E0E _ . -"));
    if (this.users().findOne((user2) => user2.username === input.username)) throw new Error(t("\u7528\u6237\u540D\u5DF2\u5B58\u5728\uFF1A{username}", { username: input.username }));
    if (!this.orgs().get(input.orgId)) throw new Error(t("\u7EC4\u7EC7\u4E0D\u5B58\u5728\uFF1A{id}", { id: input.orgId }));
    this.assertManageScope(actor, input.orgId, t("\u521B\u5EFA\u8D26\u53F7"));
    if (input.roleIds?.length) this.assertGrantCeiling(actor, this.resolveRolePermissions(input.roleIds), t("\u521B\u5EFA\u8D26\u53F7"));
    if (input.password !== void 0) this.assertPasswordStrength(input.password);
    const password = input.password ?? generateSecret("init");
    const user = this.users().insert({
      id: newId("usr"),
      username: input.username,
      displayName: input.displayName || input.username,
      email: input.email ?? `${input.username}@yuanbingke.com`,
      phone: input.phone ?? "",
      orgId: input.orgId,
      title: input.title ?? "",
      status: "pending",
      roleIds: input.roleIds ?? [],
      passwordSalt: "",
      passwordHash: hashPasswordScrypt(password),
      bindings: [],
      // 仅当调用方显式给了口令（有人拿到明文）才标记；随机生成的初始口令未下发，不算已知
      ...input.password !== void 0 ? { passwordKnown: true } : {},
      ...input.jobNumber !== void 0 ? { jobNumber: input.jobNumber } : {}
    });
    return input.password ? { user } : { user, initialPassword: password };
  }
  /** 重置口令：不传 password 则生成随机初始口令；传入则设置为指定口令（均仅本次返回明文）。 */
  resetPassword(id, password, actor) {
    const user = this.requireUser(id);
    this.assertManageScope(actor, user.orgId, t("\u91CD\u7F6E\u53E3\u4EE4"));
    if (user.status === "deactivated") throw new Error(t("\u8D26\u53F7\u5DF2\u6CE8\u9500\uFF0C\u65E0\u6CD5\u91CD\u7F6E\u53E3\u4EE4"));
    if (password !== void 0) this.assertPasswordStrength(password);
    const next = password ?? generateSecret("init");
    this.users().update(id, { passwordSalt: "", passwordHash: hashPasswordScrypt(next), passwordKnown: true });
    this.ctx.platformBus.emit(PlatformEvents.UserPasswordReset, { userId: id, username: user.username });
    return { user: this.users().get(id), initialPassword: next };
  }
  importUsers(items, actor) {
    const created = [];
    const skipped = [];
    for (const item of items) {
      if (this.users().findOne((user) => user.username === item.username)) {
        skipped.push(item.username);
        continue;
      }
      created.push(this.createUser(item, actor).user);
    }
    return { created, skipped };
  }
  activateUser(id, actor) {
    const user = this.requireUser(id);
    this.assertManageScope(actor, user.orgId, t("\u6FC0\u6D3B\u8D26\u53F7"));
    if (user.status !== "pending") throw new Error(t("\u4EC5\u5F85\u6FC0\u6D3B\u8D26\u53F7\u53EF\u6FC0\u6D3B"));
    return this.users().update(id, { status: "active" });
  }
  freezeUser(id, reason, actor) {
    const user = this.requireUser(id);
    this.assertManageScope(actor, user.orgId, t("\u51BB\u7ED3\u8D26\u53F7"));
    if (!reason?.trim()) throw new Error(t("\u51BB\u7ED3\u5FC5\u987B\u586B\u5199\u539F\u56E0\uFF08\u5BA1\u8BA1\u8981\u6C42\uFF09"));
    const updated = this.users().update(id, { status: "frozen", frozenReason: reason });
    this.ctx.platformBus.emit(PlatformEvents.UserFrozen, { userId: id, username: updated.username, reason });
    return updated;
  }
  unfreezeUser(id, actor) {
    const user = this.requireUser(id);
    this.assertManageScope(actor, user.orgId, t("\u89E3\u51BB\u8D26\u53F7"));
    const updated = this.users().update(id, { status: "active", frozenReason: void 0 });
    this.ctx.platformBus.emit(PlatformEvents.UserActivated, { userId: id });
    return updated;
  }
  deactivateUser(id, reason, actor) {
    const user = this.requireUser(id);
    this.assertManageScope(actor, user.orgId, t("\u6CE8\u9500\u8D26\u53F7"));
    if (!reason?.trim()) throw new Error(t("\u6CE8\u9500\u5FC5\u987B\u586B\u5199\u539F\u56E0"));
    const updated = this.users().update(id, { status: "deactivated", frozenReason: reason });
    this.ctx.platformBus.emit(PlatformEvents.UserFrozen, { userId: id, username: updated.username, reason: t("\u6CE8\u9500\uFF1A{reason}", { reason }) });
    return updated;
  }
  updateUser(id, patch, actor) {
    const allowedFields = ["displayName", "email", "phone", "title", "orgId", "accountType", "primaryOrgId"];
    const rejected = Object.keys(patch ?? {}).filter((key) => !allowedFields.includes(key));
    if (rejected.length > 0) {
      throw new Error(t("\u8D26\u53F7\u7F16\u8F91\u4E0D\u63A5\u53D7\u4EE5\u4E0B\u5B57\u6BB5\uFF1A{fields}\uFF08\u72B6\u6001\u8BF7\u8D70\u51BB\u7ED3/\u89E3\u51BB/\u6FC0\u6D3B/\u6CE8\u9500\u7AEF\u70B9\uFF0C\u53E3\u4EE4\u8BF7\u8D70\u91CD\u7F6E\u53E3\u4EE4\u7AEF\u70B9\uFF0C\u89D2\u8272\u8BF7\u8D70\u89D2\u8272\u5206\u914D\u63A5\u53E3\uFF09", { fields: rejected.join("\u3001") }));
    }
    const user = this.requireUser(id);
    this.assertManageScope(actor, user.orgId, t("\u4FEE\u6539\u8D26\u53F7"));
    if (patch.orgId) {
      if (!this.orgs().get(patch.orgId)) throw new Error(t("\u7EC4\u7EC7\u4E0D\u5B58\u5728\uFF1A{id}", { id: patch.orgId }));
      this.assertManageScope(actor, patch.orgId, t("\u8FC1\u79FB\u8D26\u53F7\u7EC4\u7EC7"));
    }
    if (patch.primaryOrgId && !this.orgs().get(patch.primaryOrgId)) throw new Error(t("\u4E3B\u5F52\u5C5E\u7EC4\u7EC7\u4E0D\u5B58\u5728\uFF1A{id}", { id: patch.primaryOrgId }));
    if (patch.accountType !== void 0 && !["internal", "external", "suspended-review"].includes(patch.accountType)) {
      throw new Error(t("\u975E\u6CD5\u8D26\u53F7\u7C7B\u578B\uFF1A{type}", { type: patch.accountType }));
    }
    return this.users().update(id, patch);
  }
  deleteUser(id, actor) {
    const user = this.requireUser(id);
    this.assertManageScope(actor, user.orgId, t("\u5220\u9664\u8D26\u53F7"));
    if (user.status !== "deactivated") throw new Error(t("\u4EC5\u5DF2\u6CE8\u9500\u8D26\u53F7\u53EF\u7269\u7406\u5220\u9664"));
    return this.users().remove(id);
  }
  /**
   * 绑定三方身份：事实源为 identityLinks（引擎级唯一约束），user.bindings 为投影。
   *
   * 安全审查 P1-05（2026-10-31）：
   *   ① 代他人绑定收敛为平台超级管理员（'*'）——手工绑定写入的是调用方声明的任意 unionId，
   *      组织管理员若能给他人账号挂自己的三方身份，即可经三方登录接管该账号（含超管）。
   *      组织管理员的合规通道是扫码授权（/api/auth/sso/bind/authorize，被绑定身份=扫码人本人）
   *      与连接器同步；本端点自绑（id=操作者本人）不受限。
   *   ② 移除伪「二次验证码」校验——旧逻辑只查 '000000'/6 位格式，从未对应真实挑战
   *      （验证码形同虚设）。verifyCode 参数保留接收（前端兼容），不再声明安全语义。
   */
  bindThirdParty(id, binding, actor) {
    const user = this.requireUser(id);
    this.assertManageScope(actor, user.orgId, t("\u7ED1\u5B9A\u4E09\u65B9\u8EAB\u4EFD"));
    const selfBind = actor?.userId !== void 0 && actor.userId === id;
    if (!selfBind && !actor?.permissions.includes("*")) {
      throw new OrgScopeDeniedError(t("\u4E3A\u5176\u4ED6\u8D26\u53F7\u624B\u5DE5\u7ED1\u5B9A\u4E09\u65B9\u8EAB\u4EFD\u4EC5\u9650\u5E73\u53F0\u8D85\u7EA7\u7BA1\u7406\u5458\uFF08\u9632\u501F\u4E09\u65B9\u767B\u5F55\u63A5\u7BA1\u4ED6\u4EBA\u8D26\u53F7\uFF0C\u5B89\u5168\u5BA1\u67E5 P1-05\uFF09\uFF1B\u8BF7\u8D70\u626B\u7801\u6388\u6743\u6216\u8FDE\u63A5\u5668\u540C\u6B65\u901A\u9053"));
    }
    const corpId = binding.corpId ?? this.connectorConfig(binding.provider)?.corpId ?? "";
    const occupied = this.identityLinks().findOne((link) => link.userId === id && link.provider === binding.provider && link.kind !== "staff" && (link.corpId ?? "") === corpId);
    if (occupied) {
      throw new Error(t("\u8BE5\u8D26\u53F7\u5DF2\u7ED1\u5B9A{provider}\u8EAB\u4EFD\uFF0C\u8BF7\u5148\u89E3\u7ED1", { provider: binding.provider }));
    }
    const taken = this.identityLinks().findOne((link) => link.provider === binding.provider && link.providerUserId === binding.unionId && link.kind !== "staff" && (link.corpId ?? "") === corpId);
    if (taken && taken.userId !== id) {
      throw new Error(t("\u8BE5\u4E09\u65B9\u8EAB\u4EFD\u5DF2\u7ED1\u5B9A\u5176\u4ED6\u5E73\u53F0\u8D26\u53F7\uFF08\u4E00\u4EBA\u4E00\u53F7\uFF09\uFF0C\u8BF7\u5148\u89E3\u9664\u5BF9\u65B9\u7ED1\u5B9A"));
    }
    this.linkIdentity(id, {
      provider: binding.provider,
      providerUserId: binding.unionId,
      corpId,
      displayName: binding.displayName
    }, "console");
    return this.users().get(id);
  }
  /**
   * 解除三方绑定（管理面）。corpId 缺省=该 provider 全部主体（管理员显式选择「解绑钉钉」）。
   * 解绑后写入豁免，避免连接器同步把链接自动补回。
   * 安全审查 P1-05：移除伪验证码校验（旧逻辑只查 6 位格式、从未对应真实挑战）；解绑本身
   * 不授予访问权（只影响登录方式，且「最后登录方式需先设口令」反锁定护栏在 performUnbind），
   * 配合 bindThirdParty 收敛为 '*' 后，解绑不再构成账号接管链的一环。
   */
  unbindThirdParty(id, provider, verifyCode, actor, corpId) {
    const user = this.requireUser(id);
    this.assertManageScope(actor, user.orgId, t("\u89E3\u7ED1\u4E09\u65B9\u8EAB\u4EFD"));
    void verifyCode;
    return this.performUnbind(user, provider, corpId);
  }
  /**
   * 本人自助解绑（无 iam.user.write 的业务同学在面板里解绑自己的钉钉）。
   * 与 unbindThirdParty 的唯一差别是不做组织子树校验——操作对象恒为调用者本人，
   * 由路由层从会话取 userId（不接受请求体指定），因此不存在越权面。
   */
  unbindOwnThirdParty(userId, provider, verifyCode, corpId) {
    const user = this.requireUser(userId);
    if (!verifyCode || verifyCode.length !== 6) throw new Error(t("\u89E3\u7ED1\u9700\u4E8C\u6B21\u9A8C\u8BC1\uFF086 \u4F4D\u9A8C\u8BC1\u7801\uFF09"));
    return this.performUnbind(user, provider, corpId);
  }
  /** 解绑实际执行（含反锁定护栏：先判后删，不留中间态）。 */
  performUnbind(user, provider, corpId) {
    const targets = this.identityLinks().find((link) => link.userId === user.id && link.provider === provider && (corpId === void 0 || (link.corpId ?? "") === corpId) && link.kind !== "staff");
    if (targets.length === 0) {
      throw new Error(t("\u8BE5\u8D26\u53F7\u672A\u7ED1\u5B9A{provider}\u8EAB\u4EFD", { provider }));
    }
    const remainingLinks = this.identityLinks().find((link) => link.userId === user.id && link.kind !== "staff" && !targets.some((target) => target.id === link.id));
    if (remainingLinks.length === 0 && !this.hasUsablePassword(user)) {
      throw new Error(t("\u8FD9\u662F\u8BE5\u8D26\u53F7\u552F\u4E00\u7684\u767B\u5F55\u65B9\u5F0F\uFF0C\u89E3\u7ED1\u540E\u5C06\u65E0\u6CD5\u767B\u5F55\u3002\u8BF7\u5148\u4E3A\u8D26\u53F7\u8BBE\u7F6E\u53E3\u4EE4\uFF08\u7BA1\u7406\u5458\u91CD\u7F6E\u53E3\u4EE4\uFF09\uFF0C\u518D\u89E3\u7ED1\u4E09\u65B9\u8EAB\u4EFD"));
    }
    this.unlinkIdentity(user.id, provider, corpId);
    return this.users().get(user.id);
  }
  /**
   * 账号是否有可用口令（可用于账号密码登录）。
   * 依据是 passwordKnown 标记（有人拿到过明文），不是用户名形态——通讯录同步创建的账号
   * 用户名是工号、口令同为随机值，按形态判断会把它们误判成「有已知口令」而放行解绑。
   */
  hasUsablePassword(user) {
    return Boolean(user.passwordHash) && user.passwordKnown === true;
  }
  /**
   * 账号清单（N3 组织管理员读面收敛）：orgId 展开为其组织子树过滤；scopeOrgIds（调用方可见
   * 组织集合，控制台层由 scopedOrgIdsOf 计算）传入时做交集——非平台管理员只看得到管辖子树
   * 内的账号。两者缺省不过滤（平台管理员/服务内部调用，保持既有全量口径）。
   */
  listUsers(input = {}) {
    const orgScope = input.orgId ? new Set(this.orgSubtreeIds(input.orgId)) : void 0;
    const allowScope = input.scopeOrgIds ? new Set(input.scopeOrgIds) : void 0;
    const q = input.q?.toLowerCase();
    return this.users().find((user) => {
      if (input.status && user.status !== input.status) return false;
      if (orgScope && !orgScope.has(user.orgId)) return false;
      if (allowScope && !allowScope.has(user.orgId)) return false;
      if (q && !`${user.displayName}${user.username}${user.email}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  verifyPassword(username, password) {
    const user = this.users().findOne((item) => item.username === username);
    if (!user) throw new Error(t("\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF"));
    if (!verifyPasswordHash(user, password)) throw new Error(t("\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF"));
    if (!user.passwordHash.startsWith(SCRYPT_PREFIX)) {
      try {
        this.users().update(user.id, { passwordSalt: "", passwordHash: hashPasswordScrypt(password) });
      } catch {
      }
    }
    if (user.status === "frozen") throw new Error(t("\u8D26\u53F7\u5DF2\u51BB\u7ED3\uFF1A{reason}", { reason: user.frozenReason ?? t("\u8054\u7CFB\u7BA1\u7406\u5458") }));
    if (user.status === "deactivated") throw new Error(t("\u8D26\u53F7\u5DF2\u6CE8\u9500"));
    if (user.status === "pending") throw new Error(t("\u8D26\u53F7\u5F85\u6FC0\u6D3B\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458"));
    return user;
  }
  markLogin(id) {
    this.users().update(id, { lastLoginAt: (/* @__PURE__ */ new Date()).toISOString() });
  }
  requireUser(id) {
    const user = this.users().get(id);
    if (!user) throw new Error(t("\u8D26\u53F7\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    return user;
  }
  // -- 角色 ---------------------------------------------------------------
  /**
   * 存量账号口令已知性回填（幂等，2026-10-22 解绑护栏配套）：
   * `passwordKnown` 是本批次新增字段，存量账号没有它。若把「缺字段」直接当成 false，
   * 所有既有账号都会被判成「只能靠三方登录」，解绑功能对它们等于全程被拒。
   *
   * 回填口径（保守向可用性倾斜，但不放宽真正的风险面）：
   *   - 已有任意三方绑定的账号 → 不标记（解绑护栏照常生效，只有当它是唯一登录方式时拦）；
   *   - 没有任何三方绑定的账号 → 标记 true（它本来就只能靠口令登录，说明口令是已知的）。
   */
  backfillPasswordKnown() {
    const collection = this.ctx.opsStorage.collection("iam:migrations");
    if (collection.findOne((item) => item.key === "password-known-v1")) return 0;
    let touched = 0;
    for (const user of this.users().all()) {
      if (user.passwordKnown !== void 0) continue;
      if ((user.bindings ?? []).length === 0 && user.passwordHash) {
        this.users().update(user.id, { passwordKnown: true });
        touched++;
      }
    }
    collection.insert({ id: newId("mig"), key: "password-known-v1", note: `backfilled ${touched}` });
    return touched;
  }
  /**
   * 存量身份链的 kind 回填（幂等，2026-10-22 解绑能力配套）。
   *
   * 本批次新增了 kind 字段区分「登录链」与「任职链」，存量链没有该字段。回填依据两条事实：
   *   1. 同一 (provider, corpId, userId) 下若有多条链，则登录链是 unionId 形态、任职链是 userid 形态
   *      （钉钉 unionId 形如 dd_uXXX，userid 形如 staff_XXX）——这是同步写链的既有约定；
   *   2. 形态判据兜底：providerUserId 命中该主体任一部门的负责人 userid 列表（managerRemoteIds）→ 任职链。
   * 回填后解绑只动登录链，任职链（部门负责人反查、NAS 数据权限身份反查）保持不动。
   */
  backfillIdentityLinkKinds() {
    const links = this.identityLinks().all();
    const groupOf = (link) => `${link.provider}|${link.corpId ?? ""}|${link.userId}`;
    const groups = /* @__PURE__ */ new Map();
    for (const link of links) {
      const key = groupOf(link);
      const list = groups.get(key) ?? [];
      list.push(link);
      groups.set(key, list);
    }
    const staffIds = /* @__PURE__ */ new Set();
    for (const org of this.orgs().all()) {
      for (const id of this.leadersOf(org.id)) {
        if (/^(staff|user|ou_)/i.test(id)) staffIds.add(id);
      }
    }
    let touched = 0;
    for (const group of groups.values()) {
      const isUnionShape = (id) => /^(dd_u|ou_|union)/i.test(id) || !/^(staff|user)/i.test(id);
      for (const link of group) {
        if (link.kind !== void 0) continue;
        const kind = group.length > 1 && !isUnionShape(link.providerUserId) || staffIds.has(link.providerUserId) ? "staff" : "login";
        this.identityLinks().update(link.id, { kind });
        touched++;
      }
    }
    return touched;
  }
  ensureBuiltinRoles() {
    for (const role of BuiltinRoles) {
      if (!this.roles().findOne((item) => item.code === role.code)) {
        this.roles().insert({ id: newId("rol"), ...role });
      }
    }
  }
  /**
   * 内置角色权限迁移（幂等）：给已落库的 resource_admin/developer/auditor 补齐连接器纳管
   * 权限点。只补缺不覆盖；迁移标记入 iam:migrations 集合供观测（P2 修正⑯）。
   */
  ensureConnectorPermissionsMigration() {
    const collection = this.ctx.opsStorage.collection("iam:migrations");
    const marker = collection.findOne((item) => item.key === "connector-permissions-v1");
    const touched = [];
    for (const [code, additions] of Object.entries(BUILTIN_ROLE_MIGRATION)) {
      const role = this.roles().findOne((item) => item.code === code);
      if (!role) continue;
      const missing = additions.filter((point) => !role.permissions.includes(point));
      if (missing.length > 0) {
        this.roles().update(role.id, { permissions: [...role.permissions, ...missing] });
        this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: "builtin_role_migration", roleId: role.id });
        touched.push(`${code}+${missing.join(",")}`);
      }
    }
    const resourceAdmin = this.roles().findOne((item) => item.code === "resource_admin");
    if (resourceAdmin && !resourceAdmin.permissions.includes("connector.*")) {
      this.roles().update(resourceAdmin.id, { permissions: [...resourceAdmin.permissions, "connector.*"] });
      this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: "builtin_role_migration", roleId: resourceAdmin.id });
      touched.push("resource_admin+connector.*");
    }
    if (!marker) {
      collection.insert({
        id: newId("mig"),
        key: "connector-permissions-v1",
        ...touched.length > 0 ? { note: touched.join("; ") } : {}
      });
    }
    return { applied: marker === void 0 || touched.length > 0, touched };
  }
  /**
   * 可授权权限上限（安全审查 P0-02，2026-10-31）：非平台超级管理员（无 '*'）的操作者，
   * 只能授予/管理自己本身已持有的权限点——组织管理员（iam.*）不得把任何账号提为平台超管、
   * 不得授予自己没有的跨域能力、不得创建/编辑含 '*' 或超出自身权限集的角色。
   * actor.permissions 为解析后的字面量点集（'*' 仅平台超管持有）；requested 允许通配形态，
   * 逐点展开后比对。REST 与工具桥等一切外部入口共用（服务层单点裁决）。
   */
  assertGrantCeiling(actor, requested, action) {
    if (!actor) {
      throw new OrgScopeDeniedError(t("\u89D2\u8272\u7BA1\u7406\u64CD\u4F5C\u7F3A\u5C11\u64CD\u4F5C\u8005\u8EAB\u4EFD\uFF08{action}\uFF09\uFF1A\u5916\u90E8\u5165\u53E3\u5FC5\u987B\u643A\u5E26\u53EF\u5F52\u56E0\u8C03\u7528\u8005\uFF0C\u5185\u90E8\u7CFB\u7EDF\u94FE\u8DEF\u8BF7\u663E\u5F0F\u4F20\u5165\u7CFB\u7EDF\u8EAB\u4EFD\uFF08\u9632\u63D0\u6743\uFF0C\u5B89\u5168\u5BA1\u67E5 P0-02\uFF09", { action }));
    }
    if (actor.permissions.includes("*")) return;
    const owned = new Set(actor.permissions);
    for (const permission of requested) {
      if (permission === "*") {
        throw new OrgScopeDeniedError(t("\u4EC5\u5E73\u53F0\u8D85\u7EA7\u7BA1\u7406\u5458\u53EF\u6388\u4E88/\u914D\u7F6E\u5168\u91CF\u6743\u9650\u300C*\u300D\uFF08{action}\uFF0C\u9632\u63D0\u6743\uFF09", { action }));
      }
      if (permission.endsWith(".*")) {
        const prefix = permission.slice(0, -2);
        const leaked = PermissionCatalog.filter((item) => item.point.startsWith(`${prefix}.`) && !owned.has(item.point)).map((item) => item.point);
        if (leaked.length > 0) {
          throw new OrgScopeDeniedError(t("\u8D85\u51FA\u53EF\u6388\u6743\u4E0A\u9650\uFF08{action}\uFF09\uFF1A\u64CD\u4F5C\u8005\u672A\u6301\u6709 {points}\uFF08\u4E0D\u53EF\u6388\u4E88\u81EA\u8EAB\u6CA1\u6709\u7684\u6743\u9650\uFF0C\u9632\u63D0\u6743\uFF09", { action, points: leaked.slice(0, 5).join("\u3001") }));
        }
      } else if (!owned.has(permission)) {
        throw new OrgScopeDeniedError(t("\u8D85\u51FA\u53EF\u6388\u6743\u4E0A\u9650\uFF08{action}\uFF09\uFF1A\u64CD\u4F5C\u8005\u672A\u6301\u6709\u6743\u9650\u70B9 {point}\uFF08\u4E0D\u53EF\u6388\u4E88\u81EA\u8EAB\u6CA1\u6709\u7684\u6743\u9650\uFF0C\u9632\u63D0\u6743\uFF09", { action, point: permission }));
      }
    }
  }
  /** 非平台超管不得改动「组织子树外账号仍挂载的角色」——防止借编辑共享角色影响其他组织持有人（P0-02）。 */
  assertRoleHolderScope(actor, roleId, action) {
    if (!actor || actor.permissions.includes("*")) return;
    const actorOrgId = actor.orgId ?? (actor.userId ? this.users().get(actor.userId)?.orgId : void 0);
    if (!actorOrgId) throw new OrgScopeDeniedError(t("\u89D2\u8272\u7BA1\u7406\u64CD\u4F5C\u7F3A\u5C11\u64CD\u4F5C\u8005\u7EC4\u7EC7\u5F52\u5C5E\uFF08{action}\uFF09", { action }));
    const allowed = new Set(this.orgSubtreeIds(actorOrgId));
    const outside = this.users().find((user) => user.roleIds.includes(roleId) && !allowed.has(user.orgId));
    if (outside.length > 0) {
      throw new OrgScopeDeniedError(t("\u8BE5\u89D2\u8272\u4ECD\u88AB\u672C\u7EC4\u7EC7\u5B50\u6811\u5916\u7684\u8D26\u53F7\u6302\u8F7D\uFF08{action}\u88AB\u62D2\u7EDD\uFF09\uFF1A{names} \u7B49\u2014\u2014\u8BF7\u7531\u5E73\u53F0\u8D85\u7EA7\u7BA1\u7406\u5458\u5904\u7406", { action, names: outside.slice(0, 3).map((user) => user.displayName).join("\u3001") }));
    }
  }
  createRole(input, actor) {
    if (!input.code || !/^[a-z0-9_]+$/.test(input.code)) throw new Error(t("\u89D2\u8272 code \u4EC5\u652F\u6301\u5C0F\u5199\u5B57\u6BCD/\u6570\u5B57/\u4E0B\u5212\u7EBF"));
    if (this.roles().findOne((role) => role.code === input.code)) throw new Error(t("\u89D2\u8272 code \u5DF2\u5B58\u5728\uFF1A{code}", { code: input.code }));
    this.assertPermissions(input.permissions);
    this.assertGrantCeiling(actor, input.permissions, t("\u521B\u5EFA\u89D2\u8272"));
    return this.roles().insert({
      id: newId("rol"),
      code: input.code,
      name: input.name,
      builtin: false,
      description: input.description ?? "",
      permissions: input.permissions
    });
  }
  updateRole(id, patch, actor) {
    const role = this.roles().get(id);
    if (!role) throw new Error(t("\u89D2\u8272\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    if (role.builtin && patch.permissions) throw new Error(t("\u5185\u7F6E\u89D2\u8272\u7684\u6743\u9650\u4E0D\u53EF\u4FEE\u6539"));
    if (patch.permissions) this.assertPermissions(patch.permissions);
    if (patch.permissions) {
      this.assertGrantCeiling(actor, patch.permissions, t("\u7F16\u8F91\u89D2\u8272"));
      this.assertRoleHolderScope(actor, id, t("\u7F16\u8F91\u89D2\u8272"));
    }
    const updated = this.roles().update(id, patch);
    this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: "role", roleId: id });
    return updated;
  }
  /**
   * 删除自定义角色（2026-10-14 路线图 R4 删除面补齐）：角色治理此前只增不改不删——
   * 试错/演示产生的废角色永久滞留目录。三重护栏：
   *   ① 内置角色不可删（平台基线，删掉会让新装库与存量库 RBAC 面分叉）；
   *   ② 仍有账号挂载时不可删（删了会把挂载者权限整体蒸发，须先解绑）；
   *   ③ 不存在即拒（与 updateRole 同口径，不静默成功）。
   */
  deleteRole(id, actor) {
    const role = this.roles().get(id);
    if (!role) throw new Error(t("\u89D2\u8272\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    if (role.builtin) throw new Error(t("\u5185\u7F6E\u89D2\u8272\u300C{name}\u300D\u4E0D\u53EF\u5220\u9664\uFF08\u5E73\u53F0\u57FA\u7EBF\uFF1B\u5982\u9700\u6536\u655B\u6743\u9650\u8BF7\u8D70\u89D2\u8272\u7F16\u8F91\uFF09", { name: role.name }));
    this.assertRoleHolderScope(actor, id, t("\u5220\u9664\u89D2\u8272"));
    const holders = this.users().all().filter((user) => user.roleIds.includes(id));
    if (holders.length > 0) {
      throw new Error(t("\u89D2\u8272\u300C{name}\u300D\u4ECD\u88AB {count} \u4E2A\u8D26\u53F7\u6302\u8F7D\uFF08{names} \u7B49\uFF09\uFF0C\u8BF7\u5148\u5728\u8D26\u53F7\u7BA1\u7406\u4E2D\u89E3\u9664\u540E\u518D\u5220\u9664", { name: role.name, count: holders.length, names: holders.slice(0, 5).map((user) => user.displayName).join("\u3001") }));
    }
    this.roles().remove(id);
    this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: "role", roleId: id });
  }
  assertPermissions(permissions) {
    for (const permission of permissions) {
      if (permission === "*" || permission.endsWith(".*")) continue;
      if (!PermissionCatalog.some((item) => item.point === permission)) {
        throw new Error(t("\u672A\u77E5\u6743\u9650\u70B9\uFF1A{permission}", { permission }));
      }
    }
  }
  assignRoles(userId, roleIds, actor) {
    const user = this.requireUser(userId);
    this.assertManageScope(actor, user.orgId, t("\u8C03\u6574\u89D2\u8272"));
    for (const roleId of roleIds) {
      if (!this.roles().get(roleId)) throw new Error(t("\u89D2\u8272\u4E0D\u5B58\u5728\uFF1A{id}", { id: roleId }));
    }
    this.assertGrantCeiling(actor, this.resolveRolePermissions(roleIds), t("\u5206\u914D\u89D2\u8272"));
    const updated = this.users().update(userId, { roleIds });
    this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: "user_roles", userId });
    return updated;
  }
  /** 解析一组角色的实际权限点集合（并集，支持通配）；人机两侧共用同一解析规则。 */
  resolveRolePermissions(roleIds) {
    const result = /* @__PURE__ */ new Set();
    for (const roleId of roleIds) {
      const role = this.roles().get(roleId);
      if (!role) continue;
      if (role.permissions.includes("*")) return ["*"];
      for (const permission of role.permissions) {
        if (permission.endsWith(".*")) {
          const prefix = permission.slice(0, -2);
          for (const item of PermissionCatalog) {
            if (item.point.startsWith(`${prefix}.`)) result.add(item.point);
          }
        } else {
          result.add(permission);
        }
      }
    }
    return [...result];
  }
  /** 计算用户的实际权限点集合（角色并集，支持通配）。 */
  userPermissions(userId) {
    const user = this.users().get(userId);
    if (!user) return [];
    return this.resolveRolePermissions(user.roleIds);
  }
  hasPermission(userId, point) {
    const permissions = this.userPermissions(userId);
    return permissions.includes("*") || permissions.includes(point);
  }
  // -- 用户组 -------------------------------------------------------------
  createGroup(input) {
    if (!input.name?.trim()) throw new Error(t("\u7528\u6237\u7EC4\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A"));
    if (this.groups().findOne((group) => group.name === input.name)) throw new Error(t("\u7528\u6237\u7EC4\u5DF2\u5B58\u5728\uFF1A{name}", { name: input.name }));
    if (input.type === "dynamic" && !input.rule) throw new Error(t("\u52A8\u6001\u7528\u6237\u7EC4\u5FC5\u987B\u63D0\u4F9B\u5708\u4EBA\u89C4\u5219"));
    return this.groups().insert({
      id: newId("grp"),
      name: input.name,
      type: input.type,
      ...input.rule !== void 0 ? { rule: input.rule } : {},
      memberIds: input.type === "static" ? input.memberIds ?? [] : [],
      description: input.description ?? ""
    });
  }
  updateGroup(id, patch) {
    const group = this.groups().get(id);
    if (!group) throw new Error(t("\u7528\u6237\u7EC4\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    return this.groups().update(id, patch);
  }
  deleteGroup(id) {
    return this.groups().remove(id);
  }
  /** 解析用户组成员（动态组按规则实时圈人）。 */
  resolveGroupMembers(id) {
    const group = this.groups().get(id);
    if (!group) throw new Error(t("\u7528\u6237\u7EC4\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    if (group.type === "static") {
      return group.memberIds.map((memberId) => this.users().get(memberId)).filter((user) => Boolean(user) && user.status === "active");
    }
    const rule = group.rule ?? {};
    const orgIds = rule.orgIds?.length ? new Set(this.orgSubtreeIds(rule.orgIds[0]).concat(rule.orgIds)) : void 0;
    return this.users().find((user) => {
      if (user.status !== "active") return false;
      if (orgIds && !orgIds.has(user.orgId)) return false;
      if (rule.title && user.title !== rule.title) return false;
      return true;
    });
  }
  groupsOfUser(userId) {
    return this.groups().find((group) => {
      if (group.type === "static") return group.memberIds.includes(userId);
      return this.resolveGroupMembers(group.id).some((user) => user.id === userId);
    });
  }
  /** 动态用户组成员快照（dev-plan-nas-authz §2.2：重算结果落快照，漂移可观测）。 */
  groupSnapshots() {
    return this.ctx.opsStorage.collection("iam:groupSnapshots");
  }
  /**
   * 重算全部动态用户组成员并与快照比对（连接器同步收尾 / REST 手动触发）。
   * 漂移人数 ≥ 阈值（组上 driftAlertThreshold，缺省 5）或组被标记为 NAS C 关联组（authzRoleC）
   * 时发 `nas.authz.cGroupDrift` 事件——防止 HR 调整静默改变跨域只读范围。
   * 返回本次发生漂移的组清单（含增减明细），供调用方展示/断言。
   */
  refreshGroupSnapshots(actor) {
    const drifts = [];
    for (const group of this.groups().find((item) => item.type === "dynamic")) {
      const memberIds = this.resolveGroupMembers(group.id).map((user) => user.id).sort();
      const existing = this.groupSnapshots().findOne((item) => item.groupId === group.id);
      const previous = existing?.memberIds ?? null;
      if (previous !== null) {
        const prevSet = new Set(previous);
        const nextSet = new Set(memberIds);
        const added = memberIds.filter((id) => !prevSet.has(id));
        const removed = previous.filter((id) => !nextSet.has(id));
        if (added.length > 0 || removed.length > 0) {
          const threshold = group.driftAlertThreshold ?? DEFAULT_GROUP_DRIFT_THRESHOLD;
          const alerted = group.authzRoleC === true || added.length + removed.length >= threshold;
          if (alerted) {
            this.ctx.platformBus.emit("nas.authz.cGroupDrift", {
              groupId: group.id,
              groupName: group.name,
              added,
              removed,
              addedCount: added.length,
              removedCount: removed.length,
              threshold,
              actor
            });
          }
          drifts.push({ groupId: group.id, groupName: group.name, added, removed, threshold, alerted });
        }
      }
      const record = { id: existing?.id ?? `gsn_${group.id}`, groupId: group.id, memberIds, computedAt: (/* @__PURE__ */ new Date()).toISOString() };
      if (existing) this.groupSnapshots().update(existing.id, record);
      else this.groupSnapshots().insert(record);
    }
    return drifts;
  }
  // -- 三方接入 -----------------------------------------------------------
  /** 按平台类型取第一条配置（旧调用兼容；多主体请用 connectorConfigById/resolveConnectorConfig）。 */
  connectorConfig(provider) {
    return this.connectorConfigs().findOne((config) => config.provider === provider);
  }
  /** 按配置实例 id 寻址（多主体：配置实例以 ConnectorConfigRecord.id 寻址，provider 仅表示平台类型）。 */
  connectorConfigById(id) {
    return this.connectorConfigs().get(id);
  }
  /** 解析配置实例：先按 id 找，找不到按 provider 取第一条（enabled 优先）——REST 旧参数兼容入口。 */
  resolveConnectorConfig(idOrProvider) {
    const byId = this.connectorConfigById(idOrProvider);
    if (byId) return byId;
    const candidates = this.connectorConfigs().find((config) => config.provider === idOrProvider);
    return candidates.find((config) => config.enabled) ?? candidates[0];
  }
  /** 更新/创建接入配置：带 id 按 id 更新；不带 id 维持旧行为（按 provider 第一条更新，无则建）。 */
  upsertConnectorConfig(input) {
    if (!IamService.BUILTIN_CONNECTOR_PROVIDERS.has(input.provider)) throw new Error(t("\u672A\u6CE8\u518C\u7684\u8FDE\u63A5\u5668\uFF1A{provider}", { provider: input.provider }));
    let existing;
    if (input.id !== void 0) {
      existing = this.connectorConfigById(input.id);
      if (!existing) throw new Error(t("\u63A5\u5165\u914D\u7F6E\u4E0D\u5B58\u5728\uFF1A{id}", { id: input.id }));
    } else {
      existing = this.connectorConfig(input.provider);
    }
    const secret = input.appSecret ?? existing?.secretActual ?? "demo-secret";
    const mode = input.mode ?? (secret.startsWith("demo-") ? "mock" : existing?.mode ?? "real");
    const payload = {
      provider: input.provider,
      name: input.name ?? existing?.name ?? `${input.provider}-${input.corpId}`,
      enabled: input.enabled ?? existing?.enabled ?? true,
      corpId: input.corpId,
      appKey: input.appKey,
      secretMasked: mask(secret, 4),
      secretActual: secret,
      syncOrgRoot: input.syncOrgRoot ?? existing?.syncOrgRoot ?? "",
      intervalMinutes: input.intervalMinutes ?? existing?.intervalMinutes ?? 60,
      callbackUrl: input.callbackUrl ?? existing?.callbackUrl ?? "",
      loginEnabled: input.loginEnabled ?? existing?.loginEnabled ?? false,
      conflictStrategy: input.conflictStrategy ?? existing?.conflictStrategy ?? "manual",
      mode,
      ...input.apiBase !== void 0 ? { apiBase: input.apiBase } : existing?.apiBase !== void 0 ? { apiBase: existing.apiBase } : {},
      ...input.oapiBase !== void 0 ? { oapiBase: input.oapiBase } : existing?.oapiBase !== void 0 ? { oapiBase: existing.oapiBase } : {},
      ...input.targetOrgId !== void 0 ? { targetOrgId: input.targetOrgId } : existing?.targetOrgId !== void 0 ? { targetOrgId: existing.targetOrgId } : {}
    };
    const saved = existing ? this.connectorConfigs().update(existing.id, payload) : this.connectorConfigs().insert({ id: newId("conn"), ...payload });
    this.applyConnectorMode(saved.id);
    return saved;
  }
  /** 新建接入配置实例（多主体：同一 provider 可接入多家企业，provider|corpId 由引擎级唯一约束拒绝重复主体）。 */
  createConnectorConfig(input) {
    if (!IamService.BUILTIN_CONNECTOR_PROVIDERS.has(input.provider)) throw new Error(t("\u672A\u6CE8\u518C\u7684\u8FDE\u63A5\u5668\uFF1A{provider}", { provider: input.provider }));
    const secret = input.appSecret ?? "demo-secret";
    const mode = input.mode ?? (secret.startsWith("demo-") ? "mock" : "real");
    const saved = this.connectorConfigs().insert({
      id: newId("conn"),
      provider: input.provider,
      name: input.name ?? `${input.provider}-${input.corpId}`,
      enabled: input.enabled ?? true,
      corpId: input.corpId,
      appKey: input.appKey,
      secretMasked: mask(secret, 4),
      secretActual: secret,
      syncOrgRoot: input.syncOrgRoot ?? "",
      intervalMinutes: input.intervalMinutes ?? 60,
      callbackUrl: input.callbackUrl ?? "",
      loginEnabled: input.loginEnabled ?? false,
      conflictStrategy: input.conflictStrategy ?? "manual",
      mode,
      ...input.apiBase !== void 0 ? { apiBase: input.apiBase } : {},
      ...input.oapiBase !== void 0 ? { oapiBase: input.oapiBase } : {},
      ...input.targetOrgId !== void 0 ? { targetOrgId: input.targetOrgId } : {}
    });
    this.applyConnectorMode(saved.id);
    return saved;
  }
  /** 删除接入配置实例：同时注销运行时连接器/身份源注册项（不存在则抛错）。 */
  deleteConnectorConfig(id) {
    if (!this.connectorConfigById(id)) throw new Error(t("\u63A5\u5165\u914D\u7F6E\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    this.connectorConfigs().remove(id);
    this.connectors.delete(id);
    this.authProviders.delete(id);
  }
  /** 按单条配置实例实例化连接器/身份源 Adapter 的 real/mock 实现（第 0 步：连接器真实化；多主体按 configId 注册）。 */
  applyConnectorMode(configId) {
    const config = this.connectorConfigById(configId);
    if (!config) return;
    if (config.provider === "dingtalk") {
      if (config.mode === "real" && config.secretActual) {
        const credentials = {
          corpId: config.corpId,
          appKey: config.appKey,
          appSecret: config.secretActual,
          ...config.apiBase !== void 0 ? { apiBase: config.apiBase } : {},
          ...config.oapiBase !== void 0 ? { oapiBase: config.oapiBase } : {}
        };
        this.registerConnector(config.id, new RealDingTalkConnector(credentials, { syncOrgRoot: config.syncOrgRoot }));
        this.registerAuthProvider(config.id, new RealDingTalkAuthAdapter(credentials));
      } else if (config.mode === "mock") {
        if (process.env.DEMO_SEED === "1") {
          this.registerConnector(config.id, new DingTalkConnector());
          this.registerAuthProvider(config.id, new DingTalkAuthAdapter());
        } else {
          this.registerConnector(config.id, new DingTalkConnector());
        }
      }
    }
  }
  async testConnector(idOrProvider) {
    const config = this.resolveConnectorConfig(idOrProvider);
    const connector = config ? this.connectors.get(config.id) : void 0;
    if (!connector) throw new Error(t("\u672A\u6CE8\u518C\u7684\u8FDE\u63A5\u5668\uFF1A{provider}", { provider: idOrProvider }));
    return connector.healthCheck();
  }
  /** 全量同步：目录映射 + 冲突入队 + 离职联动。失败同样落 lastSyncResult（ok:false），避免「点了没反应」。 */
  async syncConnector(idOrProvider, actor) {
    const config = this.resolveConnectorConfig(idOrProvider);
    if (!config || !config.enabled) throw new Error(t("\u8FDE\u63A5\u5668\u672A\u542F\u7528\uFF1A{provider}", { provider: idOrProvider }));
    const connector = this.connectors.get(config.id);
    if (!connector) throw new Error(t("\u672A\u6CE8\u518C\u7684\u8FDE\u63A5\u5668\uFF1A{provider}", { provider: idOrProvider }));
    try {
      return await this.runSync(config.provider, actor, config, connector);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = { ok: false, created: 0, updated: 0, conflicts: 0, frozen: 0, message: t("\u540C\u6B65\u5931\u8D25\uFF1A{message}", { message }) };
      this.connectorConfigs().update(config.id, { lastSyncAt: (/* @__PURE__ */ new Date()).toISOString(), lastSyncResult: result });
      throw error;
    }
  }
  async runSync(provider, actor, config, connector) {
    const directory = await connector.fetchDirectory();
    const remoteOrgToId = /* @__PURE__ */ new Map();
    let created = 0;
    let updated = 0;
    for (const remoteOrg of directory.orgs) {
      const parent = remoteOrg.parentRemoteId ? remoteOrgToId.get(remoteOrg.parentRemoteId) : config.targetOrgId ?? null;
      if (parent === void 0 && remoteOrg.parentRemoteId) continue;
      const local = this.orgs().findOne((org) => org.customFields["remoteId"] === remoteOrg.remoteId && org.customFields["connectorId"] === config.id) ?? this.orgs().findOne((org) => org.name === remoteOrg.name && org.parentId === parent && (org.customFields["connectorId"] === void 0 || org.customFields["connectorId"] === config.id));
      if (local) {
        if (local.customFields["connectorId"] !== config.id || local.customFields["remoteId"] !== remoteOrg.remoteId) {
          this.orgs().update(local.id, { customFields: { ...local.customFields, remoteId: remoteOrg.remoteId, connectorId: config.id } });
        }
        remoteOrgToId.set(remoteOrg.remoteId, local.id);
      } else {
        const record = this.createOrg({ name: remoteOrg.name, parentId: parent, customFields: { remoteId: remoteOrg.remoteId, connectorId: config.id } }, SYSTEM_ACTOR);
        remoteOrgToId.set(remoteOrg.remoteId, record.id);
        created++;
      }
    }
    let conflicts = 0;
    let frozen = 0;
    for (const remoteUser of directory.users) {
      const orgId = remoteOrgToId.get(remoteUser.orgRemoteId);
      if (!orgId) continue;
      const secondaryOrgId = (remoteUser.extraOrgRemoteIds ?? []).map((remoteOrgId) => remoteOrgToId.get(remoteOrgId)).find(Boolean);
      let local = this.users().get(this.identityLinks().findOne((link) => link.provider === provider && link.providerUserId === remoteUser.remoteId && link.kind !== "staff" && (link.corpId ?? "") === config.corpId)?.userId ?? "") ?? this.users().findOne((user) => user.bindings.some((binding) => binding.provider === provider && binding.unionId === remoteUser.remoteId && (binding.corpId ?? "") === config.corpId)) ?? this.users().findOne((user) => user.jobNumber === remoteUser.jobNumber);
      if (!local) {
        const { user: record } = this.createUser({
          username: remoteUser.jobNumber.toLowerCase(),
          displayName: remoteUser.name,
          orgId,
          title: remoteUser.title,
          email: remoteUser.email,
          jobNumber: remoteUser.jobNumber
        }, SYSTEM_ACTOR);
        this.users().update(record.id, secondaryOrgId ? { status: "active", primaryOrgId: orgId, orgId: secondaryOrgId } : { status: "active" });
        this.linkIdentity(record.id, { provider, providerUserId: remoteUser.remoteId, corpId: config.corpId, displayName: remoteUser.name, kind: "login" }, "connector-sync");
        if (remoteUser.remoteUserId) {
          try {
            this.linkIdentity(record.id, { provider, providerUserId: remoteUser.remoteUserId, corpId: config.corpId, displayName: remoteUser.name, kind: "staff" }, "connector-sync");
          } catch {
          }
        }
        created++;
        continue;
      }
      const exemptKey = `${provider}|${config.corpId ?? ""}`;
      const exempted = (local.bindingExemptions ?? []).includes(exemptKey);
      const hasLinkForSubject = (providerUserId) => Boolean(this.identityLinks().findOne((link) => link.provider === provider && link.userId === local.id && link.providerUserId === providerUserId && (link.corpId ?? "") === config.corpId));
      if (!exempted && !hasLinkForSubject(remoteUser.remoteId)) {
        try {
          this.linkIdentity(local.id, { provider, providerUserId: remoteUser.remoteId, corpId: config.corpId, displayName: remoteUser.name, kind: "login" }, "connector-sync");
        } catch {
        }
      }
      if (remoteUser.remoteUserId && !hasLinkForSubject(remoteUser.remoteUserId)) {
        try {
          this.linkIdentity(local.id, { provider, providerUserId: remoteUser.remoteUserId, corpId: config.corpId, displayName: remoteUser.name, kind: "staff" }, "connector-sync");
        } catch {
        }
      }
      if (secondaryOrgId && (local.primaryOrgId !== orgId || local.orgId !== secondaryOrgId)) {
        this.users().update(local.id, { primaryOrgId: orgId, orgId: secondaryOrgId });
        local = this.users().get(local.id) ?? local;
      }
      if (!remoteUser.active) {
        if (local.status === "active" || local.status === "pending") {
          this.freezeUser(local.id, t("\u4E09\u65B9\u540C\u6B65\uFF1A{provider} \u901A\u8BAF\u5F55\u5DF2\u79BB\u804C", { provider }), SYSTEM_ACTOR);
          frozen++;
        }
        continue;
      }
      const attrDiffers = local.displayName !== remoteUser.name || local.title !== remoteUser.title || local.orgId !== (secondaryOrgId ?? orgId);
      if (attrDiffers) {
        if (config.conflictStrategy === "third_party_wins") {
          this.users().update(local.id, { displayName: remoteUser.name, title: remoteUser.title, orgId: secondaryOrgId ?? orgId });
          updated++;
        } else if (config.conflictStrategy === "platform_wins") {
          updated++;
        } else {
          this.conflicts().insert({
            id: newId("cfl"),
            provider,
            kind: "user_attr",
            thirdPartyData: { displayName: remoteUser.name, title: remoteUser.title, orgId, orgName: this.orgs().get(orgId)?.name },
            platformData: { displayName: local.displayName, title: local.title, orgId: local.orgId, orgName: this.orgs().get(local.orgId)?.name },
            status: "pending"
          });
          conflicts++;
        }
      }
    }
    this.backfillIdentityLinkKinds();
    let leaderSynced = 0;
    let leaderPinned = 0;
    for (const remoteOrg of directory.orgs) {
      if (!Array.isArray(remoteOrg.managerRemoteIds)) continue;
      const localOrgId = remoteOrgToId.get(remoteOrg.remoteId);
      if (!localOrgId) continue;
      const localOrg = this.orgs().get(localOrgId);
      if (localOrg?.leaderSource === "manual") {
        leaderPinned++;
        continue;
      }
      const leaderUserIds = remoteOrg.managerRemoteIds.map((remoteUserId) => this.identityLinks().findOne((link) => link.provider === provider && link.providerUserId === remoteUserId && (link.corpId ?? "") === config.corpId)?.userId).filter((id) => Boolean(id));
      this.orgs().update(localOrgId, { leaderUserIds, leaderSource: "sync" });
      leaderSynced++;
    }
    const drifts = this.refreshGroupSnapshots("connector-sync");
    const result = { ok: true, created, updated, conflicts, frozen, message: t("\u540C\u6B65\u5B8C\u6210\uFF1A\u65B0\u5EFA {created}\uFF0C\u66F4\u65B0 {updated}\uFF0C\u51B2\u7A81 {conflicts}\uFF0C\u79BB\u804C\u51BB\u7ED3 {frozen}{leaderSyncedPart}{leaderPinnedPart}{driftsPart}", { created, updated, conflicts, frozen, leaderSyncedPart: leaderSynced > 0 ? t("\uFF0C\u8D1F\u8D23\u4EBA {n}", { n: leaderSynced }) : "", leaderPinnedPart: leaderPinned > 0 ? t("\uFF0C\u624B\u52A8\u9501\u5B9A {n}", { n: leaderPinned }) : "", driftsPart: drifts.length > 0 ? t("\uFF0C\u7EC4\u6F02\u79FB {n}", { n: drifts.length }) : "" }) };
    this.connectorConfigs().update(config.id, { lastSyncAt: (/* @__PURE__ */ new Date()).toISOString(), lastSyncResult: result });
    this.ctx.platformBus.emit(PlatformEvents.ConnectorSynced, { provider, actor, ...result });
    return result;
  }
  resolveConflict(id, keep, actor) {
    const conflict = this.conflicts().get(id);
    if (!conflict) throw new Error(t("\u51B2\u7A81\u8BB0\u5F55\u4E0D\u5B58\u5728\uFF1A{id}", { id }));
    if (conflict.status === "resolved") throw new Error(t("\u8BE5\u51B2\u7A81\u5DF2\u5904\u7406"));
    if (conflict.kind === "user_attr") {
      const jobNumber = String(conflict.thirdPartyData.jobNumber ?? "");
      const local = this.users().findOne((user) => user.bindings.some((binding) => binding.provider === conflict.provider && binding.unionId === conflict.thirdPartyData.unionId)) ?? (jobNumber ? this.users().findOne((user) => user.jobNumber === jobNumber) : void 0);
      if (local) {
        const source = keep === "third_party" ? conflict.thirdPartyData : conflict.platformData;
        this.users().update(local.id, {
          displayName: String(source.displayName ?? local.displayName),
          title: String(source.title ?? local.title),
          orgId: String(source.orgId ?? local.orgId)
        });
      }
    }
    return this.conflicts().update(id, {
      status: "resolved",
      resolution: keep,
      resolvedBy: actor,
      resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  /**
   * 连接器自动同步巡检（定时器每分钟调用；POST /api/iam/connectors/auto-sync 为其手动触发口）：
   * 已启用的配置实例中，lastSyncAt 距今超过生效间隔（intervalMinutes，下限 5 分钟；0=关闭自动同步）
   * 即全量同步——从未同步过的连接器视为到期（启动即补同步）。actor 记 'auto-sync' 与手动同步区分；
   * 单配置失败不阻断其余配置（失败已落 lastSyncResult），返回逐条处理结果。
   */
  async runDueAutoSyncs(now = Date.now()) {
    if (process.env.IAM_CONNECTOR_AUTO_SYNC === "off") return [];
    const handled = [];
    for (const config of this.connectorConfigs().all()) {
      const intervalMinutes = config.intervalMinutes ?? 0;
      if (!config.enabled || intervalMinutes <= 0) continue;
      if (config.lastSyncAt && now - new Date(config.lastSyncAt).getTime() < Math.max(intervalMinutes, AUTO_SYNC_MIN_INTERVAL_MINUTES) * 6e4) continue;
      if (this.autoSyncing.has(config.id)) continue;
      this.autoSyncing.add(config.id);
      try {
        const result = await this.syncConnector(config.id, "auto-sync");
        handled.push({ configId: config.id, provider: config.provider, name: config.name, ok: true, message: result.message });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ctx.logger("iam").warn(`\u8FDE\u63A5\u5668\u81EA\u52A8\u540C\u6B65\u5931\u8D25\uFF08${config.name}\uFF09\uFF1A${message}`);
        handled.push({ configId: config.id, provider: config.provider, name: config.name, ok: false, message });
      } finally {
        this.autoSyncing.delete(config.id);
      }
    }
    if (handled.length > 0) {
      this.ctx.logger("iam").info(`\u8FDE\u63A5\u5668\u81EA\u52A8\u540C\u6B65\u5DE1\u68C0\uFF1A\u672C\u6B21\u5904\u7406 ${handled.length} \u6761\uFF08${handled.filter((item) => item.ok).length} \u6210\u529F\uFF09`);
    }
    return handled;
  }
  /**
   * 全员名册（组织数据通道）：供已接入的外部应用（人事/绩效等）以机器凭证
   * （iam.roster.read scope，应用注册凭证经控制台追加授权）一次性拉取在职账号与组织树，
   * 用于铺排填报任务与 sub → 业务角色映射；id 即 userinfo 的 sub（稳定关联键）。
   * PII 最小化：不含手机号；已注销账号不出现在名册；每次拉取由控制台层记审计（invoke）。
   */
  roster() {
    const orgNames = new Map(this.orgs().all().map((org) => [org.id, org.name]));
    return {
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      orgs: this.orgs().all().map((org) => ({
        id: org.id,
        name: org.name,
        parentId: org.parentId,
        status: org.status,
        leaderUserIds: this.leadersOf(org.id)
      })),
      users: this.users().all().filter((user) => user.status !== "deactivated").map((user) => ({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        jobNumber: user.jobNumber ?? "",
        title: user.title,
        orgId: user.orgId,
        orgName: orgNames.get(user.orgId) ?? "",
        ...user.primaryOrgId !== void 0 ? { primaryOrgId: user.primaryOrgId } : {},
        status: user.status,
        ...user.accountType !== void 0 ? { accountType: user.accountType } : {}
      }))
    };
  }
}
const SCRYPT_PREFIX = "scrypt$";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
function hashPasswordScrypt(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${SCRYPT_PREFIX}${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}
function verifyPasswordHash(record, password) {
  if (record.passwordHash.startsWith(SCRYPT_PREFIX)) {
    const [n, r, p, saltB64, hashB64] = record.passwordHash.slice(SCRYPT_PREFIX.length).split("$");
    const expected2 = Buffer.from(hashB64 ?? "", "base64");
    if (expected2.length === 0 || !Number(n) || !Number(r) || !Number(p)) return false;
    try {
      const actual2 = scryptSync(password, Buffer.from(saltB64 ?? "", "base64"), expected2.length, { N: Number(n), r: Number(r), p: Number(p) });
      return timingSafeEqual(expected2, actual2);
    } catch {
      return false;
    }
  }
  const expected = Buffer.from(record.passwordHash, "utf8");
  const actual = Buffer.from(hashPassword(password, record.passwordSalt), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const name = "iam";
const inject = ["opsStorage", "platformBus"];
function apply(ctx) {
  ctx.plugin(IamService);
  ctx.plugin(iamTools);
}
export {
  BUILTIN_ROLE_MIGRATION,
  BuiltinRoles,
  CONNECTOR_ROLE_MIGRATION,
  DEFAULT_GROUP_DRIFT_THRESHOLD,
  DEFAULT_TENANT_ID,
  DingTalkConnector,
  IamService,
  OrgScopeDeniedError,
  PermissionCatalog,
  RealDingTalkConnector,
  SYSTEM_ACTOR,
  apply,
  inject,
  name
};
