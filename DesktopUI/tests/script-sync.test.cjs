const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const {
  ScriptSyncHost,
  ScriptSyncGuest,
  digest,
  validEntry,
} = require("../electron/network/script-sync.cjs");
const protocol = require("../electron/network/protocol.cjs");
function payload(code, variable) {
  const line = code
    .split("\n")
    .find((x) => x.startsWith(variable + "=json.loads("));
  return JSON.parse(
    JSON.parse(line.slice((variable + "=json.loads(").length, -1)),
  );
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-script-sync-")),
    source = path.join(root, "host"),
    cache = path.join(root, "guest-cache"),
    download = path.join(cache, "native-pack"),
    pack = crypto.randomUUID();
  await fs.mkdir(path.join(source, "demo"), { recursive: true });
  await fs.writeFile(
    path.join(source, "manifest.json"),
    JSON.stringify({
      header: { uuid: pack, version: [1, 0, 0] },
      modules: [{ type: "data" }],
    }),
  );
  for (const [name, text] of [
    ["__init__", ""],
    ["modMain", "# entry\n"],
    ["rules", "def value():\n    return 1\n"],
  ])
    await fs.writeFile(path.join(source, "demo", name + ".py"), text);
  await fs.cp(source, download, { recursive: true });
  const host = new ScriptSyncHost(
      {
        auto_hot_reload_mods: true,
        included_mod_dirs: [
          { path: source, hot_reload: false, toolbox_hot_reload: true },
        ],
      },
      root,
      () => {},
    ),
    state = {
      calls: [],
      acks: [],
      updates: [],
      failCompile: false,
      corrupt: false,
      failAck: false,
      closed: false,
      paths: [download],
    };
  const key = protocol.randomKey();
  const request = async (action, data) => {
    state.calls.push(action);
    let result;
    if (action === "scripts.list") result = await host.list(data);
    else if (action === "scripts.chunk") {
      result = host.chunk(data);
      if (state.corrupt)
        result.data = Buffer.from("corrupted").toString("base64");
    } else {
      if (state.failAck) throw Error("ack network error");
      state.acks.push(data);
      return true;
    }
    return protocol.open(protocol.seal(result, key, "test"), key, "test");
  };
  const guest = new ScriptSyncGuest({
    request,
    guard: () => {
      if (state.closed) throw Error("closed");
    },
    cacheRoots: [cache],
    directory: path.join(root, "staging"),
    code: async (code) => {
      if (code.includes("_result={'paths'"))
        return {
          paths: state.paths,
          loaded: ["demo", "demo.modMain", "demo.rules"],
        };
      if (code.includes("compile(")) {
        for (const f of payload(code, "_dgn_sync_files")) {
          await fs.access(f.file);
          if (state.failCompile) throw Error("SyntaxError");
        }
        return true;
      }
      const names = payload(code, "_dgn_sync_names");
      state.updates.push(names);
      return names.map((name) => ({ name, ok: true }));
    },
  });
  t.after(async () => {
    guest.close();
    host.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-script-sync-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const change = async (text) => {
    await fs.writeFile(path.join(source, "demo/rules.py"), text);
    host.dirty = true;
    host.changedAt = 0;
  };
  return { root, source, cache, download, host, guest, state, change };
}
test("encrypted paged sync stages verified bytes and updates only changed loaded modules without replay", async (t) => {
  const { guest, host, state, download, change } = await setup(t);
  await guest.tick();
  assert.equal(guest.status.phase, "synced");
  assert.equal(state.updates.length, 0);
  const text = "#" + "x".repeat(40000) + "\ndef value():\n    return 2\n";
  await change(text);
  await guest.tick();
  assert.equal(guest.status.phase, "synced");
  assert.equal(guest.status.updated, 1);
  assert.deepEqual(state.updates, [["demo.rules"]]);
  assert(state.calls.filter((x) => x === "scripts.chunk").length >= 4);
  assert.equal(
    await fs.readFile(path.join(download, "demo/rules.py"), "utf8"),
    text,
  );
  await guest.tick();
  assert.equal(state.updates.length, 1);
  assert.equal(state.acks.at(-1).revision, host.current);
});
test("corrupt chunks and invalid syntax do not alter downloaded code and the same failed revision is not replayed", async (t) => {
  const { guest, state, download, change } = await setup(t),
    file = path.join(download, "demo/rules.py"),
    original = await fs.readFile(file);
  await guest.tick();
  await change("def value():\n    return 22\n");
  state.corrupt = true;
  await guest.tick();
  assert.equal(guest.status.phase, "error");
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal(state.updates.length, 0);
  state.corrupt = false;
  await change("def broken(:\n");
  state.failCompile = true;
  await guest.tick();
  assert.match(guest.status.message, /SyntaxError/);
  assert.deepEqual(await fs.readFile(file), original);
  const count = state.calls.filter((x) => x === "scripts.chunk").length;
  await guest.tick();
  assert.equal(state.calls.filter((x) => x === "scripts.chunk").length, count);
  state.failCompile = false;
  await change("def value():\n    return 33\n");
  await guest.tick();
  assert.equal(guest.status.phase, "synced");
  assert.equal(state.updates.length, 1);
});
test("only current native cache pack paths and matching UUID/version are writable", async (t) => {
  const { guest, state, source, download, change } = await setup(t);
  state.paths = [source];
  await change("def value():\n    return 5\n");
  await guest.tick();
  assert.match(guest.status.message, /缺少对应原生下载包/);
  assert.equal(state.updates.length, 0);
  assert.match(
    await fs.readFile(path.join(download, "demo/rules.py"), "utf8"),
    /return 1/,
  );
});
test("guest-local edits are not overwritten and failed acknowledgements retry without executing code twice", async (t) => {
  const { guest, state, download, change } = await setup(t);
  await guest.tick();
  await change("def value():\n    return 7\n");
  state.failAck = true;
  await guest.tick();
  assert.equal(guest.status.phase, "ack_pending");
  assert.equal(state.updates.length, 1);
  state.failAck = false;
  await guest.tick();
  assert.equal(state.updates.length, 1);
  assert.equal(guest.status.phase, "synced");
  await fs.writeFile(path.join(download, "demo/rules.py"), "# guest edit");
  await change("def value():\n    return 8\n");
  await guest.tick();
  assert.match(guest.status.message, /其他操作修改/);
  assert.equal(
    await fs.readFile(path.join(download, "demo/rules.py"), "utf8"),
    "# guest edit",
  );
});
test("metadata rejects traversal, executable assets and mismatched module identity before any write", async (t) => {
  const { host } = await setup(t),
    list = await host.list({}),
    entry = list.entries.find((e) => e.relative.endsWith("rules.py"));
  assert(validEntry(entry));
  for (const relative of [
    "../rules.py",
    "demo/../../p.py",
    "demo/x.exe",
    "demo/CON.py",
    "C:/p.py",
    "demo\\rules.py",
  ]) {
    assert.equal(
      validEntry({
        ...entry,
        relative,
        id: digest(entry.pack + "/" + relative),
      }),
      false,
    );
  }
  assert.equal(validEntry({ ...entry, name: "os" }), false);
  assert.equal(validEntry({ ...entry, bytes: 3 * 1024 * 1024 }), false);
});
test("pause and cancellation suppress writes, and native cache links are refused", async (t) => {
  const { guest, host, state, download, root, change } = await setup(t);
  host.config.auto_hot_reload_mods = false;
  await guest.tick();
  assert.equal(guest.status.phase, "paused");
  assert.equal(state.updates.length, 0);
  host.config.auto_hot_reload_mods = true;
  const target = path.join(root, "other");
  await fs.rename(path.join(download, "demo"), target);
  await fs.symlink(target, path.join(download, "demo"), "junction");
  await change("def value():\n    return 9\n");
  await guest.tick();
  assert.match(guest.status.message, /链接重定向/);
  assert.equal(state.updates.length, 0);
  await fs.unlink(path.join(download, "demo"));
  await fs.rename(target, path.join(download, "demo"));
  guest.close();
  state.closed = true;
  await guest.tick();
  assert.equal(state.updates.length, 0);
});

test("reverting a rejected edit clears the failure without re-executing successful code", async (t) => {
  const { guest, state, source, change } = await setup(t);
  await guest.tick();
  const original = await fs.readFile(path.join(source, "demo/rules.py"));
  state.failCompile = true;
  await change("bad syntax");
  await guest.tick();
  assert.equal(guest.status.phase, "error");
  await change(original);
  state.failCompile = false;
  await guest.tick();
  assert.equal(guest.status.phase, "synced");
  assert.equal(state.updates.length, 0);
  assert.match(guest.status.message, /恢复/);
});

test("structural changes report a restart boundary instead of claiming removed scripts were synchronized", async (t) => {
  const { host, guest, source } = await setup(t);
  await guest.tick();
  await fs.writeFile(path.join(source, "demo/newfile.py"), "# new");
  host.dirty = true;
  host.changedAt = 0;
  await guest.tick();
  assert.equal(guest.status.phase, "error");
  assert.match(guest.status.message, /文件清单发生变化/);
});

test("leaving during a file transfer prevents cache writes and game updates", async (t) => {
  const { guest, host, download, change, state } = await setup(t);
  await guest.tick();
  await change("def value():\n    return 88\n");
  const request = guest.request;
  let entered, release;
  const waiting = new Promise((r) => {
    entered = r;
  });
  guest.request = async (action, data) => {
    if (action === "scripts.chunk") {
      entered();
      await new Promise((r) => {
        release = r;
      });
      return host.chunk(data);
    }
    return request(action, data);
  };
  const pending = guest.tick();
  await waiting;
  guest.close();
  release();
  await pending;
  assert.match(
    await fs.readFile(path.join(download, "demo/rules.py"), "utf8"),
    /return 1/,
  );
  assert.equal(state.updates.length, 0);
});
