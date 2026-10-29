# 依赖在构建时下载，本机打包和服务器上的构建器都一样；下载过的包留在 Docker 的构建缓存里。
FROM node:22-alpine AS build
# 服务器上的构建器可以传入国内的 npm 镜像源，不传时用官方源。
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund
# 模块图标放在 /app/icon.svg，和源码里一样在 frontend/ 的上一级，vite-icon.ts 按这个位置找它。
COPY icon.svg /app/icon.svg
COPY frontend/ ./
RUN npm run build

FROM nginx:1.29-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html/apps/builder
