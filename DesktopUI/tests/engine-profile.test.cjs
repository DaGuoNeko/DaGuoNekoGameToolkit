const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  profileForDigest,
  profilesForDiscovery,
  inspectEngine,
} = require("../electron/domains/client/engine-profiles.cjs");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { joinLabel } = require("../shared/join-status.cjs");
test("engine profiles expose version and isolation capability without treating display text as support", () => {
  const profiles = profilesForDiscovery();
  assert.deepEqual(profiles.map((p) => p.version).sort(), [
    "3.10.0.420447",
    "3.10.0.436581",
  ]);
  assert.equal(
    profileForDigest(
      "489a164d5f37048fcebf941bfefba4a50ee0dabfbb7f2f2169c09600b2a4579c",
    ).isolatedHost,
    true,
  );
  assert.equal(
    profileForDigest(
      "9be281dbe08bc591336680d5a50f94d87f3c57ee75b3afcb3cabdf03347e0269",
    ).isolatedHost,
    false,
  );
  assert.equal(profileForDigest("unknown"), null);
});
test("failed stopped join keeps the actionable result in logs", () => {
  assert.match(
    joinLabel({
      running: false,
      autoJoin: { phase: "failed", worldName: "World A" },
    }),
    /加入失败/,
  );
  assert.match(
    joinLabel({
      running: false,
      autoJoin: { phase: "needs_attention", worldName: "World A" },
    }),
    /需要处理/,
  );
  assert.match(
    joinLabel({
      running: false,
      autoJoin: { phase: "joined", worldName: "World A" },
    }),
    /入房已验证/,
  );
  assert.match(
    joinLabel({
      running: false,
      autoJoin: { phase: "waiting_menu", worldName: "World A" },
    }),
    /已结束/,
  );
});
test("engine identity ignores directory labels, invalidates replaced files and returns independent snapshots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-engine-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "3.10.0.436581"),
    exe = path.join(dir, "Minecraft.Windows.exe");
  await fs.mkdir(dir);
  await fs.writeFile(exe, "unregistered build");
  const first = await inspectEngine(exe);
  assert.equal(first.profile, null);
  assert.equal(first.version, null);
  const digest = first.digest;
  first.digest = "mutated";
  assert.equal((await inspectEngine(exe)).digest, digest);
  await fs.writeFile(exe, "replaced build with different bytes");
  assert.notEqual((await inspectEngine(exe)).digest, digest);
  await assert.rejects(inspectEngine("relative.exe"), /绝对路径/);
  await assert.rejects(inspectEngine(dir), /无效/);
});
