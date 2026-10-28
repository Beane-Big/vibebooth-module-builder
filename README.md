# 构建器

上传模块源码包，在服务器上构建出软件包，可以一键安装或下载

这是一个 [Vibebooth](https://github.com/Beane-Big/vibebooth) 模块，由 `create-vibebooth` 生成。

## 怎么工作

1. 在页面上传模块仓库打成的源码包（zip，不带 `node_modules`、`dist`；GitHub 上的 “Download ZIP” 也可以）。上传时就按平台安装的规则检查 `module.yaml` 和 `compose.yaml`，不合规范直接拒绝。
2. 后端按上传顺序一个一个构建：解压源码包，按 `compose.yaml` 里每个服务的 `build` 调用 Docker 构建镜像，导出后打成和 `npm run pack` 一样的软件包，再完整校验一遍。模块的 id、名称和版本都以源码包里的 `module.yaml` 为准，构建器不改。
3. 成功的软件包可以下载，拿到别的服务器上安装；管理员也可以在构建记录上点“安装”，等于在门户“应用管理”页上传。安装结果和日志会记在这条构建记录上，点“安装日志”查看。上传时点“构建并安装”并确认，构建成功后会自动安装，不用再点；期间不要关闭页面，降级或模块声明了特权时仍会请管理员确认。
4. 构建失败时，如果日志显示连不上官方的 Go 代理、npm 源或 Docker Hub，会提示去哪里设置镜像源。
5. 设置页里可以改保留规则（默认每个应用留最近 5 个软件包、最多 30 天，构建记录页会显示每条记录保留到哪天）、构建缓存上限（默认 5 GB）和构建时传给 Dockerfile 的 `NPM_REGISTRY`、`GOPROXY`。

构建器在 `module.yaml` 里声明了特权 `docker-build`：安装时管理员要确认，之后后端通过平台的构建代理使用 Docker，只能构建、查看、打标签、导出和删除 `vb-` 开头的模块镜像，碰不到容器和平台自己的镜像。构建同一个版本时，已经装好的同版本模块的镜像会在构建完后还原，不受影响。

构建时会在服务器上运行源码包里 Dockerfile 的命令，所以页面默认只给管理员，只构建你信任的源码。

## 常用命令

都在本目录运行，需要 Node.js。

### 发布：推荐交给平台的构建器打包

| 命令 | 需要 | 做什么 |
| --- | --- | --- |
| `npm run pack:source` | 只要 Node.js | 把源码打成 `dist/builder-<版本>-source.zip`（不含 `node_modules`、`dist`），上传到平台的“构建器”页面，由服务器构建出软件包，构建完在构建记录上点“安装” |

推荐用这种方式：本机不用装 Docker，镜像在服务器上构建，用的是构建器设置里的镜像源。前提是平台上已经装好构建器。GitHub 上的 “Download ZIP” 也可以直接上传给构建器。

构建器自己也是这样升级：在服务器的构建器上传构建器的源码包，构建完点“安装”。只有新服务器上还没有构建器时，才需要先拿到构建好的 zip：到 GitHub 的 Releases 下载（由“发布软件包”流程用 `npm run pack` 生成），或者在本机运行 `npm run pack`，再上传到“应用管理”页。

### 本机打包和开发（可选）

| 命令 | 需要 | 做什么 |
| --- | --- | --- |
| `npm run pack` | Docker | 在本机构建镜像，生成 `dist/builder-<版本>.zip`，上传到平台的“应用管理”页。平台还没装构建器时用 |
| `npm run install:local` | Docker 和本机平台 | 打包并装到本机平台，打开 http://localhost:8080 就能看到。改完代码再运行一次即可 |
| `npm run dev` | Docker 和本机平台 | 只启动前端开发服务器，接口转给本机平台，改界面时不用每次打包。先在 http://localhost:8080 登录一次，再打开终端里显示的地址 |

- 运行前先启动 Docker（Windows 和 Mac 上是 Docker Desktop）。
- “本机平台”指在平台仓库里用 `docker compose up -d` 跑起来的 Vibebooth。`pack` 不需要本机平台。
- `pack` 用安装器镜像检查并打包：本机有平台时用本机平台的，没有时下载发布版 `ghcr.io/beane-big/vibebooth-installer`，第一次要能连上 ghcr.io。镜像还是私有的话，先用有 `read:packages` 权限的令牌运行一次 `docker login ghcr.io`。
- 本机平台比模块旧时，`pack` 会用旧的安装器而报错（比如不认识新字段），先在平台仓库里 `git pull` 再 `docker compose up -d --build`。

### 其他

| 命令 | 做什么 |
| --- | --- |
| `npm run rename -- <新 id> [新名称]` | 改模块 id，也可以同时改名称，代码、配置和文档里用到的地方一起改。只改名称就把 id 写成原来的。id 要在第一次装到平台前定好：装过的模块改 id 会变成另一个应用，旧数据不会跟过去 |

依赖在构建镜像时下载（Go 用 `GOPROXY`，npm 用 `NPM_REGISTRY`），本机不用装 Go。

发布新版本前，把 `module.yaml` 的 `version` 改大。
