# 构建器（builder）模块约定（给 AI 编码工具和自己看）

这是一个 Vibebooth 模块，遵循模块规范 `platform: 1`：https://github.com/Beane-Big/vibebooth/blob/main/docs/module-spec.md 。不符合规范时 `npm run pack` 会直接报错。下面是本模块自己的约定。

- 模块 id 是 `builder`：页面在 `/apps/builder/` 下，接口在 `/api/builder/` 下，容器叫 `builder-frontend` 和 `builder-backend`。
- 不要自己写网关路由标签、端口映射或网络，安装器会补上；`compose.yaml` 允许的字段见规范。
- 不写登录代码。后端用 SDK `github.com/Beane-Big/vibebooth/packages/sdk-go/auth` 拿当前用户，接口权限用 `HasMenu("<菜单 id>")` 判断。
- 后端必须保留 `GET /api/builder/health`，正常时返回 2xx。
- 数据只存在 `compose.yaml` 里声明的卷里，默认用 SQLite。改表结构要兼容老数据。
- 要调用其他模块，只调用对方 `/api/<id>/ext/v1/` 下的对外接口，并在 `module.yaml` 的 `requires` 里写上对方。
- 发布新版本前把 `module.yaml` 的 `version` 改大，再运行 `npm run pack`。
- 后端通过环境变量 `DOCKER_HOST`（安装器设置，指向平台的构建代理）调用 Docker 接口，只用构建代理放行的那几个接口；代理拒绝的请求会返回 403，原因写在构建代理的日志里。
- 校验和打包用平台仓库的 `packages/manifest` 和 `packages/modpkg`，和安装器是同一套规则，不要在这里另写一份。平台改了这两个包并打了新标签后，更新 `backend/go.mod` 再运行 `npm run vendor`。
