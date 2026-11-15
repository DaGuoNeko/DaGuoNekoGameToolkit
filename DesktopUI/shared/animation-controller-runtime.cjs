const { evaluateMolang } = require("./molang-preview.cjs");
const { validateControllers, transitionDuration } = require("./animation-controller.cjs");

function conditionPasses(source, time, context, completion) {
  return evaluateMolang(source, time, context, completion) !== 0;
}

function transitionResults(state, time, context, completion) {
  const results = [], transitions = state.transitions || [];
  for (let index = 0; index < transitions.length; index++) {
    const [target, condition] = Object.entries(transitions[index])[0];
    try {
      const value = evaluateMolang(condition, time, context, completion);
      results.push({ index, target, condition, value });
      if (value !== 0) break;
    } catch (error) {
      results.push({ index, target, condition, error });
      break;
    }
  }
  return results;
}

// 每次只做一次有序转移，状态时间在进入新状态后归零，不跟随动画循环回卷。
function controllerState(controllers, id, current, time, context, completion) {
  const controller = controllers?.[id];
  if (!controller) throw Error("控制器不存在");
  const state = controller.states[current];
  if (!state) throw Error("控制器状态不存在");
  const result = transitionResults(state, time, context, completion).at(-1);
  if (result?.error) throw result.error;
  if (result && result.value !== 0) return { state: result.target, time: 0, animations: controller.states[result.target].animations || [], transitionIndex: result.index };
  return { state: current, time, animations: state.animations || [] };
}

function inspectControllerTransitions(controllers, id, session, context) {
  if (!Number.isFinite(session.time) || session.time < 0) throw Error("控制器时间无效");
  const controller = controllers?.[id], state = controller?.states?.[session.state];
  if (!state) throw Error("控制器状态不存在");
  const completion = session.clips ? controllerCompletion(controller, session.state, session.clips, session.time).queries : undefined;
  const results = transitionResults(state, session.time, context, completion), last = results.at(-1);
  const rows = (state.transitions || []).map((row, index) => {
    const [target, condition] = Object.entries(row)[0], result = results[index];
    if (!result) return { index, target, condition, status: "skipped", after: last.index, reason: last.error ? "error" : "match" };
    if (result.error) return { index, target, condition, status: "error", error: result.error.message };
    return { index, target, condition, status: result.value !== 0 ? "match" : "false", value: result.value };
  });
  return { state: session.state, time: session.time, rows };
}

function previewAnimations(controller, stateName) {
  const state = controller.states[stateName];
  if (!state) throw Error("控制器状态不存在");
  const entries = state.animations || [];
  transitionDuration(state);
  for (const key of ["on_entry", "on_exit", "variables", "particle_effects", "sound_effects"]) {
    if (state[key] && Object.keys(state[key]).length) throw Error("预览暂不执行状态的 " + key);
  }
  return entries.map(item => {
    if (typeof item === "string") return { id: item, weight: 1 };
    const id = Object.keys(item)[0];
    return { id, weight: item[id] };
  });
}

function previewAnimationIds(controllers, id) {
  validateControllers(controllers);
  const controller = controllers[id];
  if (!controller) throw Error("控制器不存在");
  return [...new Set(Object.keys(controller.states).flatMap(name => previewAnimations(controller, name).map(entry => entry.id)))];
}

function controllerCompletion(controller, state, clips, time) {
  if (!Number.isFinite(time) || time < 0) throw Error("控制器时间无效");
  const animations = previewAnimations(controller, state);
  const finished = animations.map(({ id }) => {
    const clip = clips?.[id];
    if (!clip) throw Error("动画未加载：" + id);
    if (!Number.isFinite(clip.length) || clip.length < 0 || clip.length > 10000) throw Error("动画时长缺失或无效：" + id);
    // 完成表示已播过一轮；循环和零权重不改变动画在状态内的计时。
    return time >= clip.length;
  });
  return { total: finished.length, finished: finished.filter(Boolean).length, queries: {
    "query.any_animation_finished": Number(finished.some(Boolean)),
    "query.all_animations_finished": Number(finished.every(Boolean)),
  } };
}

function advanceControllerSession(controllers, id, session, elapsed, context) {
  if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(session.time) || session.time < 0) throw Error("控制器时间无效");
  const time = session.time + elapsed;
  const totalTime = (session.elapsed ?? session.time) + elapsed;
  if (!Number.isFinite(totalTime) || totalTime < 0) throw Error("控制器时间无效");
  const completion = session.clips ? controllerCompletion(controllers[id], session.state, session.clips, time).queries : undefined;
  const next = controllerState(controllers, id, session.state, time, context, completion);
  let transition = session.transition ? { ...session.transition, time: session.transition.time + elapsed } : null;
  let trace = session.trace || [];
  if (next.transitionIndex !== undefined) {
    const duration = transitionDuration(controllers[id].states[session.state]);
    // 与 Blockbench 的 last_state 一致：再次转移时以刚离开的状态替换旧过渡来源。
    transition = duration ? { state: session.state, time, duration } : null;
    trace = [...trace.slice(-49), { from: session.state, to: next.state, index: next.transitionIndex,
      condition: controllers[id].states[session.state].transitions[next.transitionIndex][next.state], stateTime: time, elapsed: totalTime }];
  } else if (transition && next.time >= transition.duration) transition = null;
  return { ...session, state: next.state, time: next.time, transition, elapsed: totalTime, trace };
}

function enteredTransition(previous, next) {
  const entry = next.trace?.at(-1);
  return entry && entry !== previous.trace?.at(-1) ? entry : null;
}

function enteredBreakpoint(previous, next, breakpoints) {
  const entry = enteredTransition(previous, next);
  return entry && breakpoints.includes(entry.to) ? entry.to : "";
}

module.exports = { controllerState, conditionPasses, inspectControllerTransitions, previewAnimations, previewAnimationIds, advanceControllerSession, controllerCompletion, enteredTransition, enteredBreakpoint };
