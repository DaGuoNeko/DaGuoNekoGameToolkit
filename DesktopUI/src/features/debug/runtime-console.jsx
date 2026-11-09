import React, { useEffect, useState } from "react";
import { Button, Intro, Field, Modal, Empty, ErrorBox } from "../../app/ui.jsx";
import { LocalJoinDialog } from "../worlds/local-join.jsx";
import { ReloadActions } from "./debugger.jsx";
import { useDebugSession } from "./debug-session.jsx";
import { WorldDashboard } from "../worlds/world-actions.jsx";

export function RuntimeConsole({ state, busy, onBlank, onJoined, onStop, onWorlds, onOpenWorld }) {
  const { session: bridge, context, ready: debugReady } = useDebugSession();
  const session = state.session;
  const ready = debugReady && bridge?.registrationId === session?.bridgeRegistrationId && bridge?.mcdkPid === session?.pid;
  const [join, setJoin] = useState(false), [blank, setBlank] = useState(false), [name, setName] = useState("");
  const [world, setWorld] = useState(null), [profiles, setProfiles] = useState([]), [error, setError] = useState("");
  const randomName = () => "Player" + Array.from(crypto.getRandomValues(new Uint8Array(8)), n => String.fromCharCode(97 + n % 26)).join("");
  useEffect(() => {
    let live = true; setWorld(null); setError("");
    if (session?.worldId) Promise.all([window.toolkit.call("worlds.list"), window.toolkit.call("profiles.list")]).then(([list, values]) => { if (live) { setWorld(list.worlds.find(w => w.id === session.worldId)); setProfiles(values); } }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [session?.worldId]);
  return <div className="runtime-console">
    <Intro title="会话控制台" subtitle="选择目标后查看日志与调试；本机多人测试无需创建远程房间。">
      <Button primary disabled={busy} onClick={() => setJoin(true)}>启动联机客户端</Button>
      <Button disabled={busy} onClick={() => { setName(randomName()); setBlank(true); }}>启动空白客户端</Button>
      <Button onClick={onWorlds}>选择存档启动</Button>
    </Intro>
    {session ? <section className="section"><h2>{session.worldName || session.profileName || "客户端"}</h2>
      <p>{session.userName} · <span>{session.running ? "运行中" : "已结束"}</span> · {session.worldId ? "存档主机" : "客户端"}</p>
      <p className="muted">本次运行配置：{session.profileName || "默认"} · 游戏版本 {session.engineVersion || "未识别"}。修改模板只影响之后的启动。</p>
      {session.worldId && <Button onClick={() => onOpenWorld(session.worldId)}>打开关联存档</Button>}
      {session.running && <Button danger disabled={busy} onClick={() => onStop(session.id)}>停止会话</Button>}
      {!world && <ReloadActions context={context} ready={ready} />}
    </section> : <Empty title="选择一个运行会话">可以启动存档主机、空白客户端，或添加加入本机主机的测试玩家。</Empty>}
    <ErrorBox>{error}</ErrorBox>
    {world && <WorldDashboard key={session.id} mode="runtime" sessionId={session.id} world={world} profiles={profiles} runtimeState={state} busy={busy} onBack={onWorlds} onStart={onWorlds} onStop={onStop} onSettings={onWorlds} onLogs={() => {}} onPacks={onWorlds} onMapPreview={onWorlds} onQuickTest={onWorlds} onJoinClient={() => setJoin(true)} onSwitchWorld={onWorlds} />}
    {join && <LocalJoinDialog initialHostId={session?.worldId && session.running ? session.id : ""} onClose={() => setJoin(false)} onStart={async args => { await onJoined(args); setJoin(false); }} />}
    {blank && <Modal title="启动空白客户端" busy={busy} onClose={() => setBlank(false)} footer={<Button primary disabled={busy || !name.trim()} onClick={async () => { await onBlank(name); setBlank(false); }}>启动客户端</Button>}><Field label="玩家名字"><input value={name} onChange={e => setName(e.target.value)} maxLength={64} /></Field><Button disabled={busy} onClick={() => setName(randomName())}>随机英文名</Button><p>只打开菜单，不继承业务模组，也不自动进入世界。</p></Modal>}
  </div>;
}
