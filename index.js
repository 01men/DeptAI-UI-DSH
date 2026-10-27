/**
 * @ybkk/gate-01 根出口 = rq-card 宿主半（会话侧注入插件的 Host half）。
 *
 * 【为什么根包出口是 rq-card（issue #1 修复，2026-10-27）】
 * cordis.patch.yml 的 rq-card 条目曾以裸包名 `@ybkk/plugin-rq-card` 引用，依赖根包
 * `file:` 依赖在安装目标顶层落位才能解析——本地 file:/dir 安装会被包管理器物化到顶层
 * 所以可用，但 git / registry 安装形态下该依赖只以 bundled 嵌套拷贝存在
 * （node_modules/@ybkk/gate-01/node_modules/...），从 profile 根永远不可达 →
 * 「1 entry did not activate / ERR_MODULE_NOT_FOUND」。
 *
 * 现在 rq-card 条目直接引用根包名 `@ybkk/gate-01`（client-modules 对裸包名走
 * require.resolve('<名>/package.json') 读根包 dsh.client 元数据、exports["./client"]
 * 取浏览器 bundle）——根包本身在一切安装形态下都必然顶层在位，三种形态同通道解析。
 * 浏览器半 bundle（lib/client.js）的装载 id 也随之统一为 `@ybkk/gate-01`。
 */
export * from './packages/plugin-rq-card/dist/index.js'
