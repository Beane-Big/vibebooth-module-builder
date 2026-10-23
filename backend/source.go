package main

import (
	"archive/tar"
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/Beane-Big/vibebooth/packages/manifest"
	"github.com/Beane-Big/vibebooth/packages/modpkg"
	"github.com/moby/patternmatcher"
	"github.com/moby/patternmatcher/ignorefile"
)

// 源码包的限制。源码包不含 node_modules、vendor 这类依赖，正常只有几 MB。
const (
	maxSourceSize   = 100 << 20
	maxUnpackedSize = 500 << 20
	maxSourceFiles  = 20000
)

// sourceRoot 是源码包里模块仓库根目录的位置：文件直接放在 zip 根目录，或者都在同一个目录下
// （例如 GitHub 下载的 <仓库名>-main/）。
type sourceRoot struct {
	prefix string
}

func findRoot(zr *zip.Reader) (sourceRoot, error) {
	for _, f := range zr.File {
		if f.Name == modpkg.ManifestFile {
			return sourceRoot{}, nil
		}
	}
	var top string
	for _, f := range zr.File {
		dir, _, ok := strings.Cut(f.Name, "/")
		if !ok || (top != "" && dir != top) {
			return sourceRoot{}, errors.New("源码包的根目录里没有 module.yaml")
		}
		top = dir
	}
	for _, f := range zr.File {
		if f.Name == top+"/"+modpkg.ManifestFile {
			return sourceRoot{prefix: top + "/"}, nil
		}
	}
	return sourceRoot{}, errors.New("源码包的根目录里没有 module.yaml")
}

// source 是检查过的源码包：清单、转换后的 compose 和要构建的服务。
type source struct {
	manifest *manifest.Manifest
	targets  []modpkg.BuildTarget
}

// inspectSource 在上传时检查源码包：清单和 compose.yaml 用平台安装时的同一套规则校验，不合规范的直接拒绝，不进入构建队列。
func inspectSource(path string) (*source, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, errors.New("不是有效的 zip 文件")
	}
	defer zr.Close()
	root, err := findRoot(&zr.Reader)
	if err != nil {
		return nil, err
	}
	var fsys fs.FS = zr
	if root.prefix != "" {
		if fsys, err = fs.Sub(zr, strings.TrimSuffix(root.prefix, "/")); err != nil {
			return nil, err
		}
	}
	return checkSource(fsys)
}

// inspectDir 检查解压后的模块目录，规则和 inspectSource 一样。
func inspectDir(dir string) (*source, error) { return checkSource(os.DirFS(dir)) }

func checkSource(fsys fs.FS) (*source, error) {
	read := func(name string) ([]byte, error) {
		f, err := fsys.Open(name)
		if err != nil {
			return nil, fmt.Errorf("源码包里没有 %s", name)
		}
		defer f.Close()
		return io.ReadAll(io.LimitReader(f, 1<<20))
	}
	data, err := read(modpkg.ManifestFile)
	if err != nil {
		return nil, err
	}
	m, err := manifest.Parse(data)
	if err != nil {
		return nil, err
	}
	data, err = read(modpkg.ComposeFile)
	if err != nil {
		return nil, err
	}
	_, targets, err := modpkg.DevCompose(m, data)
	if err != nil {
		return nil, err
	}
	if m.Icon != "" {
		if _, err := fs.Stat(fsys, m.Icon); err != nil {
			return nil, fmt.Errorf("module.yaml 写了图标 %s，源码包里没有这个文件", m.Icon)
		}
	}
	for _, t := range targets {
		dir := t.Context
		if info, err := fs.Stat(fsys, dir); err != nil || !info.IsDir() {
			return nil, fmt.Errorf("服务 %s 的构建目录 %s 不存在", t.Service, dir)
		}
		if _, err := fs.Stat(fsys, path.Join(dir, t.Dockerfile)); err != nil {
			return nil, fmt.Errorf("服务 %s 的构建目录里没有 %s", t.Service, t.Dockerfile)
		}
	}
	return &source{manifest: m, targets: targets}, nil
}

// unpack 把源码包解压到 dir。只解压普通文件和目录：路径不能是绝对路径或跳出 dir，不能有符号链接，总大小和文件数有上限。
func unpack(zipPath, dir string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	root, err := findRoot(&zr.Reader)
	if err != nil {
		return err
	}
	if len(zr.File) > maxSourceFiles {
		return fmt.Errorf("源码包里的文件超过 %d 个，是不是把 node_modules 也打进去了", maxSourceFiles)
	}
	var total int64
	for _, f := range zr.File {
		name := strings.TrimPrefix(f.Name, root.prefix)
		if name == "" {
			continue
		}
		clean := path.Clean(name)
		if !fs.ValidPath(clean) || strings.Contains(name, `\`) {
			return fmt.Errorf("源码包里的路径 %q 不合法", f.Name)
		}
		target := filepath.Join(dir, filepath.FromSlash(clean))
		mode := f.Mode()
		switch {
		case mode.IsDir():
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		case !mode.IsRegular():
			return fmt.Errorf("源码包里的 %s 不是普通文件（不支持符号链接）", f.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		perm := os.FileMode(0o644)
		if mode&0o111 != 0 {
			perm = 0o755
		}
		n, err := unpackFile(f, target, perm, maxUnpackedSize-total)
		if err != nil {
			return err
		}
		total += n
	}
	return nil
}

func unpackFile(f *zip.File, target string, perm os.FileMode, limit int64) (int64, error) {
	r, err := f.Open()
	if err != nil {
		return 0, err
	}
	defer r.Close()
	w, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return 0, fmt.Errorf("解压 %s 失败: %w", f.Name, err)
	}
	defer w.Close()
	n, err := io.Copy(w, io.LimitReader(r, limit+1))
	if err != nil {
		return n, fmt.Errorf("解压 %s 失败: %w", f.Name, err)
	}
	if n > limit {
		return n, fmt.Errorf("源码包解压后超过 %d MB", maxUnpackedSize>>20)
	}
	return n, w.Close()
}

// contextTar 把构建目录打成 tar 写进 w，和 docker build 一样按目录里的 .dockerignore 排除文件；
// Dockerfile 和 .dockerignore 本身总会带上。
func contextTar(dir, dockerfile string, w io.Writer) error {
	var patterns []string
	if f, err := os.Open(filepath.Join(dir, ".dockerignore")); err == nil {
		patterns, err = ignorefile.ReadAll(f)
		f.Close()
		if err != nil {
			return fmt.Errorf(".dockerignore 格式错误: %w", err)
		}
	}
	pm, err := patternmatcher.New(patterns)
	if err != nil {
		return fmt.Errorf(".dockerignore 格式错误: %w", err)
	}
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(dockerfile))); err != nil {
		return fmt.Errorf("构建目录里没有 %s", dockerfile)
	}
	tw := tar.NewWriter(w)
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil || rel == "." {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel != dockerfile && rel != ".dockerignore" {
			skip, err := pm.MatchesOrParentMatches(rel)
			if err != nil {
				return err
			}
			// 目录被排除时，里面还可能有用 ! 重新包含的文件，只有没有 ! 规则时才整个跳过。
			if skip && d.IsDir() && !pm.Exclusions() {
				return filepath.SkipDir
			}
			if skip {
				return nil
			}
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		h, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		h.Name = rel
		h.Uid, h.Gid, h.Uname, h.Gname = 0, 0, "", ""
		if d.IsDir() {
			h.Name += "/"
		}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	return tw.Close()
}
