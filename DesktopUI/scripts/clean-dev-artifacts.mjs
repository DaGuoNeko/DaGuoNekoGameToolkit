import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("..", ".miao", "work");
const legacyRoot = path.resolve("..", ".miao", "test-data");
const legacyResults = path.resolve("test-results");
const emptyLegacyNvidia = path.resolve("..", "NVIDIA Corporation");
const projectRoot = path.resolve("..");
const systemScanSkips = new Set([
  path.join(projectRoot, ".git").toLowerCase(),
  path.join(projectRoot, "DesktopUI", "node_modules").toLowerCase(),
  path.join(projectRoot, "DesktopUI", "dist").toLowerCase(),
  path.join(projectRoot, "DesktopUI", "release").toLowerCase(),
  path.join(projectRoot, ".miao", "cache").toLowerCase(),
  path.join(projectRoot, ".miao", "tools").toLowerCase(),
]);
const apply = process.argv.includes("--apply");
const migrateLegacy = process.argv.includes("--migrate-legacy");
const now = Date.now();
const systemNames = new Set(["Thumbs.db", ".DS_Store", "desktop.ini", "ehthumbs.db"]);

async function realDirectory(value) {
  const info = await stat(value);
  return info.isDirectory() && path.resolve(value).toLowerCase() === value.toLowerCase();
}

async function cleanSystemFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!systemScanSkips.has(target.toLowerCase())) await cleanSystemFiles(target);
    }
    else if (systemNames.has(entry.name)) {
      console.log(`${apply ? "删除" : "将删除"} ${target}`);
      if (apply) await rm(target, { force: true });
    }
  }
}

async function main() {
  if (await realDirectory(projectRoot).catch(() => false)) await cleanSystemFiles(projectRoot);
  if (migrateLegacy) {
    const legacy = path.resolve("test-results");
    if (await realDirectory(legacy).catch(() => false)) {
      const directory = path.join(root, "legacy-ui-results-20261103");
      const outputs = path.join(directory, "outputs");
      await import("node:fs/promises").then(({ mkdir, rename, writeFile, readdir }) =>
        mkdir(outputs, { recursive: true }).then(async () => {
          await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
            schema: 1,
            id: "legacy-ui-results-20261103",
            kind: "visual-acceptance-migration",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
            status: "migrated",
            preserve: false,
            source: "DesktopUI/test-results",
          }, null, 2) + "\n", "utf8");
          for (const entry of await readdir(legacy, { withFileTypes: true }))
            if (entry.isFile()) await rename(path.join(legacy, entry.name), path.join(outputs, entry.name));
        }),
      );
      if (!(await (await import("node:fs/promises")).readdir(legacy)).length)
        await rm(legacy, { recursive: true, force: true });
      console.log(`已迁移旧视觉验收输出 ${directory}`);
    }
  }
  if (await realDirectory(root).catch(() => false)) {
    await cleanSystemFiles(root);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      const manifestPath = path.join(directory, "manifest.json");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch {
        console.log(`孤儿产物（未自动删除） ${directory}`);
        continue;
      }
      const expiresAt = Date.parse(manifest.expiresAt || "");
      if (manifest.preserve === true || !Number.isFinite(expiresAt) || expiresAt > now) continue;
      console.log(`${apply ? "删除" : "将删除"} ${directory}`);
      if (apply) await rm(directory, { recursive: true, force: true });
    }
  }
  if (await realDirectory(legacyRoot).catch(() => false)) {
    for (const entry of await readdir(legacyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(legacyRoot, entry.name);
      const info = await stat(directory);
      if (info.mtimeMs > now - 3 * 86400000) continue;
      console.log(`${apply ? "删除旧临时产物" : "将删除旧临时产物"} ${directory}`);
      if (apply) await rm(directory, { recursive: true, force: true });
    }
    if (apply && !(await readdir(legacyRoot)).length) await rm(legacyRoot, { recursive: true, force: true });
  }
  if (apply && (await realDirectory(legacyResults).catch(() => false)) && !(await readdir(legacyResults)).length)
    await rm(legacyResults, { recursive: true, force: true });
  if (apply && (await realDirectory(emptyLegacyNvidia).catch(() => false))) {
    const children = await readdir(emptyLegacyNvidia, { withFileTypes: true });
    if (!children.length) await rm(emptyLegacyNvidia, { recursive: true, force: true });
    else if (children.every((entry) => entry.isDirectory() && !entry.name)) await rm(emptyLegacyNvidia, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
