import React, { useEffect, useRef, useState } from "react";
const api = (method, args = {}) => window.toolkit.call(method, args);
export function useGamePreview(doc, onSelection) {
  const [state, setState] = useState({ phase: "stopped", generation: 0 }),
    [error, setError] = useState("");
  const latest = useRef();
  latest.current = { doc, onSelection, state };
  useEffect(() => {
    let live = true;
    api("ui-editor.preview.state")
      .then((s) => {
        if (live) setState(s);
      })
      .catch((e) => setError(e.message));
    const off = window.toolkit.onEditorPreview((event) => {
      if (event.type === "state")
        setState((old) => ({
          ...event.value,
          tree: old.generation === event.value.generation ? old.tree : null,
        }));
      if (event.type === "tree")
        setState((old) =>
          old.generation === event.value.generation
            ? { ...old, tree: event.value.tree }
            : old,
        );
      if (
        event.type === "selection" &&
        event.value.documentId === latest.current.doc?.id &&
        event.value.generation === latest.current.state.generation
      )
        latest.current.onSelection(event.value);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  async function action(method, args = {}) {
    setError("");
    try {
      const result = await api("ui-editor.preview." + method, args);
      if (result?.phase)
        setState((old) => ({
          ...result,
          tree: old.generation === result.generation ? old.tree : null,
        }));
      return result;
    } catch (e) {
      setError(e.message);
    }
  }
  const active = state.phase !== "stopped" && !!state.pid;
  return { state, error, active, action };
}
export function GamePreview({
  preview,
  documentId,
  width = 640,
  height = 360,
}) {
  const area = useRef(),
    [space, setSpace] = useState([1, 1]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSpace([entry.contentRect.width, entry.contentRect.height]),
    );
    observer.observe(area.current);
    return () => observer.disconnect();
  }, []);
  const viewWidth = Math.max(
    1,
    Math.min(space[0], (space[1] * width) / height),
  );
  const ref = useRef(),
    last = useRef("");
  const generation = preview.state.generation;
  const owned = preview.state.documentId === documentId;
  const [showGame, setShowGame] = useState(!!preview.state.showGame),
    [gamePending, setGamePending] = useState(false);
  useEffect(
    () => setShowGame(!!preview.state.showGame),
    [preview.state.showGame],
  );
  useEffect(() => {
    let alive = true;
    const update = () => {
      const bounds = ref.current?.getBoundingClientRect();
      const hidden =
        !owned ||
        document.hidden ||
        !!document.querySelector('dialog[open], [role="listbox"]') ||
        !bounds ||
        !ref.current?.getClientRects().length;
      const rect = hidden
        ? null
        : {
            x: Math.max(0, bounds.x),
            y: Math.max(0, bounds.y),
            width: bounds.width,
            height: bounds.height,
          };
      const key = JSON.stringify(rect);
      if (last.current === key) return;
      last.current = key;
      api("ui-editor.preview.bounds", { generation, rect }).catch(() => {
        last.current = "";
      });
    };
    last.current = "";
    const timer = setInterval(update, 250),
      observer = new ResizeObserver(update);
    observer.observe(ref.current);
    const modals = new MutationObserver(update);
    modals.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    update();
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      alive = false;
      clearInterval(timer);
      observer.disconnect();
      modals.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
      api("ui-editor.preview.bounds", { generation, rect: null }).catch(
        () => {},
      );
    };
  }, [generation, owned, preview.state.phase]);
  return (
    <div className="ue-live-wrap">
      <div className="ue-live-toolbar">
        <span>
          游戏引擎预览 ·{" "}
          {preview.state.phase === "ready" ? "已连接" : preview.state.message}
        </span>
        <label>
          <input
            type="checkbox"
            checked={showGame}
            disabled={preview.state.phase !== "ready" || gamePending}
            onChange={async (e) => {
              const value = e.target.checked;
              const previous = showGame;
              setShowGame(value);
              setGamePending(true);
              const result = await preview.action("game", { value });
              if (!result) setShowGame(previous);
              setGamePending(false);
            }}
          />
          显示游戏世界
        </label>
      </div>
      <div className="ue-game-area" ref={area}>
        <div
          className="ue-native-host"
          ref={ref}
          style={{ width: viewWidth, height: (viewWidth * height) / width }}
        >
          <span>
            {owned
              ? "正在准备真实游戏窗口…"
              : "正在预览其他文件，请先停止再为当前文件启动"}
          </span>
        </div>
      </div>
      <div className="ue-live-footer">
        修改后点“更新游戏预览”应用到引擎；源文件需另行保存。
      </div>
    </div>
  );
}
