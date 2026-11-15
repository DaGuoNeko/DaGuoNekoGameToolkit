const { faceUvCorners } = require("./model-edit.cjs");
const { faceCorners, inflateCubeVertices } = require("./model-vertex-edit.cjs");
const { texturePath } = require("./model-materials.cjs");

const faceOrder = ["east", "west", "up", "down", "south", "north"];

function round(value, limit) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > limit) throw Error("网格数据无效");
  return Math.round(number * 1000) / 1000;
}

function cubePivot(cube) {
  if (Array.isArray(cube?.pivot) && cube.pivot.length === 3) return cube.pivot.map(value => Number(value) || 0);
  const origin = Array.isArray(cube?.origin) ? cube.origin : [0, 0, 0];
  const size = Array.isArray(cube?.size) ? cube.size : [0, 0, 0];
  return [0, 1, 2].map(axis => (Number(origin[axis]) || 0) + (Number(size[axis]) || 0) / 2);
}

function bakeCubePoint(point, pivot, rotation) {
  const turns = rotation || [0, 0, 0];
  if (!turns.some(value => Number(value))) return point.map(value => round(value, 4096));
  // 预览里立方体的旋转和骨骼相反，这里用同一套取反后的 ZYX。
  const x = -(Number(turns[0]) || 0) * Math.PI / 180;
  const y = -(Number(turns[1]) || 0) * Math.PI / 180;
  const z = -(Number(turns[2]) || 0) * Math.PI / 180;
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  const local = point.map((value, axis) => value - pivot[axis]);
  const rotated = [
    c * e * local[0] + (be * d - af) * local[1] + (ae * d + bf) * local[2],
    c * f * local[0] + (bf * d + ae) * local[1] + (af * d - be) * local[2],
    -d * local[0] + b * c * local[1] + a * c * local[2],
  ];
  return rotated.map((value, axis) => round(value + pivot[axis], 4096));
}

function boxFaces(uv, size, mirror) {
  const [w, h, d] = size;
  const [u, v] = uv;
  const faces = {
    east: [u, v + d, d, h],
    west: [u + d + w, v + d, d, h],
    up: [u + d, v, w, d],
    down: [u + d + w, v + d, w, d],
    north: [u + d, v + d, w, h],
    south: [u + d + w + d, v + d, w, h],
  };
  if (mirror) [faces.east, faces.west] = [faces.west, faces.east];
  return faces;
}

function faceRect(cube, name) {
  if (Array.isArray(cube.uv)) {
    const size = (Array.isArray(cube.size) ? cube.size : [0, 0, 0]).map(value => Math.abs(Number(value) || 0));
    return { rect: boxFaces(cube.uv, size, cube.mirror)[name], rotation: 0, texture: "" };
  }
  const face = cube.uv?.[name];
  if (!face) return null;
  if (face.material_instance) throw Error("命名材质还不能转成网格");
  if (!face.uv || !face.uv_size) return null;
  return { rect: [face.uv[0], face.uv[1], face.uv_size[0], face.uv_size[1]], rotation: face.uv_rotation || 0, texture: face.dgn_texture || "" };
}

function normalizeMesh(mesh, welds) {
  if (!mesh || mesh.normalized_uvs !== false || !Array.isArray(mesh.positions) || mesh.positions.length > 256) throw Error("网格顶点数量无效");
  if (!Array.isArray(mesh.polys) || mesh.polys.length > 128) throw Error("网格面数量无效");
  if (!Array.isArray(mesh.uvs) || mesh.uvs.length !== mesh.positions.length) throw Error("网格 UV 数量不匹配");
  const positions = mesh.positions.map(point => {
    if (!Array.isArray(point) || point.length !== 3) throw Error("网格顶点无效");
    return point.map(value => round(value, 4096));
  });
  const uvs = mesh.uvs.map(point => {
    if (!Array.isArray(point) || point.length !== 2) throw Error("网格 UV 无效");
    return point.map(value => round(value, 8192));
  });
  const polys = mesh.polys.map(poly => {
    if (!Array.isArray(poly) || (poly.length !== 3 && poly.length !== 4)) throw Error("网格面必须是三角或四边");
    if (new Set(poly).size !== poly.length || poly.some(index => !Number.isInteger(index) || index < 0 || index >= positions.length)) throw Error("网格面顶点无效");
    return poly.slice();
  });
  if (mesh.face_textures != null && (!Array.isArray(mesh.face_textures) || mesh.face_textures.length !== polys.length)) throw Error("网格面贴图数量不匹配");
  const textures = mesh.face_textures == null ? polys.map(() => "") : mesh.face_textures.map(value => value ? texturePath(value) : "");
  const source = welds || positions.map((_, index) => index);
  if (!Array.isArray(source) || source.length !== positions.length || source.some(index => !Number.isInteger(index) || index < 0 || index > 255)) throw Error("网格焊接数据无效");
  const poly_mesh = { normalized_uvs: false, positions, uvs, polys };
  if (textures.some(Boolean)) poly_mesh.face_textures = textures;
  return { poly_mesh, dgn_mesh_welds: source.slice() };
}

function convertCubeToMesh(bones, boneName, cubeIndex) {
  const bone = (bones || []).find(item => item.name === boneName);
  if (!bone) throw Error("骨骼不存在");
  if (bone.poly_mesh) throw Error("这根骨骼已经有网格");
  const cube = bone.cubes?.[cubeIndex];
  if (!cube) throw Error("立方体不存在");
  const pivot = cubePivot(cube);
  const points = inflateCubeVertices(cube).map(point => bakeCubePoint(point, pivot, cube.rotation));
  const positions = [], uvs = [], welds = [], polys = [], textures = [];
  for (const name of faceOrder) {
    const face = faceRect(cube, name);
    if (!face) continue;
    const corners = faceUvCorners(face.rect, face.rotation);
    const poly = [];
    faceCorners[name].forEach((logical, corner) => {
      poly.push(positions.length);
      positions.push(points[logical].map(value => round(value, 4096)));
      uvs.push(corners[corner].map(value => round(value, 8192)));
      welds.push(logical);
    });
    polys.push(poly);
    textures.push(face.texture || "");
  }
  if (!polys.length) throw Error("这个立方体没有可转换的面");
  const mesh = normalizeMesh({ normalized_uvs: false, positions, uvs, polys, face_textures: textures }, welds);
  return (bones || []).map(item => {
    if (item.name !== boneName) return item;
    return { ...item, cubes: item.cubes.filter((_, index) => index !== cubeIndex), ...mesh };
  });
}

function withMesh(bones, boneName, change) {
  const bone = (bones || []).find(item => item.name === boneName);
  if (!bone?.poly_mesh) throw Error("网格不存在");
  const current = normalizeMesh(bone.poly_mesh, bone.dgn_mesh_welds);
  const next = change(current);
  return (bones || []).map(item => item.name === boneName ? { ...item, ...next } : item);
}

function moveMeshVertex(bones, boneName, weld, delta) {
  return withMesh(bones, boneName, current => {
    if (!current.dgn_mesh_welds.includes(weld)) throw Error("网格顶点不存在");
    const offset = [0, 1, 2].map(axis => Number(delta?.[axis]) || 0);
    return normalizeMesh({
      ...current.poly_mesh,
      positions: current.poly_mesh.positions.map((point, index) => current.dgn_mesh_welds[index] === weld ? point.map((value, axis) => value + offset[axis]) : point.slice()),
    }, current.dgn_mesh_welds);
  });
}

function setMeshVertex(bones, boneName, weld, point) {
  return withMesh(bones, boneName, current => {
    if (!current.dgn_mesh_welds.includes(weld)) throw Error("网格顶点不存在");
    const next = [0, 1, 2].map(axis => round(point?.[axis], 4096));
    return normalizeMesh({
      ...current.poly_mesh,
      positions: current.poly_mesh.positions.map((value, index) => current.dgn_mesh_welds[index] === weld ? next.slice() : value.slice()),
    }, current.dgn_mesh_welds);
  });
}

function removeMesh(bones, boneName) {
  const bone = (bones || []).find(item => item.name === boneName);
  if (!bone?.poly_mesh) throw Error("网格不存在");
  return (bones || []).map(item => {
    if (item.name !== boneName) return item;
    const copy = { ...item };
    delete copy.poly_mesh;
    delete copy.dgn_mesh_welds;
    return copy;
  });
}

function createMesh(bones, boneName) {
  const bone = (bones || []).find(item => item.name === boneName);
  if (!bone) throw Error("骨骼不存在");
  if (bone.poly_mesh) throw Error("这根骨骼已经有网格");
  return (bones || []).map(item => item.name === boneName ? { ...item, poly_mesh: { normalized_uvs: false, positions: [], uvs: [], polys: [] }, dgn_mesh_welds: [] } : item);
}

function dropPositions(data, drop) {
  const map = new Map();
  const positions = [], uvs = [], welds = [];
  data.poly_mesh.positions.forEach((point, index) => {
    if (drop.has(index)) return;
    map.set(index, positions.length);
    positions.push(point.slice());
    uvs.push(data.poly_mesh.uvs[index].slice());
    welds.push(data.dgn_mesh_welds[index]);
  });
  const polys = data.poly_mesh.polys.filter(poly => poly.every(index => map.has(index))).map(poly => poly.map(index => map.get(index)));
  const textures = (data.poly_mesh.face_textures || data.poly_mesh.polys.map(() => "")).filter((_, index) => data.poly_mesh.polys[index].every(vertex => map.has(vertex)));
  return normalizeMesh({ normalized_uvs: false, positions, uvs, polys, face_textures: textures }, welds);
}

function addMeshVertex(bones, boneName, point = [0, 0, 0]) {
  return withMesh(bones, boneName, current => {
    const weld = current.dgn_mesh_welds.reduce((max, id) => Math.max(max, id), -1) + 1;
    if (weld > 255) throw Error("网格顶点数量无效");
    const next = [0, 1, 2].map(axis => round(point?.[axis], 4096));
    return normalizeMesh({
      normalized_uvs: false,
      positions: [...current.poly_mesh.positions.map(item => item.slice()), next],
      uvs: [...current.poly_mesh.uvs.map(item => item.slice()), [0, 0]],
      polys: current.poly_mesh.polys.map(poly => poly.slice()),
      face_textures: current.poly_mesh.face_textures,
    }, [...current.dgn_mesh_welds, weld]);
  });
}

function addMeshFace(bones, boneName, weldIds) {
  const ids = Array.isArray(weldIds) ? weldIds : [];
  if ((ids.length !== 3 && ids.length !== 4) || new Set(ids).size !== ids.length) throw Error("请选 3 或 4 个不同的顶点");
  const corners = [[0, 0], [16, 0], [0, 16], [16, 16]];
  return withMesh(bones, boneName, current => {
    const positions = current.poly_mesh.positions.map(point => point.slice());
    const uvs = current.poly_mesh.uvs.map(point => point.slice());
    const welds = current.dgn_mesh_welds.slice();
    const poly = ids.map((weld, corner) => {
      const index = welds.indexOf(weld);
      if (index < 0) throw Error("网格顶点不存在");
      const at = positions.length;
      positions.push(positions[index].slice());
      uvs.push(corners[corner].slice());
      welds.push(weld);
      return at;
    });
    const textures = [...(current.poly_mesh.face_textures || current.poly_mesh.polys.map(() => "")), ""];
    return normalizeMesh({ normalized_uvs: false, positions, uvs, polys: [...current.poly_mesh.polys.map(item => item.slice()), poly], face_textures: textures }, welds);
  });
}

function removeMeshFace(bones, boneName, faceIndex) {
  return withMesh(bones, boneName, current => {
    const poly = current.poly_mesh.polys[faceIndex];
    if (!poly) throw Error("网格面不存在");
    const used = new Set();
    current.poly_mesh.polys.forEach((item, index) => { if (index !== faceIndex) item.forEach(vertex => used.add(vertex)); });
    const textures = (current.poly_mesh.face_textures || current.poly_mesh.polys.map(() => "")).filter((_, index) => index !== faceIndex);
    const next = { poly_mesh: { ...current.poly_mesh, polys: current.poly_mesh.polys.filter((_, index) => index !== faceIndex), face_textures: textures }, dgn_mesh_welds: current.dgn_mesh_welds };
    return dropPositions(next, new Set(poly.filter(index => !used.has(index))));
  });
}

function removeMeshVertex(bones, boneName, weld) {
  return withMesh(bones, boneName, current => {
    if (!current.dgn_mesh_welds.includes(weld)) throw Error("网格顶点不存在");
    const drop = new Set();
    current.dgn_mesh_welds.forEach((id, index) => { if (id === weld) drop.add(index); });
    return dropPositions(current, drop);
  });
}

function subdivideMeshFace(bones, boneName, faceIndex) {
  return withMesh(bones, boneName, current => {
    const poly = current.poly_mesh.polys[faceIndex];
    if (!poly) throw Error("网格面不存在");
    const positions = current.poly_mesh.positions.map(point => point.slice());
    const uvs = current.poly_mesh.uvs.map(point => point.slice());
    const welds = current.dgn_mesh_welds.slice();
    const polys = current.poly_mesh.polys.map(item => item.slice());
    const addPoint = (point, uv, weld = welds.reduce((max, id) => Math.max(max, id), -1) + 1) => {
      if (positions.length >= 256 || weld > 255 || !Number.isInteger(weld)) throw Error("网格顶点数量无效");
      const at = positions.length;
      positions.push(point);
      uvs.push(uv);
      welds.push(weld);
      return at;
    };
    const count = poly.length;
    const mids = [];
    for (let index = 0; index < count; index += 1) {
      const next = poly[(index + 1) % count];
      const currentIndex = poly[index];
      mids.push(addPoint(
        [0, 1, 2].map(axis => round((positions[currentIndex][axis] + positions[next][axis]) / 2, 4096)),
        [0, 1].map(axis => round((uvs[currentIndex][axis] + uvs[next][axis]) / 2, 8192)),
      ));
    }
    let faces;
    if (count === 4) {
      const center = addPoint(
        [0, 1, 2].map(axis => round(poly.reduce((sum, index) => sum + positions[index][axis], 0) / 4, 4096)),
        [0, 1].map(axis => round(poly.reduce((sum, index) => sum + uvs[index][axis], 0) / 4, 8192)),
      );
      faces = [0, 1, 2, 3].map(index => [poly[index], mids[index], center, mids[(index + 3) % 4]]);
    } else {
      faces = [
        [poly[0], mids[0], mids[2]],
        [mids[0], poly[1], mids[1]],
        [mids[1], poly[2], mids[2]],
        [mids[0], mids[1], mids[2]],
      ];
    }
    polys.splice(faceIndex, 1, ...faces);
    let textures = (current.poly_mesh.face_textures || current.poly_mesh.polys.map(() => "")).slice();
    const painted = textures[faceIndex] || "";
    textures.splice(faceIndex, 1, ...faces.map(() => painted));
    const splits = mids.map((mid, index) => ({
      a: welds[poly[index]],
      b: welds[poly[(index + 1) % count]],
      weld: welds[mid],
      point: positions[mid].slice(),
    }));
    for (const edge of splits) {
      const next = [];
      const nextTextures = [];
      polys.forEach((face, index) => {
        const ids = face.map(index => welds[index]);
        const slot = ids.findIndex((id, index) => {
          const neighbor = ids[(index + 1) % ids.length];
          return (id === edge.a && neighbor === edge.b) || (id === edge.b && neighbor === edge.a);
        });
        if (slot < 0) { next.push(face); nextTextures.push(textures[index] || ""); return; }
        const first = face[slot];
        const second = face[(slot + 1) % face.length];
        const mid = addPoint(edge.point, [0, 1].map(axis => round((uvs[first][axis] + uvs[second][axis]) / 2, 8192)), edge.weld);
        const inserted = face.slice();
        inserted.splice(slot + 1, 0, mid);
        const paint = textures[index] || "";
        if (inserted.length === 4) { next.push(inserted); nextTextures.push(paint); return; }
        if (inserted.length !== 5) throw Error("网格面必须是三角或四边");
        const start = inserted[slot];
        const previous = inserted[(slot + 4) % 5];
        next.push([start, mid, previous], [mid, inserted[(slot + 2) % 5], inserted[(slot + 3) % 5], previous]);
        nextTextures.push(paint, paint);
      });
      polys.length = 0;
      polys.push(...next);
      textures = nextTextures;
    }
    if (polys.length > 128) throw Error("网格面数量无效");
    return normalizeMesh({ normalized_uvs: false, positions, uvs, polys, face_textures: textures }, welds);
  });
}

function weldPoint(mesh, welds, weld) {
  const data = normalizeMesh(mesh, welds);
  const index = data.dgn_mesh_welds.indexOf(weld);
  if (index < 0) throw Error("网格顶点不存在");
  return data.poly_mesh.positions[index].slice();
}

function setMeshFaceTexture(bones, boneName, faceIndex, path) {
  return withMesh(bones, boneName, current => {
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= current.poly_mesh.polys.length) throw Error("网格面不存在");
    const textures = (current.poly_mesh.face_textures || current.poly_mesh.polys.map(() => "")).slice();
    textures[faceIndex] = path || "";
    return normalizeMesh({ ...current.poly_mesh, face_textures: textures }, current.dgn_mesh_welds);
  });
}

function bbMesh(mesh, welds, pivot = [0, 0, 0]) {
  const data = normalizeMesh(mesh, welds);
  if (!data.poly_mesh.positions.length) throw Error("空网格不能导出");
  const origin = [0, 1, 2].map(axis => round(pivot[axis] || 0, 4096));
  const vertices = {};
  data.poly_mesh.positions.forEach((point, index) => {
    vertices[String(index)] = [-(point[0] - origin[0]), point[1] - origin[1], point[2] - origin[2]];
  });
  const faces = {};
  data.poly_mesh.polys.forEach((poly, index) => {
    const uv = {};
    for (const vertex of poly) uv[String(vertex)] = data.poly_mesh.uvs[vertex].slice();
    faces["f" + index] = { vertices: poly.map(String), uv, texture: data.poly_mesh.face_textures?.[index] || "" };
  });
  return { vertices, faces, welds: data.dgn_mesh_welds.slice() };
}

function readBbMesh(element, pivot = [0, 0, 0], textureKey = null) {
  const keys = Object.keys(element?.vertices || {});
  if (!keys.length) throw Error("网格顶点无效");
  if ((element?.rotation || []).some(value => Number(value))) throw Error("暂不支持带旋转的网格");
  const origin = [0, 1, 2].map(axis => round(pivot[axis] || 0, 4096));
  const indexOf = new Map(keys.map((key, index) => [key, index]));
  const positions = keys.map(key => {
    const value = element.vertices[key];
    if (!Array.isArray(value) || value.length !== 3) throw Error("网格顶点无效");
    return [origin[0] - Number(value[0]), origin[1] + Number(value[1]), origin[2] + Number(value[2])];
  });
  const uvs = positions.map(() => null);
  const faceTextures = [];
  const polys = Object.values(element.faces || {}).map(face => {
    if (!Array.isArray(face?.vertices)) throw Error("网格面顶点无效");
    face.vertices.forEach(id => {
      const uv = face.uv?.[id] || [0, 0];
      const at = indexOf.get(id);
      if (at === undefined || !Array.isArray(uv) || uv.length < 2) throw Error("网格面顶点无效");
      const point = uv.slice(0, 2).map(value => round(value, 8192));
      if (uvs[at] && (uvs[at][0] !== point[0] || uvs[at][1] !== point[1])) throw Error("网格顶点的 UV 不一致");
      uvs[at] = point;
    });
    return face.vertices.map(id => indexOf.get(id));
  });
  Object.values(element.faces || {}).forEach(face => faceTextures.push(textureKey ? textureKey(face) || "" : ""));
  for (let index = 0; index < uvs.length; index += 1) if (!uvs[index]) uvs[index] = [0, 0];
  return normalizeMesh({ normalized_uvs: false, positions, uvs, polys, face_textures: faceTextures }, element.dgn_mesh_welds);
}

module.exports = { convertCubeToMesh, createMesh, addMeshVertex, addMeshFace, removeMeshFace, removeMeshVertex, subdivideMeshFace, setMeshFaceTexture, moveMeshVertex, setMeshVertex, removeMesh, weldPoint, normalizeMesh, bbMesh, readBbMesh };
