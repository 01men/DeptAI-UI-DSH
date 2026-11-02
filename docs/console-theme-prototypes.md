# 控制台多风格原型

从工作台的主题按钮单击可立即切换五个版本，控制台顶栏的「切换界面主题」也可在其他页面使用。偏好仅保存在当前浏览器，不改变业务数据、登录身份或平台分组主题。

| 主题 | 表达重点 |
| --- | --- |
| 经典 · 原版 | 既有工作台与页面布局。 |
| 澄明 · 经营总览 | 目标、项目、数字员工、待审批事项与任务状态。 |
| 星图 · 协作关系 | 以可拖拽缩放的图谱呈现目标、项目、任务和数字员工的已登记关系，节点列表支持键盘操作。 |
| 夜航 · 治理观察 | 经营洞察、风险、今日用量与按日 Token 消耗趋势。 |
| 冰晶 · 协同全景 | 数字员工、企业能力与治理一屏协作；首页的冰晶体验入口可直接切换。 |

四套新主题在驾驶舱中增加对应视图，其他页面随主题切换色彩；原有工作台视图和功能入口继续使用。选回经典即可回到原来的工作台。自定义主题和已有的 `data-platform` 平台身份彼此独立。公共首页位于 `#/home`；演示实例默认仍直接进入控制台。

## 数据与权限

视图使用现有 `/api/overview` 和执行中枢的 overview、goals、projects、issues，以及具备权限时的 agents 接口；所有访问沿用既有 API 客户端与权限判断。图谱关系只使用父目标、项目所属目标、任务所属项目和任务指派的 Agent 等字段；连线不代表真实资产调用或协作已发生。图谱最多展示 60 个可见节点，记录总数仍显示完整接口口径。缺少权限、没有数据或图形组件加载失败时显示明确空态，不补造数据。

澄明和夜航采用本地精简版 D3；星图采用本地 Cytoscape.js。均按需加载，无第三方 CDN。许可证和构建信息见 `packages/plugin-console/public/vendor/README.md`。

冰晶主题以 `/api/workforce/overview` 的员工档案数呈现数字员工，受 `workforce.read` 约束；不以 Agent 登记数代替。首页的场景与连接结构是产品概念示意，并非实时拓扑或业务数据。冰晶场景使用本地精简版 Three.js；不支持 WebGL、加载失败或图形上下文丢失时显示 SVG 静态图，页面功能不受影响。动效遵循系统的减少动态效果设置，离开页面释放渲染资源。

## 自测

```sh
npm ci
node --test packages/plugin-console/public/js/theme.test.mjs
node --test packages/plugin-console/public/js/theme-integration.test.mjs
node --test packages/plugin-console/public/js/pages/home.test.mjs
node --experimental-strip-types --test packages/plugin-exec-hub/src/timer-permission.test.mjs
node --experimental-strip-types --test packages/plugin-panel-core/src/metering-org.test.mjs
node scripts/selftest.mjs
```

前端自动化使用 jsdom、真实 D3 与 Cytoscape 内核；集成测试启动独立的只读演示实例并访问真实 API。jsdom 没有浏览器画布，图谱测试使用 Cytoscape headless 模式，不能代替真实浏览器的画布渲染和视觉检查。
