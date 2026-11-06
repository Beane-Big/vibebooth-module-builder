import { useEffect, useState, type FormEvent } from "react";
import { api, type BuildArg, type Settings as SettingsData } from "../api";
import { BackIcon } from "../icons";

// 构建器的设置页，从首页右上角的“设置”进入，左上角“构建记录”回首页；保存时由后端检查“设置”菜单权限。
export default function Settings() {
  const [form, setForm] = useState<SettingsData | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .settings()
      .then(setForm)
      .catch((err) => setError(err.message));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setForm(await api.saveSettings(form));
      setMessage("已保存，下一次构建开始生效。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<SettingsData>) => form && setForm({ ...form, ...patch });
  const setArg = (i: number, patch: Partial<BuildArg>) =>
    form && set({ buildArgs: form.buildArgs.map((a, k) => (k === i ? { ...a, ...patch } : a)) });

  return (
    <main className="content stack">
      <div className="page-head">
        <a className="pill" href="/apps/builder/">
          <BackIcon />
          构建记录
        </a>
        <h1 className="page-title">设置</h1>
      </div>
      {!form && (error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>)}
      {form && (
        <form className="stack" onSubmit={save}>
          <section className="card stack">
            <h1>保留规则</h1>
            <p className="muted">
              每次构建完和每小时检查一次，超出的构建记录连同软件包一起删除。成功和失败的记录分别计数。
            </p>
            <label className="field">
              每个应用保留最近几个软件包
              <input
                type="number"
                min={1}
                max={50}
                value={form.maxPackages}
                onChange={(e) => set({ maxPackages: e.target.valueAsNumber })}
              />
            </label>
            <label className="field">
              最多保留几天
              <input
                type="number"
                min={1}
                max={365}
                value={form.maxDays}
                onChange={(e) => set({ maxDays: e.target.valueAsNumber })}
              />
            </label>
            <label className="field">
              构建缓存上限（GB）
              <span className="muted">
                下载过的依赖和没变的构建步骤会缓存起来，下次构建更快；超过上限时先清理最久没用的。
              </span>
              <input
                type="number"
                min={1}
                max={100}
                value={form.cacheGB}
                onChange={(e) => set({ cacheGB: e.target.valueAsNumber })}
              />
            </label>
          </section>
          <section className="card stack">
            <h1>构建参数</h1>
            <p className="muted">
              按服务器的网络填写，比如国内的镜像源。构建时构建器读每个应用的 Dockerfile，只把其中用{" "}
              <code>ARG</code> 声明了的参数传过去，没填的用 Dockerfile 里的默认值；构建日志里会列出每个参数传了什么。应用需要哪些参数看应用的说明，常见的有 <code>NPM_REGISTRY</code>（如 https://registry.npmmirror.com）、
              <code>GOPROXY</code>（如 https://goproxy.cn,direct）。
            </p>
            {form.buildArgs.map((a, i) => (
              <div className="arg-row" key={i}>
                <input
                  value={a.name}
                  placeholder="参数名，例如 NPM_REGISTRY"
                  aria-label="参数名"
                  onChange={(e) => setArg(i, { name: e.target.value })}
                />
                <input
                  value={a.value}
                  placeholder="值"
                  aria-label="值"
                  onChange={(e) => setArg(i, { value: e.target.value })}
                />
                <button type="button" className="link" onClick={() => set({ buildArgs: form.buildArgs.filter((_, k) => k !== i) })}>
                  删除
                </button>
              </div>
            ))}
            <div>
              <button type="button" className="secondary" onClick={() => set({ buildArgs: [...form.buildArgs, { name: "", value: "" }] })}>
                添加参数
              </button>
            </div>
          </section>
          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </button>
            {message && <span className="success">{message}</span>}
            {error && <span className="error">{error}</span>}
          </div>
        </form>
      )}
    </main>
  );
}
