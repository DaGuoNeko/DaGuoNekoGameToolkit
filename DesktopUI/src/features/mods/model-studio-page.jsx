import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Select } from "../../app/ui.jsx";
import { addBone, addCube, removeBone, removeCube, duplicateSelection, renameBone, reparentBone, transformSelection, transformMany, snapDelta, mirrorSelection, unwrapSelection, remember, boneTree, parentBones, ensureCubeIds, addLocator, removeLocator, renameLocator, duplicateLocator, setLocator, transformLocator } from "../../../shared/model-edit.cjs";
import { displaySlots, displayPresets, displayPose, assignDisplay, clearDisplay } from "../../../shared/model-display.cjs";
import { editFaceUv, rotateFace, scaleFace } from "../../../shared/model-edit.cjs";
import { ModelViewport, TextureDesk } from "./model-studio.jsx";
import { clipFromBedrock, setBoneKey, moveCurveKey, insertCurveKey, deleteCurveKey, moveKeySelection, copyKeySelection, pasteKeySelection, clearKeySelection, setKeyMode, keyMode, setAnimSpan, keyTimes, sampleTrack, trackOf, hasExpressions, clipTime, bakeBezier } from "../skins/npc-clip.cjs";
import { KeyTracks } from "./model-key-tracks.jsx";
import { SoundEditor } from "./model-sound-editor.jsx";
import { ModelControllerEditor } from "./model-controller-editor.jsx";
import { soundFrames } from "../../../shared/animation-sounds.cjs";
import { ParticleEditor } from "./model-particle-editor.jsx";
import { particleFrames } from "../../../shared/animation-particles.cjs";
import { InstructionEditor } from "./model-instruction-editor.jsx";
import { instructionFrames } from "../../../shared/animation-timeline.cjs";
import { BezierEditor } from "./model-bezier.jsx";
import { NativeBezierEditor } from "./model-native-bezier.jsx";
import { updateNativeBezier } from "../../../shared/animation-bezier-edit.cjs";
import { MultiCubeProperties, PropertyInput } from "./model-multi-properties.jsx";
import { assignFaceTexture, faceNames } from "../../../shared/model-materials.cjs";
import { cubeVertices, setCubeVertices, moveCubeGeometry, resizeCubeGeometry, setVertexComponent, transformVertices, defaultVertices, faceCorners, mirrorVertices, extrudeCubeFace, pushFace, insetFace, splitCube } from "../../../shared/model-vertex-edit.cjs";
import { convertCubeToMesh, createMesh, addMeshVertex, addMeshFace, removeMeshFace, removeMeshVertex, subdivideMeshFace, setMeshFaceTexture, moveMeshVertex, setMeshVertex, removeMesh, weldPoint } from "../../../shared/model-mesh.cjs";
import { MultiBoneProperties } from "./model-multi-bone.jsx";
import { changeBoneProperty } from "../../../shared/model-bone-properties.cjs";
import { boneSelection, duplicateBones, deleteBones, reparentBones } from "../../../shared/model-bone-operations.cjs";
import { changeCubeProperty, namedCube } from "../../../shared/model-cube-properties.cjs";
import { duplicateCubes, deleteCubes, moveCubes } from "../../../shared/model-cube-operations.cjs";
import { CubeBoneMove } from "./model-bone-move.jsx";
import { moveCubesKeepingPose } from "./model-reparent.js";
import { vertexSnapContext, moveWithVertexSnap, alignVertexPoints, cubeVertexMarkers, meshVertexMarkers } from "./model-vertex-snap.js";
import { ModelBench } from "./model-bench.jsx";
import { useModelLayouts } from "./use-model-layouts.jsx";
import { useModelViews } from "./use-model-views.jsx";
import { defaultLayout } from "../../../shared/model-layout.cjs";
import "./model-studio.css";

const call = (method, args = {}) => window.toolkit.call(method, args);


function numberList(value) {
  const source = Array.isArray(value) ? value : [];
  return [0, 1, 2].map(index => Number(source[index]) || 0);
}

function Vec3({ label, value, onChange, disabled = false, step = 0.5 }) {
  const current = numberList(value);
  return <label className="model-vec"><span>{label}</span>{["X", "Y", "Z"].map((axis, index) => <input key={axis} disabled={disabled} aria-label={label + axis} type="number" step={step} value={current[index]} onChange={event => { const next = current.slice(); next[index] = Number(event.target.value); onChange(next); }} />)}</label>;
}

export function ModelStudioPage({ request, onBack, onLeave }) {
  const [library, setLibrary] = useState([]);
  const [filter, setFilter] = useState("");
  const [outlinerFilter, setOutlinerFilter] = useState("");
  const [opened, setOpened] = useState(request || null);
  const seen = useRef("");
  const [doc, setDoc] = useState(null);
  const [identifier, setIdentifier] = useState("");
  const [picked, setPicked] = useState(null);
  const [hidden, setHidden] = useState([]);
  const [folded, setFolded] = useState([]);
  const dragBone = useRef("");
  const [dropTarget, setDropTarget] = useState("");
  const [keepMovePose, setKeepMovePose] = useState(false);
  const [boneName, setBoneName] = useState("");
  const [locatorName, setLocatorName] = useState("");
  const [elementName, setElementName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [newId, setNewId] = useState("geometry.model");
  const [confirmPath, setConfirmPath] = useState("");
  const [textureUrl, setTextureUrl] = useState("");
  const [materialUrls, setMaterialUrls] = useState({});
  const [desk, setDesk] = useState("edit");
  const [displaySlot, setDisplaySlot] = useState("gui");
  const [solid, setSolid] = useState(false);
  const { layouts, ready: layoutReady, pending: layoutPending, error: layoutError, save: saveLayout, retry: retryLayout } = useModelLayouts();
  const { session: viewSession, ready: viewsReady, pending: viewsPending, error: viewError, save: saveViews } = useModelViews();
  const [layoutReset, setLayoutReset] = useState(0);
  const layoutMode = desk === "paint" && solid ? "solid" : desk;
  const layout = layouts[layoutMode] || defaultLayout(layoutMode);
  const [tool, setTool] = useState("move");
  const [snap, setSnap] = useState(false);
  const [vertexSnap, setVertexSnap] = useState(false), [vertexTarget, setVertexTarget] = useState(null);
  const [pointAlign, setPointAlign] = useState(false), [pointAxis, setPointAxis] = useState("all"), [pointSource, setPointSource] = useState(null);
  const [marks, setMarks] = useState([]);
  const [boneMarks, setBoneMarks] = useState([]);
  const ctrl = useRef(false);
  const [uvFace, setUvFace] = useState("");
  const [vertexIndex, setVertexIndex] = useState(0);
  const [meshFace, setMeshFace] = useState(0);
  const [vertexSelection, setVertexSelection] = useState([0]);
  const [vertexGesture, setVertexGesture] = useState("move");
  const [faceDistance, setFaceDistance] = useState("1");
  const [splitAxis, setSplitAxis] = useState("0");
  const [splitCount, setSplitCount] = useState("2");
  const faceVertexPick = useRef(null);
  const [anims, setAnims] = useState([]);
  const [animPath, setAnimPath] = useState("");
  const [animId, setAnimId] = useState("");
  const [animDoc, setAnimDoc] = useState(null);
  const [animTime, setAnimTime] = useState(0);
  const [effectTab, setEffectTab] = useState("sound");
  const [keySelection, setKeySelection] = useState(null);
  const [keyShift, setKeyShift] = useState("0.25");
  const [animBusy, setAnimBusy] = useState(false);
  const animWrite = useRef(false);
  const animationContext = useRef("");
  const loadedAnimation = useRef("");
  const [playing, setPlaying] = useState(false);
  const [animStamp, setAnimStamp] = useState(0);
  const [controllerPreview, setControllerPreview] = useState(null);
  useEffect(() => { if (controllerPreview) setPlaying(false); }, [!!controllerPreview]);
  animationContext.current = JSON.stringify([animPath, animId, animStamp, opened?.worldId]);
  const [confirmAnim, setConfirmAnim] = useState("");
  const [animName, setAnimName] = useState("");
  const [animChannel, setAnimChannel] = useState("rotation");
  const [curveAxis, setCurveAxis] = useState(0);
  const [curvePart, setCurvePart] = useState("post");
  const [timelineView, setTimelineView] = useState("tracks");
  const [bezier, setBezier] = useState(null);
  const [animVec, setAnimVec] = useState([0, 0, 0]);
  const [copied, setCopied] = useState(null);
  const [animPast, setAnimPast] = useState(0);
  const [animFuture, setAnimFuture] = useState(0);
  const animHistory = useRef([]);
  const animCursor = useRef(0);
  const dragBase = useRef(null);
  const dragLocator = useRef(null);
  const dragDelta = useRef(null);
  const dragVertices = useRef(null), dragPicks = useRef([]), dragPreview = useRef(null), dragSnapTarget = useRef(null);
  const dragKind = useRef("move");
  const bonesRef = useRef([]);
  const history = useRef([]);
  const cursor = useRef(0);
  const historyKey = useRef("");
  const actions = useRef({});
  const paintActions = useRef({});
  const [past, setPast] = useState(0);
  const [future, setFuture] = useState(0);
  useEffect(() => {
    const onKey = (event) => {
      if (document.querySelector("dialog[open]")) return;
      if (dragBase.current) return;
      const tag = event.target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target?.isContentEditable || !!event.target?.closest('[role="combobox"],[role="separator"]');
      if (event.key === "Escape" && !typing && actions.current.pointAlign) { event.preventDefault(); actions.current.cancelPoint?.(); return; }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !typing) {
        const key = event.key.toLowerCase();
        if (key === "z") {
          event.preventDefault();
          const redo = event.shiftKey;
          if (desk === "paint") (redo ? paintActions.current.redo : paintActions.current.undo)?.();
          else (redo ? actions.current.redo : actions.current.undo)?.();
          return;
        }
        if (key === "y") {
          event.preventDefault();
          if (desk === "paint") paintActions.current.redo?.();
          else actions.current.redo?.();
          return;
        }
        if (key === "d" && desk === "edit") { event.preventDefault(); actions.current.duplicate?.(); return; }
      }
      if (event.ctrlKey || event.metaKey || event.altKey || typing) return;
      if (desk !== "edit") return;
      if (actions.current.pointAlign && !["Delete", "v", "r", "s", "p"].includes(event.key)) return;
      if (event.key === "Delete") { event.preventDefault(); actions.current.remove?.(); return; }
      const arrow = { arrowleft: [-1, 0, 0], arrowright: [1, 0, 0], arrowup: [0, 1, 0], arrowdown: [0, -1, 0], pageup: [0, 0, 1], pagedown: [0, 0, -1] }[event.key.toLowerCase()];
      if (arrow) {
        event.preventDefault();
        const step = event.shiftKey ? 4 : 1;
        actions.current.nudge?.(arrow.map(axis => axis * step), actions.current.tool);
        return;
      }
      const next = { v: "move", r: "rotate", s: "scale", p: "pivot" }[event.key.toLowerCase()];
      if (!next) return;
      event.preventDefault();
      setPointAlign(false);
      if (actions.current.tool === "vertex" && next !== "pivot") { actions.current.setVertexGesture?.(next); return; }
      setTool(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desk]);
  useEffect(() => {
    const track = event => { ctrl.current = event.ctrlKey || event.metaKey; };
    const clear = () => { ctrl.current = false; };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", clear);
    };
  }, []);
  useEffect(() => {
    let live = true;
    call("content.list-models").then(value => {
      if (!live) return;
      setLibrary(value.models || []);
    }).catch(reason => { if (live) setError(reason.message); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const key = (request?.path || "") + "|" + (request?.identifier || "");
    if (request?.path && key !== seen.current) { seen.current = key; setOpened(request); }
  }, [request?.path, request?.identifier, request?.worldId]);
  useEffect(() => {
    if (!opened?.path) { setDoc(null); return undefined; }
    let live = true;
    setError(""); setNotice("");
    call("content.read-geometry", { path: opened.path, worldId: opened.worldId }).then(value => {
      if (!live) return;
      const geometries = value.geometries || [];
      const stamped = geometries.map(item => ({ ...item, bones: ensureCubeIds(item.bones || []), display: item.display || {} }));
      const current = geometries.find(item => item.identifier === opened.identifier) || geometries[0];
      setDoc({ path: value.path, geometries: stamped });
      setIdentifier(current?.identifier || "");
      setMarks([]); setBoneMarks([]);
      setPicked(null);
      setTextureUrl("");
    }).catch(reason => { if (live) setError(reason.message); });
    return () => { live = false; };
  }, [opened?.path, opened?.identifier, opened?.worldId]);
  const geometry = doc?.geometries?.find(item => item.identifier === identifier) || null;
  const preview = useMemo(() => geometry ? { bones: geometry.bones || [], tw: geometry.textureWidth || 64, th: geometry.textureHeight || 64, hidden, faceTextures: true } : null, [geometry, hidden]);
  useEffect(() => { setHidden([]); setUvFace(""); }, [doc?.path, identifier]);
  const selectedKey = picked?.mesh ? picked.bone + ":mesh" : picked && Number.isInteger(picked.cube) ? picked.bone + ":" + picked.cube : "";
  const bone = geometry?.bones?.find(item => item.name === picked?.bone) || null;
  const cube = bone && Number.isInteger(picked?.cube) ? bone.cubes?.[picked.cube] : null;
  const meshWelds = picked?.mesh && bone?.poly_mesh ? [...new Set(bone.dgn_mesh_welds || bone.poly_mesh.positions.map((_, index) => index))] : [];
  let meshPoint = [0, 0, 0];
  if (meshWelds.length) { try { meshPoint = weldPoint(bone.poly_mesh, bone.dgn_mesh_welds, meshWelds.includes(vertexIndex) ? vertexIndex : meshWelds[0]); } catch { meshPoint = [0, 0, 0]; } }
  const vertices = cube ? cubeVertices(cube) : [];
  const locator = bone && picked?.locator ? bone.locators?.[picked.locator] || null : null;
  const slotPose = geometry ? displayPose(geometry.display, displaySlot) : null;
  const slotSaved = !!(geometry?.display && Object.hasOwn(geometry.display, displaySlot));
  const changeDisplay = (patch) => {
    try {
      setDoc(current => ({ ...current, geometries: current.geometries.map(item => item.identifier === identifier ? { ...item, display: assignDisplay(item.display, displaySlot, patch) } : item) }));
      setError("");
    } catch (reason) { setError(reason.message); }
  };
  const resetDisplay = () => setDoc(current => ({ ...current, geometries: current.geometries.map(item => item.identifier === identifier ? { ...item, display: clearDisplay(item.display, displaySlot) } : item) }));
  const markedCubes = (geometry?.bones || []).flatMap(item => (item.cubes || []).filter(cube => marks.includes(cube.dgnId)));
  const pointSession = useMemo(() => {
    if (!pointAlign || desk !== "edit") return null;
    try {
      const context = vertexSnapContext(geometry?.bones || [], marks, hidden);
      return { context, targets: [...context.targets.values()].flat() };
    } catch (reason) { return { error: reason.message }; }
  }, [pointAlign, desk, geometry, marks, hidden]);
  const chosenPoint = pointSource?.session === pointSession ? pointSource.vertex : null;
  const vertexMarkers = useMemo(() => {
    if (tool !== "vertex" || desk !== "edit" || marks.length > 1) return null;
    try {
      const selected = new Set(vertexSelection);
      if (picked?.mesh) return meshVertexMarkers(geometry?.bones || [], picked.bone, hidden).map(marker => ({ ...marker, selected: selected.has(marker.index) }));
      if (!Number.isInteger(picked?.cube)) return null;
      return cubeVertexMarkers(geometry?.bones || [], picked.bone, picked.cube, hidden).map(marker => ({ ...marker, selected: selected.has(marker.index) }));
    }
    catch { return []; }
  }, [tool, desk, geometry, picked?.bone, picked?.cube, picked?.mesh, marks.length, hidden, vertexSelection]);
  const vertexCenter = useMemo(() => {
    const selected = (vertexMarkers || []).filter(marker => marker.selected);
    if (!selected.length) return undefined;
    const sum = [0, 0, 0];
    for (const marker of selected) marker.point.toArray().forEach((value, axis) => { sum[axis] += value; });
    return sum.map(value => value / selected.length);
  }, [vertexMarkers]);
  useEffect(() => { setPointSource(null); }, [pointSession]);
  useEffect(() => { if (desk !== "edit" || tool !== "move") setPointAlign(false); }, [desk, tool]);
  useEffect(() => { if (desk !== "edit") setBoneMarks([]); }, [desk]);
  useEffect(() => {
    if (faceVertexPick.current) { setVertexSelection(faceVertexPick.current); setVertexIndex(faceVertexPick.current[0] ?? 0); faceVertexPick.current = null; }
    else { setVertexIndex(0); setVertexSelection([0]); }
    setElementName(cube?.name || "");
  }, [picked?.bone, picked?.cube, picked?.mesh, cube?.name]);
  const replaceBones = (bones, nextPick) => {
    setVertexTarget(null);
    const stamped = ensureCubeIds(bones);
    bonesRef.current = stamped;
    setDoc(current => ({ ...current, geometries: current.geometries.map(item => item.identifier === identifier ? { ...item, bones: stamped } : item) }));
    if (nextPick !== undefined) setPicked(nextPick);
    return stamped;
  };
  const selectionState = () => ({ marks: marks.slice(), boneMarks: boneMarks.slice(), picked, hidden: hidden.slice() });
  const restoreSelection = selection => {
    setMarks(selection.marks); setBoneMarks(selection.boneMarks || []); setPicked(selection.picked); setHidden(selection.hidden); setBoneName(selection.picked?.bone || ""); setLocatorName(selection.picked?.locator || ""); setUvFace("");
  };
  const captureSelection = () => {
    const current = history.current[cursor.current];
    if (current) history.current[cursor.current] = JSON.stringify({ ...JSON.parse(current), selection: selectionState() });
  };
  const commitHistory = (bones, selection = selectionState()) => {
    captureSelection();
    const current = history.current[cursor.current];
    if (current && JSON.stringify(JSON.parse(current).bones) === JSON.stringify(bones || [])) return;
    const recorded = remember(history.current, cursor.current, JSON.stringify({ bones: bones || [], selection }));
    history.current = recorded.stack;
    cursor.current = recorded.cursor;
    setPast(recorded.cursor);
    setFuture(recorded.stack.length - 1 - recorded.cursor);
  };
  const applyHistory = (nextCursor) => {
    captureSelection();
    const { bones, selection } = JSON.parse(history.current[nextCursor]);
    cursor.current = nextCursor;
    replaceBones(bones);
    restoreSelection(selection);
    setPast(nextCursor);
    setFuture(history.current.length - 1 - nextCursor);
  };
  const commitAnim = (next) => {
    const recorded = remember(animHistory.current, animCursor.current, JSON.stringify(next));
    animHistory.current = recorded.stack;
    animCursor.current = recorded.cursor;
    setAnimPast(recorded.cursor);
    setAnimFuture(recorded.stack.length - 1 - recorded.cursor);
    setAnimDoc(next);
  };
  const saveAnimChange = async (change, notice, after, historyIndex) => {
    if (animWrite.current || !animDoc || !animPath || loadedAnimation.current !== animationContext.current) return { error: "动画正在切换或保存，请稍后重试" };
    const context = animationContext.current;
    animWrite.current = true;
    setAnimBusy(true);
    try {
      const animation = change(animDoc);
      if (animation === animDoc) return { ok: true };
      await call("content.save-animation", { path: animPath, id: animId, worldId: opened?.worldId, animation });
      if (animationContext.current !== context) return { error: "动画已切换，请重新打开曲线工具" };
      if (historyIndex === undefined) commitAnim(animation);
      else {
        animCursor.current = historyIndex;
        setAnimDoc(animation);
        setAnimPast(historyIndex);
        setAnimFuture(animHistory.current.length - 1 - historyIndex);
      }
      after?.(animation);
      setNotice(notice);
      setError("");
      return { ok: true };
    } catch (reason) { if (animationContext.current === context) setError(reason.message); return { error: reason.message }; }
    finally { animWrite.current = false; setAnimBusy(false); }
  };
  const restoreAnim = (nextCursor, notice) => saveAnimChange(() => JSON.parse(animHistory.current[nextCursor]), notice, () => setKeySelection(null), nextCursor);
  const undo = () => {
    if (desk === "animate") { if (animCursor.current > 0) restoreAnim(animCursor.current - 1, "已撤销"); return; }
    if (cursor.current > 0) applyHistory(cursor.current - 1);
  };
  const redo = () => {
    if (desk === "animate") { if (animCursor.current < animHistory.current.length - 1) restoreAnim(animCursor.current + 1, "已重做"); return; }
    if (cursor.current < history.current.length - 1) applyHistory(cursor.current + 1);
  };
  actions.current = { undo, redo };
  useEffect(() => {
    if (!geometry) return;
    const key = (doc?.path || "") + ":" + identifier;
    if (historyKey.current === key) return;
    historyKey.current = key;
    history.current = [JSON.stringify({ bones: geometry.bones || [], selection: { marks: [], boneMarks: [], picked: null, hidden: [] } })];
    cursor.current = 0;
    bonesRef.current = geometry.bones || [];
    setPast(0);
    setFuture(0);
  }, [doc?.path, identifier, geometry]);
  const animClip = useMemo(() => desk === "animate" && animDoc ? clipFromBedrock(animDoc) : null, [desk, animDoc]);
  const channelName = animChannel === "position" || animChannel === "scale" ? animChannel : "rotation";
  const channelSource = animDoc?.bones?.[bone?.name]?.[channelName];
  const channelKeys = useMemo(() => trackOf(channelSource), [channelSource]);
  const expressionChannel = hasExpressions(channelSource);
  const currentKeyTimes = keyTimes(animDoc, bone?.name, animChannel);
  const scopedKeys = keySelection?.context === animationContext.current;
  const selectedKeys = scopedKeys ? keySelection.items : [];
  const operationKeys = scopedKeys ? selectedKeys : currentKeyTimes.filter(time => Math.abs(time - animTime) < 0.001).map(time => ({ bone: bone.name, channel: animChannel, time }));
  const selectionTracks = new Set(selectedKeys.map(item => JSON.stringify([item.bone, item.channel]))).size;
  const firstSelectedTime = operationKeys.length ? Math.min(...operationKeys.map(item => item.time)) : 0;
  useEffect(() => {
    setKeySelection(current => current?.context === animationContext.current ? current : null);
  }, [animPath, animId, animStamp]);
  const previewTime = animClip ? clipTime(animClip, animTime) : animTime;
  const previewErrors = useMemo(() => {
    const errors = [];
    for (const [name, channels] of Object.entries(animClip?.bones || {})) {
      for (const [channel, keys] of Object.entries(channels)) {
        sampleTrack(keys, previewTime, message => errors.push(name + " / " + ({ r: "旋转", p: "位移", s: "缩放" }[channel]) + "：" + message));
      }
    }
    return errors;
  }, [animClip, previewTime]);
  useEffect(() => {
    if (desk !== "animate") setPlaying(false);
  }, [desk]);
  useEffect(() => {
    setAnimName(animId.startsWith("animation.") ? animId.slice("animation.".length) : animId);
  }, [animId]);
  useEffect(() => {
    if (desk !== "animate" || !doc?.path) return undefined;
    let live = true;
    setAnims([]);
    call("content.list-animations", { path: doc.path, worldId: opened?.worldId }).then(value => {
      if (!live) return;
      const list = value.animations || [];
      setAnims(list);
      if (!list.length) { setAnimPath(""); setAnimId(""); setAnimDoc(null); }
      if (list[0] && !list.some(item => item.path === animPath && item.id === animId)) { setAnimPath(list[0].path); setAnimId(list[0].id); }
    }).catch(reason => { if (live) setError(reason.message); });
    return () => { live = false; };
  }, [desk, doc?.path, opened?.worldId, animStamp]);
  useEffect(() => {
    if (!animPath) return undefined;
    let live = true;
    const context = animationContext.current;
    loadedAnimation.current = "";
    setAnimDoc(null);
    setKeySelection(null);
    setPlaying(false); setAnimTime(0);
    call("content.read-animation", { path: animPath, id: animId, worldId: opened?.worldId }).then(value => {
      if (!live) return;
      setAnimId(value.id);
      setAnimDoc(value.animation);
      loadedAnimation.current = context;
      animHistory.current = [JSON.stringify(value.animation)];
      animCursor.current = 0;
      setAnimPast(0);
      setAnimFuture(0);
    }).catch(reason => { if (live) setError(reason.message); });
    return () => { live = false; };
  }, [animPath, animId, opened?.worldId, animStamp]);
  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    let last = performance.now();
    const tick = now => {
      const step = (now - last) / 1000;
      last = now;
      setAnimTime(current => {
        const length = Number(animDoc?.animation_length) || 1;
        const next = current + step;
        return animDoc?.loop === false || animDoc?.loop === "hold_on_last_frame" ? Math.min(next, length) : next % length;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, animDoc]);
  useEffect(() => {
    const sampled = sampleTrack(channelKeys, previewTime);
    if (sampled) setAnimVec(sampled.map(item => Math.round(item * 1000) / 1000));
    else setAnimVec(animChannel === "scale" ? [1, 1, 1] : [0, 0, 0]);
  }, [channelKeys, animChannel, previewTime]);
  const onTransform = (kind, delta, phase) => {
    if (!geometry) return;
    const step = !snap ? 0 : kind === "rotate" ? 15 : 1;
    const amount = snapDelta(delta, step);
    if (phase === "start") {
      if (kind === "vertex") {
        if (picked?.mesh) {
          if (!vertexSelection.length) { setError("请选择一个顶点"); return false; }
          dragLocator.current = null; dragVertices.current = { mesh: true, bone: picked.bone, indices: vertexSelection.slice() }; dragBase.current = bonesRef.current; dragKind.current = "vertex"; dragDelta.current = null; dragPreview.current = null; dragSnapTarget.current = null; setError(""); return true;
        }
        if (!Number.isInteger(picked?.cube) || marks.length > 1) { setError("顶点工具一次只编辑一个立方体"); return false; }
        if (!vertexSelection.length) { setError("请选择一个顶点"); return false; }
        dragLocator.current = null; dragVertices.current = { indices: vertexSelection.slice(), gesture: vertexGesture }; dragBase.current = bonesRef.current; dragKind.current = "vertex"; dragDelta.current = null; dragPreview.current = null; dragSnapTarget.current = null; setError(""); return true;
      }
      if (picked?.locator) {
        if (kind === "scale") { setError("定位器不能缩放"); return false; }
        dragVertices.current = null; dragLocator.current = { bone: picked.bone, name: picked.locator };
        dragBase.current = bonesRef.current; dragKind.current = kind; dragDelta.current = null; dragPreview.current = null; dragSnapTarget.current = null; setVertexTarget(null); setError(""); return true;
      }
      dragLocator.current = null;
      try {
        const base = bonesRef.current;
        dragVertices.current = vertexSnap && marks.length && kind === "move" ? vertexSnapContext(base, marks, hidden) : null;
        dragBase.current = base; dragPicks.current = picksOf(base); dragKind.current = kind; dragDelta.current = null; dragPreview.current = null; dragSnapTarget.current = null; setVertexTarget(null); return true;
      } catch (reason) { dragBase.current = null; dragVertices.current = null; setError(reason.message); return false; }
    }
    if (phase === "cancel") {
      if (dragBase.current) replaceBones(dragBase.current);
      dragBase.current = null; dragVertices.current = null; dragLocator.current = null; dragPreview.current = null; setVertexTarget(null); return;
    }
    if (phase === "end") {
      const base = dragBase.current;
      const last = dragDelta.current;
      const used = dragKind.current;
      const locatorDrag = dragLocator.current;
      dragBase.current = null;
      dragVertices.current = null;
      dragLocator.current = null;
      if (!base || !last) return;
      const next = dragPreview.current || (locatorDrag ? transformLocator(base, locatorDrag.bone, locatorDrag.name, used === "rotate" ? "rotate" : "move", last) : transformMany(base, dragPicks.current, used, last));
      dragPreview.current = null;
      commitHistory(replaceBones(next));
      setVertexTarget(dragSnapTarget.current);
      return;
    }
    if (!dragBase.current) return;
    dragDelta.current = amount;
    dragKind.current = kind;
    if (dragLocator.current) {
      try {
        dragPreview.current = transformLocator(dragBase.current, dragLocator.current.bone, dragLocator.current.name, kind === "rotate" ? "rotate" : "move", amount);
        replaceBones(dragPreview.current); setError("");
      } catch (reason) { replaceBones(dragBase.current); dragPreview.current = null; dragDelta.current = null; setError(reason.message); }
      return;
    }
    if (dragKind.current === "vertex") {
      try {
        dragPreview.current = dragVertices.current?.mesh ? dragVertices.current.indices.reduce((next, index) => moveMeshVertex(next, dragVertices.current.bone, index, amount), dragBase.current) : transformVertices(dragBase.current, picked.bone, picked.cube, dragVertices.current.indices, dragVertices.current.gesture, amount);
        replaceBones(dragPreview.current); setError("");
      } catch (reason) { replaceBones(dragBase.current); dragPreview.current = null; dragDelta.current = null; setError(reason.message); }
      return;
    }
    try {
      const result = dragVertices.current ? moveWithVertexSnap(dragVertices.current, amount) : null;
      dragPreview.current = result ? result.bones : transformMany(dragBase.current, dragPicks.current, kind, amount);
      replaceBones(dragPreview.current); setError("");
      if (result) { dragSnapTarget.current = result.target; setVertexTarget(result.target); }
    } catch (reason) { replaceBones(dragBase.current); dragPreview.current = null; dragDelta.current = null; setVertexTarget(null); setError(reason.message); }
  };
  const edit = (change, nextPick) => {
    try {
      const next = replaceBones(change(bonesRef.current.length ? bonesRef.current : (geometry.bones || [])), nextPick);
      const selection = nextPick === undefined ? selectionState() : { ...selectionState(), picked: nextPick, boneMarks: nextPick?.bone && !Number.isInteger(nextPick.cube) && !nextPick.locator && !nextPick.mesh ? [nextPick.bone] : [], marks: Number.isInteger(nextPick?.cube) ? [next.find(bone => bone.name === nextPick.bone).cubes[nextPick.cube].dgnId] : [] };
      commitHistory(next, selection);
      if (nextPick !== undefined) restoreSelection(selection);
      setError("");
      return next;
    }
    catch (reason) { setError(reason.message); return null; }
  };
  const finishOutlineDrag = () => { dragBone.current = null; setDropTarget(""); };
  const startBoneDrag = (event, name) => {
    if (saving) { event.preventDefault(); return; }
    const names = boneMarks.includes(name) ? boneMarks.slice() : [name];
    if (!boneMarks.includes(name)) chooseBone(name, false);
    dragBone.current = { kind: "bone", names, bones: bonesRef.current, context: (doc?.path || "") + "|" + identifier };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "model-bone");
  };
  const startCubeDrag = (event, name, index) => {
    if (saving) { event.preventDefault(); return; }
    const cube = bonesRef.current.find(bone => bone.name === name)?.cubes?.[index];
    if (!cube?.dgnId) { event.preventDefault(); return; }
    const ids = marks.includes(cube.dgnId) ? marks.slice() : [cube.dgnId];
    if (!marks.includes(cube.dgnId)) chooseCube(name, index, false);
    dragBone.current = { kind: "cube", ids, bones: bonesRef.current, keepPose: keepMovePose, context: (doc?.path || "") + "|" + identifier };
    event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", "model-elements");
  };
  const hoverOutline = (event, key) => {
    if (!dragBone.current || saving) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(key);
  };
  const moveMarkedCubes = (target, ids = marks, beforeId = null, keepPose = keepMovePose) => {
    if (saving) return;
    try {
      const moved = (keepPose ? moveCubesKeepingPose : moveCubes)(bonesRef.current, ids, target, beforeId);
      if (moved.bones === bonesRef.current) return;
      const selection = { ...selectionState(), marks: moved.ids, picked: moved.picked };
      commitHistory(replaceBones(moved.bones), selection); restoreSelection(selection);
      const ancestors = new Set([target]);
      let parent = moved.bones.find(bone => bone.name === target)?.parent;
      while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = moved.bones.find(bone => bone.name === parent)?.parent; }
      setFolded(current => current.filter(name => !ancestors.has(name)));
      setError(""); setNotice("已移动 " + moved.ids.length + " 个立方体，可一次撤销");
    } catch (reason) { setError(reason.message); }
  };
  const dropParent = (parent, cubeAt) => {
    const item = dragBone.current;
    finishOutlineDrag();
    const next = parent || "";
    if (!item || saving) return;
    if (item.kind === "cube") {
      if (item.context !== (doc?.path || "") + "|" + identifier || item.bones !== bonesRef.current) { setError("模型在拖动期间变化，请重新拖动"); return; }
      const target = bonesRef.current.find(bone => bone.name === next);
      const beforeId = Number.isInteger(cubeAt) ? target?.cubes?.[cubeAt]?.dgnId : null;
      if (beforeId === undefined) { setError("目标位置已变化，请重新拖动"); return; }
      moveMarkedCubes(next, item.ids, beforeId, item.keepPose);
      return;
    }
    if (item.context !== (doc?.path || "") + "|" + identifier || item.bones !== bonesRef.current) { setError("模型在拖动期间变化，请重新拖动"); return; }
    try { editBoneParent(next, item.names); } catch (reason) { setError(reason.message); }
  };
  const duplicate = () => {
    if (!picked?.bone || saving) return;
    try {
      const before = bonesRef.current.length ? bonesRef.current : (geometry.bones || []);
      if (picked.locator) {
        const created = duplicateLocator(before, picked.bone, picked.locator);
        edit(() => created.bones, { bone: picked.bone, cube: null, locator: created.name });
        return;
      }
      if (picked.mesh) {
        const created = duplicateSelection(before, picked);
        edit(() => created.bones, { bone: created.picked.bone, cube: null, mesh: true });
        return;
      }
      if (marks.length) {
        const created = duplicateCubes(before, marks);
        const selection = { ...selectionState(), marks: created.ids, picked: created.picked };
        commitHistory(replaceBones(created.bones), selection); restoreSelection(selection);
        setError(""); setNotice("已复制 " + created.ids.length + " 个立方体，可一次撤销"); return;
      }
      if (boneMarks.length) {
        const created = duplicateBones(before, boneMarks);
        const selection = { ...selectionState(), boneMarks: created.names, marks: [], picked: { bone: created.names.at(-1), cube: null } };
        commitHistory(replaceBones(created.bones), selection); restoreSelection(selection);
        setError(""); setNotice("已复制所选骨骼及子级，可一次撤销"); return;
      }
      const created = duplicateSelection(bonesRef.current.length ? bonesRef.current : (geometry.bones || []), picked);
      edit(() => created.bones, created.picked);
    } catch (reason) { setError(reason.message); }
  };
  actions.current.duplicate = duplicate;
  const removeSelected = () => {
    if (!picked?.bone || saving) return;
    try {
      if (picked.mesh) {
        edit(bones => removeMesh(bones, picked.bone), { bone: picked.bone, cube: null });
        return;
      }
      if (picked.locator) {
        edit(bones => removeLocator(bones, picked.bone, picked.locator), { bone: picked.bone, cube: null });
        return;
      }
      if (marks.length) {
        const next = deleteCubes(bonesRef.current, marks);
        const selection = { marks: [], picked: null, hidden: hidden.filter(id => !marks.includes(id)) };
        commitHistory(replaceBones(next), selection); restoreSelection(selection);
        setError(""); setNotice("已删除 " + new Set(marks).size + " 个立方体，可一次撤销");
      } else if (boneMarks.length) {
        const next = deleteBones(bonesRef.current, boneMarks);
        const remaining = new Set(next.flatMap(item => [item.name, ...(item.cubes || []).map(cube => cube.dgnId)]));
        const selection = { marks: [], boneMarks: [], picked: null, hidden: hidden.filter(key => remaining.has(key)) };
        commitHistory(replaceBones(next), selection); restoreSelection(selection);
        setError(""); setNotice("已删除所选骨骼，保留未选中的子级，可一次撤销");
      } else if (Number.isInteger(picked.cube)) edit(bones => removeCube(bones, bone.name, picked.cube), { bone: bone.name, cube: null });
      else edit(bones => removeBone(bones, bone.name), null);
    } catch (reason) { setError(reason.message); }
  };
  actions.current.remove = removeSelected;
  const nudge = (delta, kind = "move") => {
    const used = kind || "move";
    const amount = snapDelta(delta, !snap ? 0 : used === "rotate" ? 15 : 1);
    if (picked?.locator) {
      if (used === "scale") { setError("定位器不能缩放"); return; }
      edit(bones => transformLocator(bones, picked.bone, picked.locator, used === "rotate" ? "rotate" : "move", amount));
      return;
    }
    if (vertexSnap && marks.length && used === "move") {
      try {
        const result = moveWithVertexSnap(vertexSnapContext(bonesRef.current, marks, hidden), amount);
        commitHistory(replaceBones(result.bones)); setVertexTarget(result.target); setError("");
      } catch (reason) { setError(reason.message); }
      return;
    }
    if (used === "vertex") {
      if (picked?.mesh) {
        const sized = snapDelta(delta, !snap ? 0 : 1);
        edit(bones => vertexSelection.reduce((next, index) => moveMeshVertex(next, picked.bone, index, sized), bones));
        return;
      }
      if (!Number.isInteger(picked?.cube) || marks.length > 1) { setError("顶点工具一次只编辑一个立方体"); return; }
      const gesture = vertexGesture === "rotate" || vertexGesture === "scale" ? vertexGesture : "move";
      const sized = snapDelta(delta, !snap ? 0 : gesture === "rotate" ? 15 : 1);
      edit(bones => transformVertices(bones, picked.bone, picked.cube, vertexSelection, gesture, sized));
      return;
    }
    if (picked?.bone || marks.length) edit(bones => transformMany(bones, picksOf(bones), used, amount));
  };
  actions.current.nudge = nudge;
  actions.current.tool = tool;
  actions.current.setVertexGesture = setVertexGesture;
  actions.current.pointAlign = pointAlign;
  actions.current.cancelPoint = () => { setPointAlign(false); setPointSource(null); };
  const chooseVertex = (vertex, toggle) => {
    if (tool === "vertex") {
      if (!Number.isInteger(vertex?.index)) return;
      setVertexIndex(vertex.index);
      setVertexSelection(current => toggle ? (current.includes(vertex.index) ? current.filter(index => index !== vertex.index) : [...current, vertex.index]) : [vertex.index]);
      return;
    }
    if (saving || !pointSession?.context || pointSession.context.bones !== bonesRef.current) return;
    if (!chosenPoint) {
      if (pointSession.context.sources.includes(vertex)) setPointSource({ session: pointSession, vertex });
      return;
    }
    try {
      const result = alignVertexPoints(pointSession.context, chosenPoint, vertex, pointAxis);
      if (result.bones !== bonesRef.current) commitHistory(replaceBones(result.bones));
      setPointSource(null); setVertexTarget({ bone: vertex.bone, cube: vertex.cube, point: result.point });
      setNotice("已按" + (pointAxis === "all" ? "三轴" : pointAxis.toUpperCase() + " 轴") + "对齐顶点，可一次撤销"); setError("");
    } catch (reason) { setError(reason.message); }
  };
  useEffect(() => { setVertexTarget(null); }, [vertexSnap, tool, desk, doc?.path, identifier, marks.join("|"), hidden.join("|")]);
  function picksOf(bones) {
    if (boneMarks.length && !marks.length && !picked?.locator) {
      const { selected } = boneSelection(bones, boneMarks);
      return [...selected.keys()].map(name => ({ bone: name, cube: null }));
    }
    const list = [];
    for (const id of marks) {
      for (const item of bones || []) {
        const index = (item.cubes || []).findIndex(cube => cube.dgnId === id);
        if (index >= 0) list.push({ bone: item.name, cube: index });
      }
    }
    if (!list.length && picked?.bone) return [picked];
    return list;
  }
  function chooseCube(boneName, index, toggle, face = "") {
    setBoneMarks([]);
    const chosen = (geometry?.bones || []).find(item => item.name === boneName)?.cubes?.[index];
    const id = chosen?.dgnId || "";
    const chosenFace = faceNames.includes(face) && (Array.isArray(chosen?.uv) || chosen?.uv?.[face]) && !(toggle && marks.includes(id)) ? face : "";
    setUvFace(chosenFace);
    if (chosenFace) paintActions.current.revealFace?.(chosen?.uv?.[chosenFace]?.dgn_texture);
    if (!toggle || !id) {
      setMarks(id ? [id] : []);
      setPicked({ bone: boneName, cube: index });
      setBoneName(boneName);
      return;
    }
    const has = marks.includes(id);
    const next = has ? marks.filter(item => item !== id) : [...marks, id];
    setMarks(next);
    if (!has) { setPicked({ bone: boneName, cube: index }); setBoneName(boneName); return; }
    if (picked?.bone !== boneName || picked.cube !== index) return;
    const left = next[next.length - 1];
    if (!left) { setPicked(null); return; }
    for (const item of geometry?.bones || []) {
      const at = (item.cubes || []).findIndex(cube => cube.dgnId === left);
      if (at >= 0) { setPicked({ bone: item.name, cube: at }); setBoneName(item.name); return; }
    }
    setPicked(null);
  }
  function chooseFaceVertices(boneName, index, face, toggle) {
    const corners = faceCorners[face];
    if (!corners || saving) return;
    const same = picked?.bone === boneName && picked?.cube === index && marks.length <= 1;
    if (!same) { faceVertexPick.current = corners.slice(); chooseCube(boneName, index, false, face); return; }
    setUvFace(faceNames.includes(face) ? face : "");
    setVertexIndex(corners[0]);
    setVertexSelection(current => {
      if (!toggle) return corners.slice();
      const next = new Set(current);
      if (corners.every(item => next.has(item))) corners.forEach(item => next.delete(item));
      else corners.forEach(item => next.add(item));
      return [...next];
    });
  }
  function extrudeSelectedFace() {
    const face = selectedFace();
    if (!face || !bone || !Number.isInteger(picked?.cube)) { setError("请先点击要挤出的面"); return; }
    const at = (bone.cubes || []).length;
    if (edit(bones => extrudeCubeFace(bones, bone.name, picked.cube, face), { bone: bone.name, cube: at })) setNotice("已挤出这一面，可一次撤销");
  }
  function selectedFace() {
    const selected = vertexSelection.slice().sort((a, b) => a - b).join(",");
    const matched = Object.entries(faceCorners).find(([, corners]) => corners.slice().sort((a, b) => a - b).join(",") === selected);
    return faceCorners[uvFace] ? uvFace : matched?.[0] || "";
  }
  function reshapeFace(kind) {
    const face = selectedFace();
    const distance = Number(faceDistance);
    if (!face || !bone || !Number.isInteger(picked?.cube)) { setError("请先点击要调整的面"); return; }
    const amount = kind === "in" ? -Math.abs(distance) : Math.abs(distance);
    if (edit(bones => (kind === "inset" ? insetFace : pushFace)(bones, bone.name, picked.cube, face, kind === "inset" ? Math.abs(distance) : amount))) setNotice(kind === "inset" ? "已收缩这一面，可一次撤销" : "已移动这一面，可一次撤销");
  }
  function splitSelectedCube() {
    if (!bone || !Number.isInteger(picked?.cube)) { setError("请选择一个立方体"); return; }
    const axis = Number(splitAxis), count = Number(splitCount);
    if (edit(bones => splitCube(bones, bone.name, picked.cube, axis, count), { bone: bone.name, cube: picked.cube })) setNotice("已沿" + "XYZ"[axis] + " 轴切开 " + count + " 段，可一次撤销");
  }
  function convertSelectedCube() {
    if (!bone || !Number.isInteger(picked?.cube)) { setError("请选择一个立方体"); return; }
    if (edit(bones => convertCubeToMesh(bones, bone.name, picked.cube), { bone: bone.name, cube: null, mesh: true })) setNotice("已转为网格，共用角点会一起移动，可一次撤销");
  }
  function chooseBone(name, additive) {
    if (saving) return;
    setMarks([]);
    setPointAlign(false);
    setLocatorName("");
    setUvFace("");
    const base = boneMarks.length ? boneMarks : (picked?.bone && !Number.isInteger(picked.cube) && !picked.locator && !picked.mesh ? [picked.bone] : []);
    const next = !additive ? [name] : base.includes(name) ? base.filter(item => item !== name) : [...base, name];
    setBoneMarks(next);
    const focus = next.includes(name) ? name : next[next.length - 1];
    if (focus) { setPicked({ bone: focus, cube: null }); setBoneName(focus); }
    else setPicked(null);
  }
  const editBoneProperty = (property, axis, value, mode) => {
    const current = bonesRef.current.length ? bonesRef.current : (geometry?.bones || []);
    const changed = changeBoneProperty(current, boneMarks, property, axis, value, mode);
    if (changed !== current) commitHistory(replaceBones(changed));
    setError("");
  };
  const editBoneParent = (parent, names = boneMarks) => {
    if (saving) return;
    const current = bonesRef.current;
    const changed = reparentBones(current, names, parent);
    if (changed === current) return;
    commitHistory(replaceBones(changed));
    setFolded(value => value.filter(name => name !== parent));
    setError(""); setNotice("已调整骨骼父级，可一次撤销");
  };
  const mirrorAxis = (axis) => {
    const before = bonesRef.current.length ? bonesRef.current : (geometry?.bones || []);
    let created;
    try { created = mirrorSelection(before, picksOf(before), axis); }
    catch (reason) { setError(reason.message); return; }
    const old = new Set();
    for (const item of before) for (const cube of item.cubes || []) if (cube.dgnId) old.add(cube.dgnId);
    const stamped = edit(() => created.bones, created.picked);
    if (!stamped) return;
    const ids = [];
    for (const item of stamped) for (const cube of item.cubes || []) if (cube.dgnId && !old.has(cube.dgnId)) ids.push(cube.dgnId);
    if (ids.length) setMarks(ids);
  };
  const unwrapUv = () => edit(bones => unwrapSelection(bones, picksOf(bones)));
  const assignMaterial = (path, face) => {
    if (picked?.mesh && bone?.poly_mesh?.polys?.length) {
      const index = Math.min(meshFace, bone.poly_mesh.polys.length - 1);
      if (edit(bones => setMeshFaceTexture(bones, bone.name, index, path))) setNotice(path ? "已分配网格面贴图，保存模型后写入" : "已取消网格面贴图，保存模型后写入");
      return;
    }
    const current = bonesRef.current, ids = marks.length ? marks : cube?.dgnId ? [cube.dgnId] : [];
    const changed = assignFaceTexture(current, ids, face || "", path);
    commitHistory(replaceBones(changed)); setError(""); setNotice("已分配面贴图，保存模型后写入");
  };
  const marqueeSelect = (keys, additive) => {
    setUvFace("");
    const ids = keys.map(key => {
      const split = key.lastIndexOf(":");
      if (split <= 0) return "";
      const bone = geometry?.bones?.find(item => item.name === key.slice(0, split));
      return bone?.cubes?.[Number(key.slice(split + 1))]?.dgnId || "";
    }).filter(Boolean);
    const next = additive ? [...new Set([...marks, ...ids])] : ids;
    setMarks(next); setBoneMarks([]);
    const first = (additive ? keys[0] : keys[0]) || "";
    const split = first.lastIndexOf(":");
    if (split > 0) { const name = first.slice(0, split), index = Number(first.slice(split + 1)); setPicked({ bone: name, cube: index }); setBoneName(name); }
    else if (!additive) setPicked(null);
  };
  const editMarkedProperty = (property, axis, value, mode) => {
    const current = bonesRef.current;
    const changed = changeCubeProperty(current, marks, property, axis, value, mode);
    if (changed !== current) commitHistory(replaceBones(changed));
    setError("");
  };
  const save = async () => {
    if (!geometry) return;
    setSaving(true); setNotice(""); setError("");
    try {
      await call("content.save-geometry", { path: doc.path, worldId: opened?.worldId, identifier, bones: geometry.bones, textureWidth: geometry.textureWidth, textureHeight: geometry.textureHeight, display: geometry.display || {} });
      setNotice("已写回模型文件，原文件保存在同名 .bak");
    } catch (reason) { setError(reason.message); }
    finally { setSaving(false); }
  };
  const createAnim = async () => {
    try {
      const created = await call("content.create-animation", { modelPath: doc.path, worldId: opened?.worldId, name: "idle" });
      setAnimPath(created.path);
      setAnimId(created.id);
      setAnimStamp(value => value + 1);
      setError("");
      setNotice("");
    } catch (reason) { setError(reason.message); }
  };
  const deleteAnim = async () => {
    if (!animPath || !animId) return;
    const key = animPath + "|" + animId;
    if (confirmAnim !== key) { setConfirmAnim(key); return; }
    try {
      await call("content.delete-animation", { path: animPath, id: animId, worldId: opened?.worldId });
      setConfirmAnim("");
      setAnimPath("");
      setAnimId("");
      setAnimDoc(null);
      setAnimStamp(value => value + 1);
      setNotice("已删除动画");
      setError("");
    } catch (reason) { setError(reason.message); }
  };
  const duplicateAnim = async () => {
    if (!animPath || !animId) return;
    try {
      const created = await call("content.duplicate-animation", { path: animPath, id: animId, worldId: opened?.worldId });
      setAnimPath(created.path);
      setAnimId(created.id);
      setAnimStamp(value => value + 1);
      setNotice("已复制动画");
      setError("");
    } catch (reason) { setError(reason.message); }
  };
  const renameAnim = async () => {
    const raw = animName.trim();
    const nextId = "animation." + raw;
    if (!animPath || !animId || nextId === animId) return;
    try {
      const renamed = await call("content.rename-animation", { path: animPath, id: animId, name: raw, worldId: opened?.worldId });
      setAnimId(renamed.id);
      setAnimStamp(value => value + 1);
      setNotice(renamed.references ? "已重命名动画，并更新了 " + renamed.references + " 个引用文件" : "已重命名动画");
      setError("");
    } catch (reason) { setError(reason.message); }
  };
  const selectKey = (name, channel, time, { toggle = false, range = false } = {}) => {
    setPlaying(false); setPicked({ bone: name, cube: null }); setBoneName(name);
    setAnimTime(time);
    setAnimChannel(channel);
    const same = keySelection?.context === animationContext.current;
    const available = keyTimes(animDoc, name, channel);
    const previous = same ? keySelection.items : [];
    const item = { bone: name, channel, time };
    const sameItem = key => key.bone === name && key.channel === channel && key.time === time;
    const previousAnchor = same ? keySelection.anchor : null;
    const anchor = previousAnchor?.bone === name && previousAnchor.channel === channel && available.includes(previousAnchor.time) ? previousAnchor : item;
    let items = [item];
    if (range) {
      const interval = available.filter(at => at >= Math.min(anchor.time, time) && at <= Math.max(anchor.time, time)).map(at => ({ bone: name, channel, time: at }));
      items = [...previous.filter(key => key.bone !== name || key.channel !== channel), ...interval];
    } else if (toggle) items = previous.some(sameItem) ? previous.filter(key => !sameItem(key)) : [...previous, item];
    setKeySelection({ context: animationContext.current, items, anchor: range ? anchor : item });
  };
  const keyChannel = () => {
    if (!bone || expressionChannel) return;
    return saveAnimChange(doc => setBoneKey(doc, bone.name, animChannel, animTime, animVec), "已写入关键帧");
  };
  const curveCommit = (time, value) => {
    if (!bone || expressionChannel) return;
    setPlaying(false);
    return saveAnimChange(doc => moveCurveKey(doc, bone.name, animChannel, time, time, curveAxis, value, curvePart), "已改曲线", () => selectKey(bone.name, animChannel, time));
  };
  const curveInsert = time => {
    if (!bone || expressionChannel || animBusy) return;
    setPlaying(false);
    return saveAnimChange(doc => insertCurveKey(doc, bone.name, animChannel, time), "已插入曲线关键帧", () => {
      setAnimTime(time);
      const item = { bone: bone.name, channel: animChannel, time };
      setKeySelection({ context: animationContext.current, items: [item], anchor: item });
    });
  };
  const curveDelete = time => {
    if (!bone || expressionChannel || animBusy) return;
    setPlaying(false);
    return saveAnimChange(doc => deleteCurveKey(doc, bone.name, animChannel, time), "已删除曲线关键帧", () => setKeySelection(null));
  };
  const curveMove = (from, to, value) => {
    if (!bone || expressionChannel || animBusy) return;
    setPlaying(false);
    return saveAnimChange(doc => moveCurveKey(doc, bone.name, animChannel, from, to, curveAxis, value, curvePart), "已移动曲线关键帧", () => {
      setAnimTime(to);
      const item = { bone: bone.name, channel: animChannel, time: to };
      setKeySelection({ context: animationContext.current, items: [item], anchor: item });
    });
  };
  const openBezier = (native = false) => {
    if (!bone || !animDoc || animBusy || expressionChannel) return;
    setPlaying(false);
    setBezier({ animation: animDoc, bone: bone.name, channel: animChannel, axis: curveAxis, time: animTime, context: animationContext.current, native: native === true });
  };
  const applyBezier = async (start, control) => {
    if (!bezier || bezier.context !== animationContext.current || bezier.animation !== animDoc) throw Error("动画已变化，请重新打开曲线工具");
    const result = await saveAnimChange(animation => bakeBezier(animation, bezier.bone, bezier.channel, start, bezier.axis, control), "已生成贝塞尔关键帧，可一次撤销", () => { setKeySelection(null); setAnimTime(start); });
    if (!result?.ok) throw Error(result?.error || "动画未保存，请重试");
  };
  const applyNativeBezier = async (frames, start) => {
    if (!bezier || bezier.context !== animationContext.current || bezier.animation !== animDoc) throw Error("动画已变化，请重新打开控制柄编辑器");
    const result = await saveAnimChange(animation => updateNativeBezier(animation, bezier.bone, bezier.channel, frames), "已更新原生控制柄，可一次撤销", () => { setKeySelection(null); setAnimTime(start); });
    if (!result?.ok) throw Error(result?.error || "动画未保存，请重试");
  };
  const clearKey = () => {
    if (!operationKeys.length) return;
    return saveAnimChange(doc => clearKeySelection(doc, operationKeys), "已删除 " + operationKeys.length + " 个关键帧", () => setKeySelection(null));
  };
  const moveKey = mark => {
    if (!mark.selection?.length) return;
    setPlaying(false);
    return saveAnimChange(doc => moveKeySelection(doc, mark.selection, mark.delta), "已移动 " + mark.selection.length + " 个关键帧", () => {
      const items = mark.selection.map(item => ({ ...item, time: Math.round((item.time + mark.delta) * 1e6) / 1e6 }));
      setPicked({ bone: mark.bone, cube: null }); setBoneName(mark.bone); setAnimChannel(mark.channel);
      setAnimTime(Math.min(...items.map(item => item.time)));
      setKeySelection({ context: animationContext.current, items, anchor: items[0] });
    });
  };
  const retimeKey = value => {
    if (!bone || !operationKeys.length) return;
    const at = Number(value);
    if (!Number.isFinite(at) || value === "") return;
    moveKey({ bone: bone.name, channel: animChannel, selection: operationKeys, delta: at - firstSelectedTime });
  };
  const shiftKeys = () => {
    if (!bone || !operationKeys.length) return;
    const delta = Number(keyShift);
    if (!Number.isFinite(delta) || keyShift === "") { setError("请输入移动秒数"); return; }
    moveKey({ bone: bone.name, channel: animChannel, selection: operationKeys, delta: Math.round(delta * 20) / 20 });
  };
  const saveMode = mode => {
    if (!bone || expressionChannel) return;
    return saveAnimChange(doc => setKeyMode(doc, bone.name, animChannel, animTime, mode), "已更新插值");
  };
  const copyKey = () => {
    if (!animDoc || !bone || !operationKeys.length) return;
    try {
      setCopied(copyKeySelection(animDoc, operationKeys));
      setNotice("已复制 " + operationKeys.length + " 个关键帧"); setError("");
    } catch (reason) { setError(reason.message); }
  };
  const pasteKey = () => {
    if (!copied || !bone) return;
    const at = Math.round(animTime * 20) / 20;
    setPlaying(false);
    let pasted;
    const count = copied.tracks.reduce((sum, track) => sum + track.frames.length, 0);
    return saveAnimChange(doc => {
      pasted = pasteKeySelection(doc, copied, at, (geometry?.bones || []).map(item => item.name), bone.name);
      return pasted.animation;
    }, "已粘贴 " + count + " 个关键帧", () => {
      const first = pasted.selection[0];
      setPicked({ bone: first.bone, cube: null }); setBoneName(first.bone); setAnimChannel(first.channel);
      setKeySelection({ context: animationContext.current, items: pasted.selection, anchor: first });
    });
  };
  const commitSpan = (length, loop) => {
    const value = Number(length);
    if (!Number.isFinite(value) || value <= 0) return;
    return saveAnimChange(doc => setAnimSpan(doc, value, loop), "已更新动画", next => {
      if (animTime > next.animation_length) setAnimTime(next.animation_length);
    });
  };
  const reloadLibrary = async () => {
    const value = await call("content.list-models");
    setLibrary(value.models || []);
  };
  const createNew = async () => {
    setError("");
    try {
      const created = await call("content.create-model", { identifier: newId.trim() || "geometry.model" });
      await reloadLibrary();
      setOpened({ path: created.path, identifier: created.identifier, label: created.identifier });
    } catch (reason) { setError(reason.message); }
  };
  const importProject = async () => {
    setError(""); setProjectBusy(true);
    try {
      const created = await call("content.import-project");
      if (!created) return;
      await reloadLibrary();
      setOpened({ path: created.path, identifier: created.identifier, label: created.identifier });
      setMarks([]); setBoneMarks([]); setDesk("edit"); setPlaying(false);
    } catch (reason) { setError(reason.message); }
    finally { setProjectBusy(false); }
  };
  const exportProject = async (options) => {
    if (!geometry || projectBusy) { if (options) throw Error("工程正在处理，请稍后重试"); return; }
    setError(""); setNotice(""); setProjectBusy(true);
    try {
      const result = await call("content.export-project", { path: doc.path, worldId: opened?.worldId, identifier, bones: geometry.bones, textureWidth: geometry.textureWidth, textureHeight: geometry.textureHeight, display: geometry.display || {}, texture: options?.texture ?? (desk === "animate" ? textureUrl : paintActions.current.snapshot?.() ?? textureUrl), textureOverrides: options?.textureOverrides ?? paintActions.current.materialSnapshot?.() ?? {}, ...(options?.repack ? { repack: options.repack, textureRevisions: options.textureRevisions } : {}) });
      if (result) setNotice("工程已导出：" + result.path);
      return result;
    } catch (reason) { setError(reason.message); if (options) throw reason; }
    finally { setProjectBusy(false); }
  };
  const removeModel = async item => {
    if (confirmPath !== item.path) { setConfirmPath(item.path); return; }
    setError("");
    try {
      await call("content.delete-model", { path: item.path });
      setConfirmPath("");
      await reloadLibrary();
    } catch (reason) { setError(reason.message); }
  };
  const visible = library.filter(item => !filter || (item.identifier + " " + item.sourceName + " " + item.path).toLowerCase().includes(filter.trim().toLowerCase()));
  const animLength = Number(animDoc?.animation_length) || 1;
  const soundState = useMemo(() => {
    try { return { rows: soundFrames(animDoc?.sound_effects), error: "" }; }
    catch (reason) { return { rows: [], error: reason.message }; }
  }, [animDoc]);
  const soundAt = soundState.rows.find(item => Math.abs(item.time - animTime) < 0.001);
  const particleState = useMemo(() => {
    try { return { rows: particleFrames(animDoc?.particle_effects), error: "" }; }
    catch (reason) { return { rows: [], error: reason.message }; }
  }, [animDoc]);
  const particleAt = particleState.rows.find(item => Math.abs(item.time - animTime) < 0.001);
  const instructionState = useMemo(() => {
    try { return { rows: instructionFrames(animDoc?.timeline), error: "" }; }
    catch (reason) { return { rows: [], error: reason.message }; }
  }, [animDoc]);
  const instructionAt = instructionState.rows.find(item => Math.abs(item.time - animTime) < 0.001);
  const keyAt = Math.max(0, Math.round(Number(animTime) * 20) / 20);
  const boneRows = boneTree(geometry?.bones || []).map(({ bone: item, depth }) => ({
    name: item.name,
    depth,
    channels: [["rotation", "旋转"], ["position", "位移"], ["scale", "缩放"]].map(([channel, label]) => ({
      channel,
      label,
      times: keyTimes(animDoc, item.name, channel),
    })),
  }));
  const foldable = new Set();
  for (const item of geometry?.bones || []) {
    if ((item.cubes || []).length || Object.keys(item.locators || {}).length || item.poly_mesh) foldable.add(item.name);
    if (item.parent) foldable.add(item.parent);
  }
  let foldDepth = null;
  const outline = [];
  for (const item of boneTree(geometry?.bones || [])) {
    if (foldDepth !== null) {
      if (item.depth > foldDepth) continue;
      foldDepth = null;
    }
    outline.push(item);
    if (folded.includes(item.bone.name)) foldDepth = item.depth;
  }
  const visibleOutline = outlinerFilter.trim() ? outline.filter(({ bone: item }) => item.name.toLowerCase().includes(outlinerFilter.trim().toLowerCase()) || (item.cubes || []).some(cube => cube.name?.toLowerCase().includes(outlinerFilter.trim().toLowerCase())) || (item.poly_mesh && "网格".includes(outlinerFilter.trim().toLowerCase()))) : outline;
  const hasKey = boneRows.find(row => row.name === bone?.name)?.channels.find(row => row.channel === animChannel)?.times.some(time => Math.abs(time - keyAt) < 0.001);
  if (!opened?.path) return <div className="model-library">
    <div className="model-studio-bar"><div className="model-studio-title"><h1>模型制作</h1><p>新建的模型保存在工具箱里，不用选模组。模组里已经有的几何，打开后才会改那个文件。</p></div></div>
    <div className="model-library-bar">
      <input className="model-name" aria-label="新模型标识符" value={newId} onChange={event => setNewId(event.target.value)} />
      <Button onClick={createNew}>新建模型</Button>
      <Button disabled={projectBusy} onClick={importProject}>{projectBusy ? "导入中…" : "导入 .bbmodel"}</Button>
      <input aria-label="搜索模型" placeholder="搜索标识符或路径" value={filter} onChange={event => setFilter(event.target.value)} />
      <span>{visible.length} 个模型</span>
    </div>
    {error && <p>{error}</p>}
    <p className="model-texture-note">可导入 Bedrock 立方体工程（4.10 / 5.0，单张内嵌 PNG）。导入后新建草稿并保留原工程。</p>
    <div className="model-library-grid">{visible.map(item => <div className="model-library-card" key={item.path + item.identifier}>
      <button type="button" className="model-library-open" onClick={() => setOpened({ path: item.path, identifier: item.identifier, label: item.identifier })}><strong>{item.identifier}</strong><small>{item.draft ? "工具箱" : item.sourceName} · {item.bones} 根骨骼 · {item.cubes} 个立方体</small><em>{item.draft ? "保存在工具箱" : item.path}</em></button>
      <Button danger onClick={() => removeModel(item)}>{confirmPath === item.path ? "确认删除" : "删除"}</Button>
    </div>)}</div>
    {!library.length && !error && <p className="model-empty">正在查找几何文件，或这些模组里还没有 .geo.json。</p>}
  </div>;
  return <div className="model-studio">
    <div className="model-toolbar">
      <div className="model-toolbar-row">
        {desk === "edit" && <div className="model-transform" role="toolbar" aria-label="变换">
          <button type="button" title="移动 (V)" aria-pressed={(tool === "move" && !pointAlign) || (tool === "vertex" && vertexGesture === "move")} onClick={() => { setPointAlign(false); if (tool === "vertex") setVertexGesture("move"); else setTool("move"); }}>移动</button>
          <button type="button" title="旋转 (R)" aria-pressed={tool === "rotate" || (tool === "vertex" && vertexGesture === "rotate")} onClick={() => { if (tool === "vertex") setVertexGesture("rotate"); else setTool("rotate"); }}>旋转</button>
          <button type="button" title="缩放 (S)" aria-pressed={tool === "scale" || (tool === "vertex" && vertexGesture === "scale")} onClick={() => { if (tool === "vertex") setVertexGesture("scale"); else setTool("scale"); }}>缩放</button>
          <button type="button" title="轴心 (P)" aria-pressed={tool === "pivot"} onClick={() => setTool("pivot")}>轴心</button>
          <button type="button" title="选择当前立方体的角点，再用移动、旋转或缩放手柄变换" aria-pressed={tool === "vertex"} onClick={() => { setPointAlign(false); setVertexSnap(false); setVertexGesture("move"); setTool("vertex"); }}>顶点</button>
          <button type="button" title="拖动时移动和缩放按 1 取整，旋转按 15 度" aria-pressed={snap} onClick={() => setSnap(value => !value)}>吸附</button>
          <button type="button" title="移动选中立方体时，0.5 模型单位内的角点自动对齐；支持多选和方向键" aria-pressed={vertexSnap} onClick={() => { setPointAlign(false); setVertexSnap(value => !value); }}>顶点吸附</button>
          <button type="button" title="先选所选元素的角点，再选其他元素的目标角点" aria-pressed={pointAlign} onClick={() => { setPointAlign(value => !value); setPointSource(null); setVertexTarget(null); setVertexSnap(false); setTool("move"); }}>顶点对齐</button>
        </div>}
        {desk === "edit" && <div className="model-studio-actions">
          <Button disabled={!past} onClick={undo}>撤销</Button>
          <Button disabled={!future} onClick={redo}>重做</Button>
        </div>}
        <div className="model-studio-title"><h1>{opened.label || identifier || "模型"}</h1><p>{opened.draft || doc?.path?.includes("model-studio") ? "工具箱中的模型" : (doc?.path || opened.path)}</p></div>
        <div className="model-modes" role="tablist" aria-label="工作模式">
          <button type="button" aria-pressed={desk === "edit"} onClick={() => setDesk("edit")}>编辑</button>
          <button type="button" aria-pressed={desk === "paint"} onClick={() => setDesk("paint")}>绘制</button>
          <button type="button" aria-pressed={desk === "animate"} onClick={() => setDesk("animate")}>动画</button>
          <button type="button" aria-pressed={desk === "display"} onClick={() => setDesk("display")}>显示</button>
        </div>
        <div className="model-studio-actions">
          <Button onClick={() => { seen.current = (request?.path || "") + "|" + (request?.identifier || ""); setOpened(null); onLeave?.(); }}>退出编辑</Button>
          {request?.path && onBack && <Button onClick={onBack}>返回内容</Button>}
          <Button primary disabled={saving || !geometry} onClick={save}>{saving ? "保存中…" : "保存模型"}</Button>
          <Button disabled={projectBusy || !geometry} onClick={() => exportProject()} title="导出当前模型、当前贴图和模型同目录中已保存的动画">{projectBusy ? "导出中…" : "导出 .bbmodel"}</Button>
          <Button disabled={!layoutReady} onClick={() => { saveLayout(layoutMode, defaultLayout(layoutMode)); setLayoutReset(value => value + 1); }} title="恢复并保存当前模式的默认面板尺寸">恢复布局</Button>
        </div>
      </div>
    </div>
    {error && <p>{error}</p>}
    {notice && <p>{notice}</p>}
    {desk === "edit" && pointAlign && <div className="model-point-align"><span role="status" aria-label="顶点对齐状态">{pointSession?.error || (chosenPoint ? "第二步：选择绿色目标顶点；黄色点是源点" : "第一步：选择已选元素上的蓝色源顶点")}{pointSession?.context && !pointSession.targets.length ? " · 没有可见的未选中目标" : ""}</span><Select aria-label="顶点对齐轴" value={pointAxis} options={[{ value: "all", label: "三轴对齐" }, { value: "x", label: "仅世界 X" }, { value: "y", label: "仅世界 Y" }, { value: "z", label: "仅世界 Z" }]} onChange={setPointAxis} /><Button disabled={!chosenPoint} onClick={() => setPointSource(null)}>重选源点</Button><Button onClick={() => { setPointAlign(false); setPointSource(null); }}>退出对齐</Button></div>}
    {desk === "edit" && vertexSnap && <p className="model-texture-note" role="status" aria-label="顶点吸附状态">{vertexTarget ? `已吸附：${vertexTarget.bone} · 立方体 ${vertexTarget.cube + 1}` : "移动立方体靠近其他可见角点，0.5 模型单位内自动对齐；绿色点标出目标。"}</p>}
    {desk === "edit" && tool === "vertex" && <p className="model-texture-note" role="status" aria-label="顶点编辑状态">{!cube || markedCubes.length > 1 ? "先选中一个立方体，再点蓝色角点" : `已选 ${vertexSelection.length} 个顶点，当前是${vertexGesture === "rotate" ? "旋转" : vertexGesture === "scale" ? "缩放" : "移动"}。点蓝色角点或立方体的面，Ctrl 加选；V/R/S 切换手柄，方向键按当前方式变换。`}</p>}
    <div className="model-layout-status" role="status" aria-label="布局保存状态">{layoutError ? <><span>{layoutError}</span><Button disabled={!!layoutPending} onClick={retryLayout}>重试布局保存</Button></> : !layoutReady ? "正在读取布局…" : layoutPending ? "正在保存布局…" : "布局已保存"}{viewError ? <span> {viewError}</span> : viewsPending ? <span> 正在保存视角…</span> : viewsReady ? null : <span> 正在读取视角…</span>}</div>
    {desk === "animate" && previewErrors.length > 0 && <div className="model-molang-warning" role="status" aria-label="动画预览提示">部分轨道无法预览，已保留原文并使用静止姿势。{previewErrors.slice(0, 3).map(message => <div key={message}>{message}</div>)}{previewErrors.length > 3 && <div>另有 {previewErrors.length - 3} 个轨道无法预览。</div>}</div>}
    {geometry && <ModelBench mode={layoutMode} layout={layout} onLayout={next => saveLayout(layoutMode, next)} reset={layoutReset} disabled={!layoutReady}>
      {desk === "display" && geometry && <aside className="model-panel model-display-slots"><div className="model-panel-head"><h2>显示</h2></div><div className="model-tree" role="listbox" aria-label="显示槽位">{displaySlots.map(([id, label]) => <button type="button" key={id} aria-pressed={displaySlot === id} className={displaySlot === id ? "active" : ""} onClick={() => setDisplaySlot(id)}>{label}</button>)}</div></aside>}
      {desk === "edit" && <aside className="model-panel model-outliner" onDragEnd={finishOutlineDrag} onKeyDown={event => { if (event.key === "Escape") finishOutlineDrag(); }}>
        <div className="model-panel-head"><h2 onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); dropParent(""); }}>大纲</h2><input className="model-outliner-filter" aria-label="过滤大纲" placeholder="过滤骨骼" value={outlinerFilter} onChange={event => setOutlinerFilter(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setOutlinerFilter(""); }} />
          <div className="model-tools">
          <Button compact icon="plus" onClick={() => { const created = addBone(geometry.bones || [], bone?.name); edit(() => created.bones, { bone: created.name, cube: null }); }}>新建骨骼</Button>
          <Button compact icon="cube" disabled={!bone} onClick={() => edit(bones => addCube(bones, bone.name), { bone: bone.name, cube: (bone.cubes || []).length })}>新建立方体</Button>
          <Button compact disabled={!bone} onClick={() => { try { const created = addLocator(geometry.bones || [], bone.name); edit(() => created.bones, { bone: bone.name, cube: null, locator: created.name }); setLocatorName(created.name); } catch (reason) { setError(reason.message); } }}>新建定位器</Button>
          <Button compact icon="copy" disabled={!bone || saving} onClick={duplicate} title={boneMarks.length > 1 ? "复制所选骨骼及子级（Ctrl+D）" : markedCubes.length > 1 ? "复制所选 " + markedCubes.length + " 个立方体（Ctrl+D）" : "复制（Ctrl+D）"}>复制</Button>
          <Button compact icon="trash" disabled={!bone || saving} onClick={removeSelected} title={boneMarks.length > 1 ? "删除所选骨骼，保留未选中的子级（Delete）" : markedCubes.length > 1 ? "删除所选 " + markedCubes.length + " 个立方体（Delete）" : "删除（Delete）"}>删除</Button>
        </div></div>
        <div className="model-tree">{visibleOutline.map(({ bone: item, depth }) => <div key={item.name}>
          <div className="model-row" style={{ "--depth": depth }}>{foldable.has(item.name) ? <button type="button" className="model-fold" aria-expanded={!folded.includes(item.name)} aria-label={(folded.includes(item.name) ? "展开 " : "折叠 ") + item.name} onClick={() => setFolded(current => current.includes(item.name) ? current.filter(key => key !== item.name) : [...current, item.name])}></button> : <span className="model-fold-gap"></span>}<button type="button" className="model-eye" aria-pressed={hidden.includes(item.name)} aria-label={(hidden.includes(item.name) ? "显示 " : "隐藏 ") + item.name} onClick={() => setHidden(current => current.includes(item.name) ? current.filter(key => key !== item.name) : [...current, item.name])}></button><button type="button" draggable onDragStart={event => startBoneDrag(event, item.name)} onDragOver={event => hoverOutline(event, "bone:" + item.name)} onDragLeave={() => setDropTarget("")} onDrop={event => { event.preventDefault(); event.stopPropagation(); dropParent(item.name); }} aria-pressed={boneMarks.includes(item.name) || (picked?.bone === item.name && !Number.isInteger(picked.cube) && !picked.locator)} className={(boneMarks.includes(item.name) || (picked?.bone === item.name && !Number.isInteger(picked.cube) && !picked.locator) ? "active" : "") + (dropTarget === "bone:" + item.name ? " model-drop-bone" : "")} onClick={event => chooseBone(item.name, event.ctrlKey || event.metaKey)}>{item.name}</button></div>
          {(folded.includes(item.name) ? [] : item.cubes || []).map((itemCube, index) => { const key = itemCube.dgnId || (item.name + ":" + index); return <div className="model-row" key={key} style={{ "--depth": depth + 1 }}><button type="button" className="model-eye" aria-pressed={hidden.includes(key)} aria-label={(hidden.includes(key) ? "显示 " : "隐藏 ") + item.name + " 立方体 " + (index + 1)} onClick={() => setHidden(current => current.includes(key) ? current.filter(itemKey => itemKey !== key) : [...current, key])}></button><button type="button" draggable onDragStart={event => startCubeDrag(event, item.name, index)} onDragOver={event => hoverOutline(event, "cube:" + key)} onDragLeave={() => setDropTarget("")} onDrop={event => { event.preventDefault(); event.stopPropagation(); dropParent(item.name, index); }} aria-label={item.name + " 立方体 " + (index + 1)} className={"model-cube" + (dropTarget === "cube:" + key ? " model-drop-before" : "") + (marks.includes(key) || (picked?.bone === item.name && picked.cube === index) ? " active" : "")} onClick={event => chooseCube(item.name, index, event.ctrlKey || event.metaKey)}>{itemCube.name || ("立方体 " + (index + 1))}</button></div>; })}{(folded.includes(item.name) ? [] : Object.keys(item.locators || {})).map(name => <div className="model-row" key={item.name + ":locator:" + name} style={{ "--depth": depth + 1 }}><button type="button" className={"model-locator" + (picked?.bone === item.name && picked.locator === name ? " active" : "")} aria-label={item.name + " 定位器 " + name} onClick={() => { setMarks([]); setBoneMarks([]); setPicked({ bone: item.name, cube: null, locator: name }); setUvFace(""); setBoneName(item.name); setLocatorName(name); }}>{name}</button></div>)}{item.poly_mesh && !folded.includes(item.name) ? <div className="model-row" key={item.name + ":mesh"} style={{ "--depth": depth + 1 }}><button type="button" className="model-eye" aria-pressed={hidden.includes(item.name + ":mesh")} aria-label={(hidden.includes(item.name + ":mesh") ? "显示 " : "隐藏 ") + item.name + " 网格"} onClick={() => setHidden(current => current.includes(item.name + ":mesh") ? current.filter(key => key !== item.name + ":mesh") : [...current, item.name + ":mesh"])}></button><button type="button" aria-label={item.name + " 网格"} className={"model-cube" + (picked?.mesh && picked.bone === item.name ? " active" : "")} onClick={() => { setMarks([]); setBoneMarks([]); setPicked({ bone: item.name, cube: null, mesh: true }); setUvFace(""); setBoneName(item.name); }}>网格</button></div> : null}
        </div>)}</div>
      </aside>}
      {desk === "animate" && <aside className="model-panel model-anims"><div className="model-panel-head"><h2>动画</h2><div className="model-tools"><Button onClick={createAnim}>新建动画</Button><Button disabled={!animId} onClick={duplicateAnim}>复制动画</Button><Button disabled={!animId} onClick={deleteAnim}>{confirmAnim === animPath + "|" + animId ? "确认删除" : "删除"}</Button></div></div>{animId && <label className="model-vec"><span>名称</span><input aria-label="动画名称" value={animName} onChange={event => setAnimName(event.target.value)} onBlur={() => renameAnim()} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>}<div className="model-anim-list">{anims.map(item => <button type="button" key={item.path + item.id} className={item.path === animPath && item.id === animId ? "active" : ""} onClick={() => { setControllerPreview(null); setAnimPath(item.path); setAnimId(item.id); setAnimStamp(value => value + 1); }}>{item.id}</button>)}{!anims.length && <p className="model-texture-note">这个模型旁边还没有动画。</p>}</div><ModelControllerEditor key={doc.path + "|" + (opened?.worldId || "") + "|" + identifier} modelPath={doc.path} worldId={opened?.worldId} animations={anims} playbackKey={animationContext.current + "|" + playing} onFrame={setControllerPreview} /></aside>}
      {preview && viewsReady && <ModelViewport vertexGesture={vertexGesture} viewSession={viewSession} onViewSession={saveViews} model={preview} frameKey={(doc?.path || "") + ":" + identifier} selectedKey={selectedKey} boneName={picked?.bone || ""} uvFace={uvFace} displayPose={desk === "display" ? slotPose : null} textureUrl={textureUrl} materialUrls={materialUrls} tool={tool} desk={desk} clip={desk === "animate" && controllerPreview ? controllerPreview.clip : animClip} time={desk === "animate" && controllerPreview ? controllerPreview.time : animTime} onPick={(name, index, face, toggle) => tool === "vertex" && faceCorners[face] ? chooseFaceVertices(name, index, face, toggle) : chooseCube(name, index, toggle, face)} onMarquee={marqueeSelect} selectedKeys={(geometry.bones || []).flatMap(item => (item.cubes || []).flatMap((cube, index) => (marks.includes(cube.dgnId) || boneMarks.includes(item.name)) ? [item.name + ":" + index] : []))} vertexPoints={pointSession ? (chosenPoint ? pointSession.targets : pointSession.context?.sources) || [] : vertexMarkers} vertexSource={pointSession ? chosenPoint?.point.toArray() : vertexCenter} onVertexPick={chooseVertex} snapPoint={vertexTarget?.point} locatorKey={picked?.locator ? picked.bone + ":" + picked.locator : ""} onPickLocator={(name, locatorId) => { setUvFace(""); setMarks([]); setBoneMarks([]); setPicked({ bone: name, cube: null, locator: locatorId }); setBoneName(name); setLocatorName(locatorId); }} onPickMesh={name => { setUvFace(""); setMarks([]); setBoneMarks([]); setPicked({ bone: name, cube: null, mesh: true }); setBoneName(name); }} onTransform={onTransform} onPaint={desk === "paint" && solid ? (point, phase) => paintActions.current.paint?.(point, phase) : undefined} />}
      {desk === "animate" && <aside className="model-panel model-anim-props"><h2>骨骼</h2><div className="model-bone-list">{boneTree(geometry.bones || []).map(({ bone: item, depth }) => <button type="button" key={item.name} className={picked?.bone === item.name ? "active" : ""} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => { setMarks([]); setBoneMarks([]); setPicked({ bone: item.name, cube: null }); setBoneName(item.name); }}>{item.name}</button>)}</div><div className="model-transform" role="toolbar" aria-label="动画通道"><button type="button" aria-pressed={animChannel === "rotation"} onClick={() => setAnimChannel("rotation")}>旋转</button><button type="button" aria-pressed={animChannel === "position"} onClick={() => setAnimChannel("position")}>位移</button><button type="button" aria-pressed={animChannel === "scale"} onClick={() => setAnimChannel("scale")}>缩放</button></div><Vec3 label={animChannel === "scale" ? "缩放" : animChannel === "position" ? "位移" : "旋转"} value={animVec} onChange={setAnimVec} disabled={expressionChannel} /><Button disabled={!bone || !animDoc || expressionChannel || animBusy} onClick={keyChannel}>{animChannel === "position" ? "记下位移" : animChannel === "scale" ? "记下缩放" : "记下旋转"}</Button>{!expressionChannel && <><div className="model-transform" role="toolbar" aria-label="插值"><button type="button" aria-pressed={keyMode(animDoc, bone?.name, animChannel, animTime) === "linear"} disabled={!hasKey || expressionChannel || animBusy} onClick={() => saveMode("linear")}>线性</button><button type="button" aria-pressed={keyMode(animDoc, bone?.name, animChannel, animTime) === "catmullrom"} disabled={!hasKey || expressionChannel || animBusy} onClick={() => saveMode("catmullrom")}>平滑</button><button type="button" aria-pressed={keyMode(animDoc, bone?.name, animChannel, animTime) === "step"} disabled={!hasKey || expressionChannel || animBusy} onClick={() => saveMode("step")}>阶跃</button></div><label className="model-vec"><span>帧</span><input aria-label="帧时间" type="number" min="0" step="0.05" disabled={!operationKeys.length || animBusy} value={operationKeys.length ? firstSelectedTime.toFixed(2) : ""} onChange={event => retimeKey(event.target.value)} /></label><Button onClick={() => setTimelineView("curve")}>编辑曲线</Button></>}{expressionChannel && <section className="model-molang" aria-label="Molang 通道"><h3>Molang 预览</h3><p>上方数值随时间计算。表达式通道不接受数值覆盖，请在源文件中编辑。</p><pre>{JSON.stringify(channelSource, null, 2)}</pre></section>}<p className="model-texture-note">{bone ? "数值是相对静止姿势的变化，记在当前时间。" : "先选中一根骨骼。"}</p><div className="model-transform" role="toolbar" aria-label="效果"><button type="button" aria-pressed={effectTab === "sound"} onClick={() => setEffectTab("sound")}>声音</button><button type="button" aria-pressed={effectTab === "particle"} onClick={() => setEffectTab("particle")}>粒子</button><button type="button" aria-pressed={effectTab === "instruction"} onClick={() => setEffectTab("instruction")}>指令</button></div>{effectTab === "sound" && <SoundEditor key={animationContext.current + "|" + animTime + "|" + JSON.stringify(soundAt)} time={animTime} row={soundAt} error={soundState.error} disabled={!animDoc || animBusy || playing} onSave={saveAnimChange} />}{effectTab === "particle" && <ParticleEditor key={animationContext.current + "|" + animTime + "|" + (particleAt ? particleAt.key : "")} time={animTime} row={particleAt} error={particleState.error} disabled={!animDoc || animBusy || playing} onSave={saveAnimChange} />}{effectTab === "instruction" && <InstructionEditor key={animationContext.current + "|" + animTime + "|" + (instructionAt ? instructionAt.key : "")} time={animTime} row={instructionAt} error={instructionState.error} disabled={!animDoc || animBusy || playing} onSave={saveAnimChange} />}</aside>}
      {desk === "display" && slotPose && <aside className="model-panel model-props model-display-props"><h2>{displaySlots.find(item => item[0] === displaySlot)[1]}</h2><p className="model-texture-note">{slotSaved ? "这个槽位已在草稿中，保存模型后写入几何文件，不进入游戏骨骼。" : "当前是参考姿势。改动任意数值后才写入草稿。"}</p><Vec3 label="旋转" step={1} value={slotPose.rotation} onChange={rotation => changeDisplay({ rotation })} /><Vec3 label="位移" value={slotPose.translation} onChange={translation => changeDisplay({ translation })} /><Vec3 label="缩放" step={0.05} value={slotPose.scale} onChange={scale => changeDisplay({ scale })} /><div className="model-tools"><Button onClick={() => changeDisplay(displayPresets[displaySlot])}>填入参考姿势</Button><Button disabled={!slotSaved} onClick={resetDisplay}>清除</Button></div></aside>}
      {desk === "edit" && <aside className="model-panel model-props"><h2>元素</h2>
        {markedCubes.length > 0 && <CubeBoneMove key={(doc?.path || "") + identifier} bones={geometry.bones} count={markedCubes.length} disabled={saving} keepPose={keepMovePose} onKeepPose={setKeepMovePose} onMove={moveMarkedCubes} />}
        {bone && boneMarks.length < 2 && <div className="model-tools"><Button onClick={() => mirrorAxis(0)}>镜像X</Button><Button onClick={() => mirrorAxis(1)}>镜像Y</Button><Button onClick={() => mirrorAxis(2)}>镜像Z</Button><Button onClick={unwrapUv}>展开 UV</Button></div>}
        {doc.geometries.length > 1 && <select aria-label="模型" value={identifier} onChange={event => { setIdentifier(event.target.value); setMarks([]); setBoneMarks([]); setPicked(null); }}>{doc.geometries.map(item => <option key={item.identifier} value={item.identifier}>{item.identifier}</option>)}</select>}
        {markedCubes.length > 1 && <MultiCubeProperties key={identifier + "|" + [...marks].sort().join("|")} cubes={markedCubes} disabled={saving} onChange={editMarkedProperty} />}
        {markedCubes.length > 1 && <div className="model-tools"><Button onClick={() => edit(bones => editFaceUv(bones, picksOf(bones), "", rotateFace))}>旋转各面</Button><Button onClick={() => edit(bones => editFaceUv(bones, picksOf(bones), "", face => scaleFace(face, 2)))}>放大 UV</Button><Button onClick={() => edit(bones => editFaceUv(bones, picksOf(bones), "", face => scaleFace(face, 0.5)))}>缩小 UV</Button></div>}
        {locator && <><label className="model-vec"><span>名称</span><input aria-label="定位器名称" value={locatorName} onChange={event => setLocatorName(event.target.value)} onBlur={() => { const next = locatorName.trim(); if (!next || next === picked.locator) { setLocatorName(picked.locator); return; } if (!edit(bones => renameLocator(bones, bone.name, picked.locator, next), { bone: bone.name, cube: null, locator: next })) setLocatorName(picked.locator); }} /></label><Vec3 label="位置" value={locator.offset} onChange={offset => edit(bones => setLocator(bones, bone.name, picked.locator, { offset }))} /><Vec3 label="旋转" value={locator.rotation || [0, 0, 0]} onChange={rotation => edit(bones => setLocator(bones, bone.name, picked.locator, { rotation }))} /><label className="model-check"><input type="checkbox" checked={!!locator.ignore_inherited_scale} onChange={event => edit(bones => setLocator(bones, bone.name, picked.locator, { ignore_inherited_scale: event.target.checked }))} />忽略继承缩放</label><p className="model-texture-note">位置相对当前骨骼轴心。移动、轴心和方向键按定位器自身坐标改变；不能缩放。</p></>}{boneMarks.length > 1 && <MultiBoneProperties key={identifier + "|" + boneMarks.slice().sort().join("|")} bones={(geometry.bones || []).filter(item => boneMarks.includes(item.name))} allBones={geometry.bones || []} disabled={saving} onChange={editBoneProperty} onParent={editBoneParent} />}{bone && !cube && !locator && !picked?.mesh && boneMarks.length < 2 && <><Button disabled={!!bone.poly_mesh} onClick={() => edit(bones => createMesh(bones, bone.name), { bone: bone.name, cube: null, mesh: true })}>新建网格</Button>
          <label className="model-vec"><span>名称</span><input aria-label="骨骼名称" value={boneName} onChange={event => setBoneName(event.target.value)} onBlur={() => { if (!boneName || boneName === bone.name) return; const from = bone.name; const to = boneName.trim(); if (edit(bones => renameBone(bones, from, to), { bone: to, cube: null })) setHidden(current => current.map(key => key === from ? to : key)); }} /></label>
          <label className="model-vec"><span>父级</span><select aria-label="父级骨骼" value={bone.parent || ""} onChange={event => edit(bones => reparentBone(bones, bone.name, event.target.value))}><option value="">无</option>{parentBones(geometry.bones, bone.name).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
          {boneMarks.length < 2 && <><Vec3 label="轴心" value={bone.pivot} onChange={pivot => edit(bones => bones.map(item => item.name === bone.name ? { ...item, pivot } : item))} />
          <Vec3 label="旋转" value={bone.rotation || [0, 0, 0]} onChange={rotation => edit(bones => bones.map(item => item.name === bone.name ? { ...item, rotation } : item))} /></>}
        </>}
        {cube && markedCubes.length <= 1 && <>
          <label className="model-vec"><span>名称</span><input aria-label="立方体名称" value={elementName} onChange={event => setElementName(event.target.value)} onBlur={() => { try { const next = namedCube(cube, elementName); if (next === cube) { setElementName(cube.name || ""); return; } edit(bones => bones.map(item => item.name === bone.name ? { ...item, cubes: item.cubes.map((itemCube, index) => index === picked.cube ? next : itemCube) } : item)); } catch (reason) { setElementName(cube.name || ""); setError(reason.message); } }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
          <Vec3 label="起点" value={cube.origin} onChange={origin => edit(bones => bones.map(item => item.name === bone.name ? { ...item, cubes: item.cubes.map((itemCube, index) => index === picked.cube ? moveCubeGeometry(itemCube, origin) : itemCube) } : item))} />
          <Vec3 label="尺寸" value={cube.size} onChange={size => edit(bones => bones.map(item => item.name === bone.name ? { ...item, cubes: item.cubes.map((itemCube, index) => index === picked.cube ? resizeCubeGeometry(itemCube, size) : itemCube) } : item))} />
          <Vec3 label="轴心" value={cube.pivot || cube.origin} onChange={pivot => edit(bones => bones.map(item => item.name === bone.name ? { ...item, cubes: item.cubes.map((itemCube, index) => index === picked.cube ? { ...itemCube, pivot } : itemCube) } : item))} />
          <Vec3 label="旋转" value={cube.rotation || [0, 0, 0]} onChange={rotation => edit(bones => bones.map(item => item.name === bone.name ? { ...item, cubes: item.cubes.map((itemCube, index) => index === picked.cube ? { ...itemCube, rotation } : itemCube) } : item))} />
          <label className="model-vec"><span>膨胀</span><input aria-label="膨胀" type="number" step="0.5" value={cube.inflate || 0} onChange={event => edit(bones => bones.map(item => item.name === bone.name ? { ...item, cubes: item.cubes.map((itemCube, index) => index === picked.cube ? { ...itemCube, inflate: Number(event.target.value) } : itemCube) } : item))} /></label>
          <label className="model-check"><input type="checkbox" checked={!!cube.mirror} onChange={event => edit(bones => bones.map(item => item.name === bone.name ? { ...item, cubes: item.cubes.map((itemCube, index) => index === picked.cube ? { ...itemCube, mirror: event.target.checked } : itemCube) } : item))} />镜像贴图</label>
          <div className="model-tools"><Button onClick={() => edit(bones => editFaceUv(bones, picksOf(bones), uvFace, rotateFace))}>{uvFace ? "旋转这一面" : "旋转各面"}</Button><Button onClick={() => edit(bones => editFaceUv(bones, picksOf(bones), uvFace, face => scaleFace(face, 2)))}>放大 UV</Button><Button onClick={() => edit(bones => editFaceUv(bones, picksOf(bones), uvFace, face => scaleFace(face, 0.5)))}>缩小 UV</Button></div>{uvFace && <p className="model-texture-note">当前面：{uvFace === "up" ? "上" : uvFace === "down" ? "下" : uvFace === "north" ? "北" : uvFace === "south" ? "南" : uvFace === "east" ? "东" : "西"}</p>}{Array.isArray(cube.uv) ? <label className="model-vec"><span>UV</span><input aria-label="U" type="number" value={cube.uv[0] || 0} onChange={event => edit(bones => bones.map(item => item.name === bone.name ? { ...item, cubes: item.cubes.map((itemCube, index) => index === picked.cube ? { ...itemCube, uv: [Number(event.target.value), itemCube.uv[1] || 0] } : itemCube) } : item))} /><input aria-label="V" type="number" value={cube.uv[1] || 0} onChange={event => edit(bones => bones.map(item => item.name === bone.name ? { ...item, cubes: item.cubes.map((itemCube, index) => index === picked.cube ? { ...itemCube, uv: [itemCube.uv[0] || 0, Number(event.target.value)] } : itemCube) } : item))} /></label> : <p>这个立方体使用按面 UV，此处不把它改成盒子 UV。</p>}
          <section className="model-vertex-edit" aria-label="立方体顶点"><h3>顶点</h3><div className="model-tools"><Button onClick={extrudeSelectedFace}>挤出这一面</Button><Button onClick={() => reshapeFace('out')}>推出</Button><Button onClick={() => reshapeFace('in')}>收回</Button><Button onClick={() => reshapeFace('inset')}>收缩</Button><Button onClick={extrudeSelectedFace}>挤出这一面</Button><Button onClick={() => edit(bones => setCubeVertices(bones, bone.name, picked.cube, defaultVertices(cube)))}>恢复盒子</Button><Button aria-label="顶点镜像X" onClick={() => edit(bones => mirrorVertices(bones, bone.name, picked.cube, vertexSelection, 0))}>镜像X</Button><Button aria-label="顶点镜像Y" onClick={() => edit(bones => mirrorVertices(bones, bone.name, picked.cube, vertexSelection, 1))}>镜像Y</Button><Button aria-label="顶点镜像Z" onClick={() => edit(bones => mirrorVertices(bones, bone.name, picked.cube, vertexSelection, 2))}>镜像Z</Button></div><label className="model-vec"><span>距离</span><input aria-label="面距离" type="number" step="0.5" value={faceDistance} onChange={event => setFaceDistance(event.target.value)} /></label><label className="model-vec"><span>切开</span><select aria-label="切开轴向" value={splitAxis} onChange={event => setSplitAxis(event.target.value)}><option value="0">X</option><option value="1">Y</option><option value="2">Z</option></select><input aria-label="切开段数" type="number" min="2" max="8" step="1" value={splitCount} onChange={event => setSplitCount(event.target.value)} /></label><Button onClick={splitSelectedCube}>切开</Button><Button onClick={convertSelectedCube}>转为网格</Button><Select aria-label="顶点索引" value={String(vertexIndex)} options={vertices.map((_, index) => ({ value: String(index), label: "顶点 " + index }))} onChange={value => { const index = Number(value); setVertexIndex(index); setVertexSelection([index]); }} />{vertexSelection.length > 1 ? <label className="model-vec"><span>坐标</span>{["X", "Y", "Z"].map((axis, index) => { const values = vertexSelection.map(item => vertices[item]?.[index]); const same = values.length > 0 && values.every(item => item === values[0]); return <PropertyInput key={vertexSelection.join(",") + axis} label={"坐标" + axis} value={same ? values[0] : null} onCommit={value => Number.isFinite(value) && !!edit(bones => setVertexComponent(bones, bone.name, picked.cube, vertexSelection, index, value))} />; })}</label> : <Vec3 label="坐标" value={vertices[vertexIndex] || [0, 0, 0]} onChange={value => { const next = vertices.map(point => point.slice()); next[vertexIndex] = value; edit(bones => setCubeVertices(bones, bone.name, picked.cube, next)); }} />}<p className="model-texture-note">角点也显示在中间预览。编辑后使用自定义顶点；恢复到盒子角点会自动清除。膨胀只推动预览中的角点，不改保存的坐标；位于盒子中心面上的角点不会沿该方向移动。暂不支持边/面拓扑操作。</p></section>
        </>}
        {picked?.mesh && bone?.poly_mesh && <section className="model-vertex-edit" aria-label="网格"><h3>网格</h3><Select aria-label="网格顶点" value={String(meshWelds.includes(vertexIndex) ? vertexIndex : meshWelds[0])} options={meshWelds.map(index => ({ value: String(index), label: "顶点 " + index }))} onChange={value => { const index = Number(value); setVertexIndex(index); setVertexSelection([index]); }} /><Vec3 label="坐标" value={meshPoint} disabled={!meshWelds.length} onChange={value => edit(bones => setMeshVertex(bones, bone.name, meshWelds.includes(vertexIndex) ? vertexIndex : meshWelds[0], value))} /><Button onClick={() => { const next = (bone.dgn_mesh_welds || []).reduce((max, id) => Math.max(max, id), -1) + 1; if (edit(bones => addMeshVertex(bones, bone.name, bone.pivot || [0, 0, 0]), { bone: bone.name, cube: null, mesh: true })) { setVertexIndex(next); setVertexSelection([next]); setNotice("已新建顶点，可一次撤销"); } }}>新建顶点</Button><Button onClick={() => { if (edit(bones => addMeshFace(bones, bone.name, vertexSelection))) setNotice("已用所选顶点建面，可一次撤销"); }}>建面</Button>{bone.poly_mesh.polys.length > 0 && <Select aria-label="网格面" value={String(Math.min(meshFace, bone.poly_mesh.polys.length - 1))} options={bone.poly_mesh.polys.map((_, index) => ({ value: String(index), label: "面 " + (index + 1) }))} onChange={value => setMeshFace(Number(value))} />}<Button disabled={!bone.poly_mesh.polys.length} onClick={() => edit(bones => removeMeshFace(bones, bone.name, Math.min(meshFace, bone.poly_mesh.polys.length - 1)))}>删除这一面</Button><Button disabled={!bone.poly_mesh.polys.length} onClick={() => { const index = Math.min(meshFace, bone.poly_mesh.polys.length - 1); if (edit(bones => subdivideMeshFace(bones, bone.name, index))) setNotice("已把这一面分成四块，共享边已切开，可一次撤销"); }}>细分这一面</Button><Button disabled={!meshWelds.length} onClick={() => edit(bones => removeMeshVertex(bones, bone.name, meshWelds.includes(vertexIndex) ? vertexIndex : meshWelds[0]))}>删除顶点</Button><Button onClick={() => edit(bones => removeMesh(bones, bone.name), { bone: bone.name, cube: null })}>删除网格</Button><p className="model-texture-note">新建顶点后，在顶点工具里选 3 或 4 个点再建面。删除顶点会去掉用到它的面。细分会切开当前这一面，并在相邻面的共享边上插入同一个中点。右侧贴图面板可以把当前贴图分给选中的这一面。每根骨骼只有一个网格。</p></section>}{!bone && <p>从左侧选择骨骼或立方体。新建骨骼会挂在当前骨骼下。</p>}
      </aside>}
      {<TextureDesk onMaterialPreview={setMaterialUrls} onAssignMaterial={assignMaterial} materialCount={marks.length || (cube ? 1 : 0) || (picked?.mesh && bone?.poly_mesh?.polys?.length ? 1 : 0)} onExportPacked={exportProject} role={desk} onFace={setUvFace} uvFace={uvFace} paintActions={paintActions} solid={solid} onSolid={setSolid} geometryPath={doc.path} worldId={opened.worldId} textureWidth={geometry.textureWidth || 64} textureHeight={geometry.textureHeight || 64} onTextureSize={(key, value) => setDoc(current => ({ ...current, geometries: current.geometries.map(item => item.identifier === identifier ? { ...item, [key]: Number(value) } : item) }))} bones={geometry.bones || []} picked={picked} onPick={(boneName, index) => chooseCube(boneName, index, false)} onUv={(boneName, index, uv) => replaceBones(bonesRef.current.map(item => item.name === boneName ? { ...item, cubes: (item.cubes || []).map((itemCube, cubeIndex) => cubeIndex === index ? { ...itemCube, uv } : itemCube) } : item))} onUvEnd={() => commitHistory(bonesRef.current)} onPack={bones => { commitHistory(replaceBones(bones)); setUvFace(""); setNotice("已排列 UV，可撤销；保存模型后写回文件"); }} onPreview={setTextureUrl} />}
      {desk === "animate" && <section className="model-panel model-timeline">
        <div className="model-panel-head">
          <div className="model-timeline-lead"><Button disabled={!animDoc} onClick={() => setPlaying(value => !value)}>{playing ? "暂停" : "播放"}</Button><h2>时间轴</h2><div className="model-timeline-view-switch" role="tablist" aria-label="时间轴视图"><button type="button" role="tab" aria-selected={timelineView === "tracks"} onClick={() => setTimelineView("tracks")}>轨道</button><button type="button" role="tab" aria-selected={timelineView === "curve"} onClick={() => setTimelineView("curve")}>曲线</button></div></div>
          <div className="model-span"><select aria-label="循环方式" disabled={!animDoc || animBusy} value={animDoc?.loop === "hold_on_last_frame" ? "hold" : animDoc?.loop === false ? "once" : "loop"} onChange={event => commitSpan(animLength, event.target.value === "hold" ? "hold_on_last_frame" : event.target.value === "once" ? false : true)}><option value="loop">循环</option><option value="once">一次</option><option value="hold">停住</option></select><label>时长<input aria-label="动画时长" type="number" min="0.05" step="0.05" value={animLength} disabled={!animDoc || animBusy} onChange={event => commitSpan(event.target.value, animDoc?.loop === "hold_on_last_frame" ? "hold_on_last_frame" : animDoc?.loop === false ? false : true)} /></label></div>
        </div>
        <div className="model-timeline-tools">
          <Button disabled={!animPast || animBusy} onClick={undo}>撤销</Button><Button disabled={!animFuture || animBusy} onClick={redo}>重做</Button>
          <Button disabled={!operationKeys.length || animBusy} onClick={copyKey}>复制</Button><Button disabled={!copied || !bone || !animDoc || animBusy} onClick={pasteKey}>粘贴</Button>
          <Button disabled={!operationKeys.length || animBusy} onClick={clearKey}>{operationKeys.length > 1 ? "删除所选" : "删除这一帧"}</Button>
          <label className="model-key-shift">偏移秒数<input aria-label="关键帧偏移秒数" type="number" step="0.05" value={keyShift} onChange={event => setKeyShift(event.target.value)} /></label>
          <Button disabled={!operationKeys.length || animBusy} onClick={shiftKeys}>移动所选</Button>
          <span className="model-selection-count" role="status" aria-label="关键帧选择">{animBusy ? "保存中…" : "已选 " + selectedKeys.length + " 帧"}</span>
          {selectionTracks > 1 && <span className="model-texture-note">跨 {selectionTracks} 条轨道</span>}
        </div>
        <KeyTracks key={animationContext.current} rows={boneRows} boneName={bone?.name} channel={animChannel} length={animLength} time={animTime} selection={selectedKeys} disabled={animBusy || !animDoc} revision={animDoc} playing={playing} mode={timelineView}
          curve={{ keys: channelKeys, axis: curveAxis, part: curvePart, incoming: channelKeys.filter(item => item[5]).map(item => item[0]), onAxis: setCurveAxis, onPart: setCurvePart, onChannel: value => { setAnimChannel(value); setKeySelection(null); setCurvePart("post"); }, readonly: expressionChannel, onChange: curveCommit, onMove: curveMove, onInsert: curveInsert, onDelete: curveDelete, onBezier: openBezier, onNativeBezier: animDoc?.dgn_native_bezier?.some(row => row.bone === bone?.name && row.channel === animChannel) ? () => openBezier(true) : null }}
          effects={[
            { id: "particle", label: "粒子", items: particleState.rows.map(item => ({ time: item.time, label: item.effect })) },
            { id: "sound", label: "声音", items: soundState.rows.map(item => ({ time: item.time, label: item.sounds.map(sound => sound.effect).join(" / ") })) },
            { id: "instruction", label: "指令", items: instructionState.rows.map(item => ({ time: item.time, label: item.text })) },
          ]}
          onBone={name => { setPicked({ bone: name, cube: null }); setBoneName(name); setKeySelection(null); }}
          onSelect={selectKey} onMove={moveKey} onTime={at => { setPlaying(false); setAnimTime(at); }}
          onEffect={(type, at) => { setPlaying(false); setAnimTime(at); setEffectTab(type); }} />
        <p className="model-texture-note">{animTime.toFixed(2)} / {animLength.toFixed(2)} 秒 · {timelineView === "curve" ? "双击插帧，拖动改时/数值；方向键微调，Delete 删除；Esc 取消" : "拖动刻度定位，方向键逐帧；Ctrl 跨轨多选，Shift 连选；Esc 取消拖动"}</p>
      </section>}
    </ModelBench>}
    {bezier && (bezier.native ? <NativeBezierEditor {...bezier} onApply={applyNativeBezier} onClose={() => setBezier(null)} /> : <BezierEditor {...bezier} onApply={applyBezier} onClose={() => setBezier(null)} />)}
  </div>;
}
