const { buildSync } = require("esbuild");
const { Vector3 } = require("three");
const { artifactPath } = require("./artifacts.cjs");
const modelFile = artifactPath("build/pose-model.cjs"), moveFile = artifactPath("build/pose-move.cjs");
for (const [entry, outfile] of [["../../src/features/skins/npc-model-view.jsx", modelFile], ["../../src/features/mods/model-reparent.js", moveFile]]) {
  buildSync({ entryPoints: [require.resolve(entry)], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent" });
}
const { buildModel } = require(modelFile), { moveCubesKeepingPose } = require(moveFile);

function worldVertices(bones) {
  const built = buildModel({ tw: 64, th: 64, bones }); built.root.updateMatrixWorld(true);
  const result = {};
  for (const mesh of built.meshes) {
    const key = mesh.userData.cubeKey, split = key.lastIndexOf(":"), bone = bones.find(item => item.name === key.slice(0, split)), cube = bone.cubes[Number(key.slice(split + 1))];
    const positions = mesh.geometry.attributes.position;
    result[cube.name || cube.dgnId] = Array.from({ length: positions.count }, (_, i) => new Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).multiplyScalar(16).toArray());
    mesh.geometry.dispose(); mesh.material.dispose();
  }
  return result;
}

module.exports = { worldVertices, moveCubesKeepingPose };
