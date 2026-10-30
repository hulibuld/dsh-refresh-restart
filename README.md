# dsh-refresh-restart

给 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面界面左上角加两个小按钮：**刷新界面** 和 **重启应用**。位置跟着「收起侧边栏」按钮走，展开 / 收起侧栏、改窗口大小、全屏都不会跑偏。

An unofficial DSH plugin that puts **reload** and **restart** buttons next to the sidebar toggle in the top-left corner of the DeepSeek Harness desktop UI.

[![test](https://github.com/hulibuld/dsh-refresh-restart/actions/workflows/test.yml/badge.svg)](https://github.com/hulibuld/dsh-refresh-restart/actions/workflows/test.yml)

## 兼容性

| 运行方式 | 刷新界面 | 重启应用 |
| --- | --- | --- |
| macOS 桌面版 | ✅ | ✅ |
| Windows 桌面版 | ✅ | ✅（`CloseMainWindow` 退出 + PowerShell 助手重开） |
| Linux 桌面版 | ✅ | ✅（`SIGTERM` 退出 + 重开 AppImage / 可执行文件） |
| 浏览器（`dsh web`） | ✅ | ⛔ 只能手动重启 |

「刷新」是纯页面操作，在任何能跑 DSH 界面的环境都成立。「重启」需要从操作系统层重开整个应用：插件会生成一个脱离宿主的小助手，先请应用自己退出，等进程真的消失（必要时升级到强杀），再把同一个应用重新打开。三个桌面平台的退出 / 重开命令不同，都已实现；识别不到应用路径时按钮会给出明确提示，不会静默失败。

## 为什么需要它

- 改插件（`client.js` 这类界面代码）后要刷新页面才能看到效果，而 `⌘R` 在焦点落在输入框时不一定生效，也不方便。
- 新增 / 删除插件必须重启整个应用（插件清单只在启动时读取），菜单里的「重启应用与 Host」藏得比较深。

两个动作各给一个按钮，重启还带二次确认，避免误点丢掉没发出去的输入。

## 安装

### 方式零：一行命令（已发布 Release 后可用）

```bash
# 走 npm（推荐，永远拿最新版）
dsh plugin add dsh-refresh-restart

# 或者装 GitHub Release 里预打包的 tgz（不需要 Node 构建，不会触发 allowBuilds 询问）
dsh plugin add https://github.com/hulibuld/dsh-refresh-restart/releases/download/v0.2.1/dsh-refresh-restart-0.2.1.tgz
```

装完重启 DSH，左上角就出现两个按钮。

### 方式一：插件市场 / 插件管理器

如果 DSH 装了插件市场，搜索 `dsh-refresh-restart` 安装即可。

### 方式二：手动装到 profile

```bash
git clone https://github.com/hulibuld/dsh-refresh-restart.git
cd dsh-refresh-restart
```

然后装进某个 profile（下面用 `<profile>` 代指，比如 `desktop`）：

1. 建软链：把仓库目录链到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-refresh-restart`。
2. 在 `<DSH_HOME>/profiles/<profile>/package.json` 的 `dependencies` 里加 `"dsh-refresh-restart": "link:<仓库绝对路径>"`。
3. 在同一个文件的 `dsh.profile.bundles`（数组）里加上 `"dsh-refresh-restart"`。
4. 重启 DSH。按钮出现在左上角；没出现就刷一次新页面。

> 不要在这里跑 `pnpm add <本插件>` 或 `pnpm install`：它们会重解析整棵依赖树。手动加软链 + 上面三行声明最稳。

卸载：删掉第 1–3 步加的东西，重启 DSH。

## 使用

- **刷新**（↻）：等于按一次 `⌘R`。只重新加载界面那一层，宿主里的生成任务照常跑，**正在生成的回答不会中断**；插件改动能立刻生效。会丢的是输入框里还没发送的草稿、滚动位置。
- **重启**（⏻）：弹确认框 → 窗口关闭 → 几秒后自动重新打开。会话、工作区都在，等同于菜单里的「重启应用与 Host」。
- **取消关闭就是取消重启**：如果此时有任务在跑，DSH 会再弹一个「关闭应用会中断当前正在进行的任务」。在那里点「取消」，本次重启就作废——助手不会再强杀、更不会重开，界面收到「已取消重启」的提示后恢复正常。

| 操作 | 宿主（后台生成） | 界面 |
| --- | --- | --- |
| 刷新 | 不受影响 | 重载，重新接上会话 |
| 重启 | 结束并重新启动 | 关闭再打开 |
| 关窗口 | 视配置而定 | 消失 |

真正会打断回答的只有重启、点「停止」、宿主崩溃；刷新不会。

## 配置

`cordis.patch.yml` 里可调（也可以写在 profile 的插件配置里）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `quitTimeoutMs` | `20000` | 等应用自己退出的上限。超时按「用户取消了」处理，不强杀 |
| `openDelayMs` | `800` | 确认进程消失后，隔多久重新打开 |
| `appPath` | 空 | 留空自动推断：macOS 找 `.app`，Windows 用 exe 路径，Linux 优先 `APPIMAGE`；换过安装位置或绿色版时填绝对路径 |
| `forceKill` | `false` | 超时后是否强杀应用。默认关闭；只有确实卡死、且你能接受丢草稿时才打开 |

## 实现方式

纯本地、零运行时依赖、无构建步骤：

```
index.js           宿主半边：导出 Config + apply，注册 status / restart 两个路由
client.js          浏览器半边：手写 __ModuleLoader__ 模块，注册 shell.overlay 槽组件
lib/platform.js    平台识别：判断能不能重启，生成「退出 + 重开」计划与助手脚本源码
lib/restart.js     重启服务：持有 token、把助手写进临时目录并 detached 拉起
lib/routes.js      路由封装：方法校验、仅 loopback、action token、JSON 响应
cordis.patch.yml   bundle 补丁：把插件插进宿主
test/              node --test 回归测试（纯函数 + 路由守卫）
```

重启为什么这么绕：桌面版是 Electron 应用，宿主只是它的子进程。只杀宿主，窗口还在但没人管，界面就废了。所以必须由**脱离宿主**的助手先请应用退出，**确认进程真的消失之后**才重新打开：

| 平台 | 退出 | 重开 |
| --- | --- | --- |
| macOS | `osascript … quit`（走正常 `before-quit`） | `open -a 应用.app` |
| Windows | PowerShell `CloseMainWindow` | 借 Explorer 拉起 exe（见下节） |
| Linux | `SIGTERM` | 重开 `APPIMAGE` 或可执行文件 |

**等不到退出就放弃，绝不「补一刀」。** 应用的退出要经过它自己的 `before-quit`，有任务在跑时 DSH 会弹窗问一句；用户点取消，进程就继续活着。这时再强杀、再重开，等于新旧两个实例抢同一个端口，界面必崩——0.2.1 之前就是这样崩的，0.2.2 把强杀从默认路径里拿掉了（真要强杀得显式打开 `forceKill`）。助手每一步都写进状态文件，界面轮询它：`requested → quitting → cancelled / relaunched`，取消时按钮立刻松开并给出提示，不会一直转圈。

macOS / Linux 的助手是一段 CommonJS，用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 执行——借 Electron 自带的 Node，用户不用另装 Node。进程匹配在 macOS 上限定在当前 `.app` 的 `Contents/` 前缀内，不会误杀别的进程。

Windows 不能用同一条路。桌面版的主进程是 Chromium 起的，整棵进程树都在一个带 kill-on-close 的 job object 里：从树里 spawn 出来的 `detached` 助手会跟着应用一起被回收，结果是**只关不开**（0.2.2 的真实症状）。所以 Windows 上改用 PowerShell 助手（`lib/win-helper.ps1`），先写一个 `.lnk` 快捷方式，再让 `explorer.exe` 去执行它——Explorer 在 job object 之外，由它创建的进程才能活过这次关停，把应用拉回来。助手报到后会写一个 boot 文件，宿主据此确认交接真的发生了；没报到就退回直接 spawn，再不行就如实报错，不假装成功。

**重开时会把 `ELECTRON_*`、`NODE_OPTIONS`、`NODE_PATH` 从环境里摘掉。** 这不是洁癖：助手自己带着 `ELECTRON_RUN_AS_NODE=1`（否则它跑不起来），而 macOS 的 `open` 会把调用者的环境原样交给新启动的应用。带着这个开关，Electron 会按纯 Node 模式启动——进程列表里看得到，窗口永远不出来，用户看到的就是「关掉了、再也没打开」。这正是 0.1.1 修掉的真实 bug。重开之后助手还会确认渲染进程（`--type=renderer`）真的出现，否则按 bundle id 再 `open` 一次，并在日志里写明。

按钮挂在 `shell.overlay` 槽里，具体摆法分两种：

- **macOS 桌面端**：`收起侧边栏` 躺在侧栏顶部那条 52px 高的标题栏（`topStrip`）里。插件把自己的两个按钮**直接插进同一条 flex 行**（平时插在收起按钮左边，全屏时插在它右边），位置由布局自己排——侧栏展开、收起、窗口拉宽拉窄、切全屏都跟着走，插件一个坐标都不算，所以不会漂。侧栏收成 56px 图标栏时那条带子塞不下两个按钮，整组自动隐藏；展开回来立刻出现。
- **其它环境**（Windows 桌面版没有这条带子，收起按钮固定在标题栏左侧）：退回 `position: fixed`，每次挂载、窗口尺寸变化、点击、`transitionend` 都重新量一次坐标。

鼠标悬停时按钮下方出现「刷新」「重启」两个小提示框。

Windows 桌面版的标题栏左侧还有系统自己的「应用」「编辑」两个菜单按钮（由桌面端 preload 注入的 `div[data-windows-menu]`，不是页面组件）。这两个按钮和本插件的两个按钮会抢同一块地方，所以渲染前会先读它们的外框：**被占着就整组往右让到它们右边，没占着就照原样**贴在「收起侧边栏」左边。让位是纯几何判断，不隐藏、不接管、不重排系统按钮——就算未来源码结构变了，最坏也只是退化成「两个按钮挨得近一点」，不会让系统菜单消失。

## 安全与隐私

- 只注册 `127.0.0.1` 上的路由；校验 `Host` 头，挡住 DNS rebinding。
- 重启是 POST，必须带 `status` 响应里的随机 token（`x-dsh-refresh-restart-key` 头），跨站 `Origin` 一律拒绝。
- 助手脚本写在临时目录，权限 `0700`，只做「退出、等待、必要时强杀、重开」。
- **不联网、不收集任何数据、不读会话内容**；插件只用 `process.execPath`、`process.platform` 这些运行时事实。

## 开发

```bash
node --test test/        # 或 npm test
```

测试覆盖：配置收敛、三平台的应用识别与重启计划（含 Windows 绿色版、Linux AppImage 分支）、助手脚本的语法与内嵌计划、**环境变量不泄漏到新应用（端到端：真跑一遍助手，检查子进程 `env`）**、loopback/DNS-rebinding 判定、token 比较、路由的方法校验 / 403 / 409 / 501 分支、注销只释放一次。

macOS（本机）与 Windows / Linux 桌面版都已在真机点过按钮（Windows 0.2.1 可关可开，0.2.2 起改走 Explorer 交接）。取消保护另有一条端到端用例：造一个「不肯退出」的进程，验证助手只写 `cancelled`、不发信号、不重开。

## 排障

- **按钮没出现**：插件清单只在启动时读取。确认 profile `package.json` 的 `dsh.profile.bundles` 里有 `dsh-refresh-restart`，然后重启应用。
- **窗口关了没回来**：先看 `%TEMP%\dsh-refresh-restart-<时间>.log`，里面会写 `relaunching through explorer`，成功是 `relaunched ok, new pid=…`，失败是 `relaunch failed: no new process appeared`（助手此时会在界面上报「重启失败」而不是继续转圈）。如果日志停在 `helper start`，说明助手被安全软件拦下了，把 DSH 加入白名单再试。macOS / Linux 的助手日志在系统临时目录，文件名 `dsh-refresh-restart-<时间>.log`（macOS 在 `$TMPDIR`，Windows 在 `%TEMP%`）。里面按顺序记了退出、等待、信号、重开每一步。0.1.1 之前的版本会因为 `ELECTRON_RUN_AS_NODE` 泄漏而重开出「没有窗口的空壳」，日志表现为 `launched=true` 但应用不出现——升级后日志会写 `应用已重新打开` 或 `进程已启动但没有窗口`。
- **点重启后弹「关闭应用会中断当前正在进行的任务」**：点「取消」即可，本次重启会作废，应用不受影响；想重启就先等任务结束。
- **提示「已取消重启」**：同上，说明应用没关成，一切照常。如果反复出现、且你确实想强杀，把配置里的 `forceKill` 改成 `true`。
- **提示「没找到应用位置」**：自动推断失败，把 `appPath` 配上绝对路径（macOS 填 `.app`，Windows 填 exe，Linux 填 AppImage）。

## Roadmap

- 浏览器 / CLI 模式重启（脱离进程重跑 `process.argv`，需要处理端口与页面重连）
- 英文界面（当前文案内联中文，`TEXT` / `ERROR_TEXT` 两处即可抽出）
- 自定义位置与紧凑模式
- Windows 上可选「把系统菜单融进本行」（默认不做，见上）

欢迎 PR。改 `lib/` 后跑一遍 `npm test`；改 `client.js` 后刷新页面即可看到效果。

## License

MIT
