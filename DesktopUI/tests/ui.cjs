const { spawnSync } = require("node:child_process");
for (const file of [
  "tests/update-network.cjs",
  "tests/update-ui.cjs",
  "tests/tracy-ui.cjs",
  "tests/automation-ui.cjs",
  "tests/ui-editor-ui.cjs",
  "tests/game-options-ui.cjs",
  "tests/profiles-ui.cjs",
  "tests/logs-ui.cjs",
  "tests/log-search-ui.cjs",
  "tests/import-ui.cjs",
  "tests/terrain-ui.cjs",
]) {
  const result = spawnSync(process.execPath, [file], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
