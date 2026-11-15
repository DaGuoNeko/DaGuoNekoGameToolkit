const { scaleVertices } = require("./model-vertex-edit.cjs");

function taken(bones) {
  return new Set(bones.map(bone => bone.name));
}

function uniqueName(bones, base) {
  const names = taken(bones);
  let name = base;
  let index = 2;
  while (names.has(name)) name = base + index++;
  return name;
}

function descendants(bones, name) {
  const result = new Set();
  const walk = parent => {
    for (const bone of bones) {
      if (bone.parent !== parent || result.has(bone.name)) continue;
      result.add(bone.name);
      walk(bone.name);
    }
  };
  walk(name);
  return result;
}

function renameBone(bones, from, to) {
  const next = String(to || "").trim();
  if (!next || next.length > 64) throw Error("骨骼名称应为 1–64 个字符");
  if (bones.some(bone => bone.name === next && bone.name !== from)) throw Error("已有同名骨骼");
  return bones.map(bone => ({
    ...bone,
    name: bone.name === from ? next : bone.name,
    parent: bone.parent === from ? next : bone.parent,
  }));
}

function reparentBone(bones, name, parent) {
  const next = parent || "";
  if (next === name) throw Error("骨骼不能以自己为父级");
  if (next && descendants(bones, name).has(next)) throw Error("不能把骨骼挂到自己的子级上");
  if (next && !bones.some(bone => bone.name === next)) throw Error("父级骨骼不存在");
  return bones.map(bone => {
    if (bone.name !== name) return bone;
    const copy = { ...bone };
    if (next) copy.parent = next;
    else delete copy.parent;
    return copy;
  });
}

function addBone(bones, parent) {
  const name = uniqueName(bones, parent ? "bone" : "root");
  const bone = { name, pivot: [0, 0, 0], cubes: [] };
  if (parent) bone.parent = parent;
  return { bones: [...bones, bone], name };
}

function removeBone(bones, name) {
  const current = bones.find(bone => bone.name === name);
  return bones.filter(bone => bone.name !== name).map(bone => {
    if (bone.parent !== name) return bone;
    const copy = { ...bone };
    if (current?.parent) copy.parent = current.parent;
    else delete copy.parent;
    return copy;
  });
}

function addCube(bones, boneName) {
  return bones.map(bone => bone.name === boneName ? {
    ...bone,
    cubes: [...(bone.cubes || []), { origin: [0, 0, 0], size: [8, 8, 8], uv: [0, 0] }],
  } : bone);
}

function removeCube(bones, boneName, index) {
  return bones.map(bone => bone.name === boneName ? {
    ...bone,
    cubes: (bone.cubes || []).filter((_, cubeIndex) => cubeIndex !== index),
  } : bone);
}

function moveCube(bones, fromBone, index, toBone, toIndex) {
  const source = bones.find(bone => bone.name === fromBone);
  const target = bones.find(bone => bone.name === toBone);
  const cube = source?.cubes?.[index];
  if (!cube || !target) throw Error("立方体不存在");
  if (fromBone === toBone) {
    if (!Number.isInteger(toIndex) || toIndex === index) return { bones, picked: { bone: fromBone, cube: index } };
    const cubes = source.cubes.slice();
    const [moving] = cubes.splice(index, 1);
    const at = Math.max(0, Math.min(toIndex, cubes.length));
    cubes.splice(at, 0, moving);
    return {
      bones: bones.map(bone => bone.name === fromBone ? { ...bone, cubes } : bone),
      picked: { bone: fromBone, cube: at },
    };
  }
  const moving = JSON.parse(JSON.stringify(cube));
  const targetCubes = (target.cubes || []).slice();
  const at = Number.isInteger(toIndex) ? Math.max(0, Math.min(toIndex, targetCubes.length)) : targetCubes.length;
  targetCubes.splice(at, 0, moving);
  return {
    bones: bones.map(bone => {
      if (bone.name === fromBone) return { ...bone, cubes: bone.cubes.filter((_, at) => at !== index) };
      if (bone.name === toBone) return { ...bone, cubes: targetCubes };
      return bone;
    }),
    picked: { bone: toBone, cube: at },
  };
}

function duplicateSelection(bones, picked) {
  const bone = bones.find(item => item.name === picked?.bone);
  if (!bone) throw Error("先选中骨骼或立方体");
  if (Number.isInteger(picked.cube)) {
    const cube = bone.cubes?.[picked.cube];
    if (!cube) throw Error("立方体不存在");
    const copy = JSON.parse(JSON.stringify(cube));
    const cubes = [...(bone.cubes || []), copy];
    return {
      bones: bones.map(item => item.name === bone.name ? { ...item, cubes } : item),
      picked: { bone: bone.name, cube: cubes.length - 1 },
    };
  }
  const names = new Map();
  const used = new Set(bones.map(item => item.name));
  const take = base => {
    let name = base;
    let index = 2;
    while (used.has(name)) name = base + index++;
    used.add(name);
    return name;
  };
  names.set(bone.name, take(bone.name));
  for (const child of descendants(bones, bone.name)) names.set(child, take(child));
  const copies = bones.filter(item => names.has(item.name)).map(item => {
    const copy = JSON.parse(JSON.stringify(item));
    copy.name = names.get(item.name);
    if (copy.parent && names.has(copy.parent)) copy.parent = names.get(copy.parent);
    return copy;
  });
  return { bones: [...bones, ...copies], picked: { bone: names.get(bone.name), cube: null } };
}

function vec(value) {
  const source = Array.isArray(value) ? value : [];
  return [0, 1, 2].map(index => Math.round(((Number(source[index]) || 0) + Number.EPSILON) * 1000) / 1000);
}

function addVec(value, delta) {
  const base = vec(value);
  return [0, 1, 2].map(index => Math.round((base[index] + (Number(delta?.[index]) || 0)) * 1000) / 1000);
}

function shiftCube(cube, delta) {
  const copy = { ...cube, origin: addVec(cube.origin, delta) };
  if (Array.isArray(cube.pivot)) copy.pivot = addVec(cube.pivot, delta);
  if (cube.dgn_vertices !== undefined) copy.dgn_vertices = cube.dgn_vertices.map(point => addVec(point, delta));
  return copy;
}

function transformSelection(bones, picked, kind, delta) {
  if (!picked?.bone || !bones.some(bone => bone.name === picked.bone)) return bones;
  if (kind === "move") {
    const names = Number.isInteger(picked.cube) ? new Set([picked.bone]) : descendants(bones, picked.bone).add(picked.bone);
    return bones.map(bone => {
      if (!names.has(bone.name)) return bone;
      const cubes = (bone.cubes || []).map((cube, index) => !Number.isInteger(picked.cube) || index === picked.cube ? shiftCube(cube, delta) : cube);
      return Number.isInteger(picked.cube) ? { ...bone, cubes } : { ...bone, pivot: addVec(bone.pivot, delta), cubes };
    });
  }
  if (kind === "rotate") {
    if (Number.isInteger(picked.cube)) {
      return bones.map(bone => bone.name !== picked.bone ? bone : {
        ...bone,
        cubes: (bone.cubes || []).map((cube, index) => index === picked.cube ? { ...cube, rotation: addVec(cube.rotation, delta) } : cube),
      });
    }
    return bones.map(bone => bone.name === picked.bone ? { ...bone, rotation: addVec(bone.rotation, delta) } : bone);
  }
  if (kind === "scale") {
    const current = bones.find(bone => bone.name === picked.bone);
    return bones.map(bone => {
      if (bone.name !== picked.bone) return bone;
      return {
        ...bone,
        cubes: (bone.cubes || []).map((cube, index) => {
          if (Number.isInteger(picked.cube) && index !== picked.cube) return cube;
          const origin = vec(cube.origin);
          const size = vec(cube.size);
          const anchor = Number.isInteger(picked.cube)
            ? (Array.isArray(cube.pivot) ? vec(cube.pivot) : origin.map((value, axis) => value + size[axis] / 2))
            : vec(current.pivot);
          const nextOrigin = origin.slice();
          const nextSize = size.slice();
          for (let axis = 0; axis < 3; axis += 1) {
            const change = Number(delta?.[axis]) || 0;
            if (!change || !size[axis]) continue;
            const ratio = (anchor[axis] - origin[axis]) / size[axis];
            const span = size[axis] + change;
            nextOrigin[axis] = Math.round((anchor[axis] - ratio * span) * 1000) / 1000;
            nextSize[axis] = Math.round(span * 1000) / 1000;
          }
          const scaled = { ...cube, origin: nextOrigin, size: nextSize };
          const ratios = [0, 1, 2].map(axis => !size[axis] || !(Number(delta?.[axis]) || 0) ? 1 : nextSize[axis] / size[axis]);
          return scaleVertices(scaled, anchor, ratios);
        }),
      };
    });
  }
  if (kind === "pivot") {
    if (Number.isInteger(picked.cube)) {
      return bones.map(bone => bone.name !== picked.bone ? bone : {
        ...bone,
        cubes: (bone.cubes || []).map((cube, index) => {
          if (index !== picked.cube) return cube;
          const origin = vec(cube.origin);
          const size = vec(cube.size);
          const pivot = Array.isArray(cube.pivot) ? vec(cube.pivot) : origin.map((value, axis) => value + size[axis] / 2);
          return { ...cube, pivot: addVec(pivot, delta) };
        }),
      });
    }
    return bones.map(bone => bone.name === picked.bone ? { ...bone, pivot: addVec(bone.pivot, delta) } : bone);
  }
  return bones;
}

function snapDelta(delta, step) {
  const size = Number(step) || 0;
  if (!size) return [0, 1, 2].map(index => Number(delta?.[index]) || 0);
  return [0, 1, 2].map(index => Math.round((Number(delta?.[index]) || 0) / size) * size);
}

function transformMany(bones, picks, kind, delta) {
  const seen = new Set();
  const moved = new Set();
  let next = bones;
  for (const pick of picks || []) {
    if (!pick?.bone) continue;
    const key = pick.bone + ":" + (Number.isInteger(pick.cube) ? pick.cube : "");
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === "move" && !Number.isInteger(pick.cube)) {
      const names = descendants(bones, pick.bone).add(pick.bone);
      next = next.map(bone => {
        if (!names.has(bone.name) || moved.has(bone.name)) return bone;
        moved.add(bone.name);
        return { ...bone, pivot: addVec(bone.pivot, delta), cubes: (bone.cubes || []).map(cube => shiftCube(cube, delta)) };
      });
      continue;
    }
    next = transformSelection(next, pick, kind, delta);
  }
  return next;
}

function mirrorCube(cube, pivot, axis) {
  const origin = vec(cube.origin);
  const size = vec(cube.size);
  const center = Number(pivot?.[axis]) || 0;
    const reflected = origin.slice();
    reflected[axis] = Math.round((center * 2 - origin[axis] - size[axis]) * 1000) / 1000;
    const copy = { ...cube, origin: reflected };
    if (cube.dgn_vertices !== undefined) copy.dgn_vertices = cube.dgn_vertices.map(point => { const next = vec(point); next[axis] = Math.round((center * 2 - next[axis]) * 1000) / 1000; return next; });
  delete copy.dgnId;
  if (Array.isArray(cube.pivot)) {
    const point = vec(cube.pivot);
    point[axis] = Math.round((center * 2 - point[axis]) * 1000) / 1000;
    copy.pivot = point;
  }
  if (Array.isArray(cube.rotation)) {
    const rotation = vec(cube.rotation);
    for (let index = 0; index < 3; index += 1) if (index !== axis) rotation[index] = -rotation[index];
    copy.rotation = rotation;
  }
  if (axis === 0) copy.mirror = !cube.mirror;
  return copy;
}

function mirrorSelection(bones, picks, axis = 0) {
  if (![0, 1, 2].includes(axis)) throw Error("镜像轴无效");
  const groups = new Map();
  for (const pick of picks || []) {
    const bone = bones.find(item => item.name === pick?.bone);
    if (!bone) continue;
    const indexes = Number.isInteger(pick.cube) ? [pick.cube] : (bone.cubes || []).map((_, index) => index);
    const bag = groups.get(bone.name) || new Set();
    indexes.forEach(index => { if (bone.cubes?.[index]) bag.add(index); });
    groups.set(bone.name, bag);
  }
  if (![...groups.values()].some(bag => bag.size)) throw Error("先选中带立方体的骨骼");
  let picked = null;
  const next = bones.map(bone => {
    const bag = groups.get(bone.name);
    if (!bag?.size) return bone;
    const copies = [...bag].map(index => mirrorCube(bone.cubes[index], bone.pivot || [0, 0, 0], axis));
    if (!picked) picked = { bone: bone.name, cube: (bone.cubes || []).length };
    return { ...bone, cubes: [...(bone.cubes || []), ...copies] };
  });
  return { bones: next, picked };
}

function boxRects(uv, size, mirror) {
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
  if (mirror) {
    const east = faces.east;
    faces.east = faces.west;
    faces.west = east;
  }
  return faces;
}

function cubeSize(cube) {
  return [0, 1, 2].map(index => Math.abs(Number(cube?.size?.[index]) || 0));
}

function uvRects(cube) {
  if (!cube) return [];
  if (Array.isArray(cube.uv)) return Object.values(boxRects(cube.uv.map(Number), cubeSize(cube), cube.mirror));
  return ["east", "west", "up", "down", "north", "south"].flatMap(name => {
    const face = cube.uv?.[name];
    if (!face?.uv || !face.uv_size) return [];
    return [[Number(face.uv[0]) || 0, Number(face.uv[1]) || 0, Number(face.uv_size[0]) || 0, Number(face.uv_size[1]) || 0]];
  });
}

function uvFaces(cube) {
  return uvRects(cube).length && Array.isArray(cube?.uv)
    ? Object.entries(boxRects(cube.uv.map(Number), cubeSize(cube), cube.mirror)).map(([name, rect]) => ({ name, x: rect[0], y: rect[1], w: rect[2], h: rect[3] }))
    : ["east", "west", "up", "down", "north", "south"].flatMap(name => {
      const face = cube?.uv?.[name];
      if (!face?.uv || !face.uv_size) return [];
      return [{ name, x: Number(face.uv[0]) || 0, y: Number(face.uv[1]) || 0, w: Number(face.uv_size[0]) || 0, h: Number(face.uv_size[1]) || 0 }];
    });
}

function mirrorPaintAt(bones, x, y) {
  let best = null;
  for (const bone of bones || []) {
    for (const cube of bone.cubes || []) {
      for (const face of uvFaces(cube)) {
        const x0 = Math.min(face.x, face.x + face.w);
        const x1 = Math.max(face.x, face.x + face.w);
        const y0 = Math.min(face.y, face.y + face.h);
        const y1 = Math.max(face.y, face.y + face.h);
        const mw = x1 - x0;
        const mh = y1 - y0;
        if (mw <= 0 || mh <= 0 || x < x0 || x >= x1 || y < y0 || y >= y1) continue;
        const area = mw * mh;
        if (!best || area < best.area) best = { cube, name: face.name, x0, y0, mw, mh, area };
      }
    }
  }
  if (!best) return null;
  const flipped = best.mw - 1 - (x - best.x0);
  const ly = y - best.y0;
  const pair = best.name === "east" ? "west" : best.name === "west" ? "east" : "";
  if (pair) {
    const other = uvFaces(best.cube).map(face => {
      const x0 = Math.min(face.x, face.x + face.w);
      const y0 = Math.min(face.y, face.y + face.h);
      return { name: face.name, x0, y0, mw: Math.abs(face.w), mh: Math.abs(face.h) };
    }).find(face => face.name === pair);
    if (!other || other.mw <= 0) return null;
    const nx = other.x0 + Math.min(flipped, other.mw - 1);
    const ny = other.y0 + Math.min(ly, other.mh - 1);
    return nx === x && ny === y ? null : { x: nx, y: ny };
  }
  const nx = best.x0 + flipped;
  return nx === x ? null : { x: nx, y: best.y0 + ly };
}

function unwrapCube(cube) {
  if (!Array.isArray(cube?.uv)) return cube;
  const faces = boxRects(cube.uv.map(Number), cubeSize(cube), cube.mirror);
  const uv = {};
  for (const [name, rect] of Object.entries(faces)) uv[name] = { uv: [rect[0], rect[1]], uv_size: [rect[2], rect[3]] };
  const copy = { ...cube, uv };
  delete copy.mirror;
  return copy;
}

function unwrapSelection(bones, picks) {
  const groups = new Map();
  for (const pick of picks || []) {
    const bone = bones.find(item => item.name === pick?.bone);
    if (!bone) continue;
    const indexes = Number.isInteger(pick.cube) ? [pick.cube] : (bone.cubes || []).map((_, index) => index);
    const bag = groups.get(bone.name) || new Set();
    indexes.forEach(index => { if (bone.cubes?.[index]) bag.add(index); });
    groups.set(bone.name, bag);
  }
  if (![...groups.values()].some(bag => bag.size)) throw Error("先选中立方体");
  return bones.map(bone => {
    const bag = groups.get(bone.name);
    if (!bag?.size) return bone;
    return { ...bone, cubes: (bone.cubes || []).map((cube, index) => bag.has(index) ? unwrapCube(cube) : cube) };
  });
}

function roundUv(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function rotateFace(face) {
  const copy = { ...face, uv_rotation: ((Number(face?.uv_rotation) || 0) + 90) % 360 };
  if (!copy.uv_rotation) delete copy.uv_rotation;
  return copy;
}

function faceUvCorners(rect, rotation = 0) {
  const [x, y, w, h] = rect;
  let corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
  const turns = ((rotation % 360) + 360) % 360 / 90;
  for (let i = 0; i < turns; i++) corners = [corners[2], corners[0], corners[3], corners[1]];
  return corners;
}

function scaleFace(face, factor) {
  const amount = Number(factor);
  if (!amount || amount <= 0) throw Error("缩放倍数无效");
  const u = Number(face?.uv?.[0]) || 0;
  const v = Number(face?.uv?.[1]) || 0;
  const w = Number(face?.uv_size?.[0]) || 0;
  const h = Number(face?.uv_size?.[1]) || 0;
  const nw = w * amount;
  const nh = h * amount;
  return { ...face, uv: [roundUv(u + w / 2 - nw / 2), roundUv(v + h / 2 - nh / 2)], uv_size: [roundUv(nw), roundUv(nh)] };
}

function editFaceUv(bones, picks, faceName, change) {
  const groups = new Map();
  for (const pick of picks || []) {
    const bone = bones.find(item => item.name === pick?.bone);
    if (!bone) continue;
    const indexes = Number.isInteger(pick.cube) ? [pick.cube] : (bone.cubes || []).map((_, index) => index);
    const bag = groups.get(bone.name) || new Set();
    indexes.forEach(index => { if (bone.cubes?.[index]) bag.add(index); });
    groups.set(bone.name, bag);
  }
  if (![...groups.values()].some(bag => bag.size)) throw Error("先选中立方体");
  return bones.map(bone => {
    const bag = groups.get(bone.name);
    if (!bag?.size) return bone;
    return {
      ...bone,
      cubes: (bone.cubes || []).map((cube, index) => {
        if (!bag.has(index)) return cube;
        const source = Array.isArray(cube.uv) ? unwrapCube(cube) : cube;
        const uv = { ...source.uv };
        const names = faceName ? [faceName] : ["east", "west", "up", "down", "north", "south"];
        if (faceName && !uv[faceName]?.uv) throw Error("这一面没有 UV");
        for (const name of names) if (uv[name]?.uv) uv[name] = change(uv[name]);
        return { ...source, uv };
      }),
    };
  });
}

function remember(stack, cursor, snapshot, limit = 50) {
  const next = stack.slice(0, cursor + 1);
  if (next[next.length - 1] === snapshot) return { stack: next, cursor: Math.max(0, next.length - 1) };
  next.push(snapshot);
  while (next.length > limit) next.shift();
  return { stack: next, cursor: next.length - 1 };
}

function boneTree(bones) {
  const names = new Set(bones.map(bone => bone.name));
  const children = new Map();
  for (const bone of bones) {
    const parent = bone.parent && names.has(bone.parent) ? bone.parent : "";
    const list = children.get(parent) || [];
    list.push(bone);
    children.set(parent, list);
  }
  const ordered = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const bone of children.get(parent) || []) {
      if (seen.has(bone.name)) continue;
      seen.add(bone.name);
      ordered.push({ bone, depth });
      walk(bone.name, depth + 1);
    }
  };
  walk("", 0);
  for (const bone of bones) if (!seen.has(bone.name)) ordered.push({ bone, depth: 0 });
  return ordered;
}

function parentBones(bones, name) {
  const blocked = descendants(bones, name);
  blocked.add(name);
  return bones.filter(bone => !blocked.has(bone.name));
}

function ensureCubeIds(bones) {
  const used = new Set();
  const reserved = new Set((bones || []).flatMap(bone => (bone.cubes || []).map(cube => cube?.dgnId).filter(Boolean)));
  let serial = 1;
  let changed = false;
  const nextId = () => {
    let id = "c" + serial++;
    while (used.has(id) || reserved.has(id)) id = "c" + serial++;
    used.add(id);
    return id;
  };
  const next = (bones || []).map(bone => {
    let cubeChanged = false;
    const cubes = (bone.cubes || []).map(cube => {
      if (cube?.dgnId && !used.has(cube.dgnId)) {
        used.add(cube.dgnId);
        return cube;
      }
      cubeChanged = true;
      changed = true;
      return { ...cube, dgnId: nextId() };
    });
    const normalized = bone.locators == null ? null : normalizeLocators(bone.locators);
    if (!cubeChanged && !normalized?.changed) return bone;
    changed = true;
    const copy = { ...bone, cubes };
    if (normalized && Object.keys(normalized.locators).length) copy.locators = normalized.locators;
    else delete copy.locators;
    return copy;
  });
  return changed ? next : bones;
}

function publishBones(bones) {
  return (bones || []).map(bone => {
    if (!(bone.cubes || []).some(cube => Object.prototype.hasOwnProperty.call(cube, "dgnId"))) return bone;
    return {
      ...bone,
      cubes: bone.cubes.map(cube => {
        if (!Object.prototype.hasOwnProperty.call(cube, "dgnId")) return cube;
        const { dgnId, ...rest } = cube;
        return rest;
      }),
    };
  });
}

function isCubeHidden(hidden, boneName, cube, index) {
  const keys = hidden instanceof Set ? hidden : new Set(hidden || []);
  return keys.has(boneName) || keys.has(boneName + ":" + index) || !!(cube?.dgnId && keys.has(cube.dgnId));
}

function roundLocator(value) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => !Number.isFinite(Number(item)) || Math.abs(Number(item)) > 1e6)) throw Error("定位器坐标无效");
  return [0, 1, 2].map(index => Math.round(Number(value[index]) * 1000) / 1000);
}

function locatorRecord(value) {
  if (Array.isArray(value)) return { offset: roundLocator(value) };
  if (!value || typeof value !== "object") throw Error("定位器数据无效");
  const offset = roundLocator(value.offset || value.position);
  const record = { offset };
  if (value.rotation != null) record.rotation = roundLocator(value.rotation);
  if (value.ignore_inherited_scale === true) record.ignore_inherited_scale = true;
  else if (value.ignore_inherited_scale != null && value.ignore_inherited_scale !== false) throw Error("定位器缩放标记无效");
  return record;
}

function normalizeLocators(locators) {
  if (!locators || typeof locators !== "object" || Array.isArray(locators)) throw Error("定位器数据无效");
  const names = Object.keys(locators);
  if (names.length > 64) throw Error("定位器数量超过 64 个");
  const next = {};
  const seen = new Set();
  let changed = false;
  for (const name of names) {
    if (!name.trim() || name !== name.trim() || name.length > 64 || ["__proto__", "constructor", "prototype"].includes(name)) throw Error("定位器名称无效");
    if (seen.has(name.toLowerCase())) throw Error("定位器名称重复");
    seen.add(name.toLowerCase());
    const record = locatorRecord(locators[name]);
    next[name] = record;
    if (JSON.stringify(locators[name]) !== JSON.stringify(record)) changed = true;
  }
  return { locators: next, changed };
}

function locatorName(value) {
  const next = String(value || "").trim();
  if (!next || next.length > 64 || ["__proto__", "constructor", "prototype"].includes(next)) throw Error("定位器名称应为 1–64 个字符");
  return next;
}

function boneWithLocators(bone, locators) {
  const copy = { ...bone };
  if (locators && Object.keys(locators).length) copy.locators = locators;
  else delete copy.locators;
  return copy;
}

function updateLocators(bones, boneName, change) {
  const bone = (bones || []).find(item => item.name === boneName);
  if (!bone) throw Error("骨骼不存在");
  const current = bone.locators == null ? {} : normalizeLocators(bone.locators).locators;
  const locators = change({ ...current });
  return bones.map(item => item.name === boneName ? boneWithLocators(item, locators) : item);
}

function freshLocatorName(locators, base) {
  const used = new Set(Object.keys(locators).map(name => name.toLowerCase()));
  let name = base;
  let index = 2;
  while (used.has(name.toLowerCase())) name = base + index++;
  if (name.length > 64) throw Error("定位器名称应为 1–64 个字符");
  return name;
}

function addLocator(bones, boneName) {
  let created = "";
  const next = updateLocators(bones, boneName, locators => {
    if (Object.keys(locators).length >= 64) throw Error("定位器数量超过 64 个");
    created = freshLocatorName(locators, "locator");
    locators[created] = { offset: [0, 0, 0] };
    return locators;
  });
  return { bones: next, name: created };
}

function removeLocator(bones, boneName, name) {
  return updateLocators(bones, boneName, locators => {
    if (!Object.prototype.hasOwnProperty.call(locators, name)) throw Error("定位器不存在");
    delete locators[name];
    return locators;
  });
}

function renameLocator(bones, boneName, from, to) {
  const nextName = locatorName(to);
  return updateLocators(bones, boneName, locators => {
    if (!Object.prototype.hasOwnProperty.call(locators, from)) throw Error("定位器不存在");
    if (nextName !== from && Object.keys(locators).some(name => name.toLowerCase() === nextName.toLowerCase())) throw Error("已有同名定位器");
    const record = locators[from];
    delete locators[from];
    locators[nextName] = record;
    return locators;
  });
}

function duplicateLocator(bones, boneName, name) {
  let created = "";
  const next = updateLocators(bones, boneName, locators => {
    if (!Object.prototype.hasOwnProperty.call(locators, name)) throw Error("定位器不存在");
    if (Object.keys(locators).length >= 64) throw Error("定位器数量超过 64 个");
    created = freshLocatorName(locators, name);
    locators[created] = JSON.parse(JSON.stringify(locators[name]));
    return locators;
  });
  return { bones: next, name: created };
}

function setLocator(bones, boneName, name, patch) {
  return updateLocators(bones, boneName, locators => {
    if (!Object.prototype.hasOwnProperty.call(locators, name)) throw Error("定位器不存在");
    const record = { ...locators[name] };
    if (patch.offset) record.offset = roundLocator(patch.offset);
    if (patch.rotation) record.rotation = roundLocator(patch.rotation);
    if (Object.prototype.hasOwnProperty.call(patch, "ignore_inherited_scale")) {
      if (patch.ignore_inherited_scale) record.ignore_inherited_scale = true;
      else delete record.ignore_inherited_scale;
    }
    locators[name] = locatorRecord(record);
    return locators;
  });
}

function transformLocator(bones, boneName, name, kind, delta) {
  if (kind === "scale") throw Error("定位器不能缩放");
  const key = kind === "rotate" ? "rotation" : "offset";
  return updateLocators(bones, boneName, locators => {
    if (!Object.prototype.hasOwnProperty.call(locators, name)) throw Error("定位器不存在");
    const record = { ...locators[name] };
    const base = key === "rotation" ? (record.rotation || [0, 0, 0]) : record.offset;
    record[key] = roundLocator([0, 1, 2].map(index => (Number(base[index]) || 0) + (Number(delta?.[index]) || 0)));
    locators[name] = record;
    return locators;
  });
}

module.exports = { renameBone, reparentBone, addBone, removeBone, addCube, removeCube, moveCube, duplicateSelection, transformSelection, transformMany, snapDelta, mirrorSelection, uvRects, uvFaces, mirrorPaintAt, unwrapSelection, rotateFace, faceUvCorners, scaleFace, editFaceUv, remember, boneTree, parentBones, ensureCubeIds, publishBones, isCubeHidden, addLocator, removeLocator, renameLocator, duplicateLocator, setLocator, transformLocator };
