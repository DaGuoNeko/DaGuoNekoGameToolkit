import React, { useEffect, useMemo, useState } from "react";
import { Button, Intro, Select } from "../../app/ui.jsx";
import "./activity-page.css";
import { useWorkspaceState } from "../../app/workspaces.jsx";

const api = (method, args = {}) => window.toolkit.call(method, args);
const levelLabels = { info: "信息", warning: "警告", error: "错误" };
const statusLabels = { queued: "排队中", running: "进行中", success: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
const levelClass = (level) => `activity-log-${level || "info"}`;
const filterState = (value, projectId, level) => ({
  ...value,
  tasks: (value.tasks || []).filter((task) => !projectId || task.projectId === projectId),
  events: (value.events || []).filter((event) => level === "all" || event.level === level),
});
const formatTime = (value) => String(value || "").replace("T", " ").replace(/\.\d{3}Z$/, "Z");

export function ActivityPage({ projects = [] }) {
  const [state, setState] = useState({ tasks: [], events: [] });
  const [projectId, setProjectId] = useWorkspaceState("activity-project", "");
  const [level, setLevel] = useWorkspaceState("activity-level", "all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = () => api("activity.snapshot", { projectId, level }).then((value) => setState(filterState(value, projectId, level))).catch(e => setError(e.message));
  useEffect(() => {
    refresh();
    const off = window.toolkit.onActivity(value => setState(filterState(value, projectId, level)));
    return off;
  }, [projectId, level]);
  const tasks = useMemo(() => state.tasks || [], [state.tasks]);
  const active = tasks.filter(task => ["queued", "running"].includes(task.status));
  const attention = tasks.filter(task => ["failed", "interrupted"].includes(task.status));
  const finished = tasks.filter(task => ["success", "cancelled"].includes(task.status));
  const cards = rows => <div className="activity-task-grid">{rows.map(task => <article className={`activity-task ${task.status}`} key={task.id}>
    <div className="activity-task-head"><strong>{task.title}</strong><span>{statusLabels[task.status] || task.status}</span></div>
    <p>{task.message}</p>
    {Number.isFinite(task.total) && task.total > 0 ? <progress max={task.total} value={Math.min(task.total, Math.max(0, task.completed || 0))} aria-label={`${statusLabels[task.status] || task.status}进度`} /> : task.status === "running" ? <div className="activity-indeterminate" aria-label="进行中" /> : <div className="activity-progress-static" aria-label="无可量化进度" />}
    <small>{task.projectId ? projects.find(p => p.id === task.projectId)?.name || task.projectId : "工具箱"} · {new Date(task.startedAt).toLocaleString()}</small>
  </article>)}</div>;
  const exportLog = () => api("activity.export", { projectId, level }).then(() => { setError(""); setNotice("项目日志已导出"); }).catch(e => setError(e.message));
  return <div className="activity-page">
    <Intro title="任务与记录" subtitle="查看工具箱操作、任务进度、警告和错误。游戏原始输出在运行与调试的“运行日志”中。">
      <Button onClick={refresh}>刷新</Button>
      <Button onClick={exportLog}>导出项目日志</Button>
      <Button onClick={() => api("activity.clear").then((value) => setState(filterState(value, projectId, level))).catch(e => setError(e.message))}>清理已结束</Button>
    </Intro>
    {state.error && <p className="activity-error">{state.error}</p>}
    {notice && <p className="activity-notice" role="status">{notice}</p>}
    <div className="activity-toolbar">
      <Select aria-label="启动配置筛选" value={projectId} onChange={setProjectId} options={[{ value: "", label: "全部范围（含工具箱）" }, ...projects.map(p => ({ value: p.id, label: p.name }))]} />
      <Select aria-label="级别筛选" value={level} onChange={setLevel} options={[{ value: "all", label: "全部级别" }, { value: "info", label: "信息" }, { value: "warning", label: "警告" }, { value: "error", label: "错误" }]} />
      <span className="activity-summary">{active.length ? `${active.length} 个任务进行中` : "暂无进行中的任务"}</span>
    </div>
    {error && <p className="activity-error">{error}</p>}
    <section className="activity-tasks" aria-label="进行中的任务">
      <header><div><span className="activity-eyebrow">TASK CENTER</span><h2>进行中的任务</h2></div><span>{active.length} 项</span></header>
      {active.length ? cards(active) : <p className="activity-empty">当前没有进行中的任务。</p>}
    </section>
    {!!attention.length && <section className="activity-tasks" aria-label="失败与中断"><header><h2>失败与中断</h2><span>{attention.length} 项</span></header><p className="muted">先查看原因和实际结果，再决定是否回到原操作处理；不会自动重试。</p>{cards(attention)}</section>}
    <details className="activity-tasks activity-history"><summary>已完成与取消（{finished.length}）</summary>{finished.length ? cards(finished) : <p className="activity-empty">暂无已完成记录。</p>}</details>
    <section className="activity-events" aria-label="后台日志">
      <header><div><span className="activity-eyebrow">BACKGROUND LOG</span><h2>后台日志</h2></div><span>最近 {state.events?.length || 0} 条</span></header>
      {state.events?.length ? <div className="activity-log">{state.events.map(event => <div className="activity-log-line" key={event.id}><span className="activity-log-time">{formatTime(event.time)}</span><span className={levelClass(event.level)}>{(levelLabels[event.level] || event.level).toUpperCase()}</span><span className="activity-log-source">[{event.source || "system"}]</span><strong className="activity-log-method">{event.method}</strong><span className="activity-log-message">{event.message}{event.repeatCount > 1 ? `（重复 ${event.repeatCount} 次）` : ""}</span>{event.projectId && <small>{projects.find(p => p.id === event.projectId)?.name || event.projectId}</small>}</div>)}</div> : <p className="activity-empty">暂无后台日志。</p>}
    </section>
  </div>;
}
