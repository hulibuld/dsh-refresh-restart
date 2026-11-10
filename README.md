# dsh-refresh-restart

[![npm](https://img.shields.io/npm/v/dsh-refresh-restart)](https://www.npmjs.com/package/dsh-refresh-restart)
[![月下载](https://img.shields.io/npm/dm/dsh-refresh-restart)](https://www.npmjs.com/package/dsh-refresh-restart)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-blue)](https://github.com/hulibuld/dsh-refresh-restart)
[![License](https://img.shields.io/npm/l/dsh-refresh-restart)](LICENSE)

`dsh plugin --profile desktop add dsh-refresh-restart` · [遇到问题开 issue](https://github.com/hulibuld/dsh-refresh-restart/issues/new/choose)

给 DeepSeek 桌面界面左上角加两个按钮：刷新界面、重启应用。位置跟着「收起侧边栏」走，展开收起、改窗口大小、切全屏都不跑偏。

## 装

```
dsh plugin --profile desktop add dsh-refresh-restart
```

装完重启 DSH，左上角就多两个按钮。插件市场里搜 `dsh-refresh-restart` 也能装。

本地开发版本请通过 DSH 的插件管理工具安装仓库目录或打包后的 tarball，替换同名 bundle；不要手动改 profile 依赖或 patch。此 fork 的 Windows 修复已于 2026-11-10 在一台 Windows / DSH Desktop 0.2.2-rc.1 上完成用户确认的真实重启：用户反馈自动重开成功、火绒未拦截，助手状态为 `relaunched`，重开后的宿主路由正常响应。这是一次本机验证，不是所有系统或安全软件的兼容性保证。

## 两个按钮

刷新等于按一次 `⌘R`。只重载界面那一层，宿主里的生成任务照常跑，正在生成的回答不会中断。会丢的是输入框里还没发的草稿和滚动位置。

重启先弹插件确认框。Windows 实验修复的设计流程是：独立助手就绪后短暂打开原生「应用」菜单，由 Windows UI Automation 调用属于该 DSH 主进程的 Chromium Views「退出」项，不需要你额外点菜单；DSH 自身仍负责正在运行任务的退出确认和清理。助手只在旧应用进程确实退出后发起一次重开，不把隐藏到托盘当成退出。本机已完成一次真实退出并自动重开的用户验证；菜单发现测试本身仍只识别、不执行退出，不能代替端到端测试。

关窗口的时候如果还有任务在跑，DSH 会再问一句。在那里点取消，这次重启就作废，助手不强杀也不重开，界面会告诉你已取消。

| 操作 | 后台生成 | 界面 |
| --- | --- | --- |
| 刷新 | 不受影响 | 重载，重新接上会话 |
| 重启 | 结束并重新启动 | 关闭再打开 |

真正会打断回答的只有重启、点停止、宿主崩溃。刷新不会。

## 兼容性

macOS、Windows、Linux 的桌面版，刷新和重启都能用。浏览器里跑 `dsh web` 只能刷新，重启得自己手动来。

三个平台的退出与重开命令不一样。Windows 修复要求 PowerShell 7、已运行的 Explorer 桌面以及可识别的 DSH 原生应用菜单（当前仅匹配英文 Exit / 中文退出）。不能识别菜单或辅助功能接口不可用时停止操作，不回退到关窗口、盲发按键或强杀。不会自动安装 PowerShell，也不会修改脚本执行策略。

## 配置

`cordis.patch.yml` 里可调，也可以写在 profile 的插件配置里。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `quitTimeoutMs` | `20000` | 等应用退出的上限；Windows 检测到原生确认对话框时延长等待，不强杀 |
| `openDelayMs` | `800` | 确认进程消失后隔多久重开 |
| `appPath` | 空 | 留空自动推断；换过安装位置或绿色版填绝对路径 |
| `forceKill` | `false` | macOS / Linux 的超时强杀选项；Windows 修复版忽略此项，始终不强杀 |

## 排障

按钮没出现，先确认 profile 的 `dsh.profile.bundles` 里有插件名，然后重启。插件清单只在启动时读一次。

窗口关了没回来，去临时目录看 `dsh-refresh-restart-<时间>-<随机标识>.log`。Windows 修复不再生成或执行临时 `.lnk`，但这不等于保证通过所有安全软件；若仍被拦截，请记录具体告警，勿关闭防护、添加白名单或绕过执行策略。助手启动回执只证明启动，不能证明脱离 DSH 的 Job 或完整重启成功。新进程出现也不代表新窗口或 GUI 已经就绪。

提示没找到应用位置，把 `appPath` 配上绝对路径。macOS 填 `.app`，Windows 填 exe，Linux 填 AppImage。

DSH 弹出任务退出确认时，点取消会保留应用和任务；助手随后超时结束，不重开第二个实例。若应用退出清理耗时超过 `quitTimeoutMs`，助手可能已停止等待，请检查日志，必要时手动打开应用。不要通过强杀跳过任务确认。

## 安全

只注册 `127.0.0.1` 上的路由，校验 `Host` 头，挡 DNS rebinding。重启是 POST，要带 `status` 响应里的随机 token，跨站 `Origin` 一律拒绝。助手脚本写在临时目录，权限 `0700`。不联网，不收集数据，不读会话内容。

## 开发

```
node --test "test/*.test.js"
```

Windows 专项测试均显式选择启用，默认测试不会操作 DSH：

- `DSH_TEST_EXPLORER_HANDOFF=1`：现有 Explorer 交接无害脚本，查询 Job 状态；任意 Job 成员身份不能判断是否仍属于 DSH 的 Job。
- `DSH_TEST_NATIVE_MENU=1`：隔离 WinForms 原生菜单必须被 Views 专用识别器拒绝，不执行退出。仅该旧 WinForms 测试窗口显式使用 Windows PowerShell 5.1。
- `DSH_TEST_MENU_DISCOVERY=1` 并设置 `DSH_TEST_APP_EXE`：仅展开实际 DSH 的「应用」菜单并运行生产识别函数，**不会调用退出**。需要用户允许该诊断交互；不能将其当作端到端重启验证。

## 已知问题与修复记录

累计的修复、现象、原因与修法记在 [docs/FIXES.md](docs/FIXES.md)。以后每修一次加一行，别攒着。

## 许可

MIT
