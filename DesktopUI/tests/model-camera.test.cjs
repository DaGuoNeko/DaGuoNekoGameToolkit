const test = require("node:test"), assert = require("node:assert/strict");
const THREE = require("three");
const { buildSync } = require("esbuild");
const { artifactPath } = require("./fixtures/artifacts.cjs");
const output = artifactPath("build/model-camera.cjs");
buildSync({ entryPoints: [require.resolve("../src/features/mods/model-camera.js")], bundle: true, platform: "node", format: "cjs", outfile: output, logLevel: "silent" });
const { viewPresets, createViewCamera, frameViewCamera, resizeViewCamera } = require(output);
const control = camera => ({ target: new THREE.Vector3(), update() { camera.lookAt(this.target); } });

test("all six orthographic directions and perspective frame offset models at wide and narrow sizes", () => {
  for (const preset of viewPresets) for (const [width, height] of [[900, 250], [120, 650]]) {
    const camera = createViewCamera(preset.value), controls = control(camera);
    const box = new THREE.Box3(new THREE.Vector3(35, -12, 7), new THREE.Vector3(38, -4, 8));
    frameViewCamera(camera, controls, box, width, height);
    for (const x of [35, 38]) for (const y of [-12, -4]) for (const z of [7, 8]) {
      const projected = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1, preset.value + " clips a model corner");
    }
    const direction = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(direction.distanceTo(new THREE.Vector3(...preset.direction).normalize().negate()) < 0.00001);
    const center = box.getCenter(new THREE.Vector3()).project(camera);
    assert.ok(Math.abs(center.x) < 0.00001 && Math.abs(center.y) < 0.00001);
  }
});

test("orthographic depth does not change pixel size and resize preserves zoom and target", () => {
  const camera = createViewCamera("south"), controls = control(camera);
  frameViewCamera(camera, controls, new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)), 600, 400);
  const pixelSpan = z => new THREE.Vector3(1, 0, z).project(camera).x - new THREE.Vector3(0, 0, z).project(camera).x;
  assert.equal(pixelSpan(-10), pixelSpan(1));
  camera.zoom = 2.5;
  const target = controls.target.clone(), position = camera.position.clone();
  resizeViewCamera(camera, 300, 800);
  assert.equal(camera.zoom, 2.5); assert.ok(position.equals(camera.position)); assert.ok(target.equals(controls.target));
  assert.equal((camera.right - camera.left) / (camera.top - camera.bottom), 300 / 800);
});

test("top/bottom orientation is stable and empty geometry leaves a finite camera", () => {
  for (const view of ["top", "bottom"]) {
    const camera = createViewCamera(view), controls = control(camera);
    frameViewCamera(camera, controls, new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)), 300, 300);
    assert.ok(new THREE.Vector3(1, 0, 0).project(camera).x > 0);
    assert.equal(Math.sign(new THREE.Vector3(0, 0, 1).project(camera).y), view === "top" ? -1 : 1);
    const before = camera.position.clone(); frameViewCamera(camera, controls, new THREE.Box3(), 0, 0);
    assert.ok(before.equals(camera.position));
    resizeViewCamera(camera, 0, 0); assert.ok(camera.projectionMatrix.elements.every(Number.isFinite));
  }
  assert.throws(() => createViewCamera("unknown"), /无效/);
});
