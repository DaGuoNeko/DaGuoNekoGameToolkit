import React, { useEffect, useRef, useState, useMemo } from "react";
import { Button, Select, ErrorBox, Modal } from "../../app/ui.jsx";
import { palette, colorLog } from "../../../shared/log-colors.cjs";
import { useLogFollow } from "./log-follow.jsx";
import { useDebugSession } from "../debug/debug-session.jsx";
import { ReloadActions } from "../debug/debugger.jsx";
import { logQuery, highlightTokens } from "../../../shared/log-search.cjs";
import { joinLabel } from "../../../shared/join-status.cjs";
import { useWorkspaceState } from "../../app/workspaces.jsx";
import { useRuntimeState } from "../../app/runtime-view.jsx";
const api = (method, args = {}) => window.toolkit.call(method, args);
const logColors = Object.fromEntries(
  Object.entries(palette).map(([key, value]) => ["--log-" + key, value]),
);
const LogText = React.memo(function LogText({ text, stream, regex }) {
  return (
    <span className="log-text">
      {highlightTokens(colorLog(text, stream), regex).map((token, index) => (
        <span key={index} className={`log-token-${token.type}`}>
          {token.marked ? <mark>{token.text}</mark> : token.text}
        </span>
      ))}
    </span>
  );
});
const LogRow = React.memo(function LogRow({ entry, active, regex, source, setNotice, report }) {
  return <div data-log-id={entry.id} className={`log-line ${entry.stream} ${active ? "log-search-current" : ""}`}>
    <time>{entry.time && Number.isFinite(Date.parse(entry.time)) ? new Date(entry.time).toLocaleTimeString() : ""}</time>
    <LogText text={entry.text} stream={entry.stream} regex={regex} />
    {entry.occurrences > 1 && <span className="log-repeat-count" title={`重复出现 ${entry.occurrences} 次，原始记录全部保留`} aria-label={`重复 ${entry.occurrences} 次`}>×{entry.occurrences}</span>}
    {/File "[^"]+", line \d+|[A-Za-z]:[\\/].+?\.(py|json)/.test(entry.text) && <Button aria-label={`定位日志 ${entry.id} 的文件`} onClick={() => api("logs.source", { entryId: entry.id, ...source }).then(value => setNotice(`已定位 ${value.file}${value.line ? `，第 ${value.line} 行` : ""}`)).catch(report)}>定位文件</Button>}
  </div>;
});

export function LogsPage({ receive, stop, busy, report }) {
  const state = useRuntimeState(true);
  const { selectionLocked } = useDebugSession();
  const [channel, setChannel] = useWorkspaceState("logs-channel", "script");
  const [gameView, setGameView] = useState(null);
  const channelName = channel === "game" ? "游戏调试日志" : "脚本日志";
  const receiveGame = (value) =>
    setGameView((old) =>
      old?.sessionId === value.sessionId &&
      old?.level === value.level &&
      (old.epoch > value.epoch ||
        (old.epoch === value.epoch && old.revision > value.revision))
        ? old
        : value,
    );
  const { snapshot: debugSnapshot } = useDebugSession();
  const liveSession = debugSnapshot.sessions.find(
    (s) => s.registrationId === state.session?.bridgeRegistrationId,
  );
  const [settingsOpen, setSettingsOpen] = useWorkspaceState("logs-settings", false);
  const [switching, setSwitching] = useState("");
  const [removing, setRemoving] = useState("");
  const [cleanup, setCleanup] = useState(null),
    [deleting, setDeleting] = useState(false);
  const sessionCards = useRef(null);
  const settingsToggle = useRef(null);
  function collapseSettings() {
    setSettingsOpen(false);
    requestAnimationFrame(() => settingsToggle.current?.focus());
  }
  const [search, setSearch] = useWorkspaceState("logs-search", ""),
    [level, setLevel] = useWorkspaceState("logs-level", "all");
  const [queryText, setQueryText] = useWorkspaceState("logs-query", ""),
    [caseSensitive, setCaseSensitive] = useWorkspaceState("logs-case", false),
    [fullHistory, setFullHistory] = useWorkspaceState("logs-full", false);
  const [queryResult, setQueryResult] = useState(null),
    [queryBusy, setQueryBusy] = useState(false),
    [queryRefresh, setQueryRefresh] = useState(0);
  const [pages, setPages] = useState({ key: "", cursors: [] }),
    [activeMatch, setActiveMatch] = useState(null);
  const searchInput = useRef(null);
  const [history, setHistory] = useState([]),
    [historyId, setHistoryId] = useState("");
  const [notice, setNotice] = useState("");
  const consoleRef = useRef(null),
    ticket = useRef(0),
    historyTicket = useRef(0);
  const archiveId = historyId || state.session?.id;
  const useArchive =
    !!historyId ||
    !!queryText ||
    fullHistory ||
    level === "errors" ||
    level === "important";
  const sourceContext = useMemo(() => ({ historyId: useArchive ? archiveId : historyId, channel, level }), [useArchive, archiveId, historyId, channel, level]);
  const baseKey = JSON.stringify([
    archiveId,
    channel,
    queryText,
    level,
    caseSensitive,
    fullHistory,
  ]);
  const cursors = pages.key === baseKey ? pages.cursors : [];
  const before = cursors.at(-1);
  const queryKey = JSON.stringify([baseKey, before]);
  const filter = useMemo(
    () => logQuery({ query: queryText, level, caseSensitive }),
    [queryText, level, caseSensitive],
  );
  const result = queryResult?.key === queryKey ? queryResult : null;
  const loading = useArchive && !!archiveId && !result;
  useEffect(() => {
    const timer = setTimeout(() => setQueryText(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const focusSearch = (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f" &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  useEffect(() => {
    if (!useArchive || !archiveId) {
      setQueryBusy(false);
      return;
    }
    let cancelled = false,
      timer;
    const load = async () => {
      setQueryBusy(true);
      try {
        const value = await api("logs.query", {
          id: archiveId,
          channel,
          query: queryText,
          caseSensitive,
          level,
          before,
        });
        if (!cancelled) setQueryResult({ ...value, key: queryKey });
      } catch (error) {
        if (!cancelled)
          setQueryResult({ key: queryKey, logs: [], error: error.message });
      } finally {
        if (!cancelled) setQueryBusy(false);
      }
      if (!cancelled && !historyId && !before && state.session?.running)
        timer = setTimeout(load, 2000);
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [queryKey, useArchive, queryRefresh, state.session?.running]);
  const refresh = async () => {
    const current = ++historyTicket.current;
    try {
      const entries = await api("logs.history", { channel });
      if (current === historyTicket.current) setHistory(entries);
    } catch (error) {
      if (current === historyTicket.current) report(error);
    }
  };
  useEffect(() => {
    refresh();
  }, [state.session?.id, state.session?.running, channel]);
  useEffect(() => {
    if (channel !== "game" || useArchive || !state.session?.id) return;
    let cancelled = false,
      timer;
    const poll = async () => {
      try {
        const value = await api("logs.gameState", {
          sessionId: state.session.id,
          level,
        });
        if (!cancelled) receiveGame(value);
      } catch (error) {
        if (!cancelled) report(error);
      }
      if (!cancelled) timer = setTimeout(poll, 1000);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [channel, useArchive, level, state.session?.id]);
  useEffect(
    () => () => {
      ticket.current++;
      historyTicket.current++;
    },
    [],
  );
  const source = switching
    ? []
    : useArchive
      ? result?.logs || []
      : channel === "game"
        ? gameView?.sessionId === state.session?.id && gameView?.level === level
          ? gameView.logs
          : []
        : state.logs;
  const { isFollowing, onScroll, scrollToBottom, scrollToEntry } = useLogFollow(
    consoleRef,
    `${channel}:${state.session?.id}:${historyId}:${useArchive ? queryKey : "live"}`,
    source,
    search,
    level,
    settingsOpen,
  );
  useEffect(() => {
    sessionCards.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.session?.id, historyId]);
  const visible = useMemo(
    () => source.filter((entry) => filter.matches(entry)),
    [source, filter],
  );
  const activeId =
    activeMatch?.key === queryKey &&
    visible.some((entry) => entry.id === activeMatch.id)
      ? activeMatch.id
      : visible.at(-1)?.id;
  const activeIndex = visible.findIndex((entry) => entry.id === activeId);
  function moveMatch(direction) {
    if (!queryText || !visible.length) return;
    const next =
      (Math.max(activeIndex, 0) + direction + visible.length) % visible.length;
    setActiveMatch({ key: queryKey, id: visible[next].id });
    scrollToEntry(visible[next].id);
  }
  async function selectHistory(id) {
    ++ticket.current;
    setHistoryId(id);
  }
  async function selectSession(id) {
    if (selectionLocked) return;
    const current = ++ticket.current;
    setSwitching(id);
    setHistoryId("");
    setNotice("");
    try {
      const value = await api("launch.select", { sessionId: id });
      receive(value);
    } catch (e) {
      if (current === ticket.current) report(e);
    } finally {
      if (current === ticket.current) setSwitching("");
    }
  }
  async function exportLog() {
    try {
      if (await api("logs.export", { id: historyId || undefined, channel }))
        setNotice("日志已导出");
    } catch (error) {
      report(error);
    }
  }
  const selectedHistory = historyId || state.session?.id;
  const canDeleteSelected =
    !!selectedHistory &&
    (historyId
      ? history.find((h) => h.id === historyId)?.canDelete
      : !state.session?.running &&
        !(channel === "game"
          ? state.session?.gameHistoryDeleted
          : state.session?.historyDeleted));
  async function prepareCleanup(all) {
    if (deleting) return;
    setDeleting(true);
    try {
      const preview = await api(
        "logs.deletePreview",
        all ? { channel } : { id: selectedHistory, channel },
      );
      if (!preview.ids.length)
        setNotice("没有可删除的历史日志；运行中的会话会自动跳过。");
      else setCleanup({ ...preview, all });
    } catch (error) {
      report(error);
    } finally {
      setDeleting(false);
    }
  }
  async function deleteHistory() {
    if (deleting) return;
    setDeleting(true);
    setCleanup(null);
    try {
      const result = await api("logs.delete", {
        ids: cleanup.ids,
        confirmed: true,
        channel,
      });
      if (result.deleted.includes(historyId)) await selectHistory("");
      if (result.deleted.includes(archiveId)) {
        setQueryResult(null);
        setQueryRefresh((n) => n + 1);
      }
      if (channel === "game" && result.deleted.includes(state.session?.id))
        receiveGame(
          await api("logs.gameState", { sessionId: state.session.id }),
        );
      receive(await api("launch.state"));
      await refresh();
      setCleanup(null);
      setNotice(
        `已删除 ${result.deleted.length} 份历史日志，跳过 ${result.skipped.length} 份正在使用的日志${result.errors.length ? `，${result.errors.length} 份删除失败` : ""}。`,
      );
      if (result.errors.length)
        report(
          new Error(
            result.errors.map((e) => `${e.id}：${e.message}`).join("\n"),
          ),
        );
    } catch (error) {
      report(error);
    } finally {
      setDeleting(false);
    }
  }
  async function removeSession(id) {
    if (removing) return;
    setRemoving(id);
    try {
      const value = await api("launch.remove", { sessionId: id });
      receive(value);
      setNotice("已删除会话卡片，历史日志仍可查看。");
    } catch (error) {
      report(error);
    } finally {
      setRemoving("");
    }
  }
  return (
    <div className="logs-page">
      <header className="logs-heading">
        <h1>运行日志</h1>
        <div role="group" aria-label="日志频道" className="log-channel-buttons">
          {[
            ["script", "脚本日志"],
            ["game", "游戏调试日志"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={`button ${channel === value ? "primary" : ""}`}
              aria-pressed={channel === value}
              disabled={deleting || !!switching}
              onClick={() => {
                if (channel === value) return;
                ticket.current++;
                historyTicket.current++;
                setChannel(value);
                setLevel(value === "game" ? "important" : "all");
                setHistory([]);
                setHistoryId("");
                setGameView(null);
                setNotice("");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="logs-session-name">
          {historyId
            ? `历史日志 · ${history.find((h) => h.id === historyId)?.projectName || "正在读取"}`
            : state.session
              ? `${state.session.projectName} · ${state.session.running ? "运行中" : "已结束"}`
              : "尚未启动"}
        </span>
        <span className="logs-count">
          {switching
            ? "正在切换会话…"
            : loading
              ? "正在读取历史日志…"
              : useArchive
                ? level === "important"
                  ? `显示 ${visible.length} / ${result?.matched || 0} 类重要问题 · 共 ${result?.occurrences || 0} 次`
                  : `显示 ${visible.length} / ${result?.matched || 0} 条匹配 · 归档共 ${result?.total || 0} 行`
                : `显示 ${visible.length} / ${source.length} 条 · 最近 2000 条`}
        </span>
        <Button
          disabled={!!switching || loading || !visible.length}
          onClick={scrollToBottom}
        >
          一键到底
        </Button>
        <button
          ref={settingsToggle}
          className="button"
          aria-expanded={settingsOpen}
          aria-controls="log-settings"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          {settingsOpen ? "收起日志设置" : "展开日志设置"}
        </button>
      </header>
      <div className="log-search-bar" role="search" aria-label="日志搜索">
        <input
          ref={searchInput}
          aria-label="搜索日志"
          placeholder="搜索整份会话日志…（Ctrl+F）"
          maxLength={256}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (search !== queryText) setQueryText(search);
              else moveMatch(event.shiftKey ? -1 : 1);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setSearch("");
              setQueryText("");
            }
          }}
        />
        <Button
          aria-label="清除搜索"
          disabled={!search}
          onClick={() => {
            setSearch("");
            setQueryText("");
            searchInput.current?.focus();
          }}
        >
          清除
        </Button>
        <Button
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive(!caseSensitive)}
        >
          区分大小写
        </Button>
        <Button
          disabled={
            !queryText || !visible.length || queryBusy || search !== queryText
          }
          onClick={() => moveMatch(-1)}
        >
          上一条
        </Button>
        <Button
          disabled={
            !queryText || !visible.length || queryBusy || search !== queryText
          }
          onClick={() => moveMatch(1)}
        >
          下一条
        </Button>
        <Select
          aria-label="日志类型"
          value={level}
          options={[
            { value: "all", label: "全部日志" },
            { value: "errors", label: "错误与异常" },
            ...(channel === "game"
              ? [
                  { value: "important", label: "重要日志（警告/错误）" },
                  { value: "content", label: "原版内容日志" },
                  { value: "engine", label: "原版引擎日志" },
                ]
              : [
                  { value: "stdout", label: "标准输出" },
                  { value: "stderr", label: "错误输出" },
                ]),
            { value: "system", label: "会话事件" },
          ]}
          onChange={setLevel}
        />
      </div>
      <div className="log-search-summary muted">
        <span>
          {search !== queryText || queryBusy
            ? "正在检索…"
            : queryText
              ? `${activeIndex + 1} / ${visible.length} 条匹配（整份归档共 ${result?.matched || 0} 条）`
              : useArchive
                ? "正在查看整份会话归档，可翻页查看较早记录"
                : "输入关键词可搜索整份会话归档，包括已移出实时窗口的记录"}
        </span>
        <Button
          disabled={!!historyId && level !== "important"}
          onClick={() => {
            if (useArchive) {
              setFullHistory(false);
              setSearch("");
              setQueryText("");
              if (level === "errors" || level === "important")
                setLevel(channel === "game" ? "content" : "all");
            } else setFullHistory(true);
          }}
        >
          {level === "important"
            ? "查看原始内容"
            : useArchive
              ? "返回实时"
              : "全部记录"}
        </Button>
        {useArchive && (
          <>
            <Button
              disabled={queryBusy || !result?.hasOlder}
              onClick={() =>
                setPages({
                  key: baseKey,
                  cursors: [...cursors, result.logs[0].id],
                })
              }
            >
              更早记录
            </Button>
            <Button
              disabled={queryBusy || !cursors.length}
              onClick={() =>
                setPages({ key: baseKey, cursors: cursors.slice(0, -1) })
              }
            >
              较新记录
            </Button>
            <Button
              disabled={queryBusy}
              onClick={() => setQueryRefresh((n) => n + 1)}
            >
              刷新结果
            </Button>
          </>
        )}
      </div>
      {level === "important" && (
        <p className="log-important-hint muted">
          按原版警告级别显示内容日志；相同问题合并计数，普通信息和引擎日志可在类型菜单中查看。
        </p>
      )}
      <ErrorBox>{result?.error}</ErrorBox>
      <span className="logs-follow-status muted">
        {isFollowing ? "自动跟随最新日志" : "已暂停跟随，滚动到底部继续"}
      </span>
      {!!state.sessions?.length && (
        <div
          className="log-session-cards"
          ref={sessionCards}
          role="group"
          aria-label="游戏日志会话"
        >
          {state.sessions.map((s) => (
            <div className="log-session-tile" key={s.id}>
              <button
                className="log-session-card"
                title={`${s.profileName || s.projectName} · ${s.userName || "玩家"} · ${s.autoJoin ? joinLabel(s) + " · " + s.autoJoin.message : s.blank ? "空白客户端" : s.worldName || "联机客户端"} · PID ${s.pid} · ${new Date(s.startedAt).toLocaleString()}`}
                aria-label={`查看会话 ${s.profileName || s.projectName} ${s.userName || ""} PID ${s.pid}`}
                disabled={deleting || selectionLocked}
                aria-pressed={
                  !historyId && (switching || state.session?.id) === s.id
                }
                onClick={() => selectSession(s.id)}
              >
                <span className="session-card-title">
                  <strong>{s.profileName || s.projectName}</strong>
                  <span className={s.running ? "session-running" : "muted"}>
                    {s.running ? "运行中" : "已结束"}
                  </span>
                </span>
                <span>
                  {s.userName || "玩家"} ·{" "}
                  {s.autoJoin ? joinLabel(s) : s.blank
                    ? "菜单"
                    : s.role === "menu"
                      ? "客户端"
                      : s.worldName || "存档"}
                </span>
              </button>
              {!s.running && (
                <button
                  className="session-remove"
                  title="删除卡片，保留历史日志"
                  aria-label={`删除会话 ${s.profileName || s.projectName} PID ${s.pid}`}
                  disabled={busy || !!removing || !!switching || state.stopping}
                  onClick={() => removeSession(s.id)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <ErrorBox>
        {channel === "game" ? gameView?.error : state.historyError}
      </ErrorBox>
      {channel === "game" && !historyId && (
        <p className="muted" role="status" title={gameView?.files?.join("\n")}>
          {useArchive
            ? "正在检索本会话已保存的原版内容 / 引擎日志"
            : gameView && gameView.sessionId === state.session?.id
              ? gameView.message
              : "等待本客户端的原版日志；请在游戏创作者设置中开启内容日志文件。"}
        </p>
      )}
      {!historyId && !!state.session && (
        <ReloadActions
          context={{
            sessionId: liveSession?.id,
            generation: liveSession?.connectionGeneration,
          }}
          ready={
            !busy &&
            !switching &&
            !!liveSession?.connected &&
            liveSession.state === "game_ready" &&
            !!liveSession.gameIpcConnected &&
            !!liveSession.debugCapabilityEnabled
          }
        />
      )}
      {!historyId && state.session?.gameExitCode && !state.session.stopped ? (
        <ErrorBox>
          Minecraft 游戏进程异常退出：0x
          {(state.session.gameExitCode >>> 0)
            .toString(16)
            .toUpperCase()
            .padStart(8, "0")}
          。启动器退出码为 0 也不能代表游戏正常结束，请检查游戏日志或 Windows
          崩溃记录。
        </ErrorBox>
      ) : null}
      {notice && <p role="status">{notice}</p>}
      {deleting && <p role="status">正在删除历史日志…</p>}
      <div className={`logs-workspace ${settingsOpen ? "settings-open" : ""}`}>
        <div
          className="log-console"
          style={logColors}
          role="log"
          aria-live="off"
          ref={consoleRef}
          onScroll={onScroll}
        >
          {visible.length ? (
            visible.map((entry) => (
              <LogRow key={entry.id} entry={entry} active={!!queryText && entry.id === activeId} regex={filter.regex} source={sourceContext} setNotice={setNotice} report={report} />
            ))
          ) : (
            <p className="muted">
              {switching
                ? "正在切换会话…"
                : queryBusy
                  ? "正在检索整份会话日志…"
                  : result?.missing && useArchive
                    ? "此会话的日志归档尚未生成或已删除"
                    : "暂无匹配的日志"}
            </p>
          )}
        </div>{" "}
        <aside
          id="log-settings"
          className="log-settings"
          hidden={!settingsOpen}
          aria-label="日志设置"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !e.defaultPrevented) {
              e.stopPropagation();
              collapseSettings();
            }
          }}
        >
          <header>
            <h2>日志设置</h2>
            <Button onClick={collapseSettings}>收起</Button>
          </header>
          <section>
            <h3>日志会话</h3>
            <div className="toolbar history-toolbar">
              <Select
                aria-label="日志会话"
                disabled={!!switching || deleting}
                value={historyId}
                options={[
                  { value: "", label: "当前会话" },
                  ...history.map((entry) => ({
                    value: entry.id,
                    label: `${new Date(entry.startedAt).toLocaleString()} · ${entry.projectName}${entry.canDelete ? "" : " · 使用中"}`,
                  })),
                ]}
                onChange={selectHistory}
              />
              <Button onClick={refresh}>刷新历史</Button>
              <Button
                onClick={() => api("logs.folder", { channel }).catch(report)}
              >
                {channel === "game" ? "打开调试日志归档目录" : "打开日志目录"}
              </Button>
              {channel === "game" && !historyId && (
                <Button onClick={() => api("logs.gameFolder").catch(report)}>
                  打开游戏原始日志目录
                </Button>
              )}
              <Button
                danger
                disabled={
                  busy ||
                  deleting ||
                  !!switching ||
                  loading ||
                  !canDeleteSelected
                }
                onClick={() => prepareCleanup(false)}
              >
                删除选中历史日志
              </Button>
              <Button
                danger
                disabled={busy || deleting || !!switching}
                onClick={() => prepareCleanup(true)}
              >
                清理全部已结束日志
              </Button>
            </div>
            <p className="muted">
              当前管理的是{channelName}。 历史日志自动保存，每次最多 50
              MB；列表显示最近 100
              次。“清理全部”也包含更早的记录，运行中的会话会自动跳过。
              日志按客户端会话保存，不随删除存档自动清理；永久删除前请先导出需要保留的记录。
              清空显示不删除历史，导出包含已清空的记录。
              {channel === "game" &&
                "这里清理的是工具箱保存的副本，不删除游戏原始 ContentLog / Debug_Log 文件。"}
            </p>
          </section>
          <section className="log-settings-actions">
            <h3>日志操作</h3>
            <Button
              disabled={
                !!switching ||
                loading ||
                deleting ||
                (!historyId &&
                  (channel === "game"
                    ? state.session?.gameHistoryDeleted || !source.length
                    : state.session?.historyDeleted)) ||
                (!historyId && !state.session && !state.logs.length)
              }
              onClick={exportLog}
            >
              导出日志
            </Button>
            <Button
              disabled={useArchive || !!switching}
              onClick={() =>
                api("logs.clear", { channel, level })
                  .then((value) =>
                    channel === "game" ? receiveGame(value) : receive(value),
                  )
                  .catch(report)
              }
            >
              清空显示
            </Button>
            {state.session?.running && (
              <Button
                danger
                disabled={busy || !!switching || !!historyId || state.stopping}
                onClick={stop}
              >
                停止会话
              </Button>
            )}
          </section>
        </aside>
      </div>
      {cleanup && (
        <Modal
          title="永久删除历史日志"
          busy={deleting}
          initialFocus=".modal-footer .button"
          onClose={() => !deleting && setCleanup(null)}
          footer={
            <>
              <Button disabled={deleting} onClick={() => setCleanup(null)}>
                取消
              </Button>
              <Button danger disabled={deleting} onClick={deleteHistory}>
                {deleting ? "正在删除…" : "确认永久删除"}
              </Button>
            </>
          }
        >
          <p>
            将永久删除 {cleanup.ids.length} 份历史日志及其索引（{channelName}
            ），约 {(cleanup.bytes / 1024 / 1024).toFixed(2)} MB，无法恢复。
          </p>
          {cleanup.all && (
            <p>
              包括列表最近 100
              条之外的旧日志。确认期间新产生的日志不在本次删除范围内。
            </p>
          )}
          <p>
            运行中的日志、游戏存档和启动配置会保留。对应已结束会话的日志显示也会清空。
          </p>
        </Modal>
      )}
    </div>
  );
}
