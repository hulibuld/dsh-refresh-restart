/**
 * 摆位回归测试。
 *
 *   node --test test/
 *
 * 真实事故（2026-10-26）：侧栏收成 56px 图标栏、或者窗口没最大化到 1024px 以上时，
 * 侧栏会自动收成图标栏，按钮被算到内容区里，看着像「位置错乱」。
 *
 * 这里搭一个够用的假 DOM，把 client.js 当普通模块加载：
 *   · 锚点在一个 52px 的标题栏（topStrip）里 → 按钮插进同一条 flex 行，交给布局排；
 *   · 标题栏只剩 56px → 插进去但整组藏起来；
 *   · 没有标题栏（Windows 那种）→ 退回固定定位，坐标自己算。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT = new URL('../client.js', import.meta.url)

/* ------------------------------------------------------------------ *
 * 假 DOM：只实现 client.js 真正用到的部分
 * ------------------------------------------------------------------ */

class FakeElement {
  constructor(tag, attrs = {}) {
    this.nodeType = 1
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = { cssText: '', pointerEvents: '' }
    this.attrs = { ...attrs }
    this.className = attrs.class || ''
    this.clientWidth = Number(attrs.clientWidth || 0)
    this.rect = attrs.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  getAttribute(name) {
    if (name === 'class') return this.className
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }

  setAttribute(name, value) {
    if (name === 'class') this.className = String(value)
    this.attrs[name] = String(value)
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const at = this.children.indexOf(before)
    if (at < 0) this.children.push(child)
    else this.children.splice(at, 0, child)
    return child
  }

  removeChild(child) {
    const at = this.children.indexOf(child)
    if (at >= 0) this.children.splice(at, 1)
    child.parentNode = null
    return child
  }

  getBoundingClientRect() {
    return this.rect
  }

  get nextSibling() {
    const parent = this.parentNode
    if (!parent) return null
    return parent.children[parent.children.indexOf(this) + 1] || null
  }

  get previousSibling() {
    const parent = this.parentNode
    if (!parent) return null
    return parent.children[parent.children.indexOf(this) - 1] || null
  }

  // 只要后代里符合条件的，够用
  querySelectorAll(selector) {
    return descendants(this).filter((node) => matches(node, selector))
  }
}

function descendants(root) {
  const out = []
  const walk = (node) => {
    for (const child of node.children) {
      out.push(child)
      walk(child)
    }
  }
  walk(root)
  return out
}

function matches(node, selector) {
  if (node.nodeType !== 1) return false
  if (selector === 'button' || selector === '*' || selector === 'div') {
    return node.tagName === selector.toUpperCase()
  }
  if (selector === 'button[class*="toggle"]') {
    return node.tagName === 'BUTTON' && node.className.indexOf('toggle') >= 0
  }
  if (selector === '[class*="topStrip"] button') {
    if (node.tagName !== 'BUTTON') return false
    const parent = node.parentNode
    return parent !== null && parent.className.indexOf('topStrip') >= 0
  }
  if (selector === '[data-windows-menu]') {
    return node.getAttribute('data-windows-menu') !== null
  }
  return false
}

/* ------------------------------------------------------------------ *
 * 假 React：只用 useState / useEffect / useRef / createElement
 * ------------------------------------------------------------------ */

function makeReact() {
  const hooks = { states: [], effects: [], refs: [], index: 0, mounted: false, pending: false }
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined) }
    },
    useState(initial) {
      const at = hooks.index++
      if (!(at in hooks.states)) hooks.states[at] = initial
      const set = (next) => {
        hooks.states[at] = typeof next === 'function' ? next(hooks.states[at]) : next
        hooks.pending = true
      }
      return [hooks.states[at], set]
    },
    useRef(initial) {
      const at = hooks.index++
      if (!(at in hooks.refs)) hooks.refs[at] = { current: initial }
      return hooks.refs[at]
    },
    useEffect(fn) {
      const at = hooks.index++
      if (!hooks.mounted) hooks.effects[at] = fn
    },
  }
  return { React, hooks }
}

/* ------------------------------------------------------------------ *
 * 装载 client.js
 * ------------------------------------------------------------------ */

function loadClient({ stripWidth, toggleRect, withStrip, justify = 'flex-end' }) {
  const { React, hooks } = makeReact()
  const portals = []

  const documentElement = new FakeElement('html')
  const body = new FakeElement('body')
  documentElement.appendChild(body)

  let anchor = null
  let strip = null
  if (withStrip) {
    strip = new FakeElement('div', { class: '_x_topStrip_1', clientWidth: stripWidth })
    documentElement.appendChild(strip)
  }
  const toggle = new FakeElement('button', { class: '_x_toggle_1', rect: toggleRect })
  if (strip) strip.appendChild(toggle)
  else documentElement.appendChild(toggle)
  anchor = toggle

  const document = {
    documentElement,
    body,
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: (selector) => descendants(documentElement).filter((node) => matches(node, selector)),
    querySelector(selector) {
      const found = descendants(documentElement).filter((node) => matches(node, selector))
      return found.length > 0 ? found[0] : null
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const window = {
    innerWidth: 1440,
    getComputedStyle: () => ({ justifyContent: justify }),
    location: { reload() {} },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(fn) {
      fn()
      return 1
    },
    cancelAnimationFrame() {},
    clearTimeout() {},
    setTimeout() {
      return 0
    },
  }

  const require = (name) => {
    if (name === 'react') return React
    if (name === 'react-dom') {
      return {
        createPortal(node, host) {
          portals.push({ node, host })
          return node
        },
      }
    }
    throw new Error('unexpected module ' + name)
  }

  let loaded = null
  const sandbox = {
    window: Object.assign(window, {
      __ModuleLoader__: {
        load(def) {
          loaded = def
        },
      },
    }),
    document,
    require,
    console,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout() {
      return 0
    },
    clearTimeout() {},
    fetch() {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
    },
  }
  sandbox.globalThis = sandbox
  sandbox.window.document = document
  vm.runInNewContext(readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })

  assert.ok(loaded !== null, 'client.js 应该注册一个模块')
  assert.equal(loaded.id, 'dsh-refresh-restart')
  const exportsObject = loaded.factory(require)

  // 拿到注册进 shell.overlay 的那个组件
  let component = null
  const slots = {
    register(options, render) {
      assert.equal(options.name, 'shell.overlay')
      component = render
      return { dispose() {} }
    },
    inject(name, fn) {
      assert.equal(name, 'shell.overlay')
      return fn()
    },
  }
  const ctx = {
    slots,
    effect(fn) {
      return fn()
    },
  }
  exportsObject.apply(ctx)
  assert.ok(component !== null, '应该往 shell.overlay 注册了组件')

  // 第一次渲染 + 跑一次 effect，然后把 setState 引起的重渲染补上
  hooks.index = 0
  let tree = component()
  hooks.mounted = true
  for (const effect of hooks.effects) if (typeof effect === 'function') effect()
  hooks.index = 0
  hooks.pending = false
  tree = component()

  return { tree, portals, hooks, strip, toggle, component, document }
}

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

test('标题栏够宽时把按钮插进那条 flex 行，跟着布局走', () => {
  const { tree, portals, strip, toggle } = loadClient({
    withStrip: true,
    stripWidth: 300,
    toggleRect: { left: 240, top: 12, right: 268, bottom: 40, width: 28, height: 28 },
  })

  assert.equal(portals.length, 1, '应该走 portal')
  const host = portals[0].host
  assert.equal(host.parentNode, strip, '容器要挂在标题栏里')
  // 插在「收起侧边栏」前面，两者同一行
  assert.equal(strip.children.indexOf(host), strip.children.indexOf(toggle) - 1)
  assert.equal(host.style.display, 'inline-flex')
  // 渲染的就是 portal 里那份，而且不带固定定位
  assert.equal(tree, portals[0].node)
  assert.equal(tree.props.style.position, undefined, '插进标题栏后不该再有固定坐标')
})

test('全屏时标题栏改成左对齐，按钮要插在收起按钮后面，不能把它顶走', () => {
  const { portals, strip, toggle } = loadClient({
    withStrip: true,
    stripWidth: 300,
    justify: 'flex-start',
    toggleRect: { left: 12, top: 12, right: 40, bottom: 40, width: 28, height: 28 },
  })

  const host = portals[0].host
  assert.equal(host.parentNode, strip)
  assert.equal(strip.children.indexOf(host), strip.children.indexOf(toggle) + 1, '要排在收起按钮右边')
})

test('侧栏收成图标栏时整组隐藏，不往内容区里乱摆', () => {
  const { portals } = loadClient({
    withStrip: true,
    stripWidth: 56,
    toggleRect: { left: 12, top: 12, right: 40, bottom: 40, width: 28, height: 28 },
  })

  assert.equal(portals.length, 1)
  assert.equal(portals[0].host.style.display, 'none', '56px 塞不下两个按钮，应该藏起来')
})

test('没有标题栏（Windows）时退回固定定位，并让开左侧系统菜单', () => {
  const { tree, portals } = loadClient({
    withStrip: false,
    stripWidth: 0,
    toggleRect: { left: 12, top: 12, right: 40, bottom: 40, width: 28, height: 28 },
  })

  assert.equal(portals.length, 0, '不该走 portal')
  assert.ok(tree !== null, '应该渲染固定定位的容器')
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.style.position, 'fixed')
  // 左边放不下，退到按钮右边
  assert.ok(tree.props.style.left >= 44 - 1, 'left 应该落在按钮右侧，实测 ' + tree.props.style.left)
})
