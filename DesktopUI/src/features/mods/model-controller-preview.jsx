import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Button } from "../../app/ui.jsx";
import { advanceControllerSession, enteredBreakpoint, enteredTransition, inspectControllerTransitions, previewAnimationIds } from "../../../shared/animation-controller-runtime.cjs";
import { controllerClip, controllerPose } from "./model-controller-blend.cjs";
import { ModelMolangContext } from "./model-molang-context.jsx";
import { ModelControllerRunNotice, ModelControllerTrace } from "./model-controller-trace.jsx";
import { ModelControllerConditions } from "./model-controller-conditions.jsx";
import { simulationResult } from "../../../shared/molang-context.cjs";
import { ModelControllerBreakpoints } from "./model-controller-breakpoints.jsx";

export function ModelControllerPreview({ document, id, state, animations, worldId, disabled, playbackKey, onFrame, controlRef, onStatus, simulation, onSimulationChange, breakpoints, onBreakpointsChange }) {
  const live = useRef({ generation: 0, frame: 0, session: null });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [inspection, setInspection] = useState(null);
  const [breakpointHit, setBreakpointHit] = useState("");
  const [nextRun, setNextRun] = useState(null);
  const stops = useRef(breakpoints);
  stops.current = breakpoints;
  const queryInput = useMemo(() => simulationResult(simulation.enabled, simulation.values), [simulation]);
  const queries = useRef(queryInput);
  queries.current = queryInput;
  const session = live.current.session;
  const reset = () => {
    live.current.generation += 1;
    cancelAnimationFrame(live.current.frame);
    live.current.session = null;
    setInspection(null);
    setBreakpointHit("");
    setNextRun(null);
    setStatus(null); setError(""); setLoading(false); setPlaying(false); onFrame(null);
  };
  useEffect(() => { reset(); return () => { live.current.generation += 1; cancelAnimationFrame(live.current.frame); onFrame(null); }; }, [document, id, state, animations, worldId, playbackKey]);
  useEffect(() => {
    const current = live.current.session;
    onStatus({ state: current?.state || "", time: current?.time || 0, trace: current?.trace, playing, loading, error, inspection, breakpointHit, nextRun });
  }, [session?.state, session?.trace, playing ? null : session?.time, playing, loading, error, inspection, breakpointHit, nextRun, onStatus]);
  const publish = session => {
    if (queries.current.error) throw Error(queries.current.error);
    const pose = controllerPose(document.animation_controllers[id], session.state, session.clips, session.time, session.transition, queries.current.context);
    const animation = pose.weights.map(row => row.id + (row.weight === 1 ? "" : " × " + Number(row.weight.toFixed(3)))).join(" + ");
    setStatus({ state: session.state, animation, time: session.time, transition: pose.transition, completion: pose.completion });
    onFrame({ clip: pose.clip, time: pose.time });
  };
  const pause = (hit = "") => { cancelAnimationFrame(live.current.frame); setPlaying(false); setBreakpointHit(hit); setNextRun(null); };
  useEffect(() => {
    setInspection(null);
    if (!live.current.session) return;
    try { publish(live.current.session); setError(""); }
    catch (reason) { pause(); setError(reason.message); }
  }, [queryInput]);
  const start = async (mode = "play") => {
    if (loading || disabled || (mode !== "play" && playing)) return;
    const generation = ++live.current.generation;
    setInspection(null);
    if (mode !== "inspect") { setBreakpointHit(""); setNextRun(null); }
    try {
      if (queries.current.error) throw Error(queries.current.error);
      let current = live.current.session;
      const fresh = !current;
      if (!current) {
        setLoading(true); setError("");
        const ids = previewAnimationIds(document.animation_controllers, id);
        const clips = {};
        for (const name of ids) {
          const matches = animations.filter(item => item.id === name);
          if (matches.length !== 1) throw Error("找不到唯一的动画：" + name);
          const result = await window.toolkit.call("content.read-animation", { path: matches[0].path, id: name, worldId });
          if (generation !== live.current.generation) return;
          if (result.id !== name) throw Error("动画来源已变化，请重新打开模型：" + name);
          clips[name] = controllerClip(result.animation);
        }
        current = { state, time: 0, clips };
      }
      if (generation !== live.current.generation) return;
      if (mode === "inspect") {
        if (queries.current.error) throw Error(queries.current.error);
        setInspection(inspectControllerTransitions(document.animation_controllers, id, current, queries.current.context));
        setLoading(false); return;
      }
      live.current.session = current;
      if (fresh && stops.current.includes(current.state)) {
        publish(current); setLoading(false); setError(""); pause(current.state); return;
      }
      if (mode === "step") live.current.session = advanceControllerSession(document.animation_controllers, id, current, 0.05, queries.current.context);
      publish(live.current.session); setLoading(false); setError("");
      if (mode === "step") { pause(enteredBreakpoint(current, live.current.session, stops.current)); return; }
      if (mode === "next" && !document.animation_controllers[id].states[current.state].transitions?.length) {
        pause(); setNextRun({ phase: "empty", state: current.state }); return;
      }
      setPlaying(true);
      if (mode === "next") setNextRun({ phase: "waiting" });
      let last = null;
      const tick = now => {
        if (generation !== live.current.generation) return;
        try {
          const session = live.current.session;
          // 首帧时间戳可能早于注册回调时的 performance.now，以帧时间戳为同一个时钟基准。
          const elapsed = last === null ? 0 : Math.max(0, (now - last) / 1000);
          if (queries.current.error) throw Error(queries.current.error);
          const next = advanceControllerSession(document.animation_controllers, id, session, elapsed, queries.current.context);
          last = now;
          live.current.session = next;
          publish(live.current.session);
          const hit = enteredBreakpoint(session, next, stops.current);
          if (hit) { pause(hit); return; }
          const entry = enteredTransition(session, next);
          if (mode === "next" && entry) { pause(); setNextRun({ phase: "stopped", entry }); return; }
          live.current.frame = requestAnimationFrame(tick);
        } catch (reason) { pause(); setError(reason.message); }
      };
      live.current.frame = requestAnimationFrame(tick);
    } catch (reason) {
      if (generation !== live.current.generation) return;
      setLoading(false); pause(); setError(reason.message);
    }
  };
  useImperativeHandle(controlRef, () => ({ play: () => start(), pause, step: () => start("step"), next: () => start("next"), inspect: () => start("inspect"), reset }));
  return <section className="model-controller-preview" aria-label="控制器预览">
    <ModelMolangContext simulation={simulation} onChange={onSimulationChange} disabled={disabled} />
    <ModelControllerBreakpoints states={Object.keys(document.animation_controllers[id].states)} breakpoints={breakpoints} onChange={onBreakpointsChange} disabled={disabled} />
    <div className="model-tools"><Button disabled={disabled || loading} onClick={() => playing ? pause() : start()}>{loading ? "读取动画…" : playing ? "暂停控制器" : "播放控制器"}</Button><Button disabled={disabled || loading || playing} onClick={() => start("step")}>单步 0.05 秒</Button><Button disabled={disabled || loading || playing} onClick={() => start("inspect")}>检查转移条件</Button><Button disabled={!status && !error && !loading && !inspection} onClick={reset}>重置控制器</Button></div>
    <Button disabled={disabled || loading || playing} onClick={() => start("next")}>运行到下一次转移</Button>
    <p role="status" aria-label="控制器播放状态">{status ? status.state + " · " + (status.animation || "静止姿势") + " · " + status.time.toFixed(2) + " 秒" : "从所选状态开始"}</p>
    {breakpointHit && <p role="status" aria-label="断点暂停位置">已在 {breakpointHit} 的进入断点暂停</p>}
    <ModelControllerRunNotice run={nextRun} />
    {status && <p role="status" aria-label="动画完成状态">已播过一轮：{status.completion.finished}/{status.completion.total} · 任一：{status.completion.queries["query.any_animation_finished"] ? "是" : "否"} · 全部：{status.completion.queries["query.all_animations_finished"] ? "是" : "否"}</p>}
    {status?.transition && <p role="status" aria-label="状态过渡进度">{status.transition.from} → {status.transition.to} · {Math.round(status.transition.progress * 100)}%</p>}
    {error && <p role="alert">{error}</p>}
    <ModelControllerConditions inspection={inspection} />
    <ModelControllerTrace records={session?.trace} />
    <p className="model-texture-note">动画完成条件由播放时长自动计算，循环动画播过首轮也算完成。按列表顺序混合；未提供或未知的查询会停止预览，不执行事件、声音或粒子。</p>
  </section>;
}
