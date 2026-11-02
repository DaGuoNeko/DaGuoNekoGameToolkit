import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, ErrorBox, Field, Modal, Select } from "../../app/ui.jsx";
import "./map-preview.css";

const call = (method, args = {}) => window.toolkit.call(method, args);
function fit(bounds, width, height) {
  if (!bounds) return { zoom: 1, x: 0, z: 0 };
  const zoom = Math.min(8, (width - 40) / (bounds.maxX - bounds.minX + 1), (height - 40) / (bounds.maxZ - bounds.minZ + 1));
  return { zoom: Math.max(.00001, zoom), x: (bounds.minX + bounds.maxX + 1) / 2, z: (bounds.minZ + bounds.maxZ + 1) / 2 };
}

export function MapPreview({ worldId, initialSource, onClose }) {
  const canvas = useRef(null), drag = useRef(null), request = useRef(0), currentRequest = useRef(""), currentView = useRef(null);
  const [source, setSource] = useState(initialSource || ""), [selectedWorld, setSelectedWorld] = useState(worldId);
  const [dimension, setDimension] = useState("overworld"), [map, setMap] = useState(null), [view, setView] = useState(null);
  const [size, setSize] = useState([800, 400]), [selection, setSelection] = useState(null), [pointer, setPointer] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [copied, setCopied] = useState(false), [progress,setProgress]=useState(null);
  const [centerX,setCenterX]=useState("0"),[centerZ,setCenterZ]=useState("0");
  const [maxChunks,setMaxChunks]=useState("2500");
  const [relief,setRelief]=useState(true),[grid,setGrid]=useState(false);
  currentView.current = view;
  const render = async (nearView=false) => {
    if(currentRequest.current)return;
    if (!source && !selectedWorld) return setError("请选择地图来源");
    if(![centerX,centerZ].every(v=>/^-?\d+$/.test(v)&&Math.abs(Number(v))<=30000000)) return setError("中心坐标应为有效整数");
    if(!/^\d+$/.test(maxChunks)||Number(maxChunks)<128||Number(maxChunks)>10000) return setError("区块上限应为 128～10000");
    const keepView=nearView&&currentView.current?{...currentView.current}:null;
    const x=keepView?Math.round(keepView.x):Number(centerX),z=keepView?Math.round(keepView.z):Number(centerZ);
    if(![x,z].every(v=>Math.abs(v)<=30000000))return setError("当前视野超出地图坐标范围");
    if(keepView){setCenterX(String(x));setCenterZ(String(z));}
    const id = ++request.current, requestId=crypto.randomUUID();
    currentRequest.current=requestId;
    setBusy(true); setProgress({stage:"准备地图"}); setError(""); setSelection(null); setPointer(null); setCopied(false);
    try {
      const result = await call("map-preview.render", { requestId,worldId: selectedWorld, source, dimension, centerX:x,centerZ:z,maxChunks:Number(maxChunks),relief });
      if(id!==request.current)return;
      const tiles=await Promise.all(result.tiles.map(async tile=>{
        const image=new Image(); image.src=tile.image; await image.decode();
        return {...tile,image};
      }));
      if (id !== request.current) return;
      setMap({...result,tiles,keepView});
    } catch (e) { if (id === request.current && e.message!=="地图加载已取消") setError(e.message); }
    finally { if (currentRequest.current === requestId) {setBusy(false);setProgress(null);currentRequest.current="";} }
  };
  const cancel=async()=>{
    const id=currentRequest.current;if(!id)return;
    request.current++;setProgress({stage:"正在取消"});
    try{await call("map-preview.cancel",{requestId:id});}catch(e){setError(e.message);}
    finally{if(currentRequest.current===id){currentRequest.current="";setBusy(false);setProgress(null);}}
  };
  useLayoutEffect(()=>{
    if(!map) return;
    if(map.keepView){setView(map.keepView);return;}
    // 元数据出现后画布会变高/变矮，等 DOM 更新后再计算初始比例。
    const rect=canvas.current.getBoundingClientRect(),initial=fit(map.bounds,rect.width,rect.height);
    if(map.bounds && Math.max(map.bounds.maxX-map.bounds.minX,map.bounds.maxZ-map.bounds.minZ)>512) {
      initial.zoom=Math.max(initial.zoom,1); initial.x=map.centerX; initial.z=map.centerZ;
    }
    setView(initial);
  },[map]);
  useEffect(() => {
    if (worldId || initialSource) render();
    return () => { request.current++;if(currentRequest.current)call("map-preview.cancel",{requestId:currentRequest.current}).catch(()=>{}); };
  }, []);
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
    if (selection) {
      const x = width / 2 + (selection.minX - view.x) * unit, y = height / 2 + (selection.minZ - view.z) * unit;
      const w = (selection.maxX - selection.minX + 1) * unit, h = (selection.maxZ - selection.minZ + 1) * unit;
      g.fillStyle = "rgba(255,210,80,.2)"; g.fillRect(x, y, w, h);
      g.strokeStyle = "#ffd250"; g.lineWidth = 2; g.strokeRect(x, y, w, h);
    }
  }, [map, view, selection, size, grid]);
  const worldAt = e => {
    const r = canvas.current.getBoundingClientRect(), v = currentView.current;
    return { x: Math.floor(v.x + (e.clientX - r.left - r.width / 2) / v.zoom), z: Math.floor(v.z + (e.clientY - r.top - r.height / 2) / v.zoom) };
  };
  const begin = e => {
    if (!view || !map || e.button !== 0) return;
    drag.current = { screen: { x: e.clientX, y: e.clientY }, view: { ...view }, point: worldAt(e), select: e.shiftKey };
    canvas.current.setPointerCapture(e.pointerId); setCopied(false);
  };
  const move = e => {
    if (!view || !map) return;
    const point = worldAt(e); setPointer(point);
    const d = drag.current; if (!d) return;
    if (d.select) setSelection({ minX: Math.min(d.point.x, point.x), maxX: Math.max(d.point.x, point.x), minZ: Math.min(d.point.z, point.z), maxZ: Math.max(d.point.z, point.z) });
    else setView({ ...d.view, x: d.view.x - (e.clientX - d.screen.x) / d.view.zoom, z: d.view.z - (e.clientY - d.screen.y) / d.view.zoom });
  };
  const pick = async archive => {
    try {
      const value = await call("map-preview.pick", { kind: archive ? "zip" : "folder" });
      if (value) { setSource(value); setSelectedWorld(null); setMap(null); setView(null); setSelection(null); setError(""); setCopied(false); }
    } catch (e) { setError(e.message); }
  };
  const copySelection = async () => {
    try { await call("map-preview.copy", { text: selection.minX + "," + selection.minZ + " → " + selection.maxX + "," + selection.maxZ }); setCopied(true); }
    catch (e) { setError(e.message); }
  };
  return <Modal wide title="地图预览" description="只读俯视像素地图。拖动浏览；按住 Shift 拖动框选区域。北方朝上，东方朝右。" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    <div className="map-preview">
      <div className="map-preview-toolbar">
        <Button disabled={busy} onClick={() => pick(false)}>选择文件夹</Button>
        <Button disabled={busy} onClick={() => pick(true)}>选择 ZIP / MCWORLD</Button>
        <Field label="维度"><Select value={dimension} disabled={busy} onChange={v => { setDimension(v); setMap(null); setView(null); setSelection(null); }} options={[{ value: "overworld", label: "主世界" }, { value: "nether", label: "下界" }, { value: "the_end", label: "末地" }]} /></Field>
        <Button primary disabled={busy || (!source && !selectedWorld)} onClick={()=>render()}>{busy ? "正在读取…" : "重新生成预览"}</Button>
        {busy&&<Button onClick={cancel}>取消加载</Button>}
        <Button disabled={busy||!map||!view} onClick={()=>render(true)}>加载当前视野附近</Button>
        <Button disabled={!map?.bounds || busy} onClick={() => setView(fit(map.bounds, ...size))}>适应画布</Button>
        <Button disabled={!map?.bounds||busy} onClick={()=>setView(v=>({...v,zoom:1}))}>1:1</Button>
        <label><input type="checkbox" checked={grid} onChange={e=>setGrid(e.target.checked)} />区块网格</label>
      </div>
      <div className="map-preview-meta" role="status">
        <span className="map-preview-source" title={source}>{source || "请选择 Java 或基岩存档"}</span>
        {map && <span>{map.format === "java" ? "Java" : "基岩"} · {map.chunksRead} 个区块{map.truncated ? " · 已按预览上限截取" : ""}{map.skipped ? " · " + map.skipped + " 个区块无法解析" : ""} · 每方块 1 像素 · 内置地图配色</span>}
      </div>
      <details className="map-preview-options"><summary>定位与显示</summary><div>
        <Field label="中心 X"><input type="number" step="1" value={centerX} onChange={e=>setCenterX(e.target.value)} disabled={busy} /></Field>
        <Field label="中心 Z"><input type="number" step="1" value={centerZ} onChange={e=>setCenterZ(e.target.value)} disabled={busy} /></Field>
        <Field label="区块上限"><input type="number" min="128" max="10000" step="128" value={maxChunks} onChange={e=>setMaxChunks(e.target.value)} disabled={busy} /></Field>
        <label><input type="checkbox" checked={relief} onChange={e=>setRelief(e.target.checked)} disabled={busy} />地形明暗与水深</label>
        <small>默认 2500 区块，可选 128～10000。拖到空白区域后点“加载当前视野附近”，或修改中心坐标再生成。新区域加载成功后替换旧区域，不生成未探索的游戏地形。</small>
      </div></details>
      <canvas ref={canvas} aria-label="地图画布" className="map-preview-canvas" onPointerDown={begin} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
      <div className="map-preview-status">
        <span>{busy ? (progress?.stage||"准备地图")+(progress?.total?` ${progress.completed}/${progress.total}`:progress?.completed?` · 已检查 ${progress.completed} 条`:"") : map ? map.bounds ? "范围 X " + map.bounds.minX + "～" + map.bounds.maxX + "，Z " + map.bounds.minZ + "～" + map.bounds.maxZ : "该维度没有可预览的已生成区块" : "选择地图后生成预览"}</span>
        {view && <span>缩放 {view.zoom.toFixed(3)} px/格</span>}{pointer && <span>光标 X {pointer.x}，Z {pointer.z}</span>}
      </div>
      <div className="map-preview-status map-preview-selection">{selection ? <><span>选区 X {selection.minX}～{selection.maxX}，Z {selection.minZ}～{selection.maxZ}</span><Button onClick={copySelection}>复制坐标</Button>{copied && <span role="status">已复制坐标</span>}</> : <span>按住 Shift 拖动框选；框选坐标包含两个角点。</span>}</div>
      <ErrorBox>{error}</ErrorBox>
    </div>
  </Modal>;
}
