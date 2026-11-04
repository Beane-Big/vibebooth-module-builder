package main

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"os"
	"sync"
	"time"
)

// 在服务器上直接安装：前端先向这里要一个一次性的下载地址，再把地址交给平台安装器，
// 安装器在内部网络里直接从本模块后端下载软件包。几百 MB 的软件包不用先下载到浏览器、再从浏览器上传。

// internalURL 是安装器在内部网络里访问本模块后端的地址：容器名 builder-backend（安装器按 <id>-backend 命名），端口 8000。
const internalURL = "http://" + moduleID + "-backend:8000"

// installLinkTTL 是下载地址的有效期；地址只能用一次，安装器拿到后马上就下载。
const installLinkTTL = 10 * time.Minute

type installLink struct {
	buildID int64
	expires time.Time
}

// installLinks 存在内存里，重启后旧地址失效，重新点“安装”就行。
type installLinks struct {
	mu    sync.Mutex
	links map[string]installLink
}

func newInstallLinks() *installLinks { return &installLinks{links: map[string]installLink{}} }

func (l *installLinks) create(buildID int64) string {
	b := make([]byte, 32)
	rand.Read(b)
	token := hex.EncodeToString(b)
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for t, link := range l.links {
		if now.After(link.expires) {
			delete(l.links, t)
		}
	}
	l.links[token] = installLink{buildID: buildID, expires: now.Add(installLinkTTL)}
	return token
}

// take 取出并作废一个地址，过期或不存在时返回 false。
func (l *installLinks) take(token string) (int64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	link, ok := l.links[token]
	delete(l.links, token)
	if !ok || time.Now().After(link.expires) {
		return 0, false
	}
	return link.buildID, true
}

// createInstallLink 给构建成功的记录生成一次性的下载地址，只有管理员能要（和安装按钮一致）。
func (h *handlers) createInstallLink(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.find(w, r)
	if !ok {
		return
	}
	if rec.Status != statusSuccess {
		writeError(w, http.StatusNotFound, "这次构建没有软件包")
		return
	}
	if _, err := os.Stat(h.builder.packagePath(rec.ID)); err != nil {
		writeError(w, http.StatusNotFound, "软件包已被清理")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": internalURL + "/internal/packages/" + h.links.create(rec.ID)})
}

// internalPackage 给安装器下载软件包。这个地址不在 /api/builder/ 下，网关不转发，只有内部网络能访问；
// 不需要登录令牌，凭一次性的地址下载。
func (h *handlers) internalPackage(w http.ResponseWriter, r *http.Request) {
	id, ok := h.links.take(r.PathValue("token"))
	if !ok {
		writeError(w, http.StatusNotFound, "下载地址无效或已过期，请重新安装")
		return
	}
	f, err := os.Open(h.builder.packagePath(id))
	if err != nil {
		writeError(w, http.StatusNotFound, "软件包已被清理")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/zip")
	http.ServeContent(w, r, "package.zip", time.Time{}, f)
}
