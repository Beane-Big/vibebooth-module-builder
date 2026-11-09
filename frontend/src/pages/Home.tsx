import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
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
import { ArchiveIcon, CloseIcon, SettingsIcon, UploadIcon } from "../icons";

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
  // 选好的源码包，可以一次选多个；上传时一个一个传，每个成功后各自排进构建队列。
  const [files, setFiles] = useState<File[]>([]);
  // 上传没通过的源码包和原因，留在列表里给管理员看，改好后可以重新上传。
  const [fileErrors, setFileErrors] = useState(new Map<File, string>());
  // 正在上传第几个（从 0 开始），没在上传是 null。
  const [uploading, setUploading] = useState<number | null>(null);
  const busy = uploading !== null;
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

  // 构建中的记录在本页第一次读到时的起点（performance.now() 的时刻），用时从这里往后按秒走，之后刷新列表不再改它；刷新本页时重新从后端算。
  const starts = useRef(new Map<number, number>());

  function load() {
    api
      .builds()
      .then(({ data, serverTime }) => {
        const now = performance.now();
        for (const b of data)
          if (b.status === "building" && b.startedAt && !starts.current.has(b.id))
            // 取整到秒：之后每秒的重画正好落在整秒后面一点，不会偶尔跳过一秒。
            starts.current.set(b.id, now - Math.round(Math.max(0, serverTime - new Date(b.startedAt).getTime()) / 1000) * 1000);
        setBuilds(data);
      })
      .catch((err) => setError(err.message));
  }

  // elapsed 返回构建用了几秒：结束了的用后端记的开始和结束时间，构建中的从本页的起点算到现在。
  function elapsed(b: Build) {
    if (!b.startedAt) return null;
    if (b.finishedAt) return (new Date(b.finishedAt).getTime() - new Date(b.startedAt).getTime()) / 1000;
    const start = starts.current.get(b.id);
    return start === undefined ? 0 : (performance.now() - start) / 1000;
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

  // 有排队或构建中的记录时每隔几秒刷新一次列表，看状态有没有变。
  const running = builds.some(isRunning);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [running]);

  // 有构建中的记录时每秒重画一次，用时一秒一秒地走。
  const [, setTick] = useState(0);
  const building = builds.some((b) => b.status === "building");
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [building]);

  useEffect(() => {
    try {
      sessionStorage.setItem(AUTO_KEY, JSON.stringify(auto));
    } catch {
      // 浏览器不让存时只影响刷新后还记不记得，本页照常自动安装。
    }
  }, [auto]);

  // 等着自动安装的记录构建结束后，按上传顺序一次装一个；正在安装或等管理员确认时先不动，结束后再看下一个。
  // 构建器自己放到最后装：装它会换掉正在用的构建器，先装的话会打断后面的构建，还会停在确认上、挡住后面的安装。
  useEffect(() => {
    if (autoBusy.current || installing !== null || pending || confirming) return;
    const waiting = builds.filter((b) => auto.includes(b.id));
    const done = waiting.filter((b) => !isRunning(b)).sort((x, y) => x.id - y.id);
    const b = done.find((b) => b.moduleId !== SELF_ID) ?? (done.length === waiting.length ? done[0] : undefined);
    if (!b) return;
    setAuto((ids) => ids.filter((id) => id !== b.id));
    if (b.status !== "success") {
      setExpanded({ id: b.id, panel: "build" });
      return;
    }
    autoBusy.current = true;
    askInstall(b, true).finally(() => (autoBusy.current = false));
  }, [builds, auto, installing, pending, confirming]);

  // 选了或拖进来几个文件，加在已选的后面，同一个文件不重复加；文件变了就要重新确认“构建并安装”。
  function add(picked: File[]) {
    const same = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
    const fresh = picked.filter((f, i) => picked.findIndex((o) => same(o, f)) === i);
    setFiles((fs) => [...fs, ...fresh.filter((f) => !fs.some((o) => same(o, f)))]);
    setConfirmAuto(false);
    setError("");
  }

  function removeFile(f: File) {
    setFiles((fs) => fs.filter((o) => o !== f));
    setFileErrors((m) => {
      const next = new Map(m);
      next.delete(f);
      return next;
    });
    setConfirmAuto(false);
    setError("");
  }

  // 一个一个上传，每个通过检查的马上排进构建队列；没通过的留在列表里、写上原因，其他的照常上传。
  // installAfter 为 true 是“构建并安装”：构建成功后自动安装，不用再点“安装”。
  async function upload(e: FormEvent, installAfter = false) {
    e.preventDefault();
    if (!files.length) return;
    setConfirmAuto(false);
    setError("");
    setFileErrors(new Map());
    const failed = new Map<File, string>();
    let first: number | null = null;
    for (const [i, f] of files.entries()) {
      setUploading(i);
      try {
        const b = await api.upload(f);
        if (installAfter) setAuto((ids) => [...ids, b.id]);
        first ??= b.id;
        load();
      } catch (err) {
        failed.set(f, err instanceof Error ? err.message : "上传失败");
      }
    }
    setUploading(null);
    setFiles((fs) => fs.filter((f) => failed.has(f)));
    setFileErrors(failed);
    if (failed.size) setError(`${failed.size} 个源码包没能上传，原因写在文件下面；改好后可以重新上传。`);
    // 展开第一条新记录的日志，看得到构建开始了。
    if (first !== null) setExpanded({ id: first, panel: "build" });
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
    <main className="content stack">
      {me?.menus.includes("settings") && (
        <div className="page-head">
          <a className="pill" href="/apps/builder/settings/">
            <SettingsIcon />
            设置
          </a>
        </div>
      )}
      <form className="card stack" onSubmit={upload}>
        <h1>上传源码包</h1>
        <p className="muted">
          服务器会按仓库里的 compose.yaml 和 Dockerfile 构建出软件包。模块的 id、名称和版本都以源码包里的 module.yaml 为准。
        </p>
        <FileDrop
          files={files}
          errors={fileErrors}
          uploading={uploading}
          onAdd={add}
          onRemove={removeFile}
          onError={setError}
        />
        <div className="actions">
          <button type="submit" disabled={!files.length || busy || confirmAuto}>
            {busy ? uploadingText(uploading, files.length) : "开始构建"}
          </button>
          {me?.admin && (
            <button
              className={"secondary" + (confirmAuto ? " pressed" : "")}
              type="button"
              aria-expanded={confirmAuto}
              onClick={() => setConfirmAuto(!confirmAuto)}
              disabled={!files.length || busy}
            >
              构建并安装
            </button>
          )}
        </div>
        {confirmAuto && files.length > 0 && (
          <div className="confirm stack" role="group" aria-label="确认构建并安装">
            <p className="confirm-title">
              {files.length === 1 ? `确认构建并安装 ${files[0].name}？` : `确认构建并安装这 ${files.length} 个源码包？`}
            </p>
            <p className="muted">
              {files.length > 1 && "按上传顺序排队构建，成功一个装一个；其中有构建器自己的话放到最后装。"}
              构建成功后直接装到本平台，不再询问。等待期间不要关闭本页；降级或模块需要特权时，仍会在记录下方请你确认。
            </p>
            <div className="actions">
              <button type="button" onClick={(e) => upload(e, true)} disabled={busy}>
                {busy ? uploadingText(uploading, files.length) : "确认构建并安装"}
              </button>
              <button className="secondary" type="button" onClick={() => setConfirmAuto(false)} disabled={busy}>
                取消
              </button>
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </form>

      <section className="stack">
        <div className="section-head">
          <h1>构建记录</h1>
          {rules && (
            <p className="muted">
              每个应用的成功和失败记录各保留最近 {rules.maxPackages} 个，超过 {rules.maxDays}{" "}
              天的自动删除，软件包和日志一起删除。
            </p>
          )}
        </div>
        {builds.length === 0 && <p className="card muted">还没有构建过。</p>}
        <ul className="cards">
          {builds.map((b) => {
            const open = expanded?.id === b.id ? expanded.panel : null;
            const retention = rules && retentionText(b, builds, rules);
            const seconds = elapsed(b);
            return (
              <li key={b.id} className={"card build" + (open ? " selected" : "")}>
                <div className="build-head">
                  <div className="build-title">
                    <span className="item-name">
                      {b.moduleName}
                      <span className="version">{b.version}</span>
                    </span>
                    <span className={"tag tag-" + b.status}>{statusText[b.status]}</span>
                    {auto.includes(b.id) && <span className="tag">构建后安装</span>}
                    {installing === b.id ? (
                      <span className="tag tag-installing">安装中</span>
                    ) : (
                      b.installStatus && (
                        <span className={"tag tag-" + b.installStatus}>
                          {b.installStatus === "success" ? "已安装" : "安装失败"}
                        </span>
                      )
                    )}
                  </div>
                  {/* 每一项整体换行，“用时 3 分 10 秒”不会被拆到两行。 */}
                  <span className="muted meta">
                    {[
                      b.moduleId,
                      b.createdBy,
                      formatTime(b.createdAt),
                      seconds !== null && `用时 ${formatDuration(seconds)}`,
                      b.status === "success" && formatSize(b.packageSize),
                    ]
                      .filter(Boolean)
                      .map((text, i) => (
                        <span key={i}>{text}</span>
                      ))}
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
                          {b.installStatus ? "重新安装" : "安装"}
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
  );
}

// FileDrop 是选源码包的区域：点一下打开选文件，也可以把 zip 拖进来，一次可以选多个。
// 选好的列在上面，每个显示文件名和大小，可以单独去掉；下面的框还能继续添加。
function FileDrop({
  files,
  errors,
  uploading,
  onAdd,
  onRemove,
  onError,
}: {
  files: File[];
  errors: Map<File, string>;
  uploading: number | null;
  onAdd: (files: File[]) => void;
  onRemove: (f: File) => void;
  onError: (message: string) => void;
}) {
  const [over, setOver] = useState(false);
  const disabled = uploading !== null;

  function choose(list: FileList | null | undefined) {
    const picked = Array.from(list ?? []);
    const zips = picked.filter((f) => f.name.toLowerCase().endsWith(".zip"));
    if (zips.length) onAdd(zips);
    const skipped = picked.filter((f) => !zips.includes(f)).map((f) => f.name);
    if (skipped.length) onError(`只能上传 .zip 格式的源码包，没有加入：${skipped.join("、")}`);
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (!disabled) choose(e.dataTransfer.files);
  }

  return (
    <div className="stack files">
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${f.lastModified}`} className="drop picked">
              <span className="drop-icon">
                <ArchiveIcon />
              </span>
              <span className="drop-text">
                <span className="drop-name">{f.name}</span>
                <span className="muted">
                  {formatSize(f.size)}
                  {uploading === i && " · 上传中…"}
                  {uploading !== null && i > uploading && " · 等待上传"}
                </span>
                {errors.has(f) && <span className="error">{errors.get(f)}</span>}
              </span>
              <button
                type="button"
                className="icon"
                aria-label={`去掉 ${f.name}`}
                disabled={disabled}
                onClick={() => onRemove(f)}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label
        className={"drop" + (over ? " over" : "") + (files.length ? " more" : "") + (disabled ? " disabled" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <input
          className="sr-only"
          type="file"
          accept=".zip"
          multiple
          disabled={disabled}
          onChange={(e) => {
            choose(e.target.files);
            // 清掉输入框，去掉一个文件后还能再选回来。
            e.target.value = "";
          }}
        />
        <span className="drop-icon">
          <UploadIcon />
        </span>
        <span className="drop-text">
          {files.length ? (
            <>
              <span className="drop-name">继续添加源码包</span>
              <span className="muted">点击选择，或把 zip 拖到这里</span>
            </>
          ) : (
            <>
              <span className="drop-name">点击选择，或把 zip 拖到这里</span>
              <span className="muted">可以一次选多个；模块仓库打成的 zip，不要带 node_modules、dist</span>
            </>
          )}
        </span>
      </label>
    </div>
  );
}

// uploadingText 是上传时按钮上的字，传多个时带上进度。
function uploadingText(index: number | null, total: number) {
  return total > 1 && index !== null ? `上传中 ${index + 1}/${total}…` : "上传中…";
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

// formatDuration 把构建用的秒数写成“几分几秒”。
function formatDuration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatSize(bytes: number) {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
