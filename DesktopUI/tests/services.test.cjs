const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { mergeRuntime } = require("../src/runtime-state.cjs");
const { discoverGames } = require("../electron/discovery.cjs");
const {
  WorkspaceStore,
  Launcher,
  parseConfig,
} = require("../electron/services.cjs");
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-game-test-"));
  t.after(async () => {
    if (
      path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("dgn-game-test-")
    )
      throw Error("Unsafe cleanup");
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project with spaces");
  await fs.mkdir(project);
  const store = new WorkspaceStore(path.join(root, "profile"));
  await store.load();
  await store.addProject(project);
  const id = store.value.projects[0].id;
  return { root, project, store, id };
}
test("startup waits for game options and never spawns when applying them fails", async (t) => {
  const { store, id, project } = await setup(t);
  const game = path.join(project, "Game.exe");
  await fs.writeFile(game, "fixture");
  const snapshot = await store.saveProject(id, null, {
    game_executable_path: game,
  });
  let spawned = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const launcher = new Launcher(store, game, {
    detectRunning: async () => false,
    beforeSpawn: async () => {
      await gate;
      throw Error("shared options are busy");
    },
    spawn: () => {
      spawned++;
      throw Error("must not spawn");
    },
  });
  const start = launcher.start(id, snapshot.revision);
  const failed = assert.rejects(start, /shared options are busy/);
  assert.equal(spawned, 0);
  release();
  await failed;
  assert.equal(spawned, 0);
  assert.equal(launcher.starting, false);
  assert.equal(launcher.session, null);
  await launcher.shutdown();
});

test("configuration preserves unknown fields/comments, rejects stale revisions, and writes recoverable backup", async (t) => {
  const { store, id, project } = await setup(t);
  const file = path.join(project, ".mcdev.json");
  const original =
    '{\n  // user comment\n  "world_name": "旧名称",\n  "unknown_option": {"keep": 42}\n}\n';
  await fs.writeFile(file, original);
  const before = await store.readProject(id);
  await store.saveProject(id, before.revision, { world_name: "新名称" });
  const saved = await store.readProject(id);
  assert.equal(saved.config.unknown_option.keep, 42);
  assert.match(saved.raw, /user comment/);
  assert.equal(await fs.readFile(file + ".dgn-launcher.bak", "utf8"), original);
  await assert.rejects(
    store.saveProject(id, before.revision, { world_name: "旧请求" }),
    /外部程序修改/,
  );
  await assert.rejects(
    store.saveProject(
      id,
      saved.revision,
      undefined,
      '{"world_folder_name":"../escape"}',
    ),
    /存档目录名/,
  );
  assert.equal(await fs.readFile(file, "utf8"), saved.raw);
  await assert.rejects(
    store.saveProject(id, saved.revision, undefined, '{"x":1,}'),
    /格式无效/,
  );
  assert.equal(parseConfig(saved.raw).world_name, "新名称");
});
test("project registration does not modify project files; profiles are isolated and new config defaults do not reset worlds", async (t) => {
  const { store, id, project, root } = await setup(t);
  assert.deepEqual(await fs.readdir(project), []);
  const value = await store.readProject(id);
  assert.equal(value.exists, false);
  assert.equal(value.config.reset_world, false);
  await store.saveProject(id, null, { user_name: "测试者" });
  await store.addProject(project);
  assert.equal(store.value.projects.length, 1);
  await store.updateSettings({ BgImageBlur: 10, AppearanceMode: "Dark" });
  const next = new WorkspaceStore(path.join(root, "profile"));
  await next.load();
  assert.equal(next.value.settings.BgImageBlur, 10);
  await assert.rejects(store.updateSettings({ BgImageScale: -1 }));
  await store.removeProject(id);
  await fs.access(path.join(project, ".mcdev.json"));
  assert.equal(store.value.projects.length, 0);
});
test("launcher uses a direct executable, workspace cwd and isolated environment; captures UTF-8 and stops only its owned process", async (t) => {
  const { root, store, id, project } = await setup(t);
  const game = path.join(root, "Game.exe");
  await fs.writeFile(game, "fixture, never executed");
  const config = await store.saveProject(id, null, {
    game_executable_path: game,
  });
  const script = path.join(root, "child.cjs");
  await fs.writeFile(
    script,
    "const b=Buffer.from('中文日志\\n');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),10);process.stderr.write('error-line\\n');setInterval(()=>{},1000);",
  );
  let options;
  const launcher = new Launcher(store, process.execPath, {
    detectRunning: async () => true,
    spawn: (exe, args, opts) => {
      assert.equal(exe, process.execPath);
      assert.deepEqual(args, []);
      options = opts;
      return spawn(process.execPath, [script], opts);
    },
  });
  t.after(async () => {
    if (launcher.session?.running) await launcher.stop();
  });
  const lines = new Promise((resolve) =>
    launcher.on("log", () => {
      if (
        launcher.logs.some((l) => l.text === "中文日志") &&
        launcher.logs.some((l) => l.text === "error-line")
      )
        resolve();
    }),
  );
  await launcher.start(id, config.revision);
  await lines;
  assert.equal(options.cwd, project);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.MCDEV_IS_SUBPROCESS_MODE, "1");
  assert.equal(options.env.MCDEV_AUTO_JOIN_GAME, "0");
  await assert.rejects(launcher.start(id, config.revision), /已有启动会话/);
  await launcher.stop();
  assert.equal(launcher.session.running, false);
  assert.equal(launcher.session.stopped, true);
  for (let i = 0; i < 2100; i++) launcher.log("stdout", "line " + i);
  assert.equal(launcher.logs.length, 2000);
  launcher.clearLogs();
  assert.equal(launcher.logs.length, 0);
});
test("world reset requires explicit confirmation and missing game configuration never spawns", async (t) => {
  const { store, id } = await setup(t);
  let calls = 0;
  const launcher = new Launcher(store, process.execPath, {
    spawn: () => {
      calls++;
      throw Error("must not launch");
    },
    detectRunning: async () => false,
  });
  let snapshot = await store.saveProject(id, null, { reset_world: true });
  await assert.rejects(launcher.start(id, snapshot.revision), /确认/);
  snapshot = await store.saveProject(id, snapshot.revision, {
    reset_world: false,
  });
  await assert.rejects(launcher.start(id, snapshot.revision), /选择游戏程序/);
  assert.equal(calls, 0);
});

test("damaged configuration is editable, repaired content is validated, and a valid backup survives recovery", async (t) => {
  const { store, id, project } = await setup(t);
  const file = path.join(project, ".mcdev.json");
  const original = '{"unknown":{"preserve":true},"world_name":"备份"}';
  await fs.writeFile(file + ".dgn-launcher.bak", original);
  await fs.writeFile(file, "{ damaged");
  const broken = await store.readProject(id);
  assert.equal(broken.config, null);
  assert.match(broken.error, /格式无效/);
  assert.equal(broken.raw, "{ damaged");
  assert.equal(await store.readBackup(id), original);
  const fixed = await store.saveProject(
    id,
    broken.revision,
    undefined,
    original,
  );
  assert.equal(fixed.config.unknown.preserve, true);
  assert.equal(await fs.readFile(file + ".dgn-launcher.bak", "utf8"), original);
  const invalidBackup = (await fs.readdir(project)).find((name) =>
    name.includes(".invalid-"),
  );
  assert.equal(
    await fs.readFile(path.join(project, invalidBackup), "utf8"),
    "{ damaged",
  );
});

test("concurrent saves cannot both overwrite the same revision; deleted directories are not recreated", async (t) => {
  const { store, id, project, root } = await setup(t);
  const snapshot = await store.saveProject(id, null, { world_name: "initial" });
  const results = await Promise.allSettled([
    store.saveProject(id, snapshot.revision, { world_name: "first" }),
    store.saveProject(id, snapshot.revision, { world_name: "second" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /外部程序修改/,
  );
  const moved = path.join(root, "moved");
  // Both absolute paths are inside this test's verified temporary root.
  assert.equal(path.dirname(project), root);
  assert.equal(path.dirname(moved), root);
  await fs.rename(project, moved);
  assert.equal((await store.readProject(id)).missing, true);
  await assert.rejects(
    store.saveProject(id, null, { world_name: "must not recreate" }),
  );
  await assert.rejects(fs.stat(project), { code: "ENOENT" });
  await store.relocateProject(id, moved);
  assert.equal((await store.readProject(id)).config.world_name, "first");
});

test("damaged global settings load with a recoverable copy instead of preventing startup", async (t) => {
  const { root } = await setup(t);
  const directory = path.join(root, "broken-profile");
  await fs.mkdir(directory);
  const file = path.join(directory, "settings.json");
  await fs.writeFile(file, "{ broken settings");
  const store = new WorkspaceStore(directory);
  await store.load();
  assert.match(store.warning, /设置文件损坏/);
  assert.deepEqual(store.value.projects, []);
  assert.equal(await fs.readFile(file, "utf8"), "{ broken settings");
  const backup = (await fs.readdir(directory)).find((name) =>
    name.endsWith(".bak"),
  );
  assert.equal(
    await fs.readFile(path.join(directory, backup), "utf8"),
    "{ broken settings",
  );
  await store.updateSettings({ AppearanceMode: "Dark" });
  assert.equal(
    JSON.parse(await fs.readFile(file, "utf8")).settings.AppearanceMode,
    "Dark",
  );
});

test("discovery scans version directories, sorts numerically and deduplicates known executables", async (t) => {
  const { root } = await setup(t);
  const install = path.join(root, "games");
  for (const version of ["3.9.1", "3.10.0", "not-a-version"]) {
    await fs.mkdir(path.join(install, version), { recursive: true });
    await fs.writeFile(
      path.join(install, version, "Minecraft.Windows.exe"),
      "fixture",
    );
  }
  const known = path.join(install, "3.10.0", "Minecraft.Windows.exe");
  const result = await discoverGames({ roots: [install], known: [known] });
  assert.deepEqual(
    result.games.map((game) => game.version),
    ["3.10.0", "3.9.1"],
  );
  assert.deepEqual(result.warnings, []);
});

test("renderer reconciles overlapping snapshots and batches without stale session or cleared log resurrection", () => {
  const entry = (id) => ({ id, text: "line " + id });
  let current = mergeRuntime(null, {
    epoch: 1,
    revision: 4,
    session: { running: true },
    logs: [entry(1), entry(2)],
  });
  current = mergeRuntime(current, {
    epoch: 1,
    revision: 5,
    session: { running: true },
    logs: [entry(2), entry(3)],
  });
  current = mergeRuntime(current, {
    epoch: 1,
    revision: 3,
    session: null,
    logs: [entry(1)],
  });
  assert.deepEqual(
    current.logs.map((l) => l.id),
    [1, 2, 3],
  );
  assert.equal(current.session.running, true);
  current = mergeRuntime(current, {
    epoch: 2,
    revision: 6,
    session: { running: true },
    logs: [],
  });
  current = mergeRuntime(current, { epoch: 1, revision: 5, logs: [entry(3)] });
  assert.deepEqual(current.logs, []);
  current = mergeRuntime(current, {
    epoch: 2,
    revision: 5000,
    session: { running: false },
    logs: Array.from({ length: 5000 }, (_, i) => entry(i + 4)),
  });
  assert.equal(current.logs.length, 2000);
  assert.equal(new Set(current.logs.map((l) => l.id)).size, 2000);
});

async function fakeLauncher(t, behavior = "spawn") {
  const context = await setup(t);
  const game = path.join(context.root, "fake.exe");
  await fs.writeFile(game, "never executed");
  const snapshot = await context.store.saveProject(context.id, null, {
    game_executable_path: game,
  });
  const children = [];
  const launcher = new Launcher(context.store, game, {
    detectRunning: async () => false,
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 123456;
      child.exitCode = null;
      children.push(child);
      queueMicrotask(() => {
        if (behavior === "spawn") child.emit("spawn");
        else {
          child.emit("error", Error("fixture spawn failed"));
          setImmediate(() => child.emit("close", null));
        }
      });
      return child;
    },
    kill: async (pid) => {
      assert.equal(pid, 123456);
      const child = children.at(-1);
      child.stdout.end();
      child.stderr.end();
      child.exitCode = 0;
      child.emit("close", 0);
    },
  });
  t.after(async () => {
    if (launcher.session?.running) await launcher.stop();
    await launcher.history.finish();
  });
  return { ...context, snapshot, launcher, children };
}

test("history retains logs past the UI cap and clearing, exports UTF-8, and prevents path traversal", async (t) => {
  const { launcher, id, snapshot, root } = await fakeLauncher(t);
  await launcher.start(id, snapshot.revision);
  for (let i = 0; i < 2300; i++) launcher.log("stdout", "中文历史 " + i);
  const sessionId = launcher.session.id;
  launcher.clearLogs();
  assert.equal(launcher.logs.length, 0);
  const archive = await launcher.history.read(sessionId);
  assert.equal(archive.logs.length, 2000);
  assert.equal(archive.total, 2301);
  const target = path.join(root, "export.log");
  await launcher.history.export(sessionId, target);
  const text = await fs.readFile(target, "utf8");
  assert.match(text, /中文历史 0\n/);
  assert.match(text, /中文历史 2299\n/);
  await assert.rejects(launcher.history.read("../settings"), /无效历史/);
  await launcher.stop();
  assert.equal((await launcher.history.list()).length, 1);
});

test("spawn error is reported once and close cannot replace its failure exit code", async (t) => {
  const { launcher, id, snapshot } = await fakeLauncher(t, "error");
  await assert.rejects(
    launcher.start(id, snapshot.revision),
    /fixture spawn failed/,
  );
  if (launcher.session.running) await once(launcher.session.child, "close");
  assert.equal(launcher.session.running, false);
  assert.equal(launcher.session.code, -1);
  assert.equal(launcher.starting, false);
});

test("stop failure preserves ownership and permits retry; concurrent stops share one process operation", async (t) => {
  const { launcher, id, snapshot } = await fakeLauncher(t);
  await launcher.start(id, snapshot.revision);
  const kill = launcher.kill;
  launcher.kill = async () => {
    throw Error("access denied");
  };
  await assert.rejects(launcher.stop(), /无法停止本次客户端/);
  assert.equal(launcher.session.running, true);
  assert.equal(launcher.session.stopped, false);
  let calls = 0;
  launcher.kill = async (pid) => {
    calls++;
    await kill(pid);
  };
  await Promise.all([launcher.stop(), launcher.stop()]);
  assert.equal(calls, 1);
  assert.equal(launcher.session.running, false);
});

test("startup rejects a changed configuration and shutdown waits for a pending launch", async (t) => {
  const { launcher, id, snapshot, store } = await fakeLauncher(t);
  let release;
  launcher.detectRunning = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = launcher.start(id, snapshot.revision);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(launcher.start(id, snapshot.revision), /已有启动会话/);
  await store.saveProject(id, snapshot.revision, { reset_world: true });
  release(false);
  await assert.rejects(pending, /准备启动期间发生变化/);
  assert.equal(launcher.session, null);
  const next = await store.readProject(id);
  const ready = await store.saveProject(id, next.revision, {
    reset_world: false,
  });
  launcher.detectRunning = async () => false;
  const startup = launcher.start(id, ready.revision);
  const closing = launcher.shutdown();
  await startup;
  await closing;
  assert.equal(launcher.session.running, false);
  assert.equal(launcher.history.stream, null);
});

test("taskkill descendant error waits for the owned child close event instead of reporting a stale failure", async (t) => {
  const { launcher, id, snapshot } = await fakeLauncher(t);
  await launcher.start(id, snapshot.revision);
  const kill = launcher.kill;
  launcher.kill = async (pid) => {
    setTimeout(() => kill(pid), 25);
    throw Error("descendant already exited");
  };
  await launcher.stop();
  assert.equal(launcher.session.running, false);
  assert.equal(launcher.session.stopped, true);
});
