# 构建上下文是 backend/。依赖已经由 npm run vendor 下载到 vendor/，构建时不联网。
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -mod=vendor -trimpath -ldflags="-s -w" -o /out/app .

FROM alpine:3.22
RUN adduser -D -u 10001 app
# 数据目录挂载命名卷；先建好并交给 app 用户，卷第一次创建时会沿用这个属主。
RUN mkdir /data && chown app /data
USER app
COPY --from=build /out/app /usr/local/bin/app
EXPOSE 8000
ENTRYPOINT ["app"]
