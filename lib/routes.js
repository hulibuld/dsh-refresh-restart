/**
 * 快捷动作的 HTTP 接口。
 *
 * 页面上的按钮是同一来源里的普通脚本，所以它这样和宿主说话：
 *
 *   GET  /plugins/dsh-refresh-restart/status   → 状态文档（含一次性 action token）
 *   POST /plugins/dsh-refresh-restart/restart  → 退出并重新打开应用
 *
 * 安全：所有路由只接受 loopback 调用，POST 还必须带上最新 status 文档里的随机
 * token。只校验 loopback 的 Host 头没有意义 —— 本机任何进程都能伪造，token 才
 * 能证明「调用方是已经读过我们状态页的那个页面」。
 *
 * @module dsh-refresh-restart/lib/routes
 */

import { timingSafeEqual } from 'node:crypto'
import { ROUTE_PREFIX } from './restart.js'

/** 接受的 POST body 上限。 */
const BODY_LIMIT = 8 * 1024

/** 把服务层抛出的 `error.code` 映射成合适的 HTTP 状态码。 */
function statusForCode(code) {
  if (code === 'busy') return 409
  if (code === 'unsupported') return 501
  if (code === 'disposed') return 503
  return 500
}

/** 请求的 Host 头是否指向本机。 */
export function hostIsLoopback(host) {
  if (typeof host !== 'string' || host.trim() === '') return false
  const value = host.trim().toLowerCase()
  const name = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/** 请求是否经由 loopback 到达。 */
export function loopbackRequest(req) {
  return hostIsLoopback(req.headers.host)
}

/** 请求的 Origin（如果有）是否是本机。 */
export function originIsLoopback(origin) {
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return hostIsLoopback(new URL(origin).host)
  } catch {
    return false
  }
}

/** 常数时间比较两个密串。 */
export function secretMatches(expected, provided) {
  if (typeof provided !== 'string' || provided === '') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 读完一个小 body（内容本身用不上，只是把数据排干）。 */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        resolve('')
        req.destroy()
      }
    })
    req.on('end', () => resolve(''))
    req.on('error', () => resolve(''))
  })
}

/**
 * 注册路由。
 *
 * @param {import('cordis').Context} ctx
 * @param {ReturnType<import('./restart.js').createRestartService>} service
 * @param {{logger?: (message: string) => void}} [options]
 * @returns {Array<() => void>} 每个路由的注销函数
 */
export function registerRoutes(ctx, service, { logger = () => {} } = {}) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    logger('[dsh-refresh-restart] the host has no webServer service; the buttons cannot be reached')
    return []
  }

  const disposers = []

  /** 套上守卫，并把抛出的错误转成 JSON。 */
  const route = (method, name, handler) => {
    const path = `${ROUTE_PREFIX}/${name}`
    const listener = async (req, res) => {
      try {
        if (req.method !== method) {
          sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `${method} only` } })
          return
        }
        if (!loopbackRequest(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'request-not-trusted', message: 'loopback requests only' } })
          return
        }
        if (method === 'POST') {
          if (!originIsLoopback(req.headers.origin)) {
            sendJson(res, 403, { ok: false, error: { code: 'request-not-trusted', message: 'loopback origin only' } })
            return
          }
          const provided = req.headers['x-dsh-refresh-restart-key']
          if (!secretMatches(service.token, Array.isArray(provided) ? provided[0] : provided)) {
            // 页面拿的是启动时那一份 token；宿主重启过就会失效，刷新页面能拿到新的。
            sendJson(res, 403, { ok: false, error: { code: 'bad-token', message: 'stale action token' } })
            return
          }
          await readBody(req)
        }
        const result = await handler(req)
        sendJson(res, result.status ?? 200, result.body ?? { ok: true })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'internal-error'
        const message = error instanceof Error ? error.message : String(error)
        logger(`[dsh-refresh-restart] ${path} failed: ${message}`)
        sendJson(res, statusForCode(code), { ok: false, error: { code, message } })
      }
    }

    const dispose = webServer.register({ kind: 'exact', path, handler: listener })
    // 卸载路径有两条（返回值没人用 + ctx.effect），包一层保证只调一次。
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (typeof dispose === 'function') dispose()
    }
    disposers.push(release)
    logger(`[dsh-refresh-restart] route ${method} ${path}`)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => release, `dsh-refresh-restart: ${method} ${path}`)
    }
    return release
  }

  route('GET', 'status', () => ({ body: service.snapshot() }))

  route('POST', 'restart', () => ({ status: 202, body: { ok: true, accepted: true, ...service.restart() } }))

  return disposers
}
