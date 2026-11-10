const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { QuickLaunch } = require("../electron/domains/game/quick-launch.cjs");

test("quick launch stores named programs and refuses anything not in the list", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-quick-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exe = path.join(root, "tool.exe");
  await fs.writeFile(exe, "");
  const launch = new QuickLaunch(root);
  assert.deepEqual((await launch.list()).items, []);
  const saved = await launch.save({ name: "看日志\n工具", note: "临时备注", path: exe });
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].name, "看日志 工具");
  assert.equal(saved.items[0].note, "临时备注");
  await assert.rejects(launch.save({ name: "", note: "", path: exe }), /名称/);
  await assert.rejects(launch.save({ name: "坏", note: "", path: path.join(root, "tool.txt") }), /exe/);
  await assert.rejects(launch.launch("missing"), /不在列表中/);
  await fs.rm(exe);
  await assert.rejects(launch.launch(saved.items[0].id), /找不到这个程序/);
  const removed = await launch.remove(saved.items[0].id);
  assert.deepEqual(removed.items, []);
});
