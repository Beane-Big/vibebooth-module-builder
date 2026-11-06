export type Me = { name: string; menus: string[]; admin: boolean };

export type BuildStatus = "queued" | "building" | "success" | "failed";

export type Build = {
  id: number;
  moduleId: string;
  moduleName: string;
  version: string;
  status: BuildStatus;
  error: string;
  hint: string;
  packageSize: number;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  // 在构建器里点“安装”的结果；空表示没在这里装过。
  installStatus: "" | "success" | "failed";
  installedBy: string;
  installedAt: string | null;
};

// 保留规则：每个模块成功和失败的构建各留最近 maxPackages 个，超过 maxDays 天的删除。
export type Rules = { maxPackages: number; maxDays: number };

export type BuildDetail = { build: Build; log: string; logTruncated: boolean };

export type Settings = {
  maxPackages: number;
  maxDays: number;
  cacheGB: number;
  buildArgs: BuildArg[]; // 构建时只传给 Dockerfile 里用 ARG 声明了的那几个
};

export type BuildArg = { name: string; value: string };

export const statusText: Record<BuildStatus, string> = {
  queued: "排队中",
  building: "构建中",
  success: "成功",
  failed: "失败",
};

export const isRunning = (b: Build) => b.status === "queued" || b.status === "building";

// 平台安装器认识的特权和给管理员看的说明，和门户“应用管理”页一致。
export const privilegeInfo: Record<string, string> = {
  "docker-build": "在服务器上构建镜像。它碰不到平台自己的程序，但能替换其他应用的镜像，只安装你信任的模块。",
};

// 平台上已经装好的模块，安装前用来告诉管理员是新装、重装、升级还是降级。
export type Installed = { id: string; name: string; version: string };

// compareVersions 按 x.y.z 逐段比较版本号，a 比 b 新时返回正数。
export function compareVersions(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public log = "",
    public privileges: string[] = [],
  ) {
    super(message);
  }
}

// 调用本模块后端的对内接口和平台安装器；登录 Cookie 由浏览器自动带上，网关负责校验。
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await send<T>(path, init)).data;
}

// send 和 request 一样，另外带回响应头 Date 里的服务器时间（毫秒，读不到时用本机时间），用来算构建已经用了多久，不受本机时钟偏差影响。
async function send<T>(path: string, init?: RequestInit): Promise<{ data: T; serverTime: number }> {
  // 上传文件时由浏览器自己设置 multipart 的 Content-Type。
  const json = !(init?.body instanceof FormData);
  const res = await fetch(path, {
    ...init,
    headers: { ...(json && { "Content-Type": "application/json" }), ...init?.headers },
  });
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? "请求失败", body.log, body.privileges);
  }
  const data = res.status === 204 ? (undefined as T) : await res.json();
  const date = Date.parse(res.headers.get("Date") ?? "");
  return { data, serverTime: Number.isNaN(date) ? Date.now() : date };
}

export const packageUrl = (id: number) => `/api/builder/builds/${id}/package`;

export const api = {
  me: () => request<Me>("/api/builder/me"),
  builds: () => send<Build[]>("/api/builder/builds"),
  build: (id: number) => request<BuildDetail>(`/api/builder/builds/${id}`),
  upload: (file: File) => {
    const form = new FormData();
    form.append("source", file);
    return request<Build>("/api/builder/builds", { method: "POST", body: form });
  },
  removeBuild: (id: number) => request<void>(`/api/builder/builds/${id}`, { method: "DELETE" }),
  installLog: (id: number) => request<{ log: string }>(`/api/builder/builds/${id}/install`),
  saveInstall: (id: number, ok: boolean, log: string) =>
    request<void>(`/api/builder/builds/${id}/install`, { method: "PUT", body: JSON.stringify({ ok, log }) }),
  rules: () => request<Rules>("/api/builder/rules"),
  settings: () => request<Settings>("/api/builder/settings"),
  saveSettings: (s: Settings) => request<Settings>("/api/builder/settings", { method: "PUT", body: JSON.stringify(s) }),

  installed: () => request<Installed[]>("/api/platform/installer/modules"),
  // 一键安装在服务器上完成：先向后端要一个一次性的下载地址，再用管理员的登录把地址交给平台安装器，
  // 安装器在内部网络里直接下载软件包，几百 MB 的软件包也不用经过浏览器。
  // 模块声明了特权时安装器返回 409 和需要的特权，确认后带上 allowPrivileges 再装一次（地址只能用一次，会重新要）。
  install: async (b: Build, allowPrivileges = false) => {
    const { url } = await request<{ url: string }>(`/api/builder/builds/${b.id}/install-link`, { method: "POST" });
    const form = new FormData();
    form.append("url", url);
    if (allowPrivileges) form.append("allowPrivileges", "true");
    return request<{ log: string }>("/api/platform/installer/modules", { method: "POST", body: form });
  },
};
