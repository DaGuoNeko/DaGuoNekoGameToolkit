import React, {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button, Field, Select, ErrorBox, Modal } from "./ui.jsx";
import { useDebugSession } from "./debug-session.jsx";

export function InspectorSettings({ view, ready, busy, picker, onAction }) {
  return (
    <div className="inspector-toolbar">
      <Field label="UI 屏幕">
        <Select
          aria-label="UI 屏幕"
          value={view.screen}
          disabled={!ready || busy}
          options={(view.screens || []).map((screen) => ({
            value: screen,
            label: screen,
          }))}
          onChange={(screen) => onAction("screen", screen)}
          placeholder="先读取屏幕"
        />
      </Field>
      <Button disabled={!ready || busy} onClick={() => onAction("refresh")}>
        {view.screens?.length ? "刷新屏幕" : "读取屏幕"}
      </Button>
      <Button
        primary={picker}
        disabled={!ready || busy}
        onClick={() => onAction("picker", !picker)}
      >
        {picker ? "停止双向选中" : "开启双向选中"}
      </Button>
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!view.bounds}
          disabled={!ready || busy || picker}
          onChange={(e) => onAction("bounds", e.target.checked)}
        />
        显示控件边界
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!view.autoRefresh}
          disabled={!ready || busy}
          onChange={(e) => onAction("autoRefresh", e.target.checked)}
        />
        自动刷新属性
      </label>
    </div>
  );
}
export function RemoteInspectorSettings() {
  const { context, ready, caches, subscribeCache, snapshot } =
    useDebugSession();
  const key = `${context.sessionId || "offline"}:${context.generation || 0}`;
  const fallback = useRef({ screens: [], screen: "", drafts: {} });
  const subscribe = useCallback(
    (fn) => subscribeCache(key, fn),
    [key, subscribeCache],
  );
  const getSnapshot = useCallback(
    () => caches.current.get(key) || fallback.current,
    [key, caches],
  );
  const view = useSyncExternalStore(subscribe, getSnapshot);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(null);
  async function send(action, value, discardDrafts = false) {
    if (
      action === "screen" &&
      Object.keys(view.drafts || {}).length &&
      !discardDrafts
    ) {
      setConfirm({ action, value });
      return;
    }
    setPending(true);
    setError("");
    try {
      await window.toolkit.call("inspector.command", {
        ...context,
        action,
        value,
        discardDrafts,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="inspector-remote-settings">
      <InspectorSettings
        view={view}
        ready={ready}
        busy={pending || !!view.remoteBusy || !!view.pendingMutation}
        picker={ready && snapshot.pickers.includes(context.sessionId)}
        onAction={send}
      />
      <p className="muted">
        独立调试窗口正在使用。这里的设置会同步到该窗口；关闭窗口后，控件树与草稿会回到本页。
      </p>
      <ErrorBox>{error || view.error}</ErrorBox>
      {view.notice && <p role="status">{view.notice}</p>}
      {confirm && (
        <Modal
          title="切换屏幕？"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>继续编辑</Button>
              <Button
                danger
                onClick={() => {
                  const next = confirm;
                  setConfirm(null);
                  send(next.action, next.value, true);
                }}
              >
                丢弃草稿并切换
              </Button>
            </>
          }
        >
          <p>
            当前控件还有未应用修改。切换屏幕将丢弃这些草稿，游戏中已应用的修改会保留。
          </p>
        </Modal>
      )}
    </section>
  );
}
