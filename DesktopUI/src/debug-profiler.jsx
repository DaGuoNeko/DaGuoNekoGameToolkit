import React, { useState } from "react";
import { Button, Field, Select, ErrorBox, Empty } from "./ui.jsx";
const api = (method, args = {}) => window.toolkit.call(method, args);
const ms = (seconds) => Number(seconds * 1000).toFixed(3);
const size = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`;
function CallNodes({ nodes, depth = 0 }) {
  if (depth > 30) return <p>更深调用见导出报告。</p>;
  return nodes.map((node, index) => (
    <details key={`${node.id}:${index}`}>
      <summary>
        {node.name} · {(node.totalNanoseconds / 1e6).toFixed(3)} ms ·{" "}
        {node.calls} 次
      </summary>
      <small>
        {node.sourceFile}:{node.sourceLine}
      </small>
      <div className="profile-children">
        <CallNodes nodes={node.children} depth={depth + 1} />
      </div>
    </details>
  ));
}

export function ProfilerPanel({ kind, context, ready, snapshot }) {
  const [duration, setDuration] = useState(10),
    [target, setTarget] = useState("client"),
    [clock, setClock] = useState("WALL"),
    [depth, setDepth] = useState(8),
    [gc, setGc] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [filter, setFilter] = useState(""),
    [sort, setSort] = useState("total"),
    [chosen, setChosen] = useState("");
  const candidates = snapshot.profiles.filter((p) => p.kind === kind);
  const record =
    candidates.find((p) => p.id === chosen) ||
    candidates.filter((p) => p.sessionId === context.sessionId).at(-1) ||
    candidates.at(-1);
  const active =
    record && ["starting", "running", "collecting"].includes(record.status);
  const running = snapshot.profiles.some(
    (p) =>
      p.sessionId === context.sessionId &&
      ["starting", "running", "collecting"].includes(p.status),
  );
  async function perform(action) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const result = record?.result;
  const title = {
    python: "Python 函数耗时",
    memory: "Python 内存变化",
    native: "Native / Tracy 采样",
  }[kind];
  let rows = [];
  if (result) {
    rows = (
      kind === "python"
        ? result.functions
        : kind === "memory"
          ? result.allocations
          : result.zones
    ).filter((row) =>
      JSON.stringify(row).toLowerCase().includes(filter.toLowerCase()),
    );
    rows = [...rows].sort((a, b) =>
      kind === "python"
        ? sort === "self"
          ? b.selfTime - a.selfTime
          : sort === "calls"
            ? b.calls - a.calls
            : b.totalTime - a.totalTime
        : kind === "memory"
          ? Math.abs(b.sizeDiff) - Math.abs(a.sizeDiff)
          : sort === "self"
            ? b.selfNanoseconds - a.selfNanoseconds
            : sort === "calls"
              ? b.calls - a.calls
              : b.totalNanoseconds - a.totalNanoseconds,
    );
  }
  return (
    <>
      <section className="debug-card">
        <header>
          <h2>{title}</h2>
          <Button
            onClick={() =>
              api("debug.reports.folder").catch((e) => setError(e.message))
            }
          >
            打开报告目录
          </Button>
        </header>
        <div className="debug-form">
          <div className="profile-options">
            <Field label="采样时长（秒）">
              <input
                type="number"
                min="1"
                max="300"
                value={duration}
                disabled={running}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </Field>
            {kind === "python" && (
              <>
                <Field label="采样目标">
                  <Select
                    value={target}
                    disabled={running}
                    options={[
                      { value: "client", label: "客户端" },
                      { value: "server", label: "服务端" },
                      { value: "all", label: "客户端与服务端" },
                    ]}
                    onChange={setTarget}
                  />
                </Field>
                <Field label="计时方式">
                  <Select
                    value={clock}
                    disabled={running}
                    options={[
                      { value: "WALL", label: "经过时间（WALL）" },
                      { value: "CPU", label: "CPU 时间" },
                    ]}
                    onChange={setClock}
                  />
                </Field>
              </>
            )}
            {kind === "memory" && (
              <>
                <Field label="调用栈深度">
                  <input
                    type="number"
                    min="1"
                    max="16"
                    value={depth}
                    disabled={running}
                    onChange={(e) => setDepth(Number(e.target.value))}
                  />
                </Field>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={gc}
                    onChange={(e) => setGc(e.target.checked)}
                  />
                  手动结束前执行 GC
                </label>
              </>
            )}
          </div>
          <p className="muted">
            {kind === "python"
              ? "基于 Yappi，采样期间请操作需要分析的功能。仅汇总项目脚本，统计单位为毫秒。"
              : kind === "memory"
                ? "比较采样前后的 tracemalloc 快照，客户端和服务端共享进程内存；正数表示净增长。"
                : "自动匹配所选游戏 PID 的 Tracy 端口。采样消耗额外资源，游戏需支持 Tracy 0.11.1；原始数据可导出为 .tracy。"}
          </p>
          <div className="toolbar">
            <Button
              primary
              disabled={!ready || busy || running}
              onClick={() =>
                perform(async () => {
                  setChosen("");
                  await api("debug.profile.start", {
                    ...context,
                    kind,
                    duration,
                    target,
                    clock,
                    depth,
                  });
                })
              }
            >
              开始采样
            </Button>
            <Button
              disabled={!active || busy || record?.status !== "running"}
              onClick={() =>
                perform(() =>
                  api("debug.profile.stop", {
                    id: record.id,
                    collectGarbage: gc,
                  }),
                )
              }
            >
              停止并生成报告
            </Button>
            <Button
              danger
              disabled={!active || busy}
              onClick={() =>
                perform(() => api("debug.profile.cancel", { id: record.id }))
              }
            >
              取消采样
            </Button>
            <span role="status">
              {record
                ? {
                    starting: "准备采样…",
                    running: "正在采样，到时自动生成报告",
                    collecting: "正在生成报告…",
                    complete: "报告已生成",
                    failed: "采样失败",
                    cancelled: "已取消",
                  }[record.status]
                : "尚未采样"}
            </span>
          </div>
          <ErrorBox>{error || record?.error}</ErrorBox>
        </div>
      </section>
      {candidates.length > 1 && (
        <Field label="本次打开期间的报告">
          <Select
            value={record?.id || ""}
            options={candidates.map((p) => ({
              value: p.id,
              label: `${new Date(p.startedAt).toLocaleTimeString()} · ${p.target} · ${p.status}`,
            }))}
            onChange={setChosen}
          />
        </Field>
      )}
      {result ? (
        <section className="debug-card profile-report">
          <header>
            <h2>采样结果</h2>
            <div className="toolbar">
              <Button
                onClick={() =>
                  perform(() =>
                    api("debug.export", { id: record.id, kind: "json" }),
                  )
                }
              >
                导出 JSON
              </Button>
              {kind === "native" && (
                <Button
                  onClick={() =>
                    perform(() =>
                      api("debug.export", { id: record.id, kind: "trace" }),
                    )
                  }
                >
                  导出 Tracy
                </Button>
              )}
            </div>
          </header>
          <div className="debug-form">
            <p>
              {kind === "memory"
                ? `净增长 ${size(result.netSizeDiff)} · 分配次数变化 ${result.netCountDiff}`
                : `采样 ${(result.elapsedSeconds ?? result.capturedSeconds).toFixed(2)} 秒`}{" "}
              ·{" "}
              {result.truncated ? "结果已截取，更多数据见原始报告" : "统计完成"}
            </p>
            <div className="toolbar">
              <input
                aria-label="搜索采样结果"
                placeholder="按函数或文件筛选"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {kind !== "memory" && (
                <Select
                  aria-label="采样结果排序"
                  value={sort}
                  options={[
                    { value: "total", label: "总耗时" },
                    { value: "self", label: "自身耗时" },
                    { value: "calls", label: "调用次数" },
                  ]}
                  onChange={setSort}
                />
              )}
            </div>
            {kind !== "memory" && (
              <div className="profile-bars">
                {rows.slice(0, 10).map((row, i) => {
                  const time =
                    kind === "python"
                      ? row.totalTime
                      : row.totalNanoseconds / 1e9;
                  const largest =
                    rows.reduce(
                      (max, r) =>
                        Math.max(
                          max,
                          kind === "python"
                            ? r.totalTime
                            : r.totalNanoseconds / 1e9,
                        ),
                      0,
                    ) || 1;
                  return (
                    <div key={i} title={row.name}>
                      <span>{row.name}</span>
                      <div>
                        <i style={{ width: `${(time / largest) * 100}%` }} />
                      </div>
                      <strong>{ms(time)} ms</strong>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="profile-table-scroll">
              <table className="profile-table">
                <thead>
                  <tr>
                    {(kind === "memory"
                      ? ["分配位置 / 调用栈", "净增长", "次数变化", "当前内存"]
                      : ["函数 / 文件", "调用次数", "总耗时 ms", "自身 ms"]
                    ).map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {kind === "memory" ? (
                          <details>
                            <summary>
                              {row.traceback[0]?.file}:{row.traceback[0]?.line}
                            </summary>
                            {row.traceback.map((frame, i) => (
                              <p key={i}>
                                {frame.file}:{frame.line}
                              </p>
                            ))}
                          </details>
                        ) : (
                          <>
                            <strong>{row.name}</strong>
                            <small>
                              {row.module || row.sourceFile}:
                              {row.line || row.sourceLine}{" "}
                              {row.target || row.threadName}
                            </small>
                            {kind === "python" && (
                              <details>
                                <summary>调用关系</summary>
                                {result.calls
                                  .filter(
                                    (edge) =>
                                      edge.callerId === row.id ||
                                      edge.calleeId === row.id,
                                  )
                                  .map((edge, i) => (
                                    <p key={i}>
                                      {
                                        result.functions.find(
                                          (f) => f.id === edge.callerId,
                                        )?.name
                                      }{" "}
                                      →{" "}
                                      {
                                        result.functions.find(
                                          (f) => f.id === edge.calleeId,
                                        )?.name
                                      }{" "}
                                      · {edge.calls} 次
                                    </p>
                                  ))}
                              </details>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        {kind === "memory" ? size(row.sizeDiff) : row.calls}
                      </td>
                      <td>
                        {kind === "memory"
                          ? row.countDiff
                          : kind === "python"
                            ? ms(row.totalTime)
                            : (row.totalNanoseconds / 1e6).toFixed(3)}
                      </td>
                      <td>
                        {kind === "memory"
                          ? size(row.currentSize)
                          : kind === "python"
                            ? ms(row.selfTime)
                            : (row.selfNanoseconds / 1e6).toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && (
              <p className="muted">
                本次未捕获匹配的项目脚本或采样区域；可增加时长，并在采样时操作目标功能。
              </p>
            )}
            {kind === "native" && (
              <div className="native-call-tree">
                <h3>线程调用树</h3>
                {result.threads.map((thread) => (
                  <details key={thread.id}>
                    <summary>
                      {thread.name || thread.id} · {thread.calls} 次
                    </summary>
                    <CallNodes nodes={thread.roots} />
                  </details>
                ))}
                {result.callTreeTruncated && (
                  <p className="muted">
                    调用树已截取，完整数据见 .tracy 文件。
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
      ) : (
        <Empty title="等待采样报告">
          开始采样后，在游戏中重现需要分析的操作。
        </Empty>
      )}
    </>
  );
}
