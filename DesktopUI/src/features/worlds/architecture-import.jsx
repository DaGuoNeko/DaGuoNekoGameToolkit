import React, { useEffect, useState } from "react";
import { Button, Field, Modal, Select, ErrorBox, Icon } from "../../app/ui.jsx";
import "./architecture-import.css";

const call = (name, args = {}) => window.toolkit.call("architecture." + name, args);
const labels = { preparing: "准备来源副本", prepared: "来源已准备", "source-starting": "启动来源世界", "source-running": "等待选择区域", copying: "正在读取地形", "source-ready": "选区读取完成", "source-stopping": "保存并退出来源", "source-saved": "准备进入目标", "backing-up": "备份目标存档", "target-running": "等待检查目标", previewing: "正在比较目标区域", "preview-ready": "等待确认导入", pasting: "正在写入并核对", done: "导入完成", undoing: "正在撤销", undone: "撤销完成", interrupted: "任务已停止" };
const defaults = { x1: 0, y1: 64, z1: 0, x2: 15, y2: 95, z2: 15, targetX: 0, targetY: 64, targetZ: 0 };
const number = value => value === "" ? NaN : Number(value);
const fmt = value => Number(value || 0).toLocaleString("zh-CN");

export function ArchitectureImport({ worldId, onClose }) {
  const [task, setTask] = useState(null), [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState({ kind: "java", source: "", chunkerJar: "", name: "地形导入" });
  const [values, setValues] = useState(defaults), [policy, setPolicy] = useState("overwrite"), [includeAir, setIncludeAir] = useState(false);
  const [position, setPosition] = useState(null), [working, setWorking] = useState(false), [error, setError] = useState("");
  const [editing, setEditing] = useState(false), [confirm, setConfirm] = useState(null);
  useEffect(() => {
    let live = true, timer;
    async function refresh() {
      try {
        const state = await call("state");
        if (live) { setTask(state); setLoaded(true); }
      } catch (e) { if (live) { setError(e.message); setLoaded(true); } }
      if (live) timer = setTimeout(refresh, 1000);
    }
    refresh();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (!task || task.targetWorldId !== worldId) return;
    setDraft({ kind: task.kind, source: task.source, chunkerJar: task.chunkerJar, name: task.name });
    if (task.region) setValues(old => ({ ...old, x1: task.region.min[0], y1: task.region.min[1], z1: task.region.min[2], x2: task.region.max[0], y2: task.region.max[1], z2: task.region.max[2] }));
    if (task.plan) {
      const p = task.plan.options;
      setValues(old => ({ ...old, targetX: p.origin[0], targetY: p.origin[1], targetZ: p.origin[2] }));
      setPolicy(p.policy); setIncludeAir(p.includeAir);
    }
  }, [task?.id]);
  const own = task?.targetWorldId === worldId;
  const busy = working || !!task?.busy;
  const sourceStep = own && !!task.sourceWorldId;
  const targetStep = own && !!task.capture;
  const step = editing || !own ? 0 : task.plan?.manifest ? 3 : targetStep ? 2 : sourceStep ? 1 : 0;
  const run = async (name, args = {}) => {
    setWorking(true); setError("");
    try {
      const value = await call(name, { taskId: task?.id, ...args });
      if (value?.stage) setTask(value);
      return value;
    } catch (e) { setError(e.message); return null; }
    finally { setWorking(false); }
  };
  const pick = async (key, archive = false) => {
    setWorking(true); setError("");
    try {
      const value = key === "chunkerJar" ? await call("pick-chunker") : await window.toolkit.call("worlds.pick-import", { kind: archive ? "zip" : "folder" });
      if (value) setDraft(old => ({ ...old, [key]: value }));
    } catch (e) { setError(e.message); }
    finally { setWorking(false); }
  };
  const readPosition = async (which, corner) => {
    const value = await run("position", { which });
    if (!value?.position) return;
    setPosition(value);
    const keys = which === "source" ? ["x" + corner, "y" + corner, "z" + corner] : ["targetX", "targetY", "targetZ"];
    setValues(old => ({ ...old, ...Object.fromEntries(keys.map((k, i) => [k, value.position[i]])) }));
  };
  const coordinates = (keys, title) => <fieldset className="terrain-coordinates"><legend>{title}</legend>{keys.map((key, i) => <Field label={["X", "Y", "Z"][i]} key={key}><input aria-label={title + " " + ["X", "Y", "Z"][i]} type="number" step="1" value={values[key]} disabled={busy} onChange={e => setValues(old => ({ ...old, [key]: e.target.value }))} /></Field>)}</fieldset>;
  const params = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, number(v)]));
  const previewMatches = task?.plan && task.plan.options.origin.every((v, i) => v === params[["targetX", "targetY", "targetZ"][i]]) && task.plan.options.policy === policy && task.plan.options.includeAir === includeAir;
  const progress = task?.progress, percent = progress?.total ? Math.min(100, Math.floor(progress.completed / progress.total * 100)) : null;
  return <Modal wide title="地形与建筑导入" description="将来源世界的选区，迁移到当前存档的指定维度。" onClose={onClose} footer={<><span className="muted">关闭面板不会中断任务</span><Button onClick={onClose}>收起</Button></>}>
    <div className="terrain-import">
      <div className="terrain-hero"><div className="terrain-hero-icon"><Icon name="import" size={28} /></div><div><span className="terrain-eyebrow">WORLD TRANSFER</span><h3>把地形带到你想要的地方</h3><p>来源副本 · 写前备份 · 分批核对 · 可撤销</p></div></div>
      <ol className="terrain-steps">{["准备来源", "选择区域", "确认目标", "检查与导入"].map((label, i) => <li key={label} className={i === step ? "active" : i < step ? "complete" : ""} aria-current={i === step ? "step" : undefined}><span>{i < step ? <Icon name="check" size={14} /> : i + 1}</span>{label}</li>)}</ol>
      {task && !own && <p className="terrain-alert">当前有属于“{task.targetName}”的任务。请到该存档继续；只有任务结束且会话停止后才能建立新任务。</p>}
      {(!own || editing || !sourceStep) && <section className="terrain-card">
        <div className="terrain-heading"><h3>选择来源</h3><span className="terrain-tag">保留原地图</span></div>
        <Field label="来源类型"><Select disabled={busy} value={draft.kind} onChange={kind => setDraft(old => ({ ...old, kind, source: "" }))} options={[{ value: "java", label: "Java 世界 · 通过 Chunker 转换" }, { value: "bedrock", label: "基岩世界 · 文件夹 / MCWORLD / ZIP" }]} /></Field>
        <div className="terrain-file"><input aria-label="来源世界路径" readOnly value={draft.source} placeholder="选择包含 level.dat 的世界目录" /><Button disabled={busy} icon="folder" onClick={() => pick("source")}>选择文件夹</Button>{draft.kind === "bedrock" && <Button disabled={busy} onClick={() => pick("source", true)}>选择压缩包</Button>}</div>
        {draft.kind === "java" && <><div className="terrain-file"><input aria-label="Chunker JAR 路径" readOnly value={draft.chunkerJar} placeholder="首次使用：选择 Chunker CLI JAR" /><Button disabled={busy} onClick={() => pick("chunkerJar")}>选择 Chunker</Button><Button icon="external" onClick={() => window.toolkit.call("web.open", { kind: "chunker" }).catch(e => setError(e.message))}>官方获取</Button></div><p className="terrain-help">需要 Java 17+ 和 Chunker CLI。转换在工具箱副本中执行，输出为基岩 1.20.80；不转换 Java 模组及世界生成规则。</p></>}
        <Field label="任务名称"><input disabled={busy} value={draft.name} maxLength={60} onChange={e => setDraft(old => ({ ...old, name: e.target.value }))} /></Field>
        <Button primary disabled={!loaded || busy || !draft.source || (draft.kind === "java" && !draft.chunkerJar)} onClick={async () => { if (await run("prepare", { ...draft, targetWorldId: worldId })) setEditing(false); }}>准备来源副本</Button>
      </section>}
      {own && !editing && sourceStep && !targetStep && <section className="terrain-card">
        <div className="terrain-heading"><h3>圈定要搬运的区域</h3><span className="terrain-tag">包含两个角点</span></div>
        <p className="terrain-help">先启动来源副本并进入来源维度。支持负坐标；大地图请按开发区域分批迁移。</p>
        <div className="terrain-actions"><Button disabled={busy} onClick={() => run("start-source")}>启动来源世界</Button><Button disabled={busy || !task.sourceSessionId} onClick={() => readPosition("source", 1)}>玩家位置 → 角点一</Button><Button disabled={busy || !task.sourceSessionId} onClick={() => readPosition("source", 2)}>玩家位置 → 角点二</Button></div>
        {coordinates(["x1", "y1", "z1"], "角点一")}{coordinates(["x2", "y2", "z2"], "角点二")}
        <Button primary disabled={busy || !task.sourceSessionId} onClick={() => run("save-source", params)}>读取选区地形</Button>
      </section>}
      {own && !editing && targetStep && <section className="terrain-card">
        <div className="terrain-heading"><h3>目标位置与冲突处理</h3><span className="terrain-tag">{task.targetName}</span></div>
        <div className="terrain-selection"><Icon name="cube" size={22} /><div><strong>{task.region.size.join(" × ")} 格</strong><span>来源维度 {task.sourceDimension} · {fmt(task.region.volume)} 格 · 原点 {task.region.min.join(", ")}</span></div></div>
        {!task.targetSessionId && <div className="terrain-actions"><Button disabled={busy || !["source-ready", "interrupted"].includes(task.stage)} onClick={() => run("source-done")}>退出来源副本</Button><Button primary disabled={busy || !["source-saved", "interrupted"].includes(task.stage)} onClick={() => run("start-target")}>备份并启动目标存档</Button></div>}
        {task.targetSessionId && task.stage === "interrupted" && <Button disabled={busy} onClick={() => run("start-target")}>重新启动目标会话后检查或撤销</Button>}
        <p className="terrain-help">进入目标维度后读取位置。预览会固定维度；切换维度会停止写入，不会跟随玩家写到别处。</p>
        {coordinates(["targetX", "targetY", "targetZ"], "目标原点")}
        <Button disabled={busy || !task.targetSessionId} onClick={() => readPosition("target")}>读取当前玩家位置与维度</Button>
        <Field label="已有方块的处理"><Select disabled={busy} value={policy} onChange={setPolicy} options={[{ value: "overwrite", label: "覆盖 · 用来源替换目标方块" }, { value: "keep", label: "保留 · 只填充目标空气位置" }]} /></Field>
        <label className="terrain-check"><input type="checkbox" checked={includeAir} disabled={busy} onChange={e => setIncludeAir(e.target.checked)} /><span><strong>同时导入来源空气</strong><small>覆盖模式下会挖空目标对应位置，适合完整迁移洞穴和室内空间。</small></span></label>
        <Button primary disabled={busy || !task.targetSessionId || !!task.attempted} onClick={() => run("preview", { ...params, policy, includeAir })}>检查目标并生成预览</Button>
        {task.plan?.manifest && <div className="terrain-preview"><div className="terrain-heading"><strong>维度 {task.plan.dimension} · 导入预览</strong><span>{task.plan.options.origin.join(", ")}</span></div><div className="terrain-counts">{[["changed", "将修改"], ["kept", "保留目标"], ["air", "跳过空气"], ["identical", "已相同"]].map(([key, label]) => <div key={key}><strong>{fmt(task.plan.counts[key])}</strong><span>{label}</span></div>)}</div><p className="terrain-help">导入前已保存完整目标副本。写入时再次比较方块，预览后发生的编辑不会被直接覆盖。</p><Button primary disabled={busy || task.stage !== "preview-ready" || !previewMatches} onClick={() => setConfirm("paste")}>确认导入 {fmt(task.plan.counts.changed)} 格</Button>{!previewMatches && <p className="terrain-help">位置或策略已改变，请重新生成预览。</p>}</div>}
      </section>}
      {position?.dimension != null && <p className="terrain-location"><Icon name="gamepad" size={16} />当前读取：维度 {position.dimension} · {position.position.join(", ")} · 高度 {position.min[1]}～{position.max[1]}</p>}
      {own && <section className="terrain-status" role="status"><div className="terrain-heading"><strong>{labels[task.stage] || task.stage}</strong><span>{percent == null ? "" : percent + "%"}</span></div>{task.busy && <progress max="100" {...(percent != null ? { value: percent } : {})} aria-label="地形任务进度" />}{task.busy && <p>{task.stage === "preparing" ? task.message : `${fmt(progress?.completed)} / ${fmt(progress?.total)}`}</p>}<div className="terrain-actions">{task.busy && <Button onClick={() => run("stop")}>停止任务</Button>}<Button disabled={busy} onClick={() => run("folder")}>打开备份与任务目录</Button>{task.attempted > 0 && <Button disabled={busy} onClick={() => setConfirm("revoke")}>撤销本次导入</Button>}{!task.busy && (!task.attempted || task.stage === "done") && <Button onClick={() => setEditing(!editing)}>{editing ? "返回当前任务" : "新建导入任务"}</Button>}</div><ErrorBox>{task.error}</ErrorBox></section>}
      <p className="terrain-help">此功能迁移地形方块、状态和可读取的方块实体；不迁移动物、玩家、群系、结构生成规则或模组脚本。目标自定义维度及模组方块需由目标存档自身提供。</p>
      <ErrorBox>{error}</ErrorBox>
    </div>
    {confirm && <Modal title={confirm === "paste" ? "确认写入目标区域" : "确认撤销本次导入"} onClose={() => setConfirm(null)} footer={<><Button onClick={() => setConfirm(null)}>取消</Button><Button primary disabled={busy} onClick={async () => { const action = confirm; setConfirm(null); await run(action, { previewId: task.plan?.id, confirmed: true }); }}>{confirm === "paste" ? "开始导入" : "开始撤销"}</Button></>}><p>存档：{task.targetName} · 维度：{task.plan?.dimension}</p><p>{confirm === "paste" ? `将修改 ${fmt(task.plan?.counts.changed)} 格；目标存档备份与撤销记录会保留。` : "仅撤销本任务记录的方块；如果目标已被再次编辑，撤销会停止并保留备份，避免覆盖后续修改。"}</p></Modal>}
  </Modal>;
}
