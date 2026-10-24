const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const exec = require("node:util").promisify(
  require("node:child_process").execFile,
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "update launcher survives the client process exit after its ready receipt",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "dgn-launcher-lifetime-"),
    );
    t.after(async () => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert(path.basename(root).startsWith("dgn-launcher-lifetime-"));
      await fs.rm(root, { recursive: true, force: true });
    });
    for (const directory of ["native", "automation", "update"])
      await fs.mkdir(path.join(root, directory));
    await fs.copyFile(
      path.resolve("runtime/native/update-launcher.exe"),
      path.join(root, "native/update-launcher.exe"),
    );
    await fs.writeFile(
      path.join(root, "automation/update-helper.ps1"),
      `param([string]$Plan,[int]$LauncherPid)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
[IO.File]::WriteAllText($Plan+'.ready.tmp', ('{"pid":'+$LauncherPid+',"version":"0.1.1"}'))
Move-Item -LiteralPath ($Plan+'.ready.tmp') -Destination ($Plan+'.ready')
$deadline=(Get-Date).AddSeconds(10)
while(Get-Process -Id $job.parentPid -ErrorAction SilentlyContinue) {
  if((Get-Date) -gt $deadline){throw 'Parent did not exit'}
  Start-Sleep -Milliseconds 50
}
[IO.File]::WriteAllText($job.marker, (@{parentGone=$true;launcherPid=$LauncherPid} | ConvertTo-Json))
`,
      "utf8",
    );
    await exec(
      process.execPath,
      [path.resolve("tests/fixtures/update-parent-exit.cjs"), root],
      { windowsHide: true, timeout: 20000 },
    );
    let receipt;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        receipt = JSON.parse(
          await fs.readFile(path.join(root, "survived.json"), "utf8"),
        );
        break;
      } catch {
        await pause(50);
      }
    }
    assert.equal(
      receipt?.parentGone,
      true,
      "The update process died with the client",
    );
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try {
        process.kill(receipt.launcherPid, 0);
        await pause(50);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        alive = false;
      }
    }
    assert.equal(alive, false, "Launcher must exit after its script finishes");
  },
);
