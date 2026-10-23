# 构建器

上传模块源码包，在服务器上构建出软件包，可以一键安装或下载

这是一个 [Vibebooth](https://github.com/Beane-Big/vibebooth) 模块，由 `create-vibebooth` 生成。

## 怎么工作

1. 在页面上传模块仓库打成的源码包（zip，不带 `node_modules`、`dist`；GitHub 上的 “Download ZIP” 也可以）。上传时就按平台安装的规则检查 `module.yaml` 和 `compose.yaml`，不合规范直接拒绝。
2. 后端按上传顺序一个一个构建：解压源码包，按 `compose.yaml` 里每个服务的 `build` 调用 Docker 构建镜像，导出后打成和 `npm run pack` 一样的软件包，再完整校验一遍。模块的 id、名称和版本都以源码包里的 `module.yaml` 为准，构建器不改。
3. 成功的软件包可以下载，拿到别的服务器上安装；管理员也可以点“安装到本平台”，等于在门户“应用管理”页上传。
4. 设置页里可以改保留规则（默认每个应用留最近 5 个软件包、最多 30 天）、构建缓存上限（默认 5 GB）和构建时传给 Dockerfile 的 `NPM_REGISTRY`、`GOPROXY`。

构建器在 `module.yaml` 里声明了特权 `docker-build`：安装时管理员要确认，之后后端通过平台的构建代理使用 Docker，只能构建、查看、打标签、导出和删除 `vb-` 开头的模块镜像，碰不到容器和平台自己的镜像。构建同一个版本时，已经装好的同版本模块的镜像会在构建完后还原，不受影响。

构建时会在服务器上运行源码包里 Dockerfile 的命令，所以页面默认只给管理员，只构建你信任的源码。

## 常用命令

都在本目录运行，需要 Node.js 和 Docker。`npm run pack` 只需要这两样；`install:local` 和 `dev` 还要求本机已经用 `docker compose up -d` 跑着 Vibebooth 平台。

| 命令 | 做什么 |
| --- | --- |
| `npm run install:local` | 打包并装到本机平台，打开 http://localhost:8080 就能看到。改完代码再运行一次即可 |
| `npm run dev` | 只启动前端开发服务器，接口转给本机平台，改界面时不用每次打包。先在 http://localhost:8080 登录一次，再打开终端里显示的地址 |
| `npm run pack` | 生成 `dist/builder-<版本>.zip`，上传到正式平台的“应用管理”页 |
| `npm run vendor` | 重新下载后端依赖（改了 `backend/go.mod` 之后运行） |

后端依赖的 SDK 在私有仓库里时，下载要用 GitHub 令牌：先 `export VIBEBOOTH_GITHUB_TOKEN=<令牌>`，或者让 git 记住 github.com 的登录。

本机没有平台时，`npm run pack` 会下载安装器镜像 `ghcr.io/beane-big/vibebooth-installer`。这个镜像还是私有的话，先用有 `read:packages` 权限的令牌运行一次 `docker login ghcr.io`。

发布新版本前，把 `module.yaml` 的 `version` 改大。
