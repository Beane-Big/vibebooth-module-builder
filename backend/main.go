// 构建器模块后端：接收模块源码包，通过平台的构建代理构建镜像，打出和 npm run pack 一样的软件包。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

const moduleID = "builder"

func main() {
	dataDir := env("DATA_DIR", "/data")
	store, err := OpenStore(filepath.Join(dataDir, "builder.db"))
	if err != nil {
		fatal("打开数据库失败", err)
	}
	// 安装器给声明了 docker-build 特权的模块设置 DOCKER_HOST，指向平台的构建代理。
	docker, err := newDockerClient(os.Getenv("DOCKER_HOST"))
	if err != nil {
		fatal("连接构建代理失败", err)
	}
	b := newBuilder(store, docker, dataDir)
	go b.run(context.Background())
	h := &handlers{store: store, builder: b}
	verifier := auth.NewVerifier(env("JWKS_URL", "http://core:8080/api/platform/.well-known/jwks.json"), moduleID)

	// 对内接口：只给本模块前端用，需要登录。
	api := http.NewServeMux()
	api.HandleFunc("GET /api/builder/me", h.me)
	api.HandleFunc("GET /api/builder/builds", h.list)
	api.HandleFunc("POST /api/builder/builds", h.upload)
	api.HandleFunc("GET /api/builder/builds/{id}", h.detail)
	api.HandleFunc("GET /api/builder/builds/{id}/package", h.download)
	api.HandleFunc("DELETE /api/builder/builds/{id}", h.remove)
	// 保留规则和镜像源属于设置，只有有“设置”菜单的人能改；门户只是对他们显示设置入口，权限以这里为准。
	api.HandleFunc("GET /api/builder/settings", requireMenu("settings", h.settings))
	api.HandleFunc("PUT /api/builder/settings", requireMenu("settings", h.saveSettings))

	mux := http.NewServeMux()
	// 健康检查由平台在内部网络直接调用，不经过网关，也不需要令牌。
	mux.HandleFunc("GET /api/builder/health", func(w http.ResponseWriter, r *http.Request) {
		if err := docker.ping(r.Context()); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/api/builder/", verifier.Middleware(api))

	srv := &http.Server{Addr: ":8000", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	slog.Info("builder 模块已启动", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil {
		fatal("服务退出", err)
	}
}

type handlers struct {
	store   *Store
	builder *builder
}

func (h *handlers) me(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFrom(r.Context())
	// 一键安装调用的是平台安装器的接口，只有管理员能用；前端据此决定显不显示安装按钮。
	writeJSON(w, http.StatusOK, map[string]any{"name": user.Name, "menus": user.Menus, "admin": slices.Contains(user.Roles, "admin")})
}

func (h *handlers) list(w http.ResponseWriter, r *http.Request) {
	builds, err := h.store.List(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, builds)
}

// upload 接收源码包（表单字段 source）。先按平台规则检查清单和 compose.yaml，通过了才排队构建。
func (h *handlers) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSourceSize+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "请上传源码包")
		return
	}
	var tmp string
	for {
		part, err := mr.NextPart()
		if err != nil {
			writeError(w, http.StatusBadRequest, "请上传源码包")
			return
		}
		if part.FormName() == "source" {
			tmp, err = saveUpload(h.builder.dir, part)
			if err != nil {
				var tooLarge *http.MaxBytesError
				if errors.As(err, &tooLarge) {
					writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("源码包不能超过 %d MB", maxSourceSize>>20))
				} else {
					internalError(w, err)
				}
				return
			}
			break
		}
	}
	defer os.Remove(tmp)
	src, err := inspectSource(tmp)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rec := &Build{ModuleID: src.manifest.ID, ModuleName: src.manifest.Name, Version: src.manifest.Version, CreatedBy: auth.UserFrom(r.Context()).Name}
	if err := h.store.Add(r.Context(), rec); err != nil {
		internalError(w, err)
		return
	}
	if err := os.MkdirAll(h.builder.buildDir(rec.ID), 0o755); err == nil {
		err = os.Rename(tmp, h.builder.sourcePath(rec.ID))
	}
	if err != nil {
		h.store.Delete(r.Context(), rec.ID)
		internalError(w, err)
		return
	}
	h.builder.enqueue(rec.ID)
	writeJSON(w, http.StatusCreated, rec)
}

func saveUpload(dir string, r io.Reader) (string, error) {
	f, err := os.CreateTemp(dir, ".upload-*.zip")
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// maxLogSize 是详情接口最多返回的日志长度，太长时只返回最后这一段。
const maxLogSize = 512 << 10

func (h *handlers) detail(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.find(w, r)
	if !ok {
		return
	}
	log, truncated := tail(h.builder.logPath(rec.ID), maxLogSize)
	writeJSON(w, http.StatusOK, map[string]any{"build": rec, "log": log, "logTruncated": truncated})
}

func tail(path string, limit int64) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", false
	}
	truncated := info.Size() > limit
	if truncated {
		f.Seek(info.Size()-limit, io.SeekStart)
	}
	data, _ := io.ReadAll(io.LimitReader(f, limit))
	return strings.ToValidUTF8(string(data), ""), truncated
}

func (h *handlers) download(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.find(w, r)
	if !ok {
		return
	}
	if rec.Status != statusSuccess {
		writeError(w, http.StatusNotFound, "这次构建没有软件包")
		return
	}
	f, err := os.Open(h.builder.packagePath(rec.ID))
	if err != nil {
		writeError(w, http.StatusNotFound, "软件包已被清理")
		return
	}
	defer f.Close()
	name := fmt.Sprintf("%s-%s.zip", rec.ModuleID, rec.Version)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	http.ServeContent(w, r, name, time.Time{}, f)
}

func (h *handlers) remove(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.find(w, r)
	if !ok {
		return
	}
	if err := h.builder.remove(r.Context(), rec.ID); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) find(w http.ResponseWriter, r *http.Request) (*Build, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, ErrNotFound.Error())
		return nil, false
	}
	rec, err := h.store.Get(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusNotFound, err.Error())
		return nil, false
	}
	if err != nil {
		internalError(w, err)
		return nil, false
	}
	return rec, true
}

func (h *handlers) settings(w http.ResponseWriter, r *http.Request) {
	st, err := h.store.Settings(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (h *handlers) saveSettings(w http.ResponseWriter, r *http.Request) {
	var st Settings
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&st); err != nil {
		writeError(w, http.StatusBadRequest, "格式错误")
		return
	}
	st.NpmRegistry, st.GoProxy = strings.TrimSpace(st.NpmRegistry), strings.TrimSpace(st.GoProxy)
	if msg := validateSettings(st); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if err := h.store.SaveSettings(r.Context(), st); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func validateSettings(st Settings) string {
	switch {
	case st.MaxPackages < 1 || st.MaxPackages > 50:
		return "每个模块保留的软件包数要在 1 到 50 之间"
	case st.MaxDays < 1 || st.MaxDays > 365:
		return "保留天数要在 1 到 365 之间"
	case st.CacheGB < 1 || st.CacheGB > 100:
		return "构建缓存上限要在 1 到 100 GB 之间"
	case st.NpmRegistry != "" && !isHTTPURL(st.NpmRegistry):
		return "npm 镜像源要是 http:// 或 https:// 开头的网址"
	case strings.ContainsAny(st.GoProxy, " \t\r\n"):
		return "Go 代理不能有空格"
	}
	return ""
}

func isHTTPURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// ---- 工具函数 ----

// requireMenu 要求当前用户有某个菜单的权限，菜单由管理员在门户“用户”页按人设置。
func requireMenu(menu string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !auth.UserFrom(r.Context()).HasMenu(menu) {
			writeError(w, http.StatusForbidden, "没有修改设置的权限")
			return
		}
		next(w, r)
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func internalError(w http.ResponseWriter, err error) {
	slog.Error("处理请求失败", "err", err)
	writeError(w, http.StatusInternalServerError, "服务器出错了")
}

func fatal(msg string, err error) {
	slog.Error(msg, "err", err)
	os.Exit(1)
}
