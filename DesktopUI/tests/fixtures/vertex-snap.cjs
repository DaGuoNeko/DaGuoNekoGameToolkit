const { buildSync } = require("esbuild");
const { artifactPath } = require("./artifacts.cjs");
const output = artifactPath("build/vertex-snap.cjs");
buildSync({ entryPoints: [require.resolve("../../src/features/mods/model-vertex-snap.js")], bundle: true, platform: "node", format: "cjs", outfile: output, logLevel: "silent" });
module.exports = require(output);
