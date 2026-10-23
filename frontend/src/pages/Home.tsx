import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  isRunning,
  packageUrl,
  privilegeInfo,
  statusText,
  type Build,
  type BuildDetail,
  type Me,
} from "../api";

// 构建器首页：上传源码包、查看构建记录和日志，成功的可以下载软件包或一键装到本平台。
export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [uploading, setUploading] = useState(false);

  function load() {
    api
      .builds()
      .then(setBuilds)
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((err) => setError(err.message));
    load();
  }, []);

  // 有排队或构建中的记录时每隔几秒刷新一次列表。
  const running = builds.some(isRunning);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [running]);

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const b = await api.upload(file);
      setFile(null);
      setFileKey((k) => k + 1);
      setSelected(b.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function remove(b: Build) {
    setError("");
    try {
      await api.removeBuild(b.id);
      if (selected === b.id) setSelected(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <>
      <header className="topbar">
        <a className="back" href="/">
          ← 返回应用
        </a>
        <span className="title">构建器</span>
      </header>
      <main className="content stack">
        <form className="card stack" onSubmit={upload}>
          <h1>上传源码包</h1>
          <p className="muted">
            上传模块仓库打成的 zip（不要带 node_modules、dist），服务器会按仓库里的 compose.yaml 和 Dockerfile
            构建出软件包。模块的 id、名称和版本都以源码包里的 module.yaml 为准。
          </p>
          <div className="actions">
            <input
              key={fileKey}
              type="file"
              accept=".zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={uploading}
            />
            <button type="submit" disabled={!file || uploading}>
              {uploading ? "上传中…" : "开始构建"}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </form>

        {selected !== null && <BuildView key={selected} id={selected} admin={me?.admin ?? false} onChange={load} />}

        <section className="card stack">
          <h1>构建记录</h1>
          {builds.length === 0 && <p className="muted">还没有构建过。</p>}
          <ul className="list">
            {builds.map((b) => (
              <li key={b.id} className={"list-item" + (b.id === selected ? " selected" : "")}>
                <div className="list-main">
                  <span className="item-name">
                    {b.moduleName} {b.version}
                    <span className={"tag tag-" + b.status}>{statusText[b.status]}</span>
                  </span>
                  <span className="muted">
                    {b.moduleId} · {b.createdBy} · {formatTime(b.createdAt)}
                    {b.status === "success" && ` · ${formatSize(b.packageSize)}`}
                  </span>
                </div>
                <div className="actions">
                  <button className="secondary" onClick={() => setSelected(b.id === selected ? null : b.id)}>
                    {b.id === selected ? "收起" : "日志"}
                  </button>
                  {b.status === "success" && (
                    <a className="secondary button" href={packageUrl(b.id)} download>
                      下载
                    </a>
                  )}
                  <button className="link" onClick={() => remove(b)}>
                    {b.status === "building" ? "取消" : "删除"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}

// BuildView 显示一次构建的日志，构建没结束时每两秒刷新；成功的管理员可以一键安装到本平台。
function BuildView({ id, admin, onChange }: { id: number; admin: boolean; onChange: () => void }) {
  const [detail, setDetail] = useState<BuildDetail | null>(null);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; log: string } | null>(null);
  // 模块声明了特权时，安装器先拒绝并列出特权，管理员确认后再带上 allowPrivileges 装一次。
  const [confirming, setConfirming] = useState<string[] | null>(null);

  const done = detail !== null && !isRunning(detail.build);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      api
        .build(id)
        .then((d) => {
          if (stopped) return;
          setDetail(d);
          if (isRunning(d.build)) timer = setTimeout(poll, 2000);
          else onChange();
        })
        .catch((err) => !stopped && setError(err.message));
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);

  async function install(allowPrivileges = false) {
    if (!detail) return;
    setConfirming(null);
    setInstalling(true);
    setResult(null);
    try {
      const { log } = await api.install(detail.build, allowPrivileges);
      setResult({
        ok: true,
        message: `${detail.build.moduleName} ${detail.build.version} 已安装，几秒后出现在应用列表里。`,
        log,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConfirming(err.privileges);
      } else {
        const log = err instanceof ApiError ? err.log : "";
        setResult({ ok: false, message: err instanceof Error ? err.message : "安装失败", log });
      }
    } finally {
      setInstalling(false);
    }
  }

  if (!detail)
    return (
      <section className="card">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</section>
    );
  const b = detail.build;
  return (
    <section className="card stack">
      <h1>
        {b.moduleName} {b.version} · {statusText[b.status]}
      </h1>
      {b.status === "queued" && <p className="muted">前面还有构建在进行，轮到时会自动开始。</p>}
      {b.status === "failed" && <p className="error">{b.error}</p>}
      {done && b.status === "success" && (
        <div className="actions">
          <a className="button" href={packageUrl(b.id)} download>
            下载软件包
          </a>
          {admin && (
            <button className="secondary" onClick={() => install()} disabled={installing}>
              {installing ? "安装中…" : "安装到本平台"}
            </button>
          )}
        </div>
      )}
      {installing && <p className="muted">正在导入镜像并启动，可能需要一两分钟。关掉页面也不会中断安装。</p>}
      {confirming && (
        <div className="stack">
          <p className="error">这个应用需要以下特权，确认后才会安装：</p>
          <ul>
            {confirming.map((p) => (
              <li key={p}>
                <code>{p}</code>：{privilegeInfo[p] ?? "平台不认识的特权"}
              </li>
            ))}
          </ul>
          <div className="actions">
            <button className="danger" onClick={() => install(true)} disabled={installing}>
              确认并安装
            </button>
            <button className="secondary" onClick={() => setConfirming(null)}>
              取消
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className="stack">
          <p className={result.ok ? "success" : "error"}>{result.message}</p>
          {result.log && (
            <details open={!result.ok}>
              <summary className="muted">安装日志</summary>
              <pre className="log">{result.log}</pre>
            </details>
          )}
        </div>
      )}
      <details open={b.status !== "success"}>
        <summary className="muted">构建日志{detail.logTruncated && "（太长，只显示最后一段）"}</summary>
        <pre className="log">{detail.log || "还没有日志"}</pre>
      </details>
    </section>
  );
}

function formatTime(s: string) {
  return new Date(s).toLocaleString("zh-CN", { hour12: false });
}

function formatSize(bytes: number) {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
