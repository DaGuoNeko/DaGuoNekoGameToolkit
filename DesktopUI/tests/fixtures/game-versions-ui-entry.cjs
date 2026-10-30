// Keep discovery, build hashing and IPC real; limit disk discovery to fixture roots.
const path = require("node:path"), Module = require("node:module");
const root = path.resolve(__dirname, "../..");
const discoveryRoot = process.env.DGN_GAME_VERSIONS_ROOT;
if (!discoveryRoot || !path.isAbsolute(discoveryRoot))
  throw Error("Game version UI fixture requires an explicit absolute root");
require("electron").app.setAppPath(root);
const entry = path.join(root, "dist/main.cjs"), compile = Module.prototype._compile;
Module.prototype._compile = function (code, file) {
  if (path.resolve(file) === entry) {
    const marker = "const result = await discoverGames({ known });";
    if (code.split(marker).length !== 2)
      throw Error("Game discovery fixture marker changed");
    code = code.replace(marker, `const result = await discoverGames({ known, roots: [${JSON.stringify(discoveryRoot)}] });`);
  }
  return compile.call(this, code, file);
};
require(entry);
