const test = require("node:test"), assert = require("node:assert/strict");
const { createActivityInvalidator, sameRecords } = require("../shared/resource-refresh.cjs");
const { RuntimeView } = require("../shared/runtime-state.cjs");
test("log appends notify log consumers without refreshing unrelated workspaces", () => {
  const view = new RuntimeView(); let metadataChanges = 0, logChanges = 0;
  view.metadataListeners.add(() => metadataChanges++); view.listeners.add(() => logChanges++);
  const session = { id: "owned", running: true }, base = { session, sessions: [session], epoch: 1, revision: 1, logs: [] };
  view.receive(base);
  for (let i = 2; i <= 11; i++) view.receive({ ...structuredClone(base), revision: i, logs: [{ id: i, text: "line" + i }] });
  assert.equal(metadataChanges, 1); assert.equal(logChanges, 11); assert.equal(view.value.logs.length, 10);
  assert.equal(view.value.revision, 11);
  view.receive({ ...base, revision: 12, session: { ...session, running: false } });
  assert.equal(metadataChanges, 2); assert.equal(view.metadata.session.running, false);
  view.receive({ ...base, epoch: 0, revision: 20 }); assert.equal(view.value.epoch, 1);
});
test("progress-only notifications do not reload resources, relevant outcomes still do", () => {
  const changed = createActivityInvalidator();
  const event = { id: "read", method: "world-data.scan", level: "info" };
  for (let i = 0; i < 10; i++) assert.equal(changed({ events: [event], tasks: [{ id: "scan", method: "world-data.scan", status: "running", completed: i }] }), false);
  const task = { id: "import", method: "worlds.import", status: "running" };
  assert(changed({ tasks: [task], events: [] }));
  assert.equal(changed({ tasks: [{ ...task, completed: 1 }], events: [] }), false);
  assert(changed({ tasks: [{ ...task, status: "failed" }], events: [] }));
  assert(changed({ tasks: [], events: [{ id: "edit", method: "project.save" }] }));
  assert.equal(changed({ tasks: [], events: [{ id: "edit", method: "project.save" }] }), false);
  assert(changed({ tasks: [], events: [{ id: "rebind", method: "worlds.rebind-pack-uuids" }] }));
});
test("equal resource lists retain identity; changed path or fields invalidate", () => {
  const previous = [{ id: "a", root: "one", name: "A" }];
  assert.equal(sameRecords(previous, structuredClone(previous)), previous);
  assert.notEqual(sameRecords(previous, [{ ...previous[0], root: "two" }]), previous);
});
