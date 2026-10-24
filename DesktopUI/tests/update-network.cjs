const { spawnSync } = require("node:child_process");
const path = require("node:path");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(
  require("electron"),
  [path.join(__dirname, "fixtures/update-network-entry.cjs")],
  {
    env,
    windowsHide: true,
    timeout: 30000,
    encoding: "utf8",
  },
);
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 ? 0 : 1;
