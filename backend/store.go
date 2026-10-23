package main

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

// 构建状态。
const (
	statusQueued   = "queued"
	statusBuilding = "building"
	statusSuccess  = "success"
	statusFailed   = "failed"
)

// Build 是一次构建：上传的源码包、构建日志和打出的软件包都按 id 存在数据目录里。
type Build struct {
	ID          int64      `json:"id"`
	ModuleID    string     `json:"moduleId"`
	ModuleName  string     `json:"moduleName"`
	Version     string     `json:"version"`
	Status      string     `json:"status"`
	Error       string     `json:"error"`
	PackageSize int64      `json:"packageSize"`
	CreatedBy   string     `json:"createdBy"`
	CreatedAt   time.Time  `json:"createdAt"`
	StartedAt   *time.Time `json:"startedAt"`
	FinishedAt  *time.Time `json:"finishedAt"`
}

// Settings 是构建器的设置，管理员在设置页修改。
type Settings struct {
	MaxPackages int    `json:"maxPackages"` // 每个模块最多保留几个软件包
	MaxDays     int    `json:"maxDays"`     // 软件包最多保留几天
	CacheGB     int    `json:"cacheGB"`     // 构建缓存（下载的依赖、没变的构建步骤）最多占多少 GB
	NpmRegistry string `json:"npmRegistry"` // 构建时传给 Dockerfile 的 NPM_REGISTRY，空表示不传
	GoProxy     string `json:"goProxy"`     // 构建时传给 Dockerfile 的 GOPROXY，空表示不传
}

var defaultSettings = Settings{MaxPackages: 5, MaxDays: 30, CacheGB: 5}

type Store struct {
	db *sql.DB
}

// 表结构在启动时创建；以后加字段用 ALTER TABLE，并保证老数据还能读。
const schema = `
CREATE TABLE IF NOT EXISTS builds (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	module_id    TEXT NOT NULL,
	module_name  TEXT NOT NULL,
	version      TEXT NOT NULL,
	status       TEXT NOT NULL,
	error        TEXT NOT NULL DEFAULT '',
	package_size INTEGER NOT NULL DEFAULT 0,
	created_by   TEXT NOT NULL,
	created_at   TIMESTAMP NOT NULL,
	started_at   TIMESTAMP,
	finished_at  TIMESTAMP
);
CREATE INDEX IF NOT EXISTS builds_module ON builds (module_id, id);
CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`

// OpenStore 打开模块自己的 SQLite 文件；数据库只属于本模块，放在本模块的卷里。
func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	// SQLite 同一时间只允许一个写入者，单连接可以避免 "database is locked"。
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

const buildColumns = `id, module_id, module_name, version, status, error, package_size, created_by, created_at, started_at, finished_at`

type scanner interface{ Scan(dest ...any) error }

func scanBuild(row scanner) (*Build, error) {
	var b Build
	var started, finished sql.NullTime
	err := row.Scan(&b.ID, &b.ModuleID, &b.ModuleName, &b.Version, &b.Status, &b.Error, &b.PackageSize,
		&b.CreatedBy, &b.CreatedAt, &started, &finished)
	if err != nil {
		return nil, err
	}
	if started.Valid {
		b.StartedAt = &started.Time
	}
	if finished.Valid {
		b.FinishedAt = &finished.Time
	}
	return &b, nil
}

func (s *Store) query(ctx context.Context, where string, args ...any) ([]Build, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+buildColumns+` FROM builds `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Build{}
	for rows.Next() {
		b, err := scanBuild(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, *b)
	}
	return list, rows.Err()
}

func (s *Store) List(ctx context.Context) ([]Build, error) {
	return s.query(ctx, `ORDER BY id DESC LIMIT 200`)
}

// ErrNotFound 表示构建记录不存在。
var ErrNotFound = errors.New("构建记录不存在")

func (s *Store) Get(ctx context.Context, id int64) (*Build, error) {
	b, err := scanBuild(s.db.QueryRowContext(ctx, `SELECT `+buildColumns+` FROM builds WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return b, err
}

func (s *Store) Add(ctx context.Context, b *Build) error {
	b.Status = statusQueued
	b.CreatedAt = time.Now().UTC()
	res, err := s.db.ExecContext(ctx, `INSERT INTO builds (module_id, module_name, version, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		b.ModuleID, b.ModuleName, b.Version, b.Status, b.CreatedBy, b.CreatedAt)
	if err != nil {
		return err
	}
	b.ID, err = res.LastInsertId()
	return err
}

func (s *Store) Start(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE builds SET status = ?, started_at = ? WHERE id = ?`, statusBuilding, time.Now().UTC(), id)
	return err
}

func (s *Store) Finish(ctx context.Context, id int64, buildErr error, packageSize int64) error {
	status, msg := statusSuccess, ""
	if buildErr != nil {
		status, msg = statusFailed, buildErr.Error()
	}
	_, err := s.db.ExecContext(ctx, `UPDATE builds SET status = ?, error = ?, package_size = ?, finished_at = ? WHERE id = ?`,
		status, msg, packageSize, time.Now().UTC(), id)
	return err
}

// Recover 在启动时处理上次没做完的构建：正在构建的记为失败，排队的返回给调用方重新排队。
func (s *Store) Recover(ctx context.Context) ([]int64, error) {
	_, err := s.db.ExecContext(ctx, `UPDATE builds SET status = ?, error = ?, finished_at = ? WHERE status = ?`,
		statusFailed, "构建器重启，构建中断，请重新上传", time.Now().UTC(), statusBuilding)
	if err != nil {
		return nil, err
	}
	queued, err := s.query(ctx, `WHERE status = ? ORDER BY id`, statusQueued)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, len(queued))
	for i, b := range queued {
		ids[i] = b.ID
	}
	return ids, nil
}

func (s *Store) Delete(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM builds WHERE id = ?`, id)
	return err
}

// Expired 返回按保留规则该清理的构建：每个模块成功和失败的构建各只留最新的 keep 个，早于 before 的都清理。
// 排队和构建中的不清理。
func (s *Store) Expired(ctx context.Context, keep int, before time.Time) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id FROM (
			SELECT id, created_at, ROW_NUMBER() OVER (PARTITION BY module_id, status ORDER BY id DESC) AS n
			FROM builds WHERE status IN (?, ?)
		) WHERE n > ? OR created_at < ?`, statusSuccess, statusFailed, keep, before.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) Settings(ctx context.Context) (Settings, error) {
	st := defaultSettings
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM settings`)
	if err != nil {
		return st, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return st, err
		}
		n, _ := strconv.Atoi(value)
		switch key {
		case "maxPackages":
			st.MaxPackages = n
		case "maxDays":
			st.MaxDays = n
		case "cacheGB":
			st.CacheGB = n
		case "npmRegistry":
			st.NpmRegistry = value
		case "goProxy":
			st.GoProxy = value
		}
	}
	return st, rows.Err()
}

func (s *Store) SaveSettings(ctx context.Context, st Settings) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	values := map[string]string{
		"maxPackages": strconv.Itoa(st.MaxPackages),
		"maxDays":     strconv.Itoa(st.MaxDays),
		"cacheGB":     strconv.Itoa(st.CacheGB),
		"npmRegistry": st.NpmRegistry,
		"goProxy":     st.GoProxy,
	}
	for key, value := range values {
		if _, err := tx.ExecContext(ctx, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value); err != nil {
			return err
		}
	}
	return tx.Commit()
}
