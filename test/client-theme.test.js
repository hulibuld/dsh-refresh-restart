/**
 * 主按钮主题回归：执行 client.js 中的真实 ActionButton，不复制生产样式逻辑。
 *
 *   node --test test/client-theme.test.js
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function ActionButton(props) {')
const end = source.indexOf('\n    /*', start)
assert.ok(start >= 0 && end > start, '应该找到真实 ActionButton 函数')

function loadButton(props) {
  let hover = false
  const ActionButton = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', {
    useState() {
      return [hover, (next) => { hover = next }]
    },
    h(type, attributes, children) {
      return { type, props: attributes, children }
    },
  }, { filename: 'client.js:ActionButton' })
  return () => ActionButton(props)
}

function assertPrimaryPair(button) {
  assert.equal(button.props.style.background, 'var(--dsw-alias-label-primary)')
  assert.equal(button.props.style.color, 'var(--dsw-alias-bg-base)')
}

for (const disabled of [false, true]) {
  test(`主按钮使用随 light/dark 主题切换的成对 token，hover 不丢失对比（disabled=${disabled}）`, () => {
    const render = loadButton({ primary: true, disabled })
    let button = render()
    assertPrimaryPair(button)
    button.props.onMouseEnter()
    button = render()
    assertPrimaryPair(button)
    button.props.onMouseLeave()
    assertPrimaryPair(render())
    assert.equal(button.props.disabled, disabled)
    assert.equal(button.props.style.opacity, disabled ? 0.55 : 1)
    assert.equal(button.props.style.cursor, disabled ? 'default' : 'pointer')
  })
}

test('主按钮保留尺寸、边框、文本和点击行为', () => {
  let clicks = 0
  const render = loadButton({ primary: true, children: '重启', onClick() { clicks += 1 } })
  const button = render()
  assert.equal(button.type, 'button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.children, '重启')
  assert.equal(button.props.style.height, 28)
  assert.equal(button.props.style.padding, '0 12px')
  assert.equal(button.props.style.borderRadius, 6)
  assert.equal(button.props.style.border, 'none')
  button.props.onClick()
  assert.equal(clicks, 1)
})

for (const disabled of [false, true]) {
  test(`次按钮保持原有前景、背景及 hover 行为（disabled=${disabled}）`, () => {
    const render = loadButton({ disabled })
    let button = render()
    assert.equal(button.props.style.background, 'transparent')
    assert.equal(button.props.style.color, 'var(--dsw-alias-label-primary)')
    assert.equal(button.props.style.border, '1px solid var(--dsw-alias-border-l1)')
    button.props.onMouseEnter()
    button = render()
    assert.equal(button.props.style.background, disabled ? 'transparent' : 'var(--dsw-alias-bg-layer-2)')
    assert.equal(button.props.style.color, 'var(--dsw-alias-label-primary)')
    button.props.onMouseLeave()
    assert.equal(render().props.style.background, 'transparent')
  })
}
