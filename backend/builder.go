package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Beane-Big/vibebooth/packages/modpkg"
)

// builder 按上传顺序一个一个构建：服务器只有几核，同时构建只会更慢，还容易把内存吃满。
// 每次构建的文件放在 <数据目录>/builds/<id>/：source.zip 是上传的源码包，build.log 是日志，package.zip 是打出的软件包，
// install.log 是在构建器里安装时平台安装器返回的日志。
type builder struct {
	store  *Store
	docker *dockerClient
	dir    string
	queue  chan int64
	// current 是正在构建的 id，cancel 用来在删除记录时中止它；discard 表示构建结束后要删掉这条记录。
	mu      sync.Mutex
	current int64
	cancel  context.CancelFunc
	discard bool
}

const buildTimeout = 30 * time.Minute

func newBuilder(store *Store, docker *dockerClient, dir string) *builder {
	return &builder{store: store, docker: docker, dir: dir, queue: make(chan int64, 1000)}
}

func (b *builder) buildDir(id int64) string {
	return filepath.Join(b.dir, "builds", strconv.FormatInt(id, 10))
}
func (b *builder) sourcePath(id int64) string  { return filepath.Join(b.buildDir(id), "source.zip") }
func (b *builder) logPath(id int64) string     { return filepath.Join(b.buildDir(id), "build.log") }
func (b *builder) packagePath(id int64) string { return filepath.Join(b.buildDir(id), "package.zip") }
func (b *builder) installLogPath(id int64) string {
	return filepath.Join(b.buildDir(id), "install.log")
}

// run 处理构建队列，并且每小时按保留规则清理一次。
func (b *builder) run(ctx context.Context) {
	ids, err := b.store.Recover(ctx)
	if err != nil {
		slog.Error("恢复构建队列失败", "err", err)
	}
	for _, id := range ids {
		b.queue <- id
	}
	b.cleanup(ctx)
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			b.cleanup(ctx)
		case id := <-b.queue:
			b.runOne(ctx, id)
			b.cleanup(ctx)
		}
	}
}

func (b *builder) enqueue(id int64) { b.queue <- id }

func (b *builder) runOne(ctx context.Context, id int64) {
	rec, err := b.store.Get(ctx, id)
	if err != nil || rec.Status != statusQueued {
		return // 排队时被删掉了
	}
	if err := b.store.Start(ctx, id); err != nil {
		slog.Error("更新构建状态失败", "id", id, "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(ctx, buildTimeout)
	b.mu.Lock()
	b.current, b.cancel = id, cancel
	b.mu.Unlock()
	defer func() {
		cancel()
		b.mu.Lock()
		discard := b.discard
		b.current, b.cancel, b.discard = 0, nil, false
		b.mu.Unlock()
		if discard {
			b.remove(context.WithoutCancel(ctx), id)
		}
	}()

	log, err := os.Create(b.logPath(id))
	if err != nil {
		slog.Error("创建构建日志失败", "id", id, "err", err)
		b.store.Finish(context.WithoutCancel(ctx), id, errors.New("创建构建日志失败"), "", 0)
		return
	}
	defer log.Close()
	start := time.Now()
	buildErr := b.build(ctx, rec, log)
	var size int64
	var hint string
	if buildErr == nil {
		if info, err := os.Stat(b.packagePath(id)); err == nil {
			size = info.Size()
		}
		fmt.Fprintf(log, "\n构建完成，用时 %s，软件包 %.1f MB\n", time.Since(start).Round(time.Second), float64(size)/(1<<20))
	} else {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			buildErr = fmt.Errorf("构建超过 %s，已中止", buildTimeout)
		} else if errors.Is(ctx.Err(), context.Canceled) {
			buildErr = errors.New("构建已取消")
		}
		fmt.Fprintf(log, "\n构建失败: %v\n", buildErr)
		if ctx.Err() == nil {
			hint = b.mirrorHint(context.WithoutCancel(ctx), id)
		}
		if hint != "" {
			fmt.Fprintf(log, "\n提示：%s\n", hint)
		}
	}
	// 源码包只在构建时用到，构建完就删掉，省得占地方。
	os.Remove(b.sourcePath(id))
	if err := b.store.Finish(context.WithoutCancel(ctx), id, buildErr, hint, size); err != nil {
		slog.Error("更新构建状态失败", "id", id, "err", err)
	}
	slog.Info("构建结束", "id", id, "module", rec.ModuleID, "version", rec.Version, "err", buildErr)
}

// build 解压源码包，逐个构建服务的镜像，导出后打成和 npm run pack 一样的软件包。
func (b *builder) build(ctx context.Context, rec *Build, log io.Writer) error {
	fmt.Fprintf(log, "构建 %s（%s）%s\n", rec.ModuleName, rec.ModuleID, rec.Version)
	work := filepath.Join(b.buildDir(rec.ID), "work")
	defer os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o755); err != nil {
		return err
	}
	if err := unpack(b.sourcePath(rec.ID), work); err != nil {
		return err
	}
	// 上传时已经检查过，这里用解压出来的文件再检查一次，打包用的就是这些文件。
	src, err := inspectDir(work)
	if err != nil {
		return err
	}
	settings, err := b.store.Settings(ctx)
	if err != nil {
		return err
	}
	args := map[string]string{}
	if settings.NpmRegistry != "" {
		args["NPM_REGISTRY"] = settings.NpmRegistry
	}
	if settings.GoProxy != "" {
		args["GOPROXY"] = settings.GoProxy
	}
	// 写明这次用的镜像源，下载依赖失败时一眼能看出是不是没设置。
	fmt.Fprintf(log, "Go 代理：%s\nnpm 镜像源：%s\n", orUnset(settings.GoProxy), orUnset(settings.NpmRegistry))

	// 构建会占用 vb-<服务>:<版本> 这个名字。同名镜像可能属于平台上已经装好的同一版本，构建前给它打一个备份名，
	// 导出后删掉新构建的镜像，再把名字还给原来的镜像，已安装的模块不受影响。
	var images []string
	backups := map[string]string{}
	defer func() { b.restore(context.WithoutCancel(ctx), images, backups, log) }()
	for _, t := range src.targets {
		fmt.Fprintf(log, "\n==> 构建 %s（%s）\n", t.Service, t.Image)
		id, err := b.docker.imageID(ctx, t.Image)
		if err != nil {
			return err
		}
		if id != "" {
			backup := backupName(rec.ID, t.Image)
			if err := b.docker.tag(ctx, t.Image, backup); err != nil {
				return fmt.Errorf("备份同名镜像 %s 失败: %w", t.Image, err)
			}
			backups[t.Image] = backup
		}
		images = append(images, t.Image)
		pr, pw := io.Pipe()
		go func() {
			pw.CloseWithError(contextTar(filepath.Join(work, filepath.FromSlash(t.Context)), t.Dockerfile, pw))
		}()
		err = b.docker.build(ctx, pr, buildOptions{
			Tag:        t.Image,
			Dockerfile: t.Dockerfile,
			BuildArgs:  args,
			Labels:     map[string]string{"vibebooth.build": strconv.FormatInt(rec.ID, 10)},
		}, log)
		pr.CloseWithError(err)
		if err != nil {
			return fmt.Errorf("%s 构建失败: %w", t.Service, err)
		}
	}

	fmt.Fprintln(log, "\n==> 导出镜像")
	imagesPath := filepath.Join(b.buildDir(rec.ID), modpkg.ImagesFile)
	defer os.Remove(imagesPath)
	f, err := os.Create(imagesPath)
	if err != nil {
		return err
	}
	err = b.docker.save(ctx, images, f)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("导出镜像失败: %w", err)
	}

	fmt.Fprintln(log, "==> 打包并校验")
	if err := modpkg.Pack(work, imagesPath, b.packagePath(rec.ID)); err != nil {
		return fmt.Errorf("打包失败: %w", err)
	}
	return nil
}

func orUnset(s string) string {
	if s == "" {
		return "未设置（用 Dockerfile 里的默认值，一般是官方源）"
	}
	return s
}

// 日志里出现这些字样，说明是网络连不上，不是代码的问题。
var networkErrors = []string{"i/o timeout", "dial tcp", "no such host", "connection reset", "connection refused",
	"TLS handshake timeout", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"}

// mirrorHint 读这次构建的日志，判断失败是不是因为连不上官方源，是的话返回该怎么处理；判断不出来返回空。
func (b *builder) mirrorHint(ctx context.Context, id int64) string {
	settings, err := b.store.Settings(ctx)
	if err != nil {
		return ""
	}
	log, _ := tail(b.logPath(id), maxLogSize)
	return mirrorHint(log, settings)
}

func mirrorHint(log string, settings Settings) string {
	var goProxy, npm, dockerHub bool
	for line := range strings.Lines(log) {
		if !containsAny(line, networkErrors) {
			continue
		}
		goProxy = goProxy || strings.Contains(line, "proxy.golang.org")
		npm = npm || strings.Contains(line, "registry.npmjs.org")
		dockerHub = dockerHub || strings.Contains(line, "docker.io")
	}
	const where = "请管理员点构建器顶栏右侧的“设置”"
	var hints []string
	switch {
	case goProxy && settings.GoProxy == "":
		hints = append(hints, "连不上官方 Go 代理 proxy.golang.org，构建器还没设置 Go 代理。"+where+"把 Go 代理填成 https://goproxy.cn,direct，保存后重新上传。")
	case goProxy:
		hints = append(hints, "构建器已经设置了 Go 代理 "+settings.GoProxy+"，日志里却还在连 proxy.golang.org。检查 Dockerfile 有没有用 ARG GOPROXY 接收，以及代理地址里是不是还带着 proxy.golang.org。")
	}
	switch {
	case npm && settings.NpmRegistry == "":
		hints = append(hints, "连不上官方 npm 源 registry.npmjs.org，构建器还没设置 npm 镜像源。"+where+"把 npm 镜像源填成 https://registry.npmmirror.com，保存后重新上传。")
	case npm:
		hints = append(hints, "构建器已经设置了 npm 镜像源 "+settings.NpmRegistry+"，日志里却还在连 registry.npmjs.org。检查 Dockerfile 有没有用 ARG NPM_REGISTRY 接收。")
	}
	if dockerHub {
		hints = append(hints, "服务器拉不到 Docker Hub 上的基础镜像。这要给服务器的 Docker 配镜像加速，见平台仓库的 DEPLOY-SERVER.md，构建器的设置管不到。")
	}
	return strings.Join(hints, "\n")
}

func containsAny(s string, subs []string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// backupName 是构建期间给同名旧镜像用的备份名，例如 vb-build-12-notes-backend:0.2.0。
// 模块 id 不能叫 build，所以不会和模块镜像重名。
func backupName(id int64, image string) string {
	return fmt.Sprintf("%sbuild-%d-%s", modpkg.ImagePrefix, id, strings.TrimPrefix(image, modpkg.ImagePrefix))
}

// restore 删掉这次构建出的镜像，原来有同名镜像的把名字还给它。出错只记日志：不影响软件包。
func (b *builder) restore(ctx context.Context, images []string, backups map[string]string, log io.Writer) {
	for _, name := range images {
		if err := b.docker.removeImage(ctx, name); err != nil {
			fmt.Fprintf(log, "删除镜像 %s 失败: %v\n", name, err)
			continue
		}
		backup := backups[name]
		if backup == "" {
			continue
		}
		if err := b.docker.tag(ctx, backup, name); err != nil {
			fmt.Fprintf(log, "恢复镜像 %s 失败: %v，原来的镜像还在 %s\n", name, err, backup)
			continue
		}
		if err := b.docker.removeImage(ctx, backup); err != nil {
			fmt.Fprintf(log, "删除备份镜像 %s 失败: %v\n", backup, err)
		}
	}
}

// cleanup 按设置清理过期的构建记录和软件包，再把构建缓存压到上限以内。
func (b *builder) cleanup(ctx context.Context) {
	settings, err := b.store.Settings(ctx)
	if err != nil {
		slog.Error("读取设置失败", "err", err)
		return
	}
	ids, err := b.store.Expired(ctx, settings.MaxPackages, time.Now().AddDate(0, 0, -settings.MaxDays))
	if err != nil {
		slog.Error("查找过期构建失败", "err", err)
	}
	for _, id := range ids {
		if err := b.remove(ctx, id); err != nil {
			slog.Error("清理构建失败", "id", id, "err", err)
		}
	}
	reclaimed, err := b.docker.pruneCache(ctx, int64(settings.CacheGB)<<30)
	if err != nil {
		slog.Error("清理构建缓存失败", "err", err)
	} else if reclaimed > 0 {
		slog.Info("清理了构建缓存", "MB", reclaimed>>20)
	}
}

// remove 删除构建记录和它的文件。正在构建的先中止，等构建停下来再删。
func (b *builder) remove(ctx context.Context, id int64) error {
	b.mu.Lock()
	if b.current == id {
		b.cancel()
		b.discard = true
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()
	if err := b.store.Delete(ctx, id); err != nil {
		return err
	}
	return os.RemoveAll(b.buildDir(id))
}
