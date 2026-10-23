package main

import (
	"bytes"
	"fmt"
	"io"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
)

// progress 把 BuildKit 的进度消息（moby.buildkit.trace，protobuf 编码的 StatusResponse）
// 写成和 docker build --progress=plain 差不多的文字日志：
//
//	#3 [build 2/4] RUN npm ci
//	#3 1.234 added 120 packages
//	#3 DONE 5.6s
//
// 只解析用得到的字段，定义见 github.com/moby/buildkit/api/services/control/control.proto。
type progress struct {
	log      io.Writer
	vertexes map[string]*vertex
	next     int
}

type vertex struct {
	n         int
	name      string
	started   time.Time
	announced bool
	finished  bool
}

func newProgress(log io.Writer) *progress {
	return &progress{log: log, vertexes: map[string]*vertex{}}
}

func (p *progress) vertex(digest string) *vertex {
	v := p.vertexes[digest]
	if v == nil {
		p.next++
		v = &vertex{n: p.next}
		p.vertexes[digest] = v
	}
	return v
}

func (p *progress) announce(v *vertex) {
	if !v.announced && v.name != "" {
		v.announced = true
		fmt.Fprintf(p.log, "#%d %s\n", v.n, v.name)
	}
}

// write 处理一条 StatusResponse：1 是 Vertex，3 是 VertexLog，4 是 VertexWarning。解析不了的部分直接跳过。
func (p *progress) write(data []byte) {
	eachField(data, func(num protowire.Number, typ protowire.Type, b []byte) {
		if typ != protowire.BytesType {
			return
		}
		switch num {
		case 1:
			p.writeVertex(b)
		case 3:
			p.writeLog(b)
		case 4:
			p.writeWarning(b)
		}
	})
}

// Vertex: 1 digest, 3 name, 4 cached, 5 started, 6 completed, 7 error。
func (p *progress) writeVertex(b []byte) {
	var digest, name, errMsg string
	var cached bool
	var started, completed time.Time
	eachField(b, func(num protowire.Number, typ protowire.Type, f []byte) {
		switch {
		case num == 1 && typ == protowire.BytesType:
			digest = string(f)
		case num == 3 && typ == protowire.BytesType:
			name = string(f)
		case num == 4 && typ == protowire.VarintType:
			cached = len(f) > 0 && f[0] != 0
		case num == 5 && typ == protowire.BytesType:
			started = timestamp(f)
		case num == 6 && typ == protowire.BytesType:
			completed = timestamp(f)
		case num == 7 && typ == protowire.BytesType:
			errMsg = string(f)
		}
	})
	if digest == "" {
		return
	}
	v := p.vertex(digest)
	if name != "" {
		v.name = name
	}
	if !started.IsZero() {
		v.started = started
	}
	if started.IsZero() && completed.IsZero() && !cached {
		return // 还没开始的步骤先不显示
	}
	p.announce(v)
	if v.finished {
		return
	}
	switch {
	case errMsg != "":
		v.finished = true
		fmt.Fprintf(p.log, "#%d ERROR: %s\n", v.n, errMsg)
	case cached:
		v.finished = true
		fmt.Fprintf(p.log, "#%d CACHED\n", v.n)
	case !completed.IsZero():
		v.finished = true
		if v.started.IsZero() {
			fmt.Fprintf(p.log, "#%d DONE\n", v.n)
		} else {
			fmt.Fprintf(p.log, "#%d DONE %.1fs\n", v.n, completed.Sub(v.started).Seconds())
		}
	}
}

// VertexLog: 1 vertex, 2 timestamp, 4 msg。
func (p *progress) writeLog(b []byte) {
	var digest string
	var at time.Time
	var msg []byte
	eachField(b, func(num protowire.Number, typ protowire.Type, f []byte) {
		switch {
		case num == 1 && typ == protowire.BytesType:
			digest = string(f)
		case num == 2 && typ == protowire.BytesType:
			at = timestamp(f)
		case num == 4 && typ == protowire.BytesType:
			msg = f
		}
	})
	if digest == "" || len(msg) == 0 {
		return
	}
	v := p.vertex(digest)
	p.announce(v)
	prefix := fmt.Sprintf("#%d ", v.n)
	if !v.started.IsZero() && !at.IsZero() {
		prefix += fmt.Sprintf("%.3f ", at.Sub(v.started).Seconds())
	}
	for line := range bytes.Lines(msg) {
		io.WriteString(p.log, prefix+string(bytes.TrimRight(line, "\r\n"))+"\n")
	}
}

// VertexWarning: 1 vertex, 3 short。
func (p *progress) writeWarning(b []byte) {
	var digest string
	var short []byte
	eachField(b, func(num protowire.Number, typ protowire.Type, f []byte) {
		switch {
		case num == 1 && typ == protowire.BytesType:
			digest = string(f)
		case num == 3 && typ == protowire.BytesType:
			short = f
		}
	})
	if len(short) == 0 {
		return
	}
	n := 0
	if digest != "" {
		n = p.vertex(digest).n
	}
	fmt.Fprintf(p.log, "#%d WARN: %s\n", n, bytes.TrimSpace(short))
}

// timestamp 解析 google.protobuf.Timestamp：1 seconds，2 nanos。
func timestamp(b []byte) time.Time {
	var sec, nsec int64
	eachField(b, func(num protowire.Number, typ protowire.Type, f []byte) {
		if typ != protowire.VarintType {
			return
		}
		v, _ := protowire.ConsumeVarint(f)
		switch num {
		case 1:
			sec = int64(v)
		case 2:
			nsec = int64(v)
		}
	})
	if sec == 0 && nsec == 0 {
		return time.Time{}
	}
	return time.Unix(sec, nsec)
}

// eachField 遍历一条 protobuf 消息的字段。长度前缀类型的字段给出内容，varint 字段给出编码后的字节。
func eachField(b []byte, fn func(protowire.Number, protowire.Type, []byte)) {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return
		}
		b = b[n:]
		var value []byte
		switch typ {
		case protowire.BytesType:
			v, m := protowire.ConsumeBytes(b)
			if m < 0 {
				return
			}
			value, n = v, m
		default:
			n = protowire.ConsumeFieldValue(num, typ, b)
			if n < 0 {
				return
			}
			value = b[:n]
		}
		fn(num, typ, value)
		b = b[n:]
	}
}
