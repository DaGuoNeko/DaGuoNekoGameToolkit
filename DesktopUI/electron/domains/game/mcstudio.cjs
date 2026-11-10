const fs = require("node:fs/promises");
const path = require("node:path");

const key = (value) => path.resolve(value).toLowerCase();
const label = (value, fallback) => {
  const text = String(value || "").replace(/[\0\r\n]/g, " ").trim().slice(0, 80);
  return text || fallback;
};

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024)
    throw Error("配置不是可读取的小文件");
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function listDirectories(root) {
  if (!(await exists(root))) return [];
  return (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory())
    .map((entry) => entry.name);
}

async function realDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) return "";
  try {
    const resolved = path.resolve(directory);
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "";
    if (key(await fs.realpath(resolved)) !== key(resolved)) return "";
    return resolved;
  } catch {
    return "";
  }
}

async function isPack(directory) {
  for (const name of ["manifest.json", "pack_manifest.json"]) {
    try {
      const stat = await fs.lstat(path.join(directory, name));
      if (!stat.isSymbolicLink() && stat.isFile()) return true;
    } catch {}
  }
  return false;
}

async function studioRoot(localAppData) {
  const config = path.join(localAppData, "Netease", "MCStudio", "config", "app", "app.conf");
  if (!(await exists(config))) return "";
  const editor = String((await readJson(config)).X64EditorPath || "").replaceAll("/", "\\");
  const index = editor.toLowerCase().indexOf("\\mcx64editor");
  return index > 0 ? editor.slice(0, index) : "";
}

async function projectsOf(root, warnings) {
  const projects = [];
  for (const account of await listDirectories(path.join(root, "work"))) {
    if (account.startsWith(".") || account.toLowerCase() === "temp") continue;
    const addon = path.join(root, "work", account, "Cpp", "AddOn");
    if (!(await exists(addon))) continue;
    for (const name of await listDirectories(addon)) {
      const folder = path.join(addon, name);
      const config = path.join(folder, "work.mcscfg");
      if (!(await exists(config))) continue;
      try {
        const data = await readJson(config);
        projects.push({
          id: name,
          name: label(data.Name, name),
          account,
          directory: folder,
          workDirectory: typeof data.CustomWorkDir === "string" ? data.CustomWorkDir : "",
          uid: String(data.UID || name),
        });
      } catch (error) {
        warnings.push(name + ": " + error.message);
      }
    }
  }
  return projects;
}

function rememberMod(mods, directory, projectName, projectId, importable) {
  const id = key(directory);
  const found = mods.get(id);
  if (found) {
    if (importable) found.importable = true;
    return;
  }
  mods.set(id, {
    id,
    name: label(path.basename(directory), projectName),
    directory,
    projectName,
    projectId,
    importable,
  });
}

async function consider(mods, directory, projectName, projectId) {
  const resolved = await realDirectory(directory);
  if (!resolved) return;
  const pack = await isPack(resolved);
  rememberMod(mods, resolved, projectName, projectId, pack);
  if (pack) return;
  for (const name of await listDirectories(resolved)) {
    if (name.startsWith(".")) continue;
    const child = await realDirectory(path.join(resolved, name));
    if (child && (await isPack(child))) rememberMod(mods, child, projectName, projectId, true);
  }
}

async function walkConfigs(directory, files, depth) {
  // shortcut: 只收集 MC_GAME 下 2000 个配置，更深的安装布局需要单独索引。
  if (depth > 4 || files.length >= 2000) return;
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= 2000 || entry.isSymbolicLink()) continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkConfigs(location, files, depth + 1);
    else if (entry.isFile() && /\.(?:json|cppconfig)$/i.test(entry.name)) files.push(location);
  }
}

async function scanMcStudio(localAppData, roaming) {
  const warnings = [];
  let root = "";
  try {
    root = await studioRoot(localAppData);
  } catch (error) {
    return { available: false, root: "", worlds: [], mods: [], warnings: [error.message] };
  }
  if (!root) return { available: false, root: "", worlds: [], mods: [], warnings };
  const projects = await projectsOf(root, warnings);
  const byUid = new Map(projects.map((item) => [item.uid, item]));
  const worlds = new Map();
  const mods = new Map();
  for (const project of projects) {
    await consider(mods, project.directory, project.name, project.id);
    if (project.workDirectory) await consider(mods, project.workDirectory, project.name, project.id);
  }
  for (const account of new Set(projects.map((item) => item.account))) {
    const files = [];
    await walkConfigs(path.join(root, "game", "config", account, "Cpp", "MC_GAME"), files, 0);
    for (const file of files) {
      try {
        const data = await readJson(file);
        const level = typeof data.world_info?.level_id === "string" ? data.world_info.level_id : "";
        if (!level || level === "." || level === ".." || /[\\/:]/.test(level)) continue;
        const directory = await realDirectory(path.join(roaming, "MinecraftPE_Netease", "minecraftWorlds", level));
        if (!directory) continue;
        const levelStat = await fs.lstat(path.join(directory, "level.dat")).catch(() => null);
        if (!levelStat?.isFile() || levelStat.isSymbolicLink()) continue;
        const project = byUid.get(String(data.MainComponentId || ""));
        const nameFile = path.join(directory, "levelname.txt");
        const levelName = (await exists(nameFile)) ? await fs.readFile(nameFile, "utf8") : "";
        const id = key(directory);
        if (!worlds.has(id)) {
          worlds.set(id, {
            id,
            name: label(levelName, project?.name || "MCStudio 存档"),
            directory,
            projectName: project?.name || "MCStudio",
            projectId: project?.id || String(data.MainComponentId || ""),
            level,
          });
        }
        const paths = data.LocalComponentPathsDict || {};
        let noted = 0;
        for (const value of Object.values(paths)) {
          if (noted >= 300) break;
          if (value && typeof value.work_path === "string") {
            await consider(mods, value.work_path, project?.name || "MCStudio", project?.id || "");
            noted++;
          }
        }
      } catch (error) {
        if (warnings.length < 20) warnings.push(path.basename(file) + ": " + error.message);
      }
    }
  }
  return { available: true, root, worlds: [...worlds.values()], mods: [...mods.values()], warnings };
}

class McStudioIndex {
  constructor(localAppData, roaming) {
    this.localAppData = localAppData;
    this.roaming = roaming;
  }
  scan() {
    return scanMcStudio(this.localAppData, this.roaming);
  }
  async world(directory) {
    const found = (await this.scan()).worlds.find((item) => item.id === key(directory));
    if (!found) throw Error("这个 MCStudio 存档已变化，请刷新后再导入");
    return found;
  }
  async mod(directory) {
    const found = (await this.scan()).mods.find((item) => item.importable && item.id === key(directory));
    if (!found) throw Error("这个 MCStudio 模组目录已变化，请刷新后再导入");
    return found;
  }
}

module.exports = { scanMcStudio, McStudioIndex };
