const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);

// Same installation layout as MCDK v1.6.1 game_discovery.cpp, across all drives.
async function discoverGames({ roots, known = [] } = {}) {
  if (!roots) {
    const { stdout } = await exec(
      path.join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq "Fixed" } | ForEach-Object { $_.RootDirectory.FullName }',
      ],
      { windowsHide: true, timeout: 10000 },
    );
    roots = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((drive) =>
        path.join(drive, "MCStudioDownload", "game", "MinecraftPE_Netease"),
      );
  }
  const candidates = new Map();
  const warnings = [];
  async function add(file) {
    try {
      if (!(await fs.stat(file)).isFile()) return;
      const absolute = path.resolve(file);
      candidates.set(absolute.toLowerCase(), {
        path: absolute,
        version: path.basename(path.dirname(absolute)),
      });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code))
        warnings.push(file + "：" + error.message);
    }
  }
  for (const file of known) await add(file);
  const searchRoots = [
    ...new Set([
      ...roots,
      ...known.map((file) => path.dirname(path.dirname(file))),
    ]),
  ];
  for (const root of searchRoots) {
    let children;
    try {
      children = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code))
        warnings.push(root + "：" + error.message);
      continue;
    }
    await add(path.join(root, "Minecraft.Windows.exe"));
    for (const child of children) {
      if (child.isDirectory() && /^\d+(\.\d+)*$/.test(child.name))
        await add(path.join(root, child.name, "Minecraft.Windows.exe"));
    }
  }
  return {
    games: [...candidates.values()].sort(
      (a, b) =>
        b.version.localeCompare(a.version, "en", { numeric: true }) ||
        a.path.localeCompare(b.path),
    ),
    warnings,
  };
}
module.exports = { discoverGames };
