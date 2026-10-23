const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { once } = require("node:events");
const helper = path.resolve("runtime/native/menu-name-helper.exe"),
  library = path.resolve("runtime/native/menu-name.dll");
const run = (args) =>
  new Promise((resolve) =>
    execFile(
      helper,
      args,
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => resolve({ error, value: JSON.parse(stdout) }),
    ),
  );
test(
  "native helper refuses foreign ownership and mismatched images before loading any library",
  { skip: process.platform !== "win32" },
  async (t) => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await once(child, "spawn");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill();
        await done;
      }
    });
    let result = await run([
      String(child.pid),
      "0",
      process.execPath,
      library,
      "a",
    ]);
    assert.equal(result.value.code, 2);
    assert(result.error);
    result = await run([
      String(child.pid),
      String(process.pid),
      path.resolve("not-the-child.exe"),
      library,
      "a",
    ]);
    assert.equal(result.value.code, 4);
    assert(result.error);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  },
);
