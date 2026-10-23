package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
)

const testManifest = "id: demo\nname: 演示\nversion: 0.2.0\nservices:\n  backend: {port: 8000}\n"

const testCompose = "services:\n  demo-backend:\n    image: vb-demo-backend:${VERSION}\n    build: ./backend\n"

type zipFile struct {
	name string
	body string
	mode os.FileMode
}

func writeZip(t *testing.T, files ...zipFile) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source.zip")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for _, file := range files {
		h := &zip.FileHeader{Name: file.name, Method: zip.Deflate}
		mode := file.mode
		if mode == 0 {
			mode = 0o644
		}
		h.SetMode(mode)
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(w, file.body)
	}
	zw.Close()
	f.Close()
	return path
}

func moduleFiles(prefix string) []zipFile {
	return []zipFile{
		{name: prefix + "module.yaml", body: testManifest},
		{name: prefix + "compose.yaml", body: testCompose},
		{name: prefix + "backend/Dockerfile", body: "FROM scratch\n"},
		{name: prefix + "backend/main.go", body: "package main\n"},
	}
}

func TestInspectSource(t *testing.T) {
	for _, prefix := range []string{"", "vibebooth-module-demo-main/"} {
		src, err := inspectSource(writeZip(t, moduleFiles(prefix)...))
		if err != nil {
			t.Fatalf("%q: %v", prefix, err)
		}
		if src.manifest.ID != "demo" || len(src.targets) != 1 || src.targets[0].Context != "backend" {
			t.Errorf("%q: %+v", prefix, src)
		}
	}

	cases := map[string][]zipFile{
		"没有清单":          moduleFiles("")[1:],
		"两个顶层目录":        append(moduleFiles("a/"), zipFile{name: "b/x", body: "x"}),
		"清单不合规范":        {{name: "module.yaml", body: "id: core\n"}},
		"缺少构建目录":        moduleFiles("")[:2],
		"缺少 Dockerfile": {moduleFiles("")[0], moduleFiles("")[1], moduleFiles("")[3]},
	}
	for name, files := range cases {
		if _, err := inspectSource(writeZip(t, files...)); err == nil {
			t.Errorf("%s: 应该被拒绝", name)
		}
	}
}

func TestUnpack(t *testing.T) {
	dir := t.TempDir()
	files := append(moduleFiles("repo/"), zipFile{name: "repo/run.sh", body: "#!/bin/sh\n", mode: 0o755})
	if err := unpack(writeZip(t, files...), dir); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "backend", "Dockerfile")); string(data) != "FROM scratch\n" {
		t.Errorf("Dockerfile = %q", data)
	}
	if info, err := os.Stat(filepath.Join(dir, "run.sh")); err != nil || info.Mode().Perm() != 0o755 {
		t.Errorf("run.sh 应保留可执行权限: %v %v", info, err)
	}

	cases := map[string]zipFile{
		"跳出目录": {name: "../evil", body: "x"},
		"绝对路径": {name: "/etc/evil", body: "x"},
		"符号链接": {name: "link", body: "/etc/passwd", mode: os.ModeSymlink | 0o777},
		"反斜杠":  {name: `a\..\..\evil`, body: "x"},
	}
	for name, bad := range cases {
		if err := unpack(writeZip(t, append(moduleFiles(""), bad)...), t.TempDir()); err == nil {
			t.Errorf("%s: 应该被拒绝", name)
		}
	}
}

func TestContextTar(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"Dockerfile":          "FROM scratch\n",
		".dockerignore":       "node_modules\ndist\n*.log\n!keep.log\n",
		"src/main.ts":         "x",
		"node_modules/a/b.js": "x",
		"dist/index.html":     "x",
		"debug.log":           "x",
		"keep.log":            "x",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	var buf bytes.Buffer
	if err := contextTar(dir, "Dockerfile", &buf); err != nil {
		t.Fatal(err)
	}
	var got []string
	tr := tar.NewReader(&buf)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			got = append(got, h.Name)
		}
	}
	slices.Sort(got)
	want := []string{".dockerignore", "Dockerfile", "keep.log", "src/main.ts"}
	if !slices.Equal(got, want) {
		t.Errorf("构建目录里的文件 = %v，应为 %v", got, want)
	}
}

func TestProgress(t *testing.T) {
	ts := func(sec int64) []byte {
		return protowire.AppendVarint(protowire.AppendTag(nil, 1, protowire.VarintType), uint64(sec))
	}
	bytesField := func(b []byte, num protowire.Number, v []byte) []byte {
		return protowire.AppendBytes(protowire.AppendTag(b, num, protowire.BytesType), v)
	}
	vertex := func(digest, name string, started, completed int64, cached bool) []byte {
		var v []byte
		v = bytesField(v, 1, []byte(digest))
		v = bytesField(v, 3, []byte(name))
		if cached {
			v = protowire.AppendVarint(protowire.AppendTag(v, 4, protowire.VarintType), 1)
		}
		if started > 0 {
			v = bytesField(v, 5, ts(started))
		}
		if completed > 0 {
			v = bytesField(v, 6, ts(completed))
		}
		return bytesField(nil, 1, v)
	}
	logMsg := func(digest string, at int64, msg string) []byte {
		var v []byte
		v = bytesField(v, 1, []byte(digest))
		v = bytesField(v, 2, ts(at))
		v = bytesField(v, 4, []byte(msg))
		return bytesField(nil, 3, v)
	}
	var out strings.Builder
	p := newProgress(&out)
	p.write(vertex("a", "[1/2] FROM alpine", 0, 0, false)) // 还没开始，不显示
	p.write(vertex("b", "[2/2] RUN npm ci", 0, 0, true))
	p.write(vertex("a", "[1/2] FROM alpine", 100, 0, false))
	p.write(logMsg("a", 101, "line 1\nline 2\n"))
	p.write(vertex("a", "[1/2] FROM alpine", 100, 103, false))
	p.write(vertex("a", "[1/2] FROM alpine", 100, 103, false)) // 重复的完成消息不再显示
	p.write([]byte{0xff, 0xff})                                // 坏数据直接跳过
	want := "#2 [2/2] RUN npm ci\n#2 CACHED\n#1 [1/2] FROM alpine\n#1 1.000 line 1\n#1 1.000 line 2\n#1 DONE 3.0s\n"
	if out.String() != want {
		t.Errorf("日志 =\n%s\n应为\n%s", out.String(), want)
	}
}

func TestExpired(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	add := func(module, status string, age time.Duration) int64 {
		b := &Build{ModuleID: module, ModuleName: module, Version: "0.1.0", CreatedBy: "t"}
		if err := store.Add(ctx, b); err != nil {
			t.Fatal(err)
		}
		store.db.Exec(`UPDATE builds SET status = ?, created_at = ? WHERE id = ?`, status, time.Now().UTC().Add(-age), b.ID)
		return b.ID
	}
	old := add("a", statusSuccess, 40*24*time.Hour)
	var a []int64
	for range 3 {
		a = append(a, add("a", statusSuccess, time.Hour))
	}
	failed := add("a", statusFailed, time.Hour)
	add("b", statusSuccess, time.Hour)
	add("a", statusQueued, 40*24*time.Hour)

	got, err := store.Expired(ctx, 2, time.Now().AddDate(0, 0, -30))
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(got)
	if want := []int64{old, a[0]}; !slices.Equal(got, want) {
		t.Errorf("Expired = %v，应为 %v（失败的 %d 和排队的不该清理）", got, want, failed)
	}
}

func TestValidateSettings(t *testing.T) {
	if msg := validateSettings(defaultSettings); msg != "" {
		t.Errorf("默认设置应该合法: %s", msg)
	}
	bad := []Settings{
		{MaxPackages: 0, MaxDays: 30, CacheGB: 5},
		{MaxPackages: 5, MaxDays: 0, CacheGB: 5},
		{MaxPackages: 5, MaxDays: 30, CacheGB: 0},
		{MaxPackages: 5, MaxDays: 30, CacheGB: 5, NpmRegistry: "registry.npmmirror.com"},
		{MaxPackages: 5, MaxDays: 30, CacheGB: 5, GoProxy: "a b"},
	}
	for _, st := range bad {
		if validateSettings(st) == "" {
			t.Errorf("%+v 应该被拒绝", st)
		}
	}
}
