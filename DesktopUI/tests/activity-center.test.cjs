const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ActivityCenter } = require("../electron/activity-center.cjs");

test("activity center persists events and task state", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-activity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const center = new ActivityCenter(root);
  await center.load();
  const task = center.start("worlds.import", { projectId: "p", message: "准备" });
  center.update(task.id, { completed: 1, total: 2, message: "复制中" });
  center.finish(task.id, "success");
  assert.equal(task.completed, 2);
  assert.equal(task.total, 2);
  await center.queue;
  const reopened = new ActivityCenter(root);
  await reopened.load();
  const snapshot = reopened.snapshot({ projectId: "p" });
  assert.equal(snapshot.tasks[0].status, "success");
  assert(snapshot.events.some(event => event.operationId === task.id));
});

test("activity center completes unknown progress and exports backend log lines", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-activity-export-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const center = new ActivityCenter(root);
  const task = center.start("worlds.recycle", { message: "等待删除任务开始" });
  center.finish(task.id, "success");
  const target = path.join(root, "project.log");
  await center.export(target);
  assert.equal(task.completed, 1);
  assert.equal(task.total, 1);
  assert.match(await fs.readFile(target, "utf8"), /\[task\] \[success\] worlds\.recycle/);
});

test("activity center folds repeated errors and compacts its journal", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-activity-fold-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const center = new ActivityCenter(root, { dedupeWindowMs: 60000, maxFileBytes: 400 });
  await center.load();
  center.event({ method: "rooms.state", level: "error", source: "ui", message: "连接失败" });
  center.event({ method: "rooms.state", level: "error", source: "ui", message: "连接失败" });
  center.event({ method: "rooms.state", level: "error", source: "ui", message: "连接失败" });
  await center.flush();
  const events = center.snapshot().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].repeatCount, 3);
  assert((await fs.stat(center.file)).size < 4000);
  const reopened = new ActivityCenter(root, { dedupeWindowMs: 60000, maxFileBytes: 400 });
  await reopened.load();
  assert.equal(reopened.snapshot().events[0].repeatCount, 3);
});
