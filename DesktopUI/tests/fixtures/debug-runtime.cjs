const net = require("node:net"),
  crypto = require("node:crypto"),
  fs = require("node:fs");
const {
  HostBridgeFrameDecoder,
  encodeHostBridgeFrame,
} = require("../../electron/debug/vendor/protocol.cjs");
const decoder = new HostBridgeFrameDecoder(),
  sessionId = crypto.randomUUID();
const snapshot = {
  session: {
    id: sessionId,
    state: "game_ready",
    stateSequence: 2,
    connectionGeneration: 1,
    startedAt: new Date().toISOString(),
  },
  minecraft: { pid: process.pid },
  mcdk: { pid: process.ppid },
  gameIpc: { connected: true },
  project: { root: process.cwd() },
  capabilities: { debugCapabilityEnabled: true },
};
// Keep the advertised run snapshot root, while fixture control files stay in
// the registered mod directory used by the tests.
const launchConfig = JSON.parse(fs.readFileSync(".mcdev.json", "utf8"));
const fixtureRoot = launchConfig.included_mod_dirs?.[0];
if (fixtureRoot)
  process.chdir(
    typeof fixtureRoot === "string" ? fixtureRoot : fixtureRoot.path,
  );
const socket = net.createConnection({
  host: "127.0.0.1",
  port: Number(process.env.MCDEV_HOST_PORT),
});
const send = (value) => socket.write(encodeHostBridgeFrame(value));
const positions = new Map();
const visibility = new Map();
const terrainBlocks = new Map();
let terrainResult;
let lastExternal = "",
  picker = false;
function jsonLiteral(code, prefix) {
  const index = code.indexOf(prefix);
  if (index < 0) return undefined;
  const literal = /^"(?:\\.|[^"\\])*"/.exec(code.slice(index + prefix.length));
  return literal ? JSON.parse(literal[0]) : undefined;
}
function rootNodes() {
  return [
    ["root", 10, 330, 0],
    ["overlay", 10, 1, 1],
  ];
}
function screens() {
  return fs.existsSync("screens.fixture")
    ? JSON.parse(fs.readFileSync("screens.fixture", "utf8"))
    : ["hud_screen"];
}
function children(parent, offset = 0, limit = 160) {
  if (!parent) return [2, rootNodes()];
  if (parent === "/root")
    return [
      330,
      Array.from(
        { length: Math.max(0, Math.min(limit, 330 - offset)) },
        (_, i) => ["label" + (offset + i), 9, 0, offset + i],
      ),
    ];
  return [1, [["child", 9, 0, 0]]];
}
socket.on("connect", () =>
  send({
    jsonrpc: "2.0",
    id: "init",
    method: "mcdk/initialize",
    params: {
      ...snapshot,
      authToken: process.env.MCDEV_HOST_TOKEN,
      protocol: { minVersion: 1, maxVersion: 1 },
      limits: { maxFrameBytes: 16777216, maxInFlightRequests: 64 },
    },
  }),
);
socket.on("data", (chunk) => {
  for (const request of decoder.push(chunk)) {
    if (!request.method) continue;
    let result = true,
      delay = 0,
      waitFile = "";
    const code = request.params?.code || "";
    const path = jsonLiteral(code, ";p=u") || "/root";
    try {
      if (fs.existsSync("external-position.json")) {
        const raw = fs.readFileSync("external-position.json", "utf8");
        if (raw !== lastExternal) {
          const value = JSON.parse(raw);
          positions.set(value.path, value.value);
          lastExternal = raw;
        }
      }
      if (request.method === "mcdk/methods/list")
        result = {
          methods: [
            {
              name: "game/reload",
              modes: ["request"],
              gameAvailability: "in_world",
            },
            {
              name: "game/code/execute",
              modes: ["request"],
              gameAvailability: "in_world",
            },
          ],
        };
      else if (request.method === "mcdk/session/get") result = snapshot;
      else if (request.method === "game/reload") {
        fs.writeFileSync("reload.fixture", JSON.stringify(request.params));
        result = { accepted: true, addons: request.params.addons };
      } else if (request.method === "game/code/execute") {
        if (code.includes("raise ValueError")) throw Error("fixture exception");
        if (code.includes("clientlevel.get_nethernet_id"))
          result = {netherNetId:String(process.pid)};
        else if (code.includes("DGN_ACTION_PLAYER"))
          result = { playerId: "-123456789123456" };
        else if (code.includes("DGN_ACTION_READY")) result = { ready: true };
        else if (code.includes("DGN_TERRAIN_PROBE")) result = { dimension: launchConfig.world_name.includes("地形来源副本") ? 0 : 3, position: [10, 64, 20], min: [0, -64, 16], max: [15, 319, 31] };
        else if (code.includes("DGN_TERRAIN_START")) {
          const data = JSON.parse(Buffer.from(/b64decode\('([^']+)'\)/.exec(code)[1], "base64").toString("utf8"));
          const source = launchConfig.world_name.includes("地形来源副本");
          const read = p => terrainBlocks.get(p.join()) || { name: source ? "minecraft:stone" : "minecraft:air", states: {}, entity: null };
          if (data.op === "read") {
            const blocks = [];
            for (let x = data.min[0]; x <= data.max[0]; x++) for (let z = data.min[2]; z <= data.max[2]; z++) for (let y = data.min[1]; y <= data.max[1]; y++) blocks.push(read([x,y,z]));
            terrainResult = { phase: "done", blocks };
          } else {
            for (const write of data.writes) terrainBlocks.set(write.pos.join(), data.op === "undo" ? write.before : write.after);
            fs.appendFileSync("terrain.fixture", JSON.stringify(data) + "\n");
            terrainResult = { phase: "done", completed: data.writes.length };
          }
          result = { accepted: true };
        } else if (code.includes("DGN_TERRAIN_STATUS")) result = terrainResult;
        else if (code.includes("DGN_TERRAIN_CANCEL")) result = true;
        else if (code.includes("DGN_BIOME_PROBE"))
          result = {
            known: true,
            dimension: 3,
            position: [0, 64, 0],
            min: [0, -64, 0],
            max: [15, 319, 15],
            chunks: [
              [-1, -1],
              [-1, 0],
              [0, -1],
              [0, 0],
            ],
          };
        else if (code.includes("DGN_BIOME_BATCH")) {
          const data = JSON.parse(
            Buffer.from(
              /b64decode\('([^']+)'\)/.exec(code)[1],
              "base64",
            ).toString("utf8"),
          );
          result = { ok: true, completed: data.volumes.length };
        } else if (code.includes("DGN_WORLD_ACTION")) {
          const encoded = /b64decode\('([^']+)'\)/.exec(code)[1];
          const data = JSON.parse(
            Buffer.from(encoded, "base64").toString("utf8"),
          );
          fs.appendFileSync(
            "actions.fixture",
            JSON.stringify({
              ...data,
              side: request.params.isClient,
              pid: process.pid,
            }) + "\n",
          );
          result = { ok: data.command !== "/invalid_fixture" };
        } else if (code.includes("DGN_RELOAD_INDEX"))
          result = {
            loadedAt: 1,
            loaded: JSON.parse(
              jsonLiteral(code, "_dgn_reload_names = json.loads("),
            ).map((name) => ({ name, file: name })),
          };
        else if (code.includes("DGN_RELOAD_APPLY"))
          result = JSON.parse(
            jsonLiteral(code, "_dgn_reload_names = json.loads("),
          ).map((name) => ({ name, ok: true }));
        else if (code.includes("DGN_MCP_ROUTE_PROBE"))
          result = launchConfig.user_name;
        else if (code.includes('_result = "fixture-picker"')) result = picker;
        else if (code.includes("_ui_before=bool")) {
          if (fs.existsSync("fail-visible.fixture"))
            throw Error("fixture visibility rejected");
          const before = visibility.get(path) ?? true;
          visibility.set(path, !before);
          result = { before, after: !before };
          if (fs.existsSync("delay-visible.fixture"))
            waitFile = "release-visible.fixture";
        } else if (code.includes("UI_PROPERTY_CHANGED")) {
          const expected = JSON.parse(
            jsonLiteral(code, "_ui_expected=json.loads(u"),
          );
          const value = JSON.parse(jsonLiteral(code, ";v=json.loads(u"));
          const visible = code.includes("q.set_visible(");
          const before = visible
            ? (visibility.get(path) ?? true)
            : positions.get(path) || [0, 0];
          if (JSON.stringify(before) !== JSON.stringify(expected))
            throw Error("UI_PROPERTY_CHANGED");
          (visible ? visibility : positions).set(path, value);
          result = { before, after: value };
          if (fs.existsSync("delay-mutation.fixture"))
            waitFile = "release-mutation.fixture";
        } else if (
          code.includes("tracemalloc.start(") ||
          code.includes("yappi.start(")
        )
          result = { ok: true };
        else if (code.includes("compare_to("))
          result = {
            ok: true,
            elapsed: 1,
            depth: 8,
            sizeDiff: 128,
            countDiff: 2,
            size: 256,
            count: 4,
            total: 1,
            rows: [[0, 128, 2, 256, 4, [["testScripts/modMain.py", 1]]]],
          };
        else if (code.includes("_edges=[]"))
          result = {
            ok: true,
            clock: "WALL",
            elapsed: 1,
            total: 1,
            targets: ["client", "server"],
            nodes: [
              [
                0,
                "testScripts/modMain.py",
                1,
                "hello",
                20,
                20,
                0.004,
                0.01,
                0,
                "main",
                "client",
              ],
            ],
            edges: [],
          };
        else if (code.includes("get_property_bag_value")) {
          const panel = path === "/root" || path === "/overlay";
          result = Array(30).fill(null);
          Object.assign(result, {
            0: panel ? 10 : 9,
            1: path === "/root" ? 330 : panel ? 1 : 0,
            2: visibility.get(path) ?? true,
            3: [100, 100],
            4: positions.get(path) || [0, 0],
            5: [0, 0],
            6: 1,
            7: 0,
            8: [0, 0],
            9: [200, 200],
            10: false,
            17: panel ? null : "示例文本",
            19: [1, 1, 1, 1],
            21: false,
            22: 0,
            29: { $fixture: true },
          });
          if (code.includes("_ui_details=_result")) {
            const pages = [];
            if (code.includes("ds=")) {
              pages.push(["", 2, 0, rootNodes()]);
              if (path.startsWith("/root/")) {
                const index = Number(path.split("label")[1]) || 0;
                const offset = Math.floor(index / 160) * 160;
                pages.push([
                  "/root",
                  330,
                  offset,
                  children("/root", offset)[1],
                ]);
              }
            }
            result = [
              result,
              pages.map((page) => [
                ...page.slice(0, 3),
                page[3].map((row) => [
                  ...row,
                  visibility.get(page[0] + "/" + row[0]) ?? true,
                ]),
              ]),
            ];
            if (code.includes("nud_set_selected_controls"))
              fs.writeFileSync("highlight.json", JSON.stringify({ path }));
          }
          if (fs.existsSync("delay-node.json")) {
            const value = JSON.parse(
              fs.readFileSync("delay-node.json", "utf8"),
            );
            if (value.path === path) {
              delay = value.delay || 0;
              waitFile = value.waitFile || "";
            }
          }
        } else if (code.includes("ds=") && code.includes("r.append(")) {
          // Reveal the requested path's ancestor pages, including an interior page.
          const targetMatch = /u"(label\d+)"/.exec(code);
          const index = targetMatch ? Number(targetMatch[1].slice(5)) : 0;
          result = [
            [
              "",
              2,
              0,
              targetMatch
                ? rootNodes().map(([name, type, count, index]) => [
                    name,
                    type,
                    null,
                    index,
                  ])
                : rootNodes(),
            ],
          ];
          if (targetMatch)
            result.push([
              "/root",
              330,
              Math.floor(index / 160) * 160,
              children("/root", Math.floor(index / 160) * 160)[1],
            ]);
        } else if (code.includes("UnListenForEngineClient")) {
          picker = false;
          result = false;
        } else if (code.includes("ListenForEngineClient")) {
          picker = true;
          result = true;
        } else if (code.includes("_ui_event")) {
          let event = null;
          if (fs.existsSync("game-pick.json")) {
            event = JSON.parse(fs.readFileSync("game-pick.json", "utf8"));
            fs.unlinkSync("game-pick.json");
          }
          result = [event, screens()];
        } else if (code.includes("get_root_children_names"))
          result = children("");
        else if (code.includes("get_children_name_from_parent")) {
          const range = /a\[(\d+):(\d+)\]/.exec(code);
          result = children(path, range ? Number(range[1]) : 0);
        } else if (code.includes("get_all_screen_fullnames"))
          result = screens();
        else if (code.includes("__mcdev_module")) result = { invoked: true };
        else result = 2;
        if (
          code.includes("_ui_visibility") &&
          !code.includes("_ui_details=_result")
        ) {
          const parent = code.includes("get_root_children_names") ? "" : path;
          result = [
            result[0],
            result[1].map((row) => [
              ...row,
              visibility.get(parent + "/" + row[0]) ?? true,
            ]),
          ];
        }
      }
      if (request.id) {
        const response = { jsonrpc: "2.0", id: request.id, result };
        if (waitFile) {
          const deadline = Date.now() + 10000;
          const timer = setInterval(() => {
            if (fs.existsSync(waitFile)) {
              clearInterval(timer);
              send(response);
            } else if (Date.now() > deadline) {
              clearInterval(timer);
              send({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32100, message: "fixture release timed out" },
              });
            }
          }, 20);
        } else if (delay) setTimeout(() => send(response), delay);
        else send(response);
      }
    } catch (error) {
      if (request.id)
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32100,
            message: error.message,
            data: { code: "PYTHON_EXECUTION_FAILED" },
          },
        });
    }
  }
});
socket.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
console.log("Bridge fixture ready");
