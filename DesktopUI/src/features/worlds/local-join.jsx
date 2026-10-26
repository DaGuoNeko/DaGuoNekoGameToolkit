import React, { useEffect, useRef, useState } from "react";
import { Button, Modal, Field, Select, ErrorBox } from "../../app/ui.jsx";

export function LocalJoinDialog({ initialHostId = "", onClose, onStart }) {
  const [hosts, setHosts] = useState([]),
    [hostId, setHostId] = useState(initialHostId),
    [playerName, setPlayerName] = useState(
      () => "Player" + crypto.randomUUID().replaceAll("-", "").slice(0, 8),
    ),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [readError, setReadError] = useState("");
  const sending = useRef(false);
  useEffect(() => {
    let active = true,
      timer;
    const refresh = async () => {
      try {
        const rows = await window.toolkit.call("launch.hosts");
        if (active) {
          setHosts(rows);
          setReadError("");
        }
      } catch (e) {
        if (active) setReadError(e.message);
      } finally {
        if (active) {
          setLoading(false);
          timer = setTimeout(refresh, 1000);
        }
      }
    };
    refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  const selected = hosts.find((h) => h.sessionId === hostId);
  return (
    <Modal
      title="启动联机客户端"
      busy={busy}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            primary
            disabled={
              busy ||
              loading ||
              !!readError ||
              !selected?.ready ||
              !selected?.autoJoinSupported ||
              !playerName.trim()
            }
            onClick={async () => {
              if (sending.current) return;
              sending.current = true;
              setBusy(true);
              setError("");
              try {
                await onStart({ hostSessionId: hostId, playerName });
              } catch (e) {
                setError(e.message);
              } finally {
                sending.current = false;
                setBusy(false);
              }
            }}
          >
            {busy ? "正在启动…" : "启动并加入"}
          </Button>
        </>
      }
    >
      <p>
        选择本机正在运行的主存档。新客户端将使用该房主本次运行的游戏版本与模组，进入后单独记录日志。
      </p>
      <Field label="加入哪个主存档">
        <Select
          value={hostId}
          disabled={busy || loading}
          onChange={setHostId}
          placeholder="请选择主存档"
          options={hosts.map((h) => ({
            value: h.sessionId,
            label: `${h.worldName} · 房主 ${h.playerName} · ${h.engineVersion || "版本未验证"}${h.ready ? "" : "（未就绪）"}`,
            disabled: !h.ready || !h.autoJoinSupported,
          }))}
        />
      </Field>
      {selected && (
        <Field label="本次联机游戏版本">
          <Select disabled value={selected.engineVersion || "unknown"} options={[{
            value: selected.engineVersion || "unknown",
            label: selected.engineVersion
              ? `${selected.engineVersion} · 跟随房主启动快照`
              : "当前构建未验证，无法自动加入",
          }]} />
          <p className="muted">{selected.engineProfile?.label || "请选择使用已验证构建的主存档"}。来宾与房主必须是同一构建，其他版本请在启动配置中选择后新开主存档。</p>
        </Field>
      )}
      <Field label="联机玩家名">
        <input
          value={playerName}
          maxLength={32}
          disabled={busy}
          onChange={(e) => setPlayerName(e.target.value)}
          autoComplete="off"
        />
      </Field>
      {!loading && !hosts.length && (
        <p>请先启动一个主存档，并进入世界等待调试就绪。</p>
      )}
      {hostId && !selected && !loading && (
        <p role="status">所选主机已退出，请重新选择；不会自动改为其他存档。</p>
      )}
      {selected && !selected.ready && (
        <p role="status">所选主机尚未就绪：{selected.reason}</p>
      )}
      <p className="muted">
        本机联机不需要邀请码或樱花。每个客户端使用不同玩家名；是否成功进入以房主验证结果为准。
      </p>
      <ErrorBox>{error || readError}</ErrorBox>
    </Modal>
  );
}
