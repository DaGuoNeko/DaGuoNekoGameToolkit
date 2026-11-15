const corners = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const faceCorners = { east: [1, 5, 6, 2], west: [4, 0, 3, 7], up: [3, 2, 6, 7], down: [0, 4, 5, 1], south: [5, 4, 7, 6], north: [0, 1, 2, 3] };
const finite = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1000000;

function validateVertices(value) {
  if (!Array.isArray(value) || value.length !== 8 || value.some(point => !Array.isArray(point) || point.length !== 3 || point.some(item => !finite(item)))) throw Error("立方体顶点必须是 8 组三维有限坐标");
  return value.map(point => point.slice());
}

function cubeVertices(cube) {
  if (cube?.dgn_vertices !== undefined) return validateVertices(cube.dgn_vertices);
  const origin = Array.isArray(cube?.origin) ? cube.origin : [0, 0, 0], size = Array.isArray(cube?.size) ? cube.size : [0, 0, 0];
  if (origin.some(item => !finite(item)) || size.some(item => !finite(item))) throw Error("立方体起点或尺寸无效");
  return corners.map(point => [origin[0] + size[0] * point[0], origin[1] + size[1] * point[1], origin[2] + size[2] * point[2]]);
}

function inflateCubeVertices(cube) {
  const points = cubeVertices(cube);
  const inflate = Number(cube?.inflate) || 0;
  if (!inflate) return points;
  const origin = Array.isArray(cube?.origin) ? cube.origin : [0, 0, 0];
  const size = Array.isArray(cube?.size) ? cube.size : [0, 0, 0];
  return points.map(point => point.map((value, axis) => {
    const center = (Number(origin[axis]) || 0) + (Number(size[axis]) || 0) / 2;
    const delta = value - center;
    if (Math.abs(delta) <= 1e-8) return value;
    return value + Math.sign(delta) * inflate;
  }));
}

function defaultVertices(cube) {
  return cubeVertices({ ...cube, dgn_vertices: undefined });
}

function setCubeVertices(bones, boneName, cubeIndex, vertices) {
  const nextVertices = validateVertices(vertices);
  let changed = false;
  const next = bones.map(bone => {
    if (bone.name !== boneName) return bone;
    return { ...bone, cubes: (bone.cubes || []).map((cube, index) => {
      if (index !== cubeIndex) return cube;
      const copy = assignVertices(cube, nextVertices);
      if (copy !== cube) changed = true;
      return copy;
    }) };
  });
  return changed ? next : bones;
}

function roundVertex(value) {
  const next = Math.round((value + Number.EPSILON) * 1000) / 1000;
  if (!finite(next)) throw Error("顶点坐标超出范围");
  return next === 0 ? 0 : next;
}

function assignVertices(cube, vertices) {
  const next = validateVertices(vertices);
  const defaults = defaultVertices(cube);
  const copy = { ...cube };
  if (next.every((point, index) => point.every((value, axis) => value === defaults[index][axis]))) delete copy.dgn_vertices;
  else copy.dgn_vertices = next;
  return JSON.stringify(copy) === JSON.stringify(cube) ? cube : copy;
}

function translateVertices(cube, delta) {
  if (cube?.dgn_vertices === undefined) return cube;
  return assignVertices(cube, cube.dgn_vertices.map(point => point.map((value, axis) => roundVertex(value + (Number(delta?.[axis]) || 0)))));
}

function scaleVertices(cube, anchor, ratios) {
  if (cube?.dgn_vertices === undefined) return cube;
  if (!Array.isArray(anchor) || anchor.length !== 3 || anchor.some(item => !finite(item)) || !Array.isArray(ratios) || ratios.length !== 3 || ratios.some(item => !finite(item))) throw Error("顶点缩放参数无效");
  return assignVertices(cube, cube.dgn_vertices.map(point => point.map((value, axis) => roundVertex(anchor[axis] + (value - anchor[axis]) * ratios[axis]))));
}

function moveCubeGeometry(cube, origin) {
  if (!Array.isArray(origin) || origin.length !== 3 || origin.some(item => !finite(item))) throw Error("立方体起点无效");
  const current = Array.isArray(cube?.origin) ? cube.origin : [0, 0, 0];
  const next = { ...cube, origin: origin.slice() };
  return translateVertices(next, origin.map((value, axis) => value - (Number(current[axis]) || 0)));
}

function resizeCubeGeometry(cube, size) {
  if (!Array.isArray(size) || size.length !== 3 || size.some(item => !finite(item))) throw Error("立方体尺寸无效");
  const current = Array.isArray(cube?.size) ? cube.size : [0, 0, 0];
  const ratios = size.map((value, axis) => {
    const before = Number(current[axis]) || 0;
    if (before === 0) {
      if (value !== before && cube?.dgn_vertices !== undefined) throw Error("自定义顶点所在尺寸为 0，不能按比例缩放");
      return 1;
    }
    return value / before;
  });
  const next = { ...cube, size: size.slice() };
  const origin = Array.isArray(cube?.origin) ? cube.origin : [0, 0, 0];
  return scaleVertices(next, origin, ratios);
}

function moveVertex(bones, boneName, cubeIndex, vertexIndex, delta) {
  const cube = bones.find(bone => bone.name === boneName)?.cubes?.[cubeIndex];
  if (!cube || !Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex > 7) throw Error("请选择一个顶点");
  if (!Array.isArray(delta) || delta.length !== 3 || delta.some(item => !finite(item))) throw Error("顶点移动量无效");
  const next = cubeVertices(cube).map(point => point.slice());
  next[vertexIndex] = next[vertexIndex].map((value, axis) => roundVertex(value + Number(delta[axis])));
  return setCubeVertices(bones, boneName, cubeIndex, next);
}

function moveVertices(bones, boneName, cubeIndex, indices, delta) {
  const unique = [...new Set(indices || [])];
  if (!unique.length || unique.some(index => !Number.isInteger(index) || index < 0 || index > 7)) throw Error("请选择一个顶点");
  let next = bones;
  for (const index of unique) next = moveVertex(next, boneName, cubeIndex, index, delta);
  return next;
}

function vertexCenter(points, indices) {
  const sum = [0, 0, 0];
  for (const index of indices) points[index].forEach((value, axis) => { sum[axis] += value; });
  return sum.map(value => value / indices.length);
}

function rotatePoint(point, center, degrees) {
  let x = point[0] - center[0], y = point[1] - center[1], z = point[2] - center[2];
  for (const axis of [0, 1, 2]) {
    const angle = Number(degrees[axis]) || 0;
    if (!angle) continue;
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
    if (axis === 0) { const y2 = y * c - z * s, z2 = y * s + z * c; y = y2; z = z2; }
    if (axis === 1) { const x2 = x * c + z * s, z2 = z * c - x * s; x = x2; z = z2; }
    if (axis === 2) { const x2 = x * c - y * s, y2 = x * s + y * c; x = x2; y = y2; }
  }
  return [x, y, z].map((value, axis) => roundVertex(value + center[axis]));
}

function scalePoint(point, center, delta, points, indices) {
  return point.map((value, axis) => {
    const change = Number(delta[axis]) || 0;
    if (!change) return value;
    let span = 0;
    for (const index of indices) span = Math.max(span, Math.abs(points[index][axis] - center[axis]));
    if (span <= 1e-8) throw Error("所选顶点在该轴上没有跨度，不能缩放");
    return roundVertex(center[axis] + (value - center[axis]) * ((span + change) / span));
  });
}

function transformVertices(bones, boneName, cubeIndex, indices, gesture, delta) {
  if (!["move", "rotate", "scale"].includes(gesture)) throw Error("顶点变换方式无效");
  if (gesture === "move") return moveVertices(bones, boneName, cubeIndex, indices, delta);
  const unique = [...new Set(indices || [])];
  const cube = bones.find(bone => bone.name === boneName)?.cubes?.[cubeIndex];
  if (!cube || !unique.length || unique.some(index => !Number.isInteger(index) || index < 0 || index > 7)) throw Error("请选择一个顶点");
  if (!Array.isArray(delta) || delta.length !== 3 || delta.some(item => !finite(item))) throw Error("顶点变换量无效");
  const points = cubeVertices(cube).map(point => point.slice());
  const center = vertexCenter(points, unique);
  const selected = new Set(unique);
  const next = points.map((point, index) => selected.has(index) ? (gesture === "rotate" ? rotatePoint(point, center, delta) : scalePoint(point, center, delta, points, unique)) : point);
  return setCubeVertices(bones, boneName, cubeIndex, next);
}

function mirrorVertices(bones, boneName, cubeIndex, indices, axis) {
  if (![0, 1, 2].includes(axis)) throw Error("镜像轴无效");
  const unique = [...new Set(indices || [])];
  const cube = bones.find(bone => bone.name === boneName)?.cubes?.[cubeIndex];
  if (!cube || !unique.length || unique.some(index => !Number.isInteger(index) || index < 0 || index > 7)) throw Error("请选择一个顶点");
  const points = cubeVertices(cube).map(point => point.slice());
  const center = vertexCenter(points, unique);
  for (const index of unique) points[index][axis] = roundVertex(center[axis] * 2 - points[index][axis]);
  return setCubeVertices(bones, boneName, cubeIndex, points);
}

function extrudeCubeFace(bones, boneName, cubeIndex, face) {
  const indices = faceCorners[face];
  const bone = bones.find(item => item.name === boneName);
  const cube = bone?.cubes?.[cubeIndex];
  if (!indices || !cube) throw Error("请选择要挤出的面");
  if (bones.reduce((sum, item) => sum + (item.cubes || []).length, 0) >= 2000) throw Error("立方体数量超过 2000");
  const points = cubeVertices(cube);
  const { normal, thickness } = faceFrame(points, face);
  if (thickness <= 1e-6) throw Error("这个面没有可挤出的厚度");
  const moved = points.map(point => point.map((value, axis) => roundVertex(value + normal[axis] * thickness)));
  const origin = [0, 1, 2].map(axis => roundVertex(Math.min(...moved.map(point => point[axis]))));
  const size = [0, 1, 2].map(axis => roundVertex(Math.max(...moved.map(point => point[axis])) - origin[axis]));
  const created = { origin, size };
  if (cube.uv !== undefined) created.uv = JSON.parse(JSON.stringify(cube.uv));
  if (cube.mirror) created.mirror = true;
  if (Array.isArray(cube.rotation)) created.rotation = cube.rotation.slice();
  if (Array.isArray(cube.pivot)) created.pivot = cube.pivot.map((value, axis) => roundVertex(value + normal[axis] * thickness));
  if (cube.inflate) created.inflate = cube.inflate;
  const defaults = cubeVertices(created);
  if (!moved.every((point, index) => point.every((value, axis) => value === defaults[index][axis]))) created.dgn_vertices = moved;
  return bones.map(item => item.name === boneName ? { ...item, cubes: [...(item.cubes || []), created] } : item);
}

function faceFrame(points, face) {
  const indices = faceCorners[face];
  if (!indices) throw Error("请选择要挤出的面");
  const quad = indices.map(index => points[index]);
  const edgeA = quad[1].map((value, axis) => value - quad[0][axis]);
  const edgeB = quad[3].map((value, axis) => value - quad[0][axis]);
  let normal = [edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]];
  const length = Math.hypot(...normal);
  if (length <= 1e-8) throw Error("这个面没有面积");
  normal = normal.map(value => value / length);
  const center = [0, 1, 2].map(axis => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
  const faceCenter = [0, 1, 2].map(axis => quad.reduce((sum, point) => sum + point[axis], 0) / quad.length);
  if (normal.reduce((sum, value, axis) => sum + value * (faceCenter[axis] - center[axis]), 0) < 0) normal = normal.map(value => -value);
  const plane = normal.reduce((sum, value, axis) => sum + value * faceCenter[axis], 0);
  const thickness = points.reduce((max, point) => Math.max(max, plane - normal.reduce((sum, value, axis) => sum + value * point[axis], 0)), 0);
  return { indices, normal, faceCenter, thickness };
}

function replaceCubePoints(bones, boneName, cubeIndex, points) {
  const rounded = points.map(point => point.map(roundVertex));
  let found = false;
  const next = bones.map(bone => {
    if (bone.name !== boneName) return bone;
    return { ...bone, cubes: (bone.cubes || []).map((cube, index) => {
      if (index !== cubeIndex) return cube;
      found = true;
      const stored = cubeWithPoints(cube, rounded);
      return JSON.stringify(stored) === JSON.stringify(cube) ? cube : stored;
    }) };
  });
  if (!found) throw Error("请选择一个立方体");
  return next;
}

function cubeWithPoints(cube, points) {
  const origin = [0, 1, 2].map(axis => roundVertex(Math.min(...points.map(point => point[axis]))));
  const size = [0, 1, 2].map(axis => roundVertex(Math.max(...points.map(point => point[axis])) - origin[axis]));
  const stored = { ...cube, origin, size };
  const defaults = cubeVertices(stored);
  if (points.every((point, index) => point.every((value, axis) => value === defaults[index][axis]))) delete stored.dgn_vertices;
  else stored.dgn_vertices = points.map(point => point.slice());
  return stored;
}

function splitCube(bones, boneName, cubeIndex, axis, segments) {
  if (![0, 1, 2].includes(axis)) throw Error("切开轴向无效");
  if (!Number.isInteger(segments) || segments < 2 || segments > 8) throw Error("切开段数须为 2 到 8");
  const bone = bones.find(item => item.name === boneName);
  const cube = bone?.cubes?.[cubeIndex];
  if (!cube) throw Error("请选择一个立方体");
  if (bones.reduce((sum, item) => sum + (item.cubes || []).length, 0) + segments - 1 > 2000) throw Error("立方体数量超过 2000");
  const points = cubeVertices(cube);
  const span = Math.max(...corners.flatMap((mark, index) => mark[axis] === 0 ? [Math.hypot(...points[index].map((value, i) => points[corners.findIndex(item => item.every((bit, bitIndex) => bit === (bitIndex === axis ? 1 : mark[bitIndex])))][i] - value))] : []));
  if (span <= 1e-6) throw Error("这个方向没有厚度，不能切开");
  // shortcut: 各段复制原 UV 和轴心，不重新展开贴图；变形边只在两端之间按比例取点。
  const pieces = [];
  for (let part = 0; part < segments; part++) {
    const shaped = points.map((_, index) => {
      const mark = corners[index].slice();
      mark[axis] = 0;
      const low = corners.findIndex(item => item.every((value, i) => value === mark[i]));
      mark[axis] = 1;
      const high = corners.findIndex(item => item.every((value, i) => value === mark[i]));
      const at = value => points[low].map((start, i) => roundVertex(start + (points[high][i] - start) * value));
      return corners[index][axis] === 0 ? at(part / segments) : at((part + 1) / segments);
    });
    const piece = cubeWithPoints(cube, shaped);
    if (piece.name) {
      const suffix = " " + (part + 1);
      piece.name = (piece.name + suffix).length <= 64 ? piece.name + suffix : piece.name;
    }
    if (part > 0) delete piece.dgnId;
    pieces.push(piece);
  }
  return bones.map(item => item.name !== boneName ? item : { ...item, cubes: item.cubes.flatMap((itemCube, index) => index === cubeIndex ? pieces : [itemCube]) });
}

function pushFace(bones, boneName, cubeIndex, face, distance) {
  if (!finite(distance) || distance === 0) throw Error("推出距离无效");
  const cube = bones.find(bone => bone.name === boneName)?.cubes?.[cubeIndex];
  if (!cube) throw Error("请选择一个立方体");
  const points = cubeVertices(cube).map(point => point.slice());
  const frame = faceFrame(points, face);
  for (const index of frame.indices) points[index] = points[index].map((value, axis) => roundVertex(value + frame.normal[axis] * distance));
  return replaceCubePoints(bones, boneName, cubeIndex, points);
}

function insetFace(bones, boneName, cubeIndex, face, distance) {
  if (!finite(distance) || distance <= 0) throw Error("收缩距离无效");
  const cube = bones.find(bone => bone.name === boneName)?.cubes?.[cubeIndex];
  if (!cube) throw Error("请选择一个立方体");
  const points = cubeVertices(cube).map(point => point.slice());
  const frame = faceFrame(points, face);
  for (const index of frame.indices) {
    const offset = points[index].map((value, axis) => value - frame.faceCenter[axis]);
    const span = Math.hypot(...offset);
    if (span <= 1e-8) continue;
    const step = Math.min(distance, span);
    points[index] = points[index].map((value, axis) => roundVertex(value - offset[axis] / span * step));
  }
  return replaceCubePoints(bones, boneName, cubeIndex, points);
}

function setVertexComponent(bones, boneName, cubeIndex, indices, axis, value) {
  const cube = bones.find(bone => bone.name === boneName)?.cubes?.[cubeIndex];
  const unique = [...new Set(indices || [])];
  if (!cube || !Number.isInteger(axis) || axis < 0 || axis > 2 || !finite(value) || !unique.length || unique.some(index => !Number.isInteger(index) || index < 0 || index > 7)) throw Error("请选择一个顶点");
  const next = cubeVertices(cube).map(point => point.slice());
  for (const index of unique) next[index][axis] = roundVertex(value);
  return setCubeVertices(bones, boneName, cubeIndex, next);
}

module.exports = { corners, faceCorners, validateVertices, cubeVertices, defaultVertices, setCubeVertices, inflateCubeVertices, scaleVertices, moveCubeGeometry, resizeCubeGeometry, moveVertex, moveVertices, setVertexComponent, transformVertices, mirrorVertices, extrudeCubeFace, pushFace, insetFace, splitCube };
