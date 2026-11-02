/**
 * Agent Card 生成 / JWS(Ed25519) 签名与验签（协作方案 §5.2）。
 *
 * 声明以授权为权威：卡片内容由 f(授权集 + 资产 attrs) 投影生成，禁止手改——
 * 调用方（或边缘网关）注册/发现卡片时先验签后采信，验签失败不进入目录并触发审计告警。
 * 签名复用 plugin-market 抽升的平台级 Ed25519 基建（platform-core/src/signature.ts），
 * 不新建密码学组件。签名格式：JWS compact（alg=EdDSA），签名输入 = `${protected}.${payload}`，
 * 复用 signEd25519 对「字符串字节」的原始签名语义。
 */
import { signEd25519, verifyEd25519 } from '../../platform-core/src/signature.ts'

// ---------------------------------------------------------------------------
// 卡片结构（协议键保持 ASCII，中文释义见《协议键中文对照总表》）
// ---------------------------------------------------------------------------

export interface AgentCardSkill {
  id: string
  name: string
  description?: string
  tags: string[]
}

export interface AgentCardGovernanceExtension {
  uri: 'urn:ybk:ext:governance:v1'
  params: {
    autonomy: string
    runtime: string
    dataClassCeiling: string
    /** 本员工（被调侧）计量主体。 */
    meteringSubject: string
    /** 协作调用的计量主体（发起侧）；外部对账方据此拉全两侧账（Q-32/E-7）。 */
    callerMeteringSubject?: string
  }
}

/** 协议面扩展（Q-31）：协议版本、方法面、流式传输与发现端点——外部 Agent 只靠卡片即可协作。 */
export interface AgentCardProtocolExtension {
  uri: 'urn:ybk:ext:protocol:v1'
  params: {
    protocol: string
    protocolVersion: string
    transport: string
    methods: string
    streamingTransport: string
    sseAuth: string
    wellKnown: string
    directory: string
    uhpDiscovery: string
    uhpVersion: string
    envelope: string
  }
}

/** 未签名卡片体（payload）。 */
export interface AgentCardBody {
  name: string
  description: string
  url: string
  version: string
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: AgentCardSkill[]
  /** 调用所需权限点（securitySchemes.*.scopes）。 */
  securitySchemes: Record<string, Record<string, unknown>>
  /** 任务事件流地址（模板含 {taskId}）。 */
  eventsUrl?: string
  extensions: Array<AgentCardGovernanceExtension | AgentCardProtocolExtension>
}

export interface CardSignature {
  protected: string
  signature: string
  keyId: string
}

export type SignedAgentCard = AgentCardBody & { signatures: CardSignature[] }

// ---------------------------------------------------------------------------
// base64url 工具（JWS compact 编码；Node Buffer 无填充 base64url）
// ---------------------------------------------------------------------------

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

// ---------------------------------------------------------------------------
// 签名 / 验签
// ---------------------------------------------------------------------------

/** 对卡片体做 JWS(EdDSA/Ed25519) 签名，返回带 signatures 的完整卡片。 */
export function signAgentCard(body: AgentCardBody, privateKeyPem: string, keyId: string): SignedAgentCard {
  const protectedHeader = b64urlJson({ alg: 'EdDSA', typ: 'JWT', kid: keyId })
  const payload = b64urlJson(body)
  const signingInput = `${protectedHeader}.${payload}`
  const signature = signEd25519(privateKeyPem, signingInput)
  return { ...body, signatures: [{ protected: protectedHeader, signature, keyId }] }
}

/** 验签：先验签后采信（协作方案 §5.2）。任一形态非法返回 false（不抛错，调用方按验签失败处理）。 */
export function verifyAgentCard(card: SignedAgentCard, publicKeyBase64: string): boolean {
  try {
    const sig = card.signatures?.[0]
    if (!sig?.protected || !sig.signature) return false
    const header = JSON.parse(Buffer.from(sig.protected, 'base64url').toString('utf8')) as { alg?: string }
    if (header.alg !== 'EdDSA') return false
    const { signatures: _signatures, ...body } = card
    const signingInput = `${sig.protected}.${b64urlJson(body)}`
    return verifyEd25519(publicKeyBase64, signingInput, sig.signature)
  } catch {
    return false
  }
}
