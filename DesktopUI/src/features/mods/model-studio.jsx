import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Button, Select } from "../../app/ui.jsx";
import { createViewCamera, frameViewCamera, resizeViewCamera, viewPresets } from "./model-camera.js";
import { applyViewPose, readViewPose } from "./model-camera.js";
import { pickProjectedVertex } from "./model-vertex-snap.js";
import { ModelUvDialog } from "./model-uv-dialog.jsx";
import { SelectionTransform } from "./model-selection-transform.jsx";
import { assignedTextures, paintBonesForTexture, faceNames } from "../../../shared/model-materials.cjs";
import { ModelLayerPanel } from "./model-layer-panel.jsx";
import { layerCanvas, flattenLayers, serializeLayers, restoreLayers, mergeLayerDown, maskedLayerCanvas, invertLayerMask } from "./model-layers.js";
import { MAX_LAYERS, MAX_PIXELS, layerBlendMode, maskCoverage } from "../../../shared/texture-layers.cjs";
import { containsPixel, selectionBounds, moveSelection as shiftedSelection, transformSelectedPixels, connectedPixels, paintMasked, compositeSelected, lassoSelection } from "../../../shared/paint-selection.cjs";
import { applyClip, boxFaces, buildModel, faceRect } from "../skins/npc-model-view.jsx";
import { remember, uvRects, mirrorPaintAt } from "../../../shared/model-edit.cjs";
import "./model-studio.css";

const call = (method, args = {}) => window.toolkit.call(method, args);

function facesOf(cube, relative) {
  if (!cube?.uv) return [];
  if (Array.isArray(cube.uv)) {
    const size = [0, 1, 2].map(index => Math.abs(Number(cube.size?.[index]) || 0));
    return Object.entries(boxFaces(cube.uv.map(Number), size, cube.mirror)).map(([name, rect]) => ({ name, rect }));
  }
  return ["east", "west", "up", "down", "south", "north"].flatMap(name => {
    const rect = faceRect(cube.uv?.[name]);
    if (!rect[2] && !rect[3]) return [];
    if (relative !== undefined && cube.uv[name]?.dgn_texture && cube.uv[name].dgn_texture !== relative) return [];
    return [{ name, rect }];
  });
}
function hitFace(bones, picked, point, relative) {
  let best = null;
  for (const bone of bones || []) {
    (bone.cubes || []).forEach((cube, index) => {
      const selected = picked?.bone === bone.name && picked?.cube === index;
      for (const face of facesOf(cube, relative)) {
        const [u, v, w, h] = face.rect;
        if (point.x < Math.min(u, u + w) || point.y < Math.min(v, v + h) || point.x >= Math.max(u, u + w) || point.y >= Math.max(v, v + h)) continue;
        const area = Math.abs(w * h) || 1;
        if (!best || (selected && !best.selected) || (selected === best.selected && area < best.area)) {
          best = { bone: bone.name, index, face, cube, selected, area };
        }
      }
    });
  }
  return best;
}

function axisMesh(dir, axis, part, mesh) {
  mesh.userData.axis = axis;
  mesh.userData.part = part;
  mesh.renderOrder = 1000;
  return mesh;
}

function buildGizmo(group) {
  const colors = [0xff5d5d, 0x6dcc6d, 0x6aa7ff];
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  dirs.forEach((dir, axis) => {
    const material = new THREE.MeshBasicMaterial({ color: colors[axis], depthTest: false, transparent: true, opacity: 0.95 });
    const move = new THREE.Group();
    move.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    move.userData.part = "move";
    const shaft = axisMesh(dir, axis, "move", new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.72, 6), material));
    const head = axisMesh(dir, axis, "move", new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 8), material));
    const hit = axisMesh(dir, axis, "move", new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.95, 8), new THREE.MeshBasicMaterial({ visible: false, depthTest: false })));
    shaft.position.y = 0.46;
    head.position.y = 0.9;
    hit.position.y = 0.5;
    move.add(shaft, head, hit);
    group.add(move);
    const ringTurn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    for (const mesh of [
      new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.02, 8, 40), material.clone()),
      new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.08, 6, 28), new THREE.MeshBasicMaterial({ visible: false, depthTest: false })),
    ]) {
      mesh.quaternion.copy(ringTurn);
      group.add(axisMesh(dir, axis, "rotate", mesh));
    }
    const box = axisMesh(dir, axis, "scale", new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), material.clone()));
    const scaleHit = axisMesh(dir, axis, "scale", new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), new THREE.MeshBasicMaterial({ visible: false, depthTest: false })));
    const scaleArm = new THREE.Group();
    scaleArm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    scaleArm.userData.part = "scale";
    const scaleShaft = axisMesh(dir, axis, "scale", new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.72, 6), material.clone()));
    scaleShaft.position.y = 0.4;
    scaleArm.add(scaleShaft);
    group.add(scaleArm);
    box.position.copy(dir).multiplyScalar(0.9);
    scaleHit.position.copy(box.position);
    group.add(box, scaleHit);
  });
}

function attachLocators(model, built) {
  const hidden = new Set(model.hidden || []);
  const locators = [];
  for (const bone of model.bones || []) {
    if (!bone?.locators || hidden.has(bone.name)) continue;
    const parent = built.groups.get(String(bone.name).toLowerCase());
    if (!parent) continue;
    for (const [name, locator] of Object.entries(bone.locators)) {
      const offset = Array.isArray(locator) ? locator : locator?.offset;
      if (!Array.isArray(offset)) continue;
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), new THREE.MeshBasicMaterial({ color: 0x8eb6ff, depthTest: false, transparent: true, opacity: 0.95 }));
      mesh.position.set(Number(offset[0]) / 16 || 0, Number(offset[1]) / 16 || 0, Number(offset[2]) / 16 || 0);
      const rotation = Array.isArray(locator) ? null : locator.rotation;
      if (Array.isArray(rotation)) {
        mesh.rotation.order = "ZYX";
        mesh.rotation.set(THREE.MathUtils.degToRad(rotation[0] || 0), THREE.MathUtils.degToRad(rotation[1] || 0), THREE.MathUtils.degToRad(rotation[2] || 0));
      }
      mesh.userData.locatorKey = bone.name + ":" + name;
      mesh.renderOrder = 4;
      parent.add(mesh);
      locators.push(mesh);
    }
  }
  built.locators = locators;
}

function disposeLocators(built) {
  for (const mesh of built?.locators || []) { mesh.geometry.dispose(); mesh.material.dispose(); }
}

export function ModelViewport({ viewSession, onViewSession, ...props }) {
  const [quad, setQuad] = useState(viewSession.quad);
  const [loaded, setLoaded] = useState(viewSession.quad);
  const [active, setActive] = useState(viewSession.active);
  const [views, setViews] = useState(viewSession.slots.map(slot => slot.view));
  const slots = useRef(viewSession.slots);
  const quadRef = useRef(viewSession.quad);
  const activeRef = useRef(viewSession.active);
  const commands = useRef({});
  const commit = (nextQuad = quadRef.current, nextActive = activeRef.current) => {
    quadRef.current = nextQuad;
    activeRef.current = nextActive;
    onViewSession?.({ quad: nextQuad, active: nextActive, slots: slots.current });
  };
  const chooseLayout = value => { const next = value === "quad"; setQuad(next); if (next) setLoaded(true); commit(next, activeRef.current); };
  const chooseView = (index, view) => { setActive(index); activeRef.current = index; setViews(current => current.map((item, itemIndex) => itemIndex === index ? view : item)); };
  const rememberPose = (index, pose) => { slots.current = slots.current.map((slot, itemIndex) => itemIndex === index ? pose : slot); commit(); };
  return <section className="model-panel model-stage" aria-label="模型预览">
    <div className="model-stage-tools">
      <Button onClick={() => commands.current[active]?.focus()}>聚焦</Button>
      <Button onClick={() => commands.current[active]?.reset()}>重置视角</Button>
      <Select aria-label="预览布局" value={quad ? "quad" : "single"} options={[{ value: "single", label: "单视图" }, { value: "quad", label: "四视图" }]} onChange={chooseLayout} />
    </div>
    <div className={"model-view-grid" + (quad ? " quad" : "")}>
      {(loaded ? [1, 0, 2, 3] : [0]).map(index => <Viewport key={index} {...props} view={views[index]} active={active === index} hidden={!quad && active !== index}
        slot={slots.current[index]} onPose={pose => rememberPose(index, pose)}
        onActivate={() => { setActive(index); activeRef.current = index; commit(); }} onView={view => chooseView(index, view)}
        onMaximize={quad ? () => { setActive(index); setQuad(false); } : null} commands={commands} index={index} />)}
    </div>
  </section>;
}

function Viewport({ model, frameKey, selectedKey, selectedKeys = [], boneName, uvFace = "", textureUrl, materialUrls, tool, desk, clip, time, snapPoint, vertexPoints, vertexSource, onVertexPick, onPick, onMarquee, onPickLocator, onPickMesh, onTransform, onPaint, locatorKey = "", displayPose = null, view, slot = null, onPose, active, hidden, onActivate, onView, onMaximize, commands, index, vertexGesture = "move" }) {
  const slotRef = useRef(slot);
  const onPoseRef = useRef(onPose);
  const viewRef = useRef(view);
  slotRef.current = slot;
  onPoseRef.current = onPose;
  viewRef.current = view;
  const host = useRef(null);
  const canvas = useRef(null);
  const state = useRef({});
  const [marquee, setMarquee] = useState(null);
  useEffect(() => {
    const renderer = new THREE.WebGLRenderer({ canvas: canvas.current, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const scene = new THREE.Scene();
    let camera = createViewCamera(view);
    let controls = new OrbitControls(camera, canvas.current);
    controls.enableDamping = true;
    const publish = () => onPoseRef.current?.(readViewPose(camera, controls, viewRef.current));
    const bindEnd = item => item.addEventListener("end", publish);
    bindEnd(controls);
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xfff4e5, 1.25);
    sun.position.set(4, 6, 3);
    scene.add(sun);
    const grid = new THREE.GridHelper(4, 16, 0x31405c, 0x243044);
    scene.add(grid);
    const themeGrid = () => {
      const style = getComputedStyle(host.current);
      const themed = new THREE.GridHelper(4, 16, style.getPropertyValue("--muted").trim(), style.getPropertyValue("--line").trim());
      grid.geometry.dispose(); grid.geometry = themed.geometry; themed.material.dispose();
    };
    themeGrid();
    const themeObserver = new MutationObserver(themeGrid);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const modelRoot = new THREE.Group();
    const gizmo = new THREE.Group();
    buildGizmo(gizmo);
    scene.add(modelRoot, gizmo);
    const snapMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshBasicMaterial({ color: 0x55d99b, depthTest: false }));
    snapMarker.renderOrder = 1001; snapMarker.visible = false; scene.add(snapMarker);
    const vertexDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x8eb6ff, size: 8, sizeAttenuation: false, depthTest: false }));
    vertexDots.renderOrder = 1002; vertexDots.frustumCulled = false; vertexDots.visible = false; scene.add(vertexDots);
    const hoverMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    hoverMarker.renderOrder = 1003; hoverMarker.visible = false; scene.add(hoverMarker);
    let vertexHover = null;
    const accent = new THREE.Color("#8eb6ff");
    const base = new THREE.Color("#d5dbe6");
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const ndcOf = (event) => {
      const rect = canvas.current.getBoundingClientRect();
      return { x: ((event.clientX - rect.left) / rect.width) * 2 - 1, y: -((event.clientY - rect.top) / rect.height) * 2 + 1 };
    };
    let drag = null;
    const pointPick = event => {
      const rect = canvas.current.getBoundingClientRect();
      camera.updateMatrixWorld();
      return pickProjectedVertex(state.current.vertexPoints, camera, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    };
    const paintPoint = event => {
      const rect = canvas.current.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return null;
      const point = ndcOf(event);
      pointer.set(point.x, point.y);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(state.current.built?.meshes || [], false)[0];
      if (!hit?.uv || hit.uv.x < 0 || hit.uv.y < 0 || hit.uv.x > 1 || hit.uv.y > 1) return null;
      return { u: hit.uv.x, v: hit.uv.y, textureKey: [].concat(hit.object.material)[hit.face.materialIndex]?.userData.textureKey || "", surface: hit.object.userData.cubeKey + ":" + Math.floor(hit.faceIndex / 2), newSelection: event.shiftKey };
    };
    const onDown = (event) => {
      if (event.button !== 0 || event.altKey) return;
      if (state.current.desk === "edit" && state.current.vertexPoints !== null && state.current.tool !== "vertex") {
        event.preventDefault(); event.stopImmediatePropagation(); canvas.current.focus();
        const vertex = pointPick(event); if (vertex) state.current.onVertexPick?.(vertex, event.ctrlKey || event.metaKey);
        return;
      }
      if (state.current.desk === "paint" && state.current.onPaint) {
        const point = paintPoint(event);
        if (point && state.current.onPaint(point, "down")) {
          controls.enabled = false;
          event.stopPropagation(); event.preventDefault();
          canvas.current.setPointerCapture(event.pointerId);
          drag = { paint: true, pointer: event.pointerId };
        }
        return;
      }
      const point = ndcOf(event);
      pointer.set(point.x, point.y);
      raycaster.setFromCamera(pointer, camera);
      const anchor = state.current.anchor?.();
      const part = state.current.tool === "pivot" ? "move" : state.current.tool === "vertex" ? (state.current.vertexGesture || "move") : state.current.tool || "move";
      const handle = gizmo.visible && raycaster.intersectObjects(gizmo.children, true).find(item => {
        const axis = item.object.userData.axis;
        if (!Number.isInteger(axis) || item.object.userData.part !== part) return false;
        if (!camera.isOrthographicCamera || part === "rotate") return true;
        const direction = new THREE.Vector3().setComponent(axis, 1).applyQuaternion(gizmo.quaternion);
        return Math.abs(direction.dot(camera.getWorldDirection(new THREE.Vector3()))) < 0.999;
      });
      if (handle && anchor && state.current.desk === "edit") {
        if (state.current.onTransform?.(state.current.tool, [0, 0, 0], "start") === false) { event.preventDefault(); event.stopPropagation(); return; }
        controls.enabled = false;
        event.stopPropagation();
        event.preventDefault();
        canvas.current.setPointerCapture(event.pointerId);
        drag = { pointer: event.pointerId, tool: state.current.tool, vertexGesture: state.current.vertexGesture || "move", axis: handle.object.userData.axis, start: point, origin: anchor.getWorldPosition(new THREE.Vector3()), quat: anchor.getWorldQuaternion(new THREE.Quaternion()) };
        return;
      }
      if (state.current.tool === "vertex" && state.current.vertexPoints) {
        const vertex = pointPick(event);
        if (vertex) { event.preventDefault(); event.stopPropagation(); canvas.current.focus(); state.current.onVertexPick?.(vertex, event.ctrlKey || event.metaKey); return; }
      }
      const targets = state.current.desk === "paint" ? (state.current.built?.meshes || []) : [...(state.current.built?.meshes || []), ...(state.current.built?.locators || [])];
      const hit = raycaster.intersectObjects(targets, false).find(item => state.current.desk !== "edit" || (item.object.visible && [].concat(item.object.material)[item.face?.materialIndex || 0]?.visible !== false));
      const locatorHit = hit?.object.userData.locatorKey || "";
      if (locatorHit) {
        const locatorSplit = locatorHit.lastIndexOf(":");
        if (locatorSplit > 0) state.current.onPickLocator?.(locatorHit.slice(0, locatorSplit), locatorHit.slice(locatorSplit + 1));
        return;
      }
      const key = hit?.object.userData.cubeKey || "";
      if (key.endsWith(":mesh")) { state.current.onPickMesh?.(key.slice(0, -5)); return; }
      const split = key.lastIndexOf(":");
      if (split > 0) state.current.onPick?.(key.slice(0, split), Number(key.slice(split + 1)), state.current.desk === "edit" ? faceNames[hit.face?.materialIndex] || "" : "", event.ctrlKey || event.metaKey);
      else if (state.current.desk === "edit" && state.current.onMarquee) {
        event.preventDefault(); event.stopPropagation(); controls.enabled = false; canvas.current.setPointerCapture(event.pointerId);
        drag = { marquee: true, pointer: event.pointerId, x: event.clientX, y: event.clientY, additive: event.ctrlKey || event.metaKey };
        setMarquee({ x: event.clientX, y: event.clientY, w: 0, h: 0 });
      }
    };
    const onMove = (event) => {
      if (!drag && state.current.desk === "edit" && state.current.vertexPoints !== null) {
        const rect = canvas.current.getBoundingClientRect();
        vertexHover = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom ? pointPick(event) : null;
      }
      if (!drag) return;
      if (drag.marquee) {
        setMarquee({ x: drag.x, y: drag.y, w: event.clientX - drag.x, h: event.clientY - drag.y });
        return;
      }
      if (drag.paint) {
        state.current.onPaint?.(paintPoint(event), "move");
        return;
      }
      const now = ndcOf(event);
      const rect = canvas.current.getBoundingClientRect();
      const dir = new THREE.Vector3(drag.axis === 0 ? 1 : 0, drag.axis === 1 ? 1 : 0, drag.axis === 2 ? 1 : 0).applyQuaternion(drag.quat).normalize();
      const projectedStart = drag.origin.clone().project(camera);
      const projectedEnd = drag.origin.clone().add(dir).project(camera);
      const halfW = rect.width / 2;
      const halfH = rect.height / 2;
      const ax = (projectedEnd.x - projectedStart.x) * halfW;
      const ay = (projectedEnd.y - projectedStart.y) * halfH;
      const mx = (now.x - drag.start.x) * halfW;
      const my = (now.y - drag.start.y) * halfH;
      const span = Math.hypot(ax, ay);
      const delta = [0, 0, 0];
      const gesture = drag.tool === "pivot" ? "move" : drag.tool === "vertex" ? (drag.vertexGesture || "move") : (drag.tool || "move");
      const spin = drag.tool === "vertex" ? 1 : (state.current.rotateSign || 1);
      if (gesture === "rotate" && span < 2) {
        const from = Math.atan2((drag.start.y - projectedStart.y) * halfH, (drag.start.x - projectedStart.x) * halfW);
        const to = Math.atan2((now.y - projectedStart.y) * halfH, (now.x - projectedStart.x) * halfW);
        const angle = Math.atan2(Math.sin(to - from), Math.cos(to - from));
        delta[drag.axis] = THREE.MathUtils.radToDeg(angle) * -Math.sign(dir.dot(camera.getWorldDirection(new THREE.Vector3()))) * spin;
      } else if (span >= 2) {
        if (gesture === "rotate") delta[drag.axis] = (mx * (-ay / span) + my * (ax / span)) * 0.45 * spin;
        else {
          const amount = (mx * ax + my * ay) / (span * span) * 16;
          if (gesture === "move") { delta[0] = dir.x * amount; delta[1] = dir.y * amount; delta[2] = dir.z * amount; }
          else delta[drag.axis] = amount;
        }
      }
      if (state.current.locatorKey && gesture !== "rotate") {
        const marker = state.current.built?.locators?.find(item => item.userData.locatorKey === state.current.locatorKey);
        const parentQuat = marker?.parent?.getWorldQuaternion(new THREE.Quaternion()) || drag.quat;
        const local = new THREE.Vector3(delta[0], delta[1], delta[2]).applyQuaternion(parentQuat.clone().invert());
        delta[0] = local.x; delta[1] = local.y; delta[2] = local.z;
      }
      if (drag.tool === "vertex" && gesture === "move") {
        const local = new THREE.Vector3(delta[0], delta[1], delta[2]).applyQuaternion(drag.quat.clone().invert());
        delta[0] = local.x; delta[1] = local.y; delta[2] = local.z;
      }
      state.current.onTransform?.(drag.tool, delta, "drag");
    };
    const onUp = event => {
      if (!drag) return;
      if (drag.marquee) {
        const mark = drag; drag = null; controls.enabled = true; setMarquee(null);
        const rect = canvas.current.getBoundingClientRect();
        const left = Math.min(mark.x, event.clientX) - rect.left, right = Math.max(mark.x, event.clientX) - rect.left;
        const top = Math.min(mark.y, event.clientY) - rect.top, bottom = Math.max(mark.y, event.clientY) - rect.top;
        const keys = [];
        for (const mesh of state.current.built?.meshes || []) {
          mesh.geometry.computeBoundingBox();
          const box = new THREE.Box3().setFromObject(mesh), points = [];
          for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
            const point = new THREE.Vector3(x, y, z).project(camera);
            points.push({ x: (point.x + 1) * rect.width / 2, y: (1 - point.y) * rect.height / 2 });
          }
          const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
          const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
          if (!String(mesh.userData.cubeKey || "").endsWith(":mesh") && maxX >= left && minX <= right && maxY >= top && minY <= bottom) keys.push(mesh.userData.cubeKey);
        }
        state.current.onMarquee?.(keys, mark.additive);
        if (canvas.current.hasPointerCapture(mark.pointer)) canvas.current.releasePointerCapture(mark.pointer);
        return;
      }
      const painting = drag.paint;
      const pointerId = drag.pointer;
      const usedTool = drag.tool;
      drag = null;
      controls.enabled = true;
      if (painting) {
        state.current.onPaint?.(event ? paintPoint(event) : null, "up");
        if (canvas.current.hasPointerCapture(pointerId)) canvas.current.releasePointerCapture(pointerId);
        return;
      }
      state.current.onTransform?.(usedTool, [0, 0, 0], "end");
      if (canvas.current.hasPointerCapture(pointerId)) canvas.current.releasePointerCapture(pointerId);
    };
    const cancelPaint = event => {
      if (!drag) return;
      if (event?.type === "pointercancel") event.stopImmediatePropagation();
      const pointerId = drag.pointer;
      const painting = drag.paint, usedTool = drag.tool;
      const marquee = drag.marquee;
      drag = null; controls.enabled = true;
      if (marquee) { setMarquee(null); if (canvas.current.hasPointerCapture(pointerId)) canvas.current.releasePointerCapture(pointerId); return; }
      if (painting) state.current.onPaint?.(null, "cancel");
      else state.current.onTransform?.(usedTool, [0, 0, 0], "cancel");
      if (canvas.current.hasPointerCapture(pointerId)) canvas.current.releasePointerCapture(pointerId);
    };
    const escape = event => { if (event.key === "Escape" && drag) { event.preventDefault(); cancelPaint(); } };
    const frameTarget = (target) => {
      const box = new THREE.Box3().setFromObject(target);
      frameViewCamera(camera, controls, box, host.current.clientWidth, host.current.clientHeight);
    };
    const setView = value => {
      cancelPaint();
      controls.removeEventListener("end", publish);
      camera = createViewCamera(value);
      controls.dispose();
      controls = new OrbitControls(camera, canvas.current);
      controls.enableDamping = true;
      bindEnd(controls);
      controls.enableRotate = camera.isPerspectiveCamera;
      controls.screenSpacePanning = true;
      controls.mouseButtons.LEFT = camera.isPerspectiveCamera ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
      grid.rotation.set(0, 0, 0);
      if (["south", "north"].includes(value)) grid.rotation.x = Math.PI / 2;
      if (["east", "west"].includes(value)) grid.rotation.z = Math.PI / 2;
      state.current.camera = camera;
      state.current.controls = controls;
      if (state.current.built) frameTarget(state.current.built.root);
      publish();
    };
    const paintSelection = () => {
      for (const mesh of state.current.built?.meshes || []) {
        const selected = (state.current.selectedKeys || []).includes(mesh.userData.cubeKey) || mesh.userData.cubeKey === state.current.selectedKey;
        for (const material of [].concat(mesh.material)) {
          material.map = material.userData.textureKey ? state.current.materialMaps?.[material.userData.textureKey] || null : state.current.map || null;
          material.color.copy(material.map ? new THREE.Color("#ffffff") : selected ? accent : base);
          material.emissive = new THREE.Color(selected ? "#243056" : "#000000");
          material.needsUpdate = true;
        }
      }
    };
    state.current = { ...state.current, camera, controls, modelRoot, gizmo, frameTarget, paintSelection, setView, publishPose: publish, applyPose: saved => applyViewPose(camera, controls, saved, host.current?.clientWidth || 320, host.current?.clientHeight || 520), setVertexPoints: (points, source) => {
      vertexDots.geometry.dispose(); vertexDots.geometry = new THREE.BufferGeometry();
      vertexDots.geometry.setAttribute("position", new THREE.Float32BufferAttribute((points || []).flatMap(vertex => vertex.point.toArray().map(n => n / 16)), 3));
      const colored = (points || []).some(vertex => vertex.selected);
      if (colored) {
        vertexDots.geometry.setAttribute("color", new THREE.Float32BufferAttribute((points || []).flatMap(vertex => vertex.selected ? [1, 0.83, 0.42] : [0.56, 0.71, 1]), 3));
        vertexDots.material.vertexColors = true; vertexDots.material.color.setHex(0xffffff);
      } else { vertexDots.material.vertexColors = false; vertexDots.material.color.setHex(source ? 0x55d99b : 0x8eb6ff); }
      vertexHover = null;
    } };
    canvas.current.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.current.addEventListener("pointercancel", cancelPaint, true);
    canvas.current.addEventListener("lostpointercapture", cancelPaint);
    window.addEventListener("blur", cancelPaint);
    window.addEventListener("keydown", escape);
    const resize = () => {
      const width = host.current?.clientWidth || 320;
      const height = host.current?.clientHeight || 520;
      renderer.setSize(width, height, false);
      resizeViewCamera(camera, width, height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (host.current) observer.observe(host.current);
    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      if (!host.current?.clientWidth || !host.current?.clientHeight) return;
      const anchor = state.current.anchor?.();
      const pointPicking = state.current.desk === "edit" && state.current.vertexPoints !== null;
      const selectingVertex = pointPicking && state.current.tool !== "vertex";
      const shown = !!anchor && state.current.desk === "edit" && !selectingVertex;
      const markedPoint = state.current.vertexSource || state.current.snapPoint;
      snapMarker.visible = state.current.desk === "edit" && !!markedPoint && state.current.tool !== "vertex";
      if (snapMarker.visible) { snapMarker.position.fromArray(markedPoint).multiplyScalar(1 / 16); snapMarker.material.color.setHex(state.current.vertexSource ? 0xffd46a : 0x55d99b); snapMarker.scale.setScalar(camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom * 0.012 : camera.position.distanceTo(snapMarker.position) * 0.009); }
      vertexDots.visible = pointPicking;
      hoverMarker.visible = pointPicking && !!vertexHover;
      if (hoverMarker.visible) { hoverMarker.position.copy(vertexHover.point).multiplyScalar(1 / 16); hoverMarker.scale.setScalar(camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom * 0.014 : camera.position.distanceTo(hoverMarker.position) * 0.01); }
      gizmo.visible = shown;
      if (anchor) {
        anchor.getWorldPosition(gizmo.position);
        anchor.getWorldQuaternion(gizmo.quaternion);
        if (state.current.tool === "vertex" && state.current.vertexSource) gizmo.position.fromArray(state.current.vertexSource).multiplyScalar(1 / 16);
        gizmo.scale.setScalar(camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom / 3 : Math.max(camera.position.distanceTo(gizmo.position), 0.4) / 5);
      }
      const shownTool = state.current.tool === "pivot" ? "move" : state.current.tool === "vertex" ? (state.current.vertexGesture || "move") : (state.current.tool || "move");
      gizmo.traverse(obj => { if (obj.userData?.part) obj.visible = shown && obj.userData.part === shownTool; });
      const viewW = host.current?.clientWidth || 0;
      const viewH = host.current?.clientHeight || 0;
      if (viewW > 1 && viewH > 1 && (viewW !== state.current.viewW || viewH !== state.current.viewH)) {
        state.current.viewW = viewW;
        state.current.viewH = viewH;
        renderer.setSize(viewW, viewH, false);
        resizeViewCamera(camera, viewW, viewH);
      }
      if (state.current.built?.groups) applyClip(state.current.built.groups, state.current.clip, state.current.time || 0);
      const pose = state.current.displayPose;
      modelRoot.position.set((pose?.translation?.[0] || 0) / 16, (pose?.translation?.[1] || 0) / 16, (pose?.translation?.[2] || 0) / 16);
      modelRoot.rotation.order = "XYZ";
      modelRoot.rotation.set(THREE.MathUtils.degToRad(pose?.rotation?.[0] || 0), THREE.MathUtils.degToRad(pose?.rotation?.[1] || 0), THREE.MathUtils.degToRad(pose?.rotation?.[2] || 0));
      modelRoot.scale.set(pose?.scale?.[0] || 1, pose?.scale?.[1] || 1, pose?.scale?.[2] || 1);
      for (const marker of state.current.built?.locators || []) {
        const selected = marker.userData.locatorKey === state.current.locatorKey;
        marker.visible = state.current.desk === "edit";
        marker.material.color.setHex(selected ? 0xffd46a : 0x8eb6ff);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
    return () => {
      cancelAnimationFrame(frame);
      canvas.current?.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.current?.removeEventListener("pointercancel", cancelPaint, true);
      canvas.current?.removeEventListener("lostpointercapture", cancelPaint);
      window.removeEventListener("blur", cancelPaint);
      window.removeEventListener("keydown", escape);
      observer.disconnect();
      themeObserver.disconnect();
      controls.dispose();
      gizmo.traverse(obj => { obj.geometry?.dispose(); obj.material?.dispose?.(); });
      grid.geometry.dispose(); grid.material.dispose();
      snapMarker.geometry.dispose(); snapMarker.material.dispose();
      vertexDots.geometry.dispose(); vertexDots.material.dispose(); hoverMarker.geometry.dispose(); hoverMarker.material.dispose();
      for (const mesh of state.current.built?.meshes || []) { mesh.geometry.dispose(); for (const material of [].concat(mesh.material)) material.dispose(); }
      disposeLocators(state.current.built);
      state.current.map?.dispose();
      for (const texture of Object.values(state.current.materialMaps || {})) texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, []);
  useEffect(() => {
    state.current.vertexPoints = vertexPoints ?? null; state.current.vertexSource = vertexSource;
    state.current.setVertexPoints?.(vertexPoints, vertexSource);
  }, [vertexPoints, vertexSource]);
  useEffect(() => {
    const root = state.current.modelRoot;
    if (!root || !model) return undefined;
    if (state.current.built) {
      root.remove(state.current.built.root);
      for (const mesh of state.current.built.meshes) { mesh.geometry.dispose(); for (const material of [].concat(mesh.material)) material.dispose(); }
      disposeLocators(state.current.built);
    }
    const built = buildModel(model);
    attachLocators(model, built);
    root.add(built.root);
    state.current.built = built;
    if (state.current.seenFrame !== frameKey && state.current.camera) {
      if (state.current.seenFrame == null && slotRef.current?.view === view && slotRef.current.custom) state.current.applyPose?.(slotRef.current);
      else state.current.setView(view);
      state.current.seenFrame = frameKey;
    }
    state.current.paintSelection?.();
    return undefined;
  }, [model, frameKey]);
  useEffect(() => {
    const saved = slotRef.current;
    if (saved?.view === view && saved.custom) state.current.applyPose?.(saved);
    else state.current.setView?.(view);
  }, [view]);
  useEffect(() => {
    let live = true;
    if (!textureUrl) { state.current.map?.dispose(); state.current.map = null; state.current.paintSelection?.(); return undefined; }
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      const texture = new THREE.Texture(image);
      texture.flipY = false;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      state.current.map?.dispose();
      state.current.map = texture;
      state.current.paintSelection?.();
    };
    image.src = textureUrl;
    return () => { live = false; };
  }, [textureUrl]);
  useEffect(() => {
    let alive = true;
    const maps = {};
    state.current.materialMaps = maps;
    state.current.paintSelection?.();
    for (const [key, source] of Object.entries(materialUrls || {})) {
      const image = new Image();
      image.onload = () => {
        if (!alive) return;
        const texture = new THREE.Texture(image);
        texture.flipY = false; texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
        maps[key] = texture; state.current.paintSelection?.();
      };
      image.src = source;
    }
    return () => { alive = false; for (const texture of Object.values(maps)) texture.dispose(); };
  }, [materialUrls]);
  useEffect(() => {
    state.current.selectedKey = selectedKey;
    state.current.selectedKeys = selectedKeys;
    state.current.boneName = boneName;
    state.current.uvFace = uvFace;
    state.current.onPick = onPick;
    state.current.onMarquee = onMarquee;
    state.current.onTransform = onTransform;
    state.current.onVertexPick = onVertexPick;
    state.current.tool = tool;
    state.current.vertexGesture = vertexGesture;
    state.current.desk = desk;
    state.current.onPaint = onPaint;
    state.current.clip = clip;
    state.current.time = time;
    state.current.snapPoint = snapPoint;
    state.current.rotateSign = selectedKey ? -1 : 1;
    state.current.locatorKey = locatorKey;
    state.current.onPickLocator = onPickLocator;
    state.current.onPickMesh = onPickMesh;
    state.current.displayPose = displayPose;
    state.current.anchor = () => {
      const built = state.current.built;
      if (!built) return null;
      if (state.current.locatorKey) {
        const marker = built.locators?.find(item => item.userData.locatorKey === state.current.locatorKey);
        if (marker) return marker;
      }
      if (selectedKey) {
        const mesh = built.meshes.find(item => item.userData.cubeKey === selectedKey);
        if (mesh?.parent) return mesh.parent;
      }
      return boneName ? built.groups.get(boneName.toLowerCase()) || null : null;
    };
    state.current.paintSelection?.();
  });
  const focus = () => {
    const current = state.current;
    const selected = (current.built?.meshes || []).filter(mesh => (current.selectedKeys || []).includes(mesh.userData.cubeKey) || mesh.userData.cubeKey === current.selectedKey);
    if (selected.length > 1 && current.camera && current.controls) {
      const box = new THREE.Box3(); selected.forEach(mesh => box.expandByObject(mesh));
      frameViewCamera(current.camera, current.controls, box, host.current?.clientWidth || 320, host.current?.clientHeight || 520);
    } else {
      const target = selected[0] || current.built?.root;
      if (target) current.frameTarget?.(target);
    }
    current.publishPose?.();
  };
  const reset = () => {
    state.current.setView(view);
  };
  commands.current[index] = { focus, reset };
  return <div className={"model-view-cell" + (active ? " active" : "")} hidden={hidden} onPointerDownCapture={onActivate} onFocusCapture={onActivate} data-view={view}>
    <div className="model-view-head">
      <Select aria-label="视角" title={viewPresets.find(item => item.value === view).label} value={view} options={viewPresets} onChange={onView} />
      {onMaximize && <Button icon="monitor" compact onClick={onMaximize}>最大化此视图</Button>}
    </div>
    <div className="model-view-canvas" ref={host}><canvas ref={canvas} tabIndex={0} aria-label={viewPresets.find(item => item.value === view).label + "模型画布"} />{marquee && <div className="model-marquee" style={{ left: Math.min(marquee.x, marquee.x + marquee.w) - (host.current?.getBoundingClientRect().left || 0), top: Math.min(marquee.y, marquee.y + marquee.h) - (host.current?.getBoundingClientRect().top || 0), width: Math.abs(marquee.w), height: Math.abs(marquee.h) }} />}</div>
  </div>;
}

export function TextureDesk({ role = "edit", geometryPath, worldId, textureWidth, textureHeight, onTextureSize, bones, picked, onPick, onUv, onUvEnd, onPack, onExportPacked, onPreview, onMaterialPreview, onAssignMaterial, materialCount = 0, onFace, uvFace, paintActions, solid, onSolid }) {
  const view = useRef(null);
  const bitmap = useRef(null);
  const layersRef = useRef([]), activeLayer = useRef(0), editTarget = useRef("image"), diskRevision = useRef("");
  const layout = useRef({ ox: 0, oy: 0, scale: 1 });
  const drag = useRef(null);
  const rectBase = useRef(null);
  const live = useRef({});
  const [textures, setTextures] = useState([]);
  const [materialSources, setMaterialSources] = useState({});
  const [materialError, setMaterialError] = useState("");
  const [current, setCurrent] = useState("");
  const currentRelative = textures.find(item => item.path === current)?.relative || "";
  const paintBones = useMemo(() => paintBonesForTexture(bones, currentRelative), [bones, currentRelative]);
  const [color, setColor] = useState("#ffffff");
  const [maskValue, setMaskValue] = useState(0);
  const [opacity, setOpacity] = useState(255);
  const [textureName, setTextureName] = useState("texture");
  const [brush, setBrush] = useState(1);
  const [transformDraft, setTransformDraft] = useState(null);
  const [paintTool, setPaintTool] = useState("brush");
  const [outline, setOutline] = useState(false);
  const [mirrorPaint, setMirrorPaint] = useState(false);
  const [selection, setSelectionState] = useState(null);
  const selectionRef = useRef(null);
  function setSelection(value) { selectionRef.current = value; setSelectionState(value); }
  const [clipReady, setClipReady] = useState(false);
  const clipboard = useRef(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uvDialog, setUvDialog] = useState("");
  const [uvTexture, setUvTexture] = useState(null);
  const [uvLoading, setUvLoading] = useState(false);
  const uvContext = useRef(""), uvPending = useRef(false);
  useEffect(() => () => { uvContext.current = ""; }, []);
  const listGen = useRef(0);
  const strokes = useRef([]);
  const strokeAt = useRef(0);
  const savedStroke = useRef(0);
  const paintGen = useRef(0);
  const restoring = useRef(false);
  const [strokePast, setStrokePast] = useState(0);
  const [strokeFuture, setStrokeFuture] = useState(0);
  const maskEditing = editTarget.current === "mask" && !!layersRef.current[activeLayer.current]?.mask;
  const inkColor = maskEditing ? "#" + maskValue.toString(16).padStart(2, "0").repeat(3) : color;
  live.current = { role, color: inkColor, opacity, brush, paintTool, outline, mirrorPaint, bones, paintBones, picked, current, onPick, onFace, uvFace, onUv, onUvEnd, onPreview };

  useEffect(() => {
    if (role !== "paint") return undefined;
    const cancel = event => live.current.selectionKey?.(event);
    const blur = () => live.current.cancelPaint?.();
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", cancel); window.removeEventListener("blur", blur); };
  }, [role]);

  function blank() {
    const board = document.createElement("canvas");
    board.width = Math.max(1, textureWidth || 64);
    board.height = Math.max(1, textureHeight || 64);
    const ctx = board.getContext("2d");
    ctx.fillStyle = "#1b212c";
    ctx.fillRect(0, 0, board.width, board.height);
    bitmap.current = board;
    layersRef.current = [{ name: "背景", visible: true, locked: false, opacity: 100, canvas: board }]; activeLayer.current = 0; editTarget.current = "image";
    setSelection(null);
    setDirty(false);
    setRevision(value => value + 1);
    onPreview?.("");
    seedStrokes(board);
  }

  function seedStrokes(board) {
    const document = serializeLayers(layersRef.current, activeLayer.current, editTarget.current), key = JSON.stringify(document.layers);
    strokes.current = [{ document, key, selection: null }];
    strokeAt.current = 0;
    savedStroke.current = key;
    setStrokePast(0);
    setStrokeFuture(0);
  }

  function publishPreview() {
    const board = flattenLayers(layersRef.current);
    live.current.onPreview?.(board ? board.toDataURL("image/png") : "");
  }
  const binding = (() => { try { return { paths: assignedTextures(bones), error: "" }; } catch (reason) { return { paths: [], error: reason.message }; } })();
  const bindingKey = JSON.stringify(binding.paths);
  uvContext.current = JSON.stringify([geometryPath, worldId, bindingKey, current, textureWidth, textureHeight, revision]);
  useEffect(() => {
    let alive = true;
    setMaterialSources({}); setMaterialError(binding.error);
    const paths = JSON.parse(bindingKey);
    if (binding.error) return () => { alive = false; };
    if (paths.length * textureWidth * textureHeight > 16 * 1024 * 1024) { setMaterialError("面贴图总像素超过 1600 万限制"); return () => { alive = false; }; }
    Promise.all(paths.map(async relative => {
      const item = textures.find(texture => texture.relative === relative);
      if (!item) throw Error("缺少面贴图：" + relative);
      const value = await call("content.read-texture", { path: item.path, worldId });
      const restored = await restoreLayers(value.layers, value.dataUrl), board = flattenLayers(restored.layers);
      if (board.width !== textureWidth || board.height !== textureHeight) throw Error("面贴图尺寸必须与模型 UV 分辨率一致：" + relative);
      return [relative, board.toDataURL("image/png")];
    })).then(entries => { if (alive) setMaterialSources(Object.fromEntries(entries)); }).catch(reason => { if (alive) setMaterialError(reason.message); });
    return () => { alive = false; };
  }, [bindingKey, binding.error, textures, textureWidth, textureHeight, worldId, current, reload]);
  useEffect(() => {
    const urls = { ...materialSources };
    if (currentRelative && JSON.parse(bindingKey).includes(currentRelative) && bitmap.current) urls[currentRelative] = flattenLayers(layersRef.current).toDataURL("image/png");
    onMaterialPreview?.(urls);
  }, [materialSources, currentRelative, revision, bindingKey]);
  const assignCurrentTexture = () => {
    if (layerBusy()) return;
    try {
      if (!currentRelative) throw Error("只能分配模型目录内的贴图");
      if (bitmap.current.width !== textureWidth || bitmap.current.height !== textureHeight) throw Error("面贴图尺寸必须与模型 UV 分辨率一致");
      onAssignMaterial(currentRelative, uvFace);
      setError("");
    } catch (reason) { setError(reason.message); }
  };

  function editableLayer() {
    const layer = layersRef.current[activeLayer.current];
    if (!layer || layer.locked || !layer.visible) { setError("当前图层已锁定或隐藏，请先解锁或显示"); return false; }
    return true;
  }

  function layerBusy() {
    return !current || !bitmap.current || saving || restoring.current || !!drag.current || uvLoading;
  }

  function syncLayerTarget(target = editTarget.current) {
    const layer = layersRef.current[activeLayer.current];
    editTarget.current = target === "mask" && layer?.mask ? "mask" : "image";
    bitmap.current = editTarget.current === "mask" ? layer.mask.canvas : layer?.canvas || null;
  }

  function selectLayerTarget(target) {
    if (layerBusy()) return;
    syncLayerTarget(target); setSelection(null); rememberSelection(); setRevision(value => value + 1); setError("");
  }

  function selectLayer(index) {
    if (layerBusy()) return;
    activeLayer.current = index; syncLayerTarget("image");
    setSelection(null); rememberSelection(); setRevision(value => value + 1); setError("");
  }

  function changeLayer(operation, value, index = activeLayer.current) {
    if (layerBusy()) return;
    try {
      const layers = layersRef.current.slice(), layer = layers[index];
      if (!layer) return;
      const width = layer.canvas.width, height = layer.canvas.height;
      let nextActive = activeLayer.current, nextTarget = editTarget.current;
      const images = layers.reduce((sum, item) => sum + 1 + (item.mask ? 1 : 0), 0);
      if (["add", "duplicate"].includes(operation)) {
        if (layers.length >= MAX_LAYERS || (images + 1 + (operation === "duplicate" && layer.mask ? 1 : 0)) * width * height > MAX_PIXELS) throw Error("最多 16 层，图层和蒙版总像素不超过 1600 万");
        const canvas = layerCanvas(width, height);
        if (operation === "duplicate") canvas.getContext("2d").drawImage(layer.canvas, 0, 0);
        let mask;
        if (operation === "duplicate" && layer.mask) { const canvas = layerCanvas(width, height); canvas.getContext("2d").drawImage(layer.mask.canvas, 0, 0); mask = { enabled: layer.mask.enabled, canvas }; }
        layers.splice(index + 1, 0, { name: operation === "duplicate" ? layer.name.slice(0, 60) + " 副本" : "图层 " + layers.length, visible: true, locked: false, opacity: operation === "duplicate" ? layer.opacity : 100, blendMode: operation === "duplicate" ? layerBlendMode(layer) : "normal", canvas, ...(mask ? { mask } : {}) });
        nextActive = index + 1;
        nextTarget = "image";
      } else if (operation === "delete") {
        if (layers.length < 2 || layer.locked) throw Error("不能删除最后一层或锁定图层");
        layers.splice(index, 1); nextActive = Math.min(index, layers.length - 1);
      } else if (["up", "down"].includes(operation)) {
        const target = index + (operation === "up" ? 1 : -1);
        if (!layers[target]) return;
        [layers[index], layers[target]] = [layers[target], layer]; nextActive = target;
      } else if (operation === "merge") {
        const merged = mergeLayerDown(layers, index);
        layers.splice(index - 1, 2, merged); nextActive = index - 1;
        nextTarget = "image";
      } else if (operation.startsWith("mask")) {
        if (layer.locked) throw Error("当前图层已锁定，请先解锁");
        if (operation === "maskAdd") {
          if (layer.mask) return;
          if ((images + 1) * width * height > MAX_PIXELS) throw Error("图层和蒙版总像素超过 1600 万限制");
          const canvas = layerCanvas(width, height), context = canvas.getContext("2d"); context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height);
          layers[index] = { ...layer, mask: { enabled: true, canvas } }; nextTarget = "mask";
        } else {
          if (!layer.mask) throw Error("当前图层没有蒙版");
          if (operation === "maskDelete" || operation === "maskApply") {
            if (operation === "maskApply" && !layer.mask.enabled) throw Error("请先启用蒙版再应用");
            const copy = { ...layer, canvas: operation === "maskApply" ? maskedLayerCanvas(layer) : layer.canvas }; delete copy.mask; layers[index] = copy; nextTarget = "image";
          } else if (operation === "maskEnabled") layers[index] = { ...layer, mask: { ...layer.mask, enabled: value } };
          else if (operation === "maskInvert") layers[index] = { ...layer, mask: { ...layer.mask, canvas: invertLayerMask(layer.mask.canvas) } };
          else return;
        }
      } else {
        if (operation === "name" && (typeof value !== "string" || !value.trim() || value.length > 64 || /[\0-\x1f]/.test(value))) throw Error("图层名称应为 1–64 个字符");
        if (operation === "opacity" && (!Number.isInteger(value) || value < 0 || value > 100)) throw Error("不透明度应为 0–100 的整数");
        if (operation === "blendMode") layerBlendMode({ blendMode: value });
        if (!["name", "opacity", "visible", "locked", "blendMode"].includes(operation)) return;
        layers[index] = { ...layer, [operation]: value };
      }
      rememberSelection(); layersRef.current = layers; activeLayer.current = nextActive; syncLayerTarget(nextTarget);
      setSelection(null); endStroke(); publishPreview(); setRevision(item => item + 1); setError("");
    } catch (reason) { setError(reason.message); }
  }

  async function showStroke(snapshot) {
    const gen = ++paintGen.current;
    restoring.current = true;
    try {
      const restored = await restoreLayers(snapshot.document);
      if (gen !== paintGen.current) return;
      layersRef.current = restored.layers; activeLayer.current = restored.active; syncLayerTarget(restored.editTarget);
      restoring.current = false;
      setRevision(value => value + 1);
      publishPreview();
    } catch (reason) { if (gen === paintGen.current) { restoring.current = false; setError(reason.message); setRevision(value => value + 1); } }
  }

  function endStroke() {
    const board = bitmap.current;
    if (!board) return;
    const document = serializeLayers(layersRef.current, activeLayer.current, editTarget.current), key = JSON.stringify(document.layers);
    if (!strokes.current.length) { seedStrokes(board); return; }
    const previous = strokes.current[strokeAt.current];
    const selection = selectionRef.current, oldSelection = previous?.selection;
    const sameSelection = selection === oldSelection || (selection && oldSelection
      && ["x", "y", "w", "h"].every(key => selection[key] === oldSelection[key])
      && (selection.mask === oldSelection.mask || (selection.mask && oldSelection.mask
        && selection.mask.length === oldSelection.mask.length && selection.mask.every((value, index) => value === oldSelection.mask[index]))));
    const snapshot = previous?.key === key && sameSelection ? previous : { document, key, selection };
    const recorded = remember(strokes.current, strokeAt.current, snapshot);
    strokes.current = recorded.stack;
    strokeAt.current = recorded.cursor;
    let bytes = strokes.current.reduce((sum, item) => sum + item.key.length * 4, 0);
    while (strokes.current.length > 2 && bytes > 32 * 1024 * 1024) { bytes -= strokes.current.shift().key.length * 4; strokeAt.current--; }
    setStrokePast(strokeAt.current);
    setStrokeFuture(strokes.current.length - 1 - strokeAt.current);
    setDirty(key !== savedStroke.current);
  }

  function moveStroke(next) {
    strokeAt.current = next;
    setStrokePast(next);
    setStrokeFuture(strokes.current.length - 1 - next);
    setDirty(strokes.current[next].key !== savedStroke.current);
    setSelection(strokes.current[next].selection);
    showStroke(strokes.current[next]);
  }

  function undoStroke() {
    if (saving) return;
    if (drag.current) { cancelShape(); return; }
    if (strokeAt.current <= 0) return;
    moveStroke(strokeAt.current - 1);
  }

  function redoStroke() {
    if (saving) return;
    if (drag.current) { cancelShape(); return; }
    if (strokeAt.current >= strokes.current.length - 1) return;
    moveStroke(strokeAt.current + 1);
  }

  function stampTemplate() {
    const board = bitmap.current;
    if (!board || !live.current.current) { setError("贴图尚未载入，不能画 UV 框"); return; }
    if (layerBusy() || !editableLayer()) return;
    const picked = live.current.picked;
    const cubes = [];
    for (const bone of live.current.paintBones || []) {
      (bone.cubes || []).forEach((cube, index) => {
        if (picked?.bone && (bone.name !== picked.bone || (Number.isInteger(picked.cube) && picked.cube !== index))) return;
        cubes.push(cube);
      });
    }
    const ctx = board.getContext("2d");
    ctx.save();
    ctx.strokeStyle = live.current.color || "#000000";
    ctx.lineWidth = 1;
    for (const cube of cubes) {
      for (const [x, y, w, h] of uvRects(cube)) {
        if (w <= 0 || h <= 0) continue;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
    }
    ctx.restore();
    setRevision(value => value + 1);
    publishPreview();
    endStroke();
  }

  if (paintActions) paintActions.current = { undo: undoStroke, redo: redoStroke, paint: (hit, phase) => {
    if (live.current.role !== "paint") return false;
    if (hit?.textureKey && hit.textureKey !== currentRelative) { setError("请先选择该面的贴图，再绘制：" + hit.textureKey); return false; }
    const board = bitmap.current;
    const point = hit && board ? { x: Math.min(board.width - 1, Math.floor(hit.u * board.width)), y: Math.min(board.height - 1, Math.floor(hit.v * board.height)), surface: hit.surface, newSelection: hit.newSelection } : null;
    if (phase === "cancel") { cancelShape(); return true; }
    if (phase === "down") return beginPaint(point);
    if (phase === "move") movePaint(point);
    if (phase === "up") { movePaint(point); finishPaint(); }
    return true;
  }, revealFace: relative => {
    if (!relative) return;
    const item = textures.find(texture => texture.relative === relative);
    if (!item) { setError("缺少选中面的贴图：" + relative); return; }
    choose(item.path);
  }, materialSnapshot: () => {
    if (materialError || JSON.parse(bindingKey).some(key => !materialSources[key] && key !== currentRelative)) throw Error(materialError || "面贴图正在加载");
    if (drag.current || restoring.current || (current && !bitmap.current)) throw Error("请先完成贴图操作");
    return currentRelative && JSON.parse(bindingKey).includes(currentRelative) && bitmap.current
      ? { [currentRelative]: flattenLayers(layersRef.current).toDataURL("image/png") } : {};
  }, snapshot: () => {
    if (drag.current) throw Error("先完成当前绘制，再导出工程");
    if (current && !bitmap.current) throw Error("贴图正在加载，请稍后导出");
    if (restoring.current) throw Error("正在恢复贴图，请稍后导出");
    return current && bitmap.current ? flattenLayers(layersRef.current).toDataURL("image/png") : "";
  } };

  function draw() {
    const canvas = view.current;
    const source = role === "paint" && editTarget.current === "mask" ? bitmap.current : flattenLayers(layersRef.current);
    if (!canvas) return;
    const width = Math.max(1, Math.floor(canvas.clientWidth || 360));
    const height = Math.max(1, Math.floor(canvas.clientHeight || 280));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    if (!source) return;
    let left = 0;
    let top = 0;
    let spanW = source.width;
    let spanH = source.height;
    if (live.current.role === "edit") {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const bone of live.current.bones || []) {
        for (const cube of bone.cubes || []) {
          for (const face of facesOf(cube, currentRelative)) {
            const [u, v, w, h] = face.rect;
            minX = Math.min(minX, u, u + w);
            minY = Math.min(minY, v, v + h);
            maxX = Math.max(maxX, u, u + w);
            maxY = Math.max(maxY, v, v + h);
          }
        }
      }
      if (Number.isFinite(minX)) {
        left = Math.max(0, Math.floor(minX - 1));
        top = Math.max(0, Math.floor(minY - 1));
        spanW = Math.max(1, Math.min(source.width, Math.ceil(maxX + 1)) - left);
        spanH = Math.max(1, Math.min(source.height, Math.ceil(maxY + 1)) - top);
      }
    }
    const scale = Math.min(width / spanW, height / spanH);
    const ox = (width - spanW * scale) / 2 - left * scale;
    const oy = (height - spanH * scale) / 2 - top * scale;
    layout.current = { ox, oy, scale };
    ctx.drawImage(source, ox, oy, source.width * scale, source.height * scale);
    for (const bone of live.current.bones || []) {
      (bone.cubes || []).forEach((cube, index) => {
        const selected = live.current.picked?.bone === bone.name && live.current.picked?.cube === index;
        for (const face of facesOf(cube, currentRelative)) {
          const [u, v, w, h] = face.rect;
          const x = ox + u * scale;
          const y = oy + v * scale;
          if (selected) {
            ctx.fillStyle = "rgba(142,182,255,0.22)";
            ctx.fillRect(x, y, w * scale, h * scale);
          }
          ctx.strokeStyle = selected ? "#8eb6ff" : "rgba(255,255,255,0.45)";
          ctx.lineWidth = selected && face.name === live.current.uvFace ? 3 : selected ? 2 : 1;
          ctx.strokeRect(x + 0.5, y + 0.5, w * scale, h * scale);
        }
      });
    }
    if (live.current.role === "paint" && selection?.w && selection?.h) {
      ctx.strokeStyle = "#8eb6ff";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(ox + selection.x * scale + 0.5, oy + selection.y * scale + 0.5, Math.max(selection.w * scale - 1, 1), Math.max(selection.h * scale - 1, 1));
      ctx.setLineDash([]);
      if (selection.mask && selection.mask.length <= 65536) {
        ctx.fillStyle = "rgba(142,182,255,0.35)";
        for (let index = 0; index < selection.mask.length; index++) if (selection.mask[index]) ctx.fillRect(ox + (selection.x + index % selection.w) * scale, oy + (selection.y + Math.floor(index / selection.w)) * scale, Math.max(scale, 1), Math.max(scale, 1));
      }
    }
    const lasso = drag.current?.lasso ? drag.current.points : null;
    if (lasso?.length) {
      ctx.beginPath();
      ctx.strokeStyle = "#8eb6ff";
      lasso.forEach(([x, y], index) => { const px = ox + (x + 0.5) * scale, py = oy + (y + 0.5) * scale; if (index) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.closePath();
      ctx.stroke();
    }
  }

  function copySelection() {
    const board = bitmap.current;
    if (!selectionReady()) return false;
    const { x, y, w, h } = selectionRef.current;
    const image = board.getContext("2d").getImageData(0, 0, board.width, board.height);
    const kept = selectionRef.current.mask ? paintMasked(image, selectionRef.current, "keep") : null;
    const data = kept ? new ImageData(kept.data, kept.width, kept.height) : board.getContext("2d").getImageData(x, y, w, h);
    clipboard.current = { w, h, data, mask: selectionRef.current.mask || null };
    setClipReady(true);
    setNotice("已复制选区");
    setError("");
    return true;
  }

  function pasteSelection() {
    const board = bitmap.current;
    const clip = clipboard.current;
    if (!clip || !selectionReady()) return;
    if (!editableLayer()) return;
    try {
      const target = selectionBounds({ ...selectionRef.current, w: clip.w, h: clip.h }, board.width, board.height);
      rememberSelection();
      const ctx = board.getContext("2d");
      if (clip.mask) {
        const dest = ctx.getImageData(target.x, target.y, clip.w, clip.h);
        dest.data.set(compositeSelected(dest.data, clip.data.data, clip.mask));
        ctx.putImageData(dest, target.x, target.y);
        setSelection({ ...target, mask: clip.mask });
      } else { ctx.putImageData(clip.data, target.x, target.y); setSelection(target); }
      finishSelection("已粘贴选区");
    } catch (reason) { setError(reason.message); }
  }

  function selectionReady() {
    if (!bitmap.current || !current || saving || restoring.current || drag.current) { setError("先完成贴图加载、绘制或保存"); return false; }
    if (!selectionRef.current) { setError("先拖一块选区"); return false; }
    return true;
  }
  function rememberSelection() {
    const entry = strokes.current[strokeAt.current];
    if (entry) strokes.current[strokeAt.current] = { ...entry, document: { ...entry.document, active: activeLayer.current, editTarget: editTarget.current }, selection: selectionRef.current };
  }
  function finishSelection(message) {
    setRevision(value => value + 1); publishPreview();
    endStroke(); setNotice(message); setError("");
  }
  function openSelectionTransform(mode) {
    if (!selectionReady() || !editableLayer()) return;
    const board = bitmap.current;
    setTransformDraft({ mode, board, path: current, target: editTarget.current, selection: selectionRef.current, image: board.getContext("2d").getImageData(0, 0, board.width, board.height) });
  }
  function applySelectionTransform(changed) {
    if (bitmap.current !== transformDraft.board || current !== transformDraft.path || editTarget.current !== transformDraft.target || selectionRef.current !== transformDraft.selection) throw Error("贴图或选区已变化，请重新打开变换");
    if (!selectionReady() || !editableLayer()) throw Error("当前贴图不可修改，请关闭后重试");
    rememberSelection();
    bitmap.current.getContext("2d").putImageData(new ImageData(changed.data, changed.width, changed.height), 0, 0);
    setSelection(changed.selection);
    finishSelection(transformDraft.mode === "resize" ? "已缩放选区，可一次撤销" : "已旋转选区，可一次撤销");
  }
  function changeSelection(operation, dx = 0, dy = 0) {
    if (!selectionReady()) return;
    if (!editableLayer()) return;
    const board = bitmap.current, ctx = board.getContext("2d"), source = selectionRef.current;
    try {
      const rect = selectionBounds(source, board.width, board.height);
      if (!["delete", "move"].includes(operation)) {
        const changed = transformSelectedPixels(ctx.getImageData(0, 0, board.width, board.height), source, operation);
        rememberSelection();
        ctx.putImageData(new ImageData(changed.data, changed.width, changed.height), 0, 0);
        setSelection(changed.selection);
        finishSelection("已变换选区");
        return;
      }
      let target = rect, pixels;
      if (operation !== "delete") {
        pixels = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
        target = shiftedSelection(rect, dx, dy, board.width, board.height);
      }
      rememberSelection();
      if (source.mask) {
        const full = ctx.getImageData(0, 0, board.width, board.height);
        const cleared = paintMasked({ width: board.width, height: board.height, data: full.data }, source, "clear");
        const patch = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
        patch.data.set(cleared.data);
        ctx.putImageData(patch, rect.x, rect.y);
        if (pixels) {
          const dest = ctx.getImageData(target.x, target.y, rect.w, rect.h);
          dest.data.set(compositeSelected(dest.data, pixels.data, source.mask));
          ctx.putImageData(dest, target.x, target.y);
        }
        setSelection(operation === "delete" ? null : { ...target, mask: source.mask });
      } else {
        ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
        if (pixels) ctx.putImageData(pixels, target.x, target.y);
        setSelection(operation === "delete" ? null : target);
      }
      finishSelection(operation === "delete" ? "已清除选区像素" : "已变换选区");
    } catch (reason) { setError(reason.message); }
  }
  function selectionKey(event) {
    if (event.defaultPrevented || document.querySelector("dialog[open]") || event.target?.closest('input,textarea,select,[role="combobox"],[role="separator"],[contenteditable="true"]')) return;
    if (event.key === "Escape") {
      if (drag.current) cancelShape(); else if (selectionRef.current) setSelection(null); else return;
      event.preventDefault(); return;
    }
    if (!["select", "wand", "lasso"].includes(live.current.paintTool) || event.altKey) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && ["c", "v", "x", "a"].includes(key)) {
      event.preventDefault();
      if (key === "c") copySelection();
      if (key === "v") pasteSelection();
      if (key === "x" && copySelection()) changeSelection("delete");
      if (key === "a" && bitmap.current && !drag.current) setSelection({ x: 0, y: 0, w: bitmap.current.width, h: bitmap.current.height });
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    const arrow = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[key];
    if (arrow && selectionRef.current) { event.preventDefault(); changeSelection("move", arrow[0] * (event.shiftKey ? 8 : 1), arrow[1] * (event.shiftKey ? 8 : 1)); }
    if ((key === "delete" || key === "backspace") && selectionRef.current) { event.preventDefault(); changeSelection("delete"); }
  }
  live.current.selectionKey = selectionKey;
  live.current.cancelPaint = cancelShape;

  useEffect(() => {
    let liveLoad = true;
    const gen = ++listGen.current;
    setError("");
    setNotice("");
    setTextures([]);
    setCurrent("");
    bitmap.current = null;
    layersRef.current = []; diskRevision.current = "";
    call("content.list-textures", { path: geometryPath, worldId }).then(value => {
      if (!liveLoad || gen !== listGen.current) return;
      const list = value.textures || [];
      setTextures(list);
      if (list[0]) setCurrent(list[0].path);
      else blank();
    }).catch(reason => { if (liveLoad) setError(reason.message); });
    return () => { liveLoad = false; };
  }, [geometryPath, worldId]);

  useEffect(() => {
    if (!current) return undefined;
    let liveLoad = true;
    bitmap.current = null;
    layersRef.current = []; diskRevision.current = "";
    onPreview?.("");
    ++paintGen.current;
    restoring.current = false;
    drag.current = null; rectBase.current = null; setSelection(null);
    call("content.read-texture", { path: current, worldId }).then(async value => {
      if (!liveLoad) return;
      const restored = await restoreLayers(value.layers, value.dataUrl);
      if (!liveLoad) return;
      layersRef.current = restored.layers; activeLayer.current = restored.active; syncLayerTarget(restored.editTarget);
      diskRevision.current = value.revision;
      setDirty(false); setRevision(item => item + 1); publishPreview(); seedStrokes(bitmap.current);
    }).catch(reason => { if (liveLoad) setError(reason.message); });
    return () => { liveLoad = false; };
  }, [current, worldId, reload]);

  useEffect(() => {
    let frame = 0;
    const redraw = () => draw();
    redraw();
    frame = requestAnimationFrame(redraw);
    const canvas = view.current;
    if (!canvas?.parentElement) return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas.parentElement);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [revision, bones, picked, uvFace, role, selection]);


  function pointOf(event) {
    const canvas = view.current;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    const { ox, oy, scale } = layout.current;
    return { x: Math.floor((x - ox) / scale), y: Math.floor((y - oy) / scale) };
  }

  function stamp(point) {
    const board = bitmap.current;
    if (!board || !live.current.current) return;
    const size = Math.max(1, Math.min(16, live.current.brush | 0));
    const left = point.x - Math.floor((size - 1) / 2);
    const top = point.y - Math.floor((size - 1) / 2);
    const ctx = board.getContext("2d");
    const erase = (drag.current?.tool || live.current.paintTool) === "erase";
    if (!erase) {
      const hex = live.current.color || "#000000";
      const alpha = Math.max(0, Math.min(255, live.current.opacity | 0)) / 255;
      ctx.fillStyle = "rgba(" + parseInt(hex.slice(1, 3), 16) + "," + parseInt(hex.slice(3, 5), 16) + "," + parseInt(hex.slice(5, 7), 16) + "," + alpha + ")";
    }
    const seen = drag.current?.painted || new Set();
    const pixel = (x, y) => {
      if (x < 0 || y < 0 || x >= board.width || y >= board.height) return;
      if (!containsPixel(selectionRef.current, x, y)) return;
      const key = y * board.width + x;
      if (seen.has(key)) return;
      seen.add(key);
      if (erase) ctx.clearRect(x, y, 1, 1);
      else ctx.fillRect(x, y, 1, 1);
    };
    for (let y = top; y < top + size; y += 1) {
      for (let x = left; x < left + size; x += 1) {
        pixel(x, y);
        if (!live.current.mirrorPaint) continue;
        const other = mirrorPaintAt(live.current.paintBones, x, y);
        if (!other) continue;
        pixel(other.x, other.y);
      }
    }
    setDirty(true);
    setRevision(value => value + 1);
  }

  function fillAt(point) {
    const board = bitmap.current;
    if (!board || !live.current.current) return;
    const x = point.x;
    const y = point.y;
    if (x < 0 || y < 0 || x >= board.width || y >= board.height) return;
    if (!containsPixel(selectionRef.current, x, y)) return;
    const ctx = board.getContext("2d");
    const image = ctx.getImageData(0, 0, board.width, board.height);
    const data = image.data;
    const start = (y * board.width + x) * 4;
    const source = data.slice(start, start + 4);
    const hex = live.current.color || "#000000";
    const target = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), Math.max(0, Math.min(255, live.current.opacity | 0))];
    if (source.every((value, index) => value === target[index])) return;
    const stack = [[x, y]];
    const seen = new Uint8Array(board.width * board.height);
    const flood = () => {
      while (stack.length) {
        const [cx, cy] = stack.pop();
        if (cx < 0 || cy < 0 || cx >= board.width || cy >= board.height) continue;
        if (!containsPixel(selectionRef.current, cx, cy)) continue;
        const index = cy * board.width + cx;
        if (seen[index]) continue;
        const pixel = index * 4;
        if (source.some((value, channel) => data[pixel + channel] !== value)) continue;
        seen[index] = 1;
        target.forEach((value, channel) => { data[pixel + channel] = value; });
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
    };
    flood();
    if (live.current.mirrorPaint) {
      const other = mirrorPaintAt(live.current.paintBones, x, y);
      if (other && !seen[other.y * board.width + other.x]) {
        const mirrored = (other.y * board.width + other.x) * 4;
        source.set(data.slice(mirrored, mirrored + 4));
        if (source.some((value, index) => value !== target[index])) {
          stack.push([other.x, other.y]);
          flood();
        }
      }
    }
    ctx.putImageData(image, 0, 0);
    setDirty(true);
    setRevision(value => value + 1);
    publishPreview();
    endStroke();
  }

  function pickAt(point) {
    const board = bitmap.current;
    if (!board || !live.current.current) return;
    if (point.x < 0 || point.y < 0 || point.x >= board.width || point.y >= board.height) return;
    const data = board.getContext("2d").getImageData(point.x, point.y, 1, 1).data;
    const hex = "#" + [0, 1, 2].map(channel => data[channel].toString(16).padStart(2, "0")).join("");
    if (editTarget.current === "mask") setMaskValue(maskCoverage(data, 0)); else setColor(hex);
    setOpacity(data[3]);
  }

  function drawShape(point) {
    const board = bitmap.current;
    const base = rectBase.current;
    const mark = drag.current;
    if (!board || !base || !mark?.shape) return;
    const ctx = board.getContext("2d");
    ctx.putImageData(base, 0, 0);
    ctx.save();
    if (selectionRef.current) { const { x, y, w, h } = selectionRef.current; ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); }
    const x = Math.min(mark.x, point.x);
    const y = Math.min(mark.y, point.y);
    const w = Math.abs(point.x - mark.x) + 1;
    const h = Math.abs(point.y - mark.y) + 1;
    const hex = live.current.color || "#000000";
    const alpha = Math.max(0, Math.min(255, live.current.opacity | 0)) / 255;
    const ink = "rgba(" + parseInt(hex.slice(1, 3), 16) + "," + parseInt(hex.slice(3, 5), 16) + "," + parseInt(hex.slice(5, 7), 16) + "," + alpha + ")";
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(1, Math.min(16, live.current.brush | 0));
    ctx.lineCap = "round";
    if (mark.shape === "line") {
      // 对齐像素中心，单像素横线和竖线不会落在两个像素之间。
      ctx.beginPath();
      ctx.moveTo(mark.x + 0.5, mark.y + 0.5);
      ctx.lineTo(point.x + 0.5, point.y + 0.5);
      ctx.stroke();
    } else if (mark.shape === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(w / 2, 0.5), Math.max(h / 2, 0.5), 0, 0, Math.PI * 2);
      if (live.current.outline) ctx.stroke();
      else ctx.fill();
    } else if (live.current.outline) ctx.strokeRect(x, y, w, h);
    else ctx.fillRect(x, y, w, h);
    if (live.current.mirrorPaint) {
      const start = mirrorPaintAt(live.current.paintBones, mark.x, mark.y);
      const end = mirrorPaintAt(live.current.paintBones, point.x, point.y);
      if (start && end && (start.x !== mark.x || start.y !== mark.y)) {
        const x2 = Math.min(start.x, end.x);
        const y2 = Math.min(start.y, end.y);
        const w2 = Math.abs(end.x - start.x) + 1;
        const h2 = Math.abs(end.y - start.y) + 1;
        if (mark.shape === "line") {
          ctx.beginPath();
          ctx.moveTo(start.x + 0.5, start.y + 0.5);
          ctx.lineTo(end.x + 0.5, end.y + 0.5);
          ctx.stroke();
        } else if (mark.shape === "ellipse") {
          ctx.beginPath();
          ctx.ellipse(x2 + w2 / 2, y2 + h2 / 2, Math.max(w2 / 2, 0.5), Math.max(h2 / 2, 0.5), 0, 0, Math.PI * 2);
          if (live.current.outline) ctx.stroke();
          else ctx.fill();
        } else if (live.current.outline) ctx.strokeRect(x2, y2, w2, h2);
        else ctx.fillRect(x2, y2, w2, h2);
      }
    }
    ctx.restore();
    const selection = selectionRef.current;
    if (selection?.mask) {
      const patch = ctx.getImageData(selection.x, selection.y, selection.w, selection.h);
      for (let y = 0; y < selection.h; y++) for (let x = 0; x < selection.w; x++) {
        const index = y * selection.w + x;
        if (selection.mask[index] === 1) continue;
        const from = ((selection.y + y) * board.width + selection.x + x) * 4;
        patch.data.set(base.data.subarray(from, from + 4), index * 4);
      }
      ctx.putImageData(patch, selection.x, selection.y);
    }
    setDirty(true);
    setRevision(value => value + 1);
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const point = pointOf(event);
    point.newSelection = event.shiftKey;
    if (live.current.role === "paint") {
      event.currentTarget.focus();
      if (beginPaint(point)) event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const found = hitFace(live.current.bones, live.current.picked, point, currentRelative);
    if (!found) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    live.current.onPick?.(found.bone, found.index); live.current.onFace?.(found.face.name);
    if (Array.isArray(found.cube.uv)) {
      drag.current = { box: true, bone: found.bone, index: found.index, x: point.x, y: point.y, uv: found.cube.uv.map(Number) };
      return;
    }
    const face = found.cube.uv?.[found.face.name];
    if (!face?.uv) return;
    drag.current = { box: false, bone: found.bone, index: found.index, face: found.face.name, x: point.x, y: point.y, uvObject: found.cube.uv, origin: face.uv.map(Number) };
  }

  function onPointerMove(event) {
    if (!drag.current) return;
    const point = pointOf(event);
    if (live.current.role === "paint") { movePaint(point); return; }
    const dx = Math.round(point.x - drag.current.x);
    const dy = Math.round(point.y - drag.current.y);
    if (drag.current.box) {
      live.current.onUv?.(drag.current.bone, drag.current.index, [drag.current.uv[0] + dx, drag.current.uv[1] + dy]);
      return;
    }
    const face = drag.current.uvObject[drag.current.face];
    live.current.onUv?.(drag.current.bone, drag.current.index, {
      ...drag.current.uvObject,
      [drag.current.face]: { ...face, uv: [drag.current.origin[0] + dx, drag.current.origin[1] + dy] },
    });
  }

  function onPointerUp(event) {
    if (live.current.role === "paint") { movePaint(pointOf(event)); finishPaint(); }
    else { const adjusted = !!drag.current; drag.current = null; if (adjusted) live.current.onUvEnd?.(); }
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function cancelShape() {
    const mark = drag.current;
    if (!mark) return;
    if (rectBase.current && bitmap.current) {
      bitmap.current.getContext("2d").putImageData(rectBase.current, 0, 0);
      setDirty(mark.dirty);
      publishPreview();
    }
    if (mark.select || mark.moveSelection) setSelection(mark.selection);
    drag.current = null;
    rectBase.current = null;
    setRevision(value => value + 1);
  }

  function beginPaint(point) {
    const board = bitmap.current;
    if (!live.current.current || !board) { setError("贴图尚未载入，不能绘制"); return false; }
    if (saving || restoring.current || drag.current || !point || point.x < 0 || point.y < 0 || point.x >= board.width || point.y >= board.height) return false;
    setError(""); setNotice("");
    const tool = live.current.paintTool;
    if (!["pick", "select", "wand", "lasso"].includes(tool) && !editableLayer()) return false;
    rememberSelection();
    if (tool === "wand") {
      try {
        const image = board.getContext("2d").getImageData(0, 0, board.width, board.height);
        const limit = selectionRef.current && containsPixel(selectionRef.current, point.x, point.y) ? selectionRef.current : null;
        const region = connectedPixels(image, point.x, point.y, limit);
        setSelection(region);
        setNotice("已选择相连的 " + region.count + " 个像素");
      } catch (reason) { setError(reason.message); }
      return true;
    }
    if (tool === "lasso") {
      drag.current = { lasso: true, points: [[point.x, point.y]], limit: selectionRef.current, surface: point.surface };
      setRevision(value => value + 1);
      return true;
    }
    if (tool === "fill") { fillAt(point); return true; }
    if (tool === "pick") { pickAt(point); return true; }
    if (tool === "select") {
      const region = selectionRef.current;
      if (region && !point.newSelection && containsPixel(region, point.x, point.y)) {
        if (!editableLayer()) return false;
        rectBase.current = board.getContext("2d").getImageData(0, 0, board.width, board.height);
        drag.current = { ...point, moveSelection: true, selection: region, dirty, pixels: board.getContext("2d").getImageData(region.x, region.y, region.w, region.h), surface: point.surface };
        return true;
      }
      drag.current = { ...point, select: true, selection: region, surface: point.surface };
      setSelection({ x: point.x, y: point.y, w: 1, h: 1 });
      return true;
    }
    rectBase.current = board.getContext("2d").getImageData(0, 0, board.width, board.height);
    if (["rect", "ellipse", "line"].includes(tool)) {
      drag.current = { ...point, shape: tool, dirty, surface: point.surface };
      drawShape(point);
    } else {
      drag.current = { paint: true, tool, dirty, last: point, painted: new Set() };
      stamp(point);
    }
    return true;
  }

  function movePaint(point) {
    const mark = drag.current, board = bitmap.current;
    if (!mark || !board) return;
    if (mark.lasso && point) {
      if (mark.surface !== point.surface) { setNotice("套索请在同一面内拖动，跨面部分未计入"); return; }
      const x = Math.max(0, Math.min(board.width - 1, point.x)), y = Math.max(0, Math.min(board.height - 1, point.y));
      const last = mark.points[mark.points.length - 1];
      if ((last[0] !== x || last[1] !== y) && mark.points.length < 8192) { mark.points.push([x, y]); setRevision(value => value + 1); }
      return;
    }
    if (!point || (!mark.moveSelection && (point.x < 0 || point.y < 0 || point.x >= board.width || point.y >= board.height))) { mark.last = null; return; }
    if (mark.paint) {
      const last = mark.last;
      const steps = last && last.surface === point.surface ? Math.max(Math.abs(point.x - last.x), Math.abs(point.y - last.y)) : 0;
      if (steps) for (let i = 1; i <= steps; i++) stamp({ x: Math.round(last.x + (point.x - last.x) * i / steps), y: Math.round(last.y + (point.y - last.y) * i / steps) });
      else stamp(point);
      mark.last = point;
      return;
    }
    if (mark.surface !== point.surface) { setNotice("形状和选区请在同一面内拖动，跨面部分未应用"); return; }
    if (mark.moveSelection) {
      const target = shiftedSelection(mark.selection, point.x - mark.x, point.y - mark.y, board.width, board.height);
      const ctx = board.getContext("2d"); ctx.putImageData(rectBase.current, 0, 0);
      if (mark.selection.mask) {
        const full = ctx.getImageData(0, 0, board.width, board.height);
        const cleared = paintMasked({ width: board.width, height: board.height, data: full.data }, mark.selection, "clear");
        const patch = ctx.getImageData(mark.selection.x, mark.selection.y, mark.selection.w, mark.selection.h);
        patch.data.set(cleared.data); ctx.putImageData(patch, mark.selection.x, mark.selection.y);
        const dest = ctx.getImageData(target.x, target.y, mark.selection.w, mark.selection.h);
        dest.data.set(compositeSelected(dest.data, mark.pixels.data, mark.selection.mask));
        ctx.putImageData(dest, target.x, target.y);
        setSelection({ ...target, mask: mark.selection.mask, count: mark.selection.count });
      } else {
        ctx.clearRect(mark.selection.x, mark.selection.y, mark.selection.w, mark.selection.h); ctx.putImageData(mark.pixels, target.x, target.y);
        setSelection(target);
      }
      setDirty(true); setRevision(value => value + 1);
      publishPreview();
    }
    if (mark.shape) drawShape(point);
    if (mark.select) setSelection({ x: Math.min(mark.x, point.x), y: Math.min(mark.y, point.y), w: Math.abs(point.x - mark.x) + 1, h: Math.abs(point.y - mark.y) + 1 });
  }

  function finishPaint() {
    const mark = drag.current;
    drag.current = null; rectBase.current = null;
    if (mark?.lasso && bitmap.current) {
      try {
        const region = lassoSelection(mark.points, bitmap.current.width, bitmap.current.height, mark.limit);
        setSelection(region);
        setNotice("套索选择了 " + region.count + " 个像素");
      } catch (reason) { setError(reason.message); }
      setRevision(value => value + 1);
      return;
    }
    if (mark?.select) rememberSelection();
    if ((mark?.paint || mark?.shape || mark?.moveSelection) && bitmap.current) {
      publishPreview();
      endStroke();
    }
  }

  function choose(path) {
    if (path === current) return;
    if (saving || restoring.current || drag.current) { setError("先完成当前贴图操作"); return; }
    if (dirty) { setError("先保存或放弃当前绘制"); return; }
    setError("");
    setNotice("");
    setCurrent(path);
  }

  async function save() {
    if (!current || !bitmap.current) return;
    if (drag.current || restoring.current) { setError("先完成绘制或撤销，再保存贴图"); return; }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const dataUrl = flattenLayers(layersRef.current).toDataURL("image/png"), layers = serializeLayers(layersRef.current, activeLayer.current, editTarget.current);
      const saved = await call("content.save-texture", { path: current, worldId, dataUrl, layers, revision: diskRevision.current });
      diskRevision.current = saved.revision;
      setDirty(false);
      savedStroke.current = JSON.stringify(layers.layers);
      onPreview?.(dataUrl);
      setNotice("贴图已保存，原文件在同名 .bak");
    } catch (reason) { setError(reason.message); }
    finally { setSaving(false); }
  }

  async function createBlank() {
    if (saving || restoring.current || drag.current) { setError("先完成当前贴图操作"); return; }
    if (dirty) { setError("先保存或放弃当前绘制"); return; }
    setError("");
    setNotice("");
    try {
      const created = await call("content.create-texture", { modelPath: geometryPath, worldId, name: textureName.trim() || "texture", width: textureWidth || 64, height: textureHeight || 64 });
      listGen.current += 1;
      const value = await call("content.list-textures", { path: geometryPath, worldId });
      setTextures(value.textures || []);
      setCurrent(created.path);
      setNotice("已新建空白贴图");
    } catch (reason) { setError(reason.message); }
  }

  async function openUvDialog(mode) {
    if (uvPending.current) return;
    if (mode === "repack") {
      if (layerBusy()) { setError("先载入贴图并完成当前绘制，再重排"); return; }
      const context = uvContext.current, currentRevision = diskRevision.current;
      uvPending.current = true; setUvLoading(true); setError("");
      try {
        const paths = assignedTextures(bones);
        const needsDefault = bones.some(bone => (bone.cubes || []).some(cube => Array.isArray(cube.uv) || faceNames.some(name => cube.uv?.[name] && !cube.uv[name].dgn_texture)));
        const count = paths.length + (needsDefault ? 1 : 0);
        if (count > 8) throw Error("面贴图连同默认贴图最多 8 张");
        if (count * textureWidth * textureHeight > 16 * 1024 * 1024) throw Error("面贴图总像素超过 1600 万限制");
        const merged = flattenLayers(layersRef.current), dataUrl = merged.toDataURL("image/png");
        const sources = {}, overrides = {}, revisions = {};
        for (const key of paths) {
          const item = textures.find(texture => texture.relative === key);
          if (!item) throw Error("缺少面贴图：" + key);
          const value = await call("content.read-texture", { path: item.path, worldId });
          let board;
          if (key === currentRelative) {
            if (value.revision !== currentRevision) throw Error("当前贴图已被外部修改，请重新载入贴图");
            board = merged;
          } else {
            const restored = await restoreLayers(value.layers, value.dataUrl);
            board = flattenLayers(restored.layers);
          }
          sources[key] = board.getContext("2d").getImageData(0, 0, board.width, board.height);
          overrides[key] = board.toDataURL("image/png");
          revisions[key] = value.revision;
        }
        const image = !paths.length || needsDefault ? merged.getContext("2d").getImageData(0, 0, merged.width, merged.height) : sources[paths[0]];
        if (needsDefault) sources[""] = image;
        if (uvContext.current !== context || live.current.bones !== bones || live.current.role !== role) throw Error("模型状态已变化，请重新打开 UV 重排");
        setUvTexture({ image, dataUrl: !paths.length || needsDefault ? dataUrl : "", sources: paths.length ? sources : null, overrides, revisions, context, bones });
        setUvDialog(mode);
      } catch (reason) { setError(reason.message); }
      finally { uvPending.current = false; setUvLoading(false); }
      return;
    }
    if (dirty || drag.current || restoring.current || saving) { setError("先保存或放弃当前绘制，再处理 UV 或模板"); return; }
    setError(""); setUvDialog(mode);
  }
  async function applyUvDialog(value) {
    if (uvDialog === "repack") {
      if (uvTexture.context !== uvContext.current || uvTexture.bones !== bones) throw Error("模型状态已变化，请重新打开 UV 重排");
      const result = await onExportPacked({ ...value, texture: uvTexture.dataUrl, textureOverrides: uvTexture.overrides, textureRevisions: uvTexture.revisions });
      if (!result) return false;
      setNotice("重排工程已导出：" + result.path);
      return true;
    }
    if (uvDialog === "pack") { onPack?.(value.bones); return; }
    const created = await call("content.create-texture", { modelPath: geometryPath, worldId, name: value.name, width: textureWidth, height: textureHeight, templateBones: value.bones });
    listGen.current += 1;
    setTextures(current => [...current, created]); setCurrent(created.path);
    setNotice("已生成贴图模板，原有贴图保留");
  }

  const texturesPanel = <section className="model-panel model-textures">
    <div className="model-panel-head"><h2>贴图</h2><div className="model-texture-actions"><Button onClick={createBlank}>新建</Button><Button onClick={() => openUvDialog("template")}>模板</Button></div></div>
    <input className="model-name" aria-label="新贴图名" value={textureName} onChange={event => setTextureName(event.target.value)} />
    <label className="model-vec"><span>尺寸</span><input aria-label="贴图宽" type="number" value={textureWidth || 64} onChange={event => onTextureSize?.("textureWidth", event.target.value)} /><input aria-label="贴图高" type="number" value={textureHeight || 64} onChange={event => onTextureSize?.("textureHeight", event.target.value)} /></label>
    <div className="model-texture-list">
      {textures.map(item => <button type="button" key={item.path} aria-pressed={item.path === current} className={item.path === current ? "active" : ""} onClick={() => choose(item.path)}>{item.name}</button>)}
      {!textures.length && <p className="model-texture-note">还没有贴图。</p>}
    </div>
    {role === "edit" && materialCount > 0 && onAssignMaterial && <section className="model-material-assignment" aria-label="面贴图分配">
      <Select aria-label="分配贴图的面" value={uvFace || ""} options={[{ value: "", label: "所选立方体全部面" }, ...[["east","东"],["west","西"],["north","北"],["south","南"],["up","上"],["down","下"]].map(([value,label]) => ({ value, label: label + "面" }))]} onChange={value => onFace?.(value)} />
      <div className="model-tools"><Button disabled={!materialCount || layerBusy() || !currentRelative} onClick={assignCurrentTexture}>分配当前贴图</Button><Button disabled={!materialCount || layerBusy()} onClick={() => { try { onAssignMaterial("", uvFace); setError(""); } catch (reason) { setError(reason.message); } }}>取消贴图分配</Button></div>
      <p className="model-texture-note">分配到所选立方体；盒子 UV 自动展开。保存模型后记住，游戏材质配置需另行接入。</p>
    </section>}
    {materialError && <p role="alert">{materialError}</p>}
    {error && <p>{error}</p>}
    {notice && <p>{notice}</p>}
    {uvDialog && <ModelUvDialog mode={uvDialog} bones={bones} width={textureWidth} height={textureHeight} name={textureName.trim() || "texture"} texture={uvTexture?.image} sources={uvTexture?.sources} onApply={applyUvDialog} onClose={() => { setUvDialog(""); setUvTexture(null); }} />}
  </section>;
  const canvas = <div className="model-texture-view"><canvas ref={view} tabIndex={0} aria-label={role === "paint" ? "贴图绘制画布" : "UV 画布"} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={cancelShape} onLostPointerCapture={cancelShape} /></div>;
  if (role === "animate") return null;
  if (role === "paint") return <>
    {transformDraft && <SelectionTransform draft={transformDraft} onApply={applySelectionTransform} onClose={() => setTransformDraft(null)} />}
    <section className="model-panel model-brush">
      <h2>{maskEditing ? "蒙版画笔" : "画笔"}</h2>
      {maskEditing ? <><label className="model-layer-field">灰度<input aria-label="蒙版灰度" type="number" min="0" max="255" value={maskValue} onChange={event => setMaskValue(Math.max(0, Math.min(255, Math.round(Number(event.target.value) || 0))))} /></label><div className="model-layer-actions"><Button onClick={() => setMaskValue(0)}>黑色隐藏</Button><Button onClick={() => setMaskValue(255)}>白色显示</Button></div><p className="model-texture-note">画板显示蒙版，模型显示合成结果；橡皮和透明区域会隐藏图像。</p></> : <input aria-label="画笔颜色" type="color" value={color} onChange={event => setColor(event.target.value)} />}
      <label className="model-vec"><span>不透明</span><input aria-label="画笔不透明度" type="number" min="0" max="255" value={opacity} onChange={event => setOpacity(Math.max(0, Math.min(255, Number(event.target.value) || 0)))} /></label>
      <label className="model-vec"><span>大小</span><input className="model-brush-size" aria-label="画笔大小" type="number" min="1" max="16" value={brush} onChange={event => setBrush(Number(event.target.value) || 1)} /></label>
      <div className="model-transform" role="toolbar" aria-label="绘制工具">
        <button type="button" aria-pressed={paintTool === "brush"} onClick={() => setPaintTool("brush")}>画笔</button>
        <button type="button" aria-pressed={paintTool === "erase"} onClick={() => setPaintTool("erase")}>橡皮</button>
        <button type="button" aria-pressed={paintTool === "fill"} onClick={() => setPaintTool("fill")}>填充</button>
        <button type="button" aria-pressed={paintTool === "pick"} onClick={() => setPaintTool("pick")}>吸色</button>
        <button type="button" aria-pressed={paintTool === "rect"} onClick={() => setPaintTool("rect")}>矩形</button>
        <button type="button" aria-pressed={paintTool === "ellipse"} onClick={() => setPaintTool("ellipse")}>椭圆</button>
        <button type="button" aria-pressed={paintTool === "line"} onClick={() => setPaintTool("line")}>直线</button>
        <button type="button" aria-label="镜像绘制" aria-pressed={mirrorPaint} onClick={() => setMirrorPaint(value => !value)}>镜像</button>
        <button type="button" aria-pressed={paintTool === "select"} onClick={() => setPaintTool("select")}>选区</button>
        <button type="button" aria-pressed={paintTool === "wand"} onClick={() => setPaintTool("wand")}>魔棒</button>
        <button type="button" aria-pressed={paintTool === "lasso"} onClick={() => setPaintTool("lasso")}>套索</button>
        <button type="button" aria-pressed={!!solid} onClick={() => onSolid?.(!solid)}>立体</button>
      </div>
      {(paintTool === "rect" || paintTool === "ellipse") && <label className="model-check"><input type="checkbox" checked={outline} onChange={event => setOutline(event.target.checked)} />描边</label>}
      {(paintTool === "select" || paintTool === "wand" || paintTool === "lasso") && <section className="model-selection-tools" aria-label="选区操作">
        <p className="model-texture-note" role="status" aria-label="选区范围">{selection ? `${selection.x}, ${selection.y} · ${selection.w} × ${selection.h} 像素` : (paintTool === "lasso" ? "拖动圈选，松开闭合" : paintTool === "wand" ? "点击选择相连的同色像素" : "拖动建立矩形选区")}</p>
        <div className="model-selection-actions">
          <Button disabled={!selection || saving} onClick={copySelection}>复制选区</Button><Button disabled={!clipReady || !selection || saving} onClick={pasteSelection}>粘贴选区</Button>
          <Button disabled={!selection || saving} onClick={() => { if (copySelection()) changeSelection("delete"); }}>剪切选区</Button><Button disabled={!selection || saving} onClick={() => changeSelection("delete")}>删除选区</Button>
          <Button disabled={!selection || saving} onClick={() => changeSelection("flipX")}>水平翻转</Button><Button disabled={!selection || saving} onClick={() => changeSelection("flipY")}>垂直翻转</Button>
          <Button disabled={!selection || saving} onClick={() => changeSelection("rotate")}>旋转 90°</Button><Button disabled={!selection || saving} onClick={() => openSelectionTransform("rotate")}>自定义旋转</Button>
          <Button disabled={!selection || saving} onClick={() => changeSelection("scale2")}>放大两倍</Button><Button disabled={!selection || saving} onClick={() => changeSelection("scaleHalf")}>缩小一半</Button>
          <Button disabled={!selection || saving} onClick={() => openSelectionTransform("resize")}>自定义缩放</Button><Button disabled={!selection} onClick={() => setSelection(null)}>取消选区</Button>
        </div>
        <p className="model-texture-note">选区工具内拖动搬移像素，Shift 拖动重选；方向键微调，Esc 取消。变换保留孔洞，只用已选像素替换目标，包括透明像素。任意角度使用最近邻像素，不插值；旋转后外接框自动调整。</p>
        {paintTool === "wand" && <p className="model-texture-note">魔棒选择四向相连的同色像素。孔洞不参与绘制或变换；原位置只清除已选像素。</p>}
        {paintTool === "lasso" && <p className="model-texture-note">按住拖出范围，松开后闭合。已有选区时只保留其中部分。选区形状随像素翻转、旋转和缩放。</p>}
      </section>}
      {selection && !["select", "wand", "lasso"].includes(paintTool) && <p className="model-texture-note">绘制限定在选区内。<Button onClick={() => setSelection(null)}>取消选区</Button></p>}
      {["rect", "ellipse", "line"].includes(paintTool) && <p className="model-texture-note">拖动预览，松开完成；Esc 取消本次绘制。</p>}
      <div className="model-tools model-paint-history">
        <Button disabled={!strokePast || saving} onClick={undoStroke}>撤销</Button>
        <Button disabled={!strokeFuture || saving} onClick={redoStroke}>重做</Button>
        <Button disabled={!current} onClick={stampTemplate}>UV框</Button>
      </div>
      <div className="model-paint-save">
        <Button disabled={!dirty || saving || restoring.current} onClick={() => setReload(value => value + 1)}>放弃</Button>
        <Button primary disabled={!current || saving || restoring.current} onClick={save}>{saving ? "保存中…" : "保存贴图"}</Button>
      </div>
      {!current && <p className="model-texture-note">先在右侧新建一张贴图。</p>}
      {solid && <p className="model-texture-note">左键使用当前工具；Alt＋左键转动视角。形状和选区限同一面，Esc 取消本次拖动。</p>}
    </section>
    <section className="model-panel model-paint">{canvas}</section>
    <aside className="model-paint-sidebar">{texturesPanel}<ModelLayerPanel layers={layersRef.current} active={activeLayer.current} editTarget={editTarget.current} disabled={layerBusy()} onSelect={selectLayer} onTarget={selectLayerTarget} onChange={changeLayer} /></aside>
  </>;
  return <>
    <section className="model-panel model-uv"><div className="model-panel-head"><h2>UV</h2><div className="model-texture-actions"><Button onClick={() => openUvDialog("pack")}>自动排列</Button><Button disabled={layerBusy()} onClick={() => openUvDialog("repack")}>{uvLoading ? "读取贴图…" : "带贴图重排"}</Button></div></div>{canvas}</section>
    {texturesPanel}
  </>;
}
