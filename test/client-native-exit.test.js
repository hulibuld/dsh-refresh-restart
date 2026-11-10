import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function extract(start, end) {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first)
  assert.ok(first >= 0 && last > first)
  return source.slice(first, last).trim()
}
const nativeSource = extract('    function nativeApplicationButton()', '\n    /*')
const watchSource = extract('      function watchState(requestId)', '\n      function doRestart()')
function button(label = '应用') {
  return {
    textContent: label,
    getAttribute(name) { return { role: 'menuitem', 'aria-haspopup': 'menu' }[name] },
    click() { this.clicks = (this.clicks || 0) + 1 },
  }
}
function nativeButton(host) {
  return vm.runInNewContext('(' + nativeSource + ')', {
    document: { querySelector(selector) { assert.equal(selector, '[data-windows-menu]'); return host } },
  })()
}
test('native menu preflight accepts only known desktop menu structure and labels', () => {
  for (const label of ['应用', 'Application', 'App']) {
    const target = button(label)
    assert.equal(nativeButton({ shadowRoot: { querySelector: () => target } }), target)
    assert.equal(target.clicks, undefined, 'preflight never opens a menu')
  }
  for (const host of [null, {}, { shadowRoot: {} }]) {
    if (host?.shadowRoot) host.shadowRoot.querySelector = () => null
    assert.equal(nativeButton(host), null)
  }
  for (const target of [button('编辑'), { ...button(), disabled: true }, { ...button(), getAttribute: () => 'button' }]) {
    assert.equal(nativeButton({ shadowRoot: { querySelector: () => target } }), null)
  }
})
async function watch(states, target = button(), requestId = 'operation-1') {
  const queue = []
  const errors = []
  let fetches = 0
  const sandbox = {
    Date,
    ROUTE: '/test',
    STATE_TEXT: { cancelled: 'cancelled', 'quit-failed': 'quit-failed', 'launch-failed': 'launch-failed' },
    unmountRef: { current: null },
    setBusy() {},
    setError(text) { errors.push(text) },
    nativeApplicationButton: () => target,
    window: { setTimeout(callback) { queue.push(callback) } },
    fetch: async () => ({ ok: true, json: async () => ({ state: states[fetches++] }) }),
  }
  vm.runInNewContext('(' + watchSource + ')', sandbox)(requestId)
  for (let i = 0; queue.length && i < states.length; i += 1) {
    queue.shift()()
    // Flush fetch -> response.json -> state handler without real polling delays.
    await new Promise(resolve => setImmediate(resolve))
  }
  return { errors, target, fetches }
}
const state = phase => ({ requestId: 'operation-1', phase })
test('opens native application menu once, only for this operation after watcher is ready', async () => {
  const result = await watch([state('starting'), state('ready-for-menu'), state('ready-for-menu'), state('cancelled')])
  assert.equal(result.target.clicks, 1)
  assert.deepEqual(result.errors, ['cancelled'])
})
test('foreign or uncorrelated state cannot open a native menu', async () => {
  for (const foreign of [null, { phase: 'ready-for-menu' }, { requestId: 'other', phase: 'ready-for-menu' }]) {
    const result = await watch([foreign])
    assert.equal(result.target.clicks, undefined)
    assert.match(result.errors[0], /不匹配/)
  }
})
test('missing menu fails closed without click; native quit failure restores UI', async () => {
  const missing = await watch([state('ready-for-menu')], null)
  assert.match(missing.errors[0], /未请求退出/)
  const failed = await watch([state('quit-failed')])
  assert.deepEqual(failed.errors, ['quit-failed'])
  assert.equal(failed.target.clicks, undefined)
})
