# 元冰可 AIOS —— 平台镜像（W1 市场引爆批次，2026-10-17）。
#
# 零构建基线照进容器：仓库原生 TS 直接运行，node:sqlite 是 Node 内置模块——镜像里不需要装任何数据库，
# npm ci 之外零额外依赖。CMD 内联 --experimental-strip-types：node:22-alpine 浮动标签当前已默认开启
# 类型剥离（22.18+），但被钉到 22.6–22.17 时仍可启动（issue #4）；新版本上该 flag 是静默 no-op。
# 运行时只读四样东西：src/、packages/（含控制台 SPA 与词典）、docs/（/docs 白名单伺服）、
# 根 package.json（版本信息）；其余目录（archive/tests/cli/integrations/数据目录等）
# 由 .dockerignore 排除，不进镜像。
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 清单与源码一并拷贝（npm workspaces 全树安装，锁文件锁定版本）；
# devDependencies 必须安装——@deepseek-ai/cordis（插件树内核）与 openid-client（OIDC）
# 声明在 devDependencies 但是运行时硬依赖，--omit=dev 会让实例起不来。
#
# ⚠️ 必须显式 --include=dev：上一行 `ENV NODE_ENV=production` 会让 npm 的默认 omit 规则
# 变成 omit=dev（实测 npm 10.9.7：`NODE_ENV=production` + `npm ci` 只装 dependencies，
# devDependencies 全部缺失 → 容器启动即崩，构建日志不报错，最难查）。
# 以后新增任何运行时硬依赖到 devDependencies 的包，都靠这个 flag 兜住。
COPY package.json package-lock.json cordis.yml cordis.patch.yml ./
COPY src ./src
COPY packages ./packages
COPY docs ./docs
RUN npm ci --no-audit --no-fund --include=dev

# 平台全部持久化状态（业务集合 + SQLite 计量/事务库 + OIDC 私钥）都在数据目录：
# 挂 volume 持久化，容器层不存状态，升级镜像 = 换容器不换数据。
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 非 root 运行（安全审查 P2-5，2026-10-31）：容器内代码被入侵执行时不再拥有 root，
# 缩小对容器层与挂载卷的破坏半径。node 基础镜像自带 uid=1000 的 node 用户；
# /app 需属主可写（数据目录 + npm 运行时缓存），挂载卷属主由部署侧保证可写。
RUN chown -R node:node /app
USER node

# 生产部署挂 ADMIN_PASSWORD + 自建 volume，且**不要**带 DEMO_* 变量（见 README「生产部署」）；
# DEMO_MODE=1 会把实例的全部只读视图开放给免登访客，仅限演示种子数据实例。
EXPOSE 7300
CMD ["node", "--experimental-strip-types", "src/main.ts", "--port", "7300", "--data", "/app/data"]
