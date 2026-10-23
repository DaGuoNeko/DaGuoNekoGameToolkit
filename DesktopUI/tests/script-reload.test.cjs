const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const {
  ScriptReloader,
  collectScripts,
  indexCode,
  applyCode,
} = require("../electron/debug/script-reload.cjs");
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-script-reload-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-script-reload-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const mod = path.join(root, "mod"),
    pkg = path.join(mod, "behavior", "demoScripts");
  await fs.mkdir(pkg, { recursive: true });
  for (const n of ["modMain", "changed", "unchanged", "unloaded"]) {
    await fs.writeFile(path.join(pkg, n + ".py"), "# source\n");
    await fs.utimes(
      path.join(pkg, n + ".py"),
      new Date(1000),
      new Date(n === "changed" || n === "unloaded" ? 3000 : 1000),
    );
  }
  await fs.writeFile(
    path.join(mod, "behavior", "manifest.json"),
    JSON.stringify({
      header: { uuid: "fixture", version: [1, 0, 0] },
      modules: [{ type: "data" }],
    }),
  );
  const config = { included_mod_dirs: [mod, mod] };
  await fs.writeFile(path.join(root, ".mcdev.json"), JSON.stringify(config));
  return {
    root,
    mod,
    pkg,
    config,
    session: { registrationId: "run", connectionGeneration: 1 },
    reloader: new ScriptReloader(),
  };
}
function names(code) {
  const prefix = "_dgn_reload_names = json.loads(";
  return JSON.parse(
    JSON.parse(
      code
        .slice(code.indexOf(prefix) + prefix.length)
        .split("\n")[0]
        .slice(0, -1),
    ),
  );
}

test("embedded-only automatic scans do not update external packs; manual scans still include both", async (t) => {
  const { root, mod, session, reloader } = await setup(t);
  const other = path.join(root, "external");
  await fs.mkdir(path.join(other, "externalScripts"), { recursive: true });
  await fs.writeFile(
    path.join(other, "manifest.json"),
    JSON.stringify({
      header: { uuid: "other", version: [1, 0, 0] },
      modules: [{ type: "data" }],
    }),
  );
  await fs.writeFile(
    path.join(other, "externalScripts/modMain.py"),
    "# external",
  );
  const config = {
    included_mod_dirs: [
      { path: mod, hot_reload: false, toolbox_hot_reload: true },
      other,
    ],
  };
  await fs.writeFile(path.join(root, ".mcdev.json"), JSON.stringify(config));
  const all = await collectScripts(config, root);
  assert(all.has("demoScripts.changed") && all.has("externalScripts.modMain"));
  const indexed = [];
  const request = async (code) => {
    if (code.includes("DGN_RELOAD_INDEX")) {
      indexed.push(names(code));
      return {
        loadedAt: 2,
        loaded: names(code).map((name) => ({ name, file: name })),
      };
    }
    return names(code).map((name) => ({ name, ok: true }));
  };
  await reloader.reload(session, root, request, true);
  assert(indexed[0].every((name) => name.startsWith("demoScripts.")));
  await reloader.reload(session, root, request);
  assert(indexed[1].includes("externalScripts.modMain"));
});
test("desktop scans deduplicate roots; only changed loaded modules use the official update entry once", async (t) => {
  const { root, config, pkg, session, reloader } = await setup(t);
  const modules = await collectScripts(config, root);
  assert.equal(modules.size, 4);
  const calls = [];
  const request = async (code) => {
    calls.push(code);
    return code.includes("DGN_RELOAD_INDEX")
      ? {
          loadedAt: 2,
          loaded: [
            "demoScripts.modMain",
            "demoScripts.changed",
            "demoScripts.unchanged",
          ].map((name) => ({ name, file: name })),
        }
      : names(code).map((name) => ({ name, ok: true }));
  };
  let result = await reloader.reload(session, root, request);
  assert.equal(result.updated, 1);
  assert.deepEqual(names(calls[1]), ["demoScripts.changed"]);
  assert.match(calls[1], /xupdate.update/);
  assert.doesNotMatch(
    calls.join(""),
    /updata_all|RELOAD_MOD|os\.stat|os\.listdir/,
  );
  result = await reloader.reload(session, root, request);
  assert.equal(result.updated, 0);
  assert.equal(calls.length, 3);
  await fs.writeFile(path.join(pkg, "changed.py"), "# new content\n");
  result = await reloader.reload(session, root, request);
  assert.equal(result.updated, 1);
});
test("ambiguous modules and disabled roots are handled before any game mutation", async (t) => {
  const { root, mod, config } = await setup(t);
  const other = path.join(root, "other", "demoScripts");
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, "modMain.py"), "");
  await fs.writeFile(
    path.join(path.dirname(other), "manifest.json"),
    JSON.stringify({
      header: { uuid: "other", version: [1, 0, 0] },
      modules: [{ type: "data" }],
    }),
  );
  await assert.rejects(
    collectScripts({ included_mod_dirs: [mod, path.dirname(other)] }, root),
    /同名/,
  );
  const selected = await collectScripts(
    {
      included_mod_dirs: [
        { path: mod, enabled: false },
        { path: path.dirname(other), hot_reload: false },
      ],
    },
    root,
  );
  assert.equal(selected.size, 0);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "modMain.py"), "");
  await fs.symlink(outside, path.join(mod, "link"), "junction");
  assert.equal((await collectScripts(config, root)).size, 4);
  const staging = path.join(mod, "st", "behavior", "demoScripts");
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(
    path.join(staging, "modMain.py"),
    "# inactive staged copy",
  );
  await fs.copyFile(
    path.join(mod, "behavior", "manifest.json"),
    path.join(path.dirname(staging), "manifest.json"),
  );
  assert.equal(
    (await collectScripts(config, root)).size,
    4,
    "nested staging packs are not launched or reloaded",
  );
});
test("partial failures retain successful stamps and a timed-out batch is never automatically replayed", async (t) => {
  const { root, pkg, session, reloader } = await setup(t);
  await fs.utimes(
    path.join(pkg, "unchanged.py"),
    new Date(3000),
    new Date(3000),
  );
  let applied = [],
    fail = true;
  const request = async (code) => {
    if (code.includes("DGN_RELOAD_INDEX"))
      return {
        loadedAt: 2,
        loaded: ["demoScripts.changed", "demoScripts.unchanged"].map(
          (name) => ({ name, file: name }),
        ),
      };
    const ns = names(code);
    applied.push(ns);
    return ns.map((name) => ({
      name,
      ok: !(fail && name.endsWith("unchanged")),
      error: "fixture failure",
    }));
  };
  await assert.rejects(
    reloader.reload(session, root, request),
    /已更新 1.*fixture failure/,
  );
  fail = false;
  await reloader.reload(session, root, request);
  assert.deepEqual(applied[1], ["demoScripts.unchanged"]);
  await fs.writeFile(path.join(pkg, "changed.py"), "# again");
  let requests = 0;
  await assert.rejects(
    reloader.reload(session, root, async (code) => {
      if (code.includes("DGN_RELOAD_INDEX"))
        return {
          loadedAt: 2,
          loaded: [
            { name: "demoScripts.changed", file: "demoScripts.changed" },
          ],
        };
      requests++;
      throw Error("timeout");
    }),
    /结果不确定/,
  );
  assert.equal(requests, 1);
});
test("an invalid index or an out-of-scope module cannot trigger updates", async (t) => {
  const { root, session, reloader } = await setup(t);
  for (const index of [
    { loadedAt: null, loaded: [] },
    { loadedAt: 2, loaded: [{ name: "sys", file: "sys" }] },
    {
      loadedAt: 2,
      loaded: [{ name: "demoScripts.changed", file: "mod/common/engine.py" }],
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      reloader.reload(session, root, async () => {
        calls++;
        return index;
      }),
    );
    assert.equal(calls, 1);
  }
  assert.match(indexCode(["a.b"]), /LAST_UP_ALL_TIMESTAMP/);
  assert.match(applyCode(["a.b"]), /not in sys.modules/);
});
