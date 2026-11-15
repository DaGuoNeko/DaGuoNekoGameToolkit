const { randomUUID } = require("node:crypto");
const { normalizeDisplay } = require("../../../shared/model-display.cjs");
const { assignedTextures } = require("../../../shared/model-materials.cjs");
const { validateVertices } = require("../../../shared/model-vertex-edit.cjs");
const { bbMesh, readBbMesh } = require("../../../shared/model-mesh.cjs");
const { soundFrames: readSoundFrames, soundName, soundLevel } = require("../../../shared/animation-sounds.cjs");
const { particleFrames: readParticleFrames, particleName, particleScript, particleBind } = require("../../../shared/animation-particles.cjs");
const { instructionFrames: readInstructionFrames, instructionText } = require("../../../shared/animation-timeline.cjs");
const { controllerId, validateControllers } = require("../../../shared/animation-controller.cjs");
const { bakeNativeFrames, restoreNativeFrames, collapseBakedFrames } = require("../../../shared/animation-bezier-exchange.cjs");
const faces = ["north", "east", "south", "west", "up", "down"];
const channels = ["rotation", "position", "scale"];
const fail = message => { throw Error("BBModel：" + message); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const empty = value => value == null || value === false || value === "" || (typeof value === "object" && Object.keys(value).length === 0);
function unsupported(value, names) {
  for (const name of names) if (!empty(value?.[name])) fail("暂不支持 " + name + "，已停止转换");
}
function vec(value, length = 3) {
  if (!Array.isArray(value) || value.length !== length || value.some(n => !Number.isFinite(n) || Math.abs(n) > 1e6)) fail("坐标或 UV 数值无效");
  return value.slice();
}
function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || ["__proto__", "constructor", "prototype"].includes(value)) fail(label + "无效");
  return value;
}
function list(value, max, label) {
  if (!Array.isArray(value) || value.length > max) fail(label + "数量无效或超过限制");
  return value;
}
function flip(value, axes) { return vec(value).map((n, i) => axes.includes(i) ? -n || 0 : n); }
function readBbLocator(value) {
  let offset, rotation, ignore = false;
  if (Array.isArray(value)) offset = vec(value);
  else if (object(value)) {
    offset = vec(value.offset || value.position || [0, 0, 0]);
    if (value.rotation != null) rotation = vec(value.rotation);
    if (value.ignore_inherited_scale === true) ignore = true;
    else if (![undefined, false].includes(value.ignore_inherited_scale)) fail("定位器缩放标记无效");
  } else fail("定位器数据无效");
  return { offset, rotation, ignore };
}
function putLocator(bone, name, raw) {
  const locatorName = text(name, "定位器名称");
  bone.locators = bone.locators || {};
  if (Object.keys(bone.locators).some(key => key.toLowerCase() === locatorName.toLowerCase())) fail("定位器名称重复");
  if (Object.keys(bone.locators).length >= 64) fail("定位器数量超过 64 个");
  const data = readBbLocator(raw);
  const locator = { offset: flip(data.offset, [0]) };
  if (data.rotation) locator.rotation = flip(data.rotation, [0, 1]);
  if (data.ignore) locator.ignore_inherited_scale = true;
  bone.locators[locatorName] = locator;
}
function dimension(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2048) fail("贴图尺寸应在 1–2048 之间");
  return value;
}
function invert(value) {
  if (typeof value === "number") return -value || 0;
  if (/^-\([\s\S]*\)$/.test(value)) return value.slice(2, -1);
  return "-(" + value + ")";
}
function animationVec(value, channel, flipAxes) {
  const result = Array.isArray(value) ? value.slice() : [value, value, value];
  if (result.length !== 3 || result.some(n => typeof n !== "string" && !Number.isFinite(n))) fail("动画值无效");
  return result.map((n, i) => {
    if (typeof n === "string" && (n.length > 2048 || !n.trim() || /[;{}]/.test(n))) fail("动画包含尚不支持的复杂 Molang");
    if (typeof n === "string" && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(n)) n = Number(n);
    if (typeof n === "number" && !Number.isFinite(n)) fail("动画数值溢出");
    return flipAxes && ((channel === "position" && i === 0) || (channel === "rotation" && i < 2)) ? invert(n) : n;
  });
}
function frameTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time < 0 || time > 10000) fail("关键帧时间无效");
  // 工作台目前以 0.05 秒为编辑步长，拒绝静默舍入源工程的时间。
  if (Math.abs(time * 20 - Math.round(time * 20)) > 1e-6) fail("关键帧时间不是 0.05 秒的倍数");
  return time;
}
function copyBezier(animation, names) {
  if (animation?.dgn_bezier == null) return undefined;
  if (!Array.isArray(animation.dgn_bezier) || animation.dgn_bezier.length > 400) fail("贝塞尔记录无效");
  return animation.dgn_bezier.map(item => {
    if (!item || typeof item !== "object" || !["rotation", "position", "scale"].includes(item.channel) || ![0, 1, 2].includes(item.axis)) fail("贝塞尔记录无效");
    const bone = text(item.bone, "贝塞尔骨骼");
    if (names && !names.has(bone)) fail("贝塞尔记录引用了模型外的骨骼");
    if (!Array.isArray(item.control) || item.control.length !== 4 || item.control.some(value => !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 3)) fail("贝塞尔记录无效");
    return { bone, channel: item.channel, axis: item.axis, from: frameTime(item.from), to: frameTime(item.to), control: item.control.map(value => Number(value)) };
  });
}
function soundFrames(effects) {
  return readSoundFrames(effects).map(row => ({
    channel: "sound", time: frameTime(row.time), interpolation: "linear",
    data_points: row.sounds.map(sound => {
      if (Object.keys(sound).some(key => key !== "effect" && key !== "pitch" && key !== "volume")) fail("声音含暂不支持的附加字段，已停止转换");
      const point = { effect: sound.effect };
      try {
        if (sound.pitch != null && sound.pitch !== "") point.pitch = soundLevel(sound.pitch, "音高");
        if (sound.volume != null && sound.volume !== "") point.volume = soundLevel(sound.volume, "音量");
      } catch (error) { fail(error.message); }
      return point;
    }),
  }));
}
function particleExport(effects) {
  return readParticleFrames(effects).map(row => {
    if (Object.keys(row.source).some(key => key !== "effect" && key !== "locator" && key !== "pre_effect_script" && key !== "bind_to_actor")) fail("粒子含暂不支持的附加字段，已停止转换");
    const point = { effect: row.effect };
    if (row.locator) point.locator = row.locator;
    if (row.source.pre_effect_script) point.script = row.source.pre_effect_script;
    if (row.source.bind_to_actor === true) point.bind_to_actor = true;
    return { channel: "particle", time: frameTime(row.time), interpolation: "linear", data_points: [point] };
  });
}
function timelineExport(entries) {
  return readInstructionFrames(entries).map(row => ({ channel: "timeline", time: frameTime(row.time), interpolation: "linear", data_points: [{ script: row.text }] }));
}
function validateBones(bones) {
  list(bones, 400, "骨骼");
  const names = new Set();
  const byName = new Map();
  let count = 0;
  for (const bone of bones) {
    const name = text(bone?.name, "骨骼名称");
    if (names.has(name.toLowerCase())) fail("骨骼名称重复");
    names.add(name.toLowerCase()); byName.set(name, bone);
    count += list(bone.cubes || [], 2000, "立方体").length;
  }
  if (count > 2000) fail("立方体超过 2000 个");
  for (const bone of bones) {
    const seen = new Set([bone.name]);
    let current = bone;
    while (current.parent) {
      if (seen.has(current.parent)) fail("骨骼父级存在循环");
      seen.add(current.parent);
      current = byName.get(current.parent);
      if (!current) fail("骨骼父级不存在");
      if (seen.size > 64) fail("骨骼层级超过 64 层");
    }
  }
}

function exportProject({ identifier, bones, textureWidth, textureHeight, texture, textures: suppliedTextures, animations = {}, display = {}, controllers = {} }) {
  text(identifier, "模型标识符");
  validateBones(bones);
  const bindings = assignedTextures(bones), multi = bindings.length > 0;
  const palette = multi ? list(suppliedTextures, 8, "面贴图") : [];
  if (multi && (!palette.length || bindings.some(key => !palette.some(item => item.key === key)))) fail("面贴图缺失，已停止导出");
  if (multi && Object.keys(animations).length) fail("多贴图方块工程不支持动画，请分开导出，未丢弃动画");
  const shown = normalizeDisplay(display);
  const ids = new Map(bones.map(bone => [bone.name, randomUUID()]));
  const model = { meta: { format_version: "5.0", model_format: "bedrock", box_uv: true }, name: identifier, model_identifier: identifier.replace(/^geometry\./, ""), resolution: { width: dimension(textureWidth), height: dimension(textureHeight) }, elements: [], groups: [], outliner: [], textures: [], animations: [] };
  if (multi) {
    model.meta.model_format = "bedrock_block";
    const keys = new Set();
    for (const item of palette) {
      if (!object(item) || typeof item.key !== "string" || keys.has(item.key) || typeof item.source !== "string" || !item.source.startsWith("data:image/png;base64,")) fail("面贴图无效或重复");
      keys.add(item.key);
      model.textures.push({ uuid: randomUUID(), id: String(model.textures.length), name: item.key.split("/").pop() || "texture.png", source: item.source, internal: true, mode: "bitmap", uv_width: textureWidth, uv_height: textureHeight });
    }
  } else if (texture) model.textures.push({ uuid: randomUUID(), id: "0", name: "texture.png", source: texture, internal: true, mode: "bitmap", uv_width: textureWidth, uv_height: textureHeight });
  if (Object.keys(shown).length) model.display = shown;
  if (controllers && Object.keys(controllers).length) model.animation_controllers = validateControllers(controllers);
  const trees = new Map();
  for (const bone of bones) {
    unsupported(bone, ["binding", "reset", "material", "texture_meshes", "render_group_id"]);
    const group = { uuid: ids.get(bone.name), name: bone.name, origin: flip(bone.pivot || [0, 0, 0], [0]), rotation: flip(bone.rotation || [0, 0, 0], [0, 1]), export: true };
    model.groups.push(group);
    const tree = { uuid: group.uuid, children: [] };
    trees.set(bone.name, tree);
    if (bone.locators != null && !object(bone.locators)) fail("定位器数据无效");
    const seenLocators = new Set();
    for (const locatorName of Object.keys(bone.locators || {})) {
      text(locatorName, "定位器名称");
      if (seenLocators.has(locatorName.toLowerCase())) fail("定位器名称重复");
      seenLocators.add(locatorName.toLowerCase());
      if (seenLocators.size > 64) fail("定位器数量超过 64 个");
      const data = readBbLocator(bone.locators[locatorName]);
      const element = { uuid: randomUUID(), name: locatorName, type: "locator", position: flip(data.offset, [0]), export: true };
      if (data.rotation) element.rotation = flip(data.rotation, [0, 1]);
      if (data.ignore) element.ignore_inherited_scale = true;
      model.elements.push(element); tree.children.push(element.uuid);
    }
    for (const cube of bone.cubes || []) {
      unsupported(cube, ["poly_mesh", "texture_meshes"]);
      const size = vec(cube.size), origin = vec(cube.origin);
      if (size.some(n => n < 0)) fail("暂不支持负尺寸立方体");
      const from = [-origin[0] - size[0], origin[1], origin[2]];
      const element = { uuid: randomUUID(), name: cube.name || bone.name, type: "cube", from, to: from.map((n, i) => n + size[i]), origin: flip(cube.pivot || [0, 0, 0], [0]), rotation: flip(cube.rotation || [0, 0, 0], [0, 1]), inflate: cube.inflate ?? bone.inflate ?? 0, box_uv: Array.isArray(cube.uv), mirror_uv: cube.mirror ?? bone.mirror ?? false, faces: {} };
      if (cube.dgn_vertices !== undefined) element.dgn_vertices = validateVertices(cube.dgn_vertices);
      if (!Number.isFinite(element.inflate)) fail("膨胀数值无效");
      if (element.box_uv) element.uv_offset = vec(cube.uv, 2);
      else model.meta.box_uv = false;
      for (const name of faces) {
        const face = cube.uv?.[name];
        if (!element.box_uv && !face) { element.faces[name] = { uv: [0, 0, 0, 0], texture: null }; continue; }
        if (face?.material_instance && !multi) fail("暂不支持未绑定的分面材质");
        if (![0, 90, 180, 270].includes(face?.uv_rotation || 0)) fail("UV 旋转角度无效");
        let rect = [0, 0, 0, 0];
        if (face) { const uv = vec(face.uv, 2), span = vec(face.uv_size, 2); rect = [...uv, uv[0] + span[0], uv[1] + span[1]]; }
        if (name === "up" || name === "down") rect = [rect[2], rect[3], rect[0], rect[1]];
        element.faces[name] = { uv: rect, texture: multi ? face?.dgn_texture ? palette.findIndex(item => item.key === face.dgn_texture) : 0 : texture ? 0 : false };
        if (face?.material_instance) element.faces[name].material_name = text(face.material_instance, "材质名称");
        if (face?.uv_rotation) element.faces[name].rotation = face.uv_rotation;
      }
      model.elements.push(element); tree.children.push(element.uuid);
    }
    if (bone.poly_mesh) {
      let built;
      try { built = bbMesh(bone.poly_mesh, bone.dgn_mesh_welds, bone.pivot || [0, 0, 0]); }
      catch (error) { fail(error.message); }
      const element = { uuid: randomUUID(), name: bone.name + " 网格", type: "mesh", origin: flip(bone.pivot || [0, 0, 0], [0]), rotation: [0, 0, 0], vertices: built.vertices, faces: {}, export: true, dgn_mesh_welds: built.welds };
      for (const [id, face] of Object.entries(built.faces)) {
        let slot = texture || multi ? 0 : false;
        if (face.texture) {
          const index = palette.findIndex(item => item.key === face.texture);
          if (index < 0) fail("面贴图缺失，已停止导出");
          slot = index;
        }
        const { texture: _texture, ...rest } = face;
        element.faces[id] = { ...rest, texture: slot };
      }
      model.elements.push(element); tree.children.push(element.uuid);
    }
  }
  for (const bone of bones) (bone.parent ? trees.get(bone.parent).children : model.outliner).push(trees.get(bone.name));
  if (!object(animations) || Object.keys(animations).length > 100) fail("动画数量无效");
  for (const [name, animation] of Object.entries(animations)) {
    text(name, "动画名称");
    unsupported(animation, ["anim_time_update", "blend_weight", "start_delay", "loop_delay"]);
    if (![true, false, "hold_on_last_frame", undefined].includes(animation.loop)) fail("动画循环表达式尚不支持");
    const entry = { uuid: randomUUID(), name, loop: animation.loop === true ? "loop" : animation.loop === "hold_on_last_frame" ? "hold" : "once", length: frameTime(animation.animation_length ?? 1), override: !!animation.override_previous_animation, animators: {} };
    const bezier = copyBezier(animation, ids);
    if (bezier) entry.dgn_bezier = bezier;
    const sounds = soundFrames(animation.sound_effects);
    const particles = particleExport(animation.particle_effects);
    const instructions = timelineExport(animation.timeline);
    const effectOrder = { particle: 0, sound: 1, timeline: 2 };
    const effectKeys = [...particles, ...sounds, ...instructions].sort((a, b) => a.time - b.time || effectOrder[a.channel] - effectOrder[b.channel]);
    if (effectKeys.length) entry.animators.effects = { name: "Effects", type: "effect", keyframes: effectKeys };
    let framesCount = 0;
    let sampledCount = 0;
    const nativeRecords = animation.dgn_native_bezier == null ? [] : list(animation.dgn_native_bezier, 400, "原生贝塞尔记录");
    for (const [boneName, tracks] of Object.entries(animation.bones || {})) {
      if (!ids.has(boneName)) fail("动画引用了模型外的骨骼 " + boneName);
      unsupported(tracks, ["relative_to", "bind_pose_rotation"]);
      const animator = { name: boneName, type: "bone", keyframes: [] };
      for (const channel of Object.keys(tracks)) {
        if (!channels.includes(channel)) fail("暂不支持动画通道 " + channel);
        const track = tracks[channel];
        const frames = object(track) && !Object.hasOwn(track, "post") && !Object.hasOwn(track, "pre") ? Object.entries(track) : [[0, track]];
        const exportedFrames = [];
        for (const [time, frame] of frames) {
          if (++framesCount > 10000) fail("动画关键帧超过 10000 个");
          const mode = frame?.lerp_mode || "linear";
          if (!["linear", "catmullrom"].includes(mode)) fail("暂不支持插值 " + mode);
          const points = object(frame) ? [frame.pre, frame.post].filter(v => v !== undefined) : [frame];
          if (!points.length) fail("关键帧没有数据");
          exportedFrames.push({ channel, time: frameTime(time), interpolation: mode, data_points: points.map(point => Object.fromEntries(animationVec(point, channel, true).map((n, i) => [["x", "y", "z"][i], n]))) });
        }
        const native = nativeRecords.filter(row => row?.bone === boneName && row.channel === channel);
        if (native.length > 1) fail("原生贝塞尔记录重复");
        let restored;
        try {
          restored = restoreNativeFrames(exportedFrames, native[0]?.frames)
            || collapseBakedFrames(exportedFrames, bezier?.filter(row => row.bone === boneName && row.channel === channel));
        } catch (error) { fail(error.message); }
        sampledCount += restored ? bakeNativeFrames(restored).sampled.length : exportedFrames.length;
        if (sampledCount + effectKeys.length > 10000) fail("原生贝塞尔重新采样后超过 10000 个关键帧");
        animator.keyframes.push(...(restored || exportedFrames));
      }
      entry.animators[ids.get(boneName)] = animator;
    }
    model.animations.push(entry);
  }
  return model;
}

function controllerMap(value) {
  if (value == null || value === false || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length)) return {};
  try {
    if (Array.isArray(value)) {
      const map = {};
      if (value.length > 32) throw Error("控制器数量超过 32 个");
      for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("控制器无效");
        const id = controllerId(item.name || item.id);
        if (Object.hasOwn(map, id)) throw Error("控制器名称重复");
        map[id] = { states: item.states };
        if (item.initial_state != null) map[id].initial_state = item.initial_state;
      }
      return validateControllers(map);
    }
    return validateControllers(value);
  } catch (error) { fail(error.message); }
}

function importProject(model) {
  if (!object(model) || !object(model.meta) || !["4.10", "5.0"].includes(model.meta.format_version)) fail("仅支持工程格式 4.10 或 5.0");
  if (!["bedrock", "bedrock_block"].includes(model.meta.model_format)) fail("仅支持 Bedrock 实体或方块立方体工程");
  const multi = model.meta.model_format === "bedrock_block";
  if (multi && model.animations?.length) fail("多贴图方块工程不支持动画，已停止导入");
  const controllers = controllerMap(model.animation_controllers);
  unsupported(model, ["texture_groups", "overrides"]);
  const display = normalizeDisplay(model.display);
  const textures = list(model.textures || [], multi ? 8 : 1, "贴图（实体一张，方块最多八张内嵌 PNG）");
  const texture = textures[0]?.source || "";
  if (textures.length && !texture.startsWith("data:image/png;base64,")) fail("贴图必须内嵌为 PNG，不读取工程中的外部路径");
  for (const item of textures) {
    if (!object(item) || typeof item.source !== "string" || !item.source.startsWith("data:image/png;base64,")) fail("贴图必须内嵌为 PNG");
    unsupported(item, ["layers"]);
    if (item.frame_count > 1) fail("暂不支持动画贴图");
    if (item.uv_width && item.uv_width !== model.resolution?.width || item.uv_height && item.uv_height !== model.resolution?.height) fail("贴图 UV 尺寸与工程不同");
  }
  const textureIndex = reference => {
    if (reference === false || reference === undefined) return 0;
    if (typeof reference === "number" && Number.isInteger(reference) && reference >= 0 && reference < textures.length) return reference;
    if (typeof reference === "string") {
      const matches = textures.flatMap((item, i) => item.uuid === reference || String(i) === reference ? [i] : []);
      if (matches.length === 1) return matches[0];
    }
    fail("元素引用了不可用贴图");
  };
  const importedTextures = textures.map((item, i) => ({ key: "textures/texture_" + i + ".png", source: item.source }));
  const elements = new Map(), locatorElements = new Map(), meshElements = new Map(), groups = new Map();
  for (const item of list(model.elements || [], 2000, "元素")) {
    if (item.type === "locator") {
      const id = text(item.uuid, "元素 UUID");
      if (elements.has(id) || locatorElements.has(id)) fail("元素 UUID 重复");
      locatorElements.set(id, item);
      continue;
    }
    if (item.type === "mesh") {
      const id = text(item.uuid, "元素 UUID");
      if (elements.has(id) || locatorElements.has(id) || meshElements.has(id)) fail("元素 UUID 重复");
      meshElements.set(id, item);
      continue;
    }
    if (item.type && item.type !== "cube") fail("暂不支持 " + item.type + " 元素");
    const id = text(item.uuid, "元素 UUID");
    if (elements.has(id) || locatorElements.has(id)) fail("元素 UUID 重复");
    elements.set(id, item);
  }
  for (const group of list(model.groups || [], 400, "骨骼")) {
    const id = text(group.uuid, "骨骼 UUID");
    if (groups.has(id) || elements.has(id) || locatorElements.has(id) || meshElements.has(id)) fail("骨骼 UUID 重复");
    groups.set(id, group);
  }
  const bones = [], boneIds = new Map(), used = new Set();
  function cubeOf(element) {
    if (element.export === false || element.visibility === false) fail("暂不支持隐藏或禁用导出的元素");
    unsupported(element, ["rescale", "stretch"]);
    const from = vec(element.from), to = vec(element.to), size = to.map((n, i) => n - from[i]);
    if (size.some(n => n < 0)) fail("暂不支持负尺寸立方体");
    const cube = { origin: [-to[0] || 0, from[1], from[2]], size, pivot: flip(element.origin || [0, 0, 0], [0]), rotation: flip(element.rotation || [0, 0, 0], [0, 1]), inflate: element.inflate ?? 0 };
    if (element.dgn_vertices !== undefined) cube.dgn_vertices = validateVertices(element.dgn_vertices);
    if (!Number.isFinite(cube.inflate)) fail("膨胀数值无效");
    if (element.box_uv ?? model.meta.box_uv) {
      cube.uv = vec(element.uv_offset || [0, 0], 2); cube.mirror = !!element.mirror_uv;
      if (multi && textures.length) {
        const unwrapped = require("../../../shared/model-edit.cjs").unwrapSelection([{ name: "box", cubes: [cube] }], [{ bone: "box", cube: 0 }])[0].cubes[0];
        cube.uv = unwrapped.uv; delete cube.mirror;
        for (const name of faces) {
          const face = element.faces?.[name];
          if (face?.texture === null) { delete cube.uv[name]; continue; }
          cube.uv[name].dgn_texture = importedTextures[textureIndex(face?.texture)].key;
          if (face?.material_name) cube.uv[name].material_instance = text(face.material_name, "材质名称");
        }
      }
    }
    else {
      cube.uv = {};
      for (const name of faces) {
        const face = element.faces?.[name];
        if (!face || face.texture === null) continue;
        if (face.material_name && !multi) fail("暂不支持分面材质");
        if (![0, 90, 180, 270].includes(face.rotation || 0)) fail("UV 旋转角度无效");
        let rect = vec(face.uv, 4);
        if (name === "up" || name === "down") rect = [rect[2], rect[3], rect[0], rect[1]];
        cube.uv[name] = { uv: rect.slice(0, 2), uv_size: [rect[2] - rect[0], rect[3] - rect[1]] };
        if (multi && textures.length) cube.uv[name].dgn_texture = importedTextures[textureIndex(face.texture)].key;
        if (multi && face.material_name) cube.uv[name].material_instance = text(face.material_name, "材质名称");
        if (face.rotation) cube.uv[name].uv_rotation = face.rotation;
      }
    }
    for (const face of Object.values(element.faces || {})) if (face.texture !== null) {
      if (multi) { if (face.texture !== undefined && face.texture !== false) textureIndex(face.texture); }
      else if (![false, undefined, 0, "0", textures[0]?.uuid].includes(face.texture)) fail("元素引用了不可用贴图");
    }
    return cube;
  }
  function walk(nodes, parent, depth) {
    if (depth > 64) fail("骨骼层级超过 64 层");
    for (const node of list(nodes, 2400, "大纲")) {
      const id = typeof node === "string" ? node : node?.uuid;
      if (used.has(id)) fail("大纲含重复引用或循环");
      used.add(id);
      if (typeof node === "string") {
        if (locatorElements.has(id)) {
          const element = locatorElements.get(id);
          if (!parent) fail("定位器必须属于骨骼");
          if (element.export === false || element.visibility === false) fail("暂不支持隐藏或禁用导出的定位器");
          putLocator(parent, element.name, { position: element.position, rotation: element.rotation, ignore_inherited_scale: element.ignore_inherited_scale });
        } else if (meshElements.has(id)) {
          if (!parent) fail("网格必须属于骨骼");
          const element = meshElements.get(id);
          if (element.export === false || element.visibility === false) fail("暂不支持隐藏或禁用导出的元素");
          if (parent.poly_mesh) fail("每根骨骼只能有一个网格");
          let read;
          try { read = readBbMesh(element, element.origin ? flip(element.origin, [0]) : (parent.pivot || [0, 0, 0]), multi ? face => face.texture === false || face.texture == null ? "" : importedTextures[textureIndex(face.texture)].key : null); }
          catch (error) { fail(error.message); }
          parent.poly_mesh = read.poly_mesh;
          parent.dgn_mesh_welds = read.dgn_mesh_welds;
        } else {
          const element = elements.get(id);
          if (!element || !parent) fail("元素必须属于骨骼，或大纲引用无效");
          parent.cubes.push(cubeOf(element));
        }
      } else {
        if (elements.has(id) || locatorElements.has(id)) fail("骨骼与元素 UUID 冲突");
        const group = groups.get(id) || node;
        if (!object(group)) fail("骨骼数据无效");
        text(id, "骨骼 UUID");
        if (group.export === false || group.visibility === false) fail("暂不支持隐藏骨骼");
        unsupported(group, ["bedrock_binding", "reset", "material"]);
        const bone = { name: text(group.name, "骨骼名称"), pivot: flip(group.origin || [0, 0, 0], [0]), rotation: flip(group.rotation || [0, 0, 0], [0, 1]), cubes: [] };
        if (parent) bone.parent = parent.name;
        if (!empty(group.locators)) {
          if (!object(group.locators)) fail("定位器数据无效");
          for (const [locatorName, raw] of Object.entries(group.locators)) putLocator(bone, locatorName, raw);
        }
        bones.push(bone); boneIds.set(id, bone.name);
        walk(node.children || [], bone, depth + 1);
      }
    }
  }
  walk(model.outliner || [], null, 0);
  if ([...elements.keys(), ...locatorElements.keys(), ...meshElements.keys(), ...groups.keys()].some(id => !used.has(id))) fail("工程含未挂入大纲的元素");
  validateBones(bones);
  const animations = {};
  for (const animation of list(model.animations || [], 100, "动画")) {
    const name = text(animation.name, "动画名称");
    if (Object.hasOwn(animations, name)) fail("动画名称重复");
    unsupported(animation, ["anim_time_update", "blend_weight", "start_delay", "loop_delay"]);
    if (!["loop", "once", "hold", undefined].includes(animation.loop)) fail("动画循环类型无效");
    const entry = { loop: animation.loop === "loop" ? true : animation.loop === "hold" ? "hold_on_last_frame" : false, animation_length: frameTime(animation.length ?? 1), override_previous_animation: !!animation.override, bones: {} };
    const bezier = copyBezier(animation, new Set(boneIds.values()));
    if (bezier) entry.dgn_bezier = bezier;
    let count = 0;
    for (const [id, animator] of Object.entries(animation.animators || {})) {
      if (animator.type === "effect" || id === "effects") {
        if (boneIds.has(id) || animator.type && animator.type !== "effect") fail("效果轨道类型无效");
        for (const frame of list(animator.keyframes || [], 1000, "声音")) {
          if (++count > 10000) fail("动画关键帧超过 10000 个");
          if (frame.channel === "particle") {
            const points = list(frame.data_points, 1, "粒子事件");
            if (points.length !== 1 || !object(points[0]) || Object.keys(points[0]).some(key => key !== "effect" && key !== "locator" && key !== "script" && key !== "bind_to_actor")) fail("粒子含暂不支持的附加字段，已停止转换");
            const stored = { effect: particleName(points[0].effect, "粒子名称") };
            if (points[0].locator != null && points[0].locator !== "") stored.locator = particleName(points[0].locator, "定位器名称");
            if (points[0].script != null && points[0].script !== "") stored.pre_effect_script = particleScript(points[0].script);
            if (points[0].bind_to_actor != null) { const bound = particleBind(points[0].bind_to_actor); if (bound) stored.bind_to_actor = true; }
            const key = frameTime(frame.time).toFixed(2);
            entry.particle_effects = entry.particle_effects || {};
            if (Object.hasOwn(entry.particle_effects, key)) fail("粒子时间重复");
            entry.particle_effects[key] = stored;
            continue;
          }
          if (frame.channel === "timeline") {
            const points = list(frame.data_points, 1, "指令");
            if (points.length !== 1 || !object(points[0]) || Object.keys(points[0]).some(key => key !== "script")) fail("指令含暂不支持的附加字段，已停止转换");
            const key = frameTime(frame.time).toFixed(2);
            entry.timeline = entry.timeline || {};
            if (Object.hasOwn(entry.timeline, key)) fail("指令时间重复");
            entry.timeline[key] = instructionText(points[0].script);
            continue;
          }
          if (frame.channel !== "sound") fail("暂不支持效果通道 " + (frame.channel || ""));
          const sounds = list(frame.data_points, 1000, "声音事件").map(point => {
            if (!object(point) || Object.keys(point).some(key => key !== "effect" && key !== "pitch" && key !== "volume" && !empty(point[key]))) fail("声音含暂不支持的附加字段，已停止转换");
            const stored = { effect: soundName(point.effect) };
            try {
              if (point.pitch != null && point.pitch !== "") stored.pitch = soundLevel(point.pitch, "音高");
              if (point.volume != null && point.volume !== "") stored.volume = soundLevel(point.volume, "音量");
            } catch (error) { fail(error.message); }
            return stored;
          });
          if (!sounds.length) fail("声音事件为空");
          const key = frameTime(frame.time).toFixed(2);
          entry.sound_effects = entry.sound_effects || {};
          if (Object.hasOwn(entry.sound_effects, key)) fail("声音时间重复");
          entry.sound_effects[key] = sounds.length > 1 ? sounds : sounds[0];
        }
        continue;
      }
      if (!boneIds.has(id) || animator.type && animator.type !== "bone") fail("暂不支持效果轨道或模型外骨骼");
      unsupported(animator, ["rotation_global"]);
      const tracks = {};
      let importedFrames = list(animator.keyframes || [], 10000, "关键帧");
      const nativeChannels = channels.filter(channel => importedFrames.some(frame => frame.channel === channel && frame.interpolation === "bezier"));
      for (const channel of nativeChannels) {
        const original = importedFrames.filter(frame => frame.channel === channel).map(frame => {
          const data_points = list(frame.data_points, 2, "关键帧数据").map(point =>
            Object.fromEntries(animationVec([point.x, point.y, point.z], channel, model.meta.format_version !== "5.0").map((value, i) => [["x", "y", "z"][i], value])));
          const copy = { ...frame, data_points, time: frameTime(frame.time) };
          for (const key of ["bezier_left_value", "bezier_right_value"]) if (copy[key] !== undefined) copy[key] = animationVec(vec(copy[key]), channel, model.meta.format_version !== "5.0");
          return copy;
        });
        let baked;
        try { baked = bakeNativeFrames(original); } catch (error) { fail(error.message); }
        entry.dgn_native_bezier ||= [];
        if (entry.dgn_native_bezier.length >= 400) fail("原生贝塞尔记录超过 400 条");
        entry.dgn_native_bezier.push({ bone: boneIds.get(id), channel, frames: baked.frames });
        // 原生柄统一保存为 5.0 坐标，采样再转回当前导入版本交给原有读帧流程。
        const samples = baked.sampled.map(frame => ({ ...frame, data_points: frame.data_points.map(point =>
          Object.fromEntries(animationVec([point.x, point.y, point.z], channel, model.meta.format_version !== "5.0").map((value, i) => [["x", "y", "z"][i], value]))) }));
        importedFrames = [...importedFrames.filter(frame => frame.channel !== channel), ...samples];
        if (importedFrames.length + count > 10000) fail("贝塞尔采样后动画超过 10000 个关键帧");
      }
      for (const frame of importedFrames) {
        if (++count > 10000) fail("动画关键帧超过 10000 个");
        if (!channels.includes(frame.channel)) fail("暂不支持动画通道 " + frame.channel);
        const mode = frame.interpolation || "linear";
        if (!["linear", "catmullrom", "step"].includes(mode)) fail("暂不支持 " + mode + " 插值");
        const points = list(frame.data_points, 2, "关键帧数据").map(point => animationVec([point.x, point.y, point.z], frame.channel, model.meta.format_version === "5.0"));
        if (!points.length) fail("关键帧数据为空");
        const key = frameTime(frame.time).toFixed(2);
        const track = tracks[frame.channel] ||= {};
        if (Object.hasOwn(track, key)) fail("关键帧时间重复");
        track[key] = { points, mode };
      }
      for (const channel of Object.keys(tracks)) {
        let previous = null;
        for (const time of Object.keys(tracks[channel]).sort((a, b) => Number(a) - Number(b))) {
          const { points, mode } = tracks[channel][time];
          tracks[channel][time] = points.length === 2 ? { pre: points[0], post: points[1] } : points[0];
          if (previous?.mode === "step") tracks[channel][time] = { pre: previous.post, post: points.at(-1) };
          if (mode === "catmullrom") tracks[channel][time] = { ...(points.length === 2 ? { pre: points[0] } : {}), post: points.at(-1), lerp_mode: "catmullrom" };
          previous = { mode, post: points.at(-1) };
        }
      }
      entry.bones[boneIds.get(id)] = tracks;
    }
    readSoundFrames(entry.sound_effects);
    readParticleFrames(entry.particle_effects);
    readInstructionFrames(entry.timeline);
    animations[name] = entry;
  }
  const identifier = "geometry." + text(model.model_identifier || model.name || "imported", "模型标识符").replace(/^geometry\./, "");
  return { identifier, bones, textureWidth: dimension(model.resolution?.width), textureHeight: dimension(model.resolution?.height), texture, animations, display, ...(Object.keys(controllers).length ? { controllers } : {}), ...(multi ? { textures: importedTextures } : {}) };
}

module.exports = { exportProject, importProject };
