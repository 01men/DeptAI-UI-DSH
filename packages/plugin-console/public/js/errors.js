/**
 * 错误文案共享模块（WP-06/C3）：原因码 → 文案 + 行动按钮，全控制台集中一处。
 *
 * 纪律（DoD「错误文案映射完整性」）：任何新增对外原因码必须同步本表。
 * selftest 实时枚举后端原因码（exchange.fail(NNN,'XXX') 大写码 + 内联 error:{code:'XXX'} 载荷）
 * 并断言 全集 ⊆ ERROR_CODES ∪ BINDING_REASONS，漏配即红。模块保持零依赖（selftest 直接 import 校验）。
 * ERROR_CODES 由 COPY 键集派生，注册表与文案同源、永不脱节。
 *
 * 原因码全集（REFACTOR-2026-10-13 阶段 2 完备化，共 48 + 3 条；2026-11-02 +5 面板轨远端连接/代理码）：
 *   业务原因码（七条，rq-card 会话卡同键——语义冻结勿动）：
 *   nas-authz-deny    NAS 数据权限五步判定 deny（fail-closed）
 *   breaker-open      MCP 服务熔断器开启（连续失败≥3 次置位）
 *   quota-exhausted   调用额度耗尽（quota.exceeded；billing 下线后保留 wire 兼容文案）
 *   pdp-unreachable   权限判定点不可达（保护性拒绝，P0-2 红线）
 *   degraded          服务健康 degraded（延迟>800ms，30s 轮询探活）
 *   binding-invalid   平台身份绑定失效（含 no_cookie / expired / account_inactive 细分）
 *   invoke-error      工具执行报错且无平台侧原因码时的兜底（rq-card 会话卡语义，WP-06 报备决议）
 *   后端 HTTP 大写码（31 条 fail 码 + 5 条内联载荷码）：见 COPY 内分组注释。
 *   绑定失效细分小写码（3 条）：BINDING_REASONS（dsh-bridge /dsh-bridge/status 返回）。
 */

const COPY = {
  // ── 业务原因码（rq-card 会话卡同键，语义冻结）──────────────────────────
  'nas-authz-deny': {
    tone: 'danger',
    title: '暂无该数据的访问权限',
    message: '本次访问被数据权限策略拦截（保护性拒绝）。如因工作需要，可发起访问申请，审批通过后即可使用。',
    action: { label: '申请访问', href: '#/nas-authz' },
  },
  'breaker-open': {
    tone: 'warn',
    title: '服务熔断中，正在自动恢复',
    message: '该服务连续调用失败已触发熔断保护，暂拒绝调用；探活恢复后自动闭合，无需人工处理。',
    action: { label: '查看服务健康', href: '#/mcp' },
  },
  'quota-exhausted': {
    tone: 'danger',
    title: '额度已耗尽',
    message: '本主体调用额度已用完，调用被暂停。可查看用量明细，或联系管理员调整限额。',
    action: { label: '查看用量', href: '#/assets' },
  },
  'pdp-unreachable': {
    tone: 'warn',
    title: '权限检查服务暂不可用',
    message: '为守住安全红线，权限判定不可达时一律保护性拒绝。服务恢复后请重试；紧急情况请联系平台管理员。',
    action: null,
  },
  degraded: {
    tone: 'info',
    title: '服务响应有点慢',
    message: '该服务当前处于降级运行（延迟偏高），调用仍在继续。如长时间未恢复，系统会转后台并经钉钉通知你。',
    action: null,
  },
  'binding-invalid': {
    tone: 'danger',
    title: '身份绑定已失效',
    message: '当前浏览器与平台账号的绑定已失效（可能是过期、退出或账号状态变化）。重新绑定后即可继续使用宿主对话与归因能力。',
    action: { label: '一键重绑', href: '/auth/oidc/start', external: true },
  },
  'invoke-error': {
    tone: 'danger',
    title: '本次调用执行出错',
    message: '工具执行返回错误（非权限/额度原因）。可重试一次；持续失败请到服务详情查看健康与调用记录。',
    action: { label: '查看调用记录', href: '#/mcp' },
  },

  // ── 认证与会话（fail 401 族）──────────────────────────────────────────
  UNAUTHORIZED: {
    tone: 'danger',
    title: '登录状态缺失',
    message: '本次请求未携带有效登录凭证（缺少 Bearer 令牌）。请重新登录后再试。',
    action: { label: '去登录', href: '#/login' },
  },
  TOKEN_INVALID: {
    tone: 'danger',
    title: '登录凭证已失效',
    message: '当前会话令牌无效或已被吊销（可能因改密、登出或管理员吊销联动）。请重新登录。',
    action: { label: '重新登录', href: '#/login' },
  },
  LOGIN_FAILED: {
    tone: 'danger',
    title: '登录失败',
    message: '账号或密码不正确，或账号状态不可用。请核对后重试；多次失败请联系管理员确认账号状态。',
    action: null,
  },
  REFRESH_FAILED: {
    tone: 'danger',
    title: '会话续期失败',
    message: '登录会话续期被拒绝（刷新令牌失效或已过期）。请重新登录以继续使用。',
    action: { label: '重新登录', href: '#/login' },
  },

  // ── 通用 HTTP（fail 400/403/404/500 族）───────────────────────────────
  BAD_REQUEST: {
    tone: 'warn',
    title: '请求参数不完整或有误',
    message: '平台拒绝了本次请求（参数校验未通过）。请检查填写内容后重试；若确认无误仍失败，请联系平台管理员。',
    action: null,
  },
  FORBIDDEN: {
    tone: 'danger',
    title: '没有该操作的权限',
    message: '当前账号缺少执行此操作所需的权限点。如需办理，请联系管理员调整角色授权。',
    action: null,
  },
  // 面板域扩展收编（DeptAI-UI-DSH，2026-10-29）：制造工具箱 AI 工具的诚实降级码——
  // 面板零密钥铁律，模型面在宿主平台侧；未配置时 503 + 本码，不冒充成功。
  MODEL_NOT_CONFIGURED: {
    tone: 'warn',
    title: '模型尚未配置',
    message: '该 AI 工具需要平台侧配置可用模型才能执行（面板不持有任何模型密钥）。请在模型网关登记模型渠道后重试。',
    action: null,
  },
  INTERNAL_ERROR: {
    tone: 'danger',
    title: '服务内部错误',
    message: '处理本次请求时发生未预期的错误。请稍后重试；若持续出现，请联系平台管理员并附上发生时间。',
    action: null,
  },
  // W1 MCP 治理（2026-10-22）：服务创建/更新携带明文敏感头被门禁拒绝——
  // 引导改走「服务凭证」入口（PUT /api/mcp/services/:id/credential），经 Secret Broker 保管、永不明文落库。
  SENSITIVE_HEADERS_FORBIDDEN: {
    tone: 'warn',
    title: '不允许明文写入下游凭证',
    message: '服务请求头中包含敏感键（Authorization / Token / Secret / Key）。请改用服务凭证入口下发，密钥将由平台凭证代理保管，不再明文落库。',
    action: null,
  },
  // W2 应用能力绑定（2026-10-22）：MCP 服务归属已被其他主体认领，重复绑定被拒——
  // 归属唯一是成本穿透与责任追溯的前提；先解绑原归属或由平台管理员调整 ownerEntity。
  OWNER_CONFLICT: {
    tone: 'warn',
    title: '该能力已归属其他应用',
    message: '目标 MCP 服务已被其他应用认领（归属唯一）。请先由原应用解绑，或联系平台管理员调整服务归属后再绑定。',
    action: null,
  },
  // A2A/UHP 协作面（2026-10-20 QA 整改批次）：外部调用试图注入 ybk_a2a_task_id 绑定他人
  // A2A 任务——平台拒绝（仅允许内部派发通道绑定）。正常前端操作不会触达，仅直调协议面时出现。
  // 应用外部凭证托管（issue #19，2026-10-31）：取值键未登记（未登记过或已删除/清库）
  CREDENTIAL_NOT_FOUND: {
    tone: 'warn',
    title: '凭证不存在',
    message: '该应用未登记此凭证，或它已被删除/随应用清除。请先在「AI 应用 → 应用详情 → 外部凭证」登记（登记即 AES-256-GCM 加密落库）。',
    action: { label: '前往应用详情', href: '#/apps' },
  },
  TASK_BINDING_FORBIDDEN: {
    tone: 'danger',
    title: '禁止绑定协作任务',
    message: '外部调用不得绑定 A2A 任务：该字段仅允许平台内部派发通道注入。如需发起协作，请走 A2A 协作端点。',
    action: null,
  },
  // 演示只读闸门（2026-10-17 演示模式批次）：DEMO_MODE=1 实例的写方法入口 405。
  // 正常浏览时写按钮已按权限隐藏，本码仅在直调 API 等旁路触达——文案与
  // platform-i18n 服务端词条同句（en/ja 词典复用同一键，不双源）。
  DEMO_READONLY: {
    tone: 'warn',
    title: '演示模式 · 只读',
    message: '演示模式为只读，不支持写操作。请自行部署后体验完整功能。',
    action: null,
  },
  // 演示一键入场失败（2026-11-01 演示免密批次）：demo-entry 签票端点服务端异常
  //（演示账号缺失/认证面未就绪等）。gate01.html 中转页自行消化主路径，此映射兜底直调场景。
  DEMO_ENTRY_FAILED: {
    tone: 'warn',
    title: '演示免密通道暂不可用',
    message: '演示身份签票未成功（服务未就绪或非演示实例）。可直接打开 01门面板手动登录，或稍后重试。',
    action: { label: '打开 01门面板', href: '/gate01/panel/' },
  },
  // 本人自助解绑三方身份被拒（2026-10-22 解绑能力上线）：最常见原因是「这是该账号唯一的
  // 登录方式」（SSO 自注册/通讯录同步号的口令从未下发）。服务端原文写明具体原因，此处给
  // 通用兜底 + 下一步动作。
  UNBIND_FAILED: {
    tone: 'danger',
    title: '未能解绑该三方身份',
    message: '解绑未完成。若这是你账号唯一的登录方式，请先联系管理员重置口令（设好口令后再解绑，避免无法登录）。',
    action: null,
  },
  NOT_FOUND: {
    tone: 'warn',
    title: '找不到目标资源或页面',
    message: '请求的资源不存在或已被移除。请确认链接/编号无误；若从列表进入，可能已被他人删除，刷新后重试。',
    action: { label: '回到工作台', href: '#/dashboard' },
  },
  CONFLICT: {
    tone: 'warn',
    title: '资源已被占用或状态冲突',
    message: '目标已被他人占用/命名重复（如 webhook 路径已被占用）。请换一个标识后重试。',
    action: null,
  },
  INTERNAL: {
    tone: 'danger',
    title: '服务器内部错误',
    message: '平台处理本次请求时出现未预期错误。请稍后重试；持续出现请联系平台管理员并提供操作时间点。',
    action: null,
  },

  // ── SSO 族（授权/登录/注册/绑定）──────────────────────────────────────
  SSO_AUTHORIZE_FAILED: {
    tone: 'danger',
    title: '单点登录发起失败',
    message: '无法发起三方登录授权（连接器配置或参数有误）。请联系管理员检查「组织与账号 → 三方集成」配置。',
    action: null,
  },
  SSO_FAILED: {
    tone: 'danger',
    title: '单点登录失败',
    message: '三方身份提供方登录未通过（授权码无效、已过期或账号映射失败）。请重试；持续失败请联系管理员核查 SSO 配置。',
    action: null,
  },
  SSO_REGISTER_FAILED: {
    tone: 'danger',
    title: '单点登录开户失败',
    message: '首次三方登录自动开通账号未成功（可能缺少组织映射或账号被停用）。请联系管理员处理。',
    action: null,
  },
  SSO_BIND_AUTHORIZE_FAILED: {
    tone: 'danger',
    title: '绑定授权发起失败',
    message: '无法生成三方绑定授权地址（连接器登录配置缺失或有误）。请联系管理员检查三方集成配置。',
    action: null,
  },
  SSO_BIND_FAILED: {
    tone: 'danger',
    title: '三方身份绑定失败',
    message: '扫码/授权绑定未成功（授权已过期或账号状态变化）。请回到原页面重新发起绑定。',
    action: null,
  },
  UNBIND_FAILED: {
    tone: 'danger',
    title: '解除三方绑定失败',
    message: '解绑未完成：验证码不正确、该账号未绑定此三方身份，或它已是该账号唯一的登录方式（需先设置口令）。具体原因见服务端提示。',
    action: null,
  },

  // ── 票据与绑定（内联载荷码 + fail 码）─────────────────────────────────
  // 安全审查批次（2026-10-31）新增原因码
  ENV_CREDENTIAL_NOT_ALLOWED: {
    tone: 'warn',
    title: '凭证引用未登记白名单',
    message: 'env: 凭证引用未在 MCP_ENV_SECRET_ALLOWLIST 白名单登记，已被拒绝注入（防进程密钥外传）。请联系管理员在部署环境登记该变量名后重试。',
    action: { label: '查看 MCP 凭证治理', href: '#/mcp' },
  },
  TOKEN_AUDIENCE_MISMATCH: {
    tone: 'warn',
    title: '令牌用途不匹配',
    message: '该令牌绑定了专用受众（MCP 服务/插件），不能用于控制台通用接口。请使用登录会话令牌，或经对应服务的专用端点调用。',
    action: { label: '返回登录', href: '#/login' },
  },
  ENTRY_TICKET_INVALID: {
    tone: 'danger',
    title: '入场票据无效或已过期',
    message: '免登入场票据无效、已被使用或已过期。请回到来源入口（钉钉/门户）重新点击进入。',
    action: null,
  },
  INVALID_TICKET: {
    tone: 'danger',
    title: '票据无效或已过期',
    message: '会话票据校验未通过（无效、已使用或已过期）。请回到来源入口重新获取。',
    action: null,
  },
  TICKET_INVALID: {
    tone: 'warn',
    title: '下载票据已失效',
    message: '下载票据缺失或已过期。请回到文件列表重新发起下载。',
    action: { label: '回到 NAS 存储', href: '#/nas' },
  },
  NOT_BOUND: {
    tone: 'danger',
    title: '宿主会话未绑定',
    message: '当前浏览器与平台账号尚未建立绑定。请从宿主入口（打开即工作台）进入，或完成身份绑定后重试。',
    action: { label: '一键绑定', href: '/auth/oidc/start', external: true },
  },
  ACCOUNT_INACTIVE: {
    tone: 'danger',
    title: '账号已冻结或不可用',
    message: '绑定的平台账号已冻结或不存在（fail-closed）。请联系管理员确认账号状态后重新绑定。',
    action: null,
  },
  AUTHN_UNAVAILABLE: {
    tone: 'warn',
    title: '认证服务暂不可用',
    message: '平台认证服务装配不完整或暂不可用。请稍后重试；持续出现请联系平台管理员。',
    action: null,
  },
  EXEC_HUB_UNAVAILABLE: {
    tone: 'warn',
    title: '执行中枢暂不可用',
    message: '执行中枢（exec-hub）装配不完整或暂不可用，数字员工待办暂无法拉取。请稍后重试；持续出现请联系平台管理员。',
    action: null,
  },
  // ── 面板域（2026-10-29 架构统一收编：面板轨软依赖降级/只读面的对外原因码） ──
  UNAUTHENTICATED: {
    tone: 'danger',
    title: '未认证',
    message: '当前请求未携带有效登录凭证（鉴权中间件未覆盖或令牌缺失）。请重新登录后再试。',
    action: { label: '重新登录', href: '#/login' },
  },
  DEGRADED: {
    tone: 'warn',
    title: '能力未接入',
    message: '该能力在本机形态未装配（演示态诚实降级）——连接宿主平台后可用。',
    action: null,
  },
  MODEL_READONLY: {
    tone: 'warn',
    title: '模型目录只读',
    message: '模型目录由 dsh 配置托管（settings.yaml / llm 适配器），面板侧不可增删改。请在 dsh 侧调整模型配置。',
    action: null,
  },

  // ── 01门 远端连接与代理（plugin-rq-card hostlink/向导：形态 C 对外原因码，2026-11-02 合并登记） ──
  WIZARD_CALL_HEADER_REQUIRED: {
    tone: 'danger',
    title: '请求缺少安全校验头',
    message: '连接向导端点要求页面内发起的请求携带安全头（跨站防御拦截）。请从面板内的连接向导页面操作，不要直接拼地址调用。',
    action: null,
  },
  NOT_REMOTE: {
    tone: 'warn',
    title: '当前不是远端连接模式',
    message: '该操作只在「已连接远端宿主」时可用。请先在连接向导里选择并连接宿主平台。',
    action: null,
  },
  HUB_UNREACHABLE: {
    tone: 'warn',
    title: '远端宿主不可达',
    message: '按当前配置的地址无法连上宿主平台。请检查宿主地址、端口与本机网络后重试；持续失败请联系管理员确认宿主在线。',
    action: null,
  },
  HUB_BAD_RESPONSE: {
    tone: 'warn',
    title: '宿主应答格式异常',
    message: '宿主返回了网页而非数据（地址或挂载前缀可能不匹配）。请在连接向导里重新测试连接，必要时更正挂载前缀。',
    action: null,
  },
  PROXY_PATH_DENIED: {
    tone: 'danger',
    title: '该路由不在远端代理白名单内',
    message: '为保护宿主，远端代理只转发登记过的面板路由（fail-closed）。如该能力本应可用，请联系管理员核对双侧版本是否匹配。',
    action: null,
  },

  // ── NAS / 下载 / 版本冲突 ─────────────────────────────────────────────
  SHARE_LINK_INVALID: {
    tone: 'danger',
    title: '分享链接无效',
    message: '该分享链接已失效（过期、被撤销或达到访问上限）。请向分享者重新索取链接。',
    action: null,
  },
  DOWNLOAD_FAILED: {
    tone: 'warn',
    title: '文件下载失败',
    message: '后端存储取流失败。请重试；持续失败请联系管理员检查 NAS 存储状态。',
    action: { label: '查看 NAS 存储', href: '#/nas' },
  },
  VERSION_CONFLICT: {
    tone: 'warn',
    title: '版本冲突：数据已被他人修改',
    message: '你编辑的内容在你打开后已被他人变更，为保护数据本次保存被拒绝。请刷新获取最新版本后重新修改。',
    action: null,
  },

  // ── 更新（plugin-update）──────────────────────────────────────────────
  TOO_FREQUENT: {
    tone: 'warn',
    title: '操作太频繁',
    message: '更新检查请求过于频繁，已被限流。请稍后再试。',
    action: null,
  },
  UPSTREAM_ERROR: {
    tone: 'warn',
    title: '上游服务异常',
    message: '平台依赖的上游服务（更新源）暂时不可用。请稍后重试。',
    action: null,
  },
  APPLY_FAILED: {
    tone: 'danger',
    title: '更新应用失败',
    message: '更新包应用未成功（校验或执行出错）。可重试一次；持续失败请联系管理员查看更新详情。',
    action: null,
  },
  ROLLBACK_FAILED: {
    tone: 'danger',
    title: '回滚失败',
    message: '版本回滚未成功。请勿重复操作，联系管理员介入处理。',
    action: null,
  },

  // ── 接入与机器凭证（plugin-connect / client_credentials）──────────────
  ENROLL_FAILED: {
    tone: 'danger',
    title: '连接器接入注册失败',
    message: '连接器注册未通过（注册凭证无效或已过期）。请核对注册凭证后重试。',
    action: { label: '查看平台接入', href: '#/connect' },
  },
  LOCKED: {
    tone: 'warn',
    title: '接入注册已临时锁定',
    message: '连续注册失败次数过多，接入注册已被临时锁定以保护平台。请锁定期过后再试，或联系管理员核查注册凭证。',
    action: { label: '查看平台接入', href: '#/connect' },
  },
  CC_FAILED: {
    tone: 'danger',
    title: '机器凭证认证失败',
    message: 'client_credentials 认证未通过（client_id/secret 有误或已被吊销）。请核对凭证；必要时到「认证与令牌」重新签发。',
    action: { label: '查看认证与令牌', href: '#/authn' },
  },
  FORBIDDEN_ORIGIN: {
    tone: 'danger',
    title: '当前来源无权访问',
    message: '该配置接口仅允许本机访问。请在部署本机的浏览器中操作。',
    action: null,
  },

  // ── 市场（plugin-market 开发者面）─────────────────────────────────────
  DEVELOPER_REGISTER_FAILED: {
    tone: 'danger',
    title: '开发者注册失败',
    message: '市场开发者注册未成功（信息不完整或账号已存在）。请核对填写内容后重试。',
    action: null,
  },
  DEVELOPER_LOGIN_FAILED: {
    tone: 'danger',
    title: '开发者登录失败',
    message: '市场开发者账号登录未通过（账号或密钥有误）。请核对后重试。',
    action: null,
  },
  MARKET_SUBMIT_FAILED: {
    tone: 'warn',
    title: '市场提交失败',
    message: 'Skill 提交市场未成功（内容校验未通过）。请按提交要求检查资产信息后重试。',
    action: { label: '查看 Skill 市场', href: '#/skills' },
  },

  // ── MCP 工具风险登记（W 批次 W1，V11 根治）────────────────────────────
  RISK_RECORD_NOT_FOUND: {
    tone: 'warn',
    title: '风险登记记录不存在',
    message: '该风险登记记录不存在或已被删除。请刷新清单后重试。',
    action: { label: '查看 MCP 服务', href: '#/mcp' },
  },
  RISK_NOT_PENDING: {
    tone: 'warn',
    title: '登记状态不允许该审批',
    message: '该风险登记当前不在可审批状态（已生效/已驳回/已退场）。请刷新清单确认最新状态。',
    action: { label: '查看 MCP 服务', href: '#/mcp' },
  },
  RISK_LEVEL_MISMATCH: {
    tone: 'warn',
    title: '审批级别与登记进度不匹配',
    message: '当前登记未到该审批级别（write/admin 需先过领域级、再过安全级）。请按两级顺序审批。',
    action: { label: '查看 MCP 服务', href: '#/mcp' },
  },
}

/** 全部已配文案的对外原因码（由 COPY 键集派生，注册表与文案同源）。 */
export const ERROR_CODES = Object.keys(COPY)

/** 绑定失效细分原因码（dsh-bridge /dsh-bridge/status 返回） */
export const BINDING_REASONS = ['no_cookie', 'expired', 'account_inactive']

/**
 * 动态拼接文案翻译（保持零依赖纪律：不 import i18n.js——selftest 在 Node 直测本模块，
 * 经 window.rqI18n 取运行时（浏览器注入），Node/无 i18n 环境回退原文。
 */
function tr(text, params) {
  try {
    if (typeof window !== 'undefined' && window.rqI18n && typeof window.rqI18n.t === 'function') {
      return window.rqI18n.t(text, params)
    }
  } catch { /* 忽略 */ }
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/** 绑定细分原因 → 归并到 binding-invalid 的提示补充。 */
const BINDING_DETAIL = {
  no_cookie: '尚未完成身份绑定。',
  expired: '绑定已过期（默认 24 小时），重新登录即可续期。',
  account_inactive: '账号状态异常（冻结/离职联动失效），请联系管理员确认账号状态。',
}

/** 查文案：未知原因码回落通用兜底（永不裸奔技术错误）。 */
export function errorCopy(code, detail) {
  const base = COPY[code] ?? {
    tone: 'danger',
    title: '操作暂时无法完成',
    message: tr('平台返回未知状态（{code}）。请稍后重试；若持续出现，请联系平台管理员。', { code: code || 'unknown' }),
    action: null,
  }
  const extra = code === 'binding-invalid' && detail && BINDING_DETAIL[detail] ? BINDING_DETAIL[detail] : ''
  return { ...base, ...(extra ? { message: `${base.message}${tr('（{extra}）', { extra })}` } : {}) }
}

/** 渲染横幅/条状提示（返回 HTML 字符串；调用方负责挂载与按钮跳转）。 */
export function errorBarHtml(code, detail) {
  const copy = errorCopy(code, detail)
  const toneColor = copy.tone === 'danger' ? 'var(--danger)' : copy.tone === 'warn' ? 'var(--warn)' : 'var(--info)'
  const toneBg = copy.tone === 'danger' ? 'var(--danger-bg)' : copy.tone === 'warn' ? 'var(--warn-bg)' : 'var(--info-bg)'
  const action = copy.action
    ? `<a class="btn btn-sm ${copy.tone === 'danger' ? 'btn-primary' : 'btn-default'}" data-error-action="1"
        href="${copy.action.href}" ${copy.action.external ? 'target="_top" rel="noopener"' : ''} style="margin-left:12px">${copy.action.label}</a>`
    : ''
  return `<div class="flex error-bar" role="alert" data-error-code="${code}"
    style="gap:10px;padding:10px 14px;border:1px solid ${toneColor}33;background:${toneBg};border-radius:var(--radius);margin-bottom:16px">
    <span style="color:${toneColor};display:flex">${copy.tone === 'info' ? 'ℹ️' : '⚠️'}</span>
    <div class="grow"><div class="fs-13" style="font-weight:600">${copy.title}</div>
    <div class="fs-12 text-3">${copy.message}</div></div>${action}</div>`
}
