import React, { useEffect, useState } from "react";
import { Button, Empty, ErrorBox, Field, Icon, Intro, Modal } from "../../app/ui.jsx";
import "./quick-launch.css";

const api = (method, args) => window.toolkit.call(method, args);
const blank = { name: "", note: "", path: "" };

export function QuickLaunchPage() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [removeId, setRemoveId] = useState(null);
  async function load() {
    try {
      setItems((await api("quick-launch.list")).items);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);
  async function pick() {
    try {
      const files = await api("files.pick", { kind: "executable" });
      const file = files?.[0];
      if (!file) return;
      setDraft((old) => ({
        ...old,
        path: file,
        name: old.name || file.split(/[\\/]/).pop().replace(/\.exe$/i, "").slice(0, 40),
      }));
    } catch (e) {
      setError(e.message);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      setItems((await api("quick-launch.save", draft)).items);
      setDraft(null);
      setNotice("已保存");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function run(item) {
    setBusy(true);
    setError("");
    try {
      await api("quick-launch.launch", { id: item.id });
      setNotice("已启动 " + item.name);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      setItems((await api("quick-launch.remove", { id: removeId })).items);
      setRemoveId(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const removing = items.find((item) => item.id === removeId);
  return (
    <div className="quick-launch">
      <Intro heading title="快捷程序" subtitle="把常用程序绑在这里。每条可以写名称和备注，点运行就会直接打开对应的 exe。">
        <Button primary icon="plus" disabled={busy} onClick={() => setDraft({ ...blank })}>添加程序</Button>
      </Intro>
      <ErrorBox>{error}</ErrorBox>
      {notice && <p className="muted" role="status">{notice}</p>}
      {items.length ? (
        <div className="world-grid">
          {items.map((item) => (
            <article className="world-card quick-launch-card" key={item.id} aria-label={"程序 " + item.name}>
              <div className="world-cover">
                <Icon name="tools" size={34} />
                <span>可运行</span>
              </div>
              <div className="world-card-content">
                <h3>{item.name}</h3>
                <p className="quick-launch-note">{item.note || "没有备注"}</p>
                <small className="break-all" title={item.path}>{item.path}</small>
                <div className="world-card-actions">
                  <Button primary icon="external" disabled={busy} onClick={() => run(item)}>运行</Button>
                  <Button icon="edit" compact disabled={busy} onClick={() => setDraft(item)}>编辑</Button>
                  <Button icon="trash" compact danger disabled={busy} onClick={() => setRemoveId(item.id)}>删除</Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty title="还没有绑定程序" icon="tools">添加一个 exe 后，就可以从这张卡片直接运行。</Empty>
      )}
      {draft && (
        <Modal
          title={draft.id ? "编辑程序" : "添加程序"}
          description="选择本机的 exe，并给它一个好认的名称。"
          onClose={() => !busy && setDraft(null)}
          busy={busy}
          footer={
            <>
              <Button disabled={busy} onClick={() => setDraft(null)}>取消</Button>
              <Button primary disabled={busy} onClick={save}>保存</Button>
            </>
          }
        >
          <Field label="名称">
            <input value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="备注">
            <input value={draft.note} maxLength={120} placeholder="可选，例如：看日志、打包资源" onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </Field>
          <Field label="程序">
            <div className="quick-launch-path">
              <input readOnly value={draft.path} placeholder="尚未选择 exe" />
              <Button icon="folder" disabled={busy} onClick={pick}>选择</Button>
            </div>
          </Field>
        </Modal>
      )}
      {removing && (
        <Modal
          title={"删除 " + removing.name + "？"}
          description="只从列表移除，不会删除程序文件。"
          onClose={() => !busy && setRemoveId(null)}
          busy={busy}
          footer={
            <>
              <Button disabled={busy} onClick={() => setRemoveId(null)}>取消</Button>
              <Button danger disabled={busy} onClick={remove}>删除</Button>
            </>
          }
        />
      )}
    </div>
  );
}
