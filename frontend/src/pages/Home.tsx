import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  compareVersions,
  isRunning,
  packageUrl,
  privilegeInfo,
  statusText,
  type Build,
  type BuildDetail,
  type Installed,
  type Me,
  type Rules,
} from "../api";

// 展开在某条记录下方的内容：构建日志或安装日志，同一时间只展开一个。
type Expanded = { id: number; panel: "build" | "install" };

// 构建器自己的模块 id：装它会替换正在用的这个构建器。
const SELF_ID = "builder";

// 刚在本页装完的结果；安装日志保存在后端，保存失败时日志也留在这里，免得看不到。
type InstallNotice = { id: number; ok: boolean; message: string; log?: string };

// 点“构建并安装”上传的记录，构建成功后在本页自动安装。存在 sessionStorage 里，刷新本页不丢，关掉页签就不再自动装。
const AUTO_KEY = "builder:auto-install";

function loadAuto(): number[] {
  try {
    return JSON.parse(sessionStorage.getItem(AUTO_KEY) ?? "[]");
  } catch {
    return [];
  }
}

// 构建器首页：上传源码包、查看构建记录，日志在记录下方展开；成功的可以下载软件包或一键装到本平台。
export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [expanded, setExpanded] = useState<Expanded | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  // 点了“构建并安装”、等确认；换了文件就要重新确认。
  const [confirmAuto, setConfirmAuto] = useState(false);
  // 点了“删除”或“取消”、等确认的记录。
  const [removing, setRemoving] = useState<number | null>(null);
  const [installing, setInstalling] = useState<number | null>(null);
  // 点了“安装”、等确认的记录；current 是平台上已装的同一个模块，没装过是 null。
  const [pending, setPending] = useState<{ id: number; current: Installed | null } | null>(null);
  // 模块声明了特权时，安装器先拒绝并列出特权，管理员确认后再带上 allowPrivileges 装一次。
  const [confirming, setConfirming] = useState<{ id: number; privileges: string[]; current: Installed | null } | null>(
    null,
  );
  const [notice, setNotice] = useState<InstallNotice | null>(null);
  const [auto, setAuto] = useState<number[]>(loadAuto);
  // 正在查已装版本或安装的自动安装；查的时候 installing 还没设上，靠它避免同时开始装第二个。
  const autoBusy = useRef(false);

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
    api
      .rules()
      .then(setRules)
      .catch((err) => setError(err.message));
    load();
  }, []);

  // 有排队或构建中的记录时每隔几秒刷新一次列表，构建中的用时也跟着更新。
  const running = builds.some(isRunning);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    try {
      sessionStorage.setItem(AUTO_KEY, JSON.stringify(auto));
    } catch {
      // 浏览器不让存时只影响刷新后还记不记得，本页照常自动安装。
    }
  }, [auto]);

  // 等着自动安装的记录构建结束后，一次装一个；正在安装或等管理员确认时先不动，结束后再看下一个。
  useEffect(() => {
    if (autoBusy.current || installing !== null || pending || confirming) return;
    const b = builds.find((b) => auto.includes(b.id) && !isRunning(b));
    if (!b) return;
    setAuto((ids) => ids.filter((id) => id !== b.id));
    if (b.status !== "success") {
      setExpanded({ id: b.id, panel: "build" });
      return;
    }
    autoBusy.current = true;
    askInstall(b, true).finally(() => (autoBusy.current = false));
  }, [builds, auto, installing, pending, confirming]);

  // installAfter 为 true 是“构建并安装”：构建成功后自动安装，不用再点“安装”。
  async function upload(e: FormEvent, installAfter = false) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setConfirmAuto(false);
    setError("");
    try {
      const b = await api.upload(file);
      if (installAfter) setAuto((ids) => [...ids, b.id]);
      setFile(null);
      setFileKey((k) => k + 1);
      setExpanded({ id: b.id, panel: "build" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function remove(b: Build) {
    setRemoving(null);
    setError("");
    try {
      await api.removeBuild(b.id);
      setAuto((ids) => ids.filter((id) => id !== b.id));
      if (expanded?.id === b.id) setExpanded(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  function toggle(id: number, panel: Expanded["panel"]) {
    setExpanded(expanded?.id === id && expanded.panel === panel ? null : { id, panel });
  }

  // 点“安装”先查平台上装的是哪个版本，在记录下方请管理员确认。
  // 构建并安装（auto）时已经表明要装，直接安装；只有降级、或者装构建器自己时还有别的构建没结束，才照常请管理员确认。
  async function askInstall(b: Build, auto = false) {
    setConfirming(null);
    setNotice(null);
    setError("");
    try {
      const installed = await api.installed();
      const current = installed.find((m) => m.id === b.moduleId) ?? null;
      const downgrade = current !== null && compareVersions(b.version, current.version) < 0;
      if (auto && !downgrade && !(b.moduleId === SELF_ID && running)) return install(b, false, current);
      setPending({ id: b.id, current });
      setExpanded({ id: b.id, panel: "install" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取已安装的应用失败");
    }
  }

  // 一键安装：装完把结果和日志报给后端保存，记录上就会出现“安装日志”。
  // current 是平台上已装的同一个模块，用来决定装完后的提示；不传时从安装确认或特权确认里带过来。
  async function install(b: Build, allowPrivileges = false, current?: Installed | null) {
    if (current === undefined)
      current = pending?.id === b.id ? pending.current : confirming?.id === b.id ? confirming.current : null;
    setPending(null);
    setConfirming(null);
    setNotice(null);
    setInstalling(b.id);
    setExpanded({ id: b.id, panel: "install" });
    let ok = false;
    let message: string;
    let log = "";
    try {
      ({ log } = await api.install(b, allowPrivileges));
      ok = true;
      if (b.moduleId === SELF_ID) message = `构建器已更新为 ${b.version}，刷新本页后生效。`;
      else if (current) message = `${b.moduleName} 已更新为 ${b.version}，已经打开的页签刷新后生效。`;
      else message = `${b.moduleName} ${b.version} 已安装，几秒后出现在应用列表里。`;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConfirming({ id: b.id, privileges: err.privileges, current });
        setInstalling(null);
        return;
      }
      message = err instanceof Error ? err.message : "安装失败";
      if (err instanceof ApiError) log = err.log;
    }
    try {
      // 装的是构建器自己时，后端刚被换掉，网关要过一会儿才认出新容器，所以失败了隔两秒再试几次。
      await retry(() => api.saveInstall(b.id, ok, log), b.moduleId === SELF_ID ? 5 : 1);
      setNotice({ id: b.id, ok, message });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "保存失败";
      setNotice({ id: b.id, ok, message: `${message}（安装日志没能保存：${reason}）`, log });
    }
    setInstalling(null);
    load();
  }

  return (
    <>
      <header className="topbar">
        <span className="title">构建器</span>
        {me?.menus.includes("settings") && (
          <a className="nav" href="/apps/builder/settings/">
            设置
          </a>
        )}
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
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setConfirmAuto(false);
              }}
              disabled={uploading}
            />
            {confirmAuto ? (
              <>
                <button type="button" onClick={(e) => upload(e, true)} disabled={!file || uploading}>
                  {uploading ? "上传中…" : "确认构建并安装"}
                </button>
                <button className="secondary" type="button" onClick={() => setConfirmAuto(false)} disabled={uploading}>
                  取消
                </button>
              </>
            ) : (
              <>
                <button type="submit" disabled={!file || uploading}>
                  {uploading ? "上传中…" : "开始构建"}
                </button>
                {me?.admin && (
                  <button className="secondary" type="button" onClick={() => setConfirmAuto(true)} disabled={!file || uploading}>
                    构建并安装
                  </button>
                )}
              </>
            )}
          </div>
          {confirmAuto && file && (
            <p className="hint">
              构建 {file.name}，成功后直接装到本平台，不再询问。等待期间不要关闭本页；降级或模块需要特权时，仍会在记录下方请你确认。
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </form>

        <section className="card stack">
          <h1>构建记录</h1>
          {rules && (
            <p className="muted">
              每个应用的成功和失败记录各保留最近 {rules.maxPackages} 个，超过 {rules.maxDays}{" "}
              天的自动删除，软件包和日志一起删除。
            </p>
          )}
          {builds.length === 0 && <p className="muted">还没有构建过。</p>}
          <ul className="list">
            {builds.map((b) => {
              const open = expanded?.id === b.id ? expanded.panel : null;
              const retention = rules && retentionText(b, builds, rules);
              return (
                <li key={b.id} className={"list-item" + (open ? " selected" : "")}>
                  <div className="list-main">
                    <span className="item-name">
                      {b.moduleName} {b.version}
                      <span className={"tag tag-" + b.status}>{statusText[b.status]}</span>
                      {auto.includes(b.id) && <span className="tag">构建后安装</span>}
                      {b.installStatus && (
                        <span className={"tag tag-" + b.installStatus}>
                          {b.installStatus === "success" ? "已安装" : "安装失败"}
                        </span>
                      )}
                    </span>
                    <span className="muted">
                      {b.moduleId} · {b.createdBy} · {formatTime(b.createdAt)}
                      {b.startedAt && ` · 用时 ${formatDuration(b.startedAt, b.finishedAt)}`}
                      {b.status === "success" && ` · ${formatSize(b.packageSize)}`}
                    </span>
                    {retention && <span className="muted">{retention}</span>}
                  </div>
                  <div className="actions">
                    {removing === b.id ? (
                      <>
                        <button className="danger" onClick={() => remove(b)}>
                          {isRunning(b) ? "确认取消构建" : "确认删除"}
                        </button>
                        <button className="secondary" onClick={() => setRemoving(null)}>
                          {isRunning(b) ? "继续构建" : "不删除"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="secondary" onClick={() => toggle(b.id, "build")}>
                          {open === "build" ? "收起日志" : "日志"}
                        </button>
                        {(b.installStatus || installing === b.id || confirming?.id === b.id || pending?.id === b.id) && (
                          <button className="secondary" onClick={() => toggle(b.id, "install")}>
                            {open === "install" ? "收起安装日志" : "安装日志"}
                          </button>
                        )}
                        {b.status === "success" && (
                          <a className="secondary button" href={packageUrl(b.id)} download>
                            下载
                          </a>
                        )}
                        {b.status === "success" && me?.admin && (
                          <button className="secondary" onClick={() => askInstall(b)} disabled={installing !== null}>
                            {installing === b.id ? "安装中…" : b.installStatus ? "重新安装" : "安装"}
                          </button>
                        )}
                        <button className="link" onClick={() => setRemoving(b.id)} disabled={installing === b.id}>
                          {isRunning(b) ? "取消" : "删除"}
                        </button>
                      </>
                    )}
                  </div>
                  {open === "build" && <BuildLog id={b.id} onFinish={load} />}
                  {open === "install" && (
                    <div className="detail stack">
                      {installing === b.id && (
                        <p className="muted">正在导入镜像并启动，可能需要一两分钟。关掉页面也不会中断安装。</p>
                      )}
                      {pending?.id === b.id && (
                        <InstallConfirm
                          build={b}
                          current={pending.current}
                          busy={b.moduleId === SELF_ID && running}
                          onConfirm={() => install(b)}
                          onCancel={() => setPending(null)}
                        />
                      )}
                      {confirming?.id === b.id && (
                        <div className="stack">
                          <p className="error">这个应用需要以下特权，确认后才会安装：</p>
                          <ul>
                            {confirming.privileges.map((p) => (
                              <li key={p}>
                                <code>{p}</code>：{privilegeInfo[p] ?? "平台不认识的特权"}
                              </li>
                            ))}
                          </ul>
                          <div className="actions">
                            <button className="danger" onClick={() => install(b, true)}>
                              确认并安装
                            </button>
                            <button className="secondary" onClick={() => setConfirming(null)}>
                              取消
                            </button>
                          </div>
                        </div>
                      )}
                      {notice?.id === b.id && <p className={notice.ok ? "success" : "error"}>{notice.message}</p>}
                      {notice?.id === b.id && notice.log !== undefined ? (
                        <pre className="log">{notice.log || "安装器没有返回日志"}</pre>
                      ) : (
                        b.installStatus && <InstallLog key={b.installedAt} build={b} />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </main>
    </>
  );
}

// InstallConfirm 在安装前说明会发生什么：新装、重装、升级还是降级，装构建器自己时还要提醒会打断构建。
function InstallConfirm({
  build,
  current,
  busy,
  onConfirm,
  onCancel,
}: {
  build: Build;
  current: Installed | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const diff = current ? compareVersions(build.version, current.version) : 0;
  let text = `安装 ${build.moduleName} ${build.version}？`;
  if (current && diff === 0) text = `平台上已经装了${build.moduleName} ${current.version}，重新安装一次？`;
  if (current && diff > 0) text = `把${build.moduleName}从 ${current.version} 升级到 ${build.version}？`;
  return (
    <div className="stack">
      <p className={diff < 0 ? "error" : undefined}>
        {current && diff < 0
          ? `平台上装的是更新的 ${current.version}，确定要降级到 ${build.version} 吗？`
          : text}
      </p>
      {build.moduleId === SELF_ID && (
        <p className="hint">
          这会替换正在使用的构建器：安装期间正在进行的构建会中断，装完后要刷新本页才能用上新版本。
        </p>
      )}
      {busy && <p className="error">还有排队或构建中的记录，等它们结束后再安装构建器。</p>}
      <div className="actions">
        <button className={diff < 0 ? "danger" : undefined} onClick={onConfirm} disabled={busy}>
          确认安装
        </button>
        <button className="secondary" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// retry 最多调用 fn times 次，失败后隔两秒再试，最后一次的错误照常抛出。
async function retry(fn: () => Promise<void>, times: number) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= times) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// BuildLog 显示一次构建的日志，构建没结束时每两秒刷新，结束后通知列表刷新。
function BuildLog({ id, onFinish }: { id: number; onFinish: () => void }) {
  const [detail, setDetail] = useState<BuildDetail | null>(null);
  const [error, setError] = useState("");

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
          else onFinish();
        })
        .catch((err) => !stopped && setError(err.message));
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);

  if (!detail)
    return <div className="detail">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</div>;
  const b = detail.build;
  return (
    <div className="detail stack">
      {b.status === "queued" && <p className="muted">前面还有构建在进行，轮到时会自动开始。</p>}
      {b.status === "failed" && <p className="error">{b.error}</p>}
      {b.hint && <p className="hint">{b.hint}</p>}
      {detail.logTruncated && <p className="muted">日志太长，只显示最后一段。</p>}
      <pre className="log">{detail.log || "还没有日志"}</pre>
    </div>
  );
}

// InstallLog 显示在构建器里最近一次安装的结果和日志。
function InstallLog({ build }: { build: Build }) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .installLog(build.id)
      .then((r) => setLog(r.log))
      .catch((err) => setError(err.message));
  }, [build.id]);

  return (
    <>
      <p className="muted">
        {build.installedBy} 于 {build.installedAt && formatTime(build.installedAt)}{" "}
        {build.installStatus === "success" ? "安装成功" : "安装失败"}
      </p>
      {error && <p className="error">{error}</p>}
      {log !== null && <pre className="log">{log || "安装器没有返回日志"}</pre>}
    </>
  );
}

// retentionText 按保留规则说明这条记录什么时候会被删除；排队和构建中的不会被清理。
function retentionText(b: Build, builds: Build[], rules: Rules) {
  if (isRunning(b)) return "";
  // 列表按 id 从新到旧排，同一应用同一结果里排第几就是第几新的。
  const rank = builds.filter((o) => o.moduleId === b.moduleId && o.status === b.status && o.id >= b.id).length;
  const expires = new Date(b.createdAt);
  expires.setDate(expires.getDate() + rules.maxDays);
  const date = expires.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
  if (rank === rules.maxPackages) {
    const next = b.status === "success" ? "成功" : "失败";
    return `保留到 ${date}；这个应用再${next}构建一次就会删除`;
  }
  return `保留到 ${date}`;
}

function formatTime(s: string) {
  return new Date(s).toLocaleString("zh-CN", { hour12: false });
}

// formatDuration 算构建用时；还没结束的算到现在。
function formatDuration(start: string, end: string | null) {
  const seconds = Math.max(0, Math.round(((end ? new Date(end) : new Date()).getTime() - new Date(start).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatSize(bytes: number) {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
