/**
 * authn 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'
import { t as translate } from '../../platform-i18n/src/index.ts'

export const name = 'authn-tools'
export const inject = ['tools', 'authn']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'authn_token_issue',
    description: '为主体签发短期访问令牌（默认 2 小时）。人 / 机器身份均可。',
    permission: 'authn.token.issue',
    parameters: {
      principalId: { type: 'string', required: true, description: '主体 ID（pri_ 前缀）' },
      ttlHours: { type: 'number', description: '有效期（小时），默认 2' },
      reason: { type: 'string', description: '签发原因（审计）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const { token, record } = ctx.authn.issueToken(args.principalId, {
        kind: 'access',
        ttlHours: args.ttlHours,
        scopes: ctx.authn.principals().get(args.principalId)?.scopes ?? [],
        issuedBy: `agent:${args.reason ?? 'tool'}`,
      })
      return { token, jti: record.jti, expiresAt: record.expiresAt }
    },
  }))

  t.register(defineTool({
    name: 'authn_token_revoke',
    description: '吊销令牌（L4 高危，需 reason）。支持按 jti 吊销单个令牌。',
    permission: 'authn.token.revoke',
    parameters: {
      jti: { type: 'string', required: true, description: '令牌 jti' },
      reason: { type: 'string', required: true, description: '吊销原因' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const record = ctx.authn.revokeToken(args.jti, args.reason)
      return { jti: record.jti, revokedAt: record.revokedAt }
    },
  }))

  t.register(defineTool({
    name: 'authn_token_list',
    description: '查询主体令牌列表（含吊销状态）。',
    permission: 'authn.principal.read',
    parameters: {
      principalId: { type: 'string', description: '按主体过滤' },
      activeOnly: { type: 'boolean', description: '仅未吊销' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const tokens = ctx.authn.tokens().find((token) => {
        if (args.principalId && token.principalId !== args.principalId) return false
        if (args.activeOnly && token.revokedAt) return false
        return true
      })
      return {
        total: tokens.length,
        tokens: tokens.map((token) => ({
          jti: token.jti, kind: token.kind, issuedAt: token.issuedAt,
          expiresAt: token.expiresAt, revokedAt: token.revokedAt ?? null, issuedBy: token.issuedBy,
          ...(token.label !== undefined ? { label: token.label } : {}),
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'authn_credential_create',
    description: '为 Agent/应用/外部系统创建机器身份凭证（Client Credentials，密钥仅返回一次）。',
    permission: 'authn.principal.write',
    parameters: {
      name: { type: 'string', required: true, description: '主体名称' },
      refType: { type: 'string', enum: ['agent', 'app', 'external'], description: '绑定资源类型' },
      refId: { type: 'string', description: '绑定资源 ID' },
      scopes: { type: 'array', items: { type: 'string' }, description: '权限点列表（须为权限目录中的点，或仅 ["*"]）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const created = ctx.authn.createMachineCredential({
        name: args.name,
        refType: args.refType,
        refId: args.refId,
        scopes: args.scopes ?? ['skill.read'],
      })
      return {
        principalId: created.principal.id,
        clientId: created.clientId,
        clientSecret: created.clientSecret,
        note: translate('clientSecret 仅此一次返回，请妥善保管'),
      }
    },
  }))

  t.register(defineTool({
    name: 'authn_credential_scopes',
    description: '调整机器身份权限范围（收权/扩权）。调整后存量令牌全部联动吊销，机器侧需重新换牌。',
    permission: 'authn.principal.write',
    parameters: {
      principalId: { type: 'string', required: true, description: '主体 ID（pri_ 前缀）' },
      scopes: { type: 'array', items: { type: 'string' }, required: true, description: '新权限点列表（须全部命中权限目录，或恰为 ["*"]）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const principal = ctx.authn.updateMachineScopes(args.principalId, { scopes: args.scopes })
      const { clientSecretHash, ...safe } = principal
      void clientSecretHash
      return { ...safe, note: translate('存量令牌已全部吊销，机器侧需用凭证重新换牌') }
    },
  }))

  t.register(defineTool({
    name: 'authn_credential_rotate',
    description: '轮换机器凭证密钥（clientSecret）。clientId 不变，旧值立即失效，存量令牌全部吊销；新 secret 仅此一次返回。凭证丢失/泄露的补救手段，无需重新注册 Agent。',
    permission: 'authn.principal.write',
    parameters: {
      principalId: { type: 'string', required: true, description: '主体 ID（pri_ 前缀）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const rotated = ctx.authn.rotateMachineCredential(args.principalId)
      return {
        clientId: rotated.principal.clientId,
        clientSecret: rotated.clientSecret,
        note: translate('新 clientSecret 仅此一次返回，旧值立即失效，存量令牌已全部吊销'),
      }
    },
  }))
}
