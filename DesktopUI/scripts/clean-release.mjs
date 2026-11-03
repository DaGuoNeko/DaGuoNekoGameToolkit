import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const root = path.resolve("release");
const apply = process.argv.includes("--apply");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const currentVersion = manifest.version;
const currentDirectory = path.join(root, "DaGuoNeko-Game-Toolkit-win32-x64");

async function runningPaths() {
  try {
    const { stdout } = await exec(
      path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name = 'DaGuoNeko-Game-Toolkit.exe'\" | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress"],
      { windowsHide: true, timeout: 10000 },
    );
    return new Set([].concat(stdout.trim() ? JSON.parse(stdout) : []).filter(Boolean).map((value) => path.resolve(value).toLowerCase()));
  } catch {
    return new Set([path.resolve(currentDirectory, "DaGuoNeko-Game-Toolkit.exe").toLowerCase()]);
  }
}

function report(target) {
  console.log(`${apply ? "删除" : "将删除"} ${target}`);
}

async function main() {
  if (path.resolve(root).toLowerCase() !== path.resolve("release").toLowerCase())
    throw Error("发行目录路径无效");
  const live = await runningPaths();
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isFile()) {
      const match = /^DaGuoNeko-Game-Toolkit-(\d+\.\d+\.\d+)-win-x64\.zip(?:\.sha256)?$/.exec(entry.name);
      if (match && match[1] !== currentVersion) {
        report(target);
        if (apply) await rm(target, { force: true });
      }
      continue;
    }
    if (!entry.isDirectory() || target.toLowerCase() === currentDirectory.toLowerCase()) continue;
    if (/^build-\d+$/.test(entry.name)) {
      const executable = path.join(target, "DaGuoNeko-Game-Toolkit-win32-x64", "DaGuoNeko-Game-Toolkit.exe");
      if (live.has(path.resolve(executable).toLowerCase())) {
        console.log(`跳过正在运行的发行目录 ${target}`);
        continue;
      }
      let version = "";
      try {
        version = JSON.parse(await readFile(path.join(target, "DaGuoNeko-Game-Toolkit-win32-x64", "release-info.json"), "utf8")).version || "";
      } catch {}
      report(target);
      if (apply) await rm(target, { recursive: true, force: true });
    }
  }
}

await stat(root);
await main();
