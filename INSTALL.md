# dsh-refresh-restart 安装说明

在 DeepSeek Harness 桌面版界面左上角加两个小按钮：**↻ 刷新**、**⏻ 重启**。

- 刷新 = 重新加载界面（等于按 `⌘R`），正在生成的回答不会断。
- 重启 = 关掉整个 App 再自动打开，用来让新装的插件、改了配置的插件生效。

它不改 DSH 本体，只是加一个插件。不想要了可以把下面加的几行删掉，DSH 回到原样。

版本：0.1.1 ｜ 要求：DSH 桌面版 0.2.0-rc.1 或更新

---

## 一、先把文件夹放好（别放在下载目录里）

解压出来的 `dsh-refresh-restart` 文件夹要**长期留在一个不会被清理的地方**，因为 DSH 是"引用"它，不是"复制"它——你把它删了或移走，按钮就没了。

推荐位置：

- macOS / Linux：`~/Documents/dsh-refresh-restart`
- Windows：`C:\Users\你的用户名\Documents\dsh-refresh-restart`

后面的命令里出现 `/Users/你的用户名/Documents/dsh-refresh-restart` 或 `C:\...`，都换成你实际放的位置。

## 二、找到 DSH 的配置目录

DSH 的所有配置都在一个叫 `.dsh` 的隐藏文件夹里：

- macOS / Linux：`~/.dsh`（在访达里按 `⌘⇧G` 输入 `~/.dsh` 就能进去）
- Windows：`C:\Users\你的用户名\.dsh`

我们要改的是里面这个文件：

```
~/.dsh/profiles/desktop/package.json
```

## 三、在 package.json 里加两处

用文本编辑器打开它，找到 `"dependencies": { ... }` 那一段，在花括号里面加一行（注意行尾的逗号，最后一行不需要）：

```json
"dsh-refresh-restart": "link:/Users/你的用户名/Documents/dsh-refresh-restart",
```

Windows 上写成（路径里的反斜杠要写成两个）：

```json
"dsh-refresh-restart": "link:C:\\Users\\你的用户名\\Documents\\dsh-refresh-restart",
```

然后往下找 `"dsh"` → `"profile"` → `"bundles": [ ... ]` 这个数组，在里面加一行：

```json
"dsh-refresh-restart",
```

改完保存。JSON 对格式很挑剔：漏逗号、多逗号都会让整个文件失效，改完可以搜"在线 JSON 校验"贴进去检查一下。

## 四、建一个软链接

DSH 按名字找插件，所以在 `node_modules` 里要有一个指向你那个文件夹的"快捷方式"。

macOS / Linux（打开"终端"，粘贴后回车）：

```bash
ln -s ~/Documents/dsh-refresh-restart ~/.dsh/profiles/desktop/node_modules/dsh-refresh-restart
```

Windows（**以管理员身份**打开 PowerShell）：

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-refresh-restart" `
  -Target "$env:USERPROFILE\Documents\dsh-refresh-restart"
```

> 不要用 `pnpm add` 或 `pnpm install` 装它。那两个命令会重算整棵依赖树，可能把你 profile 里别的插件弄坏。手动加软链最稳。

## 五、完全退出 DSH，再重新打开

点左上角苹果菜单 / 任务栏退出 App，**不是**只关窗口。重开之后，左上角"收起侧边栏"旁边应该多了两个小按钮。

没出现的话：

1. 按一次 `⌘R`（Windows 是 `Ctrl+R`）刷新界面；
2. 还是没有，就检查第三步改的 JSON 有没有语法错误、第四步的软链接路径对不对；
3. 重启功能的日志在临时目录里，文件名形如 `dsh-refresh-restart-<时间>.log`（macOS：`/var/folders/.../T/`，Linux：`/tmp/`，Windows：`%TEMP%`），里面能看到它退到哪一步。

## 六、卸载

1. 删掉第三步加的那两行；
2. 删掉第四步建的软链接；
3. 重启 DSH，左上角的按钮就消失了。

---

## 各平台能用到什么程度

| 功能 | macOS | Windows | Linux | 浏览器里打开 |
| --- | --- | --- | --- | --- |
| 刷新按钮 | ✅ | ✅ | ✅ | ✅ |
| 重启按钮 | ✅ 实测通过 | ✅ 写了但没在真机跑过 | ✅ 写了但没在真机跑过 | ⛔ 不显示 |

浏览器里（非桌面 App）只能刷新，重启按钮会自动变成灰色不可点——网页没有权限重启你电脑上的程序。

## 安全说明

- 纯本地：不联网、不读你的对话内容、不收集任何数据。
- 重启是一个 POST 请求，必须带宿主每次启动随机生成的一次性 token；光有本机地址伪造不了。
- 代码全在这几个文件里，可以自己看：`index.js`（宿主侧）、`client.js`（界面侧）、`lib/`（平台识别、重启、路由）。
