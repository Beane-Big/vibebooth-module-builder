package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// dockerClient 通过平台的构建代理调用 Docker 接口。构建代理只放行构建、查看、打标签、导出、删除 vb- 开头的模块镜像，
// 所以这里只用到这几个接口；安装器给声明了 docker-build 特权的模块设置了 DOCKER_HOST。
type dockerClient struct {
	base string
	http *http.Client
}

func newDockerClient(host string) (*dockerClient, error) {
	addr, ok := strings.CutPrefix(host, "tcp://")
	if !ok {
		return nil, fmt.Errorf("DOCKER_HOST 必须是 tcp:// 地址，实际是 %q；模块清单里要声明 privileges: [docker-build]", host)
	}
	return &dockerClient{base: "http://" + addr, http: &http.Client{}}, nil
}

func (d *dockerClient) do(ctx context.Context, method, path string, query url.Values, body io.Reader, contentType string) (*http.Response, error) {
	u := d.base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := d.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连接不上构建代理: %w", err)
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		return nil, &dockerError{status: res.StatusCode, msg: readMessage(res.Body)}
	}
	return res, nil
}

type dockerError struct {
	status int
	msg    string
}

func (e *dockerError) Error() string { return fmt.Sprintf("Docker 返回 %d: %s", e.status, e.msg) }

func isNotFound(err error) bool {
	var de *dockerError
	return errors.As(err, &de) && de.status == http.StatusNotFound
}

// readMessage 读出 Docker 或构建代理的错误信息，它们都是 {"message": "..."}。
func readMessage(r io.Reader) string {
	data, _ := io.ReadAll(io.LimitReader(r, 64<<10))
	var body struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &body) == nil && body.Message != "" {
		return body.Message
	}
	return strings.TrimSpace(string(data))
}

func (d *dockerClient) ping(ctx context.Context) error {
	res, err := d.do(ctx, http.MethodGet, "/_ping", nil, nil, "")
	if err != nil {
		return err
	}
	return res.Body.Close()
}

type buildOptions struct {
	Tag        string
	Dockerfile string
	BuildArgs  map[string]string
	Labels     map[string]string
}

// build 用 BuildKit 构建镜像，buildContext 是构建目录的 tar。构建过程按 docker build --progress=plain 的样子写进 log。
func (d *dockerClient) build(ctx context.Context, buildContext io.Reader, opts buildOptions, log io.Writer) error {
	q := url.Values{"version": {"2"}, "t": {opts.Tag}, "dockerfile": {opts.Dockerfile}, "rm": {"1"}, "forcerm": {"1"}}
	if len(opts.BuildArgs) > 0 {
		data, _ := json.Marshal(opts.BuildArgs)
		q.Set("buildargs", string(data))
	}
	if len(opts.Labels) > 0 {
		data, _ := json.Marshal(opts.Labels)
		q.Set("labels", string(data))
	}
	res, err := d.do(ctx, http.MethodPost, "/build", q, buildContext, "application/x-tar")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	progress := newProgress(log)
	dec := json.NewDecoder(bufio.NewReader(res.Body))
	for {
		var msg struct {
			ID     string          `json:"id"`
			Stream string          `json:"stream"`
			Aux    json.RawMessage `json:"aux"`
			Error  string          `json:"error"`
		}
		if err := dec.Decode(&msg); err == io.EOF {
			return nil
		} else if err != nil {
			return fmt.Errorf("读取构建输出失败: %w", err)
		}
		switch {
		case msg.Error != "":
			return errors.New(msg.Error)
		case msg.ID == "moby.buildkit.trace":
			var data []byte
			if err := json.Unmarshal(msg.Aux, &data); err == nil {
				progress.write(data)
			}
		case msg.Stream != "":
			io.WriteString(log, msg.Stream)
		}
	}
}

// imageID 返回镜像的 id，镜像不存在时返回空字符串。
func (d *dockerClient) imageID(ctx context.Context, name string) (string, error) {
	res, err := d.do(ctx, http.MethodGet, "/images/"+url.PathEscape(name)+"/json", nil, nil, "")
	if isNotFound(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct {
		ID string `json:"Id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", err
	}
	return body.ID, nil
}

// tag 给镜像 source 再起一个名字 name，两个都是 vb- 开头的模块镜像名。
func (d *dockerClient) tag(ctx context.Context, source, name string) error {
	repo, tag, _ := strings.Cut(name, ":")
	res, err := d.do(ctx, http.MethodPost, "/images/"+url.PathEscape(source)+"/tag", url.Values{"repo": {repo}, "tag": {tag}}, nil, "")
	if err != nil {
		return err
	}
	return res.Body.Close()
}

func (d *dockerClient) removeImage(ctx context.Context, name string) error {
	res, err := d.do(ctx, http.MethodDelete, "/images/"+url.PathEscape(name), nil, nil, "")
	if isNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return res.Body.Close()
}

// save 把镜像导出成 docker save 格式，写进 w。
func (d *dockerClient) save(ctx context.Context, names []string, w io.Writer) error {
	res, err := d.do(ctx, http.MethodGet, "/images/get", url.Values{"names": names}, nil, "")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, err = io.Copy(w, res.Body)
	return err
}

// pruneCache 清理构建缓存，先清最久没用的，直到不超过 maxBytes。和已有镜像共用的层不算在内，也不会被清掉。
// 新版 Docker 认 max-used-space，老版本只认 keep-storage，两个都传。
func (d *dockerClient) pruneCache(ctx context.Context, maxBytes int64) (int64, error) {
	n := strconv.FormatInt(maxBytes, 10)
	res, err := d.do(ctx, http.MethodPost, "/build/prune", url.Values{"keep-storage": {n}, "max-used-space": {n}}, nil, "")
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	var body struct {
		SpaceReclaimed int64 `json:"SpaceReclaimed"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	return body.SpaceReclaimed, nil
}
