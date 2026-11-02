/**
 * OpenAPI 接口面投影（issue #6）：把 httpServer 的全量路由台账（declaredRoutes，交接清单 H5）
 * 生成为 OpenAPI 3.0.3 文档，让 Agent / 第三方客户端能机器可读地发现 REST 接口面与鉴权要求。
 *
 * 台账是唯一事实源——每个 register() 都落一条，文档随路由注册自动同步，不另维护第二份接口清单
 * （口径与 /api/platform/route-matrix 一致）。路由声明只有 method / path / 鉴权 profile，没有逐端点的
 * 参数与响应 schema，因此文档刻画的是「接口面 + 鉴权要求 + 统一信封」，逐字段契约仍以各插件
 * manifest（api.yaml）为准；两者由 lint:manifests 对账，不在此重复建模。
 */
import type { RouteLedgerEntry } from './http.ts'
import { t } from '../../platform-i18n/src/index.ts'

export interface OpenApiBuildOptions {
  /** 平台版本（info.version，取 platformVersionInfo().version）。 */
  version: string
  /** 对外挂载前缀（'' 或 '/rq'，见 HttpServerConfig.externalBase），映射为 servers[0].url。 */
  externalBase?: string
}

/** `/api/iam/users/:id` → `/api/iam/users/{id}`，并返回路径参数名列表。 */
export function toOpenApiPath(pattern: string): { path: string; params: string[] } {
  const params: string[] = []
  const path = pattern.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment
    const name = segment.slice(1)
    params.push(name)
    return `{${name}}`
  }).join('/')
  return { path: path || '/', params }
}

/** 分组标签：/api/<域>/… 取域名；/api 之外的协议面（/mcp、/oauth、/docs…）取首段。 */
function tagOf(pattern: string): string {
  const segments = pattern.split('/').filter(Boolean)
  if (segments[0] === 'api') return segments[1] ?? 'api'
  return segments[0] ?? 'root'
}

/** operationId：method + 路径的标识符化（`{id}` 等参数段保留参数名）。 */
function operationIdOf(method: string, openApiPath: string): string {
  const slug = openApiPath.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `${method.toLowerCase()}_${slug || 'root'}`
}

export function buildOpenApiDocument(routes: readonly RouteLedgerEntry[], options: OpenApiBuildOptions): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  const tags = new Set<string>()
  // 稳定输出：按路径、方法排序；同 method+path 多次登记（幂等重复注册）只保留首条
  const sorted = [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  for (const route of sorted) {
    const { path, params } = toOpenApiPath(route.path)
    const method = route.method.toLowerCase()
    const item = (paths[path] ??= {})
    if (item[method] !== undefined) continue
    const tag = tagOf(route.path)
    tags.add(tag)
    const auth = route.auth
    const envelope = auth.access !== 'outside-api'
    const operation: Record<string, unknown> = {
      operationId: operationIdOf(method, path),
      tags: [tag],
      ...(params.length > 0
        ? { parameters: params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })) }
        : {}),
      responses: envelope
        ? {
          '200': {
            description: t('成功：统一信封 { ok: true, data }'),
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OkEnvelope' } } },
          },
          default: {
            description: t('失败：统一信封 { ok: false, error: { code, message } }（401 未认证 / 403 缺权限点 / 404 不存在 / 422 校验失败）'),
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
          },
        }
        : { default: { description: t('协议面响应（OAuth / MCP JSON-RPC / 文档页等，不走统一信封）') } },
      // 精确鉴权声明（与 route-matrix 同口径）：guarded=权限点保护；authenticated=仅 Bearer；
      // public=免鉴权（selfValidated=处理器自带凭证校验）；outside-api=协议面自管鉴权
      'x-auth': { ...auth },
    }
    if (auth.access === 'guarded') {
      operation.security = [{ bearerAuth: [] }]
      operation['x-permission'] = auth.permission
    } else if (auth.access === 'authenticated') {
      operation.security = [{ bearerAuth: [] }]
    } else if (auth.access === 'public') {
      operation.security = []
    }
    item[method] = operation
  }
  const externalBase = (options.externalBase ?? '').replace(/\/+$/, '')
  return {
    openapi: '3.0.3',
    info: {
      title: t('元冰可 · 企业 AI 资源统一管理平台 API'),
      version: options.version,
      description: t('由运行时路由台账自动生成：覆盖全部已注册端点及其鉴权要求（x-auth / x-permission）。/api/* 响应为统一 JSON 信封；逐字段契约见各插件 manifest（api.yaml）。'),
    },
    servers: [{ url: externalBase || '/' }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: t('平台令牌（人类账号 POST /api/auth/login 换取，或机器凭证签发）；/mcp 与 REST 共用同一套令牌'),
        },
      },
      schemas: {
        OkEnvelope: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { type: 'boolean', enum: [true] }, data: {} },
        },
        ErrorEnvelope: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: { code: { type: 'string' }, message: { type: 'string' } },
              additionalProperties: true,
            },
          },
        },
      },
    },
  }
}
