import React, { useEffect, useRef, useState } from "react";
import { Button, ErrorBox, Field, Modal, Select } from "../../app/ui.jsx";
import "./map-preview.css";

const call = (method, args = {}) => window.toolkit.call(method, args);
function fit(bounds, width, height) {
  if (!bounds) return { zoom: 1, x: 0, z: 0 };
  const zoom = Math.min(8, (width - 40) / (bounds.maxX - bounds.minX + 1), (height - 40) / (bounds.maxZ - bounds.minZ + 1));
  return { zoom: Math.max(.00001, zoom), x: (bounds.minX + bounds.maxX + 1) / 2, z: (bounds.minZ + bounds.maxZ + 1) / 2 };
}

export function MapPreview({ worldId, initialSource, projectId, worlds = [], onClose, onTerrain, onSelect, selectionMode = "area", initialDimension = "overworld", lockedSource = false, footprint, inline = false, onSource, focus, remembered, onRemember, markers = [], onObject }) {
  const canvas = useRef(null), drag = useRef(null), request = useRef(0), currentRequest = useRef(""), currentView = useRef({ zoom: 1, x: 0, z: 0 }), renderRef = useRef(null), viewInitialized = useRef(false), mapRef = useRef(null), loadedChunks = useRef(new Set()), mapUpdate = useRef(Promise.resolve()), loadTimer = useRef(null), pendingLoad = useRef(false);
  const currentWorlds = worlds.filter(world => !world.deleted && !world.copying && !world.error && world.present && world.ready);
  const [source, setSource] = useState(initialSource || ""), [selectedWorld, setSelectedWorld] = useState(worldId || "");
  const [sourceRevision, setSourceRevision] = useState(0);
  const [dimension, setDimension] = useState(initialDimension), [map, setMap] = useState(null), [view, setView] = useState({ zoom: 1, x: 0, z: 0 });
  const [size, setSize] = useState([800, 400]), [selection, setSelection] = useState(null), [pointer, setPointer] = useState(null);
  const fitCanvas = bounds => { const rect = canvas.current?.getBoundingClientRect(); return fit(bounds, rect?.width || size[0], rect?.height || size[1]); };
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [copied, setCopied] = useState(false), [progress,setProgress]=useState(null);
  const [relief,setRelief]=useState(true),[grid,setGrid]=useState(false);
  const [tool, setTool] = useState(onSelect ? selectionMode : "pan");
  const shownMarkers = markers.filter(item => item.position && ["overworld", "nether", "the_end"][item.dimension] === dimension && ["command", "container", "npc", "entity"].includes(item.kind)).slice(0, 500);
  const memory = useRef(null);
  memory.current = { source, dimension, view, selection };
  useEffect(() => () => onRemember?.(memory.current), []);
  const selectionData = () => ({ source, sourceWorldId: selectedWorld, kind: map?.format, dimension, selection });
  currentView.current = view;
  const visibleBounds = () => {
    const v = currentView.current, [width, height] = size, zoom = Math.max(.00001, v.zoom), margin = Math.max(64, Math.ceil(128 / zoom));
    return { minX: Math.floor(v.x - width / (2 * zoom)) - margin, maxX: Math.ceil(v.x + width / (2 * zoom)) + margin, minZ: Math.floor(v.z - height / (2 * zoom)) - margin, maxZ: Math.ceil(v.z + height / (2 * zoom)) + margin };
  };
  const visibleChunks = bounds => {
    const result = [], minX = Math.floor(bounds.minX / 16), maxX = Math.floor(bounds.maxX / 16), minZ = Math.floor(bounds.minZ / 16), maxZ = Math.floor(bounds.maxZ / 16);
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > 100000) return null;
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) if (!loadedChunks.current.has(x + "," + z)) result.push([x, z]);
    return result;
  };
  const applyMap = async value => {
    if (!value || value.requestId !== currentRequest.current) return;
    const merged = new Map((mapRef.current?.tiles || []).map(tile => [tile.x + "," + tile.z, tile]));
    const incoming = await Promise.all((value.tiles || []).map(async tile => { const image = new Image(); image.src = tile.image; await image.decode(); return { ...tile, image }; }));
    if (value.requestId !== currentRequest.current) return;
    for (const tile of incoming) {
      const key = tile.x + "," + tile.z, old = merged.get(key);
      if (!old) { merged.set(key, tile); continue; }
      const c = document.createElement("canvas"); c.width = c.height = tile.size;
      const g = c.getContext("2d"); g.drawImage(old.image, 0, 0); g.drawImage(tile.image, 0, 0); merged.set(key, { ...tile, image: c });
    }
    const tiles = [...merged.values()], bounds = tiles.length ? { minX: Math.min(...tiles.map(tile => tile.x)), maxX: Math.max(...tiles.map(tile => tile.x + tile.size - 1)), minZ: Math.min(...tiles.map(tile => tile.z)), maxZ: Math.max(...tiles.map(tile => tile.z + tile.size - 1)) } : null;
    const knownBounds = [mapRef.current?.bounds, value.bounds].filter(Boolean);
    const contentBounds = knownBounds.length ? { minX: Math.min(...knownBounds.map(b => b.minX)), maxX: Math.max(...knownBounds.map(b => b.maxX)), minZ: Math.min(...knownBounds.map(b => b.minZ)), maxZ: Math.max(...knownBounds.map(b => b.maxZ)) } : bounds;
    const next = { ...(mapRef.current || {}), ...value, bounds: contentBounds, tiles };
    for (const id of value.chunkIds || []) loadedChunks.current.add(id);
    next.chunksRead = Math.max(value.chunksRead || 0, loadedChunks.current.size);
    mapRef.current = next; setMap(next);
    if (!viewInitialized.current && next.bounds && canvas.current && value.complete) { viewInitialized.current = true; setView(fitCanvas(next.bounds)); }
  };
  const queueMap = value => { mapUpdate.current = mapUpdate.current.then(() => applyMap(value)).catch(() => {}); return mapUpdate.current; };
  const render = async () => {
    if(currentRequest.current){pendingLoad.current=true;return;}
    if (!source && !selectedWorld) return setError("请选择地图来源");
    const bounds = visibleBounds(), x = Math.round(currentView.current.x), z = Math.round(currentView.current.z), chunks = visibleChunks(bounds);
    if(![x,z,...Object.values(bounds)].every(v=>Math.abs(v)<=30000000))return setError("当前视野超出地图坐标范围");
    if (chunks === null) return setError("当前视野过大，请放大后继续加载");
    if (chunks && !chunks.length) return;
    pendingLoad.current=false;
    const id = ++request.current, requestId=crypto.randomUUID();
    currentRequest.current=requestId;
    setBusy(true); setProgress({stage:"准备地图"}); setError(""); setPointer(null); setCopied(false);
    try {
      const result = await call("map-preview.render", { requestId,worldId: selectedWorld, source, dimension, centerX:x,centerZ:z,bounds,chunks,relief });
      if(id!==request.current)return;
      if (!viewInitialized.current && result.bounds) { viewInitialized.current = true; setView(fitCanvas(result.bounds)); }
      await queueMap({ ...result, requestId });
    } catch (e) { if (id === request.current && e.message!=="地图加载已取消") setError(e.message); }
    finally { if (currentRequest.current === requestId) {setBusy(false);setProgress(null);currentRequest.current="";if(pendingLoad.current)setTimeout(render,0);} }
  };
  renderRef.current = render;
  const cancel=async()=>{
    const id=currentRequest.current;if(!id)return;
    request.current++;setProgress({stage:"正在取消"});
    try{await call("map-preview.cancel",{requestId:id});}catch(e){setError(e.message);}
    finally{if(currentRequest.current===id){currentRequest.current="";setBusy(false);setProgress(null);}}
  };
  const scheduleLoad = () => {
    if (loadTimer.current) clearTimeout(loadTimer.current);
    loadTimer.current = setTimeout(() => { loadTimer.current = null; renderRef.current?.(); }, 120);
  };
  useEffect(() => {
    const off = window.toolkit.onMapPreview(queueMap);
    let alive = true;
    const previous = currentRequest.current;
    request.current++;
    currentRequest.current = "";
    const previousView = remembered?.source === source && remembered.dimension === dimension ? remembered : null;
    const target = focus && focus.dimension === dimension ? { zoom: 4, x: focus.position[0], z: focus.position[2] } : previousView?.view;
    loadedChunks.current.clear(); mapRef.current = null; viewInitialized.current = !!target; setMap(null); setSelection(previousView?.selection || null); setView(target || { zoom: 1, x: 0, z: 0 }); currentView.current = target || { zoom: 1, x: 0, z: 0 }; setBusy(false); setProgress(null);
    const start = async () => {
      if (previous) await call("map-preview.cancel", { requestId: previous }).catch(() => {});
      if (alive && (worldId || initialSource || source || selectedWorld)) render();
    };
    start();
    return () => { alive = false; off(); request.current++; if(loadTimer.current)clearTimeout(loadTimer.current); const id=currentRequest.current; currentRequest.current=""; if(id)call("map-preview.cancel",{requestId:id}).catch(()=>{}); };
  }, [source, selectedWorld, dimension, sourceRevision]);
  useEffect(()=>{
    if(!busy)return;
    let alive=true,timer;const id=currentRequest.current;
    const poll=async()=>{
      try{const value=await call("map-preview.state",{requestId:id});if(alive&&currentRequest.current===id&&value)setProgress(value);}catch{}
      if(alive)timer=setTimeout(poll,250);
    };
    poll();return()=>{alive=false;clearTimeout(timer);};
  },[busy]);
  useEffect(() => {
    const c = canvas.current;
    const observer = new ResizeObserver(() => { const r = c.getBoundingClientRect(); setSize([r.width, r.height]); });
    observer.observe(c);
    // React 的 wheel 监听是 passive；在画布上显式阻止滚轮带动整个弹窗。
    const wheel = e => {
      e.preventDefault();
      const v = currentView.current;
      if (!v) return;
      const r = c.getBoundingClientRect(), dx = e.clientX - r.left - r.width / 2, dz = e.clientY - r.top - r.height / 2;
      const zoom = Math.max(.00001, Math.min(32, v.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      setView({ zoom, x: v.x + dx / v.zoom - dx / zoom, z: v.z + dz / v.zoom - dz / zoom });
      scheduleLoad();
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); c.removeEventListener("wheel", wheel); };
  }, []);
  useEffect(() => {
    const c = canvas.current, [width, height] = size, ratio = window.devicePixelRatio || 1;
    c.width = Math.round(width * ratio); c.height = Math.round(height * ratio);
    const g = c.getContext("2d"); g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.fillStyle = "#111820"; g.fillRect(0, 0, width, height);
    if (!map || !view) return;
    // 完整方块像素保留在瓦片中，缩小平滑取样、放大保持像素清晰。
    const unit = view.zoom;
    g.imageSmoothingEnabled=unit<1;
    g.imageSmoothingQuality="high";
    for (const tile of map.tiles) {
      const x = width / 2 + (tile.x - view.x) * unit, y = height / 2 + (tile.z - view.z) * unit, side=tile.size*unit;
      if (x + side < 0 || y + side < 0 || x > width || y > height) continue;
      // 相邻瓦片共用物理像素边界，消除非整数缩放时露出的深色接缝。
      const left=Math.round(x*ratio)/ratio, top=Math.round(y*ratio)/ratio;
      g.drawImage(tile.image,left,top,Math.round((x+side)*ratio)/ratio-left,Math.round((y+side)*ratio)/ratio-top);
    }
    if (grid && unit * 16 >= 32) {
      g.strokeStyle = "rgba(255,255,255,.18)"; g.lineWidth = 1;
      for (let x = Math.floor((view.x - width / (2 * unit)) / 16) * 16; x < view.x + width / (2 * unit); x += 16) {
        const px = width / 2 + (x - view.x) * unit; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, height); g.stroke();
      }
      for (let z = Math.floor((view.z - height / (2 * unit)) / 16) * 16; z < view.z + height / (2 * unit); z += 16) {
        const py = height / 2 + (z - view.z) * unit; g.beginPath(); g.moveTo(0, py); g.lineTo(width, py); g.stroke();
      }
    }
    for (const item of shownMarkers) {
      const x = width / 2 + (item.position[0] - view.x) * unit, y = height / 2 + (item.position[2] - view.z) * unit;
      g.fillStyle = item.kind === "npc" ? "#d9aaff" : item.kind === "command" ? "#ffc36b" : "#71d5d0";
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
    }
    if (selection) {
      const x = width / 2 + (selection.minX - view.x) * unit, y = height / 2 + (selection.minZ - view.z) * unit;
      const w = (selectionMode === "point" && footprint ? footprint[0] : selection.maxX - selection.minX + 1) * unit, h = (selectionMode === "point" && footprint ? footprint[1] : selection.maxZ - selection.minZ + 1) * unit;
      g.fillStyle = "rgba(255,210,80,.2)"; g.fillRect(x, y, w, h);
      g.strokeStyle = "#ffd250"; g.lineWidth = 2; g.strokeRect(x, y, w, h);
    }
  }, [map, view, selection, size, grid, footprint, selectionMode, markers]);
  const worldAt = e => {
    const r = canvas.current.getBoundingClientRect(), v = currentView.current;
    return { x: Math.floor(v.x + (e.clientX - r.left - r.width / 2) / v.zoom), z: Math.floor(v.z + (e.clientY - r.top - r.height / 2) / v.zoom) };
  };
  const begin = e => {
    if (!view || e.button !== 0 || !map || error || busy) return;
    const point = worldAt(e);
    if (tool === "point") setSelection({ minX: point.x, maxX: point.x, minZ: point.z, maxZ: point.z });
    drag.current = { screen: { x: e.clientX, y: e.clientY }, view: { ...view }, point, select: tool === "area" || e.shiftKey, pointOnly: tool === "point" };
    canvas.current.setPointerCapture(e.pointerId); setCopied(false);
  };
  const move = e => {
    if (!view) return;
    const point = worldAt(e); setPointer(point);
    const d = drag.current; if (!d) return;
    if (d.pointOnly) return;
    if (d.select) setSelection({ minX: Math.min(d.point.x, point.x), maxX: Math.max(d.point.x, point.x), minZ: Math.min(d.point.z, point.z), maxZ: Math.max(d.point.z, point.z) });
    else setView({ ...d.view, x: d.view.x - (e.clientX - d.screen.x) / d.view.zoom, z: d.view.z - (e.clientY - d.screen.y) / d.view.zoom });
  };
  const end = () => { drag.current = null; scheduleLoad(); };
  const pick = async kind => {
    try {
      const value = await call("map-preview.pick", { kind });
      if (value) { onSource?.({ source: value, worldId: "", dimension }); setSource(value); setSelectedWorld(""); setSourceRevision(v => v + 1); viewInitialized.current=false; mapRef.current=null; loadedChunks.current.clear(); setMap(null); setView({ zoom: 1, x: 0, z: 0 }); setSelection(null); setError(""); setCopied(false); }
    } catch (e) { setError(e.message); }
  };
  const copySelection = async () => {
    try { await call("map-preview.copy", { text: selection.minX + "," + selection.minZ + " → " + selection.maxX + "," + selection.maxZ }); setCopied(true); }
    catch (e) { setError(e.message); }
  };
  return <Modal inline={inline} wide title={onSelect ? selectionMode === "point" ? "在地图上选择目标落点" : "在地图上框选来源区域" : "地图预览"} description="查看已保存的地形；框选决定 X/Z，Y 高度在导入向导中设置。" onClose={onClose} footer={<><Button onClick={onClose}>{onSelect ? "取消选取" : "关闭"}</Button>{onSelect && <Button primary disabled={!selection || busy || !!error || !map?.complete} onClick={() => onSelect(selectionData())}>{selectionMode === "point" ? "使用此落点" : "使用此选区"}</Button>}{onTerrain && <Button primary onClick={() => onTerrain({ targetWorldId: selectedWorld || worldId || "" })}>地形与建筑导入</Button>}</>}>
    <div className="map-preview">
      <div className="map-preview-toolbar">
        {!lockedSource && <>
        <Field label="选择当前存档"><Select value={selectedWorld} disabled={lockedSource || busy || !currentWorlds.length} onChange={value => { const world = currentWorlds.find(item => item.id === value); if (!world) return; onSource?.({ source: world.path, worldId: world.id, dimension }); setSelectedWorld(value); setSource(world.path); viewInitialized.current=false; mapRef.current=null; loadedChunks.current.clear(); setMap(null); setView({ zoom: 1, x: 0, z: 0 }); setSelection(null); setError(""); }} options={currentWorlds.map(world => ({ value: world.id, label: world.name }))} placeholder={currentWorlds.length ? "请选择存档" : "没有可用存档"} /></Field>
        <Select aria-label="选择外部地图" value="" placeholder="选择外部地图" disabled={lockedSource || busy} onChange={pick} options={[{ value: "folder", label: "文件夹" }, { value: "archive", label: "ZIP / MCWORLD" }]} />
        </>}
        <Field label="维度"><Select value={dimension} disabled={busy} onChange={v => { setDimension(v); viewInitialized.current=false; mapRef.current=null; loadedChunks.current.clear(); setMap(null); setView({ zoom: 1, x: 0, z: 0 }); setSelection(null); }} options={[{ value: "overworld", label: "主世界" }, { value: "nether", label: "下界" }, { value: "the_end", label: "末地" }]} /></Field>
        <Field label="地图操作"><Select value={tool} onChange={setTool} options={[{ value: "pan", label: "拖动浏览" }, { value: selectionMode, label: selectionMode === "point" ? "点击选落点" : "拖动框选区域" }]} /></Field>
        {busy&&<Button onClick={cancel}>取消加载</Button>}
        <Button disabled={!map?.bounds || busy} onClick={() => { setView(fit(map.bounds, ...size)); scheduleLoad(); }}>适应画布</Button>
        <Button disabled={!map?.bounds||busy} onClick={()=>{setView(v=>({...v,zoom:1}));scheduleLoad();}}>1:1</Button>
        <label><input type="checkbox" checked={grid} onChange={e=>setGrid(e.target.checked)} />区块网格</label>
      </div>
      <div className="map-preview-meta" role="status">
        <span className="map-preview-source" title={source}>{source || "请选择 Java 或基岩存档"}</span>
        {map && <span>{map.format === "java" ? "Java" : "基岩"} · {map.chunksRead} 个区块{map.truncated ? " · 已按预览上限截取" : ""}{map.skipped ? " · " + map.skipped + " 个区块无法解析" : ""} · 每方块 1 像素 · 内置地图配色</span>}
      </div>
      <details className="map-preview-options"><summary>显示选项</summary><div>
        <label><input type="checkbox" checked={relief} onChange={e=>{setRelief(e.target.checked);loadedChunks.current.clear();setTimeout(()=>renderRef.current?.(),0);}} disabled={busy} />地形明暗与水深</label>
        <small>进入预览后按当前视野异步加载已生成区块；拖动或缩放地图会继续加载附近区块，已显示内容会保留，不生成未探索的游戏地形。</small>
      </div></details>
      <canvas ref={canvas} aria-label="地图画布" className="map-preview-canvas" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onDoubleClick={event => {
        const rect = canvas.current.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
        const object = shownMarkers.find(item => Math.hypot(size[0] / 2 + (item.position[0] - view.x) * view.zoom - x, size[1] / 2 + (item.position[2] - view.z) * view.zoom - y) < 9);
        if (object) onObject?.(object.id);
      }} />
      {!!shownMarkers.length && <Select aria-label="地图数据对象" value="" placeholder={`已标记 ${shownMarkers.length} 个对象（最多 500）`} options={shownMarkers.map(item => ({ value: item.id, label: `${item.name} · ${item.position.join(", ")}` }))} onChange={id => onObject?.(id)} />}
      <div className="map-preview-status">
        <span>{busy ? (progress?.stage||"准备地图")+(progress?.total?` ${progress.completed}/${progress.total}`:progress?.completed?` · 已检查 ${progress.completed} 条`:"") : map ? map.bounds ? "范围 X " + map.bounds.minX + "～" + map.bounds.maxX + "，Z " + map.bounds.minZ + "～" + map.bounds.maxZ : "该维度没有可预览的已生成区块" : "选择地图后生成预览"}</span>
        {view && <span>缩放 {view.zoom.toFixed(3)} px/格</span>}{pointer && <span>光标 X {pointer.x}，Z {pointer.z}</span>}
      </div>
      <div className="map-preview-status map-preview-selection">{selection ? <><span>选区 X {selection.minX}～{selection.maxX}，Z {selection.minZ}～{selection.maxZ}</span><Button onClick={copySelection}>复制坐标</Button>{onTerrain && <Button disabled={busy || !!error || !map?.complete || (map?.format === "java" && /\.(zip|mcworld)$/i.test(source))} onClick={() => onTerrain({ targetWorldId: worldId || "", sourceSelection: selectionData() })}>以此选区为来源</Button>}{copied && <span role="status">已复制坐标</span>}</> : <span>{selectionMode === "point" ? "选择“点击选落点”，点击地图设置目标原点；黄色范围表示导入占地。" : "选择“拖动框选区域”，或按住 Shift 拖动；范围包含两个角点。"}</span>}</div>
      <ErrorBox>{error}</ErrorBox>
    </div>
  </Modal>;
}
