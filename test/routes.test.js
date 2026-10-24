/**
 * 路由层的回归测试：方法校验、loopback 守卫、token 校验、错误码映射、只注销一次。
 *
 *   node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { registerRoutes } from '../lib/routes.js'

/** 假的 req：Readable 加上 method/headers，POST 时推空 body 让 readBody 收尾。 */
function makeRequest({ method = 'GET', host = '127.0.0.1:1234', origin, key, body = '' } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  if (key !== undefined) headers['x-dsh-refresh-restart-key'] = key
  const req = Readable.from(method === 'POST' ? [Buffer.from(body)] : [])
  req.method = method
  req.headers = headers
  return req
}

/** 假的 res：记录状态码、响应头和 JSON body。 */
function makeResponse() {
  const res = {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(payload) {
      res.body = payload === undefined ? null : JSON.parse(payload)
    },
  }
  return res
}

/** 起一个假的宿主：只实现 webServer.register。 */
function makeHost(service) {
  const routes = new Map()
  const disposals = []
  const ctx = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(options) {
          routes.set(`${options.path}`, options.handler)
          return () => disposals.push(options.path)
        },
      }
    },
  }
  const registered = registerRoutes(ctx, service)
  return { routes, disposals, registered }
}

const baseService = () => ({
  token: 'token-abc',
  snapshot: () => ({ ok: true, canRestart: true, token: 'token-abc' }),
  restart: () => ({ ok: true, helperPid: 123, logPath: '/tmp/x.log', scriptPath: '/tmp/x.sh' }),
})

const call = async (routes, path, req) => {
  const res = makeResponse()
  await routes.get(path)(req, res)
  return res
}

test('GET status 返回快照并禁缓存', async () => {
  const { routes } = makeHost(baseService())
  const res = await call(routes, '/plugins/dsh-refresh-restart/status', makeRequest())
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.body.ok, true)
  assert.equal(res.body.token, 'token-abc')
})

test('方法不对返回 405', async () => {
  const { routes } = makeHost(baseService())
  const res = await call(routes, '/plugins/dsh-refresh-restart/restart', makeRequest({ method: 'GET' }))
  assert.equal(res.statusCode, 405)
  assert.equal(res.body.error.code, 'method-not-allowed')
})

test('非 loopback Host 一律 403（DNS rebinding）', async () => {
  const { routes } = makeHost(baseService())
  const res = await call(routes, '/plugins/dsh-refresh-restart/status', makeRequest({ host: 'evil.example.com' }))
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error.code, 'request-not-trusted')
})

test('跨站 Origin 的 POST 被拒', async () => {
  const { routes } = makeHost(baseService())
  const req = makeRequest({ method: 'POST', origin: 'https://evil.example.com', key: 'token-abc' })
  const res = await call(routes, '/plugins/dsh-refresh-restart/restart', req)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error.code, 'request-not-trusted')
})

test('token 不对返回 403 bad-token', async () => {
  const { routes } = makeHost(baseService())
  const req = makeRequest({ method: 'POST', key: 'wrong' })
  const res = await call(routes, '/plugins/dsh-refresh-restart/restart', req)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error.code, 'bad-token')
})

test('缺 token 同样 403', async () => {
  const { routes } = makeHost(baseService())
  const res = await call(routes, '/plugins/dsh-refresh-restart/restart', makeRequest({ method: 'POST' }))
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error.code, 'bad-token')
})

test('合法请求返回 202 与助手信息', async () => {
  const { routes } = makeHost(baseService())
  const req = makeRequest({ method: 'POST', key: 'token-abc', body: '{}' })
  const res = await call(routes, '/plugins/dsh-refresh-restart/restart', req)
  assert.equal(res.statusCode, 202)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.helperPid, 123)
})

test('服务层 unsupported → 501，busy → 409', async () => {
  const service = baseService()
  service.restart = () => {
    const error = new Error('这个平台暂不支持一键重启')
    error.code = 'unsupported'
    throw error
  }
  let res = await call(makeHost(service).routes, '/plugins/dsh-refresh-restart/restart', makeRequest({ method: 'POST', key: 'token-abc' }))
  assert.equal(res.statusCode, 501)
  assert.equal(res.body.error.code, 'unsupported')

  service.restart = () => {
    const error = new Error('已经在重启了')
    error.code = 'busy'
    throw error
  }
  res = await call(makeHost(service).routes, '/plugins/dsh-refresh-restart/restart', makeRequest({ method: 'POST', key: 'token-abc' }))
  assert.equal(res.statusCode, 409)
})

test('注销函数可重复调用，底层只释放一次', () => {
  const { disposals, registered } = makeHost(baseService())
  assert.equal(registered.length, 3)
  for (const release of registered) {
    release()
    release()
  }
  assert.deepEqual(disposals.sort(), [
    '/plugins/dsh-refresh-restart/restart',
    '/plugins/dsh-refresh-restart/state',
    '/plugins/dsh-refresh-restart/status',
  ])
})

test('宿主没有 webServer 时安静返回空数组', () => {
  const registered = registerRoutes({ get: () => undefined }, baseService())
  assert.deepEqual(registered, [])
})
