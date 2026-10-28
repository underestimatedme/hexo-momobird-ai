# hexo-momobird-ai

在生成 Hexo 站点时，把公开文章同步到 MomoBird 控制台的项目里，让这些文章可以在「问答调试」和网站问答助手里被提问、被引用；也可以把 MomoBird 问答助手挂到页面底部，并在文章页播放 AI 播客。

本插件属于 MomoBird 专业版功能。创建第一个项目时自动开始 14 天试用；企业空间按企业套餐。

Hexo 是静态博客生成器，没有服务端，所以同步发生在**构建时**：每次 `hexo generate`（本地或 CI）都会把当前所有公开文章和 MomoBird 上的列表对账，推送新增或变更的文章，下线已经不在的文章。

## 功能

- 同步公开文章（Post，已发布）。草稿、`published: false`、有 `password` 的加密文章、`hidden: true` / `hide: true` 的隐藏文章、`momobird: false` 的文章不会同步。页面（`source/` 下非 `_posts` 的页面）不同步。
- 每次构建全量对账：新文章出现，改过的文章更新，删掉或改成草稿的文章下线。内容没变的文章不会重复向量化。
- 同步失败默认**不影响构建**，只打印警告；配置 `strict: true` 后失败会让命令以非零退出码结束。
- 可选：在每个页面底部显示 MomoBird 问答助手；在文章页显示播客播放器（文章生成过播客才会出现）。

## 环境要求

- Hexo 5.0 或更高版本（已在 5.4.2、7.3.0、8.1.2 上验证）
- Node.js 14 或更高版本（Hexo 8 自己要求 Node.js 20.19 以上）
- 构建环境可以访问 `https://api.valley.atlaspaces.com`
- 没有任何运行时依赖

## 安装

1. 在 MomoBird 控制台（https://momobird.atlaspaces.com）打开或新建一个项目，进入「知识 → 连接博客 → 博客 / 论坛」，平台选 **Hexo**，站点地址填 `_config.yml` 里 `url` 的协议和域名部分（含端口，不含路径）。
2. 复制页面上显示的**连接密钥**（以 `mbk_` 开头，只显示这一次）。
3. 在博客目录安装插件：

   ```bash
   npm install https://momobird.atlaspaces.com/downloads/hexo-momobird-ai-0.1.0.tgz
   ```

   依赖名是 `hexo-momobird-ai`，以 `hexo-` 开头，Hexo 会自动从 `package.json` 的依赖里加载它。请把改动后的 `package.json` 和 `package-lock.json` 一起提交，CI 里 `npm ci` 才会装上插件。
4. 在站点的 `_config.yml` 里加上配置（见下）。
5. 把连接密钥设置为环境变量 `MOMOBIRD_KEY`（见下），然后运行 `npx hexo generate`。

## 配置

```yaml
momobird:
  sync: true              # hexo generate / deploy 时同步文章
  widget: false           # 在页面底部显示问答助手
  widget_position: right  # right 或 left
  podcast: true           # 文章页显示播客播放器（文章生成过播客才会出现）
  podcast_transcript: false
  strict: false           # true：同步失败时让命令以非零退出码结束
  # api: https://api.valley.atlaspaces.com   # 一般不用写
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `sync` | `true` | 关闭后只是不同步文章，问答助手和播客不受影响 |
| `widget` | `false` | 打开后在每个页面底部加载 MomoBird 问答助手；项目的网站接入还没上线时，同步成功后自动开启一次 |
| `widget_position` | `right` | 助手按钮在右下角（`right`）或左下角（`left`） |
| `podcast` | `true` | 在文章页加载播客播放器脚本，并给会被同步的文章加上占位元素 |
| `podcast_transcript` | `false` | 播放器里显示播客文字稿 |
| `strict` | `false` | 同步失败（网络、5xx、401、402、被拒绝的文章等）时让构建失败 |
| `api` | `https://api.valley.atlaspaces.com` | 必须是 HTTPS；本地联调可以用 `http://localhost` 或 `http://127.0.0.1` |

**站点 `url` 必须和 MomoBird 来源的网址同源**（协议、域名、端口一致，注意 `www` 和 http/https）。Hexo 默认的 `url` 是 `http://example.com`，记得改成自己的域名。不同源时 MomoBird 会拒绝每一篇文章，插件会在推送前就中止，并打印两边的地址。

## 设置连接密钥

连接密钥**只从环境变量 `MOMOBIRD_KEY` 读取**，不要写进 `_config.yml`：很多 Hexo 博客的源码仓库是公开的。如果 `momobird` 配置里出现 `key`、`secret` 或任何以 `mbk_` 开头的值，插件会拒绝使用并报错。

### 本地（macOS / Linux）

```bash
export MOMOBIRD_KEY='mbk_你的密钥'
npx hexo generate
```

只对这一条命令生效：

```bash
MOMOBIRD_KEY='mbk_你的密钥' npx hexo generate
```

### 本地（Windows PowerShell）

```powershell
$env:MOMOBIRD_KEY = 'mbk_你的密钥'
npx hexo generate
```

这只对当前 PowerShell 窗口有效。想长期保存可以用 `setx MOMOBIRD_KEY "mbk_你的密钥"`，然后重新打开终端。

### GitHub Actions

先到仓库的 Settings → Secrets and variables → Actions，新建名为 `MOMOBIRD_KEY` 的 secret，再在构建步骤里引用：

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx hexo generate
        env:
          MOMOBIRD_KEY: ${{ secrets.MOMOBIRD_KEY }}
      # 之后用你自己的方式部署 public/，例如 actions/upload-pages-artifact
```

### 只在生产环境设置密钥

Vercel、Netlify、Cloudflare Pages 默认会给每个 PR 或分支做预览构建。如果 `MOMOBIRD_KEY` 对预览环境也生效，**还没合并的分支里的文章会被推上 MomoBird，而它们的链接却指向正式域名**。所以请只给生产环境设置密钥：

- **GitHub Actions**：只在合并后的分支（上面的 `push: branches: [main]`）里给 `env` 传 `secrets.MOMOBIRD_KEY`，不要传给 `pull_request` 触发的任务。fork 仓库的 PR 本来就拿不到 secrets，那种构建会只打一行提示、照常成功。
- **Vercel**：Project Settings → Environment Variables，新建 `MOMOBIRD_KEY` 时只勾选 Production，不勾 Preview 和 Development。
- **Netlify**：Site configuration → Environment variables，新建 `MOMOBIRD_KEY` 时选择只用于 Production 部署环境（Deploy contexts → Production only）。
- **Cloudflare Pages**：Settings → Variables and Secrets，只加在 Production 环境，不要加在 Preview 环境。

## 什么时候同步

只在下面这些情况自动同步（问答助手和播客的输出条件相同，但与 `sync` 开关无关）：

- 命令是 `hexo generate` 或 `hexo deploy` 触发的生成，包括简写 `hexo g`、`hexo gen`，以及 `hexo g -d`、`hexo d -g`。单独的 `hexo d` 不会重新生成站点，所以不会同步。
- 不在监视模式（`hexo g --watch` 或 `-w`）：监视模式下每次保存都会重新生成，不应该每次都推送。
- 配置里 `sync` 不是 `false`，并且设置了 `MOMOBIRD_KEY`。

**`hexo server`（本地预览）不同步，也不输出问答助手和播客播放器。** 预览地址是 `localhost:4000`，不在助手允许的来源里，显示出来只会报错，容易让人以为插件坏了。

没有设置 `MOMOBIRD_KEY` 时，插件只打一行提示「未设置 MOMOBIRD_KEY，跳过同步」，不发任何请求，也不报错。

## 同步规则

- **文章编号**：取文章源文件相对路径（例如 `_posts/hello-world.md`），算 SHA-256，取前 52 位转成十进制数字（最多 16 位）。它不受 `permalink` 配置影响，改站点链接格式不会让所有文章变成「新文章」。**给文章文件改名或换目录，会被当成「删旧建新」**，这篇文章已经生成的播客需要重新生成。
- **标题**：`title`，去掉 HTML，最多 255 个字符；为空时用 `slug`。
- **链接**：文章的 `permalink`，由站点 `url` 加文章路径生成。
- **分类**：取文章分类链的顶层分类，最多 64 个字符，没有分类时不发送。一篇文章有多个顶层分类时，取 front-matter 里写在最前面的那个（例如 `categories: [[前端, 工具], [生活]]` 取「前端」）。控制台知识页可以按分类筛选，问答助手也可以只回答某个分类。
- **正文**：Hexo 渲染后的 HTML 转成纯文本，保留标题层级，代码块保留文字，代码块左侧的行号、`script`、`style`、`iframe` 都会去掉。
- **未来日期**的文章跟随站点的 `future` 配置：站点会显示的才同步。
- **缓存**：上次成功推送的内容摘要记在 `node_modules/.cache/hexo-momobird-ai/<来源ID>.json`，只用来少发请求，不影响正确性。CI 里每次全新安装、没有缓存时会把全部文章推送一遍，MomoBird 对没变的文章返回「未变」，不会重新向量化，也不会下线任何文章。
- 每个请求超时 30 秒；网络错误和 5xx 自动重试 2 次，间隔 1 秒、3 秒。

## 问答助手和播客

- 配置 `widget: true` 后，每个页面底部会输出：

  ```html
  <script defer src="https://momobird.atlaspaces.com/widget/loader.v1.js" data-project="<项目编号>"></script>
  ```

  `widget_position: left` 时加上 `data-position="left"`。静态页面不会自己更新，项目下线或助手被关闭后，由助手脚本在浏览器里判断可用性并自行隐藏。
- 助手被你在控制台关闭或撤销后，插件不会自动重新开启。第一次构建时文章还没建好索引，会提示「下次构建会自动再试」。
- 配置 `podcast: true`（默认）时，文章页会加载 `https://momobird.atlaspaces.com/widget/podcast.v1.js`，并在会被同步的文章正文最前面放一个不可见的占位元素 `<div class="momobird-podcast" ...>`。草稿、加密文章和首页摘要里没有占位元素。播客在 MomoBird 控制台生成；文章没有播客时播放器什么也不显示。
- 占位元素是在渲染页面时加上的，不会写进 Hexo 的文章缓存，所以改了播客设置不需要先 `hexo clean`。

## 手动命令

```bash
npx hexo momobird status
npx hexo momobird sync [--dry-run] [--prune]
```

- `hexo momobird status`：显示项目名、来源名和类型、套餐与到期时间、助手状态、站点地址检查结果，以及本地文章数和 MomoBird 上的文章数。
- `hexo momobird sync`：手动对账一次。
  - `--dry-run` 只打印将要推送和下线的文章，不发送任何改动。
  - `--prune` 跳过下面的清理保护。

这两条命令同样需要环境变量 `MOMOBIRD_KEY`。缺少密钥、站点地址不同源、同步失败时，命令会打印原因并以非零退出码结束。

## 清理保护

为了防止一次出错的构建（比如配置错了、只生成出一部分文章）把整个知识库清空，自动同步时遇到下面任一情况会**跳过全部下线**，并打印警告：

- 本地一篇文章都没有；
- 要下线的文章超过 10 篇，并且超过 MomoBird 上总数的一半。

确认无误后，运行 `npx hexo momobird sync --prune` 手动下线。

## 常见问题

**构建日志里什么都没有。**
没有设置 `MOMOBIRD_KEY`，或者用的是 `hexo server`。先看有没有「未设置 MOMOBIRD_KEY，跳过同步」这一行。

**提示「站点地址不一致」。**
`_config.yml` 里的 `url` 和 MomoBird 来源的网址不同源。常见原因：`url` 还是默认的 `http://example.com`；一边有 `www` 一边没有；一边是 http 一边是 https。改成一致后重新生成。

**提示「连接密钥不能写在 _config.yml 里」。**
把 `momobird` 配置里的 `key`、`secret` 或 `mbk_` 开头的值删掉，改用环境变量 `MOMOBIRD_KEY`。

**401 / 「连接密钥无效或已被吊销」。**
密钥复制错了、被重新生成或吊销，或者控制台里的来源已被删除。到控制台重新生成密钥。

**402 / 「套餐已到期」。**
试用或专业版已到期，新文章不会同步，开通后重新生成即可补齐。到期不会让页面上的助手消失，助手按工作区当前的套餐额度继续工作。

**我给文章文件改了名，播客没了。**
文章编号来自源文件路径，改名等于「删旧建新」。重新给新文章生成播客即可。

**预览部署（Vercel / Netlify）把没合并的文章推上去了。**
见上面「只在生产环境设置密钥」。已经推上去的文章，下次用生产环境构建时会按站点现有文章对账并下线。

**多个项目站点共用一个域名（`user.github.io/a`、`user.github.io/b`）。**
它们同源，但每个站点都要建一个自己的来源，**不要让两个站点共用同一个来源**：每次构建都会把对方站点的文章当成「本地已经没有」而下线，路径相同的文章（比如都有 `_posts/hello-world.md`）还会得到相同的编号，互相覆盖。

**为什么有些文章没有同步？**
草稿、加密、隐藏、`momobird: false`，或者日期在未来而站点 `future: false`。用 `hexo momobird sync --dry-run` 可以看到会推送哪些文章。

**部分文章被拒绝。**
日志里会列出文章源文件路径和错误码（`VALIDATION_FAILED`、`UNSUPPORTED_CONTENT`、`PAYLOAD_TOO_LARGE`），下次构建会再试。

## 日志

所有日志统一带 `[MomoBird]` 前缀，不会出现连接密钥（连密钥前缀也不打印）。例如：

```
INFO  [MomoBird] 已推送 2/2 篇
INFO  [MomoBird] 同步完成：新增或更新 2 篇，未变 0 篇，下线 0 篇，失败 0 篇
INFO  [MomoBird] 已开启问答助手
```

## 开发

```bash
npm test                    # 单元测试，需要 Node.js 18 或更高版本（运行时只需要 14）
npm run test:integration    # 在真实的 Hexo 5.4.2、7.3.0、8.1.2 上跑一遍，对本机的模拟服务；需要联网安装依赖
npm run package             # 生成 dist/hexo-momobird-ai-<版本>.tgz 并检查包内文件
docker run --rm -v "$PWD":/p -w /p node:14 node test/node14-smoke.js   # Node 14 冒烟测试
```

`dev/mock-connect.js` 是 connect API 的本地替身，集成测试用它代替 MomoBird；`test/fixtures/site` 是集成测试用的最小 Hexo 站点。这两样、`scripts/` 和 `test/` 都不在发布的包里。

## 安全说明

- 连接密钥只从环境变量读取，日志、错误信息和生成的 HTML 里都不会出现它。
- 页面里只输出公开的项目编号、来源编号、文章编号和 API 地址。
- 生产环境 `api` 必须使用 HTTPS，不跟随重定向，限制响应体大小。
- 只发送公开文章的标题、链接、分类、修改时间和纯文本正文。

## License

MIT
