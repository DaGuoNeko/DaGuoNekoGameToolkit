const ui = require("./vendor/uiDebugger.cjs");
function visibleChildren(screen, parent, offset) {
  const source = ui.buildUiDebuggerChildrenCode(screen, parent, offset);
  return (
    source +
    "\nimport gui as _mcdev_ui_gui\ndef _mcdev_ui_visibility(p):\n try:return bool(_mcdev_ui_gui.get_visible(s,p))\n except:return None\n" +
    `_result=[_result[0],[list(x)+[_mcdev_ui_visibility(${parent ? "p.rstrip('/')+'/'+x[0]" : "'/'+x[0]"})] for x in _result[1]]]`
  );
}
function parseChildren(value, parent, offset) {
  const result = ui.parseUiDebuggerChildren(value, parent, offset);
  const visibility = new Map(
    value[1]
      .filter((row) => Array.isArray(row) && typeof row[4] === "boolean")
      .map((row) => [row[0], row[4]]),
  );
  result.nodes = result.nodes.map((node) => ({
    ...node,
    ...(visibility.has(node.name)
      ? { visible: visibility.get(node.name) }
      : {}),
  }));
  return result;
}
function selectionCode(screen, path, reveal, highlight) {
  const lines = [
    ...(highlight ? [highlightCode(screen, path)] : []),
    ui.buildUiDebuggerNodeCode(screen, path),
    "_mcdev_ui_details=_result",
  ];
  if (reveal)
    lines.push(
      ui.buildUiDebuggerRevealCode(screen, path),
      "import gui as _mcdev_ui_gui\ndef _mcdev_ui_visibility(p):\n try:return bool(_mcdev_ui_gui.get_visible(s,p))\n except:return None",
      "_mcdev_ui_pages=[[page[0],page[1],page[2],[list(x)+[_mcdev_ui_visibility(page[0].rstrip('/')+'/'+x[0])] for x in page[3]]] for page in _result]",
    );
  else lines.push("_mcdev_ui_pages=[]");
  lines.push("_result=[_mcdev_ui_details,_mcdev_ui_pages]");
  return lines.join("\n");
}
function highlightCode(screen, path) {
  return [
    ...ui.buildUiDebuggerPickerSelectCode(screen, path).split("\n").slice(0, 2),
    "gui.nud_set_selected_controls(p);_result=True",
  ].join("\n");
}
function pickerEnableCode(bounds) {
  return [
    "import gui,json,mobile_logger,_gui",
    "from common import eventUtil",
    "if not globals().get('_mcdev_ui_listener'):",
    " _mcdev_ui_old_logger=mobile_logger.OPEN_SAFAIA_TEST_LOGGER",
    " mobile_logger.OPEN_SAFAIA_TEST_LOGGER=True",
    " _mcdev_ui_old_enabled=bool(gui.get_netease_ui_debugger_enable())",
    " _mcdev_ui_event=None;_mcdev_ui_screen_changed=False",
    " def _mcdev_ui_resolve(p):",
    "  a=p.split('/');n=a[1] if len(a)>2 else '';cp='/'+ '/'.join(a[2:])",
    "  try:ss=_gui.get_all_screen_fullnames() or []",
    "  except:return None",
    "  for s in reversed(ss):",
    "   if s!=n and not s.endswith('.'+n):continue",
    "   try:",
    "    t=_gui.get_control_def_type(s,cp)",
    "    if isinstance(t,(int,long)) and 0<=t<=31:return s",
    "   except:pass",
    "  return None",
    " class _MCDevUiListener(object):",
    "  def __init__(self):self.active=True",
    "  def on_event(self,args):",
    "   global _mcdev_ui_event,_mcdev_ui_screen_changed",
    "   if not self.active:return",
    "   d=args if isinstance(args,dict) and 'handle' in args else args.get('data') if isinstance(args,dict) else args",
    "   if isinstance(d,basestring):",
    "    try:d=json.loads(d)",
    "    except:return",
    "   if not isinstance(d,dict) or d.get('success') is not True:return",
    "   if d.get('handle')==4:",
    "    _mcdev_ui_screen_changed=True;_mcdev_ui_event=None;return",
    "   if d.get('handle')!=7:return",
    "   paths=d.get('data')",
    "   if not isinstance(paths,(list,tuple)):return",
    "   for p in paths[:64]:",
    "    if not isinstance(p,basestring) or not p.startswith('/') or p.count('/')<2 or len(p)>8192:continue",
    "    s=_mcdev_ui_resolve(p)",
    "    if s:_mcdev_ui_event=[None,s,p];return",
    " _mcdev_ui_listener=_MCDevUiListener()",
    " eventUtil.instance.ListenForEngineClient('UIDebuggerNotifyEvent',_mcdev_ui_listener,_mcdev_ui_listener.on_event)",
    "gui.set_netease_ui_debugger_enable(True)",
    `gui.nud_set_bounds_visible(${bounds ? "True" : "False"})`,
    "_result=bool(gui.get_netease_ui_debugger_enable())",
  ].join("\n");
}
function pickerPollCode() {
  return "_result=[globals().get('_mcdev_ui_event'),gui.get_all_screen_fullnames(),bool(globals().get('_mcdev_ui_screen_changed'))];_mcdev_ui_event=None;_mcdev_ui_screen_changed=False";
}
function parseReveal(value) {
  return ui.parseUiDebuggerReveal(value).map((page) => {
    const raw = value.find(
      (item) => Array.isArray(item) && item[0] === page.parentPath,
    );
    return {
      ...page,
      ...parseChildren(
        [page.total, Array.isArray(raw[3]) ? raw[3] : raw[2]],
        page.parentPath,
        page.offset,
      ),
    };
  });
}
function toggleVisibilityCode(screen, path) {
  const lines = ui
    .buildUiDebuggerVisibilityCode(screen, path, true)
    .split("\n");
  lines[2] =
    "_mcdev_ui_before=bool(q.get_visible(s,p));q.set_visible(s,p,not _mcdev_ui_before);_result={'before':_mcdev_ui_before,'after':bool(q.get_visible(s,p))}";
  return lines.join("\n");
}
module.exports = {
  visibleChildren,
  parseChildren,
  parseReveal,
  selectionCode,
  toggleVisibilityCode,
  highlightCode,
  pickerEnableCode,
  pickerPollCode,
};
