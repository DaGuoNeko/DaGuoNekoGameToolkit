const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  properties,
  parseValue,
  mergePage,
  mergeReveal,
  flattenTree,
} = require("../shared/ui-inspector-model.cjs");
const { buildMutation } = require("../electron/debug/ui-mutation.cjs");
const live = require("../electron/debug/ui-live.cjs");
const { diffCache, applyCache } = require("../shared/inspector-cache.cjs");
const { withVisibility } = require("../shared/ui-inspector-model.cjs");
test("selection cache patches omit unchanged trees and visibility changes preserve other parent pages", () => {
  const pages = {
    "": { nodes: [{ path: "/root", visible: true }] },
    "/root": { nodes: [{ path: "/root/child", visible: true }] },
  };
  assert.equal(withVisibility(pages, "/root/child", true), pages);
  const changed = withVisibility(pages, "/root/child", false);
  assert.equal(changed[""], pages[""]);
  assert.notEqual(changed["/root"], pages["/root"]);
  const before = { pages, details: { path: "/root" }, drafts: {} },
    next = { ...before, details: { path: "/root/child" } };
  const delta = diffCache(before, next);
  assert.equal(delta.pages, undefined);
  assert.deepEqual(applyCache(before, delta), next);
  const visibilityDelta = diffCache(next, { ...next, pages: changed });
  assert.deepEqual(Object.keys(visibilityDelta.pages.set), ["/root"]);
  assert.deepEqual(applyCache(next, visibilityDelta).pages, changed);
  assert.deepEqual(applyCache(undefined, diffCache(undefined, before)), before);
  assert.deepEqual(
    applyCache(before, diffCache(before, { ...before, pages: {} })).pages,
    {},
  );
  const large = {
    ...before,
    pages: {
      "": {
        nodes: Array.from({ length: 5000 }, (_, i) => ({
          path: "/node" + i,
          name: "node" + i,
          visible: true,
        })),
      },
    },
  };
  const largeNext = { ...large, details: { path: "/node2" } };
  assert.ok(
    Buffer.byteLength(JSON.stringify(diffCache(large, largeNext))) <
      Buffer.byteLength(JSON.stringify(largeNext)) / 100,
  );
});
test("native picker accepts selection events only, ignores properties/errors, and never echoes a passive selection", () => {
  const script = `import sys,types,json\nbasestring=str;long=int\ngui=types.ModuleType('gui');gui.get_netease_ui_debugger_enable=lambda:True;gui.set_netease_ui_debugger_enable=lambda v:None;gui.nud_set_bounds_visible=lambda v:None;gui.get_all_screen_fullnames=lambda:['hud.hud_screen'];gui.get_control_def_type=lambda s,p:10\nlogger=types.ModuleType('mobile_logger');logger.OPEN_SAFAIA_TEST_LOGGER=False\ncommon=types.ModuleType('common');common.eventUtil=types.SimpleNamespace(instance=types.SimpleNamespace(ListenForEngineClient=lambda *a:None))\nsys.modules.update({'gui':gui,'_gui':gui,'mobile_logger':logger,'common':common})\nexec(${JSON.stringify(live.pickerEnableCode(false))})\ndef event(handle,data,success=True):_mcdev_ui_listener.on_event({'data':json.dumps({'handle':handle,'success':success,'data':data})})\nevent(6,{'/hud_screen/root':{'visible':True}})\nassert _mcdev_ui_event is None\nevent(7,['/hud_screen/root'],False)\nassert _mcdev_ui_event is None\nevent(7,['/hud_screen/root'])\nassert _mcdev_ui_event==[None,'hud.hud_screen','/hud_screen/root']\nevent(4,{})\nassert _mcdev_ui_event is None and _mcdev_ui_screen_changed\nexec(${JSON.stringify(live.pickerPollCode())})\nassert _result[2] is True and not _mcdev_ui_screen_changed\nprint('ok')`;
  const run = spawnSync("python", ["-c", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(
    !live
      .selectionCode("hud", "/root", false, true)
      .includes("nud_get_controls_data"),
  );
  assert.ok(
    live
      .selectionCode("hud", "/root", false, true)
      .indexOf("nud_set_selected_controls") <
      live
        .selectionCode("hud", "/root", false, true)
        .indexOf("get_property_bag_value"),
  );
});
const {
  propertyRows,
  readableValue,
} = require("../shared/ui-inspector-model.cjs");
test("live inspector scripts return bounded visible pages, combined selection and fresh visibility toggles", () => {
  const script = `import json,sys,types\ngui=types.ModuleType('gui')\nstate={'visible':True,'selected':None}\ndef get_visible(s,p):return state['visible']\ndef set_visible(s,p,v):state['visible']=v\ndef select(v):state['selected']=json.loads(v)\ngui.get_visible=get_visible;gui.set_visible=set_visible\ngui.get_control_def_type=lambda s,p:10\ngui.get_root_children_names=lambda s:['root']\ngui.get_children_name_from_parent=lambda s,p:[]\ngui.nud_set_selected_controls=select;gui.nud_get_controls_data=lambda p:None\nsys.modules['gui']=gui;sys.modules['_gui']=gui\nexec(${JSON.stringify(live.visibleChildren("hud", "", 0))})\nchildren=_result\nexec(${JSON.stringify(live.selectionCode("hud", "/root", true, true))})\nselection=_result\nexec(${JSON.stringify(live.toggleVisibilityCode("hud", "/root"))})\nfirst=_result\nexec(${JSON.stringify(live.toggleVisibilityCode("hud", "/root"))})\nprint(json.dumps({'children':children,'selection':selection,'selected':state['selected'],'first':first,'second':_result}))`;
  const run = spawnSync("python", ["-c", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  const value = JSON.parse(run.stdout);
  assert.equal(
    live.parseChildren(value.children, "", 0).nodes[0].visible,
    true,
  );
  assert.equal(value.selection[0][2], true);
  assert.equal(value.selection[1][0][3][0][0], "root");
  assert.ok(value.selected[0].endsWith("/root"));
  assert.deepEqual(value.first, { before: true, after: false });
  assert.deepEqual(value.second, { before: false, after: true });
});
test("property overview translates runtime values and retains unknown properties", () => {
  const rows = propertyRows({
    name: "root",
    type: "Panel",
    path: "/root",
    properties: {
      runtime: { visible: false, size: [100, 20], position: [1.23456, 2] },
      variables: { $custom: "value" },
    },
  });
  assert.equal(rows.find((r) => r.key === "runtime.visible").value, "否");
  assert.equal(
    rows.find((r) => r.key === "runtime.size").value,
    "宽：100，高：20",
  );
  assert.equal(rows.find((r) => r.key === "variables.$custom").value, "value");
  assert.equal(readableValue("top_left", "anchorFrom"), "左上");
});
function runMutation(property, value, expected, current) {
  const source = buildMutation({
    screen: "hud.screen",
    path: '/root/"quoted',
    property,
    value,
    expected,
  });
  const script = `import json,sys,types\nstate={'value':json.loads(${JSON.stringify(JSON.stringify(current))}),'writes':0}\ndef get(*args): return state['value']\ndef set(*args):\n state['value']=args[2];state['writes']+=1\ngui=types.ModuleType('gui')\nfor key in ['position','text','visible']: setattr(gui,'get_'+key,get);setattr(gui,'set_'+key,set)\nsys.modules['gui']=gui\ntry:\n exec(${JSON.stringify(source)})\n print(json.dumps({'result':_result,'writes':state['writes']}))\nexcept Exception as error:\n print(json.dumps({'error':str(error),'writes':state['writes']}))\n`;
  const result = spawnSync("python", ["-c", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test("UI property mutation rejects external changes before writing, and reports before/after values", () => {
  const conflict = runMutation("position", [10, 20], [0, 0], [5, 0]);
  assert.match(conflict.error, /UI_PROPERTY_CHANGED/);
  assert.equal(conflict.writes, 0);
  const applied = runMutation("position", [10, 20], [0, 0], [0, 0]);
  assert.deepEqual(applied, {
    result: { before: [0, 0], after: [10, 20] },
    writes: 1,
  });
  const undo = runMutation("position", [0, 0], [10, 20], [10, 20]);
  assert.deepEqual(undo.result.after, [0, 0]);
});
test("UI mutation safely transports Unicode, quotes, multiline text and boolean values", () => {
  const value = '中文 "quoted"\nnot executable: __import__("os")';
  const applied = runMutation("text", value, "old", "old");
  assert.equal(applied.result.after, value);
  assert.equal(runMutation("visible", true, false, false).result.after, true);
  assert.throws(
    () =>
      buildMutation({
        screen: "x",
        path: "/x",
        property: "visible",
        value: 1,
        expected: false,
      }),
    /开关值/,
  );
});
test("typed drafts keep incomplete numeric input invalid instead of silently writing zero", () => {
  const position = properties.find((p) => p.key === "position"),
    layer = properties.find((p) => p.key === "layer");
  assert.throws(() => parseValue(position, ["", "2"]), /有效数值/);
  assert.deepEqual(parseValue(position, ["-1.25", "2"]), [-1.25, 2]);
  assert.throws(() => parseValue(layer, "1.5"), /整数/);
});
test("UI pages deduplicate overlaps, merge reveal ranges and preserve pagination from middle pages", () => {
  const node = (index) => ({
    path: "/node" + index,
    name: "node" + index,
    index,
    childCount: 0,
  });
  const old = {
    offset: 160,
    total: 500,
    nodes: Array.from({ length: 160 }, (_, i) => node(i + 160)),
  };
  const next = mergePage(
    old,
    {
      offset: 320,
      total: 500,
      nodes: Array.from({ length: 160 }, (_, i) => node(i + 320)),
    },
    true,
  );
  assert.equal(next.nodes.length, 320);
  let rows = flattenTree({ "": next }, []);
  assert.equal(rows[0].before, true);
  assert.equal(rows.at(-1).offset, 480);
  const preserved = mergeReveal({ "": next }, [
    { parentPath: "", offset: 160, total: 500, nodes: old.nodes },
  ]);
  assert.equal(preserved[""].nodes.length, 320);
  const prepended = mergePage(
    next,
    {
      offset: 0,
      total: 500,
      nodes: Array.from({ length: 160 }, (_, i) => node(i)),
    },
    true,
  );
  assert.equal(prepended.offset, 0);
  assert.equal(prepended.nodes.length, 480);
  rows = flattenTree({ "": prepended }, []);
  assert.equal(rows[0].path, "/node0");
  assert.equal(rows.at(-1).offset, 480);
  const partial = mergePage(
    {
      offset: 0,
      total: 1,
      nodes: [{ path: "/root", index: 0, childCount: 10 }],
    },
    { offset: 0, total: 1, nodes: [{ path: "/root", index: 0 }] },
    true,
  );
  assert.equal(partial.nodes[0].childCount, 10);
  assert.equal(
    flattenTree(
      { "": partial, "/root": { offset: 0, total: 12, nodes: [] } },
      [],
    )[0].childCount,
    12,
  );
});
