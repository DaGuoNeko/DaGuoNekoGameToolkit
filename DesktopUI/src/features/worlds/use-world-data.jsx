import { useEffect, useRef, useState } from "react";
import { useWorkspaceState } from "../../app/workspaces.jsx";
const call = (name, args) => window.toolkit.call(name, args);
let cancellation = Promise.resolve();
export function cancelWorldData(id) {
  const result = call("world-data.cancel", { requestId: id }).catch(() => false);
  cancellation = Promise.all([cancellation, result]).then(() => {});
  return result;
}
export async function scanWorldData(args, isCurrent = () => true) {
  await cancellation;
  if (!isCurrent()) throw Error("扫描已取消");
  return call("world-data.scan", args);
}

// 工作区持有任务；切换子页不重扫，换来源或退出工作区才取消。
export function useWorldData({ source, worldId, snapshot, onSnapshot, observe, enabled = true }) {
  const [scope, setScope] = useWorkspaceState("world-data-scope:" + (worldId || source), "gameplay");
  const key = JSON.stringify([source, worldId, scope, enabled]);
  const latest = useRef(null), active = useRef(null), alive = useRef(false);
  const wasVisible = useRef(observe);
  latest.current = { source, worldId, scope, snapshot, onSnapshot, key, enabled };
  const [state, setState] = useState({ key: "", busy: false, error: "", progress: null, checkedId: "", cancelled: false });
  const cancel = () => {
    const job = active.current;
    if (!job) return Promise.resolve();
    job.cancelled = true; active.current = null;
    if (alive.current) setState(value => ({ ...value, busy: false, progress: null, cancelled: true }));
    return job.started ? cancelWorldData(job.id) : Promise.resolve();
  };
  const load = (force = false) => {
    const input = latest.current;
    if (!input.enabled || !input.source && !input.worldId) return Promise.resolve(null);
    if (!force && active.current?.key === input.key) return active.current.promise;
    cancel();
    const job = { id: crypto.randomUUID(), key: input.key, started: false, cancelled: false };
    active.current = job;
    setState(value => ({ ...value, key: input.key, busy: true, error: "", progress: null, cancelled: false }));
    job.promise = (async () => {
      try {
        await cancellation;
        if (job.cancelled || !alive.current) return null;
        job.started = true;
        const cached = !force && input.snapshot?.source === input.source && input.snapshot.scope === input.scope;
        const result = await call("world-data.scan", { requestId: job.id, summaryOnly: true, scope: input.scope,
          ...(cached ? { reuseRequestId: input.snapshot.requestId } : {}), ...(input.worldId ? { worldId: input.worldId } : { source: input.source }) });
        if (job.cancelled || !alive.current || active.current !== job) return null;
        latest.current.onSnapshot(result);
        setState({ key: input.key, busy: false, error: "", progress: null, checkedId: result.requestId, cancelled: false });
        return result;
      } catch (error) {
        if (!job.cancelled && alive.current && active.current === job) setState({ key: input.key, busy: false, error: error.message, progress: null, checkedId: "", cancelled: false });
        return null;
      } finally { if (active.current === job) active.current = null; }
    })();
    return job.promise;
  };
  useEffect(() => {
    alive.current = true;
    const timer = setTimeout(() => load(), 0);
    return () => { clearTimeout(timer); alive.current = false; cancel(); };
  }, [key]);
  useEffect(() => {
    const entering = observe && !wasVisible.current; wasVisible.current = observe;
    if (!entering) return;
    load();
  }, [observe]);
  useEffect(() => {
    if (!enabled || !observe || !state.busy) return;
    const timer = setInterval(() => {
      const job = active.current;
      if (job?.started) call("world-data.state", { requestId: job.id }).then(progress => {
        if (alive.current && active.current === job) setState(value => ({ ...value, progress }));
      }).catch(() => {});
    }, 350);
    return () => clearInterval(timer);
  }, [state.busy, observe, enabled]);
  return { scope, setScope, unavailable: !enabled, busy: enabled && !!(source || worldId) && (state.key !== key || state.busy),
    data: enabled && state.key === key && snapshot?.source === source && snapshot.scope === scope && snapshot.requestId === state.checkedId ? snapshot : null,
    error: state.key === key ? state.error : "", progress: state.key === key ? state.progress : null,
    cancelled: state.key === key && state.cancelled, reload: () => load(true), cancel };
}
