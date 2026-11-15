import React, { useEffect, useRef, useState } from "react";
import { Button, Select } from "../../app/ui.jsx";
import { ModelControllerPreview } from "./model-controller-preview.jsx";
import { StateNameEditor, ControllerTransitionRow } from "./model-controller-state.jsx";
import { ModelControllerGraph } from "./model-controller-graph.jsx";
import { TransitionCurveEditor } from "./model-transition-curve.jsx";
import { readTransition } from "../../../shared/controller-transition-curve.cjs";
import { remember } from "../../../shared/model-edit.cjs";
import { defaultMolangContext } from "../../../shared/molang-context.cjs";
import { addState, duplicateState, removeState, renameState, setInitialState, setStateAnimations, setStateAnimationWeight, moveStateAnimation, setStateTransition, setStateTransitionCurve, setStateShortestPath, addTransition, updateTransition, moveTransition, removeTransitionAt, animationsOf, transitionsOf } from "../../../shared/animation-controller.cjs";

const call = (method, args = {}) => window.toolkit.call(method, args);

function StateTransitionEditor({ state, disabled, onSave, onCurve, onShortest }) {
  let unsupported = "", settings;
  try { settings = readTransition(state); } catch (reason) { unsupported = reason.message; }
  const saved = state.blend_transition === undefined ? "" : settings ? String(settings.duration) : "";
  const [duration, setDuration] = useState(saved);
  const [curve, setCurve] = useState(null);
  useEffect(() => { setDuration(saved); }, [saved]);
  return <section className="model-controller-preview" aria-label="状态过渡">
    {unsupported ? <p role="note">{unsupported}；保留原数据。</p> : <>
      <label className="model-sound-name">离开状态的过渡（秒）<input aria-label="状态过渡时长" type="text" inputMode="decimal" placeholder="默认 0，立即切换" disabled={disabled} value={duration}
        onChange={event => setDuration(event.target.value)} onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); setDuration(saved); }
          if (event.key === "Enter") { event.preventDefault(); onSave(duration.trim()); }
        }} /></label>
      <Button disabled={disabled || duration.trim() === saved} onClick={() => onSave(duration.trim())}>保存过渡时长</Button>
      <Button disabled={disabled} onClick={() => setCurve(state)}>编辑过渡曲线</Button>
      <label className="model-check"><input aria-label="最短旋转路径" type="checkbox" disabled={disabled} checked={state.blend_via_shortest_path === true} onChange={event => onShortest(event.target.checked)} />最短旋转路径</label>
      <p className="model-texture-note">离开此状态时，各旋转轴取不超过半圈的方向；不改变动画帧。</p>
      <p className="model-texture-note">{settings?.points ? settings.points.length + " 个曲线点；改变时长会保持曲线形状。先恢复线性才能清零时长。" : "0–60 秒，作用于离开当前状态时；0 或留空为立即切换。"}</p>
    </>}
    {curve && <TransitionCurveEditor state={curve} onClose={() => setCurve(null)} onApply={async (seconds, points) => {
      if (curve !== state) throw Error("状态已变化，请重新打开曲线编辑器");
      return onCurve(seconds, points);
    }} />}
  </section>;
}

function AnimationWeightRow({ entry, index, count, disabled, onSave, onMove }) {
  const name = typeof entry === "string" ? entry : Object.keys(entry)[0];
  const saved = typeof entry === "string" ? "" : String(entry[name]);
  const [weight, setWeight] = useState(saved);
  useEffect(() => { setWeight(saved); }, [saved]);
  return <div className="model-controller-weight">
    <div className="model-controller-transition"><span title={name}>{name}</span>
      <Button compact icon="up" aria-label={"上移动画 " + name} disabled={disabled || index === 0} onClick={() => onMove(name, -1)} />
      <Button compact icon="down" aria-label={"下移动画 " + name} disabled={disabled || index === count - 1} onClick={() => onMove(name, 1)} />
    </div>
    <label className="model-sound-name">权重<input aria-label={"动画权重 " + name} value={weight} placeholder="默认 1，可填表达式" disabled={disabled} onChange={event => setWeight(event.target.value)}
      onKeyDown={event => { if (event.key === "Escape") { setWeight(saved); event.stopPropagation(); } if (event.key === "Enter") { event.preventDefault(); onSave(name, weight.trim()); } }} /></label>
    <Button disabled={disabled || weight.trim() === saved} aria-label={"保存权重 " + name} onClick={() => onSave(name, weight.trim())}>保存权重</Button>
  </div>;
}

export function ModelControllerEditor({ modelPath, worldId, animations, playbackKey, onFrame }) {
  const [entries, setEntries] = useState([]);
  const [file, setFile] = useState("");
  const [id, setId] = useState("");
  const [doc, setDoc] = useState(null);
  const [revision, setRevision] = useState("");
  const [state, setState] = useState("");
  const [stateName, setStateNameInput] = useState("");
  const [anim, setAnim] = useState("");
  const [target, setTarget] = useState("");
  const [condition, setCondition] = useState("query.anim_time > 1");
  const [editingTransition, setEditingTransition] = useState(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [previewStatus, setPreviewStatus] = useState(null);
  const [breakpoints, setBreakpoints] = useState([]);
  const [simulation, setSimulation] = useState(() => ({ enabled: false, values: defaultMolangContext() }));
  const previewControls = useRef(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState({ stack: [], cursor: 0 });
  const [editEpoch, setEditEpoch] = useState(0);
  const panel = useRef(null);
  const live = useRef({ generation: 0, writing: false });
  const controller = doc?.animation_controllers?.[id];
  const current = controller?.states?.[state];
  const states = controller ? Object.keys(controller.states || {}) : [];
  const stateAnimations = animationsOf(current);
  const animIds = [...new Set([...animations.map(item => item.id), ...stateAnimations])];
  const chosenAnim = animIds.includes(anim) ? anim : animIds[0] || "";
  const transitions = transitionsOf(current);
  useEffect(() => { setEditingTransition(null); }, [file, id, state]);
  const resetSimulation = () => setSimulation({ enabled: false, values: defaultMolangContext() });
  const selectState = name => { if (name !== state) resetSimulation(); setState(name); };

  const select = async (entry, generation) => {
    const read = await call("content.read-controller", { path: entry.path, worldId });
    if (generation !== live.current.generation) return;
    setFile(read.path); setDoc(read.document); setRevision(read.revision); setId(entry.id);
    const value = read.document.animation_controllers[entry.id];
    const selected = value.initial_state || (value.states.default ? "default" : Object.keys(value.states)[0]);
    setState(selected); resetSimulation(); setBreakpoints([]); setHistory({ stack: [{ document: read.document, state: selected }], cursor: 0 });
    setTarget(""); setAnim(""); setError(""); setNotice("");
  };
  const loadList = async (prefer) => {
    const generation = ++live.current.generation;
    setEditingTransition(null);
    setBusy(true); setDoc(null); setHistory({ stack: [], cursor: 0 });
    try {
      const list = await call("content.list-controllers", { path: modelPath, worldId });
      if (generation !== live.current.generation) return;
      setEntries(list.controllers);
      const next = list.controllers.find(item => item.path === prefer?.path && item.id === prefer?.id) || list.controllers[0];
      if (next) await select(next, generation);
      else { setFile(""); setId(""); setState(""); setError(""); }
    } catch (reason) { if (generation === live.current.generation) setError(reason.message); }
    finally { if (generation === live.current.generation) setBusy(false); }
  };
  useEffect(() => { loadList(); return () => { live.current.generation += 1; }; }, [modelPath, worldId]);
  const commit = async (change, message, nextState = state, historyIndex) => {
    if (busy || live.current.writing || !doc) return;
    const generation = live.current.generation;
    live.current.writing = true; setBusy(true);
    try {
      const next = change(doc);
      if (next === doc) return true;
      const saved = await call("content.save-controller", { path: file, worldId, document: next, revision });
      if (generation !== live.current.generation) return;
      setDoc(next); setRevision(saved.revision);
      const value = next.animation_controllers[id];
      const selected = value.states[nextState] ? nextState : value.initial_state || (value.states.default ? "default" : Object.keys(value.states)[0]);
      selectState(selected);
      setBreakpoints(previous => historyIndex !== undefined ? [] : previous.filter(name => Object.hasOwn(value.states, name)));
      setHistory(previous => {
        if (historyIndex !== undefined) return { ...previous, cursor: historyIndex };
        const stack = previous.stack.slice();
        stack[previous.cursor] = { document: doc, state };
        return remember(stack, previous.cursor, { document: next, state: selected });
      });
      if (historyIndex !== undefined) {
        resetSimulation();
        setEditEpoch(epoch => epoch + 1); setEditingTransition(null); setTarget(""); setAnim("");
      }
      setNotice(message); setError(""); setStateNameInput("");
      return true;
    } catch (reason) { if (generation === live.current.generation) setError(reason.message); return { error: reason.message }; }
    finally { live.current.writing = false; if (generation === live.current.generation) setBusy(false); }
  };
  const restore = direction => {
    const index = history.cursor + direction, snapshot = history.stack[index];
    if (busy || live.current.writing || !snapshot) return;
    panel.current?.focus();
    return commit(() => snapshot.document, direction < 0 ? "已撤销控制器编辑" : "已重做控制器编辑", snapshot.state, index);
  };
  const insertTransition = (target, condition) => commit(value => addTransition(value, id, state, target, condition), "已添加转移");
  const saveTransition = (index, target, condition) => commit(value => updateTransition(value, id, state, index, current.transitions[index], target, condition), "已更新转移");
  const shiftTransition = (index, direction) => commit(value => moveTransition(value, id, state, index, current.transitions[index], direction), "已调整转移优先级");
  const deleteTransition = index => commit(value => removeTransitionAt(value, id, state, index, current.transitions[index]), "已删除转移");
  const insertState = name => commit(value => addState(value, id, name), "已添加状态", name.trim());
  const copyState = name => commit(value => duplicateState(value, id, state, name), "已复制状态", name.trim());
  const renameSelectedState = async name => {
    const wasBreakpoint = breakpoints.includes(state);
    const result = await commit(value => renameState(value, id, state, name), "已重命名状态并更新转移引用", name.trim());
    if (result === true) {
      setTarget("");
      if (wasBreakpoint) setBreakpoints(current => [...new Set([...current, name.trim()])]);
    }
    return result;
  };
  const deleteState = () => commit(value => removeState(value, id, state), "已删除状态");
  const makeInitial = () => commit(value => setInitialState(value, id, state), "已设为初始状态");
  const create = async () => {
    if (live.current.writing) return;
    live.current.writing = true; setBusy(true);
    try {
      const created = await call("content.create-controller", { modelPath, worldId, name: "mob" });
      await loadList(created); setNotice("已新建控制器");
    } catch (reason) { setError(reason.message); }
    finally { live.current.writing = false; setBusy(false); }
  };

  return <section ref={panel} tabIndex={0} className="model-controller-editor" aria-label="动画控制器" onKeyDown={event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !["z", "y"].includes(event.key.toLowerCase())) return;
    if (document.querySelector("dialog[open]")) return;
    event.stopPropagation();
    if (event.target.closest('input,textarea,select,[role="combobox"],[contenteditable="true"]')) return;
    event.preventDefault();
    restore(event.key.toLowerCase() === "y" || event.shiftKey ? 1 : -1);
  }}>
    <div className="model-panel-head"><h3>控制器</h3><Button disabled={busy} onClick={() => loadList({ path: file, id })}>重新读取</Button></div>
    <div className="model-tools" role="group" aria-label="控制器编辑历史">
      <Button disabled={busy || history.cursor === 0} onClick={() => restore(-1)}>撤销控制器</Button>
      <Button disabled={busy || history.cursor >= history.stack.length - 1} onClick={() => restore(1)}>重做控制器</Button>
    </div>
    <Button disabled={busy || !controller || editingTransition !== null} onClick={() => setGraphOpen(true)}>状态关系图</Button>
    {error && <p role="alert">{error}</p>}
    {!entries.length && <Button disabled={busy} onClick={create}>新建控制器</Button>}
    {!!entries.length && <Select aria-label="控制器" disabled={busy} value={file + "|" + id} options={entries.map(item => ({ value: item.path + "|" + item.id, label: item.id }))} onChange={async value => {
      const entry = entries.find(item => item.path + "|" + item.id === value);
      if (!entry) return;
      const generation = ++live.current.generation; setBusy(true); setDoc(null); setHistory({ stack: [], cursor: 0 });
      try { await select(entry, generation); }
      catch (reason) { if (generation === live.current.generation) setError(reason.message); }
      finally { if (generation === live.current.generation) setBusy(false); }
    }} />}
    {controller && <React.Fragment key={editEpoch}>
      <Select aria-label="控制器状态" disabled={busy} value={state} options={states.map(name => ({ value: name, label: name === controller.initial_state ? name + " · 初始" : name }))} onChange={value => { selectState(value); setTarget(""); }} />
      <StateNameEditor key={"name|" + file + "|" + id + "|" + state} name={state} disabled={busy} onSave={renameSelectedState} />
      <StateTransitionEditor key={"transition|" + file + "|" + id + "|" + state} state={current} disabled={busy}
        onSave={duration => commit(value => setStateTransition(value, id, state, duration), "已保存状态过渡时长")}
        onCurve={(duration, points) => commit(value => setStateTransitionCurve(value, id, state, duration, points), "已保存状态过渡曲线")}
        onShortest={enabled => commit(value => setStateShortestPath(value, id, state, enabled), "已保存最短旋转路径设置")} />
      <ModelControllerPreview document={doc} id={id} state={state} animations={animations} worldId={worldId} disabled={busy} playbackKey={playbackKey} onFrame={onFrame} controlRef={previewControls} onStatus={setPreviewStatus} simulation={simulation} onSimulationChange={setSimulation} breakpoints={breakpoints} onBreakpointsChange={setBreakpoints} />
      <div className="model-tools">
        <input aria-label="新状态名称" disabled={busy} value={stateName} onChange={event => setStateNameInput(event.target.value)} placeholder="状态名" />
        <Button disabled={busy || !stateName.trim()} onClick={() => insertState(stateName)}>添加状态</Button>
        <Button disabled={busy || !stateName.trim() || states.length >= 32} onClick={() => copyState(stateName)}>复制状态</Button>
        <Button disabled={busy || states.length < 2} onClick={deleteState}>删除状态</Button>
        <Button disabled={busy || !state || state === controller.initial_state} onClick={makeInitial}>设为初始</Button>
      </div>
      <Select aria-label="加入的动画" disabled={busy} value={chosenAnim} options={animIds.map(item => ({ value: item, label: item }))} onChange={setAnim} />
      <div className="model-tools">
        <Button disabled={busy || !chosenAnim || stateAnimations.includes(chosenAnim)} onClick={() => commit(value => setStateAnimations(value, id, state, [...stateAnimations, chosenAnim]), "已加入动画")}>加入动画</Button>
        <Button disabled={busy || !stateAnimations.includes(chosenAnim)} onClick={() => commit(value => setStateAnimations(value, id, state, stateAnimations.filter(item => item !== chosenAnim)), "已移出动画")}>移出动画</Button>
      </div>
      <div className="model-controller-weights" aria-label="状态动画权重">{(current?.animations || []).map((entry, index) => <AnimationWeightRow
        key={file + "|" + id + "|" + state + "|" + stateAnimations[index]} entry={entry} index={index} count={stateAnimations.length} disabled={busy}
        onSave={(name, weight) => commit(value => setStateAnimationWeight(value, id, state, name, weight), "已保存动画权重")}
        onMove={(name, direction) => commit(value => moveStateAnimation(value, id, state, name, direction), "已调整动画顺序")} />)}</div>
      <p className="model-texture-note">{stateAnimations.length ? "权重留空为 1；修改后保存。叠加顺序影响带覆盖标记的动画。" : "这个状态还没有动画。"}</p>
      <Select aria-label="转移目标" disabled={busy} value={target} placeholder="选择目标状态" options={states.filter(name => name !== state).map(name => ({ value: name, label: name }))} onChange={setTarget} />
      <Select aria-label="转移条件预设" disabled={busy} value={["query.any_animation_finished", "query.all_animations_finished"].includes(condition) ? condition : "custom"} options={[
        { value: "custom", label: "自定义条件" }, { value: "query.any_animation_finished", label: "任一动画播完一轮" }, { value: "query.all_animations_finished", label: "全部动画播完一轮" },
      ]} onChange={value => setCondition(value === "custom" ? "" : value)} />
      <label className="model-sound-name">转移条件<input aria-label="转移条件" disabled={busy} value={condition} onChange={event => setCondition(event.target.value)} /></label>
      <Button disabled={busy || !target} onClick={() => insertTransition(target, condition)}>添加转移</Button>
      {!!transitions.length && <p className="model-texture-note">从上到下检查，只执行第一条成立的转移。上下移动可调整优先级。</p>}
      <div className="model-controller-transitions">{transitions.map((row, index) => <ControllerTransitionRow key={file + "|" + id + "|" + state + "|" + index}
        row={row} index={index} count={transitions.length} states={states} source={state} disabled={busy || (editingTransition !== null && editingTransition !== index)}
        onEditingChange={active => setEditingTransition(active ? index : null)}
        onSave={(target, condition) => saveTransition(index, target, condition)}
        onMove={direction => shiftTransition(index, direction)}
        onRemove={() => deleteTransition(index)} />)}</div>
    </React.Fragment>}
    {graphOpen && controller && <ModelControllerGraph controller={controller} selected={state}
      breakpoints={breakpoints} onBreakpointsChange={setBreakpoints}
      simulation={simulation} onSimulationChange={setSimulation}
      preview={previewStatus} previewControls={previewControls}
      busy={busy} error={error} notice={notice} canUndo={history.cursor > 0} canRedo={history.cursor < history.stack.length - 1}
      onUndo={() => restore(-1)} onRedo={() => restore(1)}
      onAddTransition={insertTransition} onSaveTransition={saveTransition} onMoveTransition={shiftTransition} onRemoveTransition={deleteTransition}
      onAddState={insertState} onCopyState={copyState} onRenameState={renameSelectedState} onRemoveState={deleteState} onInitialState={makeInitial}
      onSelect={name => { selectState(name); setTarget(""); }} onClose={() => setGraphOpen(false)}
      onEdit={() => { setGraphOpen(false); requestAnimationFrame(() => {
        const input = panel.current?.querySelector('[aria-label="当前状态名称"]'); input?.focus(); input?.scrollIntoView({ block: "nearest" });
      }); }} />}
    {notice && <p className="model-texture-note">{notice}</p>}
    <p className="model-texture-note">保存成功后更新状态；模型旁的控制器文件保留备份。面板内 Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做；切换控制器或重新读取会清空历史。</p>
  </section>;
}
