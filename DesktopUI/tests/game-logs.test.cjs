const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { GameLogs, ownedLogFiles } = require("../electron/domains/game/game-logs.cjs");
const { Sessions } = require("../electron/sessions.cjs");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-game-logs-"));
  const directory = path.join(root, "native");
  await fs.mkdir(directory);
  const workers = [1, 2].map((n) => ({
    session: {
      id: crypto.randomUUID(),
      pid: 100 + n,
      running: true,
      startedAt: "2026-10-13T01:00:00Z",
      projectName: "client" + n,
    },
    sourceSnapshot: { config: { game_executable_path: "C:/Game.exe" } },
  }));
  const names = [
    "ContentLog2026-10-13_09-00-00.txt",
    "ContentLog2026-10-13_09-00-00_1.txt",
  ];
  let queries = 0;
  const logs = new GameLogs({
    directory,
    archiveDirectory: path.join(root, "logs/game"),
    runtime: "unused",
    workers: () => workers,
    identity: (w) => ({ pid: w.session.pid + 1000 }),
    interval: 60000,
    discoveryInterval: 0,
    discover: async (runtime, dir, w) => {
      queries++;
      return {
        files: [names[workers.indexOf(w)]],
        startedAt: w.session.startedAt,
      };
    },
  });
  t.after(async () => {
    await logs.dispose();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-game-logs-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of names) await fs.writeFile(path.join(directory, name), "");
  return { root, directory, workers, names, logs, queries: () => queries };
}
test("native logs follow exact process files, split UTF-8 safely and isolate clients/history/clear", async (t) => {
  const f = await fixture(t);
  const first = path.join(f.directory, f.names[0]),
    second = path.join(f.directory, f.names[1]);
  await fs.writeFile(first, "09:00:01[Json][error]-first\n\n");
  const bytes = Buffer.from("09:00:02[Json][inform]-中文\n");
  await fs.appendFile(first, bytes.subarray(0, bytes.length - 3));
  await fs.writeFile(second, "09:00:03[Json][warn]-second\n");
  await f.logs.tick();
  const a = f.workers[0].session.id,
    b = f.workers[1].session.id;
  assert(f.logs.snapshot(a).logs.some((l) => l.text.includes("first")));
  assert(!f.logs.snapshot(a).logs.some((l) => l.text.includes("second")));
  await fs.appendFile(first, bytes.subarray(bytes.length - 3));
  await f.logs.tick();
  assert(f.logs.snapshot(a).logs.some((l) => l.text.endsWith("中文")));
  assert(!f.logs.snapshot(a).logs.some((l) => l.text.includes("�")));
  const count = f.logs.snapshot(a).logs.length;
  await f.logs.tick();
  assert.equal(f.logs.snapshot(a).logs.length, count);
  f.logs.clear(a);
  assert.equal(f.logs.snapshot(a).logs.length, 0);
  assert.equal(f.logs.snapshot(a).epoch, 1);
  await fs.appendFile(first, "09:00:04[Json][error]-new\n");
  await f.logs.tick();
  assert.equal(f.logs.snapshot(a).logs.length, 1);
  await f.logs.records.get(a).history.flush();
  assert(
    (await f.logs.archive.read(a)).logs.some((l) => l.text.includes("first")),
  );
  f.workers[0].session.running = false;
  await f.logs.tick();
  assert.equal(f.logs.snapshot(a).phase, "ended");
  assert.equal(f.logs.snapshot(b).phase, "capturing");
});
test("truncation and rotations are bounded, PID changes stop reading and raw files survive history deletion", async (t) => {
  const f = await fixture(t),
    a = f.workers[0].session.id;
  const file = path.join(f.directory, f.names[0]);
  await fs.writeFile(file, "09:00:01[Json][error]-initial-long-entry\n");
  await f.logs.tick();
  await fs.writeFile(file, "short\n");
  await f.logs.tick();
  assert(f.logs.snapshot(a).logs.some((l) => l.text === "short"));
  const old = f.names[0];
  f.names[0] = "ContentLog2026-10-13_09-01-00.txt";
  await fs.writeFile(path.join(f.directory, f.names[0]), "rotated\n");
  await f.logs.tick();
  assert(f.logs.snapshot(a).logs.some((l) => l.text === "rotated"));
  f.workers[0].session.pid++;
  await f.logs.tick();
  assert.equal(f.logs.snapshot(a).phase, "error");
  await fs.appendFile(path.join(f.directory, f.names[0]), "must-not-read\n");
  await f.logs.tick();
  assert(!f.logs.snapshot(a).logs.some((l) => l.text === "must-not-read"));
  f.workers[0].session.running = false;
  const sessions = new Sessions(
    { file: path.join(f.root, "settings.json") },
    "unused",
  );
  sessions.workers = f.workers;
  sessions.gameLogs = f.logs;
  for (const w of f.workers) w.state = () => ({ session: w.session, logs: [] });
  const result = await sessions.deleteHistory([a], true, "game");
  assert.deepEqual(result.errors, []);
  await fs.access(file);
  await fs.access(path.join(f.directory, f.names[0]));
  await assert.rejects(fs.access(f.logs.archive.file(a)), { code: "ENOENT" });
  await fs.mkdir(sessions.archive.directory, { recursive: true });
  await fs.writeFile(sessions.archive.file(a), "script preserved");
  await sessions.deleteHistory([a], true, "game");
  assert.equal(
    await fs.readFile(sessions.archive.file(a), "utf8"),
    "script preserved",
  );
});
test("capture bounds huge initial files and rejects redirected or arbitrary source paths", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, f.names[0]);
  await fs.writeFile(file, "old\n".repeat(600000) + "tail-marker\n");
  for (let i = 0; i < 6; i++) await f.logs.tick();
  const r = f.logs.records.get(f.workers[0].session.id);
  assert(r.logs.length <= 2000);
  assert(r.logs.some((l) => l.text === "tail-marker"));
  assert(r.history.bytes <= 50 * 1024 * 1024);
  assert.equal(r.files.get(f.names[0]).offset, (await fs.stat(file)).size);
  await assert.rejects(f.logs.openFile("../secret", "owner"), /文件名/);
  await f.logs.closeFiles(r);
  const external = path.join(f.root, "external");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, f.names[0]), "external");
  const redirected = path.join(f.root, "redirected");
  await fs.symlink(external, redirected, "junction");
  f.logs.directory = redirected;
  await assert.rejects(f.logs.openFile(f.names[0], "owner"), /重定向/);
});
test("slow discovery cannot attach to a stopped or replaced client; query failure is visible without falling back to newest file", async (t) => {
  const f = await fixture(t);
  let release;
  f.logs.discover = () =>
    new Promise((r) => {
      release = r;
    });
  f.workers.splice(1);
  const tick = f.logs.tick();
  while (!release) await new Promise((r) => setImmediate(r));
  f.workers[0].session.running = false;
  release({ files: [f.names[0]], startedAt: "2026-10-13T01:00:00Z" });
  await tick;
  assert.equal(f.logs.records.get(f.workers[0].session.id).files.size, 0);
  f.workers[0].session.running = true;
  f.logs.discover = async () => {
    throw Error("access refused");
  };
  await f.logs.tick();
  assert.match(
    f.logs.snapshot(f.workers[0].session.id).message,
    /access refused/,
  );
  assert.equal(f.logs.records.get(f.workers[0].session.id).files.size, 0);
});
test("native helper validates response paths and refuses a foreign parent process", async () => {
  const worker = {
    session: { pid: process.ppid + 1000000 },
    sourceSnapshot: { config: { game_executable_path: process.execPath } },
  };
  await assert.rejects(
    ownedLogFiles(path.resolve(__dirname, "../runtime"), os.tmpdir(), worker, {
      pid: process.pid,
    }),
    /GAME_OWNERSHIP_CHANGED/,
  );
  await assert.rejects(
    ownedLogFiles("unused", "unused", worker, { pid: 1 }, async () => ({
      stdout: JSON.stringify({
        ok: true,
        files: ["../outside.txt"],
        startedAt: new Date().toISOString(),
      }),
    })),
    /无效路径/,
  );
});

test("engine output cannot evict the content-only live view", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.directory, f.names[0]),
    "[Json][error]-flower_pot\n",
  );
  await f.logs.tick();
  const id = f.workers[0].session.id,
    r = f.logs.records.get(id);
  for (let i = 0; i < 5000; i++)
    f.logs.append(r, "engine", "engine noise " + i);
  assert(!f.logs.snapshot(id).logs.some((l) => l.text.includes("flower_pot")));
  assert(
    f.logs
      .snapshot(id, "content")
      .logs.some((l) => l.text.includes("flower_pot")),
  );
  assert.equal(f.logs.snapshot(id, "engine").logs.length, 2000);
  f.logs.clear(id);
  assert.equal(f.logs.snapshot(id, "content").logs.length, 0);
  assert.equal(f.logs.snapshot(id, "engine").logs.length, 0);
});

test(
  "real Windows handle tracing separates two processes with same-time log filenames",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    const children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      }
    });
    try {
      for (const name of f.names) {
        const child = spawn(
          process.execPath,
          [
            "-e",
            "require('node:fs').openSync(process.argv[1],'r');process.stdout.write('ready');setInterval(()=>{},1000)",
            path.join(f.directory, name),
          ],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        children.push(child);
        await once(child.stdout, "data");
      }
      for (let i = 0; i < children.length; i++) {
        const result = await ownedLogFiles(
          path.resolve(__dirname, "../runtime"),
          f.directory,
          {
            session: { pid: process.pid },
            sourceSnapshot: {
              config: { game_executable_path: process.execPath },
            },
          },
          { pid: children[i].pid },
        );
        assert.deepEqual(result.files, [f.names[i]]);
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      }
    }
  },
);
