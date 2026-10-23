import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, Field, Select, ErrorBox } from "../../app/ui.jsx";
import { diffCache, applyCache } from "../../../shared/inspector-cache.cjs";
const Context = createContext(null);
const states = {
  process_started: "游戏启动中",
  game_ready: "调试就绪",
  game_unavailable: "等待进入世界",
  exiting: "正在退出",
  exited: "已退出",
  starting: "正在连接",
};
const call = (method, args = {}) => window.toolkit.call(method, args);
export function DebugSessionProvider({ children }) {
  const [snapshot, setSnapshot] = useState({
    sessions: [],
    profiles: [],
    pickers: [],
    pickerOwners: {},
    revision: -1,
  });
  const [selected, setSelectedState] = useState(""),
    [error, setError] = useState(""),
    [refreshing, setRefreshing] = useState(false),
    [inspectorDirty, setInspectorDirty] = useState(false);
  const [workspace, setWorkspace] = useState({
    version: -1,
    ready: false,
    open: false,
    popup: new URLSearchParams(location.search).get("inspector") === "1",
    ownerId: "",
  });
  const workspaceRef = useRef(workspace),
    selectedRef = useRef("");
  const [transferring, setTransferring] = useState(false);
  const transfer = useRef(false);
  const caches = useRef(new Map()),
    listeners = useRef(new Map()),
    pending = useRef(new Map()),
    timer = useRef(null),
    writes = useRef(Promise.resolve());
  const synced = useRef(new Map());
  const subscribeCache = useCallback((key, listener) => {
    if (!listeners.current.has(key)) listeners.current.set(key, new Set());
    listeners.current.get(key).add(listener);
    return () => {
      const set = listeners.current.get(key);
      set.delete(listener);
      if (!set.size) listeners.current.delete(key);
    };
  }, []);
  const putCache = useCallback((key, value) => {
    if (caches.current.get(key) === value) return;
    caches.current.delete(key);
    caches.current.set(key, value);
    const clean = [...caches.current].filter(
      ([id, state]) =>
        id !== key &&
        !listeners.current.get(id)?.size &&
        !state.pendingMutation &&
        !Object.keys(state.drafts || {}).length,
    );
    for (const [id] of clean.slice(0, Math.max(0, caches.current.size - 3))) {
      caches.current.delete(id);
      synced.current.delete(id);
    }
    setInspectorDirty(
      [...caches.current.values()].some(
        (state) =>
          Object.keys(state.drafts || {}).length || state.pendingMutation,
      ),
    );
    for (const listener of listeners.current.get(key) || []) listener();
  }, []);
  const flushCaches = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (!workspaceRef.current.ready) throw Error("调试工作区尚未初始化");
    const entries = [...pending.current];
    pending.current.clear();
    if (
      entries.length &&
      (workspaceRef.current.popup || !workspaceRef.current.open)
    ) {
      const task = writes.current
        .catch(() => {})
        .then(async () => {
          const patches = entries
            .map(([key, value]) => [
              key,
              diffCache(synced.current.get(key), value),
            ])
            .filter(
              ([, patch]) =>
                patch.replace ||
                patch.pages ||
                Object.keys(patch.fields).length,
            );
          const accepted =
            !patches.length ||
            (await call("inspector.cache", { entries: patches }));
          if (accepted)
            for (const [key, value] of entries) synced.current.set(key, value);
        })
        .catch((error) => {
          for (const [key] of entries) {
            synced.current.delete(key);
            if (!pending.current.has(key) && caches.current.has(key))
              pending.current.set(key, caches.current.get(key));
          }
          throw error;
        });
      writes.current = task;
    }
    await writes.current;
  }, []);
  const saveCache = useCallback(
    (key, value) => {
      if (workspaceRef.current.open && !workspaceRef.current.popup) return;
      putCache(key, value);
      pending.current.set(key, value);
      if (workspaceRef.current.ready && !timer.current)
        timer.current = setTimeout(
          () => flushCaches().catch((e) => setError(e.message)),
          120,
        );
    },
    [putCache, flushCaches],
  );
  const receive = useCallback(
    (value) =>
      setSnapshot((old) => (value.revision >= old.revision ? value : old)),
    [],
  );
  const receiveWindow = useCallback(
    (value) => {
      if (value.version < workspaceRef.current.version) return;
      const next = { ...value, ready: true };
      workspaceRef.current = next;
      setWorkspace(next);
      for (const [key, data] of value.caches || []) {
        putCache(key, data);
        synced.current.set(key, data);
      }
      if (value.selected) {
        selectedRef.current = value.selected;
        setSelectedState(value.selected);
      }
      if (pending.current.size) flushCaches().catch((e) => setError(e.message));
    },
    [putCache, flushCaches],
  );
  useEffect(() => {
    let alive = true;
    const off = window.toolkit.onDebug((value) => alive && receive(value));
    const offWindow = window.toolkit.onInspectorWindow(
      (value) => alive && receiveWindow(value),
    );
    const offCache = window.toolkit.onInspectorCache((entries) => {
      if (
        alive &&
        entries.some(
          ([key, patch]) => !patch.replace && !caches.current.has(key),
        )
      ) {
        call("inspector.state")
          .then((value) => alive && receiveWindow(value))
          .catch((e) => alive && setError(e.message));
        return;
      }
      if (alive)
        for (const [key, patch] of entries) {
          const value = applyCache(caches.current.get(key), patch);
          putCache(key, value);
          synced.current.set(key, value);
        }
    });
    const offSelected = window.toolkit.onInspectorSelected((value) => {
      if (alive) {
        selectedRef.current = value;
        setSelectedState(value);
      }
    });
    call("debug.state")
      .then((v) => alive && receive(v))
      .catch((e) => alive && setError(e.message));
    call("inspector.state")
      .then((v) => alive && receiveWindow(v))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
      off();
      offWindow();
      offCache();
      offSelected();
      clearTimeout(timer.current);
    };
  }, [receive, receiveWindow, putCache]);
  function setSelected(value) {
    const previous = selectedRef.current;
    selectedRef.current = value;
    setSelectedState(value);
    call("inspector.selected", { selected: value }).catch((e) => {
      if (selectedRef.current === value) {
        selectedRef.current = previous;
        setSelectedState(previous);
      }
      setError(e.message);
    });
  }
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      receive(await call("debug.refresh"));
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }
  async function expand() {
    if (transfer.current) return;
    transfer.current = true;
    setTransferring(true);
    try {
      await flushCaches();
      receiveWindow(
        await call("inspector.open", {
          selected: selectedRef.current,
          caches: [...caches.current],
        }),
      );
    } finally {
      transfer.current = false;
      setTransferring(false);
    }
  }
  async function closeInspector() {
    if (transfer.current) return;
    transfer.current = true;
    setTransferring(true);
    try {
      await flushCaches();
      await call("inspector.close");
    } finally {
      transfer.current = false;
      setTransferring(false);
    }
  }
  const session =
    snapshot.sessions.find((s) => s.id === selected) ||
    snapshot.sessions.find((s) => s.connected) ||
    snapshot.sessions[0];
  const ready =
    !!session?.connected &&
    session.state === "game_ready" &&
    session.gameIpcConnected &&
    session.debugCapabilityEnabled;
  const context = {
    sessionId: session?.id,
    generation: session?.connectionGeneration,
  };
  return (
    <Context.Provider
      value={{
        snapshot,
        session,
        ready,
        context,
        selected,
        setSelected,
        refresh,
        refreshing,
        error,
        caches,
        saveCache,
        subscribeCache,
        inspectorDirty,
        workspace,
        transferring,
        expand,
        closeInspector,
        flushCaches,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const useDebugSession = () => useContext(Context);
export function DebugSessionBar() {
  const {
    snapshot,
    session,
    ready,
    setSelected,
    refresh,
    refreshing,
    error,
    caches,
  } = useDebugSession();
  return (
    <>
      <div className="debug-session">
        <Field label="游戏会话">
          <Select
            disabled={[...caches.current.values()].some(
              (value) => value.pendingMutation,
            )}
            value={session?.id || ""}
            placeholder="尚未启动"
            options={snapshot.sessions.map((s) => ({
              value: s.id,
              label: `${s.profileName || s.projectRoot.split(/[\\/]/).pop()} · ${s.worldName || "游戏"} · PID ${s.minecraftPid} · ${s.connected ? states[s.state] || s.state : "已断开"}`,
            }))}
            onChange={setSelected}
          />
        </Field>
        <span className={`debug-badge ${ready ? "ready" : ""}`}>
          {session?.connected
            ? states[session.state] || session.state
            : "尚未连接"}
        </span>
        <Button disabled={refreshing} onClick={refresh}>
          {refreshing ? "刷新中…" : "刷新会话"}
        </Button>
      </div>
      {!ready && (
        <p className="muted">
          请通过工具箱启动项目并进入世界；项目需启用“加载开发辅助模组”。调试操作在连接就绪后开放。
        </p>
      )}
      <ErrorBox>{error || snapshot.error}</ErrorBox>
    </>
  );
}
