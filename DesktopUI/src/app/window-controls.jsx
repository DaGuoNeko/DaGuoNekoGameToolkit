import React, { useEffect, useState } from "react";
import { Button, Modal, ErrorBox } from "./ui.jsx";

// These controls belong to the page so <dialog>'s backdrop also covers them.
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState("");
  const [closeRequest, setCloseRequest] = useState(null);
  const [closeError, setCloseError] = useState("");
  const [responding, setResponding] = useState(false);
  useEffect(
    () =>
      window.toolkit.onCloseRequested((request) => {
        setCloseError("");
        setCloseRequest(request);
      }),
    [],
  );
  async function respondToClose(action) {
    if (responding) return;
    setResponding(true);
    setCloseError("");
    try {
      await window.toolkit.call("window.confirm-close", { action });
      setCloseRequest(null);
    } catch (error) {
      setCloseError(error.message);
    } finally {
      setResponding(false);
    }
  }
  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.toolkit.onWindowState((state) =>
      setMaximized(state.maximized),
    );
    window.toolkit
      .call("window.state")
      .then((state) => {
        if (mounted) setMaximized(state.maximized);
      })
      .catch((error) => {
        if (mounted) setError(error.message);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  async function control(action) {
    setError("");
    try {
      await window.toolkit.call("window.control", { action });
    } catch (error) {
      setError(error.message);
    }
  }
  return (
    <>
      <div className="window-controls" role="group" aria-label="窗口操作">
        <button
          type="button"
          title="最小化"
          aria-label="最小化窗口"
          onClick={() => control("minimize")}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1 6.5h10" />
          </svg>
        </button>
        <button
          type="button"
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
          onClick={() => control("maximize")}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            {maximized ? (
              <path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7z" />
            ) : (
              <rect x="1.5" y="1.5" width="9" height="9" />
            )}
          </svg>
        </button>
        <button
          type="button"
          className="window-close"
          title="关闭"
          aria-label="关闭窗口"
          onClick={() => control("close")}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="m1.5 1.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>
      {error && (
        <div className="window-control-error" role="alert">
          {error}
        </div>
      )}
      {closeRequest && (
        <Modal
          title="关闭游戏工具箱"
          initialFocus="[data-close-cancel]"
          onClose={() => respondToClose("cancel")}
          busy={responding}
          footer={
            <>
              <Button
                data-close-cancel
                primary
                disabled={responding}
                onClick={() => respondToClose("cancel")}
              >
                继续编辑
              </Button>
              <Button
                danger
                disabled={responding}
                onClick={() => respondToClose("exit")}
              >
                退出
              </Button>
            </>
          }
        >
          <p>
            {closeRequest.busy
              ? "游戏会话仍在运行，退出会停止本次启动的游戏。"
              : "存在未保存配置或未应用的界面修改，退出后将丢弃这些修改。"}
          </p>
          <p className="muted close-confirm-detail">
            请先保存项目配置和游戏内进度。只有由本工具箱启动的会话会被停止。
          </p>
          <ErrorBox>{closeError}</ErrorBox>
        </Modal>
      )}
    </>
  );
}
