import React, { useEffect, useRef, useState } from "react";
import { Button, Select, ErrorBox, Modal, HelpDisclosure } from "../../app/ui.jsx";
import { useDebugSession } from "../debug/debug-session.jsx";
import "./tracy-profiler.css";
const api = (method, args = {}) => window.toolkit.call(method, args);
export function TracyPage() {
  const { snapshot } = useDebugSession();
  const [state, setState] = useState({
      phase: "stopped",
      generation: 0,
      mode: "embedded",
    }),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const area = useRef();
  useEffect(() => {
    let live = true;
    api("tracy.state")
      .then((s) => {
        if (live) setState(s);
      })
      .catch((e) => setError(e.message));
    const off = window.toolkit.onTracy((s) => setState(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  const clients = snapshot.sessions.filter(
    (s) => s.connected && s.minecraftPid && s.state !== "exited",
  );
  const chosen = clients.find((s) => s.id === selected) || clients[0];
  const active = !!state.pid;
  useEffect(() => {
    let last = "";
    const update = () => {
      const box = area.current?.getBoundingClientRect();
      const hidden =
        document.hidden ||
        !!document.querySelector("dialog[open], :popover-open") ||
        !box ||
        state.mode !== "embedded";
      const rect = hidden
        ? null
        : {
            x: Math.max(0, box.x),
            y: Math.max(0, box.y),
            width: box.width,
            height: box.height,
          };
      const next = JSON.stringify(rect);
      if (next === last) return;
      last = next;
      api("tracy.bounds", { generation: state.generation, rect }).catch((e) => {
        last = "";
        setError(e.message);
      });
    };
    const timer = setInterval(update, 250),
      observer = new ResizeObserver(update),
      modals = new MutationObserver(update);
    if (area.current) observer.observe(area.current);
    modals.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    update();
    return () => {
      clearInterval(timer);
      observer.disconnect();
      modals.disconnect();
      api("tracy.bounds", { generation: state.generation, rect: null }).catch(
        () => {},
      );
    };
  }, [state.generation, state.phase, state.mode]);
  async function action(method, args = {}) {
    setError("");
    setBusy(true);
    try {
      const value = await api(method, args);
      if (value?.phase) setState(value);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="tracy-page">
      <div className="tracy-heading">
        <h1>Tracy 性能分析</h1>
        <span className="muted">官方完整界面 · 建议使用 0.11.1</span>
      </div>
      <div className="tracy-toolbar">
        <Select
          aria-label="Tracy 游戏会话"
          value={chosen?.id || ""}
          disabled={active || busy}
          options={clients.map((s) => ({
            value: s.id,
            label: `${s.profileName || "游戏"} · PID ${s.minecraftPid}`,
          }))}
          onChange={setSelected}
        />
        <Button
          primary
          disabled={!chosen || active || busy}
          onClick={() =>
            action("tracy.start", {
              sessionId: chosen.id,
              generation: chosen.connectionGeneration,
            })
          }
        >
          连接所选游戏
        </Button>
        <Button disabled={active || busy} onClick={() => action("tracy.start")}>
          打开分析器
        </Button>
        <Button
          disabled={active || busy}
          onClick={() => action("tracy.open-trace")}
        >
          打开 .tracy 文件
        </Button>
        {active && (
          <Button
            disabled={busy || state.phase !== "open"}
            onClick={() =>
              action("tracy.mode", {
                generation: state.generation,
                mode: state.mode === "embedded" ? "external" : "embedded",
              })
            }
          >
            {state.mode === "embedded" ? "独立窗口" : "嵌入页面"}
          </Button>
        )}
        {active && (
          <Button disabled={busy} onClick={() => setConfirm(true)}>
            关闭分析器
          </Button>
        )}
        <Button
          disabled={active || busy}
          onClick={() => action("tracy.pick-exe")}
        >
          选择 Tracy 程序
        </Button>
      </div>
      <ErrorBox>{error}</ErrorBox>
      <div className="tracy-status">
        <span>
          {state.message ||
            "选择游戏自动连接，或打开离线采样文件。首次自动查找本机 MCStudio 的 Tracy。"}
        </span>
        {state.target && (
          <span>
            PID {state.target.gamePid} · 127.0.0.1:{state.target.port}
          </span>
        )}
      </div>
      <div className="tracy-viewport" ref={area}>
        <div className="tracy-placeholder">
          {active
            ? state.mode === "external"
              ? "Tracy 正在独立窗口运行，可随时嵌回此页。"
              : "官方 Tracy 窗口区域"
            : "帧时间线、函数统计、内存与调用栈在官方界面中操作。"}
        </div>
      </div>
      <HelpDisclosure label="采样、保存与退出说明">
        切页后采样继续，保存请使用 Tracy 内的 Save。与 Native
        采样共用游戏连接；同一游戏不能同时连接两份分析器。退出工具箱会将分析器恢复为独立窗口，保留未保存数据。
      </HelpDisclosure>
      {confirm && (
        <Modal title="关闭 Tracy 分析器" onClose={() => setConfirm(false)}>
          <p>
            请先在 Tracy
            内保存需要保留的采样。此操作只请求关闭本工具箱打开的分析器，不关闭游戏。
          </p>
          <div className="tracy-toolbar">
            <Button onClick={() => setConfirm(false)}>取消</Button>
            <Button
              danger
              onClick={() => {
                setConfirm(false);
                action("tracy.close", {
                  generation: state.generation,
                  confirmed: true,
                });
              }}
            >
              已保存，关闭分析器
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
