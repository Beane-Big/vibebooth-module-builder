package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestInternalPackage(t *testing.T) {
	h := &handlers{builder: &builder{dir: t.TempDir()}, links: newInstallLinks()}
	os.MkdirAll(filepath.Dir(h.builder.packagePath(7)), 0o755)
	os.WriteFile(h.builder.packagePath(7), []byte("zipdata"), 0o644)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/packages/{token}", h.internalPackage)
	get := func(token string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", "/internal/packages/"+token, nil))
		return rec
	}

	token := h.links.create(7)
	if rec := get(token); rec.Code != 200 || rec.Body.String() != "zipdata" {
		t.Fatalf("第一次应该能下载：%d %q", rec.Code, rec.Body.String())
	}
	if rec := get(token); rec.Code != 404 {
		t.Fatalf("地址只能用一次，第二次应返回 404，实际 %d", rec.Code)
	}
	if rec := get("nope"); rec.Code != 404 {
		t.Fatalf("不认识的地址应返回 404，实际 %d", rec.Code)
	}

	expired := h.links.create(7)
	h.links.links[expired] = installLink{buildID: 7, expires: time.Now().Add(-time.Second)}
	if rec := get(expired); rec.Code != 404 {
		t.Fatalf("过期的地址应返回 404，实际 %d", rec.Code)
	}
	if len(h.links.links) != 0 {
		t.Fatalf("用过和过期的地址都应删掉，还剩 %d 个", len(h.links.links))
	}
}
