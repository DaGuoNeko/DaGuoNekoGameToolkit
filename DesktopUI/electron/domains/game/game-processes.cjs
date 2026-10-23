const fs = require("node:fs/promises"),
  path = require("node:path");
const execFile = require("node:util").promisify(
  require("node:child_process").execFile,
);
const { parse } = require("jsonc-parser");
const imageNames = ["Minecraft.Windows.exe", "Minecraft.exe"];
function normalized(file) {
  return path.win32.normalize(file.replace(/^\\\\\?\\/, "")).toLowerCase();
}
async function canonical(file) {
  try {
    return normalized(await fs.realpath(file));
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    return normalized(file);
  }
}
async function queryProcesses(names) {
  // Names are data, not interpolated PowerShell/WQL. Never return launch tokens.
  const { stdout } = await execFile(
    path.join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $images=ConvertFrom-Json $env:DGN_GAME_IMAGE_NAMES; $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $images -contains $_.Name } | ForEach-Object { $ownerSid=$null; try { $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop; if($owner.ReturnValue -eq 0){$ownerSid=$owner.Sid} } catch [Microsoft.Management.Infrastructure.CimException] {} ; [PSCustomObject]@{ProcessId=$_.ProcessId;Name=$_.Name;ExecutablePath=$_.ExecutablePath;OwnerSid=$ownerSid;CurrentSid=$currentSid} }) | ConvertTo-Json -Compress",
    ],
    {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, DGN_GAME_IMAGE_NAMES: JSON.stringify(names) },
    },
  );
  return stdout.trim()
    ? [].concat(JSON.parse(stdout)).map((p) => ({
        pid: p.ProcessId,
        ownerSid: p.OwnerSid,
        currentSid: p.CurrentSid,
        name: p.Name,
        path: p.ExecutablePath || null,
      }))
    : [];
}
async function developmentBuild(file) {
  // Known MCStudio version layout, including versions not selected in a profile.
  if (
    /\\minecraftpe_netease\\\d+(?:\.\d+)*\\minecraft(?:\.windows)?\.exe$/i.test(
      file,
    )
  )
    return true;
  // Also retain protection for unpacked development builds moved elsewhere.
  // Retail MCP-packed builds use a separate data family and are not identified
  // as development builds merely because the executable basename matches.
  const config = path.win32.join(
    path.win32.dirname(file),
    "data",
    "client_cfg.json",
  );
  try {
    const stat = await fs.stat(config);
    if (!stat.isFile() || stat.size > 65536) return false;
    const errors = [],
      value = parse(await fs.readFile(config, "utf8"), errors, {
        allowTrailingComma: true,
      });
    return !errors.length && value?.no_launch_mcp === 0;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code))
      throw Error("无法检查游戏类型：" + file + "；" + error.message);
    return false;
  }
}
class GameProcesses {
  constructor({
    paths = async () => [],
    query = queryProcesses,
    isDevelopment = developmentBuild,
  } = {}) {
    Object.assign(this, { paths, query, isDevelopment });
  }
  async conflicts(selectedFile) {
    if (selectedFile !== undefined && !path.win32.isAbsolute(selectedFile))
      throw Error("启动冲突检查需要游戏 EXE 的完整路径");
    const files = [
      ...(await this.paths()),
      ...(selectedFile ? [selectedFile] : []),
    ].filter((f) => typeof f === "string" && path.win32.isAbsolute(f));
    const known = new Set(await Promise.all(files.map(canonical)));
    const names = [
      ...new Set([...imageNames, ...files.map((f) => path.win32.basename(f))]),
    ];
    const allowedNames = new Set(names.map((n) => n.toLowerCase())),
      result = [];
    // Deliberately fresh on every check: options writes check again before commit.
    for (const process of await this.query(names)) {
      if (
        !Number.isInteger(process.pid) ||
        process.pid <= 0 ||
        !allowedNames.has(String(process.name).toLowerCase())
      )
        continue;
      // Native save/options directories are per Windows user. Only a positive
      // owner SID result permits excluding another account; unknown owners keep
      // the existing conservative checks, including unreadable executable paths.
      if (
        /^S-\d-\d+(?:-\d+)+$/i.test(process.ownerSid || "") &&
        /^S-\d-\d+(?:-\d+)+$/i.test(process.currentSid || "") &&
        process.ownerSid !== process.currentSid
      )
        continue;
      if (!process.path || !path.win32.isAbsolute(process.path))
        throw Error(
          `无法读取 ${process.name}（PID ${process.pid}）的程序路径，不能确认是否为测试端，请检查该进程权限后重试`,
        );
      const file = await canonical(process.path);
      if (known.has(file) || (await this.isDevelopment(file)))
        result.push({ ...process, path: file });
    }
    return result;
  }
  async pids(file) {
    return (await this.conflicts(file)).map((p) => p.pid);
  }
  async any() {
    return (await this.conflicts()).length > 0;
  }
}
module.exports = { GameProcesses, queryProcesses, developmentBuild, canonical };
