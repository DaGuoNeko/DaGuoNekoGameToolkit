import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, ErrorBox, Modal, Select } from "../../app/ui.jsx";
import { ControllerTransitionRow } from "./model-controller-state.jsx";
import { controllerGraph, searchControllerGraph } from "./model-controller-graph.cjs";
import { ModelControllerRunNotice, ModelControllerTrace } from "./model-controller-trace.jsx";
import { ModelControllerConditions } from "./model-controller-conditions.jsx";
import { ModelMolangContext } from "./model-molang-context.jsx";
import { ModelControllerBreakpoints } from "./model-controller-breakpoints.jsx";
import { ModelControllerConnect } from "./model-controller-connect.jsx";
import { useControllerArrange } from "./use-controller-arrange.jsx";
import { useControllerPan } from "./use-controller-pan.jsx";
import { useControllerZoom } from "./use-controller-zoom.jsx";
import { ModelControllerSearch } from "./model-controller-search.jsx";

export function ModelControllerGraph({ controller, selected, onSelect, onClose, onEdit, busy, error, notice, canUndo, canRedo, onUndo, onRedo, onAddTransition, onSaveTransition, onMoveTransition, onRemoveTransition, onAddState, onCopyState, onRenameState, onRemoveState, onInitialState, preview, previewControls, simulation, onSimulationChange, breakpoints, onBreakpointsChange }) {
  const [order, setOrder] = useState([]);
  const namesKey = Object.keys(controller.states).join("|");
  // 名称列表变化后恢复网格排列，避免临时视图保留已删除或改名的卡片。
  useEffect(() => { setOrder(previous => previous.length ? [] : previous); }, [namesKey]);
  const graph = useMemo(() => controllerGraph(controller, order), [controller, order]);
  const [search, setSearch] = useState("");
  const matches = useMemo(() => searchControllerGraph(graph, search), [graph, search]);
  const matchedNames = useMemo(() => new Set(matches.map(item => item.name)), [matches]);
  const [adding, setAdding] = useState(null), [editing, setEditing] = useState(null);
  const [stateDraft, setStateDraft] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [panning, setPanning] = useState(false);
  const viewport = useRef(null), nodeRefs = useRef(new Map());
  const { zoom, change: changeZoom, fit: fitZoom } = useControllerZoom({ viewport, graph, disabled: connecting || moving || panning });
  const marker = "controller-arrow-" + useId().replace(/:/g, "");
  const outgoing = graph.edges.filter(edge => edge.from === selected);
  const lastTransition = preview?.trace?.at(-1);
  const triggered = graph.edges.find(edge => edge.from === lastTransition?.from && edge.to === lastTransition?.to && edge.index === lastTransition?.index && edge.condition === String(lastTransition?.condition));
  const visibleEdges = triggered && !outgoing.includes(triggered) ? [...outgoing, triggered] : outgoing;
  const incoming = graph.edges.filter(edge => edge.to === selected);
  const node = graph.nodes.find(item => item.name === selected);
  const available = graph.nodes.filter(item => item.name !== selected && !outgoing.some(edge => edge.to === item.name));
  const editLocked = busy || adding !== null || editing !== null || stateDraft !== null;
  const locked = editLocked || connecting || moving || panning;
  const pan = useControllerPan({ viewport, disabled: editLocked || connecting || moving, context: graph, onPanning: setPanning });
  const swap = (from, to) => {
    const names = graph.nodes.map(item => item.name), a = names.indexOf(from), b = names.indexOf(to);
    if (a < 0 || b < 0 || a === b) return;
    [names[a], names[b]] = [names[b], names[a]]; setOrder(names);
    requestAnimationFrame(() => { nodeRefs.current.get(from)?.focus({ preventScroll: true }); reveal(from); });
  };
  const arrange = useControllerArrange({ graph, disabled: editLocked || connecting || panning, viewport, onMoving: setMoving, onSwap: swap });
  const stateTitle = { add: "新增状态", copy: "复制状态", rename: "重命名状态", remove: "删除状态" }[stateDraft?.kind];
  const saveState = async () => {
    if (busy || !stateDraft) return;
    const name = stateDraft.name.trim();
    const action = { add: onAddState, copy: onCopyState, rename: onRenameState, remove: onRemoveState }[stateDraft.kind];
    if (await action(name) === true) setStateDraft(null);
  };
  const reveal = name => nodeRefs.current.get(name)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  useEffect(() => { reveal(selected); }, [selected]);
  const choose = name => {
    if (busy || editing !== null || stateDraft || connecting || moving || panning) return;
    if (adding) {
      if (!available.some(item => item.name === name)) return;
      setAdding({ ...adding, target: name });
    } else onSelect(name);
    nodeRefs.current.get(name)?.focus({ preventScroll: true });
  };
  return <Modal wide busy={locked} title="状态关系图" description="选择状态查看出站箭头及编号；编号就是转移检查顺序。编辑需保存，浏览不会写入文件。" onClose={onClose}
    footer={<><Button disabled={locked} onClick={onClose}>关闭</Button><Button primary disabled={locked} onClick={onEdit}>编辑所选状态</Button></>}>
    <div className="model-controller-graph-tools">
      <Select aria-label="定位状态" disabled={locked} value={selected} options={graph.nodes.map(item => ({ value: item.name, label: item.name + (item.initial ? " · 初始" : "") }))} onChange={choose} />
      <div className="model-tools">
        <Button aria-label="缩小关系图" disabled={connecting || moving || panning || zoom <= 0.05} onClick={() => changeZoom(-0.25)}>−</Button>
        <output aria-label="关系图缩放">{Math.round(zoom * 100)}%</output>
        <Button aria-label="放大关系图" disabled={connecting || moving || panning || zoom >= 1.5} onClick={() => changeZoom(0.25)}>+</Button>
        <Button disabled={connecting || moving || panning} onClick={() => fitZoom(false)}>适应宽度</Button>
        <Button disabled={connecting || moving || panning} onClick={() => fitZoom(true)}>适应全图</Button>
        <Button disabled={connecting || moving || panning} onClick={() => reveal(selected)}>定位所选</Button>
        <Button disabled={locked || !order.length} onClick={() => { setOrder([]); requestAnimationFrame(() => reveal(selected)); }}>恢复状态排列</Button>
      </div>
    </div>
    <ModelControllerSearch query={search} onChange={setSearch} results={matches} total={graph.nodes.length} disabled={locked}
      onLocate={name => { nodeRefs.current.get(name)?.focus({ preventScroll: true }); reveal(name); }} />
    <div className="model-tools model-controller-graph-actions" role="group" aria-label="关系图状态操作">
      <Button disabled={locked || graph.nodes.length >= 32} onClick={() => setStateDraft({ kind: "add", name: "" })}>新增状态</Button>
      <Button disabled={locked || graph.nodes.length >= 32} onClick={() => setStateDraft({ kind: "copy", name: "" })}>复制状态</Button>
      <Button disabled={locked} onClick={() => setStateDraft({ kind: "rename", name: selected })}>重命名状态</Button>
      <Button disabled={locked || node.initial} onClick={onInitialState}>设为初始</Button>
      <Button disabled={locked || graph.nodes.length < 2} onClick={() => setStateDraft({ kind: "remove", name: selected })}>删除状态</Button>
    </div>
    <div className="model-tools model-controller-graph-actions">
      <Button disabled={locked || outgoing.length >= 8 || !available.length} onClick={() => setAdding({ target: "", condition: "query.anim_time > 1" })}>新增转移</Button>
      <Button disabled={locked || !canUndo} onClick={onUndo}>撤销控制器</Button>
      <Button disabled={locked || !canRedo} onClick={onRedo}>重做控制器</Button>
    </div>
    <ErrorBox>{error}</ErrorBox>
    {notice && <p role="status" aria-label="关系图保存状态" className="model-texture-note">{notice}</p>}
    <section className="model-controller-preview" aria-label="关系图预览">
      <details className="model-controller-simulation"><summary>模拟查询 · {simulation.enabled ? "已启用" : "未启用"}</summary>
        <ModelMolangContext simulation={simulation} onChange={onSimulationChange} disabled={locked} />
      </details>
      <ModelControllerBreakpoints states={graph.nodes.map(item => item.name)} breakpoints={breakpoints} onChange={onBreakpointsChange} disabled={locked} />
      <div className="model-tools">
        <Button disabled={preview?.loading || (!preview?.playing && locked)} onClick={() => preview?.playing ? previewControls.current?.pause() : previewControls.current?.play()}>{preview?.loading ? "读取预览…" : preview?.playing ? "暂停图中预览" : "播放图中预览"}</Button>
        <Button disabled={locked || preview?.loading || preview?.playing} onClick={() => previewControls.current?.step()}>图中单步 0.05 秒</Button>
        <Button disabled={locked || preview?.loading || preview?.playing} onClick={() => previewControls.current?.next()}>运行到下一次转移</Button>
        <Button disabled={locked || preview?.loading || preview?.playing} onClick={() => previewControls.current?.inspect()}>检查图中条件</Button>
        <Button disabled={locked || (!preview?.state && !preview?.error && !preview?.loading && !preview?.inspection)} onClick={() => previewControls.current?.reset()}>重置图中预览</Button>
        <Button disabled={connecting || moving || panning || !preview?.state} onClick={() => reveal(preview.state)}>定位运行状态</Button>
      </div>
      <p role="status" aria-label="关系图运行状态">{preview?.state ? "运行状态：" + preview.state + (preview.error ? " · 已停止" : preview.playing ? " · 播放中" : " · 已暂停 · 状态时间 " + preview.time.toFixed(3) + " 秒") : "从编辑所选状态开始"}</p>
      {preview?.breakpointHit && <p role="status" aria-label="断点暂停位置">已在 {preview.breakpointHit} 的进入断点暂停</p>}
      <ModelControllerRunNotice run={preview?.nextRun} />
      <ErrorBox>{preview?.error}</ErrorBox>
      <ModelControllerConditions inspection={preview?.inspection} />
      <ModelControllerTrace records={preview?.trace} />
    </section>
    {stateDraft && <section className="model-controller-graph-add" aria-label="状态编辑草稿" onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); setStateDraft(null); }
    }}>
      <h3>{stateTitle}{stateDraft.kind !== "add" ? " · " + selected : ""}</h3>
      {stateDraft.kind === "remove" ? <p>将删除此状态及指向它的 {incoming.filter(edge => edge.from !== selected).length} 条转移，可撤销。{node.initial ? "初始状态将改为剩余的第一个状态。" : ""}</p> : <>
        <label className="model-sound-name">状态名称<input autoFocus aria-label="图中状态名称" disabled={busy} value={stateDraft.name} onChange={event => setStateDraft({ ...stateDraft, name: event.target.value })} /></label>
        <p className="model-texture-note">{stateDraft.kind === "copy" ? "保留动画、权重、过渡设置及附加字段；自转移指向副本，其他入边和初始状态保持不变。" : stateDraft.kind === "rename" ? "同步初始状态与同一控制器内的转移引用，条件和脚本文本保持原样。" : "新增空状态，保持当前初始状态。"} 名称支持字母、数字、下划线，最多 32 个字符。</p>
      </>}
      <div className="model-tools">
        <Button disabled={busy || (stateDraft.kind !== "remove" && (!stateDraft.name.trim() || (stateDraft.kind === "rename" && stateDraft.name.trim() === selected)))} onClick={saveState}>{stateDraft.kind === "remove" ? "确认删除状态" : "保存状态"}</Button>
        <Button disabled={busy} onClick={() => setStateDraft(null)}>取消状态编辑</Button>
      </div>
    </section>}
    {adding && <section className="model-controller-graph-add" aria-label="新增转移草稿" onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); setAdding(null); }
    }}>
      <p>从 <strong>{selected}</strong> 转移到：点击目标卡片或选择目标，然后填写条件。先保存或取消，再切换状态。</p>
      <Select aria-label="新转移目标" disabled={busy} placeholder="选择目标状态" value={adding.target} options={available.map(item => ({ value: item.name, label: item.name }))} onChange={target => setAdding({ ...adding, target })} />
      <label className="model-sound-name">条件<input aria-label="新转移条件" disabled={busy} value={adding.condition} onChange={event => setAdding({ ...adding, condition: event.target.value })} /></label>
      <div className="model-tools">
        <Button disabled={busy || !adding.target || !adding.condition.trim()} onClick={async () => { if (await onAddTransition(adding.target, adding.condition.trim()) === true) setAdding(null); }}>保存新转移</Button>
        <Button disabled={busy} onClick={() => setAdding(null)}>取消添加转移</Button>
      </div>
    </section>}
    <div ref={viewport} className="model-controller-graph-scroll" role="region" aria-label="状态连线画布" tabIndex={0} data-panning={panning} {...pan}>
      <div style={{ width: graph.width * zoom, height: graph.height * zoom }}>
        <div className="model-controller-graph-board" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}>
          <svg width={graph.width} height={graph.height} aria-hidden="true">
            <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 z" /></marker></defs>
            {visibleEdges.map(edge => <g key={edge.from + "|" + edge.index} data-transition-index={edge.index} data-triggered={edge === triggered}>
              <path className="connection" d={edge.path} markerEnd={`url(#${marker})`} />
              <circle cx={edge.labelX} cy={edge.labelY} r="6" /><text x={edge.labelX} y={edge.labelY + 3}>{edge.index + 1}</text>
            </g>)}
          </svg>
          {graph.nodes.map((item, index) => <button type="button" key={item.name} ref={element => { if (element) nodeRefs.current.set(item.name, element); else nodeRefs.current.delete(item.name); }}
            className="model-controller-graph-node" data-connect-state={item.name} aria-label={"状态节点 " + item.name} aria-pressed={selected === item.name || adding?.target === item.name}
            data-search-match={search.trim() ? matchedNames.has(item.name) : undefined}
            aria-description={breakpoints.includes(item.name) ? "进入状态时暂停" : undefined}
            data-running={preview?.state === item.name}
            data-target={adding?.target === item.name} disabled={busy || editing !== null || !!stateDraft || (!!adding && !available.some(target => target.name === item.name))}
            data-swap-target={arrange.preview?.target === item.name}
            aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown" onPointerDownCapture={arrange.preparePointer}
            style={{ left: item.x, top: item.y, width: graph.cardWidth, height: graph.cardHeight }} onClick={event => { if (!arrange.consumeClick(event)) choose(item.name); }}
            onDoubleClick={event => { if (!locked && !arrange.consumeClick(event)) onEdit(); }} onKeyDown={event => {
              const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -graph.columns, ArrowDown: graph.columns }[event.key];
              if (!offset || event.ctrlKey || event.metaKey) return;
              if (event.altKey) { event.preventDefault(); event.stopPropagation(); if (!locked && graph.nodes[index + offset]) swap(item.name, graph.nodes[index + offset].name); return; }
              event.preventDefault(); const target = graph.nodes[index + offset]; if (target) choose(target.name);
            }}>
            <span className="model-controller-graph-node-head" {...arrange.handlers(item)} title="拖动标题到其他卡片交换位置；Alt＋方向键也可换位"><strong title={item.name}>{item.name}</strong>{item.initial && <small>初始</small>}{breakpoints.includes(item.name) && <small className="model-controller-breakpoint">断点</small>}{preview?.state === item.name && <small className="model-controller-running">运行</small>}</span>
            <span>{item.animations.length} 个动画 · {(controller.states[item.name].transitions || []).length} 条转移</span>
            <span className="model-controller-graph-node-animation" title={item.animations.join("、")}>{item.animations.join("、") || "静止姿势"}</span>
          </button>)}
          {arrange.preview && <div className="model-controller-arrange-ghost" aria-hidden="true" style={{ left: arrange.preview.x, top: arrange.preview.y, width: graph.cardWidth, height: graph.cardHeight }}>{arrange.preview.name}</div>}
          <ModelControllerConnect graph={graph} disabled={editLocked || moving || panning} viewport={viewport} onDragging={setConnecting} onConnect={(source, target) => {
            onSelect(source); setAdding({ target, condition: "query.anim_time > 1" });
            requestAnimationFrame(() => viewport.current?.closest("dialog")?.querySelector('[aria-label="新转移条件"]')?.focus());
          }} />
        </div>
      </div>
    </div>
    <p className="model-texture-note">{graph.nodes.length} 个状态 · {graph.edges.length} 条转移；选中 {selected}{node?.initial ? "（初始状态）" : ""}。Ctrl＋滚轮定点缩放，普通滚轮滚动；拖动空白处平移；拖动标题或 Alt＋方向键换位；拖动 + 新建转移。Esc 取消拖动。卡片方向键选择、双击返回编辑。排列仅用于本次视图，状态名称列表变化后重置。</p>
    <div className="model-controller-graph-details">
      <section aria-label="所选状态的出站转移"><h3>转移到</h3>
        {outgoing.length ? <ol className="model-controller-graph-outgoing">{outgoing.map(edge => <li key={selected + "|" + edge.index}>
          <ControllerTransitionRow row={{ state: edge.to, condition: edge.condition }} index={edge.index} count={outgoing.length} states={graph.nodes.map(item => item.name)} source={selected}
            disabled={busy || connecting || moving || panning || !!adding || !!stateDraft || (editing !== null && editing !== edge.index)} onEditingChange={active => setEditing(active ? edge.index : null)}
            onSave={(target, condition) => onSaveTransition(edge.index, target, condition)} onMove={direction => onMoveTransition(edge.index, direction)} onRemove={() => onRemoveTransition(edge.index)} onLocate={() => choose(edge.to)} />
        </li>)}</ol> : <p>没有出站转移</p>}
      </section>
      <section aria-label="所选状态的入站转移"><h3>来自</h3>
        {incoming.length ? <ul>{incoming.map(edge => <li key={edge.from + "|" + edge.index}><Button disabled={locked} onClick={() => choose(edge.from)} aria-label={"来自 " + edge.from + " 的转移 " + (edge.index + 1)}>{edge.from} · {edge.index + 1}</Button><code>{edge.condition}</code></li>)}</ul> : <p>没有入站转移</p>}
      </section>
    </div>
  </Modal>;
}
