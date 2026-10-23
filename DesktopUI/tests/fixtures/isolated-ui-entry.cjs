// Test-only bootstrap. A running user's development game must remain untouched.
// Replace only OS conflict discovery in the in-memory fixture build; the real
// Sessions, launcher child PID, Host Bridge auth and action routing still run.
const path = require("node:path"),
  Module = require("node:module");
const root = process.env.DGN_UI_BUNDLE_DIR || path.resolve(__dirname, "../..");
const entry = path.join(
  root,
  process.env.DGN_UI_BUNDLE_DIR ? "app.asar/dist/main.cjs" : "dist/main.cjs",
);
require("electron").app.setAppPath(root);
const original = Module.prototype._compile;
Module.prototype._compile = function (code, file) {
  if (path.resolve(file) === entry) {
    const marker = "query = queryProcesses,";
    if (code.split(marker).length !== 2)
      throw Error("Process fixture injection point changed");
    code = code.replace(marker, "query = async () => [],");
  }
  return original.call(this, code, file);
};
require(entry);
