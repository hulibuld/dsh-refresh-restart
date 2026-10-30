/**
 * dsh-refresh-restart — client half.
 *
 * 手写浏览器模块（没有构建步骤）：React 来自页面自己的模块表，插件只注册一个
 * `shell.overlay` 槽组件。按钮怎么摆分两种情况：
 *   · macOS 桌面端：「收起侧边栏」躺在侧栏顶部那条 52px 高的标题栏里，插件把按钮
 *     直接插进同一条 flex 行，位置由布局自己排 —— 侧栏展开/收起、窗口拉宽拉窄都
 *     跟着走，不用算坐标，也就不会漂。侧栏收成 56px 图标栏时那条带子塞不下，整组
 *     藏起来。
 *   · 其它环境：没有这条带子（Windows 的收起按钮固定在标题栏左侧），退回固定定位，
 *     挂载时和窗口变化时重新量。
 * 两种情况都在渲染前算好，渲染路径上不抛错。
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
    // 侧栏标题栏窄于这个值就算「收成了图标栏」：两个按钮塞不下，整组隐藏。
    var MIN_STRIP = 132

    // 插进侧栏标题栏要靠 portal。页面模块表里有 react-dom（宿主自己也用），
    // 拿不到就退化成固定定位那套，功能不受影响。
    var reactDom = null
    try {
      reactDom = require('react-dom')
    } catch (ignored) {
      reactDom = null
    }
    var createPortal = reactDom && typeof reactDom.createPortal === 'function' ? reactDom.createPortal : null

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */

    var TEXT = {
      refreshTitle: '刷新界面（正在生成的回答不会中断）',
      restartTitle: '重启 DeepSeek Harness',
      confirmTitle: '重启 DeepSeek Harness？',
      confirmBody: '界面会先关闭，几秒后自动重新打开。没发送出去的输入会丢失。',
      confirmHint: '如果 DSH 弹出「关闭应用会中断当前正在进行的任务」，点「取消」就只是取消这次重启，不会关掉应用。',
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

    /** 重启取消 / 失败时给人看的提示（按助手写的进度挑一句）。 */
    var STATE_TEXT = {
      cancelled: '已取消重启：应用没有关闭，一切照常',
      'quit-failed': '退出请求被系统拒绝，本次没有重启',
      'launch-failed': '应用已关闭，但没能自动重新打开，请手动启动',
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
      // 插进侧栏标题栏时用的容器（React 渲染到这上面）。为 null 说明在用固定定位。
      var hostState = useState(null)
      var host = hostState[0]
      var setHost = hostState[1]
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
      // 重启按钮外面那层：确认框要贴着它定位。
      var anchorRef = useRef(null)
      // 卸载后停掉状态轮询，避免对已经消失的组件 setState
      var unmountRef = useRef({ current: false })

      // 摆位置。两种摆法：插进侧栏标题栏（跟着布局走），或退回固定定位（自己算坐标）。
      // 渲染路径上不允许抛错，整段包在 try 里。
      useEffect(function () {
        var frame = 0
        var timer = 0
        var mode = 'none' // 'none' | 'strip' | 'fixed'
        var stripNode = null
        var stripHost = null
        var stripObserver = null
        var stripWatcher = null
        var alive = true

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

        // 「收起侧边栏」按钮本身。要跳过我们自己插进去的那两个，否则量着量着会量到自己身上。
        function findToggle() {
          try {
            var groups = [
              document.querySelectorAll('[class*="topStrip"] button'),
              document.querySelectorAll('button[class*="toggle"]'),
            ]
            for (var g = 0; g < groups.length; g += 1) {
              var list = groups[g]
              for (var i = 0; i < list.length; i += 1) {
                if (!isOurs(list[i])) return list[i]
              }
            }
            return null
          } catch (ignored) {
            return null
          }
        }

        // 那个按钮外面若是侧栏顶部的标题栏，返回它；Windows 上没有这条带子，返回 null。
        function stripOf(toggle) {
          try {
            var parent = toggle.parentNode
            if (!parent || parent.nodeType !== 1) return null
            var cls = parent.getAttribute('class') || ''
            return cls.indexOf('topStrip') >= 0 ? parent : null
          } catch (ignored) {
            return null
          }
        }

        // 侧栏收成 56px 图标栏时标题栏只剩一条缝，塞不下两个按钮：整组藏起来，
        // 展开回来再显示（ResizeObserver 会再叫一次）。
        function fitStrip() {
          if (stripHost === null || stripNode === null) return
          try {
            stripHost.style.display = stripNode.clientWidth >= MIN_STRIP ? 'inline-flex' : 'none'
          } catch (ignored) {
            // 量不到就保持现状
          }
        }

        function clearStrip() {
          if (stripObserver !== null) {
            try {
              stripObserver.disconnect()
            } catch (ignored) {}
            stripObserver = null
          }
          if (stripWatcher !== null) {
            try {
              stripWatcher.disconnect()
            } catch (ignored) {}
            stripWatcher = null
          }
          if (stripHost !== null && stripHost.parentNode) {
            try {
              stripHost.parentNode.removeChild(stripHost)
            } catch (ignored) {}
          }
          stripHost = null
          stripNode = null
          if (mode === 'strip') {
            mode = 'none'
            if (alive) setHost(null)
          }
        }

        // 标题栏平时是右对齐（flex-end），全屏时改成左对齐（flex-start）。右对齐时我们插在
        // 收起按钮前面就落在它左边；左对齐时要插在它后面，否则会把官方那个按钮顶到右边去。
        function placeHost(strip, toggle) {
          if (stripHost === null) return
          try {
            var justify = ''
            try {
              var computed = window.getComputedStyle ? window.getComputedStyle(strip) : null
              justify = computed && computed.justifyContent ? computed.justifyContent : ''
            } catch (ignoredStyle) {
              justify = ''
            }
            // 不同内核把「从左边开始排」报成 flex-start / start / left 都见过，都算左对齐
            var leftAligned = justify === 'flex-start' || justify === 'start' || justify === 'left'
            if (leftAligned) {
              if (stripHost.previousSibling !== toggle) strip.insertBefore(stripHost, toggle.nextSibling)
            } else if (stripHost.nextSibling !== toggle) {
              strip.insertBefore(stripHost, toggle)
            }
          } catch (ignored) {}
        }

        function mountStrip(strip, toggle) {
          if (mode === 'strip' && stripNode === strip && stripHost !== null) {
            fitStrip()
            return
          }
          clearStrip()
          stripHost = document.createElement('div')
          stripHost.setAttribute('data-dsh-refresh-restart', 'true')
          stripHost.style.cssText =
            'display:inline-flex;align-items:center;gap:' + GAP + 'px;flex:none;margin:0 4px 0 0;pointer-events:auto'
          try {
            strip.insertBefore(stripHost, toggle)
          } catch (ignored) {
            try {
              strip.appendChild(stripHost)
            } catch (ignoredAgain) {}
          }
          placeHost(strip, toggle)
          stripNode = strip
          mode = 'strip'
          fitStrip()
          if (typeof ResizeObserver === 'function') {
            try {
              stripObserver = new ResizeObserver(fitStrip)
              stripObserver.observe(strip)
            } catch (ignored) {}
          }
          // 侧栏折叠/展开时 React 会重建那一列，我们的容器可能被挤掉：盯着，掉了就插回去。
          if (typeof MutationObserver === 'function') {
            try {
              stripWatcher = new MutationObserver(function () {
                if (stripHost === null || stripNode === null) return
                var live = findToggle()
                if (stripHost.parentNode !== stripNode) {
                  try {
                    if (live && live.parentNode === stripNode) stripNode.insertBefore(stripHost, live)
                    else stripNode.appendChild(stripHost)
                  } catch (ignored) {}
                }
                if (live !== null && live.parentNode === stripNode) placeHost(stripNode, live)
                fitStrip()
              })
              stripWatcher.observe(strip, { childList: true })
            } catch (ignored) {}
          }
          // 插进标题栏就不再用固定坐标，把旧坐标清掉
          if (alive) {
            setPos(null)
            setHost(stripHost)
          }
        }

        function measureFixed(toggle) {
          try {
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
            if (!alive) return
            setPos(function (previous) {
              if (previous !== null && previous.left === left && previous.top === top) return previous
              return { left: left, top: top }
            })
          } catch (ignored) {
            // 位置量不到就先不渲染，下一次事件会再试
          }
        }

        function sync() {
          frame = 0
          if (!alive) return
          var toggle = findToggle()
          if (toggle === null) {
            if (mode === 'strip') clearStrip()
            return
          }
          var strip = stripOf(toggle)
          if (strip !== null && createPortal !== null) {
            mountStrip(strip, toggle)
            return
          }
          if (mode === 'strip') clearStrip()
          mode = 'fixed'
          measureFixed(toggle)
        }

        function schedule() {
          if (!alive) return
          if (!frame) frame = window.requestAnimationFrame(sync)
          window.clearTimeout(timer)
          // 侧栏展开/收起有 150ms 动画，动画结束后再补量一次
          timer = window.setTimeout(sync, 300)
        }

        schedule()
        window.addEventListener('resize', schedule)
        document.addEventListener('click', schedule, true)
        document.addEventListener('transitionend', schedule, true)
        window.addEventListener('keydown', schedule, true)
        return function () {
          alive = false
          if (frame) window.cancelAnimationFrame(frame)
          window.clearTimeout(timer)
          window.removeEventListener('resize', schedule)
          document.removeEventListener('click', schedule, true)
          document.removeEventListener('transitionend', schedule, true)
          window.removeEventListener('keydown', schedule, true)
          clearStrip()
        }
      }, [])

      // 卸载时停掉状态轮询（组件被换掉的情况下不该再 setState）
      useEffect(function () {
        return function () {
          if (unmountRef.current) unmountRef.current.current = false
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

      // 点完重启之后盯进度：助手写 phase，界面据此把「正在重启」收尾。
      // 超时就当没结果处理，绝不让按钮永远转圈。
      function watchState() {
        var startedAt = Date.now()
        var misses = 0
        var mounted = { current: true }
        unmountRef.current = mounted

        function finish(text) {
          mounted.current = false
          if (text) {
            setBusy(false)
            setError(text)
          }
        }

        function tick() {
          if (!mounted.current) return
          if (Date.now() - startedAt > 60000) {
            finish('等不到重启结果，请刷新页面看看应用还在不在')
            return
          }
          fetch(ROUTE + '/state', { headers: { accept: 'application/json' } })
            .then(function (response) {
              if (!response.ok) throw new Error('state ' + response.status)
              return response.json()
            })
            .then(function (body) {
              if (!mounted.current) return
              misses = 0
              var state = body && body.state ? body.state : null
              var phase = state && typeof state.phase === 'string' ? state.phase : 'idle'
              if (phase === 'cancelled' || phase === 'quit-failed') {
                finish(STATE_TEXT[phase] || '重启已取消')
                return
              }
              if (phase === 'launch-failed') {
                finish(STATE_TEXT[phase])
                return
              }
              if (phase === 'relaunched') {
                // 页面马上就要被新窗口顶掉，保持 busy 即可
                mounted.current = false
                return
              }
              window.setTimeout(tick, 700)
            })
            .catch(function () {
              // 宿主正在退出时请求会失败，这是正常的，继续等。
              // 但连续失败太多次说明这个宿主还没有 /state 路由（旧版本），
              // 那就别再打扰它，按老样子「窗口马上会关」处理。
              misses += 1
              if (misses >= 4) {
                mounted.current = false
                return
              }
              if (mounted.current) window.setTimeout(tick, 700)
            })
        }

        window.setTimeout(tick, 800)
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
            // 助手接单了。但「接单」不等于「关掉了」：DSH 自己会弹
            // 「关闭应用会中断当前正在进行的任务」，用户可能点取消。
            // 所以接下来轮询助手写的进度，取消就把按钮松开、给一句人话。
            watchState()
          })
          .catch(function (failure) {
            setBusy(false)
            setError(failure && failure.message ? failure.message : String(failure))
          })
      }

      // 确认框：插进标题栏时那一列会裁掉 absolute 溢出，改成按按钮位置定死在视口上。
      function popoverStyle() {
        if (host === null) return POPOVER_STYLE
        var anchor = anchorRef.current
        var rect = anchor === null ? null : anchor.getBoundingClientRect()
        if (!rect) return POPOVER_STYLE
        var width = 260
        var viewport = typeof window === 'undefined' ? 1280 : window.innerWidth
        var room = Math.max(8, viewport - width - 8)
        var left = Math.min(Math.max(8, Math.round(rect.right - width)), room)
        var style = {}
        for (var key in POPOVER_STYLE) {
          if (Object.prototype.hasOwnProperty.call(POPOVER_STYLE, key)) style[key] = POPOVER_STYLE[key]
        }
        style.position = 'fixed'
        style.left = left
        style.top = Math.round(rect.bottom + 8)
        style.zIndex = 140
        return style
      }

      var pair = [
        h(IconButton, { label: TEXT.refreshTitle, tip: '刷新', onClick: doRefresh }, REFRESH_ICON),
        h(
          'div',
          { ref: anchorRef, style: { position: 'relative', display: 'inline-flex' } },
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
                { style: popoverStyle(), role: 'dialog', 'aria-label': TEXT.confirmTitle, 'data-dsh-refresh-restart-popover': 'true' },
                h('div', { style: { fontWeight: 600, marginBottom: 4, color: 'var(--dsw-alias-label-primary)' } }, TEXT.confirmTitle),
                h('div', { style: { color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 } }, TEXT.confirmBody),
                h(
                  'div',
                  { style: { color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))', fontSize: 11, marginBottom: 10 } },
                  TEXT.confirmHint,
                ),
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
      ]

      // 插进侧栏标题栏：位置交给 flex 排，侧栏展开/收起、窗口缩放都跟着走。
      if (host !== null && createPortal !== null) {
        return createPortal(
          h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: GAP, pointerEvents: 'auto' } }, pair),
          host,
        )
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
        pair,
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
