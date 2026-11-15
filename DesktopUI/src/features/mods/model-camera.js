import * as THREE from "three";

export const viewPresets = [
  { value: "perspective", label: "透视", direction: [0.55, 0.35, 1] },
  { value: "top", label: "顶视图", direction: [0, 1, 0], up: [0, 0, -1] },
  { value: "bottom", label: "底视图", direction: [0, -1, 0], up: [0, 0, 1] },
  { value: "south", label: "前视图（南）", direction: [0, 0, 1] },
  { value: "north", label: "后视图（北）", direction: [0, 0, -1] },
  { value: "east", label: "右视图（东）", direction: [1, 0, 0] },
  { value: "west", label: "左视图（西）", direction: [-1, 0, 0] },
];

export function createViewCamera(view) {
  const preset = viewPresets.find(item => item.value === view);
  if (!preset) throw Error("无效模型视角");
  const camera = view === "perspective" ? new THREE.PerspectiveCamera(40, 1, 0.01, 200) : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 200);
  camera.position.fromArray(preset.direction);
  camera.up.fromArray(preset.up || [0, 1, 0]);
  camera.lookAt(0, 0, 0);
  camera.userData.span = 2;
  return camera;
}

export function resizeViewCamera(camera, width, height) {
  const aspect = Math.max(1, width) / Math.max(1, height);
  if (camera.isPerspectiveCamera) camera.aspect = aspect;
  else {
    const half = camera.userData.span / 2;
    camera.left = -half * aspect; camera.right = half * aspect;
    camera.top = half; camera.bottom = -half;
  }
  camera.updateProjectionMatrix();
}

export function applyViewPose(camera, controls, slot, width, height) {
  const preset = viewPresets.find(item => item.value === slot.view);
  camera.up.fromArray(preset?.up || [0, 1, 0]);
  camera.position.fromArray(slot.position);
  camera.lookAt(slot.target[0], slot.target[1], slot.target[2]);
  camera.userData.span = slot.span;
  camera.zoom = slot.zoom;
  controls?.target.fromArray(slot.target);
  resizeViewCamera(camera, Math.max(1, width), Math.max(1, height));
  controls?.update();
  camera.updateMatrixWorld();
}

export function readViewPose(camera, controls, view) {
  const round = value => Math.round(value * 1000) / 1000;
  return {
    view,
    custom: true,
    position: camera.position.toArray().map(round),
    target: controls.target.toArray().map(round),
    span: round(camera.userData.span || 2),
    zoom: round(camera.zoom || 1),
  };
}

export function frameViewCamera(camera, controls, box, width, height) {
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const offset = camera.position.clone().sub(controls.target).normalize();
  if (offset.lengthSq() < 0.0001) offset.set(0.55, 0.35, 1).normalize();
  camera.position.copy(center).add(offset); camera.lookAt(center);
  const inverse = camera.quaternion.clone().invert();
  const aspect = Math.max(1, width) / Math.max(1, height);
  let halfWidth = 0.1, halfHeight = 0.1, halfDepth = 0.1;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const point = new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverse);
    halfWidth = Math.max(halfWidth, Math.abs(point.x));
    halfHeight = Math.max(halfHeight, Math.abs(point.y));
    halfDepth = Math.max(halfDepth, Math.abs(point.z));
  }
  const halfSpan = Math.max(halfHeight, halfWidth / aspect) * 1.3;
  const distance = camera.isPerspectiveCamera ? halfDepth + halfSpan / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) : halfDepth + 4;
  camera.userData.span = halfSpan * 2;
  camera.zoom = 1;
  camera.far = Math.max(200, distance + halfDepth * 2 + 10);
  camera.position.copy(center).addScaledVector(offset, distance);
  controls.target.copy(center);
  resizeViewCamera(camera, width, height);
  controls.update(); camera.updateMatrixWorld();
}
