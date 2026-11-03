const { spawnSync } = require("node:child_process");
const { artifactRoot } = require("./fixtures/artifacts.cjs");
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
  "tests/map-preview-ui.cjs",
  "tests/file-selection-ui.cjs",
]) {
  const result = spawnSync(process.execPath, [file], {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      DGN_ARTIFACT_ROOT: artifactRoot,
      DGN_ARTIFACT_TASK: "ui-suite",
    },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
