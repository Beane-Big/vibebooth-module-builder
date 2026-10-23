#!/usr/bin/env node
// Vibebooth 模块命令：打包、装到本机平台、下载后端依赖、启动前端开发服务器。
// 校验和打 zip 都交给平台的安装器镜像完成，所以本地打出的包和平台安装时用的是同一套规则。
//
//   node scripts/vb.mjs pack      生成 dist/<id>-<版本>.zip
//   node scripts/vb.mjs install   打包并装到本机平台
//   node scripts/vb.mjs vendor    把后端依赖下载到 backend/vendor/
//   node scripts/vb.mjs dev       启动前端开发服务器
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// 平台本体的 Compose 项目名，安装器镜像和容器都按它命名。
const platformProject = "home-platform";
// 打包时用安装器镜像检查模块包。本机跑着平台时用平台自己的，保证和要装进去的平台规则一致；
// 没有平台时用发布版，对应平台仓库的标签 installer/v<版本>。
const localInstaller = `${platformProject}-installer`;
const releasedInstaller = "ghcr.io/beane-big/vibebooth-installer:0.1.0";
const goImage = "golang:1.26";
const sdkModule = "github.com/Beane-Big/vibebooth/packages/sdk-go";
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
  if (!id || !version) die("module.yaml 里缺少 id 或 version");
  // 声明了特权的模块，装到本机平台时要带上 --allow-privileges，等于在门户上点了确认。
  const privileged = /^privileges:\s*\[\s*[a-z]/m.test(text);
  return { id, version, privileged };
}

// GitHub 令牌：优先用环境变量，否则问 git 有没有记住 github.com 的登录。仓库公开后不需要。
function githubToken() {
  if (process.env.VIBEBOOTH_GITHUB_TOKEN) return process.env.VIBEBOOTH_GITHUB_TOKEN;
  const res = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return res.status === 0 ? (res.stdout.match(/^password=(.*)$/m)?.[1] ?? "") : "";
}

// vendor 在 Go 容器里运行 go mod tidy 和 go mod vendor，本机不用装 Go。
// VIBEBOOTH_SDK_DIR 指向本地的 sdk-go 目录时改用本地 SDK，只在开发平台本身时用。
function vendor() {
  const backend = join(root, "backend");
  if (!existsSync(join(backend, "go.mod"))) return;
  console.log("下载后端依赖…");
  const cache = join(root, ".cache", "gomod");
  mkdirSync(cache, { recursive: true });
  const args = ["run", "--rm", ...asUser,
    "-v", `${backend}:/src`, "-v", `${cache}:/gomod`, "-w", "/src",
    "-e", "HOME=/tmp", "-e", "GOMODCACHE=/gomod", "-e", "GOPRIVATE=github.com/Beane-Big/*",
    "-e", "GH_TOKEN"];
  let script = 'if [ -n "$GH_TOKEN" ]; then git config --global url."https://x-access-token:$GH_TOKEN@github.com/".insteadOf "https://github.com/"; fi && ';
  if (process.env.VIBEBOOTH_SDK_DIR) {
    args.push("-v", `${resolve(process.env.VIBEBOOTH_SDK_DIR)}:/sdk:ro`);
    script += `go mod edit -replace ${sdkModule}=/sdk && `;
  }
  script += "go mod tidy && go mod vendor";
  args.push(goImage, "sh", "-c", script);
  run("docker", args, { env: { ...process.env, GH_TOKEN: githubToken() } });
}

// vendor 目录过期（不存在，或 go.mod / go.sum 比它新）时才重新下载。
function vendorIfNeeded() {
  const backend = join(root, "backend");
  if (!existsSync(join(backend, "go.mod"))) return;
  const modules = join(backend, "vendor", "modules.txt");
  const mtime = (f) => (existsSync(f) ? statSync(f).mtimeMs : 0);
  if (mtime(modules) < Math.max(mtime(join(backend, "go.mod")), mtime(join(backend, "go.sum")))) vendor();
}

// installer 返回打包要用的安装器镜像，本机没有时下载发布版。
function installer() {
  if (output("docker", ["image", "inspect", localInstaller])) return localInstaller;
  if (output("docker", ["image", "inspect", releasedInstaller])) return releasedInstaller;
  console.log(`下载安装器镜像 ${releasedInstaller}…`);
  const res = spawnSync("docker", ["pull", releasedInstaller], { stdio: "inherit" });
  if (res.status !== 0) {
    die(`下载不了 ${releasedInstaller}。镜像还是私有的话，先用有 read:packages 权限的令牌运行 docker login ghcr.io；` +
      "也可以先在平台仓库里运行 docker compose up -d --build，改用本机平台的安装器");
  }
  return releasedInstaller;
}

function pack() {
  const { id, version } = manifest();
  const installerImage = installer();
  vendorIfNeeded();
  // 前端镜像按 package-lock.json 安装依赖，还没有锁文件时先生成一个。
  const frontend = join(root, "frontend");
  if (existsSync(join(frontend, "package.json")) && !existsSync(join(frontend, "package-lock.json"))) {
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: frontend });
  }
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
  if (privileged) console.log("这个模块在 module.yaml 里声明了特权，按你的确认安装");
  run("docker", ["exec", container, "installer", "install", "/tmp/package.zip", ...(privileged ? ["--allow-privileges"] : [])]);
}

function dev() {
  const frontend = join(root, "frontend");
  if (!existsSync(join(frontend, "package.json"))) die("这个模块的前端是纯静态页面，直接改 frontend/public/ 后运行 npm run install:local 即可");
  if (!existsSync(join(frontend, "node_modules"))) run("npm", ["install"], { cwd: frontend });
  run("npm", ["run", "dev"], { cwd: frontend });
}

const commands = { pack, install, vendor, dev };
const cmd = commands[process.argv[2]];
if (!cmd) die("用法: node scripts/vb.mjs pack | install | vendor | dev");
cmd();
