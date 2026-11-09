const test = require("node:test"), assert = require("node:assert/strict");
const { debugTargetFor, launchTargetFor } = require("../shared/runtime-state.cjs");
const { validate } = require("../electron/domains/automation/automation-tools.cjs");
const { queryWorldData, exportWorldData, references, businessObjects } = require("../shared/world-data-model.cjs");
test("business rules distinguish quest groups and objective records, and native NPC callbacks", () => {
  const questData = { quest_item: { allitem: { group: { _type_: "group" }, q: { _type_: "quest" } }, allobjitem: { o: { owner_quest_uid: "q" } } } };
  const projected = businessObjects({ id: "root", value: { scriptData: { Quest_Engine_Data: questData } }, evidence: {} });
  assert(projected.some(row => row.kind === "questGroup")); assert(projected.some(row => row.identity === "objective:o"));
  const rows = [...projected, { id: "lib", kind: "library", identity: "library:entry", value: {} }, { id: "npc", kind: "npc", value: { scriptData: { NPC_IDENTITY: { inte_data: { stacmd: "cmd.miao:cmd 指令库 entry 0 @s" } } }, description: "cmd(not-a-call)" } }];
  const refs = references(rows);
  assert(refs.some(row => row.from === "npc" && row.to === "lib"));
  assert(!refs.some(row => row.target.includes("cmd.miao") || row.target.includes("not-a-call")));
});
const { AutomationRouter } = require("../electron/domains/automation/automation-router.cjs");
test("MCP world data tools route validated requests without a running game", async () => {
  const calls = [];
  const router = new AutomationRouter({ worldData: async (operation, args) => { calls.push([operation, args]); return { operation, complete: false }; } });
  for (const [name, args, expected] of [
    ["scan_world_data", { worldId: "fixture", requestId: "scan-1" }, "scan"],
    ["read_world_data", { requestId: "scan-1", offset: 10, limit: 5 }, "query"],
    ["world_data_scan_state", { requestId: "scan-1", cancel: true }, "cancel"],
    ["compare_world_data", { left: "scan-1", right: "scan-2" }, "compare"],
  ]) {
    const response = await router.call(name, args);
    assert.equal(JSON.parse(response.content[0].text).operation, expected);
    assert.deepEqual(calls.at(-1), [expected, args]);
  }
  await assert.rejects(router.call("scan_world_data", { source: "unselected-path", requestId: "scan-2" }), /参数无效/);
  assert.equal(calls.length, 4);
});
test("workspace target mapping uses registration and PID, never first connected client", () => {
  const hosts = [{ id: "host-a", bridgeRegistrationId: "reg-a", pid: 10 }, { id: "host-b", bridgeRegistrationId: "reg-b", pid: 20 }];
  const bridges = [{ id: "debug-b", registrationId: "reg-b", mcdkPid: 20, connected: true }, { id: "debug-a", registrationId: "reg-a", mcdkPid: 10, connected: true }];
  assert.equal(debugTargetFor(hosts[0], bridges).id, "debug-a");
  assert.equal(launchTargetFor(bridges[0], hosts).id, "host-b");
  assert.equal(debugTargetFor(hosts[0], [{ ...bridges[1], mcdkPid: 30 }]), undefined);
  assert.equal(debugTargetFor(hosts[0], [{ ...bridges[1], connected: false }]), undefined);
  assert.equal(debugTargetFor({}, bridges), undefined);
  assert.equal(launchTargetFor({}, hosts), undefined);
});
test("world data query pages stable snapshots and exports escaped non-executable relation SVG", () => {
  const snapshot = { source: "fixture", generatedAt: "fixture", complete: true, objects: [{ id: "a", name: "<script>alert(1)</script>", kind: "quest", value: { large: "data" }, evidence: {} }], relations: [{ from: "a", target: "library:<bad>", status: "not-found" }] };
  assert.equal(queryWorldData(snapshot, {}).rows[0].value, undefined);
  assert.equal(queryWorldData(snapshot, { includeData: true }).rows[0].value.large, "data");
  assert.equal(queryWorldData(snapshot, { offset: 1 }).rows.length, 0);
  assert.throws(() => queryWorldData(snapshot, { limit: 101 }), /范围/);
  const svg = exportWorldData(snapshot, "svg"); assert(svg.includes("&lt;script&gt;")); assert(!svg.includes("<script>"));
  validate("scan_world_data", { worldId: "fixture", requestId: "scan-1" });
  assert.throws(() => validate("read_world_data", { requestId: "scan-1", limit: 1000 }));
});
