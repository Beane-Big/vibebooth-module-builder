#!/usr/bin/env node
// Vibebooth 模块命令：打包、打源码包、装到本机平台、启动前端开发服务器。
// 校验和打 zip 都交给平台的安装器镜像完成，所以本地打出的包和平台安装时用的是同一套规则。
//
//   node scripts/vb.mjs pack      生成 dist/<id>-<版本>.zip（要 Docker）
//   node scripts/vb.mjs source    生成 dist/<id>-<版本>-source.zip，上传到平台的构建器（不要 Docker）
//   node scripts/vb.mjs install   打包并装到本机平台
//   node scripts/vb.mjs dev       启动前端开发服务器
//   node scripts/vb.mjs rename <新 id> [新名称]   改模块 id 和名称，改 id 要在第一次装到平台之前
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
// 平台本体的 Compose 项目名，安装器镜像和容器都按它命名。
const platformProject = "home-platform";
// 打包时用安装器镜像检查模块包。本机跑着平台时用平台自己的，保证和要装进去的平台规则一致；
// 没有平台时用发布版，对应平台仓库的标签 installer/v<版本>。
const localInstaller = `${platformProject}-installer`;
const releasedInstaller = "ghcr.io/beane-big/vibebooth-installer:0.3.0";
const isWindows = process.platform === "win32";
// 容器里按本机用户写文件，生成的文件不归 root。Windows 上没有 uid，Docker Desktop 会自己处理文件属主。
const asUser = isWindows ? [] : ["--user", `${process.getuid()}:${process.getgid()}`];

function die(msg) {
  console.error("错误: " + msg);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  // Windows 上的 npm 是 npm.cmd，要经过 shell 才能运行。
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: isWindows && cmd === "npm", ...opts });
  if (res.error) die(`${cmd} 无法运行：${res.error.message}`);
  if (res.status !== 0) die(`${cmd} ${args[0]} 失败`);
  return res;
}

function output(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
  return res.status === 0 ? res.stdout.trim() : "";
}

function manifest() {
  const text = readFileSync(join(root, "module.yaml"), "utf8");
  const field = (name) => text.match(new RegExp(`^${name}:\\s*([^\\s#]+)`, "m"))?.[1];
  const id = field("id"), version = field("version");
  const name = text.match(/^name:\s*"([^"]*)"/m)?.[1] ?? "";
  if (!id || !version) die("module.yaml 里缺少 id 或 version");
  // 声明了特权的模块，装到本机平台时要带上 --allow-privileges，等于在门户上点了确认。
  const privileged = /^privileges:\s*\[\s*[a-z]/m.test(text);
  return { id, version, name, privileged };
}

// 前端镜像按 package-lock.json 安装依赖，还没有锁文件时先生成一个。
function ensureLockfile() {
  const frontend = join(root, "frontend");
  if (existsSync(join(frontend, "package.json")) && !existsSync(join(frontend, "package-lock.json"))) {
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: frontend });
  }
}

// requireDocker 在用 Docker 之前先确认它在运行；没运行时后面的报错看不出原因，比如会被当成“下载不了安装器镜像”。
function requireDocker() {
  if (output("docker", ["version", "--format", "{{.Server.Version}}"])) return;
  die("连不上 Docker。请先安装并启动 Docker（Windows 和 Mac 上是 Docker Desktop），等它显示运行中再重新运行。" +
    "不想装 Docker 的话，可以用 npm run pack:source 交给平台的构建器打包");
}

// installer 返回打包要用的安装器镜像，本机没有时下载发布版。
function installer() {
  if (output("docker", ["image", "inspect", localInstaller])) return localInstaller;
  if (output("docker", ["image", "inspect", releasedInstaller])) return releasedInstaller;
  console.log(`下载安装器镜像 ${releasedInstaller}…`);
  const res = spawnSync("docker", ["pull", releasedInstaller], { stdio: "inherit" });
  if (res.status !== 0) {
    die(`下载不了 ${releasedInstaller}。连不上 ghcr.io 时，可以改用 npm run pack:source 交给平台的构建器打包；` +
      "镜像还是私有的话，先用有 read:packages 权限的令牌运行 docker login ghcr.io；" +
      "也可以先在平台仓库里运行 docker compose up -d --build，改用本机平台的安装器");
  }
  return releasedInstaller;
}

function pack() {
  const { id, version } = manifest();
  requireDocker();
  const installerImage = installer();
  ensureLockfile();
  const env = { ...process.env, VERSION: version };
  const compose = ["compose", "-p", `mod-${id}`, "-f", "compose.yaml"];
  console.log(`构建 ${id} ${version} 的镜像…`);
  run("docker", [...compose, "build"], { env });
  const images = output("docker", [...compose, "config", "--images"], { env }).split(/\s+/).filter(Boolean);

  mkdirSync(join(root, "dist"), { recursive: true });
  const tmp = mkdtempSync(join(root, "dist", ".pack-"));
  try {
    console.log("导出镜像…");
    run("docker", ["save", "-o", join(tmp, "images.tar"), ...images]);
    const out = `dist/${id}-${version}.zip`;
    run("docker", ["run", "--rm", ...asUser, "-v", `${root}:/work`, "-w", "/work",
      installerImage, "pack", ".", `dist/${basename(tmp)}/images.tar`, out]);
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function install() {
  const { privileged } = manifest();
  const zip = pack();
  const container = output("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${platformProject}`,
    "--filter", "label=com.docker.compose.service=installer"]);
  if (!container) die("本机平台没有在运行，请先在平台仓库里运行 docker compose up -d");
  run("docker", ["cp", join(root, zip), `${container}:/tmp/package.zip`], { stdio: "ignore" });
  if (privileged) console.log("module.yaml 里声明了特权，本机安装时直接确认");
  run("docker", ["exec", container, "installer", "install", "/tmp/package.zip", ...(privileged ? ["--allow-privileges"] : [])]);
}

// ---- 源码包 ----

// 源码包里不放的东西：依赖、构建产物和本机缓存，服务器构建时会重新下载和生成。
const sourceExcludeNames = ["node_modules", ".git", ".cache"];
const sourceExcludeDirs = ["dist/", "frontend/dist/", "backend/vendor/"];

// sourceFiles 列出要放进源码包的文件。是 git 仓库时按 git 的规则（已提交的和没被 .gitignore 忽略的新文件），
// 否则遍历目录；两种情况都去掉上面这些目录。
function sourceFiles() {
  const skip = (f) =>
    f.split("/").some((part) => sourceExcludeNames.includes(part)) ||
    sourceExcludeDirs.some((d) => (f + "/").startsWith(d));
  const listed = output("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listed) return listed.split("\0").filter((f) => f && !skip(f) && existsSync(join(root, f)));
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      const rel = relative(root, p).split(sep).join("/");
      if (skip(rel)) return [];
      return e.isDirectory() ? walk(p) : e.isFile() ? [rel] : [];
    });
  return walk(root);
}

function source() {
  const { id, version } = manifest();
  ensureLockfile();
  const files = sourceFiles();
  mkdirSync(join(root, "dist"), { recursive: true });
  const out = `dist/${id}-${version}-source.zip`;
  writeFileSync(join(root, out), zip(files.map((f) => ({ name: f, path: join(root, f) }))));
  console.log(`已生成 ${out}（${files.length} 个文件），上传到平台“构建器”页面，服务器会构建出软件包`);
  return out;
}

// zip 用 Node 自带的 zlib 写一个普通的 zip 文件，保留文件的可执行权限，不需要额外的工具。
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, path } of entries) {
    const data = readFileSync(path);
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const mode = statSync(path).mode & 0o111 ? 0o100755 : 0o100644;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // 解压需要的版本
    header.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(0x00210000, 10); // 修改时间固定为 1980-01-01，同样的源码打出同样的包
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4); // 由 Unix 生成，这样解压时认得权限位
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE((mode << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += header.length + nameBuf.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

let crcTable;
function crc32(buf) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 改名 ----

// rename 把模块 id 和名称改到所有用到它们的地方：module.yaml、compose.yaml、网址前缀、容器和镜像名、
// 前端的 base 和 nginx 路径、后端的 moduleID 和路由、README 和 AGENTS.md。
// id 决定网址、容器名和数据卷，平台按 id 认模块：装到平台以后再改 id，平台会把它当成另一个应用，老数据不会跟过来。
function rename() {
  const [newId, newName] = process.argv.slice(3);
  const old = manifest();
  if (!newId) die("用法: npm run rename -- <新 id> [新名称]");
  // 和 create-vibebooth 生成时的规则一样，平台自己的服务名不能用作模块 id。
  const reserved = ["platform", "core", "portal", "traefik", "postgres", "socket", "installer", "build"];
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(newId) || reserved.includes(newId)) {
    die(`模块 id 只能是小写字母开头的小写字母、数字和连字符（2 到 31 个字符），且不能是 ${reserved.join("、")}`);
  }
  if (newName !== undefined && (!newName.trim() || /[<>{}$`"\\\n]/.test(newName))) {
    die("名称不能为空，也不能有 < > { } $ ` 引号、反斜杠或换行");
  }
  // 已安装的模块改了 id 就成了另一个模块，旧数据卷带不过去；只改名称不受影响。
  if (newId !== old.id && output("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=mod-${old.id}`])) {
    die(`${old.id} 已经装在本机平台上。先在门户“应用管理”页卸载它，再改 id`);
  }
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const o = esc(old.id);
  const idRules = [
    [new RegExp(`/(apps|api)/${o}(?![a-z0-9-])`, "g"), `/$1/${newId}`],
    [new RegExp(`(?<=^|[^a-z0-9-]|vb-|mod-|dist/)${o}(?=-[a-z0-9<])`, "gm"), newId],
    [new RegExp(`vibebooth-module-${o}(?![a-z0-9-])`, "g"), `vibebooth-module-${newId}`],
    [new RegExp(`^id: ${o}(?![a-z0-9-])`, "m"), `id: ${newId}`],
    [new RegExp(`moduleID = "${o}"`, "g"), `moduleID = "${newId}"`],
    [new RegExp(`"${o}(\\.db| 模块)`, "g"), `"${newId}$1`],
    [new RegExp(`（${o}）|\`${o}\``, "g"), (m) => m.replace(old.id, newId)],
  ];
  const nameRules = [];
  if (newName !== undefined && old.name) {
    const n = esc(old.name);
    nameRules.push(
      [new RegExp(`^(name|  - \\{id: home, name): "${n}"`, "gm"), `$1: "${newName}"`],
      [new RegExp(`<title>${n}</title>`, "g"), `<title>${newName}</title>`],
      [new RegExp(`(class(Name)?="title">)${n}<`, "g"), `$1${newName}<`],
      [new RegExp(`^(# |// )${n}(（| 的后端|$)`, "gm"), `$1${newName}$2`],
    );
  }
  let changed = 0;
  const leftovers = [];
  for (const f of sourceFiles()) {
    if (f.endsWith("package-lock.json") || !/\.(ya?ml|json|md|mjs|js|ts|tsx|vue|html|css|go|mod|conf)$|Dockerfile$/.test(f)) continue;
    const path = join(root, f);
    const text = readFileSync(path, "utf8");
    let next = text;
    for (const [re, to] of [...idRules, ...nameRules]) next = next.replace(re, to);
    if (next !== text) {
      writeFileSync(path, next);
      changed++;
    }
    if (newId !== old.id && new RegExp(`(?<![a-z0-9-])${o}(?![a-z0-9-])`).test(next)) leftovers.push(f);
  }
  const what = [newId !== old.id && `把 id 从 ${old.id} 改成 ${newId}`, newName && `把名称改成 ${newName}`].filter(Boolean);
  console.log(`${what.join("，") || "id 和名称都没变"}，改了 ${changed} 个文件`);
  if (leftovers.length) console.log(`这些文件里还有 ${old.id}，可能是普通文字，请自己看一下：\n  ${leftovers.join("\n  ")}`);
  if (newId !== old.id) console.log(`模块目录和 git 仓库的名字（vibebooth-module-${old.id}）不会自动改，需要的话自己改`);
}

function dev() {
  const frontend = join(root, "frontend");
  if (!existsSync(join(frontend, "package.json"))) die("这个模块的前端是纯静态页面，直接改 frontend/public/ 后运行 npm run install:local 即可");
  if (!existsSync(join(frontend, "node_modules"))) run("npm", ["install"], { cwd: frontend });
  run("npm", ["run", "dev"], { cwd: frontend });
}

const commands = { pack, source, install, dev, rename };
const cmd = commands[process.argv[2]];
if (!cmd) die("用法: node scripts/vb.mjs pack | source | install | dev | rename <新 id> [新名称]");
cmd();
