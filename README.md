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

自己 clone 下来装的话按 profile 那套走：链到 `node_modules`，`dependencies` 里写 `link:`，`dsh.profile.bundles` 里加上名字，然后重启。别在仓库目录里跑 `pnpm install`，它会重解整棵依赖树，把你别的插件也装一遍。

## 两个按钮

刷新等于按一次 `⌘R`。只重载界面那一层，宿主里的生成任务照常跑，正在生成的回答不会中断。会丢的是输入框里还没发的草稿和滚动位置。

重启会弹确认框，然后窗口关闭，几秒后自己重新打开。会话、工作区都在，等同菜单里的「重启应用与 Host」。

关窗口的时候如果还有任务在跑，DSH 会再问一句。在那里点取消，这次重启就作废，助手不强杀也不重开，界面会告诉你已取消。

| 操作 | 后台生成 | 界面 |
| --- | --- | --- |
| 刷新 | 不受影响 | 重载，重新接上会话 |
| 重启 | 结束并重新启动 | 关闭再打开 |

真正会打断回答的只有重启、点停止、宿主崩溃。刷新不会。

## 兼容性

macOS、Windows、Linux 的桌面版，刷新和重启都能用。浏览器里跑 `dsh web` 只能刷新，重启得自己手动来。

三个平台的退出与重开命令不一样，都实现了。识别不到应用位置时按钮会明说，不会静默失败。

## 配置

`cordis.patch.yml` 里可调，也可以写在 profile 的插件配置里。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `quitTimeoutMs` | `20000` | 等应用自己退出的上限，超时按取消处理，不强杀（`forceKill` 打开时不等待） |
| `openDelayMs` | `800` | 确认进程消失后隔多久重开 |
| `appPath` | 空 | 留空自动推断；换过安装位置或绿色版填绝对路径 |
| `forceKill` | `false` | 是否跳过等待直接强杀。默认关，只有确认卡死且能接受丢草稿才开 |

## 排障

按钮没出现，先确认 profile 的 `dsh.profile.bundles` 里有插件名，然后重启。插件清单只在启动时读一次。

窗口关了没回来，去临时目录看 `dsh-refresh-restart-<时间>.log`。里面按顺序记了退出、等待、重开每一步。日志停在 `helper start`，多半是安全软件把助手拦了，把 DSH 加进白名单再试。

提示没找到应用位置，把 `appPath` 配上绝对路径。macOS 填 `.app`，Windows 填 exe，Linux 填 AppImage。

点重启后弹「关闭应用会中断当前正在进行的任务」，点取消就行，本次重启作废，应用不受影响。反复出现又确实想强杀，把 `forceKill` 改成 `true`。

## 安全

只注册 `127.0.0.1` 上的路由，校验 `Host` 头，挡 DNS rebinding。重启是 POST，要带 `status` 响应里的随机 token，跨站 `Origin` 一律拒绝。助手脚本写在临时目录，权限 `0700`。不联网，不收集数据，不读会话内容。

## 开发

```
node --test test/
```

## 已知问题与修复记录

累计的修复、现象、原因与修法记在 [docs/FIXES.md](docs/FIXES.md)。以后每修一次加一行，别攒着。

## 许可

MIT
