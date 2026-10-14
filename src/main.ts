/**
 * 独立宿主入口：以 cordis 插件树启动整个平台。
 * 用法：node src/main.ts [--port 7300] [--data ./data]
 */
import { Context } from '@deepseek-ai/cordis'
import { bootAll } from './boot-all.ts'

const args = process.argv.slice(2)
function argValue(flag: string, fallback?: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}

const ctx = new Context()
const port = Number(argValue('--port', '7300'))
const dataDir = argValue('--data', './data')

process.on('unhandledRejection', (reason) => {
  console.error('[main] 未处理的 Promise 拒绝', reason)
})

await bootAll(ctx, { dataDir, port })

const logger = ctx.logger('main')
logger.info('元冰可|企业AI资源管理平台已启动')
logger.info(`控制台地址：http://0.0.0.0:${port}（本机访问 http://127.0.0.1:${port}）`)

process.on('SIGINT', () => {
  logger.info('收到 SIGINT，正在退出…')
  void ctx.opsStorage.flushNow().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void ctx.opsStorage.flushNow().finally(() => process.exit(0))
})
