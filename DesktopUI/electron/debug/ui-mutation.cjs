const ui = require("./vendor/uiDebugger.cjs");
function pythonJson(value) {
  const quoted = JSON.stringify(JSON.stringify(value)).replace(
    /[\u007f-\uffff]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return `json.loads(u${quoted})`;
}
function buildMutation({ screen, path, property, value, expected }) {
  let source;
  if (property === "visible") {
    if (typeof value !== "boolean" || typeof expected !== "boolean")
      throw Error("可见性必须为开关值");
    source = ui.buildUiDebuggerVisibilityCode(screen, path, value);
  } else {
    ui.normalizeUiDebuggerPropertyValue(property, expected);
    source = ui.buildUiDebuggerPropertyCode(screen, path, property, value);
  }
  const lines = source.split("\n"),
    operation = lines.pop();
  const getter = operation.slice(
    operation.indexOf(";_result=") + ";_result=".length,
  );
  return [
    "import json",
    ...lines,
    `_mcdev_ui_before=${getter}`,
    `_mcdev_ui_expected=${pythonJson(expected)}`,
    "if json.loads(json.dumps(_mcdev_ui_before))!=_mcdev_ui_expected:",
    " raise RuntimeError('UI_PROPERTY_CHANGED: property changed since last read; refresh before applying')",
    operation,
    "_result={'before':_mcdev_ui_before,'after':_result}",
  ].join("\n");
}
module.exports = { buildMutation };
