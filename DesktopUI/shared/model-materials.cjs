const { unwrapSelection } = require("./model-edit.cjs");
const { selectedCubes } = require("./model-cube-properties.cjs");
const faceNames = ["east", "west", "up", "down", "south", "north"];

function texturePath(value) {
  if (typeof value !== "string" || value.length > 240 || !value.endsWith(".png") || value.includes("\\") || value.includes(":") || /[\0-\x1f]/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) throw Error("面贴图须为模型目录内的 PNG 相对路径");
  return value;
}

function assignedTextures(bones) {
  if (!Array.isArray(bones) || bones.length > 400) throw Error("骨骼数据无效");
  const paths = new Set(); let count = 0;
  for (const bone of bones) {
    if (!bone || (bone.cubes !== undefined && !Array.isArray(bone.cubes))) throw Error("骨骼立方体数据无效");
    for (const cube of bone.cubes || []) {
      if (!cube || typeof cube !== "object") throw Error("立方体数据无效");
      if (++count > 2000) throw Error("立方体超过 2000 个");
      if (Array.isArray(cube.uv)) continue;
      for (const name of faceNames) {
        const face = cube.uv?.[name];
        if (face?.dgn_texture !== undefined) paths.add(texturePath(face.dgn_texture));
      }
    }
    for (const texture of bone.poly_mesh?.face_textures || []) if (texture) paths.add(texturePath(texture));
  }
  if (paths.size > 8) throw Error("模型最多绑定 8 张面贴图");
  return [...paths];
}

function assignFaceTexture(bones, ids, faceName, path) {
  if (path !== "") texturePath(path);
  if (faceName && !faceNames.includes(faceName)) throw Error("模型面无效");
  const selected = selectedCubes(bones, ids);
  if (!path && [...selected.values()].every(cube => !faceNames.some(name => (!faceName || faceName === name) && cube.uv?.[name]?.dgn_texture))) return bones;
  const picks = bones.flatMap(bone => (bone.cubes || []).flatMap((cube, index) => selected.has(cube.dgnId) ? [{ bone: bone.name, cube: index }] : []));
  const unwrapped = unwrapSelection(bones, picks);
  const next = unwrapped.map(bone => ({ ...bone, cubes: (bone.cubes || []).map(cube => {
    if (!selected.has(cube.dgnId)) return cube;
    const uv = { ...cube.uv };
    for (const name of faceName ? [faceName] : faceNames) {
      if (!uv[name]) { if (faceName) throw Error("选中元素的这一面不存在"); continue; }
      const face = { ...uv[name] };
      if (path) face.dgn_texture = path; else delete face.dgn_texture;
      uv[name] = face;
    }
    return { ...cube, uv };
  }) }));
  assignedTextures(next);
  return next;
}

function paintBonesForTexture(bones, relative) {
  return bones.map(bone => ({ ...bone, cubes: (bone.cubes || []).map(cube => Array.isArray(cube.uv) ? cube : { ...cube, uv: Object.fromEntries(Object.entries(cube.uv || {}).filter(([, face]) => face && (!face.dgn_texture || face.dgn_texture === relative))) }) }));
}

module.exports = { faceNames, texturePath, assignedTextures, assignFaceTexture, paintBonesForTexture };
