const { test } = require("node:test"),
  assert = require("node:assert/strict");
const path = require("node:path");
const { HostIsolation } = require("../electron/host-isolation.cjs");
const { Sessions } = require("../electron/sessions.cjs");
const {
  profileDefaults,
} = require("../electron/domains/profiles/profiles.cjs");
const {
  isolatedGameVersions,
  isolatedEngineVersion,
} = require("../electron/host-isolation-support.cjs");
const oldHash =
  "489a164d5f37048fcebf941bfefba4a50ee0dabfbb7f2f2169c09600b2a4579c";
const newHash =
  "248421df4f3eb4fe1a232887385e0adebca2d545d5958d728b18585658c339d5";
const legacyHash =
  "9be281dbe08bc591336680d5a50f94d87f3c57ee75b3afcb3cabdf03347e0269";
test("isolated engine support keeps exact build hashes and excludes join-only/unknown builds", () => {
  assert.deepEqual(isolatedGameVersions, ["3.10.0.436581", "3.10.0.448891"]);
  assert.equal(isolatedEngineVersion(oldHash), "3.10.0.436581");
  assert.equal(isolatedEngineVersion(newHash), "3.10.0.448891");
  assert.equal(isolatedEngineVersion(legacyHash), null);
  assert.equal(isolatedEngineVersion("0".repeat(64)), null);
});
test(
  "isolation assessment identifies settings, launchers, legacy sources and unregistered builds",
  { skip: process.platform !== "win32" },
  async () => {
    const runtime = path.resolve("fixture-runtime"),
      launcher = path.join(runtime, "mcdk.exe");
    const isolation = new HostIsolation(runtime, null, null);
    let hash = newHash;
    isolation.digest = async () => hash;
    const config = {
      game_executable_path: path.join(
        "C:/game",
        "3.10.0.448891",
        "Minecraft.Windows.exe",
      ),
    };
    assert.equal((await isolation.assess(config, launcher, true)).reason, null);
    assert.match(
      (await isolation.assess(config, launcher, false)).reason,
      /启用独立主机.*已关闭/,
    );
    assert.match(
      (await isolation.assess(config, path.join(runtime, "other.exe"))).reason,
      /自定义启动器/,
    );
    assert.match(
      (
        await isolation.assess(
          { ...config, world_source_path: "C:/map" },
          launcher,
        )
      ).reason,
      /旧式源地图/,
    );
    hash = "0".repeat(64);
    const invalid = await isolation.assess(config, launcher, true);
    assert.match(invalid.reason, /目录版本 3\.10\.0\.448891.*尚未适配/);
    assert.match(invalid.reason, /必须通过构建校验/);
    hash = legacyHash;
    assert.match(
      (await isolation.assess(config, launcher, true)).reason,
      /尚未适配独立主机/,
    );
  },
);
function pendingHost({
  storageMode = "isolated",
  enabled = true,
  customLauncher = false,
  sourcePath = null,
  hash = newHash,
} = {}) {
  const runtime = path.resolve("fixture-runtime"),
    config = {
      ...profileDefaults(),
      game_executable_path: path.resolve(
        "fixture-game/3.10.0.448891/Minecraft.Windows.exe",
      ),
    };
  const store = {
    file: path.resolve("fixture-data/settings.json"),
    queue: Promise.resolve(),
    value: {
      settings: {
        IndependentWorlds: enabled,
        LauncherPath: customLauncher ? path.resolve("other-launcher.exe") : "",
      },
    },
    project: () => ({ id: "p", root: path.resolve("fixture-profile") }),
  };
  const isolation = new HostIsolation(runtime, null, null);
  isolation.digest = async () => hash;
  let prepared = 0;
  isolation.prepare = async () => {
    prepared++;
    throw Error("Unexpected preparation");
  };
  const manager = Object.create(Sessions.prototype);
  Object.assign(manager, {
    store,
    runtime: path.join(runtime, "mcdk.exe"),
    engineInfo: async () => ({digest:hash,version:isolatedEngineVersion(hash),profile:{version:isolatedEngineVersion(hash)}}),
    isolation,
    workers: [
      {
        session: {
          id: "old-session",
          worldId: "world-a",
          worldName: "A",
          running: true,
          storageMode,
        },
      },
    ],
    profiles: {
      queue: Promise.resolve(),
      read: async () => ({ config, revision: "r" }),
    },
    worlds: {
      launchWorld: async () => ({
        id: "world-b",
        name: "B",
        options: {},
        sourcePath,
      }),
    },
    publish() {},
    starting: false,
  });
  return { manager, prepared: () => prepared };
}
test("an already shared host cannot be combined with another host after enabling isolation", async () => {
  const f = pendingHost({ storageMode: "shared", enabled: true });
  await assert.rejects(
    f.manager.start("p", "world-b"),
    /存档“A”.*共享兼容模式.*先保存并退出.*不会改变已经运行/,
  );
  assert.equal(f.prepared(), 0);
  assert.equal(f.manager.workers[0].session.running, true);
});
test(
  "new incompatible host reports the precise reason before preparing files beside an isolated host",
  { skip: process.platform !== "win32" },
  async () => {
    for (const [options, expected] of [
      [{ enabled: false }, /启用独立主机.*已关闭/],
      [{ customLauncher: true }, /自定义启动器/],
      [{ sourcePath: "C:/legacy-map" }, /旧式源地图/],
      [{ hash: legacyHash }, /尚未适配独立主机/],
    ]) {
      const f = pendingHost(options);
      await assert.rejects(f.manager.start("p", "world-b"), expected);
      assert.equal(f.prepared(), 0);
      assert.equal(f.manager.starting, false);
      assert.equal(f.manager.workers[0].session.running, true);
    }
  },
);
