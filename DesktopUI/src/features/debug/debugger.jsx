import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Intro,
  Field,
  Select,
  ErrorBox,
  Empty,
  Section,
  Modal,
  Icon,
} from "../../app/ui.jsx";
import { useDebugSession, DebugSessionBar } from "./debug-session.jsx";
import { ProfilerPanel } from "./debug-profiler.jsx";
import "./debugger.css";
export const debugApi = (method, args = {}) =>
  window.toolkit.call(method, args);
const tabs = [
  ["code", "代码执行"],
  ["functions", "调试函数"],
  ["python", "Python 性能"],
  ["memory", "Python 内存"],
  ["native", "Native 性能"],
];
export function DebugPage({ projectId, draft, setDraft }) {
  const { snapshot, session, ready, context } = useDebugSession();
  const [tab, setTab] = useState("code");
  return (
    <div className="debug-page">
      <Intro
        title="游戏调试"
        subtitle="执行代码、调用函数并分析游戏性能。UI 控件调试已移至侧栏独立页面。"
      />
      <DebugSessionBar />
      <ReloadActions context={context} ready={ready} />
      <div className="debug-tabs" role="tablist" aria-label="调试工具">
        {tabs.map(([id, label]) => (
          <button
            role="tab"
            aria-selected={tab === id}
            key={id}
            onClick={() => {
              setTab(id);
            }}
          >
            <Icon name={id === "code" ? "terminal" : id === "functions" ? "tools" : "activity"} size={16} />{label}
          </button>
        ))}
      </div>
      <div
        key={`${session?.id || "offline"}:${session?.connectionGeneration || 0}`}
      >
        {tab === "code" && (
          <CodePanel
            context={context}
            ready={ready}
            draft={draft}
            setDraft={setDraft}
          />
        )}
        {tab === "functions" && (
          <FunctionsPanel
            context={context}
            ready={ready}
            projectId={session?.projectId || projectId}
          />
        )}
        {["python", "memory", "native"].includes(tab) && (
          <ProfilerPanel
            key={tab}
            kind={tab}
            context={context}
            ready={ready}
            snapshot={snapshot}
          />
        )}
      </div>
    </div>
  );
}

export function ReloadActions({ context, ready }) {
  const [pending, setPending] = useState(false),
    [confirm, setConfirm] = useState(null),
    [sources, setSources] = useState(null),
    [saved, setSaved] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const contextKey = JSON.stringify(context),
    live = useRef(contextKey);
  live.current = contextKey;
  useEffect(() => {
    let active = true,
      timer;
    setSources(null);
    const refresh = async () => {
      try {
        const value = await debugApi("debug.sources", context);
        if (active) setSources(value);
      } catch (e) {
        if (active) setSources({ error: e.message });
      } finally {
        if (active) timer = setTimeout(refresh, 2500);
      }
    };
    if (context?.sessionId) refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [contextKey, ready]);
  async function run(action, target = context) {
    const key = JSON.stringify(target);
    setPending(true);
    setMessage("");
    setError("");
    try {
      const result =
        action === "restart"
          ? await debugApi("debug.restartLatest", {
              ...target,
              token: confirm.token,
              confirmed: saved,
            })
          : await debugApi("debug.reload", {
              ...target,
              action,
              confirmed: action !== "scripts",
            });
      if (live.current === key)
        setMessage(
          action === "restart"
            ? "已按最新配置重新启动目标存档，请等待游戏就绪。"
            : action === "scripts"
              ? result.updated
                ? `已增量更新 ${result.updated} 个脚本模块。`
                : "没有检测到已加载脚本的改动。"
              : "重载请求已接收，请等待游戏重新就绪。",
        );
    } catch (e) {
      if (live.current === key) {
        setError(e.message + "；超时或断开时请先检查游戏状态，不要连续重试。");
        debugApi("debug.sources", target)
          .then((v) => {
            if (live.current === key) setSources(v);
          })
          .catch(() => {});
      }
    } finally {
      setPending(false);
      setConfirm(null);
      setSaved(false);
    }
  }
  useEffect(() => {
    live.current = contextKey;
    setMessage("");
    setError("");
    setConfirm(null);
    return () => {
      live.current = "";
    };
  }, [contextKey]);
  return (
    <>
      <div className="toolbar reload-toolbar">
        <Button disabled={!ready || pending} onClick={() => run("scripts")}>
          热更新脚本
        </Button>
        <Button
          disabled={!ready || pending}
          onClick={() => setConfirm({ action: "world", target: context })}
        >
          重载游戏
        </Button>
        <Button
          disabled={!ready || pending}
          onClick={() => setConfirm({ action: "addons", target: context })}
        >
          重载资源和游戏
        </Button>
        <span className="muted">
          {pending ? "正在发送…" : "作用于上方选中的游戏会话"}
        </span>
      </div>
      {sources && (
        <div className="reload-sources">
          <p
            className={sources.changed || sources.error ? "notice" : "muted"}
            role={sources.changed || sources.error ? "status" : undefined}
          >
            {sources.error || sources.message}
          </p>
          {!!sources.activeSources?.length && (
            <details>
              <summary>查看本次运行的模组来源</summary>
              <ul>
                {sources.activeSources.map((dir, i) => (
                  <li key={i}>
                    <code>{dir}</code>
                  </li>
                ))}
              </ul>
              {sources.configFile && (
                <p>
                  启动配置：<code>{sources.configFile}</code>
                </p>
              )}
            </details>
          )}
          {sources.changed && (
            <>
              <p>已保存配置中的模组：</p>
              <ul>
                {sources.savedSources.map((m, i) => (
                  <li key={i}>
                    {m.enabled ? "启用" : "停用"} · <code>{m.path}</code>
                  </li>
                ))}
              </ul>
              {sources.canRestart ? (
                <Button
                  primary
                  disabled={pending}
                  onClick={() => {
                    setSaved(false);
                    setConfirm({
                      action: "restart",
                      target: context,
                      token: sources.token,
                    });
                  }}
                >
                  按最新配置重启
                </Button>
              ) : (
                <p>请保存并退出当前客户端，再从原启动入口启动。</p>
              )}
            </>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      <ErrorBox>{error}</ErrorBox>
      {confirm && (
        <Modal
          title={
            confirm.action === "restart"
              ? "按最新配置重启目标存档？"
              : "重载当前游戏世界？"
          }
          onClose={() => !pending && setConfirm(null)}
          footer={
            <>
              <Button disabled={pending} onClick={() => setConfirm(null)}>
                取消
              </Button>
              <Button
                primary
                disabled={
                  pending || (confirm.action === "restart" ? !saved : !ready)
                }
                onClick={() => run(confirm.action, confirm.target)}
              >
                {confirm.action === "restart" ? "确认重启" : "确认重载"}
              </Button>
            </>
          }
        >
          {confirm.action === "restart" ? (
            <>
              <p>
                将停止此存档的游戏进程，重新读取已保存的配置并启动同一存档。其他页面未保存的配置草稿不会应用。
              </p>
              <p>
                请先在游戏中保存进度。此操作会断开当前来宾，恢复情况取决于其联机方式。
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />{" "}
                我已保存游戏进度
              </label>
            </>
          ) : (
            <p>
              将重新加载当前世界运行环境，调试连接会暂时断开。请先保存游戏进度，运行时修改的
              UI 属性会失效；不会重建或删除存档。
            </p>
          )}
          {confirm.action === "addons" && <p>同时重新加载 Add-on 资源数据。</p>}
        </Modal>
      )}
    </>
  );
}

function CodePanel({ context, ready, draft, setDraft }) {
  const [busy, setBusy] = useState(false),
    [side, setSide] = useState("client");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  async function execute() {
    if (busy || !ready) return;
    setBusy(true);
    const entry = {
      id: crypto.randomUUID(),
      time: new Date().toLocaleTimeString(),
      sessionId: context.sessionId,
      side,
      code: draft.code,
    };
    try {
      entry.result = await debugApi("debug.execute", {
        ...context,
        code: draft.code,
        isClient: side === "client",
      });
    } catch (error) {
      entry.error = error.message;
    } finally {
      setDraft((old) => ({
        ...old,
        records: [entry, ...old.records].slice(0, 30),
      }));
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="debug-split">
      <section className="debug-card">
        <header>
          <h2>Python 代码</h2>
          <Select
            aria-label="代码执行端"
            value={side}
            options={[
              { value: "client", label: "客户端" },
              { value: "server", label: "服务端" },
            ]}
            onChange={setSide}
          />
        </header>
        <textarea
          aria-label="Python 代码"
          className="debug-editor"
          spellCheck={false}
          value={draft.code}
          onChange={(e) =>
            setDraft((old) => ({ ...old, code: e.target.value }))
          }
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              execute();
            }
          }}
        />
        <footer>
          <span className="muted">
            Python 2.7 · 用 _result 返回值；print 输出见运行日志。
          </span>
          <Button
            primary
            disabled={!ready || busy || !draft.code.trim()}
            onClick={execute}
          >
            {busy ? "执行中…" : "执行"}
          </Button>
        </footer>
      </section>
      <section className="debug-card">
        <header>
          <h2>执行结果</h2>
          <Button onClick={() => setDraft((old) => ({ ...old, records: [] }))}>
            清空记录
          </Button>
        </header>
        <div className="debug-results">
          {draft.records.length ? (
            draft.records.map((entry) => (
              <article key={entry.id} className="debug-result">
                <small>
                  {entry.time} · {entry.side === "client" ? "客户端" : "服务端"}
                </small>
                <pre className={entry.error ? "debug-error" : ""}>
                  {entry.error ||
                    JSON.stringify(entry.result, null, 2) ||
                    "执行完成，无返回值"}
                </pre>
              </article>
            ))
          ) : (
            <Empty title="暂无执行记录">
              连接游戏后运行代码，结果会显示在这里。
            </Empty>
          )}
        </div>
      </section>
    </div>
  );
}

function FunctionsPanel({ context, ready, projectId }) {
  const [discovered, setDiscovered] = useState([]),
    [saved, setSaved] = useState([]),
    [filter, setFilter] = useState("");
  const [editing, setEditing] = useState(null),
    [values, setValues] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (projectId)
      debugApi("debug.functions.list", { projectId })
        .then((v) => alive.current && setSaved(v))
        .catch((e) => alive.current && setError(e.message));
    return () => {
      alive.current = false;
    };
  }, [projectId]);
  async function run(action) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (alive.current) setError(error.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function choose(item) {
    setEditing({
      ...item,
      label: item.label || item.functionName,
      target: item.target || "client",
      argumentConfigs: item.argumentConfigs || {},
    });
    setValues({});
    setResult(null);
  }
  const visible = discovered.filter((item) =>
    `${item.modulePath}.${item.functionName}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  return (
    <>
      <div className="toolbar">
        <Button
          disabled={!projectId || busy}
          onClick={() =>
            run(async () => {
              const result = await debugApi("debug.functions.discover", {
                projectId,
              });
              if (alive.current) setDiscovered(result);
            })
          }
        >
          {busy ? "处理中…" : "扫描模组函数"}
        </Button>
        <input
          aria-label="搜索调试函数"
          placeholder="按函数名或模块搜索"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <p className="muted">
        扫描 modMain.py
        所在脚本包中的顶层函数；不会导入或执行源码。收藏保存在工具箱配置目录。
      </p>
      <ErrorBox>{error}</ErrorBox>
      <div className="debug-split">
        <section className="debug-card">
          <header>
            <h2>函数列表</h2>
          </header>
          <div className="debug-function-list">
            <h3>收藏</h3>
            {saved.map((item) => (
              <button
                key={item.id}
                className={editing?.id === item.id ? "selected" : ""}
                onClick={() => choose(item)}
              >
                {item.label}
                <small>
                  {item.modulePath}.{item.functionName}
                </small>
              </button>
            ))}
            <h3>扫描结果 · {visible.length}</h3>
            {visible.slice(0, 200).map((item) => (
              <button key={item.key} onClick={() => choose(item)}>
                {item.functionName}
                <small>
                  {item.relativeFilePath}:{item.line}
                </small>
              </button>
            ))}
            {visible.length > 200 && (
              <p className="muted">显示前 200 项，请搜索缩小范围。</p>
            )}
          </div>
        </section>
        <section className="debug-card">
          <header>
            <h2>参数与调用</h2>
          </header>
          <div className="debug-form">
            {editing ? (
              <>
                <Field label="收藏名称">
                  <input
                    value={editing.label}
                    onChange={(e) =>
                      setEditing({ ...editing, label: e.target.value })
                    }
                  />
                </Field>
                <Field label="函数执行端">
                  <Select
                    value={editing.target}
                    options={[
                      { value: "client", label: "客户端" },
                      { value: "server", label: "服务端" },
                    ]}
                    onChange={(target) => setEditing({ ...editing, target })}
                  />
                </Field>
                <p className="muted break-all">
                  {editing.modulePath}.{editing.functionName}
                </p>
                {editing.parameters.map((parameter) => {
                  const config = editing.argumentConfigs[parameter.name] || {
                    mode: parameter.required ? "required" : "optional",
                    value: "",
                  };
                  return (
                    <Field
                      key={parameter.name}
                      label={`${parameter.name}${parameter.required ? "（必填）" : ""}`}
                      hint={
                        parameter.defaultValue
                          ? `Python 默认值：${parameter.defaultValue}`
                          : '值使用 JSON，例如 1、true、"文字"、[] 或 {}'
                      }
                    >
                      <div className="debug-argument">
                        <Select
                          aria-label={`${parameter.name} 参数方式`}
                          value={config.mode}
                          options={[
                            { value: "required", label: "每次必填" },
                            { value: "optional", label: "可选参数" },
                            { value: "fixed", label: "固定值" },
                          ]}
                          onChange={(mode) =>
                            setEditing({
                              ...editing,
                              argumentConfigs: {
                                ...editing.argumentConfigs,
                                [parameter.name]: { ...config, mode },
                              },
                            })
                          }
                        />
                        <input
                          aria-label={`${parameter.name} 参数值`}
                          value={
                            config.mode === "fixed"
                              ? config.value
                              : values[parameter.name] || ""
                          }
                          onChange={(e) =>
                            config.mode === "fixed"
                              ? setEditing({
                                  ...editing,
                                  argumentConfigs: {
                                    ...editing.argumentConfigs,
                                    [parameter.name]: {
                                      ...config,
                                      value: e.target.value,
                                    },
                                  },
                                })
                              : setValues({
                                  ...values,
                                  [parameter.name]: e.target.value,
                                })
                          }
                        />
                      </div>
                    </Field>
                  );
                })}
                <div className="toolbar">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const next = await debugApi("debug.functions.save", {
                          projectId,
                          function: editing,
                        });
                        setSaved(next);
                        setEditing(
                          next.find((item) => item.id === editing.id) ||
                            next.at(-1),
                        );
                      })
                    }
                  >
                    保存收藏
                  </Button>
                  <Button
                    primary
                    disabled={
                      !ready ||
                      busy ||
                      !editing.id ||
                      JSON.stringify(editing) !==
                        JSON.stringify(
                          saved.find((item) => item.id === editing.id),
                        )
                    }
                    onClick={() =>
                      run(async () =>
                        setResult(
                          await debugApi("debug.functions.invoke", {
                            ...context,
                            projectId,
                            id: editing.id,
                            arguments: values,
                          }),
                        ),
                      )
                    }
                  >
                    调用函数
                  </Button>
                  {editing.id && (
                    <Button
                      danger
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          setSaved(
                            await debugApi("debug.functions.delete", {
                              projectId,
                              id: editing.id,
                            }),
                          );
                          setEditing(null);
                        })
                      }
                    >
                      移除收藏
                    </Button>
                  )}
                  <Button
                    onClick={() =>
                      debugApi("debug.source", {
                        projectId,
                        file:
                          editing.absoluteFilePath || editing.relativeFilePath,
                      }).catch((e) => setError(e.message))
                    }
                  >
                    定位源文件
                  </Button>
                </div>
                <pre className="debug-json">
                  {result === null
                    ? "保存收藏后可调用；参数或执行端修改后请先保存。"
                    : JSON.stringify(result, null, 2)}
                </pre>
              </>
            ) : (
              <Empty title="选择一个函数">
                先扫描当前配置的模组或选择已有收藏。
              </Empty>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
