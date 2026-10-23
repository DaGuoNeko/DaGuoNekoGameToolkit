const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { Sessions } = require("../electron/sessions.cjs");
const { SessionHistory } = require("../electron/domains/game/history.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-history-delete-"));
  const sessions = new Sessions(
    { file: path.join(root, "settings.json") },
    "unused",
  );
  t.after(async () => {
    for (const w of sessions.workers) await w.history.finish();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-history-delete-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const directory = sessions.history.directory;
  await fs.mkdir(directory);
  async function seed(id = randomUUID()) {
    await fs.writeFile(
      path.join(directory, id + ".json"),
      JSON.stringify({
        id,
        projectName: "fixture",
        startedAt: "2026-10-01T00:00:00Z",
      }),
    );
    await fs.writeFile(
      path.join(directory, id + ".log"),
      "[time] [stdout] old log\n",
    );
    return id;
  }
  function worker(
    id,
    running,
    history = new SessionHistory(directory, () => {}),
  ) {
    const w = {
      session: { id, running },
      history,
      logs: ["old log"],
      state() {
        return { session: this.session, logs: this.logs };
      },
      clearLogs() {
        this.logs = [];
      },
    };
    sessions.workers.push(w);
    return w;
  }
  return { root, sessions, directory, seed, worker };
}

test("history deletion requires confirmation, scopes exact UUID files and protects live sessions", async (t) => {
  const f = await fixture(t),
    ended = await f.seed(),
    live = await f.seed();
  const w = f.worker(ended, false);
  f.worker(live, true);
  f.sessions.selected = ended;
  await fs.writeFile(path.join(f.directory, "keep.log"), "unrelated");
  await fs.writeFile(path.join(f.root, "world.dat"), "world");
  await assert.rejects(f.sessions.deleteHistory([ended], false), /确认/);
  await assert.rejects(
    f.sessions.deleteHistory([ended, "../world"], true),
    /无效历史/,
  );
  await fs.access(path.join(f.directory, ended + ".log"));
  const result = await f.sessions.deleteHistory([ended, live], true);
  assert.deepEqual(result, { deleted: [ended], skipped: [live], errors: [] });
  for (const ext of ["log", "json"])
    await assert.rejects(fs.access(path.join(f.directory, ended + "." + ext)), {
      code: "ENOENT",
    });
  assert.equal((await f.sessions.history.list())[0].canDelete, false);
  assert.deepEqual(w.logs, []);
  assert.equal(f.sessions.state().epoch, 1);
  assert.equal(w.session.historyDeleted, true);
  assert.equal(
    await fs.readFile(path.join(f.root, "world.dat"), "utf8"),
    "world",
  );
  assert.equal(
    await fs.readFile(path.join(f.directory, "keep.log"), "utf8"),
    "unrelated",
  );
});

test("bulk preview includes more than 100 histories and orphan pairs but never deletes later records or live output", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 105; i++) await f.seed();
  const orphan = randomUUID();
  await fs.writeFile(path.join(f.directory, orphan + ".log"), "orphan");
  const damaged = randomUUID();
  await fs.writeFile(path.join(f.directory, damaged + ".json"), "invalid json");
  const live = randomUUID(),
    h = new SessionHistory(f.directory, () => {});
  await h.begin({
    id: live,
    projectName: "live",
    startedAt: new Date().toISOString(),
  });
  f.worker(live, true, h);
  assert.equal((await f.sessions.history.list()).length, 100);
  const preview = await f.sessions.previewHistoryDeletion();
  assert.equal(preview.ids.length, 107);
  assert.equal(preview.skipped, 1);
  assert(preview.bytes > 0);
  const later = await f.seed();
  const result = await f.sessions.deleteHistory(preview.ids, true);
  assert.equal(result.deleted.length, 107);
  assert.deepEqual(result.errors, []);
  await fs.access(path.join(f.directory, later + ".log"));
  h.append({ time: "time", stream: "stdout", text: "still running" });
  await h.flush();
  assert.match(
    await fs.readFile(path.join(f.directory, live + ".log"), "utf8"),
    /still running/,
  );
  assert.equal((await f.sessions.history.list()).length, 2);
});

test("deletion rechecks worker state after draining writes and blocks cleanup during startup", async (t) => {
  const f = await fixture(t),
    id = await f.seed();
  const w = f.worker(id, false);
  const plan = await f.sessions.previewHistoryDeletion(id);
  w.history.finish = async () => {
    w.session.running = true;
  };
  assert.deepEqual((await f.sessions.deleteHistory(plan.ids, true)).skipped, [
    id,
  ]);
  await fs.access(path.join(f.directory, id + ".log"));
  f.sessions.starting = true;
  await assert.rejects(f.sessions.previewHistoryDeletion(), /正在启动/);
  assert.deepEqual((await f.sessions.deleteHistory([id], true)).skipped, [id]);
});

test("redirected directories and non-file entries cannot delete external data; partial failures retain metadata for retry", async (t) => {
  const f = await fixture(t),
    id = await f.seed(),
    other = await f.seed();
  await fs.unlink(path.join(f.directory, id + ".log"));
  await fs.mkdir(path.join(f.directory, id + ".log"));
  const result = await f.sessions.deleteHistory([id, other], true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].id, id);
  assert.deepEqual(result.deleted, [other]);
  await fs.access(path.join(f.directory, id + ".json"));
  await fs.rmdir(path.join(f.directory, id + ".log"));
  assert.deepEqual((await f.sessions.deleteHistory([id], true)).errors, []);
  const external = path.join(f.root, "external");
  await fs.mkdir(external);
  const externalId = randomUUID();
  await fs.writeFile(path.join(external, externalId + ".log"), "keep");
  const link = path.join(f.root, "redirected");
  await fs.symlink(external, link, "junction");
  const redirected = new SessionHistory(link, () => {});
  await assert.rejects(redirected.remove(externalId), /重定向/);
  assert.equal(
    await fs.readFile(path.join(external, externalId + ".log"), "utf8"),
    "keep",
  );
});
