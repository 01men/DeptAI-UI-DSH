/**
 * 受控 artifact 服务（实施路径 §4.5/§D.12：员工文件出入一律走受控 staging，
 * 不开放平台本地路径——远端运行时的本机路径既不等于平台路径，也不能因此
 * 获得读取平台任意文件的能力）。
 *
 * 内容经请求体 base64 进入服务端受控目录；文件名清洗禁路径分隔符与 `..`；
 * 员工仅可写自己 run 的 artifact；读取归属＝本人或同组织 workforce.read。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { newId } from '../../platform-core/src/ids.ts'
import type {
  ArtifactRecord,
  PermitRecord,
  WorkforceArtifacts,
  WorkforceIdentityResolver,
  WorkforcePermits,
  WorkforceStore,
} from './contract.ts'
import { WorkforceError, ARTIFACT_MAX_BYTES } from './contract.ts'
import { t } from '../../platform-i18n/src/index.ts'
import type { WorkCallerRef } from '../../platform-core/src/workforce-port.ts'

export class ArtifactService extends Service implements WorkforceArtifacts {
  static readonly provide = 'workforceArtifacts'

  /** 受控 staging 目录：与 SQLite 同底座（config.dataDir ?? <cwd>/data）。 */
  private readonly stagingDir: string

  constructor(ctx: Context, config: { dataDir?: string } = {}) {
    super(ctx, 'workforceArtifacts')
    this.stagingDir = join(config.dataDir ?? join(process.cwd(), 'data'), 'workforce-artifacts')
    mkdirSync(this.stagingDir, { recursive: true })
  }

  // -- 依赖 -------------------------------------------------------------

  private get store(): WorkforceStore {
    const store = (this.ctx as unknown as { workforceStore?: WorkforceStore }).workforceStore
    if (!store || typeof store.txn !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceStore 未就绪（迁移未完成）'), 503)
    }
    return store
  }

  private get identity(): WorkforceIdentityResolver {
    const resolver = (this.ctx as unknown as { workforceIdentity?: WorkforceIdentityResolver }).workforceIdentity
    if (!resolver || typeof resolver.resolveByCaller !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforceIdentity 未就绪'), 503)
    }
    return resolver
  }

  private get permits(): WorkforcePermits {
    const permits = (this.ctx as unknown as { workforcePermits?: WorkforcePermits }).workforcePermits
    if (!permits || typeof permits.activeForRun !== 'function') {
      throw new WorkforceError('WORKFORCE_NOT_READY', t('workforcePermits 未就绪'), 503)
    }
    return permits
  }

  // -- 受控上传 -----------------------------------------------------------

  async createUpload(caller: WorkCallerRef, input: { name: string; contentType: string; contentBase64: string; runId?: string }): Promise<ArtifactRecord> {
    // 身份：仅受管数字员工可写（D12）
    const resolution = await this.identity.resolveByCaller(caller)
    if (!resolution) throw new WorkforceError('EMPLOYEE_NOT_ACTIVE', t('非受管数字员工，不能写入 artifact'))
    // 大小：硬上限（默认 8MB）
    const buffer = Buffer.from(input.contentBase64, 'base64')
    if (buffer.length > ARTIFACT_MAX_BYTES) {
      throw new WorkforceError('ARTIFACT_SCOPE_DENIED', t('超出 artifact 大小上限（{max} 字节）', { max: ARTIFACT_MAX_BYTES }))
    }
    // run 归属：携带 runId 时必须存在本员工签发且有效的 permit 绑定（V06：跨 run 拒绝）
    if (input.runId) {
      const permit = this.permits.activeForRun(input.runId)
      if (!permit || permit.employeeId !== resolution.employee.id) {
        throw new WorkforceError('ARTIFACT_SCOPE_DENIED', t('该 run 不归属当前员工，拒绝写入 artifact'))
      }
    }
    // 文件名清洗：禁路径分隔符与 ..（V15：不向员工开放任意 localFile）
    const safeName = this.sanitizeName(input.name)
    const id = newId('art')
    const storagePath = join(this.stagingDir, `${id}__${safeName}`)
    writeFileSync(storagePath, buffer)
    // TableStore.insert 为 void（落库副作用）——记录以本地变量返回，不得返回 insert() 结果
    const record: ArtifactRecord = {
      id,
      employeeId: resolution.employee.id,
      runId: input.runId ?? '',
      orgId: resolution.employee.orgId,
      name: safeName,
      contentType: input.contentType || 'application/octet-stream',
      sizeBytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      storagePath,
      source: 'upload',
      createdAt: new Date().toISOString(),
    }
    this.store.artifacts.insert(record)
    return record
  }

  /** 文件名清洗：去除路径分隔符、空字节与 .. 序列；空名兜底 artifact。 */
  private sanitizeName(name: string): string {
    const cleaned = String(name ?? '')
      .replace(/[\\/\x00]/g, '_')
      .replace(/\.{2,}/g, '_')
      .replace(/[\r\n\t]/g, '_')
      .trim()
    return cleaned || 'artifact'
  }

  // -- 读取 ---------------------------------------------------------------

  async get(caller: WorkCallerRef, artifactId: string): Promise<ArtifactRecord> {
    const record = this.store.artifacts.get(artifactId)
    if (!record) throw new WorkforceError('ARTIFACT_SCOPE_DENIED', t('artifact 不存在或无权访问'), 404)
    await this.assertReadable(caller, record)
    return record
  }

  async readBase64(caller: WorkCallerRef, artifactId: string): Promise<string> {
    const record = await this.get(caller, artifactId)
    return readFileSync(record.storagePath).toString('base64')
  }

  /** 归属判定：员工本人，或 human（入口已把守权限点）且与 artifact 组织同组织。 */
  private async assertReadable(caller: WorkCallerRef, record: ArtifactRecord): Promise<void> {
    const resolution = await this.identity.resolveByCaller(caller)
    if (resolution && resolution.employee.id === record.employeeId) return
    if (caller.kind === 'human' && caller.userId) {
      const orgId = this.humanOrgId(caller)
      if (orgId !== null && orgId === record.orgId) return
    }
    throw new WorkforceError('ARTIFACT_SCOPE_DENIED', t('无权访问该 artifact（仅本人或同组织主体）'))
  }

  /** human 组织反查（结构化探测 iam；解析失败 fail-closed）。 */
  private humanOrgId(caller: WorkCallerRef): string | null {
    try {
      const iam = (this.ctx as unknown as { iam?: { users?: () => { get(id: string): { orgId?: string } | undefined } } }).iam
      const user = typeof iam?.users === 'function' ? iam.users().get(caller.userId ?? '') : undefined
      return typeof user?.orgId === 'string' ? user.orgId : null
    } catch {
      return null
    }
  }

  /** 内部通道（NAS 写入适配器消费）：run 归属已由 permit 校验，按存储路径直读。 */
  readByPermit(permit: PermitRecord, artifactId: string): ArtifactRecord {
    const record = this.store.artifacts.get(artifactId)
    if (!record
      || record.employeeId !== permit.employeeId
      || (record.runId !== '' && record.runId !== permit.runId)) {
      throw new WorkforceError('ARTIFACT_SCOPE_DENIED', t('artifact 不存在或不属于该员工/该 run'))
    }
    return record
  }
}
