import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Button, Select } from "../../app/ui.jsx";
import models from "../../../shared/skins/npc-models.json";
import textures from "../../../shared/skins/npc-textures.json";
import slotTextures from "./npc-slot-textures.json";
import animationSets from "./npc-animations.json";
import { sampleTrack, clipTime } from "./npc-clip.cjs";
import { isCubeHidden, faceUvCorners } from "../../../shared/model-edit.cjs";
import { cubeVertices, inflateCubeVertices } from "../../../shared/model-vertex-edit.cjs";

export function npcModelFor(identifier) {
  return models[identifier] || null;
}
export function npcTextureFor(identifier) {
  return textures[identifier] || "";
}
export function npcSlotTexture(identifier, slot) {
  const table = slotTextures[identifier];
  if (table) return table[slot] || "";
  return npcTextureFor(identifier);
}
export function npcClipsFor(identifier) {
  return animationSets[identifier] || null;
}

export function boxFaces(uv, size, mirror) {
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
export function faceRect(face) {
  if (!face?.uv || !face.uv_size) return [0, 0, 0, 0];
  return [face.uv[0], face.uv[1], face.uv_size[0], face.uv_size[1]];
}
function writeFace(attr, index, tw, th, rect, rotation) {
  faceUvCorners(rect, rotation).forEach(([u, v], corner) => attr.setXY(index * 4 + corner, u / tw, v / th));
}
function customCubeGeometry(vertices, faces, tw, th, rotations, pivot) {
  const order = [
    ["east", [1, 5, 6, 2]], ["west", [4, 0, 3, 7]], ["up", [3, 2, 6, 7]],
    ["down", [0, 4, 5, 1]], ["south", [5, 4, 7, 6]], ["north", [0, 1, 2, 3]],
  ];
  const positions = [], uvs = [], geometry = new THREE.BufferGeometry();
  order.forEach(([name, indices], faceIndex) => {
    const corners = faceUvCorners(faces[name], rotations[name] || 0);
    indices.forEach((vertexIndex, index) => {
      const point = vertices[vertexIndex];
      positions.push((point[0] - pivot[0]) / 16, (point[1] - pivot[1]) / 16, (point[2] - pivot[2]) / 16);
      uvs.push(corners[index][0] / tw, corners[index][1] / th);
    });
    geometry.addGroup(faceIndex * 6, 6, faceIndex);
  });
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}
function addPolyMesh(group, bone, model, meshes) {
  const keys = model.hidden instanceof Set ? model.hidden : new Set(model.hidden || []);
  if (!bone.poly_mesh || keys.has(bone.name) || keys.has(bone.name + ":mesh")) return;
  try {
    const data = bone.poly_mesh;
    const pivot = bone.pivot || [0, 0, 0];
    const positions = [], uvs = [];
    const groups = [];
    let cursor = 0;
    for (const poly of data.polys || []) {
      const corners = poly.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2];
      for (const corner of corners) {
        const point = data.positions[poly[corner]];
        const uv = data.uvs?.[poly[corner]] || [0, 0];
        positions.push((point[0] - pivot[0]) / 16, (point[1] - pivot[1]) / 16, (point[2] - pivot[2]) / 16);
        uvs.push(uv[0] / (model.tw || 64), uv[1] / (model.th || 64));
      }
      groups.push({ start: cursor, count: corners.length, texture: data.face_textures?.[groups.length] || "" });
      cursor += corners.length;
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    const keys = [...new Set(groups.map(group => group.texture))];
    const materials = keys.map(key => {
      const value = new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.05, side: THREE.DoubleSide });
      value.userData.textureKey = key;
      return value;
    });
    groups.forEach(group => geometry.addGroup(group.start, group.count, keys.indexOf(group.texture)));
    const mesh = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
    mesh.userData.cubeKey = bone.name + ":mesh";
    group.add(mesh);
    meshes.push(mesh);
  } catch { /* 坏网格不拖垮立方体预览。 */ }
}
export function buildModel(model) {
  const root = new THREE.Group();
  const bones = new Map();
  const groups = new Map();
  for (const bone of model.bones) bones.set(bone.name, { bone, group: new THREE.Group() });
  const meshes = [];
  for (const { bone, group } of bones.values()) {
    const parent = bone.parent ? bones.get(bone.parent)?.group : null;
    (parent || root).add(group);
    const pivot = bone.pivot || [0, 0, 0];
    const parentPivot = bone.parent ? bones.get(bone.parent)?.bone.pivot || [0, 0, 0] : [0, 0, 0];
    group.position.set((pivot[0] - parentPivot[0]) / 16, (pivot[1] - parentPivot[1]) / 16, (pivot[2] - parentPivot[2]) / 16);
    if (bone.rotation) {
      group.rotation.order = "ZYX";
      group.rotation.set(
        THREE.MathUtils.degToRad(bone.rotation[0] || 0),
        THREE.MathUtils.degToRad(bone.rotation[1] || 0),
        THREE.MathUtils.degToRad(bone.rotation[2] || 0),
      );
    }
    group.userData.base = {
      px: group.position.x,
      py: group.position.y,
      pz: group.position.z,
      rx: group.rotation.x,
      ry: group.rotation.y,
      rz: group.rotation.z,
    };
    groups.set(bone.name.toLowerCase(), group);
    (bone.cubes || []).forEach((cube, index) => {
      if (isCubeHidden(model.hidden, bone.name, cube, index)) return;
      let origin = cube.origin.slice();
      let size = cube.size.slice();
      const storedVertices = cube.dgn_vertices ? cubeVertices(cube) : null;
      const customVertices = storedVertices ? inflateCubeVertices(cube) : null;
      const inflate = cube.inflate || 0;
      const uvSize = size.slice();
      if (inflate) {
        origin = origin.map((value) => value - inflate);
        size = size.map((value) => value + inflate * 2);
      }
      if (!customVertices && size.some((value) => !value)) return;
      const geometry = customVertices ? null : new THREE.BoxGeometry(Math.abs(size[0]) / 16, Math.abs(size[1]) / 16, Math.abs(size[2]) / 16);
      const faces = Array.isArray(cube.uv)
        ? boxFaces(cube.uv, uvSize.map(Math.abs), cube.mirror)
        : {
          east: faceRect(cube.uv?.east),
          west: faceRect(cube.uv?.west),
          up: faceRect(cube.uv?.up),
          down: faceRect(cube.uv?.down),
          south: faceRect(cube.uv?.south),
          north: faceRect(cube.uv?.north),
        };
      const rotations = Object.fromEntries(["east", "west", "up", "down", "south", "north"].map(name => [name, cube.uv?.[name]?.uv_rotation || 0]));
      const meshGeometry = customVertices ? customCubeGeometry(customVertices, faces, model.tw, model.th, rotations, cube.pivot || [origin[0] + size[0] / 2, origin[1] + size[1] / 2, origin[2] + size[2] / 2]) : geometry;
      if (!customVertices) { const attr = meshGeometry.getAttribute("uv"); ["east", "west", "up", "down", "south", "north"].forEach((name, index) => writeFace(attr, index, model.tw, model.th, faces[name], rotations[name])); attr.needsUpdate = true; }
      const makeMaterial = () => new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.05, side: THREE.DoubleSide });
      const material = model.faceTextures ? ["east", "west", "up", "down", "south", "north"].map(name => {
        const value = makeMaterial();
        value.userData.textureKey = cube.uv?.[name]?.dgn_texture || "";
        value.visible = Array.isArray(cube.uv) || !!cube.uv?.[name];
        return value;
      }) : makeMaterial();
      const mesh = new THREE.Mesh(meshGeometry, material);
      mesh.userData.cubeKey = bone.name + ":" + index;
      const center = [origin[0] + size[0] / 2, origin[1] + size[1] / 2, origin[2] + size[2] / 2];
      const holder = new THREE.Group();
      const cubePivot = cube.pivot || center;
      holder.position.set((cubePivot[0] - pivot[0]) / 16, (cubePivot[1] - pivot[1]) / 16, (cubePivot[2] - pivot[2]) / 16);
      if (cube.rotation) {
        holder.rotation.order = "ZYX";
        // 方块的旋转方向和骨骼相反，不取反时宝箱金边会离开箱体。
        holder.rotation.set(
          THREE.MathUtils.degToRad(-(cube.rotation[0] || 0)),
          THREE.MathUtils.degToRad(-(cube.rotation[1] || 0)),
          THREE.MathUtils.degToRad(-(cube.rotation[2] || 0)),
        );
      }
      mesh.position.set(customVertices ? 0 : (center[0] - cubePivot[0]) / 16, customVertices ? 0 : (center[1] - cubePivot[1]) / 16, customVertices ? 0 : (center[2] - cubePivot[2]) / 16);
      holder.add(mesh);
      group.add(holder);
      meshes.push(mesh);
    });
    addPolyMesh(group, bone, model, meshes);
  }
  return { root, meshes, groups };
}

export function applyClip(groups, clip, seconds) {
  const time = clip ? clipTime(clip, seconds) : 0;
  for (const [name, group] of groups) {
    const base = group.userData.base;
    const channels = clip?.bones?.[name];
    const rotation = channels?.r ? sampleTrack(channels.r, time) : null;
    const position = channels?.p ? sampleTrack(channels.p, time) : null;
    const scale = channels?.s ? sampleTrack(channels.s, time) : null;
    group.rotation.order = "ZYX";
    group.rotation.set(
      base.rx + THREE.MathUtils.degToRad(rotation?.[0] || 0),
      base.ry + THREE.MathUtils.degToRad(rotation?.[1] || 0),
      base.rz + THREE.MathUtils.degToRad(rotation?.[2] || 0),
    );
    group.position.set(
      base.px + (position?.[0] || 0) / 16,
      base.py + (position?.[1] || 0) / 16,
      base.pz + (position?.[2] || 0) / 16,
    );
    group.scale.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
  }
}

export function captureNpcModel(model, image, width = 104, height = 156, clip = null) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, width / height, 0.01, 200);
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const built = buildModel(model);
  scene.add(built.root);
  applyClip(built.groups, clip, 0);
  if (image) {
    const texture = new THREE.CanvasTexture(image);
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    for (const mesh of built.meshes) mesh.material.map = texture;
  }
  const bounds = new THREE.Box3().setFromObject(built.root);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z, 0.5) * 1.7;
  camera.position.set(center.x + distance * 0.45, center.y + distance * 0.25, center.z - distance);
  camera.lookAt(center);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  built.meshes.forEach((mesh) => {
    mesh.geometry.dispose();
    mesh.material.map?.dispose();
    mesh.material.dispose();
  });
  renderer.dispose();
  return url;
}

export function NpcModelView({ model, src, defaultSrc = "", canvasSource, revision = 0, clips = null }) {
  const host = useRef(null);
  const canvas = useRef(null);
  const controlsRef = useRef(null);
  const meshes = useRef([]);
  const [spin, setSpin] = useState(true);
  const spinRef = useRef(true);
  const [clipName, setClipName] = useState(clips?.default || "");
  const clipRef = useRef(clips);
  const nameRef = useRef(clipName);
  const started = useRef(0);
  clipRef.current = clips;
  nameRef.current = clipName;
  useEffect(() => {
    setClipName(clips?.default || clips?.clips?.[0]?.name || "");
    started.current = performance.now();
  }, [clips]);
  useEffect(() => {
    const renderer = new THREE.WebGLRenderer({ canvas: canvas.current, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
    const controls = new OrbitControls(camera, canvas.current);
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    const built = buildModel(model);
    const turn = new THREE.Group();
    turn.add(built.root);
    scene.add(turn);
    const initial = clips?.clips?.find((clip) => clip.name === (clips.default || clipName));
    applyClip(built.groups, initial, 0);
    meshes.current = built.meshes;
    const bounds = new THREE.Box3().setFromObject(built.root);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const distance = Math.max(size.x, size.y, size.z, 0.5) * 1.7;
    camera.position.set(center.x + distance * 0.45, center.y + distance * 0.25, center.z - distance);
    controls.target.copy(center);
    controls.update();
    controls.saveState();
    controlsRef.current = controls;
    const resize = () => {
      const width = host.current?.clientWidth || 260;
      const height = 340;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    let frame = 0;
    const loop = () => {
      const playing = clipRef.current?.clips?.find((clip) => clip.name === nameRef.current);
      applyClip(built.groups, playing, (performance.now() - started.current) / 1000);
      if (spinRef.current) turn.rotation.y += 0.012;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      controlsRef.current = null;
      built.meshes.forEach((mesh) => {
        mesh.geometry.dispose();
        mesh.material.map?.dispose();
        mesh.material.dispose();
      });
      renderer.dispose();
      meshes.current = [];
    };
  }, [model]);
  useEffect(() => {
    let alive = true;
    const apply = (image) => {
      if (!alive) return;
      for (const mesh of meshes.current) {
        const texture = new THREE.CanvasTexture(image);
        texture.flipY = false;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        mesh.material.map?.dispose();
        mesh.material.map = texture;
        mesh.material.needsUpdate = true;
      }
    };
    if (defaultSrc || src) {
      const image = new Image();
      image.onload = () => {
        const copy = document.createElement("canvas");
        copy.width = image.width;
        copy.height = image.height;
        copy.getContext("2d").drawImage(image, 0, 0);
        apply(copy);
      };
      image.src = defaultSrc || src;
    } else if (canvasSource?.current) apply(canvasSource.current);
    return () => { alive = false; };
  }, [src, defaultSrc, canvasSource, defaultSrc ? 0 : revision, model]);
  function toggleSpin() {
    spinRef.current = !spinRef.current;
    setSpin(spinRef.current);
  }
  function resetView() {
    controlsRef.current?.reset();
  }
  return <>
    <div ref={host} className="skin-3d-host" data-texture-source={defaultSrc ? "default" : canvasSource?.current ? "skin" : src ? "skin" : "none"}>
      <canvas ref={canvas} aria-label="自定义模型预览" />
    </div>
    <div className="skin-tools">
      <Button aria-pressed={spin} onClick={toggleSpin}>{spin ? "停止旋转" : "继续旋转"}</Button>
      <Button onClick={resetView}>重置视角</Button>
      {clips?.clips?.length > 0 && <Select
        aria-label="动作"
        value={clipName}
        options={clips.clips.map((clip) => ({ value: clip.name, label: clip.name }))}
        onChange={(value) => { started.current = performance.now(); setClipName(value); }}
      />}
    </div>
  </>;
}
