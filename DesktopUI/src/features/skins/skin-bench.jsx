import React, { useEffect, useRef, useState } from "react";
import { FlyingAnimation, IdleAnimation, RunningAnimation, SkinViewer, WalkingAnimation, WaveAnimation } from "skinview3d";
import { Button, ErrorBox, Field, Modal, Select } from "../../app/ui.jsx";
import { NpcModelView, npcClipsFor, npcModelFor, npcSlotTexture, npcTextureFor } from "./npc-model-view.jsx";
import modelSlots from "./npc-slots.json";

const api = (method, args) => window.toolkit.call(method, args);
const PARTS = [
  ["head", "头"],
  ["body", "身体"],
  ["armR", "右臂"],
  ["armL", "左臂"],
  ["legR", "右腿"],
  ["legL", "左腿"],
];
const POSES = [
  ["idle", "站立", () => new IdleAnimation()],
  ["walk", "行走", () => new WalkingAnimation()],
  ["run", "跑步", () => new RunningAnimation()],
  ["fly", "飞行", () => new FlyingAnimation()],
  ["wave", "挥手", () => new WaveAnimation("right")],
];

function partRect(part, layer, slim) {
  const arm = slim ? 14 : 16;
  const boxes = {
    head: { base: [0, 0, 32, 16], overlay: [32, 0, 32, 16] },
    body: { base: [16, 16, 24, 16], overlay: [16, 32, 24, 16] },
    armR: { base: [40, 16, arm, 16], overlay: [40, 32, arm, 16] },
    armL: { base: [32, 48, arm, 16], overlay: [48, 48, arm, 16] },
    legR: { base: [0, 16, 16, 16], overlay: [0, 32, 16, 16] },
    legL: { base: [16, 48, 16, 16], overlay: [0, 48, 16, 16] },
  };
  const box = boxes[part][layer];
  return { x: box[0], y: box[1], w: box[2], h: box[3] };
}
function line(x0, y0, x1, y1, plot) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const doubled = err * 2;
    if (doubled > -dy) { err -= dy; x0 += sx; }
    if (doubled < dx) { err += dx; y0 += sy; }
  }
}

export function TargetFields({ targets, value, slot, onChange, onSlot }) {
  const known = targets.some((item) => item.identifier === value);
  const [custom, setCustom] = useState(!!value && !known);
  const options = [
    { value: "", label: "通用人型皮肤（Steve / Alex）" },
    ...targets.map((item) => ({ value: item.identifier, label: item.name + " · " + item.identifier })),
    { value: "__custom", label: "填写自定义模型 ID…" },
  ];
  return <>
    <Field label="目标模型" hint="目标模型需已安装；这个拓展包不会创建模型。">
      <Select
        value={custom ? "__custom" : value}
        options={options}
        onChange={(choice) => {
          if (choice === "__custom") {
            setCustom(true);
            onChange("customnpc:");
            onSlot("default");
            return;
          }
          setCustom(false);
          onChange(choice);
          const known = modelSlots[choice] || [];
          const preferred = targets.find((item) => item.identifier === choice)?.texture_slot;
          onSlot(!choice ? "skin_4" : known.includes(preferred) ? preferred : known[0] || preferred || "default");
        }}
      />
    </Field>
    {custom && <Field label="自定义模型 ID" hint="例如 customnpc:forest_guard_dlcnpc">
      <input value={value} maxLength={160} onChange={(event) => onChange(event.target.value)} />
    </Field>}
    {!!value && !custom && !targets.some((item) => item.identifier === value && item.human) && (modelSlots[value] || []).length > 0 && <Field label="贴图槽位">
      <Select
        aria-label="贴图槽位"
        value={(modelSlots[value] || []).includes(slot) ? slot : modelSlots[value][0]}
        options={(modelSlots[value].includes(slot) ? modelSlots[value] : [slot, ...modelSlots[value]]).map((item) => ({ value: item, label: item }))}
        onChange={onSlot}
      />
    </Field>}
  </>;
}

export function SkinBench({ skin, targets, busy, error, onBack, onSave }) {
  const stageHost = useRef(null);
  const stageCanvas = useRef(null);
  const viewerRef = useRef(null);
  const paintCanvas = useRef(null);
  const paintStage = useRef(null);
  const masterRef = useRef(null);
  const history = useRef([]);
  const drawing = useRef(false);
  const lastPoint = useRef(null);
  const [masterTick, setMasterTick] = useState(0);
  const [name, setName] = useState(skin.name);
  const [author, setAuthor] = useState(skin.author);
  const [target, setTarget] = useState(skin.targetIdentifier || "");
  const [slot, setSlot] = useState(skin.textureSlot || "skin_4");
  const [model, setModel] = useState("default");
  const [pose, setPose] = useState("idle");
  const [spin, setSpin] = useState(true);
  const [part, setPart] = useState("head");
  const [layer, setLayer] = useState("base");
  const [tool, setTool] = useState("pan");
  const [paintDirty, setPaintDirty] = useState(false);
  const [ask, setAsk] = useState(null);
  const [color, setColor] = useState("#d6ac84");
  const [canUndo, setCanUndo] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leave, setLeave] = useState(false);
  const [localError, setLocalError] = useState("");
  const [saved, setSaved] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [userZoom, setUserZoom] = useState(1);
  const legacy = masterRef.current ? masterRef.current.height * 2 === masterRef.current.width : false;
  const scale = masterRef.current ? masterRef.current.width / 64 : 1;
  const human = !target || targets.some((item) => item.identifier === target && item.human);
  const npcModel = npcModelFor(target);
  const npcTexture = npcTextureFor(target);
  const partBlocked = human && legacy && (layer === "overlay" || part === "armL" || part === "legL");
  const box = !masterRef.current || partBlocked ? null : human ? (() => {
    const raw = partRect(part, layer, model === "slim");
    return { x: raw.x * scale, y: raw.y * scale, w: raw.w * scale, h: raw.h * scale };
  })() : { x: 0, y: 0, w: masterRef.current.width, h: masterRef.current.height };

  useEffect(() => {
    if (!human) return undefined;
    const canvas = stageCanvas.current;
    const host = stageHost.current;
    if (!canvas || !host) return undefined;
    const viewer = new SkinViewer({
      canvas,
      width: host.clientWidth || 250,
      height: 340,
      zoom: 0.72,
    });
    viewer.background = getComputedStyle(host).backgroundColor;
    viewer.autoRotate = spin;
    viewer.playerObject.rotation.y = Math.PI / 8;
    viewerRef.current = viewer;
    const observer = new ResizeObserver(() => {
      viewer.setSize(host.clientWidth || 250, 340);
      viewer.render();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [human]);
  useEffect(() => {
    if (viewerRef.current) viewerRef.current.autoRotate = spin;
  }, [spin, human]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const source = await api("skins.image", { id: skin.id });
      const image = new Image();
      image.src = source;
      await image.decode();
      if (!alive) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.imageSmoothingEnabled = false;
      context.drawImage(image, 0, 0);
      masterRef.current = canvas;
      history.current = [];
      setCanUndo(false);
      setUserZoom(1);
      setPaintDirty(false);
      setMasterTick((value) => value + 1);
    })().catch((loadError) => { if (alive) setLocalError(loadError.message); });
    return () => { alive = false; };
  }, [skin.id]);
  useEffect(() => {
    const viewer = viewerRef.current;
    const master = masterRef.current;
    if (!viewer || !master) return;
    const loaded = viewer.loadSkin(master, { model: model === "slim" ? "slim" : "default" });
    Promise.resolve(loaded).then(() => viewer.render());
  }, [masterTick, model]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const selected = POSES.find((item) => item[0] === pose);
    viewer.animation = selected ? selected[2]() : null;
  }, [pose, masterTick]);
  useEffect(() => {
    const view = paintCanvas.current;
    const master = masterRef.current;
    if (!view || !master || !box) return;
    const room = Math.max(160, (paintStage.current?.clientWidth || 480) - 28);
    const fit = Math.min(12, room / Math.max(box.w, box.h));
    const zoom = Math.min(32, Math.max(0.05, fit * userZoom));
    view.width = box.w * zoom;
    view.height = box.h * zoom;
    const context = view.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, view.width, view.height);
    context.drawImage(master, box.x, box.y, box.w, box.h, 0, 0, view.width, view.height);
    context.strokeStyle = "rgba(255,255,255,0.22)";
    context.beginPath();
    if (zoom >= 3) {
      for (let x = 0; x <= box.w; x += 1) {
        context.moveTo(x * zoom + 0.5, 0);
        context.lineTo(x * zoom + 0.5, view.height);
      }
      for (let y = 0; y <= box.h; y += 1) {
        context.moveTo(0, y * zoom + 0.5);
        context.lineTo(view.width, y * zoom + 0.5);
      }
      context.stroke();
    }
  }, [box?.x, box?.y, box?.w, box?.h, masterTick, userZoom, detailsOpen]);
  useEffect(() => {
    const stage = paintStage.current;
    if (!stage) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 1 / 1.12 : 1.12;
      changePaintZoom(factor);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [box]);

  function changePaintZoom(factor) {
    setUserZoom((value) => Math.min(8, Math.max(0.2, value * factor)));
  }
  function setPaintZoom(next) {
    setUserZoom(Math.min(8, Math.max(0.2, next)));
  }

  function point(event) {
    const view = paintCanvas.current;
    const rect = view.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / rect.width * box.w);
    const y = Math.floor((event.clientY - rect.top) / rect.height * box.h);
    if (x < 0 || y < 0 || x >= box.w || y >= box.h) return null;
    return { x: box.x + x, y: box.y + y };
  }
  function plot(x, y) {
    const context = masterRef.current.getContext("2d", { willReadFrequently: true });
    if (tool === "eraser") context.clearRect(x, y, 1, 1);
    else {
      context.fillStyle = color;
      context.clearRect(x, y, 1, 1);
      context.fillRect(x, y, 1, 1);
    }
  }
  function sample(pixel) {
    const data = masterRef.current.getContext("2d", { willReadFrequently: true }).getImageData(pixel.x, pixel.y, 1, 1).data;
    if (!data[3]) return;
    setColor("#" + [...data.subarray(0, 3)].map((value) => value.toString(16).padStart(2, "0")).join(""));
    setTool("pencil");
  }
  function pointerDown(event) {
    if (tool === "pan") {
      const stage = paintStage.current;
      if (!stage) return;
      drawing.current = true;
      lastPoint.current = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const pixel = point(event);
    if (!pixel) return;
    if (tool === "pick") { sample(pixel); return; }
    const context = masterRef.current.getContext("2d", { willReadFrequently: true });
    history.current.push(context.getImageData(0, 0, masterRef.current.width, masterRef.current.height));
    if (history.current.length > 30) history.current.shift();
    setCanUndo(true);
    setDirty(true);
    setPaintDirty(true);
    setSaved("");
    drawing.current = true;
    lastPoint.current = pixel;
    event.currentTarget.setPointerCapture(event.pointerId);
    plot(pixel.x, pixel.y);
    setMasterTick((value) => value + 1);
  }
  function pointerMove(event) {
    if (tool === "pan" && drawing.current && lastPoint.current && paintStage.current) {
      paintStage.current.scrollLeft = lastPoint.current.left - (event.clientX - lastPoint.current.x);
      paintStage.current.scrollTop = lastPoint.current.top - (event.clientY - lastPoint.current.y);
      return;
    }
    if (!drawing.current) return;
    const pixel = point(event);
    if (!pixel || !lastPoint.current) return;
    line(lastPoint.current.x, lastPoint.current.y, pixel.x, pixel.y, plot);
    lastPoint.current = pixel;
    setMasterTick((value) => value + 1);
  }
  useEffect(() => {
    const onKey = (event) => {
      const tag = event.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);
  function pointerUp() {
    drawing.current = false;
    lastPoint.current = null;
  }
  function resetPreview() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.resetCameraPose();
    viewer.zoom = 0.72;
    viewer.playerObject.rotation.y = Math.PI / 8;
    viewer.render();
  }
  function undo() {
    const snapshot = history.current.pop();
    if (!snapshot || !masterRef.current) return;
    masterRef.current.getContext("2d", { willReadFrequently: true }).putImageData(snapshot, 0, 0);
    setCanUndo(history.current.length > 0);
    setPaintDirty(history.current.length > 0);
    setDirty(true);
    setMasterTick((value) => value + 1);
  }
  function back() {
    if (dirty) setLeave(true);
    else onBack();
  }
  async function save() {
    if (!name.trim() || !author.trim()) { setLocalError("请填写人物名称和作者"); return; }
    setLocalError("");
    try {
      await onSave({
        id: skin.id,
        name,
        author,
        targetIdentifier: target,
        textureSlot: slot,
        image: masterRef.current ? masterRef.current.toDataURL("image/png") : undefined,
      });
      setDirty(false);
      setPaintDirty(false);
      setSaved("已保存");
      return true;
    } catch (saveError) {
      setLocalError(saveError.message);
      return false;
    }
  }
  async function paintFrom(url) {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
    masterRef.current = canvas;
    history.current = [];
    setCanUndo(false);
    setPaintDirty(false);
    setUserZoom(1);
    setMasterTick((value) => value + 1);
  }
  function applyPick(nextTarget, nextSlot) {
    const humanNext = !nextTarget || targets.some((item) => item.identifier === nextTarget && item.human);
    setTarget(nextTarget);
    setSlot(nextSlot);
    setDirty(true);
    setSaved("");
    if (humanNext) return;
    const url = npcSlotTexture(nextTarget, nextSlot);
    if (url) paintFrom(url).catch((loadError) => setLocalError(loadError.message));
  }
  const pendingTarget = useRef(null);
  function onTargetChange(value) {
    pendingTarget.current = value;
    const known = value === "" || targets.some((item) => item.identifier === value);
    if (!known) {
      setTarget(value);
      setDirty(true);
      setSaved("");
    }
  }
  function onSlotChange(value) {
    const nextTarget = pendingTarget.current == null ? target : pendingTarget.current;
    pendingTarget.current = null;
    const known = nextTarget === "" || targets.some((item) => item.identifier === nextTarget);
    if (!known) {
      setSlot(value);
      setDirty(true);
      setSaved("");
      return;
    }
    if (nextTarget === target && value === slot) return;
    if (paintDirty) setAsk({ target: nextTarget, slot: value });
    else applyPick(nextTarget, value);
  }
  async function acceptAsk(saveFirst) {
    const next = ask;
    if (saveFirst) {
      const ok = await save();
      if (!ok) return;
    }
    setAsk(null);
    applyPick(next.target, next.slot);
  }
  const parts = PARTS.filter((item) => !(legacy && (item[0] === "armL" || item[0] === "legL")));
  return <section className="skin-bench">
    <div className="skin-bench-bar">
      <Button icon="arrow" onClick={back}>返回</Button>
      <div>
        <h1>皮肤工作台</h1>
        <p className="muted">{skin.id}{saved ? " · " + saved : ""}</p>
      </div>
      <span className="spacer" />
      {!detailsOpen && <Button icon="panel" title="资料" aria-label="展开资料" onClick={() => setDetailsOpen(true)} />}
      <Button disabled={!canUndo || busy} onClick={undo}>撤销</Button>
      <Button primary disabled={busy} onClick={save}>保存</Button>
    </div>
    <ErrorBox>{localError || error}</ErrorBox>
    <div className={"skin-bench-grid" + (detailsOpen ? "" : " details-closed")}>
      <div className="skin-card">
        <h2>{human ? "人物" : "预览"}</h2>
        {human ? <>
          <div ref={stageHost} className="skin-3d-host">
            <canvas ref={stageCanvas} aria-label="皮肤工作台预览" />
          </div>
          <div className="skin-tools">
            <Button aria-pressed={spin} onClick={() => setSpin((value) => !value)}>{spin ? "停止旋转" : "继续旋转"}</Button>
            <Button onClick={resetPreview}>重置视角</Button>
          </div>
          <p className="muted skin-note">拖动旋转，滚轮缩放。姿势只影响这里的预览。</p>
          <div className="skin-choice" role="group" aria-label="体型">
            <button type="button" aria-pressed={model === "default"} onClick={() => setModel("default")}>Steve</button>
            <button type="button" aria-pressed={model === "slim"} onClick={() => setModel("slim")}>Alex</button>
          </div>
          <div className="skin-choice" role="group" aria-label="姿势">
            {POSES.map(([id, label]) => <button key={id} type="button" aria-pressed={pose === id} onClick={() => setPose(id)}>{label}</button>)}
          </div>
        </> : npcModel ? <>
          <NpcModelView model={npcModel} defaultSrc={npcTexture} canvasSource={masterRef} revision={masterTick} clips={npcClipsFor(target)} />
          {!npcTexture && <p className="muted skin-note">工具箱没有收录这个模型的默认贴图，3D 预览暂时使用当前绘制贴图。</p>}
          <p className="muted skin-note">3D 预览使用这个模型的默认贴图，方便确认几何体；中间画板仍是当前皮肤，绘制会保存到皮肤草稿。</p>
        </> : <p className="muted">工具箱没有这个目标模型的几何体，不能做 3D 预览。中间可以直接改整张贴图。</p>}
      </div>
      <div className="skin-card">
        <h2>绘制</h2>
        {human ? <>
          <div className="skin-choice" role="group" aria-label="身体部位">
            {parts.map(([id, label]) => <button key={id} type="button" aria-pressed={part === id} onClick={() => setPart(id)}>{label}</button>)}
          </div>
          {!legacy && <div className="skin-choice" role="group" aria-label="贴图层">
            <button type="button" aria-pressed={layer === "base"} onClick={() => setLayer("base")}>底层</button>
            <button type="button" aria-pressed={layer === "overlay"} onClick={() => setLayer("overlay")}>外层</button>
          </div>}
        </> : null}
        <div className={"skin-paint-stage" + (tool === "pan" ? " pan" : "")} ref={paintStage}>
          {box ? <canvas
            ref={paintCanvas}
            aria-label={human ? "皮肤部位画板" : "整张贴图画板"}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
          /> : <p className="muted">正在读取贴图…</p>}
        </div>
        <div className="skin-tools">
          <div className="skin-choice" role="group" aria-label="工具">
            <button type="button" aria-pressed={tool === "pan"} onClick={() => setTool("pan")}>拖动</button>
            <button type="button" aria-pressed={tool === "pencil"} onClick={() => setTool("pencil")}>铅笔</button>
            <button type="button" aria-pressed={tool === "eraser"} onClick={() => setTool("eraser")}>橡皮</button>
            <button type="button" aria-pressed={tool === "pick"} onClick={() => setTool("pick")}>取色</button>
          </div>
          <input className="skin-color" type="color" aria-label="颜色" value={color} onChange={(event) => { setColor(event.target.value); setTool("pencil"); }} />
        </div>
        <div className="skin-tools" role="group" aria-label="贴图缩放">
          <Button aria-label="缩小贴图" disabled={userZoom <= 0.2} onClick={() => changePaintZoom(1 / 1.25)}>−</Button>
          <output aria-label="贴图缩放">{Math.round(userZoom * 100)}%</output>
          <Button aria-label="放大贴图" disabled={userZoom >= 8} onClick={() => changePaintZoom(1.25)}>＋</Button>
          <Button onClick={() => setPaintZoom(1)}>适应画板</Button>
        </div>
        <p className="muted skin-note">{human ? (legacy ? "这是 64×32 旧皮肤，没有单独的左侧肢体和外层。" : "外层是帽子、袖子和裤腿，擦掉后会露出底层。") : "没有这个模型的身体分区，画板是整张贴图。游戏里的外形取决于目标模型自己的几何体。"}拖动可平移，滚轮可缩放。Ctrl+Z 撤销。</p>
      </div>
      {detailsOpen && <div className="skin-card">
        <div className="skin-card-head">
          <h2>资料</h2>
          <Button icon="close" title="收起资料" aria-label="收起资料" onClick={() => setDetailsOpen(false)} />
        </div>
        <Field label="人物名称">
          <input value={name} maxLength={120} onChange={(event) => { setName(event.target.value); setDirty(true); setSaved(""); }} />
        </Field>
        <Field label="作者">
          <input value={author} maxLength={120} onChange={(event) => { setAuthor(event.target.value); setDirty(true); setSaved(""); }} />
        </Field>
        <TargetFields targets={targets} value={target} slot={slot} onChange={onTargetChange} onSlot={onSlotChange} />
      </div>}
    </div>
    {ask && <Modal title="保存当前绘制？" description="切换模型和槽位后，画布会换成对应槽位的初始贴图。" onClose={() => setAsk(null)} busy={busy} footer={<><Button disabled={busy} onClick={() => setAsk(null)}>取消</Button><Button disabled={busy} onClick={() => acceptAsk(false)}>不保存并切换</Button><Button primary disabled={busy} onClick={() => acceptAsk(true)}>保存后切换</Button></>}>
    </Modal>}
    {leave && <Modal title="放弃未保存的修改？" description="返回列表后，这次绘制和资料修改不会写回草稿。" onClose={() => setLeave(false)} footer={<><Button onClick={() => setLeave(false)}>继续编辑</Button><Button primary onClick={onBack}>放弃修改</Button></>}>
    </Modal>}
  </section>;
}
