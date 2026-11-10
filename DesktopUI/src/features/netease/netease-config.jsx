import React, { useEffect, useState } from "react";
import { Button, Empty, ErrorBox, Intro, Select } from "../../app/ui.jsx";
import { useWorkspaceState } from "../../app/workspaces.jsx";

const api = (method, args) => window.toolkit.call(method, args);
const sizeText = (size) => (size < 1024 ? size + " B" : (size / 1024).toFixed(1) + " KB");

export function NeteaseConfigPage() {
  const [channel, setChannel] = useWorkspaceState("netease-channel", "测试端");
  const [player, setPlayer] = useWorkspaceState("netease-player", "");
  const [data, setData] = useState({ players: [], entries: [], root: "", missing: false, player: "" });
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);
  async function load(nextChannel = channel, nextPlayer = player) {
    setBusy(true);
    setError("");
    try {
      const value = await api("netease-config.list", { channel: nextChannel, player: nextPlayer });
      setData(value);
      if (value.player !== nextPlayer) setPlayer(value.player);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  const entries = (data.entries || []).filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  async function open(item, reveal) {
    try {
      await api("netease-config.open", { path: item.path, reveal });
    } catch (e) {
      setError(e.message);
    }
  }
  async function beginEdit(item) {
    setBusy(true);
    setError("");
    try {
      const value = await api("netease-config.read", { path: item.path });
      setEdit({ path: item.path, name: item.name, text: value.text, saved: value.text, modified: value.modified });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function saveEdit() {
    setBusy(true);
    setError("");
    try {
      const value = await api("netease-config.save", { path: edit.path, text: edit.text, modified: edit.modified });
      setEdit((old) => ({ ...old, saved: old.text, modified: value.modified }));
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <Intro heading title="网易全局配置" subtitle="按客户端身份查看换世界仍然保留的配置文件。可以在页面里修改；保存前会在同目录留下同名 .bak。游戏正在运行时，可能随后覆盖这次保存。">
        <Button icon="refresh" disabled={busy} onClick={() => load()}>刷新</Button>
      </Intro>
      <div className="toolbar">
        <Select
          aria-label="游戏端"
          value={channel}
          onChange={(value) => {
            setChannel(value);
            setPlayer("");
            setEdit(null);
            load(value, "");
          }}
          options={["测试端", "正式端"].map((value) => ({ value, label: value }))}
        />
        <Select
          aria-label="身份"
          value={data.player || ""}
          onChange={(value) => {
            setPlayer(value);
            setEdit(null);
            load(channel, value);
          }}
          options={[
            { value: "", label: "选择身份" },
            ...data.players.map((value) => ({
              value,
              label: value.toLowerCase() === "config" ? "config（直接配置目录）" : value,
            })),
          ]}
        />
        <input aria-label="搜索配置文件" placeholder="搜索文件名…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <ErrorBox>{error}</ErrorBox>
      {data.root && <p className="muted break-all">{data.root}</p>}
      {edit && (
        <section className="section" aria-label={"编辑 " + edit.name}>
          <h2>{edit.name}</h2>
          <textarea aria-label={"配置内容 " + edit.name} rows={16} value={edit.text} onChange={(e) => setEdit((old) => ({ ...old, text: e.target.value }))} />
          <div className="world-card-actions">
            <Button primary disabled={busy || edit.text === edit.saved} onClick={saveEdit}>保存</Button>
            <Button disabled={busy} onClick={() => setEdit(null)}>关闭</Button>
            {edit.text !== edit.saved && <span className="muted">有未保存的修改</span>}
          </div>
        </section>
      )}
      {entries.length ? (
        <div className="world-grid">
          {entries.map((item) => (
            <article className="world-card" key={item.path}>
              <div className="world-card-content">
                <h3>{item.name}</h3>
                <p>{new Date(item.modified).toLocaleString()} · {sizeText(item.size)}</p>
                <div className="world-card-actions">
                  <Button disabled={busy} onClick={() => beginEdit(item)}>编辑</Button>
                  <Button onClick={() => open(item, false)}>打开</Button>
                  <Button icon="folder" onClick={() => open(item, true)}>定位</Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty title={busy ? "正在读取…" : data.missing ? "未找到这个客户端的配置目录" : "暂无配置文件"}>
          {data.missing ? "安装并启动对应的网易客户端后，再刷新。" : "选择游戏端和身份后，配置文件会显示在这里。"}
        </Empty>
      )}
    </div>
  );
}
