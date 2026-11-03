import React, { useEffect, useMemo, useState } from "react";
import { Button, Empty, Intro, Select } from "../../app/ui.jsx";
import "./activity-page.css";

const api = (method, args = {}) => window.toolkit.call(method, args);
const levelLabels = { info: "信息", warning: "警告", error: "错误" };
const statusLabels = { running: "进行中", success: "已完成", failed: "失败", cancelled: "已取消" };

export function ActivityPage({ projects = [] }) {
  const [state, setState] = useState({ tasks: [], events: [] });
  const [projectId, setProjectId] = useState("");
  const [level, setLevel] = useState("all");
  const [error, setError] = useState("");
  const refresh = () => api("activity.snapshot", { projectId, level }).then(setState).catch(e => setError(e.message));
  useEffect(() => {
    refresh();
    const off = window.toolkit.onActivity(value => setState(value));
    return off;
  }, [projectId, level]);
  const tasks = useMemo(() => state.tasks || [], [state.tasks]);
  const active = tasks.filter(task => task.status === "running");
  return <div className="activity-page">
    <Intro title="项目日志" subtitle="查看工具箱操作、任务进度、警告和错误。游戏原始输出仍在“运行日志”中。">
      <Button onClick={refresh}>刷新</Button>
      <Button onClick={() => api("activity.clear").then(setState).catch(e => setError(e.message))}>清理已结束</Button>
    </Intro>
    <div className="activity-toolbar">
      <Select aria-label="项目筛选" value={projectId} onChange={setProjectId} options={[{ value: "", label: "全部项目" }, ...projects.map(p => ({ value: p.id, label: p.name }))]} />
      <Select aria-label="级别筛选" value={level} onChange={setLevel} options={[{ value: "all", label: "全部级别" }, { value: "info", label: "信息" }, { value: "warning", label: "警告" }, { value: "error", label: "错误" }]} />
      <span className="activity-summary">{active.length ? `${active.length} 个任务进行中` : "暂无进行中的任务"}</span>
    </div>
    {error && <p className="activity-error">{error}</p>}
    <section className="activity-tasks" aria-label="进行中的任务">
      <header><div><span className="activity-eyebrow">TASK CENTER</span><h2>任务进度</h2></div><span>{tasks.length} 条记录</span></header>
      {tasks.length ? <div className="activity-task-grid">{tasks.map(task => <article className={`activity-task ${task.status}`} key={task.id}>
        <div className="activity-task-head"><strong>{task.title}</strong><span>{statusLabels[task.status] || task.status}</span></div>
        <p>{task.message}</p>
        {task.total ? <progress max={task.total} value={Math.min(task.total, task.completed || 0)} /> : <div className="activity-indeterminate" />}
        <small>{task.projectId ? projects.find(p => p.id === task.projectId)?.name || task.projectId : "工具箱"} · {new Date(task.startedAt).toLocaleString()}</small>
      </article>)}</div> : <Empty title="还没有项目任务">导入、删除、调试和联机操作会在这里留下记录。</Empty>}
    </section>
    <section className="activity-events" aria-label="项目事件">
      <header><div><span className="activity-eyebrow">EVENT STREAM</span><h2>事件时间线</h2></div><span>最近 {state.events?.length || 0} 条</span></header>
      {state.events?.length ? <div className="activity-event-list">{state.events.map(event => <div className={`activity-event ${event.level}`} key={event.id}><span className="activity-event-dot" /><div><div className="activity-event-line"><strong>{event.message}</strong><small>{levelLabels[event.level] || event.level} · {new Date(event.time).toLocaleString()}</small></div><small>{event.projectId ? projects.find(p => p.id === event.projectId)?.name || event.projectId : "工具箱"}{event.source ? ` · ${event.source}` : ""}</small></div></div>)}</div> : <p className="activity-empty">暂无事件。</p>}
    </section>
  </div>;
}
