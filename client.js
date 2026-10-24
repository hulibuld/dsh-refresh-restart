/**
 * dsh-refresh-restart — client half.
 *
 * 手写浏览器模块（没有构建步骤）：React 来自页面自己的模块表，插件只注册一个
 * `shell.overlay` 槽组件。按钮不往页面 DOM 里塞东西，而是用**固定定位**画在
 * 「收起侧边栏」按钮左边一点点 —— 那个按钮的位置每次挂载和窗口变化时重新量，
 * 所以展开/收起侧栏、全屏、换窗口大小都不会跑偏。
 *
 * 两个动作：
 *   · 刷新 —— 页面自己 `location.reload()`，不需要宿主配合；
 *   · 重启 —— 读 status 拿一次性 token，POST 给宿主，由宿主拉起脱离进程的
 *     助手去「退出 → 等它消失 → 重新打开」。
 *
 * 宿主没加载时（例如刚装好还没重启），按钮会给出明确提示而不是静默失败。
 */

window.__ModuleLoader__.load({
  id: 'dsh-refresh-restart',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var ROUTE = '/plugins/dsh-refresh-restart'
    var SIZE = 28
    var GAP = 4
    var ROW = SIZE * 2 + GAP

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */

    var TEXT = {
      refreshTitle: '刷新界面（正在生成的回答不会中断）',
      restartTitle: '重启 DeepSeek Harness',
      confirmTitle: '重启 DeepSeek Harness？',
      confirmBody: '界面会先关闭，几秒后自动重新打开。没发送出去的输入会丢失。',
      restarting: '正在重启…窗口马上会关闭。',
      cancel: '取消',
      confirm: '重启',
    }

    /** 宿主返回的错误码 → 人话。认不出来的码退回服务端原文。 */
    var ERROR_TEXT = {
      'bad-token': '重启授权已过期，刷新页面后再点一次',
      unsupported: '当前启动方式不支持一键重启：浏览器 / 命令行模式请手动重启桌面应用',
      busy: '正在重启中，请稍等',
      disposed: '插件已被卸载',
    }

    /* ------------------------------------------------------------------ *
     * 图标（16px，颜色跟随 currentColor）
     * ------------------------------------------------------------------ */

    function icon(children) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        children,
      )
    }

    var REFRESH_ICON = icon([
      h('path', { key: 'arc', d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
      h('path', { key: 'head', d: 'M21 3v5h-5' }),
    ])

    var RESTART_ICON = icon([
      h('path', { key: 'stem', d: 'M12 3v9' }),
      h('path', { key: 'arc', d: 'M6.6 6.6a9 9 0 1 0 12.8 0' }),
    ])

    /* ------------------------------------------------------------------ *
     * 样式
     * ------------------------------------------------------------------ */

    function iconButtonStyle(hover, disabled) {
      return {
        width: SIZE,
        height: SIZE,
        flex: 'none',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: '6px',
        background: hover && !disabled ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        WebkitAppRegion: 'no-drag',
      }
    }

    var POPOVER_STYLE = {
      position: 'absolute',
      left: '0px',
      top: SIZE + 8 + 'px',
      width: 260,
      maxWidth: 'calc(100vw - 16px)',
      boxSizing: 'border-box',
      padding: '12px 14px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 16px 40px rgba(0,0,0,.28)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      zIndex: 30,
      pointerEvents: 'auto',
    }

    /* ------------------------------------------------------------------ *
     * 小组件
     * ------------------------------------------------------------------ */

    /** 按钮下方的小提示框：悬停或键盘聚焦时出现，纯装饰，不挡鼠标。 */
    function tipStyle(visible) {
      return {
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: '50%',
        transform: 'translateX(-50%)',
        whiteSpace: 'nowrap',
        padding: '2px 7px',
        borderRadius: 4,
        background: 'rgba(20,20,22,.88)',
        color: '#fff',
        fontSize: 11,
        lineHeight: '16px',
        letterSpacing: 0,
        opacity: visible ? 1 : 0,
        transition: 'opacity 120ms ease',
        pointerEvents: 'none',
        zIndex: 140,
        WebkitAppRegion: 'no-drag',
      }
    }

    function IconButton(props) {
      var hoverState = useState(false)
      var hover = hoverState[0]
      var setHover = hoverState[1]
      var focusState = useState(false)
      var focus = focusState[0]
      var setFocus = focusState[1]
      var disabled = props.disabled === true
      var tip = typeof props.tip === 'string' ? props.tip : ''
      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex', flex: 'none' } },
        h(
          'button',
          {
            type: 'button',
            'aria-label': props.label,
            disabled: disabled,
            onClick: props.onClick,
            onMouseEnter: function () { setHover(true) },
            onMouseLeave: function () { setHover(false) },
            onFocus: function () { setFocus(true) },
            onBlur: function () { setFocus(false) },
            style: iconButtonStyle(hover, disabled),
          },
          props.children,
        ),
        tip === ''
          ? null
          : h(
              'span',
              { 'aria-hidden': true, style: tipStyle(!disabled && (hover || focus)) },
              tip,
            ),
      )
    }

    function ActionButton(props) {
      var hoverState = useState(false)
      var hover = hoverState[0]
      var setHover = hoverState[1]
      var primary = props.primary === true
      var disabled = props.disabled === true
      var background = primary
        ? 'var(--dsw-alias-brand-primary)'
        : hover && !disabled
          ? 'var(--dsw-alias-bg-layer-2)'
          : 'transparent'
      return h(
        'button',
        {
          type: 'button',
          disabled: disabled,
          onClick: props.onClick,
          onMouseEnter: function () { setHover(true) },
          onMouseLeave: function () { setHover(false) },
          style: {
            height: 28,
            padding: '0 12px',
            borderRadius: 6,
            border: primary ? 'none' : '1px solid var(--dsw-alias-border-l1)',
            background: background,
            color: primary ? '#ffffff' : 'var(--dsw-alias-label-primary)',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            font: 'inherit',
            fontSize: 13,
          },
        },
        props.children,
      )
    }

    /* ------------------------------------------------------------------ *
     * 主体
     * ------------------------------------------------------------------ */

    function Controls() {
      var posState = useState(null)
      var pos = posState[0]
      var setPos = posState[1]
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errorState = useState('')
      var error = errorState[0]
      var setError = errorState[1]

      // 自己的容器：量位置时要先把它藏起来，否则 elementFromPoint 命中的永远是它自己。
      var ownRef = useRef(null)

      // 量「收起侧边栏」按钮的位置。渲染路径上不允许抛错，整段包在 try 里。
      useEffect(function () {
        var frame = 0
        var timer = 0

        // 探测某个坐标上已经站着谁。Windows 桌面端的标题栏上有「应用」「编辑」两个
        // 系统菜单按钮，和「收起侧边栏」挤在同一条带子里，位置是写死的，插件拿不到它们的
        // 坐标，只能反过来问页面：这个点是不是空的。
        function isOurs(node) {
          for (var n = node; n && n !== document.documentElement; n = n.parentNode) {
            if (n.nodeType !== 1) break
            if (n.getAttribute && n.getAttribute('data-dsh-refresh-restart') !== null) return true
          }
          return false
        }

        function freeAt(x, y) {
          try {
            var node = document.elementFromPoint(x, y)
            if (!node) return true
            if (isOurs(node)) return true
            if (node === document.body || node === document.documentElement) return true
            var cls = node.getAttribute && node.getAttribute('class')
            // 标题栏的拖拽层不算占用，点上去是拖窗口，不抢点击
            if (cls && (cls.indexOf('topStrip') >= 0 || cls.indexOf('drag') >= 0)) return true
            return false
          } catch (ignored) {
            return true
          }
        }

        // 两个按钮并排占 left..left+ROW，四角都空才算空。
        function spotFree(left, top) {
          var mid = top + SIZE / 2
          return (
            freeAt(left + 5, mid) &&
            freeAt(left + SIZE - 5, mid) &&
            freeAt(left + SIZE + GAP + 5, mid) &&
            freeAt(left + ROW - 5, mid)
          )
        }

        function measure() {
          frame = 0
          try {
            // topStrip 里只有一个按钮，就是「收起侧边栏」；先用它，取不到再退回
            // 按 class 找 toggle（避免误中设置页里同样带 toggle 字样的开关）。
            var toggle =
              document.querySelector('[class*="topStrip"] button') ||
              document.querySelector('button[class*="toggle"]')
            if (!toggle) return
            var rect = toggle.getBoundingClientRect()
            if (!rect || rect.width === 0) return
            var top = Math.round(rect.top + (rect.height - SIZE) / 2)
            var left = Math.round(rect.left - 4 - ROW)
            if (left < 8) left = Math.round(rect.right + 4)

            // Windows 桌面端的「应用」「编辑」两个菜单按钮不在页面里，是 preload 直接塞进来的
            // 固定定位元素（div[data-windows-menu]，里面是 shadow DOM），固定在标题栏左侧。
            // 拿不到它们的尺寸就没法猜，所以直接读它们的盒子，把我们排到右边去。
            var menu = document.querySelector('[data-windows-menu]')
            if (menu !== null) {
              var menuRect = menu.getBoundingClientRect()
              if (menuRect && menuRect.width > 0 && left < menuRect.right + 4) {
                left = Math.round(menuRect.right + 4)
              }
            }

            // 探测前先把自己的容器藏起来（pointer-events:none）：否则 elementFromPoint
            // 命中的是自己，会一直误判「这儿空着」，永远让不了位。
            var own = ownRef.current
            var pointerEvents = own === null ? null : own.style.pointerEvents
            if (own !== null) own.style.pointerEvents = 'none'
            try {
              // 还是被占着就继续往右让，一次 8px，最多 400px；实在没地方就留在原位
              // （宁可挤一点，也不要整组按钮消失）。
              if (!spotFree(left, top)) {
                var limit = Math.round(left + 400)
                var shifted = left + 8
                while (shifted <= limit && !spotFree(shifted, top)) shifted += 8
                if (shifted <= limit) left = shifted
              }
            } finally {
              if (own !== null) own.style.pointerEvents = pointerEvents === null ? '' : pointerEvents
            }
            setPos(function (previous) {
              if (previous !== null && previous.left === left && previous.top === top) return previous
              return { left: left, top: top }
            })
          } catch (ignored) {
            // 位置量不到就先不渲染，下一次事件会再试
          }
        }

        function schedule() {
          if (!frame) frame = window.requestAnimationFrame(measure)
          window.clearTimeout(timer)
          // 侧栏展开/收起有 150ms 动画，动画结束后再补量一次
          timer = window.setTimeout(measure, 300)
        }

        schedule()
        window.addEventListener('resize', schedule)
        document.addEventListener('click', schedule, true)
        document.addEventListener('transitionend', schedule, true)
        window.addEventListener('keydown', schedule, true)
        return function () {
          if (frame) window.cancelAnimationFrame(frame)
          window.clearTimeout(timer)
          window.removeEventListener('resize', schedule)
          document.removeEventListener('click', schedule, true)
          document.removeEventListener('transitionend', schedule, true)
          window.removeEventListener('keydown', schedule, true)
        }
      }, [])

      // 确认框打开时：点外面或按 Esc 关掉。
      useEffect(function () {
        if (!open) return undefined
        function onDown(event) {
          try {
            var node = event.target
            while (node) {
              if (node.getAttribute && node.getAttribute('data-dsh-refresh-restart-popover') === 'true') return
              node = node.parentNode
            }
            setOpen(false)
          } catch (ignored) {
            setOpen(false)
          }
        }
        function onKey(event) {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      function doRefresh() {
        try {
          window.location.reload()
        } catch (ignored) {
          // 刷新失败什么也不用做，页面还在
        }
      }

      function doRestart() {
        if (busy) return
        setBusy(true)
        setError('')
        fetch(ROUTE + '/status', { headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('宿主没有响应（HTTP ' + response.status + '）')
            return response.json()
          })
          .then(function (status) {
            if (!status || typeof status.token !== 'string') throw new Error('拿不到重启授权，请先重启一次 DSH')
            if (status.canRestart === false) {
              throw new Error(typeof status.reason === 'string' && status.reason !== '' ? status.reason : ERROR_TEXT.unsupported)
            }
            return fetch(ROUTE + '/restart', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-dsh-refresh-restart-key': status.token,
              },
              body: '{}',
            })
          })
          .then(function (response) {
            return response.json().then(function (body) {
              return { response: response, body: body }
            })
          })
          .then(function (result) {
            if (!result.response.ok || !result.body || result.body.ok !== true) {
              var failure = (result.body && result.body.error) || null
              var text = failure ? ERROR_TEXT[failure.code] : ''
              if (!text && failure && failure.message) text = failure.message
              if (!text) text = '重启请求被拒绝（HTTP ' + result.response.status + '）'
              throw new Error(text)
            }
            // 助手已启动，窗口马上会消失 —— 保持 busy，不再改状态。
          })
          .catch(function (failure) {
            setBusy(false)
            setError(failure && failure.message ? failure.message : String(failure))
          })
      }

      if (pos === null) return null

      return h(
        'div',
        {
          'data-dsh-refresh-restart': 'true',
          ref: ownRef,
          style: {
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            display: 'flex',
            alignItems: 'center',
            gap: GAP,
            pointerEvents: 'auto',
            zIndex: 100,
          },
        },
        h(IconButton, { label: TEXT.refreshTitle, tip: '刷新', onClick: doRefresh }, REFRESH_ICON),
        h(
          'div',
          { style: { position: 'relative', display: 'inline-flex' } },
          h(
            IconButton,
            {
              label: TEXT.restartTitle,
              tip: '重启',
              disabled: busy,
              onClick: function () {
                setError('')
                setOpen(!open)
              },
            },
            RESTART_ICON,
          ),
          open
            ? h(
                'div',
                { style: POPOVER_STYLE, role: 'dialog', 'aria-label': TEXT.confirmTitle, 'data-dsh-refresh-restart-popover': 'true' },
                h('div', { style: { fontWeight: 600, marginBottom: 4, color: 'var(--dsw-alias-label-primary)' } }, TEXT.confirmTitle),
                h('div', { style: { color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 } }, TEXT.confirmBody),
                busy
                  ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 } }, TEXT.restarting)
                  : null,
                error
                  ? h(
                      'div',
                      { style: { color: 'var(--dsw-alias-state-error-primary)', marginBottom: 10, wordBreak: 'break-word' } },
                      error,
                    )
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
                  h(ActionButton, { disabled: busy, onClick: function () { setOpen(false) } }, TEXT.cancel),
                  h(ActionButton, { primary: true, disabled: busy, onClick: doRestart }, TEXT.confirm),
                ),
              )
            : null,
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 插件
     * ------------------------------------------------------------------ */

    /** 拿到 slots 服务：先试 `ctx.slots` 属性，再退回 `ctx.get('slots')`。 */
    function resolveSlots(ctx) {
      try {
        if (ctx && ctx.slots && typeof ctx.slots.register === 'function') return ctx.slots
      } catch (ignored) {
        // 属性访问抛错就往下试
      }
      try {
        if (ctx && typeof ctx.get === 'function') {
          var viaGet = ctx.get('slots')
          if (viaGet && typeof viaGet.register === 'function') return viaGet
        }
      } catch (ignored) {
        // 两种都拿不到就放弃
      }
      return null
    }

    function apply(ctx) {
      var slots = resolveSlots(ctx)
      if (slots === null) {
        console.warn('[dsh-refresh-restart] the client has no slots service; nothing to render')
        return
      }

      function register() {
        return slots.register(
          { name: 'shell.overlay', id: 'dsh-refresh-restart', order: 15, registrant: 'dsh-refresh-restart' },
          Controls,
        )
      }

      function mount() {
        try {
          if (typeof slots.inject === 'function') slots.inject('shell.overlay', register)
          else register()
        } catch (error) {
          console.warn('[dsh-refresh-restart] failed to register the quick actions overlay', error)
        }
      }

      // 宿主持有 effect 就用它登记清理函数，否则直接挂载。
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            try {
              if (typeof slots.remove === 'function') slots.remove('shell.overlay', 'dsh-refresh-restart')
            } catch (ignored) {
              // 宿主不允许移除时忽略
            }
          }, 'dsh-refresh-restart: overlay')
          ctx.effect(mount, 'dsh-refresh-restart: overlay mount')
          return
        }
      } catch (error) {
        console.warn('[dsh-refresh-restart] ctx.effect unavailable, mounting directly', error)
      }
      mount()
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
