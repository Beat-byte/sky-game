import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeFile = join(root, ".dev-server.json");
const logDir = join(root, ".dev-logs");
const logFile = join(logDir, "server.log");
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const IDENTITY_HEADER = "x-sky-games";

const args = process.argv.slice(2);
const command = args[0] ?? "status";
// 模式：dev = Vite 开发服务器（默认 5173）；preview = 构建产物预览（默认 4173）
const mode = args.includes("preview") ? "preview" : "dev";
const DEFAULT_PORT = { dev: 5173, preview: 4173 };
const portFlag = args.indexOf("--port");
const wantedPort =
  portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.PORT ?? DEFAULT_PORT[mode]);

function cmdline(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRecord() {
  if (!existsSync(runtimeFile)) return null;
  try {
    return JSON.parse(readFileSync(runtimeFile, "utf8"));
  } catch {
    return null;
  }
}

/** 记录里的进程必须真的是本项目拉起的 Vite，避免 PID 复用或残留记录误判 */
function runningInfo({ clean = true } = {}) {
  const info = readRecord();
  if (!info) return null;
  if (isAlive(info.pid) && cmdline(info.pid).includes("vite")) return info;
  if (clean) {
    rmSync(runtimeFile, { force: true });
    console.log(`已清理失效记录（进程 ${info.pid} 不是运行中的 Vite 服务）`);
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tailLog(lines = 20) {
  if (!existsSync(logFile)) return "（还没有日志）";
  return readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

/** Vite 会把实际端口打在 “Local: http://localhost:5173/” 里，被占用时会自动顺延 */
function parseLocalUrl(chunk) {
  const match = chunk.match(/http:\/\/localhost:(\d+)\/?/);
  if (!match) return null;
  return { url: `http://localhost:${match[1]}`, port: Number(match[1]) };
}

async function start() {
  const existing = runningInfo();
  if (existing) {
    console.log(`已在运行（${existing.mode}）： ${existing.url}（进程 ${existing.pid}）`);
    console.log("需要换端口先执行 npm run stop，或 PORT=8080 npm run dev");
    return;
  }
  if (!existsSync(viteBin)) {
    console.log("找不到 node_modules/vite，请先执行 npm install");
    process.exitCode = 1;
    return;
  }
  if (mode === "preview" && !existsSync(join(root, "dist", "index.html"))) {
    console.log("没有构建产物，请先执行 npm run build（或改用 npm run dev）");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  rmSync(runtimeFile, { force: true });

  const out = openSync(logFile, "a");
  // 日志是跨次运行累加的，只读本次追加之后的部分，否则会解析到上一次留下的端口
  const logStart = statSync(logFile).size;
  const child = spawn(
    process.execPath,
    [viteBin, ...(mode === "preview" ? ["preview"] : []), "--host", "--port", String(wantedPort)],
    { cwd: root, detached: true, stdio: ["ignore", out, out] }
  );
  child.unref();
  writeFileSync(join(logDir, "child.pid"), String(child.pid));

  // 从日志里等 Vite 打印实际监听地址；子进程提前退出即判失败
  let endpoint = null;
  for (let i = 0; i < 80 && !endpoint; i += 1) {
    await sleep(100);
    if (!isAlive(child.pid)) break;
    endpoint = parseLocalUrl(readFileSync(logFile).subarray(logStart).toString("utf8"));
  }
  if (!endpoint) {
    console.log(`启动失败（进程 ${child.pid}）。日志末尾：`);
    console.log(tailLog());
    process.exitCode = 1;
    return;
  }

  const info = {
    pid: child.pid,
    mode,
    port: endpoint.port,
    url: endpoint.url,
    startedAt: new Date().toISOString(),
    logFile,
  };

  // 回读首页并核对身份头：端口被别的服务回答时不能谎报启动成功
  let verdict = "无法访问";
  for (let i = 0; i < 20 && verdict === "无法访问"; i += 1) {
    try {
      const res = await fetch(info.url.replace("localhost", "127.0.0.1"));
      const answered = res.headers.get(IDENTITY_HEADER);
      if (!answered) verdict = `端口 ${info.port} 由其它程序回答（HTTP ${res.status}，非本项目 Vite）`;
      else if (Number(answered) !== info.pid) verdict = `端口 ${info.port} 被进程 ${answered} 抢占`;
      else if (!res.ok) verdict = `首页返回 HTTP ${res.status}`;
      else verdict = "启动成功";
    } catch {
      await sleep(120);
    }
  }

  if (verdict === "启动成功") writeFileSync(runtimeFile, JSON.stringify(info, null, 2));
  console.log(`${verdict}（${mode}）： ${info.url}`);
  if (verdict !== "启动成功") {
    console.log(`处理： npm run stop 关掉本次实例，再用 PORT=8080 npm run dev 指定空闲端口`);
    process.exitCode = 1;
  }
  console.log(`进程号： ${info.pid} · 端口： ${info.port} · 日志： ${logFile}`);
  if (info.port !== wantedPort) {
    console.log(`（默认端口 ${wantedPort} 已被占用，自动改用 ${info.port}）`);
  }
}

async function stop() {
  const info = runningInfo({ clean: false });
  if (!info) {
    rmSync(runtimeFile, { force: true });
    console.log("未在运行");
    return;
  }
  process.kill(info.pid, "SIGTERM");
  for (let i = 0; i < 40 && isAlive(info.pid); i += 1) await sleep(100);
  rmSync(runtimeFile, { force: true });
  if (isAlive(info.pid)) {
    console.log(`进程 ${info.pid} 未响应 SIGTERM，请手动 kill -9 ${info.pid}`);
    process.exitCode = 1;
    return;
  }
  console.log(`已关闭（${info.mode}）： 进程 ${info.pid} · ${info.url}`);
}

function status() {
  const info = runningInfo();
  if (!info) {
    console.log("状态： 未运行");
    console.log(`启动： npm run dev（开发 ${DEFAULT_PORT.dev}）/ npm run build && npm run preview（预览 ${DEFAULT_PORT.preview}）`);
    return;
  }
  console.log(`状态： 运行中（${info.mode}）`);
  console.log(`地址： ${info.url}`);
  console.log(`进程： ${info.pid}`);
  console.log(`端口： ${info.port}`);
  console.log(`启动于： ${info.startedAt}`);
  console.log(`日志： ${logFile}`);
}

function logs() {
  console.log(tailLog(30));
}

const commands = { start, stop, status, logs };

if (command === "restart") {
  await stop();
  await start();
} else if (commands[command]) {
  await commands[command]();
} else {
  console.log("用法： node scripts/dev.mjs <start|stop|restart|status|logs> [preview] [--port 5173]");
  console.log("  npm run dev / npm start    后台启动开发服务器（默认 http://localhost:5173）");
  console.log("  npm run build             构建生产产物到 dist/");
  console.log("  npm run preview           后台预览构建产物（默认 http://localhost:4173）");
  console.log("  npm run stop              关闭当前实例");
  console.log("  npm run restart           重启");
  console.log("  npm run status            查看模式、地址、端口、进程号");
  console.log("  npm run logs              查看最近 30 行日志");
}
