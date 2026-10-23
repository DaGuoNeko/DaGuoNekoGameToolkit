const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const listFiles = (directory) =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

test("source layout keeps renderer, shared, and Electron domain boundaries", () => {
  assert.deepEqual(listFiles(path.join(appRoot, "src")), ["index.html"]);
  for (const directory of [
    "app",
    "features/debug",
    "features/editor",
    "features/logs",
    "features/mods",
    "features/performance",
    "features/profiles",
    "features/rooms",
    "features/settings",
    "features/worlds",
  ]) {
    assert.ok(fs.existsSync(path.join(appRoot, "src", directory)), directory);
  }
  for (const file of fs.readdirSync(path.join(appRoot, "shared"))) {
    if (!file.endsWith(".cjs")) continue;
    const source = fs.readFileSync(path.join(appRoot, "shared", file), "utf8");
    assert.doesNotMatch(source, /require\(["'](?:electron|node:)/, file);
  }
  const domains = fs.readdirSync(path.join(appRoot, "electron", "domains"), {
    withFileTypes: true,
  });
  assert.deepEqual(
    domains.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
    ["automation", "client", "editor", "game", "performance", "profiles", "reload", "worlds"],
  );
  for (const domain of domains.filter((entry) => entry.isDirectory())) {
    for (const file of listFiles(path.join(appRoot, "electron", "domains", domain.name))) {
      if (!/\.(cjs|mjs)$/.test(file)) continue;
      const source = fs.readFileSync(
        path.join(appRoot, "electron", "domains", domain.name, file),
        "utf8",
      );
      assert.doesNotMatch(source, /\.\.\/src\//, `${domain.name}/${file}`);
    }
  }
  for (const file of [
    "src/app/main.jsx",
    "src/features/editor/ui-layout.wasm",
    "electron/main.cjs",
    "electron/domains/automation/automation-stdio.cjs",
  ]) {
    assert.ok(fs.existsSync(path.join(appRoot, file)), file);
  }
});
