import React, { useState, useEffect, useRef } from "react";
import {
  Intro,
  Section,
  Field,
  Select,
  Button,
  ErrorBox,
  Modal,
  HelpDisclosure,
} from "../../app/ui.jsx";
import "./rooms.css";
const call = (method, args = {}) => window.toolkit.call(method, args);
const phases = {
  idle: "尚未联机",
  preparing: "正在准备",
  network_starting: "等待网络授权",
  game_starting: "启动存档",
  hosting: "等待朋友加入",
  connecting: "正在联系房主",
  waiting_menu: "等待菜单",
  finding_room: "查找游戏房间",
  joining: "正在进入游戏",
  verifying: "验证玩家身份",
  joined: "已进入游戏",
  waiting_host: "等待房主恢复",
  reconnect_blocked: "重连需要处理",
  failed: "联机失败",
  needs_attention: "联机需要处理",
  waiting_assertion: "等待处理断言",
};
const members = {
  creating: "准备邀请",
  invited: "尚未加入",
  joining: "正在入房",
  joined: "已验证入房",
  reconnecting: "等待自动重连",
  revoked: "已撤销",
  revoking: "正在撤销",
  revoke_failed: "撤销未完成，请重试",
  expired: "已过期",
  failed: "生成失败",
  left: "已离开",
};
export function RoomsPage({ draft, onDraft }) {
  const touched = useRef(new Set());
  const [state, setState] = useState({ phase: "idle", members: [] }),
    [worlds, setWorlds] = useState([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let active = true,
      reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const v = await call("rooms.state");
        if (active) setState(v);
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        reading = false;
      }
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    Promise.all([
      call("worlds.list"),
      call("rooms.settings"),
      call("rooms.draft"),
    ])
      .then(([w, s, saved]) => {
        if (active) {
          setWorlds(w.worlds.filter((x) => !x.deleted && !x.deletedAt));
          onDraft((d) => {
            const next = { ...d };
            for (const key of [
              "endpoint",
              "localPort",
              "worldId",
              "roomCode",
              "invitation",
              "playerName",
            ])
              if (!touched.current.has(key) && saved[key] !== undefined)
                next[key] = saved[key];
            next.endpoint ||= s.endpoint;
            next.localPort ||= String(s.localPort);
            next.roomCode ||= crypto
              .randomUUID()
              .replaceAll("-", "")
              .slice(0, 16);
            return next;
          });
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const edit = (k, v) => {
    touched.current.add(k);
    onDraft((d) => ({ ...d, [k]: v }));
    call("rooms.saveDraft", { [k]: v }).catch((e) =>
      setError("保存房间设置失败：" + e.message),
    );
  };
  const action = async (method, args) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (method === "rooms.create" || method === "rooms.join")
        await call("rooms.saveDraft", draft);
      const value = await call(method, args);
      if (method === "rooms.invite")
        setNotice(
          value.fixed
            ? "固定邀请已复制到剪贴板，不限时；重新创建房间后可继续使用。"
            : "邀请已复制到剪贴板，请仅发送给参与测试的朋友。",
        );
      else setState(value);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const active = state.phase !== "idle";
  return (
    <div className="rooms-page">
      <Intro
        title="联机房间"
        subtitle="远程联机：通过 EasyTier 和樱花映射，邀请异地朋友共同制作地图与测试模组。"
      />
      <HelpDisclosure label="本机多人测试与远程联机的区别">
        本机多人测试请在“存档”页启动房主，再多开客户端加入。AI
        自动测试也使用这一流程，无需在此创建房间或配置隧道。
      </HelpDisclosure>
      <ErrorBox>{error || state.error}</ErrorBox>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <Section
        title={phases[state.phase] || state.phase}
        descriptionInline
        description={
          state.message || "房主配置樱花 TCP 隧道；朋友粘贴邀请即可开始连接。"
        }
      >
        <div className="room-status" aria-live="polite">
          <span data-ready={!!state.networkReady}>虚拟网络：{state.networkReady ? "已启动" : "未连接"}</span>
          {state.network?.transport && (
            <span>连接方式：{state.network.transport}</span>
          )}
          <span data-ready={!!state.gameReady}>游戏：{state.gameReady ? "已就绪" : "尚未完成入房"}</span>
          {state.name && <span>存档：{state.name}</span>}
          {state.network?.latencyMs != null && (
            <span>网络延迟：{Math.round(state.network.latencyMs)} ms</span>
          )}
        </div>
        {state.scriptSync && (
          <p
            className={
              state.scriptSync.phase === "error" ? "error-box" : "room-hint"
            }
          >
            脚本同步：{state.scriptSync.message}
          </p>
        )}
        {active && (
          <div className="room-buttons">
            {state.canRetry && (
              <Button disabled={busy} onClick={() => action("rooms.retry")}>
                重试重连
              </Button>
            )}
            {state.role === "host" && (
              <Button
                primary
                disabled={busy || state.phase !== "hosting"}
                onClick={() => action("rooms.invite")}
              >
                {state.fixed ? "复制固定邀请" : "复制新邀请"}
              </Button>
            )}
            <Button disabled={busy} onClick={() => setConfirm(true)}>
              {state.role === "host" ? "关闭联机分享" : "离开房间"}
            </Button>
          </div>
        )}
        {!!state.members?.length && (
          <div className="room-members">
            {state.members.map((m, i) => (
              <article key={m.id}>
                <div>
                  <strong>{m.playerName || `邀请 ${i + 1}`}</strong>
                  <p>
                    {members[m.phase] || m.phase}
                    {state.fixed
                      ? " · 固定邀请码"
                      : " · 到期 " + new Date(m.expires).toLocaleString()}
                  </p>
                  {m.scriptSync && <p>脚本同步：{m.scriptSync.message}</p>}
                </div>
                {!state.fixed && (
                  <Button
                    disabled={
                      busy || ["revoked", "expired", "failed"].includes(m.phase)
                    }
                    onClick={() => action("rooms.revoke", { id: m.id })}
                  >
                    撤销邀请
                  </Button>
                )}
              </article>
            ))}
          </div>
        )}
      </Section>
      {!active && (
        <div className="room-columns">
          <Section
            title="创建房间"
            description="先准备网络，再启动选定存档。已运行的同一存档将直接共享。"
          >
            <Field label="存档">
              <Select
                value={draft.worldId}
                onChange={(v) => edit("worldId", v)}
                options={worlds.map((w) => ({ value: w.id, label: w.name }))}
              />
            </Field>
            <Field
              label="自定义邀请码"
              hint="自动保存，不限时。重建房间时保持此码即可复用邀请；更换此码会使旧邀请失效。"
            >
              <input
                value={draft.roomCode || ""}
                maxLength="64"
                autoComplete="off"
                onChange={(e) => edit("roomCode", e.target.value)}
              />
            </Field>
            <Field
              label="樱花公网入口"
              hint="填写 TCP 隧道显示的地址:端口，不要填写 Web 管理地址。"
            >
              <input
                value={draft.endpoint}
                onChange={(e) => edit("endpoint", e.target.value)}
                placeholder="example.natfrp.com:12345"
              />
            </Field>
            <Field
              label="樱花隧道本地端口"
              hint="樱花的本地 IP 填 127.0.0.1，本地端口与这里一致。"
            >
              <input
                type="number"
                min="1024"
                max="65535"
                value={draft.localPort}
                onChange={(e) => edit("localPort", e.target.value)}
              />
            </Field>
            <HelpDisclosure label="联机组件、授权与自动重连">
              首次使用会下载并校验官方 EasyTier 联机组件。开启网络时 Windows
              会请求管理员授权。房主需保持樱花隧道在线；网络流量通过樱花 TCP
              入口。
              双方工具箱保持运行时，房主恢复同一存档后可用原邀请自动重连；朋友客户端会保留。
            </HelpDisclosure>
            <Button
              primary
              disabled={
                busy ||
                !draft.worldId ||
                !draft.endpoint ||
                !draft.roomCode?.trim()
              }
              onClick={() =>
                action("rooms.create", {
                  worldId: draft.worldId,
                  endpoint: draft.endpoint,
                  localPort: Number(draft.localPort),
                  roomCode: draft.roomCode,
                })
              }
            >
              创建联机房间
            </Button>
          </Section>
          <Section
            title="邀请加入"
            description="朋友无需安装樱花客户端。使用相同游戏版本，原生下载模组；入房后自动接收房主 Python 代码更新。"
          >
            <Field label="完整邀请文本">
              <textarea
                rows="5"
                value={draft.invitation}
                onChange={(e) => edit("invitation", e.target.value)}
                placeholder="DGNROOM2:…"
                spellCheck="false"
                autoComplete="off"
              />
            </Field>
            <HelpDisclosure label="邀请保存说明">
              邀请和名字会自动保存在本机，下次直接加入。完整邀请包含樱花地址；仅填写房主自定义的短码无法定位房间。
            </HelpDisclosure>
            <Button
              disabled={busy}
              onClick={() => {
                edit("invitation", "");
                edit("playerName", "");
              }}
            >
              清除已保存的加入信息
            </Button>
            <Field label="联机玩家名">
              <input
                value={draft.playerName}
                maxLength="32"
                onChange={(e) => edit("playerName", e.target.value)}
                autoComplete="off"
              />
            </Field>
            <HelpDisclosure label="游戏版本与入房验证">
              使用“设置 →
              默认游戏程序”中的开发版游戏，无需选择启动配置或预装房主模组。若游戏提示资源包，请选择“下载并加入”。进入世界且房主确认玩家身份后，才会显示联机成功。
            </HelpDisclosure>
            <Button
              primary
              disabled={busy || !draft.invitation || !draft.playerName}
              onClick={() =>
                action("rooms.join", {
                  invitation: draft.invitation,
                  playerName: draft.playerName,
                })
              }
            >
              加入朋友房间
            </Button>
          </Section>
        </div>
      )}
      {confirm && (
        <Modal
          title={state.role === "host" ? "关闭联机分享" : "离开房间"}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>取消</Button>
              <Button
                danger
                onClick={() => {
                  setConfirm(false);
                  action("rooms.close");
                }}
              >
                确认结束联机
              </Button>
            </>
          }
        >
          <p>
            {state.role === "host"
              ? state.fixed
                ? "本次分享将关闭，房主存档继续运行。固定邀请保留，下次用相同邀请码创建即可继续使用。"
                : "朋友将断开，邀请失效；房主存档继续运行。请让朋友先完成当前操作。"
              : "将停止本次加入的客户端并关闭虚拟网络。请先完成当前游戏操作。"}
          </p>
        </Modal>
      )}
    </div>
  );
}
