const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const { windowCall } = require("../electron/ore-native.cjs");
test("OreUI window helper classifies native assertion details for manual handling", async () => {
  const exec = async () => ({
    stdout: JSON.stringify({
      ok: false,
      error:
        "GAME_ASSERT_DIALOG: Assertion failed: Unrecognized keyword! TexCoord0",
    }),
  });
  await assert.rejects(
    windowCall(
      "unused",
      {
        session: { pid: 1 },
        sourceSnapshot: { config: { game_executable_path: "C:/fixture.exe" } },
      },
      2,
      "status",
      exec,
    ),
    (e) =>
      e.code === "GAME_ASSERT_DIALOG" &&
      e.transient === false &&
      e.message.includes("TexCoord0"),
  );
});
test(
  "Windows OreUI helper rejects foreign parent and compiles without touching any game",
  { skip: process.platform !== "win32" },
  async () => {
    const runtime = path.resolve(__dirname, "../runtime");
    const worker = {
      session: { pid: process.ppid + 1000000 },
      sourceSnapshot: { config: { game_executable_path: process.execPath } },
    };
    await assert.rejects(
      windowCall(runtime, worker, process.pid, "status"),
      (e) => e.transient === false && /GAME_OWNERSHIP_CHANGED/.test(e.message),
    );
    worker.session.pid = process.ppid;
    await assert.rejects(
      windowCall(runtime, worker, process.pid, "status"),
      (e) => e.transient === true && /WINDOW_NOT_READY/.test(e.message),
    );
  },
);
