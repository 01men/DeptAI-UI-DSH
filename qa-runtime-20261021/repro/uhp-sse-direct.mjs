/**
 * 复现：UHP 外部直调 stream=true 的 SSE 永不完成
 * 预期：执行 completed 后应下发 event: response.completed
 * 实测：只有 response.created，后续无任何帧（仅 15s 心跳注释）
 */
const base = process.env.BASE ?? 'http://127.0.0.1:7344'
const login = async (u, p = 'Ybk@2026') => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }).then(r => r.json())).data.token
const admin = await login('admin')
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + admin }
const harnesses = (await (await fetch(base + '/api/uhp/harnesses', { headers: H })).json()).data.harnesses
const harness = harnesses.find(h => h.dataClassCeiling !== 'public') ?? harnesses[0]
const ac = new AbortController()
const res = await fetch(base + '/v1/uhp/responses', {
  method: 'POST', headers: H, signal: ac.signal,
  body: JSON.stringify({ model: 'harness/' + harness.id, input: 'SSE 外部直调复现', stream: true }),
})
const reader = res.body.getReader()
let text = ''
const deadline = Date.now() + 9000
while (Date.now() < deadline) {
  const chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ timeout: true }), 1000))])
  if (chunk.timeout) continue
  if (chunk.done) break
  text += Buffer.from(chunk.value).toString('utf8')
  if (/response\.(completed|failed|canceled)/.test(text)) break
}
ac.abort(); await reader.cancel().catch(() => {})
const recordId = /"id":"(resp_[^"]+)"/.exec(text)?.[1]
const status = recordId ? (await (await fetch(base + '/v1/uhp/responses/' + recordId, { headers: H })).json()).data.status : null
console.log(JSON.stringify({
  httpStatus: res.status,
  contentType: res.headers.get('content-type'),
  eventsSeen: [...text.matchAll(/event: (\S+)/g)].map(m => m[1]),
  executionStatus: status,
  verdict: /response\.completed/.test(text) ? 'PASS（收到 completed 帧）' : 'FAIL（SSE 未完成，执行实际状态=' + status + '）',
}, null, 2))
