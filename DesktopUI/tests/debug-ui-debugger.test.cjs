// Adapted from Dofes/mcdev-tools (MIT), pinned source listed in electron/debug/vendor/SOURCES.md.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_strict = __toESM(require("node:assert/strict"));
var import_node_test = __toESM(require("node:test"));
var import_uiDebugger = require("../electron/debug/vendor/uiDebugger.cjs");
(0, import_node_test.default)("UI debugger code escapes Python input and never recursively scans", () => {
  const code = (0, import_uiDebugger.buildUiDebuggerChildrenCode)("screen';boom()#", "/root/\u754C", 0);
  import_strict.default.match(code, /u"screen';boom\(\)#"/);
  import_strict.default.match(code, /\\u754c/);
  import_strict.default.doesNotMatch(code, /recurs|get_all_children/i);
  import_strict.default.match(code, /get_children_name_from_parent/);
});
(0, import_node_test.default)("UI debugger validates editable properties and emits compact readback code", () => {
  const position = (0, import_uiDebugger.buildUiDebuggerPropertyCode)("hud.hud_screen", "/root/panel", "position", [12.5, -3]);
  import_strict.default.match(position, /set_position\(s,p,tuple\(v\)\)/);
  import_strict.default.match(position, /_result=q\.get_position\(s,p\)/);
  const size = (0, import_uiDebugger.buildUiDebuggerPropertyCode)("hud.hud_screen", "/root/panel", "size", [120, 40]);
  import_strict.default.match(size, /set_size\(s,p,tuple\(v\),True\)/);
  const textCode = (0, import_uiDebugger.buildUiDebuggerPropertyCode)("hud.hud_screen", "/root/title", "text", "a'\\nb");
  import_strict.default.match(textCode, /json\.loads/);
  import_strict.default.match(textCode, /set_text\(s,p,v,True\)/);
  import_strict.default.match((0, import_uiDebugger.buildUiDebuggerPropertyCode)("hud.hud_screen", "/root/toggle", "toggleState", true), /bool\(v\)/);
  import_strict.default.throws(() => (0, import_uiDebugger.buildUiDebuggerPropertyCode)("screen", "/node", "position", ["", 1]));
  import_strict.default.throws(() => (0, import_uiDebugger.buildUiDebuggerPropertyCode)("screen", "/node", "scrollPercent", 101));
  import_strict.default.throws(() => (0, import_uiDebugger.buildUiDebuggerPropertyCode)("screen", "/node", "layer", 1.5));
  import_strict.default.throws(() => (0, import_uiDebugger.buildUiDebuggerPropertyCode)("screen", "/node", "unknown", 1));
});
(0, import_node_test.default)("UI debugger parses a compact child page", () => {
  import_strict.default.deepEqual((0, import_uiDebugger.parseUiDebuggerChildren)([3, [["label", 9, 0, 160], ["panel", 10, 2, 161]]], "/root", 160), {
    total: 3,
    offset: 160,
    nodes: [
      { name: "label", path: "/root/label", typeId: 9, type: "Label", childCount: 0, index: 160 },
      { name: "panel", path: "/root/panel", typeId: 10, type: "Panel", childCount: 2, index: 161 }
    ]
  });
});
(0, import_node_test.default)("UI debugger normalizes screens and node details", () => {
  import_strict.default.deepEqual((0, import_uiDebugger.parseUiDebuggerScreens)(["hud.hud_screen", "hud.hud_screen", null]), ["hud.hud_screen"]);
  const values = new Array(30).fill(null);
  values[0] = 9;
  values[1] = 0;
  values[2] = true;
  values[3] = [100, 20];
  values[4] = [1, 2];
  values[5] = [3, 4];
  values[6] = 5;
  values[17] = "Hi";
  values[29] = { "#title": "Bound title", "#enabled": true };
  import_strict.default.deepEqual(
    (0, import_uiDebugger.parseUiDebuggerNode)(values, "hud.hud_screen", "/root/title"),
    {
      screen: "hud.hud_screen",
      path: "/root/title",
      name: "title",
      typeId: 9,
      type: "Label",
      visible: true,
      childCount: 0,
      properties: {
        runtime: {
          visible: true,
          size: [100, 20],
          position: [1, 2],
          globalPosition: [3, 4],
          layer: 5,
          directChildren: 0
        },
        layout: {},
        text: { text: "Hi" },
        control: {},
        variables: { "#title": "Bound title", "#enabled": true }
      }
    }
  );
});
(0, import_node_test.default)("UI debugger keeps picker polling and node details bounded", () => {
  const selectCode = (0, import_uiDebugger.buildUiDebuggerPickerEnableCode)(false);
  const layoutCode = (0, import_uiDebugger.buildUiDebuggerPickerEnableCode)(true);
  import_strict.default.match(selectCode, /nud_set_bounds_visible\(False\)/);
  import_strict.default.match(layoutCode, /nud_set_bounds_visible\(True\)/);
  import_strict.default.match(selectCode, /UIDebuggerNotifyEvent/);
  import_strict.default.match(selectCode, /json\.loads\(v\)/);
  import_strict.default.match(selectCode, /_mcdev_ui_find_path/);
  import_strict.default.match(selectCode, /GetClientModTimer\(\)\.addTimer\(0\.0,self\.apply_selection\)/);
  import_strict.default.match(selectCode, /self\.pending=p/);
  import_strict.default.match(selectCode, /_mcdev_ui_resolve/);
  import_strict.default.match(selectCode, /get_all_screen_fullnames/);
  import_strict.default.match(selectCode, /for s in reversed\(ss\)/);
  import_strict.default.match(selectCode, /_mcdev_ui_event=\[d,_mcdev_ui_resolve\(p\),p\]/);
  import_strict.default.doesNotMatch(selectCode, /_mcdev_ui_last_path/);
  import_strict.default.match(layoutCode, /UIDebuggerNotifyEvent/);
  const nodeCode = (0, import_uiDebugger.buildUiDebuggerNodeCode)("hud.hud_screen", "/root/title");
  import_strict.default.match(nodeCode, /get_property_bag_value/);
  import_strict.default.match(nodeCode, /items\(\)\)\[:256\]/);
  const runtimeSelectCode = (0, import_uiDebugger.buildUiDebuggerPickerSelectCode)("custom.overlay", "/root/button");
  import_strict.default.match(runtimeSelectCode, /overlay\/root\/button/);
  import_strict.default.match(runtimeSelectCode, /nud_get_controls_data/);
  import_strict.default.ok((0, import_uiDebugger.buildUiDebuggerPickerPollCode)().length < 80);
  import_strict.default.match((0, import_uiDebugger.buildUiDebuggerPickerPollCode)(true), /get_all_screen_fullnames/);
  import_strict.default.ok(nodeCode.length < 1200);
  import_strict.default.deepEqual((0, import_uiDebugger.parseUiDebuggerReveal)([
    ["", 400, 160, [["root", 10, void 0, 160]]],
    ["/root", 1, 0, [["panel", 10, 0, 0]]]
  ]), [
    { parentPath: "", total: 400, offset: 160, nodes: [{ name: "root", path: "/root", typeId: 10, type: "Panel", index: 160 }] },
    { parentPath: "/root", total: 1, offset: 0, nodes: [{ name: "panel", path: "/root/panel", typeId: 10, type: "Panel", childCount: 0, index: 0 }] }
  ]);
  const revealCode = (0, import_uiDebugger.buildUiDebuggerRevealCode)("hud.hud_screen", "/root/panel/title");
  import_strict.default.match(revealCode, /a\.index\(t\)/);
  import_strict.default.match(revealCode, /o=\(j\/\/160\)\*160/);
  import_strict.default.doesNotMatch(revealCode, /get_all_children|recurs/i);
});
