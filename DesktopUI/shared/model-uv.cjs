const { uvFaces } = require("./model-edit.cjs");
const { assignedTextures, faceNames } = require("./model-materials.cjs");
const colors = { east: [225, 142, 84], west: [214, 183, 85], up: [113, 177, 109], down: [96, 166, 174], north: [112, 146, 214], south: [174, 127, 198] };

function validateSize(width, height) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 2048)) throw Error("贴图边长要在 1 到 2048 之间");
}

function facesFor(bones) {
  if (!Array.isArray(bones) || bones.length > 400) throw Error("模型骨骼数据无效");
  let count = 0;
  return bones.flatMap((bone, boneIndex) => {
    if (!bone || (bone.cubes !== undefined && !Array.isArray(bone.cubes))) throw Error("立方体数据无效");
    return (bone.cubes || []).flatMap((cube, cubeIndex) => {
      if (++count > 2000) throw Error("最多处理 2000 个立方体");
      const vector = (value, size) => Array.isArray(value) && value.length === size && value.every(item => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 1000000);
      if (!cube || !cube.uv) return [];
      if (Array.isArray(cube.uv)) {
        if (!vector(cube.uv, 2) || !vector(cube.size, 3)) throw Error("盒子 UV 或尺寸无效");
      } else {
        if (typeof cube.uv !== "object") throw Error("按面 UV 无效");
        for (const name of Object.keys(colors)) {
          const face = cube.uv[name];
          if (face == null) continue;
          if (!vector(face.uv, 2) || !vector(face.uv_size, 2)) throw Error("按面 UV 坐标无效");
        }
      }
      return uvFaces(cube).filter(face => face.w && face.h).map(face => ({ ...face, boneIndex, cubeIndex, x: Math.min(face.x, face.x + face.w), y: Math.min(face.y, face.y + face.h), w: Math.abs(face.w), h: Math.abs(face.h) }));
    });
  });
}

function packUv(bones, width, height, padding = 1) {
  validateSize(width, height);
  if (!Number.isInteger(padding) || padding < 0 || padding > 16) throw Error("UV 间距应为 0 到 16 像素");
  const faces = facesFor(bones), groups = new Map();
  for (const face of faces) {
    const cube = bones[face.boneIndex].cubes[face.cubeIndex];
    const key = face.boneIndex + ":" + face.cubeIndex + (Array.isArray(cube.uv) ? "" : ":" + face.name);
    const group = groups.get(key) || { faces: [], x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity };
    group.faces.push(face); group.x = Math.min(group.x, face.x); group.y = Math.min(group.y, face.y);
    group.right = Math.max(group.right, face.x + face.w); group.bottom = Math.max(group.bottom, face.y + face.h);
    groups.set(key, group);
  }
  if (!groups.size) throw Error("模型没有可排列的 UV 面");
  const islands = [...groups.values()].map(group => ({ ...group, w: Math.ceil(group.right - group.x), h: Math.ceil(group.bottom - group.y) }));
  islands.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.h - a.h || b.w - a.w);
  const free = [{ x: padding, y: padding, w: width - padding * 2, h: height - padding * 2 }];
  for (const island of islands) {
    let choice = -1, score = null;
    for (let index = 0; index < free.length; index++) {
      const slot = free[index];
      if (island.w > slot.w || island.h > slot.h) continue;
      const next = [Math.min(slot.w - island.w, slot.h - island.h), Math.max(slot.w - island.w, slot.h - island.h), slot.y, slot.x];
      if (!score || next.some((value, at) => value < score[at] && next.slice(0, at).every((item, before) => item === score[before]))) { choice = index; score = next; }
    }
    if (choice < 0) throw Error("当前贴图放不下全部 UV，请增大尺寸或减小间距");
    const slot = free.splice(choice, 1)[0];
    island.dx = slot.x - island.x; island.dy = slot.y - island.y;
    const usedWidth = island.w + padding, usedHeight = island.h + padding;
    if (slot.w > usedWidth) free.push({ x: slot.x + usedWidth, y: slot.y, w: slot.w - usedWidth, h: slot.h });
    if (slot.h > usedHeight) free.push({ x: slot.x, y: slot.y + usedHeight, w: slot.w, h: slot.h - usedHeight });
    for (let a = free.length - 1; a >= 0; a--) {
      const outer = free[a];
      if (free.some((inner, b) => a !== b && inner.x <= outer.x && inner.y <= outer.y && inner.x + inner.w >= outer.x + outer.w && inner.y + inner.h >= outer.y + outer.h)) free.splice(a, 1);
    }
  }
  const next = structuredClone(bones);
  for (const island of islands) {
    const first = island.faces[0], cube = next[first.boneIndex].cubes[first.cubeIndex];
    const shift = uv => [Math.round((uv[0] + island.dx) * 1000000) / 1000000, Math.round((uv[1] + island.dy) * 1000000) / 1000000];
    if (Array.isArray(cube.uv)) cube.uv = shift(cube.uv);
    else cube.uv[first.name] = { ...cube.uv[first.name], uv: shift(cube.uv[first.name].uv) };
  }
  return { bones: next, islands: islands.length, faces: faces.length };
}

function templateRects(bones, width, height) {
  validateSize(width, height);
  const faces = facesFor(bones);
  if (!faces.length) throw Error("模型没有可生成模板的 UV 面");
  let pixels = 0;
  return faces.map(face => {
    if (face.x < 0 || face.y < 0 || face.x + face.w > width || face.y + face.h > height) throw Error("UV 超出贴图边界，请先排列或调整尺寸");
    const x = Math.floor(face.x), y = Math.floor(face.y), w = Math.ceil(face.x + face.w) - x, h = Math.ceil(face.y + face.h) - y;
    pixels += w * h;
    if (pixels > 32 * 1024 * 1024) throw Error("UV 重叠区域过多，不能生成模板");
    return { x, y, w, h, color: colors[face.name], name: face.name };
  });
}

function repackTexture(bones, image, width, height, padding = 1, sourceImages = null) {
  validateSize(image?.width, image?.height);
  if (!image.data?.subarray || image.data.length !== image.width * image.height * 4) throw Error("源贴图像素无效");
  const bindings = assignedTextures(bones), source = facesFor(bones);
  if (sourceImages !== null && (!sourceImages || typeof sourceImages !== "object" || Array.isArray(sourceImages))) throw Error("面贴图像素无效");
  const checked = new Map(sourceImages ? Object.entries(sourceImages) : [["", image]]);
  const needsDefault = bones.some(bone => (bone.cubes || []).some(cube => Array.isArray(cube.uv) || faceNames.some(name => cube.uv?.[name] && !cube.uv[name].dgn_texture)));
  const count = bindings.length + (needsDefault ? 1 : 0);
  if (count > 8) throw Error("面贴图连同默认贴图最多 8 张");
  if (count * image.width * image.height > 16 * 1024 * 1024) throw Error("面贴图总像素超过 1600 万限制");
  for (const bone of bones) for (const cube of bone.cubes || []) {
    if (!Array.isArray(cube.uv) && faceNames.some(name => cube.uv?.[name]?.material_instance)) throw Error("命名分面材质不能合并为图集，请保留多贴图工程");
  }
  for (const key of bindings) if (!checked.has(key)) throw Error("缺少面贴图：" + key);
  if (needsDefault && !checked.has("")) throw Error("未分配的模型面需要默认贴图");
  if (sourceImages) {
    for (const [key, sourceImage] of checked) {
      if (key !== "" && !bindings.includes(key)) throw Error("面贴图快照包含未绑定来源");
      if (!sourceImage || sourceImage.width !== image.width || sourceImage.height !== image.height || !sourceImage.data?.subarray || sourceImage.data.length !== sourceImage.width * sourceImage.height * 4) throw Error("所有面贴图必须使用相同的 UV 分辨率和有效像素");
    }
  }
  let pixels = 0;
  for (const face of source) {
    if (![face.x, face.y, face.w, face.h].every(Number.isInteger)) throw Error("带贴图重排要求 UV 边界为整数像素");
    const cube = bones[face.boneIndex].cubes[face.cubeIndex];
    const faceData = Array.isArray(cube.uv) ? null : cube.uv?.[face.name];
    const key = Array.isArray(cube.uv) ? "" : faceData?.dgn_texture || "";
    const sourceImage = checked.get(key);
    if (!sourceImage) throw Error("缺少面贴图：" + key);
    if (face.x < 0 || face.y < 0 || face.x + face.w > sourceImage.width || face.y + face.h > sourceImage.height) throw Error("源 UV 超出贴图边界，不能搬移像素");
    pixels += face.w * face.h;
    if (pixels > 32 * 1024 * 1024) throw Error("UV 重叠区域过多，不能搬移贴图");
  }
  const packed = packUv(bones, width, height, padding), target = facesFor(packed.bones);
  const data = new Uint8ClampedArray(width * height * 4);
  source.forEach((from, index) => {
    const to = target[index];
    if (!to || ![to.x, to.y].every(Number.isInteger) || to.w !== from.w || to.h !== from.h) throw Error("UV 重排无法保持原像素尺寸");
    const cube = bones[from.boneIndex].cubes[from.cubeIndex];
    const key = Array.isArray(cube.uv) ? "" : cube.uv?.[from.name]?.dgn_texture || "";
    const sourceImage = checked.get(key);
    // 始终读原图，重叠源 UV 分别复制到各个新区域，保留镜像和面旋转。
    for (let y = 0; y < from.h; y++) {
      const start = ((from.y + y) * sourceImage.width + from.x) * 4;
      data.set(sourceImage.data.subarray(start, start + from.w * 4), ((to.y + y) * width + to.x) * 4);
    }
  });
  for (const bone of packed.bones) for (const cube of bone.cubes || []) {
    if (!Array.isArray(cube.uv)) for (const name of faceNames) if (cube.uv?.[name]) delete cube.uv[name].dgn_texture;
  }
  return { ...packed, width, height, data };
}

module.exports = { packUv, templateRects, validateSize, repackTexture };
