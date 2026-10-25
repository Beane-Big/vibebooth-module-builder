import { useEffect, useState, type FormEvent } from "react";
import { api, type Settings as SettingsData } from "../api";

// 构建器的设置页，从门户“设置”页进入；保存时由后端检查“设置”菜单权限。
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

  return (
    <>
      <header className="topbar">
        <span className="title">构建器 · 设置</span>
      </header>
      <main className="content stack">
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
              <h1>镜像源</h1>
              <p className="muted">
                构建时作为 <code>NPM_REGISTRY</code> 和 <code>GOPROXY</code> 传给 Dockerfile，Dockerfile 里用 ARG
                声明了才会生效。留空表示不传，用官方源。
              </p>
              <label className="field">
                npm 镜像源
                <input
                  value={form.npmRegistry}
                  placeholder="例如 https://registry.npmmirror.com"
                  onChange={(e) => set({ npmRegistry: e.target.value })}
                />
              </label>
              <label className="field">
                Go 代理
                <input
                  value={form.goProxy}
                  placeholder="例如 https://goproxy.cn,direct"
                  onChange={(e) => set({ goProxy: e.target.value })}
                />
              </label>
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
    </>
  );
}
