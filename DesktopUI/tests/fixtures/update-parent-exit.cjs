const path = require("node:path");
const fs = require("node:fs/promises");
const {
  UpdateService,
} = require("../../electron/domains/update/update-service.cjs");
(async () => {
  const root = process.argv[2];
  const service = new UpdateService({
    currentVersion: "0.1.0",
    dataRoot: root,
    runtimeRoot: root,
    appDirectory: path.join(root, "unused"),
    executablePath: process.execPath,
    isPackaged: true,
    requestQuit: () => process.exit(0),
  });
  service.plan = path.join(root, "update/install.json");
  await fs.writeFile(
    service.plan,
    JSON.stringify({
      parentPid: process.pid,
      marker: path.join(root, "survived.json"),
    }),
    "utf8",
  );
  service.setState({ phase: "downloaded", latestVersion: "0.1.1" });
  const state = await service.install();
  throw Error(state.error || "Installer did not request exit");
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
