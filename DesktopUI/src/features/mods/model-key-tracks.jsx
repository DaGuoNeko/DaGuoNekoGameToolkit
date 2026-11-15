import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../app/ui.jsx";
import { Curve } from "./model-curve.jsx";
import { timelineTimeAt, timelineTicks, neighboringTime } from "../../../shared/model-timeline-view.cjs";

export function KeyTracks({ rows, boneName, channel, length, time, selection, disabled, revision, playing, effects = [], curve, mode = "tracks", onBone, onSelect, onMove, onTime, onEffect }) {
  const host = useRef(null), drag = useRef(null), skipClick = useRef(false), callbacks = useRef({});
  const [ghost, setGhost] = useState(null), [zoom, setZoom] = useState(1), [folded, setFolded] = useState([]);
  const [view, setView] = useState({ width: 1, height: 120, left: 0 });
  const [overlay, setOverlay] = useState(false);
  const selectedIds = useMemo(() => new Set(selection.map(item => JSON.stringify([item.bone, item.channel, item.time]))), [selection]);
  const ghostIds = useMemo(() => new Set((ghost?.selection || []).map(item => JSON.stringify([item.bone, item.channel, item.time]))), [ghost?.selection]);
  const labelWidth = 156, trackWidth = Math.max(120, view.width - labelWidth) * zoom;
  const width = labelWidth + trackWidth;
  const ticks = timelineTicks(length, trackWidth, view.left, Math.max(1, view.width - labelWidth));
  const at = length ? Math.min(1, Math.max(0, time / length)) : 0;
  const times = rows.flatMap(row => row.channels.flatMap(track => track.times)).concat(effects.flatMap(track => track.items.map(item => item.time)));
  callbacks.current = { onTime, revision };

  const cancel = (restore = true) => {
    const mark = drag.current;
    drag.current = null; setGhost(null);
    if (!mark) return;
    skipClick.current = true;
    if (restore && mark.kind === "scrub" && mark.revision === callbacks.current.revision) callbacks.current.onTime(mark.time);
    if (mark.node.hasPointerCapture(mark.pointer)) mark.node.releasePointerCapture(mark.pointer);
  };
  useEffect(() => {
    const blur = () => cancel();
    const escape = event => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    window.addEventListener("blur", blur); window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("blur", blur); window.removeEventListener("keydown", escape, true); };
  }, []);
  useEffect(() => { cancel(false); }, [revision, length, disabled, zoom, mode]);
  useLayoutEffect(() => { host.current.scrollTop = 0; }, [mode]);
  useLayoutEffect(() => {
    const node = host.current;
    const measure = () => setView({ width: node.clientWidth, height: node.clientHeight, left: node.scrollLeft });
    const observer = new ResizeObserver(measure); observer.observe(node); measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = host.current;
    // 缩放后把当前时间留在可见区域，标签列始终固定。
    const x = 6 + at * (trackWidth - 12), visible = Math.max(1, node.clientWidth - labelWidth);
    node.scrollLeft = Math.max(0, Math.min(width - node.clientWidth, x - visible / 2));
  }, [zoom]);
  const reveal = () => {
    const node = host.current, visible = Math.max(1, node.clientWidth - labelWidth);
    node.scrollLeft = Math.max(0, 6 + at * (trackWidth - 12) - visible / 2);
  };
  useEffect(() => {
    if (!playing || drag.current) return;
    const node = host.current, x = 6 + at * (trackWidth - 12), visible = Math.max(1, node.clientWidth - labelWidth);
    if (x < node.scrollLeft || x > node.scrollLeft + visible - 12) node.scrollLeft = Math.max(0, x - visible / 4);
  }, [playing, time, trackWidth]);
  const position = (event, node) => timelineTimeAt(event.clientX - node.getBoundingClientRect().left, node.clientWidth, length);
  const startScrub = event => {
    if (disabled || event.button !== 0 || event.target.closest("button")) return;
    const node = event.currentTarget;
    event.preventDefault(); node.focus({ preventScroll: true }); node.setPointerCapture(event.pointerId);
    drag.current = { kind: "scrub", node, pointer: event.pointerId, time, revision };
    onTime(position(event, node));
  };
  const move = event => {
    const mark = drag.current;
    if (!mark || event.pointerId !== mark.pointer) return;
    if (mark.revision !== revision || disabled) { cancel(false); return; }
    if (mark.kind === "scrub") { onTime(position(event, mark.node)); return; }
    const distance = event.clientX - mark.x;
    mark.moved ||= Math.abs(distance) >= 3;
    if (!mark.moved) return;
    mark.delta = Math.round(distance / mark.width * length * 20) / 20;
    setGhost({ ...mark });
  };
  const finish = event => {
    const mark = drag.current;
    if (!mark || event.pointerId !== mark.pointer) return;
    move(event);
    if (drag.current !== mark) return;
    drag.current = null; setGhost(null);
    if (mark.node.hasPointerCapture(mark.pointer)) mark.node.releasePointerCapture(mark.pointer);
    if (mark.kind !== "key" || !mark.moved) return;
    skipClick.current = true;
    if (mark.delta) onMove(mark);
  };
  const seekKeys = event => {
    if (disabled || event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = length;
    else if (["ArrowLeft", "ArrowRight"].includes(event.key)) next = Math.round((time + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 0.5 : 0.05)) * 20) / 20;
    else return;
    event.preventDefault(); event.stopPropagation(); onTime(Math.max(0, Math.min(length, next)));
  };
  const pointerEvents = { onPointerMove: move, onPointerUp: finish, onPointerCancel: () => cancel(), onLostPointerCapture: () => cancel() };
  const playhead = <div className="model-key-playhead" aria-hidden="true" style={{ left: labelWidth + 6 + (trackWidth - 12) * at }} />;
  return <>
    <div className="model-timeline-navigation">
      <Button disabled={disabled || time <= 0} onClick={() => onTime(neighboringTime(times, time, -1, length))}>上一关键帧</Button>
      <Button disabled={disabled || time >= length} onClick={() => onTime(neighboringTime(times, time, 1, length))}>下一关键帧</Button>
      <input aria-label="时间" type="range" min="0" max={length} step="0.05" disabled={disabled} value={Math.min(time, length)} onChange={event => onTime(Number(event.target.value))} />
      <Button disabled={zoom === 1} aria-label="缩小时间轴" onClick={() => setZoom(value => Math.max(1, value / 2))}>−</Button>
      <span aria-label="时间轴缩放">{zoom * 100}%</span>
      <Button disabled={zoom === 32} aria-label="放大时间轴" onClick={() => setZoom(value => Math.min(32, value * 2))}>＋</Button>
      <Button onClick={() => setZoom(1)}>适应时长</Button><Button disabled={disabled} onClick={reveal}>定位播放头</Button>
    </div>
    <div ref={host} className="model-timeline-scroll" tabIndex={0} role="region" aria-label="时间轴轨道区" onKeyDown={seekKeys} onScroll={event => setView({ width: event.currentTarget.clientWidth, height: event.currentTarget.clientHeight, left: event.currentTarget.scrollLeft })}>
      <div className="model-timeline-content" style={{ width, "--track-label": labelWidth + "px" }}>
        <div className="model-ruler-row">
          <div className="model-timeline-label" title={mode === "curve" ? "当前编辑 " + "XYZ"[curve.axis] + " 轴 · " + (boneName || "未选骨骼") : undefined}>{mode === "curve" ? "曲线 " + "XYZ"[curve.axis] + " · " + (boneName || "未选骨骼") : "骨骼 / 通道"}</div>
          <div className="model-timeline-ruler" role="slider" tabIndex={disabled ? -1 : 0} aria-label="时间刻度" aria-valuemin={0} aria-valuemax={length} aria-valuenow={time} aria-disabled={disabled}
            onPointerDown={startScrub} {...pointerEvents} onKeyDown={seekKeys}>
            {ticks.map(tick => <span key={tick.time} className={tick.time === length ? "last" : ""} style={{ left: tick.x }}>{tick.time.toFixed(2)}</span>)}
            <i className="model-ruler-head" style={{ left: 6 + at * (trackWidth - 12) }} />
          </div>
        </div>
        {mode === "curve" ? <div className="model-graph-row">
          <div className="model-timeline-label model-graph-controls">
            <select aria-label="曲线通道" disabled={disabled || !boneName} value={channel} onChange={event => curve.onChannel(event.target.value)}><option value="rotation">旋转</option><option value="position">位移</option><option value="scale">缩放</option></select>
            <div className="model-graph-axes" role="toolbar" aria-label="曲线轴">{[0,1,2].map(axis => <button type="button" key={axis} data-axis={"XYZ"[axis]} title={"编辑 " + "XYZ"[axis] + " 轴"} aria-pressed={curve.axis === axis} onClick={() => curve.onAxis(axis)}>{"XYZ"[axis]}</button>)}</div>
            <div className="model-graph-ends" role="toolbar" aria-label="曲线端点"><button type="button" aria-pressed={curve.part === "pre"} disabled={!curve.incoming.length} onClick={() => curve.onPart("pre")}>入点</button><button type="button" aria-pressed={curve.part === "post"} onClick={() => curve.onPart("post")}>出点</button></div>
            <div className="model-graph-options"><label title="同时显示三个轴，圆点只编辑当前轴"><input type="checkbox" aria-label="叠加 XYZ" checked={overlay} onChange={event => setOverlay(event.target.checked)} />叠加 XYZ</label><Button disabled={disabled || curve.readonly || curve.keys.length < 2} onClick={curve.onBezier}>贝塞尔缓动</Button>{curve.onNativeBezier && <Button disabled={disabled || curve.readonly} onClick={curve.onNativeBezier}>原生控制柄</Button>}</div>
          </div>
          {!boneName || curve.readonly ? <p className="model-graph-empty">{!boneName ? "选择一根骨骼以编辑曲线" : "当前通道含 Molang，仅支持预览；原表达式保留。"}</p> : <Curve {...curve} overlay={overlay} width={trackWidth} height={Math.max(80, view.height - 24)} length={length} revision={revision} disabled={disabled} selected={selection.filter(item => item.bone === boneName && item.channel === channel).map(item => item.time)} onSelect={(at, part) => { curve.onPart(part); onSelect(boneName, channel, at); }} />}
        </div> : <><div className="model-key-rows">{rows.map(row => {
          const active = row.name === boneName, collapsed = folded.includes(row.name);
          const tracks = row.channels.filter(track => active || track.times.length);
          return <div key={row.name} className="model-key-group">
            <div className="model-key-group-head"><div className="model-timeline-label" style={{ paddingLeft: 4 + row.depth * 10 }}>
              <button type="button" className="model-track-fold" aria-label={(collapsed ? "展开轨道 " : "折叠轨道 ") + row.name} aria-expanded={!collapsed} onClick={() => setFolded(value => collapsed ? value.filter(name => name !== row.name) : [...value, row.name])}>{collapsed ? "▸" : "▾"}</button>
              <button type="button" aria-label={"时间轴 " + row.name} className={"model-key-name" + (active ? " active" : "")} onClick={() => onBone(row.name)}>{row.name}</button>
            </div></div>
            {!collapsed && tracks.map(track => <div className="model-key-row" key={track.channel} role="group" aria-label={"关键帧轨道 " + row.name + " " + track.label}>
              <span className="model-timeline-label">{track.label}</span>
              <div className="model-key-track" tabIndex={disabled ? -1 : 0} aria-label={row.name + " " + track.label + "定位时间"} onPointerDown={startScrub} {...pointerEvents} onKeyDown={seekKeys}>
                {track.times.map(at => {
                  const id = JSON.stringify([row.name, track.channel, at]);
                  const chosen = selectedIds.has(id), offset = ghostIds.has(id) ? ghost.delta : 0;
                  return <button type="button" key={at} disabled={disabled} aria-pressed={chosen} aria-label={"关键帧 " + track.label + " " + at.toFixed(2)}
                    className={chosen ? "active" : active && channel === track.channel && Math.abs(at - time) < 0.001 ? "current" : ""}
                    style={{ "--at": length ? Math.min(1, Math.max(0, (at + offset) / length)) : 0 }}
                    onPointerDown={event => {
                      skipClick.current = false;
                      if (disabled || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
                      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
                      drag.current = { kind: "key", node: event.currentTarget, pointer: event.pointerId, revision, bone: row.name, channel: track.channel, selection: chosen ? selection.slice() : [{ bone: row.name, channel: track.channel, time: at }], x: event.clientX, width: trackWidth - 12, delta: 0, moved: false };
                    }}
                    onClick={event => {
                      if (skipClick.current) { skipClick.current = false; return; }
                      onSelect(row.name, track.channel, at, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
                    }} />;
                })}
              </div>
            </div>)}
          </div>;
        })}</div>
        {effects.map(track => <div key={track.id} className="model-key-row model-sound-track" role="group" aria-label={track.label + "轨道"}>
          <span className="model-timeline-label">{track.label}</span>
          <div className="model-key-track" tabIndex={disabled ? -1 : 0} aria-label={track.label + "定位时间"} onPointerDown={startScrub} {...pointerEvents} onKeyDown={seekKeys}>
            {track.items.map(item => <button type="button" key={item.time} disabled={disabled} title={item.label} aria-label={track.label + " " + item.time.toFixed(2) + " " + item.label}
              className={Math.abs(item.time - time) < 0.001 ? "current" : ""} style={{ "--at": length ? Math.min(1, Math.max(0, item.time / length)) : 0 }}
              onClick={() => onEffect(track.id, item.time)} />)}
          </div>
        </div>)}</>}
        <div className="model-time-grid" aria-hidden="true">{ticks.map(tick => <i key={tick.time} style={{ left: labelWidth + tick.x }} />)}</div>
        {playhead}
      </div>
    </div>
  </>;
}
