import { packager } from "@electron/packager";
import {
  readdir,
  unlink,
  access,
  mkdir,
  realpath,
  readFile,
  writeFile,
  copyFile,
  lstat,
  mkdtemp,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { listPackage } from "@electron/asar";
const exec = promisify(execFile);
const root = path.resolve("release");
await mkdir(root, { recursive: true });
if ((await realpath(root)).toLowerCase() !== root.toLowerCase())
  throw Error("发布目录不能重定向到其他位置");
const powershell = path.join(
  process.env.SystemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const { stdout } = await exec(
  powershell,
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name = 'DaGuoNeko-Game-Toolkit.exe'\" | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress",
  ],
  { windowsHide: true, timeout: 15000 },
);
const processes = stdout.trim() ? [].concat(JSON.parse(stdout)) : [];
const destination = path.join(root, "DaGuoNeko-Game-Toolkit-win32-x64");
const occupied = processes.some(
  (file) =>
    !file ||
    file.toLowerCase().startsWith(destination.toLowerCase() + path.sep),
);
const outputRoot = occupied ? path.join(root, "build-" + Date.now()) : root;
if (occupied) console.log("现有程序正在运行，新包输出到：" + outputRoot);
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const applicationFiles = new Set([
  "/package.json",
  "/dist",
  "/dist/app.js",
  "/dist/app.css",
  "/dist/main.cjs",
  "/dist/preload.cjs",
  "/dist/isolation-worker.cjs",
  "/dist/game-title-worker.cjs",
  "/dist/toolbox-mcp.cjs",
  "/dist/index.html",
  "/dist/icon.ico",
]);
const runtimeFiles = new Set([
  "mcdk.exe",
  "README.md",
  "automation/ore-window.ps1",
  "automation/content-log-owner.ps1",
  "native/koffi.node",
  "native/mcdev-tracy-bridge.dll",
  "native/menu-name-helper.exe",
  "native/menu-name.dll",
  "native/ore-join.dll",
  "native/dgn-host-isolation.dll",
  "network/easytier-core.exe",
  "network/easytier-cli.exe",
  "network/wintun.dll",
  "network/WinDivert64.sys",
  "network/Packet.dll",
  "network/network-helper.exe",
  "network/manifest.json",
  "network/launch.ps1",
]);
async function filesIn(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name),
      relative = prefix + entry.name;
    if ((await lstat(file)).isSymbolicLink())
      throw Error("发行内容不允许目录/文件链接：" + relative);
    if (entry.isDirectory())
      result.push(...(await filesIn(file, relative + "/")));
    else if (entry.isFile()) result.push(relative);
    else throw Error("发行内容不是普通文件：" + relative);
  }
  return result.sort();
}
// Vendor networking components are obtained by each user from the pinned
// official EasyTier release on first use; do not redistribute Npcap Packet.dll.
const fetchedNetworkFiles = new Set(
  [
    "easytier-core.exe",
    "easytier-cli.exe",
    "wintun.dll",
    "WinDivert64.sys",
    "Packet.dll",
  ].map((f) => "network/" + f),
);
const runtimeInventory = await filesIn("runtime");
if (
  [...runtimeFiles].some(
    (file) =>
      !fetchedNetworkFiles.has(file) && !runtimeInventory.includes(file),
  ) ||
  runtimeInventory.some((file) => !runtimeFiles.has(file))
)
  throw Error("runtime 存在缺失或额外文件，请先核对分发范围");
const stagingRoot = await mkdtemp(
  path.join(os.tmpdir(), "dgn-package-runtime-"),
);
const stagedRuntime = path.join(stagingRoot, "runtime");
await mkdir(stagedRuntime);
for (const file of runtimeInventory.filter(
  (f) => !fetchedNetworkFiles.has(f),
)) {
  await mkdir(path.dirname(path.join(stagedRuntime, file)), {
    recursive: true,
  });
  await copyFile(path.join("runtime", file), path.join(stagedRuntime, file));
}
const archive = path.resolve(
  "node_modules/.cache",
  `electron-v${manifest.devDependencies.electron}-win32-x64.zip`,
);
let cache = false;
try {
  await access(archive);
  cache = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const outputs = await packager({
  dir: ".",
  name: "DaGuoNeko-Game-Toolkit",
  executableName: "DaGuoNeko-Game-Toolkit",
  platform: "win32",
  arch: "x64",
  out: outputRoot,
  overwrite: true,
  asar: true,
  icon: "assets/icon.ico",
  ...(cache ? { electronZipDir: path.dirname(archive) } : {}),
  // Positive allow-list: local configs/research/new directories cannot enter
  // the application archive just because a deny-list missed their names.
  ignore: (file) => !!file && !applicationFiles.has(file.replaceAll("\\", "/")),
  extraResource: [stagedRuntime, "../licenses"],
  win32metadata: {
    ProductName: "大果喵游戏工具箱",
    FileDescription: "DaGuoNeko Game Toolkit",
    CompanyName: "DaGuoNeko",
  },
});
if (
  path.dirname(stagedRuntime) !== stagingRoot ||
  !path.basename(stagingRoot).startsWith("dgn-package-runtime-")
)
  throw Error("Invalid staging directory");
await rm(stagingRoot, { recursive: true });
for (const directory of outputs) {
  if (!path.resolve(directory).startsWith(root + path.sep))
    throw Error("Invalid output");
  for (const file of await readdir(path.join(directory, "locales")))
    if (file.endsWith(".pak") && !["zh-CN.pak", "en-US.pak"].includes(file))
      await unlink(path.join(directory, "locales", file));
  console.log(directory);
  const appEntries = listPackage(
    path.join(directory, "resources/app.asar"),
  ).map((file) => file.replaceAll("\\", "/"));
  if (
    appEntries.length !== applicationFiles.size ||
    appEntries.some((file) => !applicationFiles.has(file))
  )
    throw Error("app.asar 分发清单不一致");
  await copyFile(
    "distribution/使用说明.txt",
    path.join(directory, "使用说明.txt"),
  );
  await writeFile(
    path.join(directory, "release-info.json"),
    JSON.stringify(
      {
        product: manifest.productName,
        version: manifest.version,
        platform: "win32",
        arch: "x64",
        packagedAt: new Date().toISOString(),
        edition: "免安装分发版",
        gameIncluded: false,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const checksums = [];
  for (const file of await filesIn(directory)) {
    const hash = createHash("sha256")
      .update(await readFile(path.join(directory, file)))
      .digest("hex");
    checksums.push(`${hash}  ${file}`);
  }
  await writeFile(
    path.join(directory, "SHA256SUMS.txt"),
    checksums.join("\n") + "\n",
    "utf8",
  );
  const zip = path.join(
    outputRoot,
    `DaGuoNeko-Game-Toolkit-${manifest.version}-win-x64.zip`,
  );
  const result = await exec(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("scripts/zip-package.ps1"),
      "-PackageDirectory",
      directory,
      "-ZipPath",
      zip,
      "-ReleaseRoot",
      root,
    ],
    { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 },
  );
  console.log(result.stdout.trim());
  const hash = createHash("sha256")
    .update(await readFile(zip))
    .digest("hex");
  await writeFile(zip + ".sha256", `${hash}  ${path.basename(zip)}\n`, "utf8");
  console.log("ZIP SHA-256: " + hash);
}
