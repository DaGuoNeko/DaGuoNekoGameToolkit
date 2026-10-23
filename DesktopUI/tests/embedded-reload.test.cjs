const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { EmbeddedReloader } = require("../electron/debug/embedded-reload.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(t, reload) {
  const state = { target: null, calls: [], reports: [], watchers: [] };
  const reloader = new EmbeddedReloader(["pack", "pack"], {
    delay: 10,
    target: () => state.target,
    reload: async (target) => {
      state.calls.push(target);
      return reload ? reload() : { updated: 1 };
    },
    report: (value) => state.reports.push(value),
    watchDirectory: (_dir, _options, callback) => {
      const watcher = new EventEmitter();
      watcher.callback = callback;
      watcher.closed = false;
      watcher.close = () => {
        watcher.closed = true;
      };
      state.watchers.push(watcher);
      return watcher;
    },
  });
  t.after(() => reloader.close());
  return {
    state,
    reloader,
    change: (name = "rules.py") => state.watchers[0].callback("change", name),
  };
}
test("embedded updates debounce Python edits and wait for a current ready session", async (t) => {
  const { state, reloader, change } = setup(t);
  assert.equal(state.watchers.length, 1);
  change("texture.png");
  await sleep(25);
  assert.equal(state.calls.length, 0);
  change();
  change();
  await sleep(25);
  assert.equal(state.calls.length, 0);
  state.target = { sessionId: "owned", generation: 2 };
  reloader.resume();
  await sleep(25);
  assert.deepEqual(state.calls, [state.target]);
  assert.equal(state.reports[0].result.updated, 1);
  reloader.resume();
  await sleep(25);
  assert.equal(state.calls.length, 1);
});
test("edits during an update coalesce and never run concurrently", async (t) => {
  let resolve;
  const { state, change } = setup(
    t,
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  state.target = { sessionId: "owned", generation: 1 };
  change();
  await sleep(25);
  change();
  change();
  await sleep(25);
  assert.equal(state.calls.length, 1);
  resolve({ updated: 1 });
  await sleep(25);
  assert.equal(state.calls.length, 2);
  resolve({ updated: 1 });
  await sleep(25);
  assert.equal(state.calls.length, 2);
});
test("ambiguous failures do not replay pending notifications and release cancels delayed work", async (t) => {
  let reject;
  const { state, reloader, change } = setup(
    t,
    () =>
      new Promise((_r, r) => {
        reject = r;
      }),
  );
  state.target = { sessionId: "owned", generation: 1 };
  change();
  await sleep(25);
  change();
  reject(Error("timeout"));
  await sleep(25);
  reloader.resume();
  await sleep(25);
  assert.equal(state.calls.length, 1);
  assert.match(state.reports[0].error, /timeout.*手动热更新/);
  change();
  reloader.close();
  await sleep(25);
  assert.equal(state.calls.length, 1);
  assert(state.watchers.every((w) => w.closed));
});
test("watch errors close handles and surface one actionable error", async (t) => {
  const { state, change } = setup(t);
  state.target = { sessionId: "owned", generation: 1 };
  state.watchers[0].emit("error", Error("directory unavailable"));
  change();
  await sleep(25);
  assert.equal(state.calls.length, 0);
  assert(state.watchers[0].closed);
  assert.match(state.reports[0].error, /监听已停止.*directory unavailable/);
});
