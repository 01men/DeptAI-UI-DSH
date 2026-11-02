/**
 * open-connector 侧错误模型：统一信封 { success:false, errorCode } → 平台错误的唯一映射处。
 * client.ts 是全仓唯一感知 open-connector v1.4.0 契约的适配层（版本锁定隔离），其余代码只见本文件语义。
 */

/** 错误码 → HTTP 状态与平台提示文案（v1.4.0 文档载明的错误码子集 + 上游文档未载项按默认处理）。 */
import { t } from '../../platform-i18n/src/index.ts'

const OC_ERROR_STATUS: Record<string, number> = {
  connection_not_allowed: 403,
  rate_limited: 429,
  oauth_token_expired: 409,
  oauth_client_config_required: 400,
  unknown_action: 404,
  unauthorized: 401,
}

export class OcError extends Error {
  readonly code: string
  /** 建议 HTTP 状态码（console 路由层透传给调用方）。 */
  readonly status: number
  /** 面向连接向导的修复指引（如 OAuth 自备 App 注册链接说明）。 */
  readonly guidance?: string

  constructor(code: string, message?: string, guidance?: string, status?: number) {
    super(message ?? t('open-connector 错误：{code}', { code }))
    this.name = 'OcError'
    this.code = code
    this.status = status ?? OC_ERROR_STATUS[code] ?? 502
    this.guidance = guidance
  }
}

/** sidecar 不可达 / 响应非契约形态——fail-closed 判定的输入。 */
export class OcUnavailableError extends OcError {
  constructor(message: string) {
    super('gateway_unreachable', message)
    this.name = 'OcUnavailableError'
  }
}
