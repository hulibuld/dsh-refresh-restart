# 把 dsh-refresh-restart 发到 GitHub 和 dshmarket

这份是给你的操作手册。在你把仓库建好之前，里面有 `<你的用户名>` 的地方先别管，等你建完仓库、拿到用户名，整份替换掉即可。

先说清楚两件事，避免白做工：

1. **dshmarket 不是一个你能"直接上传"的商店。** 它的插件列表来自另一个仓库 [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。你往那个仓库提一个 PR、加一行你自己的插件条目，合并之后 dshmarket 和 DSH 自带的"发现"页就都能搜到你了。所以顺序是：**先发 GitHub，再去那个仓库提 PR。**
2. **不要发 npm。** 我查过，npm 上的 `dsh-refresh-restart` 这个名字已经被别人占了（另一个人的同名插件，2026-09 发的）。所以我们的路线是 **GitHub + Release tarball**（官方收录指南明确支持），而不是 npm 包。

---

## 第 0 步：已经替你备好的东西

| 东西 | 位置 | 说明 |
| --- | --- | --- |
| git 仓库 | `dsh-refresh-restart/.git` | 已 `git init`、首次提交、打了 `v0.1.1` 标签 |
| 安装包 | `dsh-refresh-restart/dsh-refresh-restart-0.1.1.tgz` | 待上传到 GitHub Release |
| 分享压缩包 | `dsh-refresh-restart-0.1.1.zip` | 给朋友手动装的（之前那个） |
| 市场条目文件 | `publish/awesome-dsh-plugin-entry.yml` | 提 PR 时复制粘贴用 |

---

## 第 1 步：在 GitHub 建一个空仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `dsh-refresh-restart`
3. 选 **Public**（私有仓库不会被收录，别人也装不了）
4. 下面的 "Add a README file" / ".gitignore" / "license" **全部不要勾**
5. 点 **Create repository**

建完页面会显示一堆命令，先别管，我们走图形界面。

> 仓库名必须和插件目录名一致，因为后面提 PR 时条目文件名要写成 `<用户名>__<仓库名>.yml`。

## 第 2 步：把代码推上去（推荐用 GitHub Desktop，全程不用敲命令）

你已经装了 git，但**第一次推送**时终端会跟你要密码或 token，对新手最容易卡住。所以推荐用官方图形客户端：

1. 下载安装 [GitHub Desktop](https://desktop.github.com/)（免费），用你的 GitHub 账号登录
2. 菜单 **File → Add local repository…**，选到
   `~/Documents/deepseek-harness/default-workspace/dsh-refresh-restart`
3. 如果它提示 "this directory does not appear to be a Git repository"，说明选错层级了，重选
4. 左侧会显示一条提交记录（我已经提交过了），点右上角 **Publish repository**
5. 取消勾选 "Keep this code private"，点 **Publish repository**

推完之后，你的 `https://github.com/<你的用户名>/dsh-refresh-restart` 就有代码了。

**顺便把 tag 推上去**（Release 要用）：GitHub Desktop 里点 **History**，右键那条提交 → **Create Tag…** → 名字填 `v0.1.1` → 创建；然后再点一次 **Publish** 把 tag 推上去。（如果菜单里找不到，第 4 步直接在网页上创建 Release 时选 "Create new tag on publish"，一样可以。）

### 路线 B：用终端（想学命令的话）

```bash
cd ~/Documents/deepseek-harness/default-workspace/dsh-refresh-restart
git remote add origin https://github.com/<你的用户名>/dsh-refresh-restart.git
git push -u origin main
git push origin v0.1.1
```

推送时会要用户名和密码——**密码位置要填 Personal Access Token**，不是你的 GitHub 登录密码。生成方法：GitHub 右上角头像 → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token，勾 `repo`，复制那串 `ghp_...` 当密码用。

## 第 3 步：把仓库信息补全

在仓库首页右侧：

1. 点 **⚙ Settings 图标**（About 那一栏的齿轮）→ Description 填：`刷新 / 重启按钮，装在 DSH 桌面版左上角`
2. **Topics** 里加 `dsh-plugin`（收录指南要求，CI 会查）
3. 可选：勾上 Releases / Packages 之类无所谓，不影响收录

> `dsh-plugin` 这个 topic 是硬性要求，漏了 PR 会被打回。

## 第 4 步：发一个 Release，把 tgz 传上去

1. 仓库页右侧 **Releases** → **Create a new release**
2. **Choose a tag** 选 `v0.1.1`（没有的话选 "Create new tag: v0.1.1 on publish"）
3. **Release title** 填 `v0.1.1`
4. 把 `dsh-refresh-restart-0.1.1.tgz` 拖进 "Attach binaries" 区域
5. 点 **Publish release**

为什么必须做这步：从 GitHub 源码直接装插件，pnpm 会要求你手动批准构建脚本（`allowBuilds`），新手很容易卡在这。挂一个预打包的 tgz，市场和用户就能跳过构建。**而且这个文件名带版本号、链接钉在 v0.1.1 上，以后发新版也不会变成 404。**

传完检查这个链接能下载（把用户名换掉）：

```
https://github.com/<你的用户名>/dsh-refresh-restart/releases/download/v0.1.1/dsh-refresh-restart-0.1.1.tgz
```

## 第 5 步：等一天（真的有这个限制）

收录指南里有一条：**仓库创建必须满 1 天**，CI 会自动检查。它的目的只是过滤"提交 PR 前几分钟才建好的空仓库"，不是评价你的插件。

所以今天做完第 1–4 步，明天再来提 PR。顺便这一天里可以给 README 加张界面截图（拍一张左上角按钮的图放进 `assets/`，在 README 里引用），评审和用户都更愿意点。

## 第 6 步：去 awesome-dsh-plugin 提 PR（全程网页，不用命令行）

1. 打开 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 右上角 **Fork** → **Create fork**（这会在你自己账号下复制一份）
3. 进入你 fork 出来的仓库，点 **Add file → Create new file**
4. 文件名填（**注意是两条下划线**）：
   ```
   data/plugins/<你的用户名>__dsh-refresh-restart.yml
   ```
5. 内容粘贴 `publish/awesome-dsh-plugin-entry.yml` 里的东西，并把 `<你的用户名>` 换成真的
6. 页面下方 **Commit changes** → 直接提交到 main 分支
7. 回到你 fork 的首页，会出现一条黄色提示条 **Compare & pull request**，点它
8. 标题填 `Add dsh-refresh-restart`，正文简单写清楚：插件做什么、在哪个分类、为什么和已有的重启类插件不同（见下）
9. 点 **Create pull request**

### 提交时会跑的检查

CI 会依次查：一个 PR 最多 3 条、`package.json` 里有 `dsh.bundle`（我们有）、仓库满 1 天、YAML 格式与站点构建。任何一项挂了都会在 PR 里写明改哪里，改完往同一分支再提交即可，不用重开 PR。

### 评审会看什么（提前准备好说法）

- 代码是否真的做了描述里说的事；
- 分类是否合理（我们放 `ui`，UI 增强）；
- 是否和已有条目重复——**这里要留意**：列表里已经有几个"重启按钮"类插件（`dsh-restart-fab`、`dsh-launcher`、`dsh-power-button`）。所以 PR 正文里要主动说清差异，别等评审问：
  - 位置不同：装在左上角「收起侧边栏」旁，不额外占浮窗／侧栏
  - 一个插件给两个动作：**刷新**（只重载界面、不打断正在生成的回答）+ **重启**（整个 App 退出再开）
  - 重启带二次确认，且需要宿主每次启动随机生成的一次性 token，网页端伪造不了
  - Windows / Linux / macOS 三平台，macOS 已真机验证
- 源码里有没有可疑行为（我们零依赖、不联网、不读对话，这是加分项，PR 正文里写一句）。

## 第 7 步：合并之后

- 合并后站点自动重建，`awesome-dsh-plugin.com` 和 dshmarket 的列表都会出现你这一条（市场侧有自己的缓存，一般一天内跟上）；
- dsh 0.2.1 起自带的 **插件 → 发现 → 索引源**，默认就能搜到（索引是 npm 上的 `dsh-plugin-catalog`，由这个仓库构建）；
- 用户装你插件的命令会变成 `dsh plugin add <tgz 链接>` 或者市场里点一下；
- 以后更新：改代码 → 提新版本号 → 发新 Release → 在新 tag 的 URL 上更新条目里的 `tarball` 字段（提一个小 PR 改自己那一行）。

## 附：以后想发 npm 的话

需要先把包名改掉（比如 `dsh-refresh-restart-topbar`），因为 `dsh-refresh-restart` 已被占。改名会牵连：`package.json` 的 `name`、`cordis.patch.yml` 的 `name`、`lib/routes.js` 的路由前缀、`client.js` 的模块 id、profile 里的软链与依赖名。这些我可以一次改完并跑测试，但**必须在 DSH 关闭时改**（运行中替换正在加载的插件目录会触发重载失败）。

发 npm 的好处只有一个：市场能显示下载量、排序更好看。收录本身不依赖它，所以不急。
