import React, { useEffect, useState } from "react";
import { Button, ErrorBox, Modal, Select } from "../../app/ui.jsx";
const call = (name, args) => window.toolkit.call(name, args);
const display = value => JSON.stringify(value, null, 2) ?? "未记录";
const sameVersion = (text, parts) => text === "" && !parts || Array.isArray(parts) && text.split(".").map(Number).concat([0, 0, 0, 0, 0]).slice(0, 5).join(".") === parts.concat([0, 0, 0, 0, 0]).slice(0, 5).join(".");
// 未保存内容不参与浏览缓存淘汰，只在保存、还原为原值或明确放弃后释放。
const drafts = new Map();
function useDraft(key, initial) {
  const [value, setValue] = useState(() => drafts.has(key) ? drafts.get(key) : initial);
  useEffect(() => { if (value === initial || value === null) drafts.delete(key); }, [key, value, initial]);
  return [value, next => { if (next === null || next === initial) drafts.delete(key); else drafts.set(key, next); setValue(next); }];
}
function Preview({ plan }) {
  return <div className="data-write-preview"><p>确认后写回当前存档，修改前的原始记录会保存在工具箱数据目录。保存期间请保持游戏关闭。</p>{plan.changes.map((change, i) => <section key={i}><h4>{change.field}</h4><div className="data-write-columns"><div><small>修改前</small><pre>{display(change.before)}</pre></div><div><small>修改后</small><pre>{display(change.after)}</pre></div></div></section>)}</div>;
}
export function EditFieldDialog({ requestId, source, object, field, onClose, onSaved, onRefresh }) {
  const dirtyKey = "field:" + source + ":" + object.id + field;
  const [current, setCurrent] = useState(null);
  const [draft, setDraft] = useDraft("world-field-draft:" + source + ":" + object.id + field, current ? typeof current.value === "string" ? current.value : display(current.value) : null);
  const [plan, setPlan] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let alive = true; setCurrent(null); setPlan(null);
    call("world-data.edit.read", { requestId, id: object.id, field }).then(value => { if (alive) { setCurrent(value); if (draft === null) setDraft(typeof value.value === "string" ? value.value : display(value.value)); } }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [requestId, object.id, field]);
  useEffect(() => { if (current) call("world-data.dirty", { key: dirtyKey, dirty: draft !== null && draft !== (typeof current.value === "string" ? current.value : display(current.value)) }).catch(() => {}); }, [current, draft, dirtyKey]);
  const discard = () => { setDraft(null); call("world-data.dirty", { key: dirtyKey, dirty: false }).catch(() => {}); onClose(); };
  const preview = async () => {
    setBusy(true); setError("");
    try {
      const value = typeof current.value === "string" ? draft : JSON.parse(draft);
      setPlan(await call("world-data.edit.prepare", { requestId, id: object.id, changes: [{ field, value }] }));
    } catch (error) { setError(error.message); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError("");
    try { const result = await call("world-data.edit.apply", { requestId, token: plan.token, confirmed: true }); setDraft(null); await call("world-data.dirty", { key: dirtyKey, dirty: false }); onSaved(result); }
    catch (error) { setError(error.message + "；草稿已保留，可重新扫描后再次预览。"); setPlan(null); }
    finally { setBusy(false); }
  };
  return <Modal title={plan ? "确认字段变更" : "编辑已保存字段"} description={object.name + " · " + (field || "业务对象内容")} wide busy={busy} onClose={onClose} footer={<><Button disabled={busy} onClick={onClose}>关闭并保留草稿</Button>{plan ? <><Button disabled={busy} onClick={() => setPlan(null)}>继续编辑</Button><Button primary disabled={busy} onClick={save}>{busy ? "正在备份保存…" : "备份并保存"}</Button></> : <><Button disabled={busy} onClick={discard}>放弃草稿</Button><Button primary disabled={busy || !current || draft === null} onClick={preview}>预览变更</Button></>}</>}>
    <ErrorBox>{error}</ErrorBox>{error && <Button disabled={busy} onClick={onRefresh}>重新扫描并保留草稿</Button>}{plan ? <Preview plan={plan} /> : current ? <><p className="data-hint">{current.type} · 保留原始存储类型与未修改字段。复杂内容使用 JSON；大整数保留字符串表示。</p>{typeof current.value === "boolean" ? <Select aria-label="字段值" value={draft} onChange={setDraft} options={[{ value: "true", label: "true" }, { value: "false", label: "false" }]} /> : <textarea className="data-edit-input" aria-label="字段值" value={draft ?? ""} onChange={event => { setDraft(event.target.value); setPlan(null); }} spellCheck={false} />}</> : <p role="status">正在读取原始字段…</p>}
  </Modal>;
}
export function ConfirmWrite({ requestId, plan, onClose, onSaved }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try {
      const result = await call("world-data.edit.apply", { requestId, token: plan.token, confirmed: true });
      for (const change of plan.changes) for (const key of ({ "工具箱允许启动版本": ["min", "max"], "/MinimumCompatibleClientVersion": ["compatible"], "/lastOpenedWithVersion": ["opened"] }[change.field] || [])) drafts.delete("world-versions:" + plan.source + ":" + key);
      onSaved(result);
    }
    catch (error) { setError(error.message + "；请关闭预览并重新扫描。"); }
    finally { setBusy(false); }
  };
  return <Modal title="确认版本设置变更" wide busy={busy} onClose={onClose} footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button primary disabled={busy || !!error} onClick={save}>{busy ? "正在备份保存…" : "备份并保存"}</Button></>}><ErrorBox>{error}</ErrorBox><Preview plan={plan} /></Modal>;
}
export function VersionSettings({ data, onPreview }) {
  const markers = Object.fromEntries(Object.entries(data.versionMarkers || {}).filter(([key, value]) => ["MinimumCompatibleClientVersion", "lastOpenedWithVersion"].includes(key) ? Array.isArray(value) && value.every(Number.isInteger) : ["string", "number"].includes(typeof value))), prefix = "world-versions:" + data.source;
  const [minimum, setMinimum] = useDraft(prefix + ":min", data.versionPolicy?.minimum || ""), [maximum, setMaximum] = useDraft(prefix + ":max", data.versionPolicy?.maximum || "");
  const [compatible, setCompatible] = useDraft(prefix + ":compatible", markers.MinimumCompatibleClientVersion?.join(".") || ""), [opened, setOpened] = useDraft(prefix + ":opened", markers.lastOpenedWithVersion?.join(".") || "");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const dirty = minimum !== data.versionPolicy?.minimum || maximum !== data.versionPolicy?.maximum || !sameVersion(compatible, markers.MinimumCompatibleClientVersion) || !sameVersion(opened, markers.lastOpenedWithVersion);
  useEffect(() => { call("world-data.dirty", { key: prefix, dirty }).catch(() => {}); }, [dirty, prefix]);
  const versionValue = text => {
    if (!/^\d+(?:\.\d+){2,4}$/.test(text)) throw Error("存档版本请输入 3–5 个数字分量，如 1.20.0");
    const values = text.split(".").map(Number); while (values.length < 5) values.push(0); return values;
  };
  const prepare = async policy => {
    setBusy(true); setError("");
    try {
      if (policy) onPreview(await call("world-data.policy.prepare", { requestId: data.requestId, value: { schema: 1, minimum: minimum.trim(), maximum: maximum.trim() } }));
      else {
        const changes = [];
        for (const [field, text] of [["MinimumCompatibleClientVersion", compatible], ["lastOpenedWithVersion", opened]]) if (text && text !== markers[field]?.join(".")) changes.push({ field: "/" + field, value: versionValue(text) });
        if (!changes.length) throw Error("没有待保存的兼容标记变更");
        onPreview(await call("world-data.edit.prepare", { requestId: data.requestId, id: "level.dat:0", changes }));
      }
    } catch (error) { setError(error.message); } finally { setBusy(false); }
  };
  const discard = () => { setMinimum(data.versionPolicy?.minimum || ""); setMaximum(data.versionPolicy?.maximum || ""); setCompatible(markers.MinimumCompatibleClientVersion?.join(".") || ""); setOpened(markers.lastOpenedWithVersion?.join(".") || ""); };
  return <fieldset className="data-version-settings" aria-label="版本设置" disabled={!data.editable || busy}><ErrorBox>{error}</ErrorBox>{dirty && <div className="data-backup-notice"><span>有未保存的版本草稿</span><Button onClick={discard}>放弃版本草稿</Button></div>}<section><header><h3>允许启动的游戏版本</h3><span className="data-badge">工具箱限制</span></header><p>设置最低与最高版本，防止误用其他构建打开存档。留空表示不限；仅约束通过工具箱启动的主机。</p><div className="data-version-inputs"><label>最低启动版本<input aria-label="最低启动版本" value={minimum} onChange={e => setMinimum(e.target.value)} placeholder="如 3.10.0.420447" /></label><label>最高启动版本<input aria-label="最高启动版本" value={maximum} onChange={e => setMaximum(e.target.value)} placeholder="如 3.10.0.436581" /></label></div><p className="data-hint">填写客户端构建版本。设置范围后，工具箱无法可靠识别的构建也会被拒绝。</p><Button primary onClick={() => prepare(true)}>预览启动范围变更</Button></section>
    <section><header><h3>存档兼容版本标记</h3><span className="data-badge">level.dat</span></header><p>最低兼容版本与最后打开版本是存档声明。最后打开版本不是“最高允许版本”；调整它们不会转换新版区块、实体或实验性内容。</p><div className="data-version-inputs"><label>最低兼容客户端版本<input aria-label="最低兼容客户端版本" value={compatible} onChange={e => setCompatible(e.target.value)} placeholder="未记录，例如 1.18.0" /></label><label>最后打开版本<input aria-label="最后打开版本" value={opened} onChange={e => setOpened(e.target.value)} placeholder="未记录，例如 1.20.0" /></label></div><div className="data-version-facts"><span>基础游戏版本 <strong>{markers.baseGameVersion ?? "未记录"}</strong></span><span>存储格式 <strong>{markers.StorageVersion ?? "未记录"}</strong></span><span>网络协议 <strong>{markers.NetworkVersion ?? "未记录"}</strong></span></div><p className="data-hint">存档标记常使用 1.x 版本，与网易客户端的 3.x 构建号不同。降级前应保留完整存档副本；这里的备份用于恢复本次字段改动。</p><Button onClick={() => prepare(false)}>预览兼容标记变更</Button></section></fieldset>;
}
