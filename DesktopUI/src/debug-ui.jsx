import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button, Intro, Field, Select, ErrorBox, Empty, Modal } from "./ui.jsx";
import { useDebugSession, DebugSessionBar } from "./debug-session.jsx";
import {
  properties,
  equal,
  valueOf,
  supports,
  formatValue,
  parseValue,
  mergePage,
  mergeReveal,
  flattenTree,
  typeLabel,
  propertyRows,
  withVisibility,
} from "./ui-inspector-model.cjs";
import "./ui-inspector.css";
import {
  InspectorSettings,
  RemoteInspectorSettings,
} from "./inspector-settings.jsx";
const api = (args) => window.toolkit.call("debug.ui", args);
const message = (error) =>
  error.message?.includes("UI_PROPERTY_CHANGED")
    ? "属性已在游戏中变化。请刷新，并重置该属性的草稿后再修改。"
    : error.message || String(error);
const emptyView = () => ({
  screens: [],
  screen: "",
  pages: {},
  expanded: [],
  details: null,
  pathInput: "",
  drafts: {},
  history: [],
  historyIndex: -1,
  undo: [],
  query: "",
  type: "all",
  width: 38,
  scroll: 0,
  refreshedAt: 0,
  error: "",
  notice: "",
  pendingMutation: null,
  propertyTab: "overview",
  propertyQuery: "",
});

export function UiInspectorPage() {
  const {
    context,
    ready,
    caches,
    saveCache,
    inspectorDirty,
    workspace,
    expand,
    closeInspector,
    transferring,
  } = useDebugSession();
  const [discard, setDiscard] = useState(false);
  const [windowError, setWindowError] = useState("");
  const activeKey = `${context.sessionId || "offline"}:${context.generation || 0}`;
  const staleDrafts =
    inspectorDirty &&
    [...caches.current].some(
      ([key, value]) =>
        key !== activeKey && Object.keys(value.drafts || {}).length > 0,
    );
  if (workspace.popup)
    return (
      <div className="ui-inspector-page" inert={transferring}>
        <UiInspector key={activeKey} context={context} ready={ready} />
      </div>
    );
  return (
    <div
      className="ui-inspector-page"
      inert={transferring}
      aria-busy={transferring}
    >
      <Intro
        title="UI 调试器"
        subtitle="检查控件、定位路径并调整运行时属性。项目 JSON 不会被修改。"
      >
        <Button
          primary
          disabled={
            !workspace.ready ||
            [...caches.current.values()].some((value) => value.pendingMutation)
          }
          onClick={() => expand().catch((e) => setWindowError(e.message))}
        >
          {workspace.open ? "显示调试窗口" : "展开"}
        </Button>
        {workspace.open && (
          <Button
            disabled={[...caches.current.values()].some(
              (value) => value.pendingMutation,
            )}
            onClick={() =>
              closeInspector().catch((e) => setWindowError(e.message))
            }
          >
            收回工具箱
          </Button>
        )}
        {staleDrafts && (
          <Button onClick={() => setDiscard(true)}>清除旧会话草稿</Button>
        )}
      </Intro>
      <ErrorBox>{windowError}</ErrorBox>
      <DebugSessionBar />
      {workspace.open ? (
        <RemoteInspectorSettings />
      ) : (
        <UiInspector key={activeKey} context={context} ready={ready} />
      )}
      {discard && (
        <Modal
          title="清除旧会话草稿？"
          onClose={() => setDiscard(false)}
          footer={
            <>
              <Button onClick={() => setDiscard(false)}>取消</Button>
              <Button
                danger
                onClick={() => {
                  if (workspace.open) {
                    window.toolkit
                      .call("inspector.command", {
                        ...context,
                        action: "clear-old-drafts",
                      })
                      .catch((e) => setWindowError(e.message));
                    setDiscard(false);
                    return;
                  }
                  for (const [key, value] of caches.current)
                    if (key !== activeKey && !value.pendingMutation)
                      saveCache(key, { ...value, drafts: {} });
                  setDiscard(false);
                }}
              >
                确认清除
              </Button>
            </>
          }
        >
          <p>只丢弃工具箱中尚未应用的界面修改，不会改变游戏或项目文件。</p>
        </Modal>
      )}
    </div>
  );
}

export function UiInspector({ context, ready }) {
  const {
    snapshot,
    caches,
    saveCache,
    subscribeCache,
    workspace,
    flushCaches,
  } = useDebugSession();
  const cacheKey = `${context.sessionId || "offline"}:${context.generation || 0}`;
  const initial = useRef(emptyView());
  const subscribe = useCallback(
    (listener) => subscribeCache(cacheKey, listener),
    [cacheKey, subscribeCache],
  );
  const getView = useCallback(
    () => caches.current.get(cacheKey) || initial.current,
    [cacheKey, caches],
  );
  const view = useSyncExternalStore(subscribe, getView);
  const update = useCallback(
    (change) => {
      const old = getView();
      saveCache(
        cacheKey,
        typeof change === "function" ? change(old) : { ...old, ...change },
      );
    },
    [cacheKey, getView, saveCache],
  );
  const [operation, setOperation] = useState("");
  const bounds = !!view.bounds,
    autoRefresh = !!view.autoRefresh;
  const setBounds = (bounds) => update({ bounds });
  const setAutoRefresh = (autoRefresh) => update({ autoRefresh });
  const [pendingSelection, setPendingSelection] = useState(null);
  const [pendingVisibility, setPendingVisibility] = useState(null);
  const [confirm, setConfirm] = useState(null),
    [picked, setPicked] = useState(null);
  const propertyTab = view.propertyTab || "overview";
  const setPropertyTab = (propertyTab) => update({ propertyTab });
  const alive = useRef(true),
    lock = useRef(false),
    epoch = useRef(0),
    pollLock = useRef(false),
    treeRef = useRef(null),
    workbench = useRef(null),
    readyRef = useRef(ready);
  const selecting = useRef(false),
    nextSelection = useRef(null),
    autoLinked = useRef(false);
  readyRef.current = ready;
  const busy = !!operation || !!view.pendingMutation;
  const picker =
    ready &&
    snapshot.pickers.includes(context.sessionId) &&
    (!snapshot.pickerOwners?.[context.sessionId] ||
      snapshot.pickerOwners[context.sessionId] === workspace.ownerId);
  const dirty = Object.keys(view.drafts).length > 0;
  const valid = (token) =>
    alive.current && readyRef.current && token === epoch.current;
  const call = (action, args = {}) => api({ ...context, action, ...args });
  useEffect(() => {
    alive.current = true;
    if (treeRef.current) treeRef.current.scrollTop = getView().scroll;
    return () => {
      alive.current = false;
      epoch.current++;
      if (context.sessionId)
        api({ ...context, action: "picker-stop" }).catch((error) =>
          update({ notice: "拾取清理未完成：" + message(error) }),
        );
    };
  }, []);
  useEffect(() => {
    if (!ready) {
      epoch.current++;
      setAutoRefresh(false);
    }
  }, [ready]);
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const observer = new ResizeObserver(() =>
      tree
        .querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" }),
    );
    observer.observe(tree);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (workspace.popup && workspace.ready && ready && !autoLinked.current) {
      autoLinked.current = true;
      perform("开启双向选中…", async (token) => {
        await call("picker-start", { bounds });
        if (!getView().screen) {
          const screens = await call("screens"),
            screen = screens.at(-1) || "";
          const root = screen
            ? await call("children", { screen, path: "", offset: 0 })
            : null;
          if (valid(token))
            update({
              screens,
              screen,
              pages: root ? { "": root } : {},
              refreshedAt: Date.now(),
            });
        }
      });
    }
  }, [workspace.popup, workspace.ready, ready]);
  async function perform(label, task) {
    if (lock.current || getView().pendingMutation || !readyRef.current) return;
    lock.current = true;
    const token = ++epoch.current;
    setOperation(label);
    update({ error: "", notice: "" });
    try {
      await task(token);
    } catch (error) {
      if (valid(token)) update({ error: message(error) });
    } finally {
      lock.current = false;
      if (alive.current) setOperation("");
    }
  }
  function guarded(title, action) {
    if (Object.keys(getView().drafts).length) setConfirm({ title, action });
    else return action();
  }
  async function loadChildren(parent, offset, screen, token) {
    const result = await call("children", { screen, path: parent, offset });
    if (!valid(token) || getView().screen !== screen) return;
    update((old) => ({
      ...old,
      pages: {
        ...old.pages,
        [parent]: mergePage(
          old.pages[parent],
          result,
          offset > 0 || (old.pages[parent]?.offset || 0) > 0,
        ),
      },
      refreshedAt: Date.now(),
    }));
  }
  function commitSelection(screen, details, pages, token, historyIndex) {
    if (!valid(token)) return;
    update((old) => {
      const history =
        historyIndex === undefined
          ? [
              ...old.history.slice(0, old.historyIndex + 1),
              { screen, path: details.path },
            ].slice(-20)
          : old.history;
      const parts = details.path.split("/").filter(Boolean);
      const previousExpanded = old.screen === screen ? old.expanded : [];
      const additions = [
        ...pages.map((page) => page.parentPath).filter(Boolean),
        ...parts
          .slice(0, -1)
          .map((_, i) => "/" + parts.slice(0, i + 1).join("/")),
      ].filter((path) => !previousExpanded.includes(path));
      return {
        ...old,
        screen,
        details,
        pathInput: details.path,
        drafts: {},
        query: "",
        type: "all",
        pages: withVisibility(
          mergeReveal(old.screen === screen ? old.pages : {}, pages),
          details.path,
          details.visible,
        ),
        expanded: additions.length
          ? [...new Set([...previousExpanded, ...additions])]
          : previousExpanded,
        history,
        historyIndex: historyIndex ?? history.length - 1,
        refreshedAt: Date.now(),
      };
    });
    requestAnimationFrame(() =>
      treeRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" }),
    );
  }
  function selectNode(screen, path, historyIndex, fromGame = false) {
    const current = getView();
    if (
      !path ||
      (!selecting.current &&
        current.screen === screen &&
        current.details?.path === path)
    )
      return;
    if (getView().pendingMutation || (lock.current && !selecting.current))
      return;
    guarded("切换控件？", () => {
      setPendingSelection({ screen, path });
      if (fromGame && current.screen === screen) {
        const parts = path.split("/").filter(Boolean);
        const ancestors = parts
          .slice(0, -1)
          .map((_, i) => "/" + parts.slice(0, i + 1).join("/"));
        const expanded = [...new Set([...current.expanded, ...ancestors])];
        update({
          query: "",
          type: "all",
          expanded:
            expanded.length === current.expanded.length
              ? current.expanded
              : expanded,
        });
      }
      requestAnimationFrame(() =>
        treeRef.current
          ?.querySelector('[aria-selected="true"]')
          ?.scrollIntoView({ block: "nearest" }),
      );
      nextSelection.current = {
        screen,
        path,
        historyIndex,
        fromGame,
        token: ++epoch.current,
      };
      if (selecting.current) return;
      selecting.current = true;
      lock.current = true;
      (async () => {
        while (nextSelection.current && alive.current && readyRef.current) {
          const target = nextSelection.current;
          nextSelection.current = null;
          setOperation("正在定位 " + target.path + "…");
          update({ error: "", notice: "" });
          try {
            const cached = getView();
            const known =
              cached.screen === target.screen &&
              Object.values(cached.pages).some((page) =>
                page.nodes.some((node) => node.path === target.path),
              );
            const result = await call("select", {
              screen: target.screen,
              path: target.path,
              reveal: !known,
              highlight: picker && !target.fromGame,
            });
            commitSelection(
              target.screen,
              result.details,
              result.pages,
              target.token,
              target.historyIndex,
            );
          } catch (error) {
            if (valid(target.token)) update({ error: message(error) });
          }
        }
      })().finally(() => {
        selecting.current = false;
        lock.current = false;
        if (alive.current) {
          setOperation("");
          setPendingSelection(null);
        }
      });
    });
  }
  function chooseScreen(screen) {
    return guarded("切换屏幕？", () =>
      perform("正在读取控件…", async (token) => {
        const root = await call("children", { screen, path: "", offset: 0 });
        if (valid(token))
          update({
            screen,
            pages: { "": root },
            expanded: [],
            details: null,
            pathInput: "",
            drafts: {},
            query: "",
            type: "all",
            refreshedAt: Date.now(),
          });
      }),
    );
  }
  function refreshScreens() {
    return perform("正在刷新屏幕…", async (token) => {
      const screens = await call("screens");
      if (!valid(token)) return;
      update({ screens });
      const old = getView();
      if (old.screen && screens.includes(old.screen)) {
        await loadChildren("", 0, old.screen, token);
        if (old.details) {
          const details = await call("node", {
            screen: old.screen,
            path: old.details.path,
          });
          if (valid(token))
            update((old) => ({
              ...old,
              details,
              pages: withVisibility(old.pages, details.path, details.visible),
              refreshedAt: Date.now(),
            }));
        }
      } else if (!Object.keys(old.drafts).length) {
        const screen = screens.at(-1) || "";
        const root = screen
          ? await call("children", { screen, path: "", offset: 0 })
          : null;
        if (valid(token))
          update({
            screen,
            pages: root ? { "": root } : {},
            expanded: [],
            details: null,
            pathInput: "",
            drafts: {},
            refreshedAt: Date.now(),
          });
      } else
        update({
          error: "原屏幕已关闭。草稿已保留，请复制所需内容或重置后切换屏幕。",
        });
    });
  }
  function refreshChildren() {
    perform("刷新子控件…", async (token) => {
      const old = getView();
      const parent = old.details.path;
      const page = await call("children", {
        screen: old.screen,
        path: parent,
        offset: 0,
      });
      if (!valid(token)) return;
      update((current) => ({
        ...current,
        pages: {
          ...Object.fromEntries(
            Object.entries(current.pages).filter(
              ([key]) => key !== parent && !key.startsWith(parent + "/"),
            ),
          ),
          [parent]: page,
        },
        expanded: [
          ...new Set([
            ...current.expanded.filter((key) => !key.startsWith(parent + "/")),
            parent,
          ]),
        ],
        details: { ...current.details, childCount: page.total },
        refreshedAt: Date.now(),
        notice: "子控件列表已重新读取",
      }));
    });
  }
  async function refreshNode(token) {
    const old = getView();
    if (!old.details) return;
    const details = await call("node", {
      screen: old.screen,
      path: old.details.path,
    });
    if (valid(token))
      update((old) => ({
        ...old,
        details,
        pages: withVisibility(old.pages, details.path, details.visible),
        refreshedAt: Date.now(),
      }));
  }
  useEffect(() => {
    if (!autoRefresh || !ready) return;
    let stopped = false,
      timer;
    const tick = async () => {
      if (
        !lock.current &&
        !pollLock.current &&
        !getView().pendingMutation &&
        !Object.keys(getView().drafts).length &&
        !document.activeElement?.closest(".inspector-property") &&
        getView().details
      )
        await perform("刷新属性…", refreshNode);
      if (!stopped) timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [autoRefresh, ready]);
  useEffect(() => {
    if (!picker || !ready) return;
    let stopped = false,
      timer;
    const tick = async () => {
      if (lock.current || getView().pendingMutation) {
        timer = setTimeout(tick, 250);
        return;
      }
      const token = epoch.current;
      pollLock.current = true;
      try {
        const result = await call("picker-poll");
        if (stopped || !valid(token)) return;
        const [event, screens, screenChanged] = result || [];
        if (Array.isArray(screens) && !equal(screens, getView().screens))
          update({ screens });
        if (screenChanged) {
          if (Object.keys(getView().drafts).length)
            update({
              notice: "游戏画布已变化，当前草稿仍保留；请确认后刷新屏幕。",
            });
          else if (screens?.length) chooseScreen(screens.at(-1));
          return;
        }
        if (event?.[1] && event?.[2]) {
          const target = {
            screen: event[1],
            path: "/" + event[2].split("/").slice(2).join("/"),
          };
          if (Object.keys(getView().drafts).length) setPicked(target);
          else selectNode(target.screen, target.path, undefined, true);
        }
      } catch (error) {
        if (!stopped && alive.current) {
          stopped = true;
          update({ error: message(error) });
          api({ ...context, action: "picker-stop" }).catch((e) =>
            update({ notice: "拾取清理失败：" + message(e) }),
          );
        }
      } finally {
        pollLock.current = false;
        if (!stopped) timer = setTimeout(tick, 250);
      }
    };
    timer = setTimeout(tick, 250);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [picker, ready]);
  function edit(property, input) {
    update((old) => {
      const baseline =
        old.drafts[property.key]?.baseline ?? valueOf(old.details, property);
      const drafts = { ...old.drafts };
      let same = false;
      try {
        same = equal(parseValue(property, input), baseline);
      } catch {
        /* Preserve incomplete numeric drafts. */
      }
      if (same) delete drafts[property.key];
      else drafts[property.key] = { baseline, input };
      return { ...old, drafts };
    });
  }
  async function mutate(
    property,
    value,
    expected,
    undoIndex,
    explicitTarget,
    toggle = false,
  ) {
    if (!ready || lock.current || getView().pendingMutation) return;
    const old = getView(),
      target = explicitTarget || { screen: old.screen, path: old.details.path };
    const id = crypto.randomUUID();
    if (toggle) {
      const parent = target.path.slice(0, target.path.lastIndexOf("/"));
      const node = old.pages[parent]?.nodes.find(
        (node) => node.path === target.path,
      );
      if (typeof node?.visible === "boolean")
        setPendingVisibility({ path: target.path, visible: !node.visible });
    }
    ++epoch.current;
    update({ pendingMutation: id, error: "", notice: "" });
    try {
      const result = await call(toggle ? "toggle-visible" : "mutate", {
        ...target,
        property: property.key,
        value,
        expected,
      });
      update((current) => {
        if (current.pendingMutation !== id) return current;
        let details = current.details;
        if (details?.path === target.path && current.screen === target.screen)
          details =
            property.key === "visible"
              ? {
                  ...details,
                  visible: result.after,
                  properties: {
                    ...details.properties,
                    runtime: {
                      ...details.properties.runtime,
                      visible: result.after,
                    },
                  },
                }
              : {
                  ...details,
                  properties: {
                    ...details.properties,
                    [property.section]: {
                      ...details.properties[property.section],
                      [property.key]: result.after,
                    },
                  },
                };
        const drafts = { ...current.drafts };
        if (
          current.screen === target.screen &&
          current.details?.path === target.path
        )
          delete drafts[property.key];
        const pages =
          property.key === "visible" && current.screen === target.screen
            ? withVisibility(current.pages, target.path, result.after)
            : current.pages;
        const undo =
          undoIndex !== undefined
            ? current.undo.filter((_, index) => index !== undoIndex)
            : equal(result.before, result.after)
              ? current.undo
              : [
                  ...current.undo,
                  {
                    ...target,
                    property: property.key,
                    before: result.before,
                    after: result.after,
                  },
                ].slice(-20);
        return {
          ...current,
          details,
          pages,
          drafts,
          undo,
          pendingMutation: null,
          refreshedAt: Date.now(),
          notice: toggle
            ? `${target.path.split("/").pop()} 已${result.after ? "显示" : "隐藏"}`
            : `${property.label}${undoIndex !== undefined ? "已撤销并回读" : "已应用并回读"}`,
        };
      });
    } catch (error) {
      update((current) =>
        current.pendingMutation === id
          ? {
              ...current,
              pendingMutation: null,
              error:
                undoIndex !== undefined &&
                error.message?.includes("UI_PROPERTY_CHANGED")
                  ? "游戏属性已再次变化，不能覆盖后续修改来执行撤销。请刷新后重新编辑。"
                  : message(error),
            }
          : current,
      );
    } finally {
      if (alive.current) setPendingVisibility(null);
    }
  }
  const allNodes = useMemo(
    () => [
      ...new Map(
        Object.values(view.pages)
          .flatMap((page) => page.nodes)
          .map((node) => [node.path, node]),
      ).values(),
    ],
    [view.pages],
  );
  const filtering = !!view.query.trim() || view.type !== "all";
  const rows = useMemo(
    () =>
      filtering
        ? allNodes
            .filter(
              (node) =>
                (view.type === "all" || node.type === view.type) &&
                `${node.name} ${node.path}`
                  .toLowerCase()
                  .includes(view.query.trim().toLowerCase()),
            )
            .map((node) => ({ ...node, depth: 0 }))
        : flattenTree(view.pages, view.expanded),
    [allNodes, view.query, view.type, view.pages, view.expanded, filtering],
  );
  const selectedUndo = view.undo.findLastIndex(
    (item) => item.screen === view.screen && item.path === view.details?.path,
  );
  const treeActions = useRef(null);
  const onTreeAction = useCallback(
    (action, row) => treeActions.current(action, row),
    [],
  );
  treeActions.current = (action, row) => {
    if (action === "select") return selectNode(view.screen, row.path);
    if (action === "visible")
      return mutate(
        properties.find((p) => p.key === "visible"),
        undefined,
        undefined,
        undefined,
        { screen: view.screen, path: row.path },
        true,
      );
    perform("读取子控件…", async (token) => {
      if (getView().expanded.includes(row.path))
        update((old) => ({
          ...old,
          expanded: old.expanded.filter((path) => path !== row.path),
        }));
      else {
        if (!getView().pages[row.path])
          await loadChildren(row.path, 0, view.screen, token);
        if (valid(token))
          update((old) => ({ ...old, expanded: [...old.expanded, row.path] }));
      }
    });
  };
  const crumbParts = (view.details?.path || "").split("/").filter(Boolean);
  const treeWidth = workspace.popup ? (view.popupWidth ?? 56) : view.width;
  const widthKey = workspace.popup ? "popupWidth" : "width";
  function copyPath() {
    window.toolkit
      .call("debug.copy-path", { path: view.details.path })
      .then(() => update({ notice: "控件路径已复制" }))
      .catch((error) => update({ error: message(error) }));
  }
  const settingsAction = useRef(null);
  settingsAction.current = async (action, value, discardDrafts = false) => {
    if (getView().pendingMutation || lock.current)
      throw Error("请等待当前调试操作完成");
    if (action === "clear-old-drafts") {
      for (const [key, state] of caches.current)
        if (key !== cacheKey && !state.pendingMutation)
          saveCache(key, { ...state, drafts: {} });
      return;
    }
    if (!readyRef.current) throw Error("游戏会话尚未就绪");
    if (action === "refresh") return refreshScreens();
    if (action === "screen") {
      if (
        workspace.popup &&
        Object.keys(getView().drafts).length &&
        !discardDrafts
      )
        throw Error("当前草稿已变化，请重新确认切换屏幕");
      if (discardDrafts) update({ drafts: {} });
      return chooseScreen(value);
    }
    if (action === "picker")
      return perform(value ? "开启双向选中…" : "停止双向选中…", () =>
        call(value ? "picker-start" : "picker-stop", { bounds }),
      );
    if (action === "bounds") {
      if (picker) throw Error("请先停止双向选中，再调整边界显示");
      setBounds(value);
    }
    if (action === "autoRefresh") setAutoRefresh(value);
  };
  useEffect(() => {
    if (workspace.popup) update({ remoteBusy: busy });
  }, [busy, workspace.popup]);
  useEffect(() => {
    if (!workspace.popup) return;
    return window.toolkit.onInspectorCommand(async (command) => {
      let error;
      try {
        if (
          command.sessionId !== context.sessionId ||
          command.generation !== context.generation
        )
          throw Error("游戏会话已变化，请重试");
        await settingsAction.current(
          command.action,
          command.value,
          command.discardDrafts === true,
        );
        await flushCaches();
      } catch (e) {
        error = e.message;
      }
      window.toolkit
        .call("inspector.command-result", { id: command.id, error })
        .catch(() => {});
    });
  }, [workspace.popup, context.sessionId, context.generation, flushCaches]);
  function resize(event) {
    if (
      event.buttons !== 1 ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    )
      return;
    const rect = workbench.current.getBoundingClientRect();
    update({
      [widthKey]: Math.min(
        60,
        Math.max(28, ((event.clientX - rect.left) / rect.width) * 100),
      ),
    });
  }
  return (
    <>
      {!workspace.popup && (
        <InspectorSettings
          view={view}
          ready={ready}
          busy={busy}
          picker={picker}
          onAction={(action, value) =>
            settingsAction
              .current(action, value)
              .catch((error) => update({ error: error.message }))
          }
        />
      )}
      {!workspace.popup && (
        <div className="inspector-status" role="status">
          {view.pendingMutation
            ? "正在应用并回读属性…"
            : operation ||
              (picker
                ? "双向选中已开启：点击游戏定位控件，点击树节点在游戏中高亮"
                : view.refreshedAt
                  ? `上次读取 ${new Date(view.refreshedAt).toLocaleTimeString()} · ${allNodes.length} 个已读取控件${dirty ? " · 有未应用修改" : ""}`
                  : "选择游戏会话后读取屏幕，或使用拾取器定位控件。")}
          {view.notice && <span>{view.notice}</span>}
        </div>
      )}
      <ErrorBox>
        {view.error ||
          (!ready && workspace.popup
            ? "游戏会话未就绪，请在工具箱的 UI 调试器页面选择会话。"
            : "")}
      </ErrorBox>
      {picked && (
        <div className="inspector-pick-note">
          已拾取 {picked.path}，当前草稿仍保留。
          <Button
            onClick={() => {
              selectNode(picked.screen, picked.path);
              setPicked(null);
            }}
          >
            切换到拾取控件
          </Button>
        </div>
      )}
      <div
        className="ui-workbench"
        ref={workbench}
        style={{ "--ui-tree-width": `${treeWidth}%` }}
      >
        <section className="inspector-panel inspector-tree-panel">
          <header>
            <h2>控件树</h2>
            <Button
              disabled={!view.expanded.length || busy}
              onClick={() => update({ expanded: [] })}
            >
              收起全部
            </Button>
          </header>
          <div className="inspector-tree-tools">
            <input
              aria-label="搜索已读取控件"
              placeholder="搜索已读取控件的名称或路径"
              value={view.query}
              onChange={(event) => update({ query: event.target.value })}
            />
            <Select
              aria-label="控件类型筛选"
              value={view.type}
              options={[
                { value: "all", label: "全部类型" },
                ...[...new Set(allNodes.map((node) => node.type))]
                  .sort()
                  .map((type) => ({
                    value: type,
                    label: `${typeLabel(type)} · ${type}`,
                  })),
              ]}
              onChange={(type) => update({ type })}
            />
          </div>
          <small className="inspector-tree-note">
            {filtering
              ? `匹配 ${rows.length} 项；搜索范围为已读取节点。`
              : "按需展开子控件，未展开区域不会递归读取。"}
          </small>
          <div
            className="inspector-tree-scroll"
            ref={treeRef}
            onScroll={(event) => {
              const scroll = event.currentTarget.scrollTop;
              if (Math.abs(scroll - getView().scroll) > 20) update({ scroll });
            }}
            role="tree"
            aria-label="UI 控件树"
          >
            {rows.length ? (
              rows.map((row) =>
                row.more ? (
                  <Button
                    className="inspector-more"
                    key={`more:${row.before ? "before" : "after"}:${row.path}`}
                    disabled={!ready || busy}
                    onClick={() =>
                      perform("读取更多控件…", (token) =>
                        loadChildren(row.path, row.offset, view.screen, token),
                      )
                    }
                  >
                    {row.before ? "加载前面的控件" : "加载更多"} · 还有{" "}
                    {row.remaining} 项
                  </Button>
                ) : (
                  <InspectorTreeRow
                    key={row.path}
                    row={
                      pendingVisibility?.path === row.path
                        ? { ...row, visible: pendingVisibility.visible }
                        : row
                    }
                    selected={
                      (pendingSelection?.screen === view.screen
                        ? pendingSelection.path
                        : view.details?.path) === row.path
                    }
                    expanded={view.expanded.includes(row.path)}
                    filtering={filtering}
                    disabled={!ready || busy}
                    selectionDisabled={
                      !ready ||
                      !!view.pendingMutation ||
                      (busy && !selecting.current)
                    }
                    onAction={onTreeAction}
                  />
                ),
              )
            ) : (
              <Empty title={view.pages[""] ? "没有匹配的控件" : "尚未读取控件"}>
                {view.pages[""]
                  ? "清除搜索条件，或展开更多节点后搜索。"
                  : "连接就绪后点击“读取屏幕”。"}
              </Empty>
            )}
          </div>
        </section>
        <div
          className="inspector-splitter"
          role="separator"
          aria-label="调整控件树宽度"
          aria-orientation="vertical"
          aria-valuemin={28}
          aria-valuemax={60}
          aria-valuenow={Math.round(treeWidth)}
          tabIndex={0}
          onPointerDown={(event) =>
            event.currentTarget.setPointerCapture(event.pointerId)
          }
          onPointerMove={resize}
          onPointerUp={(event) =>
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              update({
                [widthKey]: Math.max(
                  28,
                  Math.min(
                    60,
                    treeWidth + (event.key === "ArrowLeft" ? -2 : 2),
                  ),
                ),
              });
            }
          }}
        />
        <section className="inspector-panel inspector-details">
          <header>
            <h2>控件属性</h2>
            <div>
              <Button
                disabled={!ready || busy || view.historyIndex <= 0}
                onClick={() => {
                  const index = view.historyIndex - 1,
                    item = view.history[index];
                  selectNode(item.screen, item.path, index);
                }}
              >
                后退
              </Button>
              <Button
                disabled={
                  !ready || busy || view.historyIndex >= view.history.length - 1
                }
                onClick={() => {
                  const index = view.historyIndex + 1,
                    item = view.history[index];
                  selectNode(item.screen, item.path, index);
                }}
              >
                前进
              </Button>
            </div>
          </header>
          <div className="inspector-path-bar">
            <input
              aria-label="控件路径"
              placeholder="输入完整控件路径，如 /root/panel"
              value={pendingSelection?.path ?? view.pathInput}
              onChange={(event) => update({ pathInput: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter")
                  selectNode(view.screen, view.pathInput.trim());
              }}
            />
            <Button
              disabled={
                !ready || busy || !view.screen || !view.pathInput.trim()
              }
              onClick={() => selectNode(view.screen, view.pathInput.trim())}
            >
              定位路径
            </Button>
          </div>
          {pendingSelection ? (
            <Empty title="正在读取控件属性">{pendingSelection.path}</Empty>
          ) : view.details ? (
            <>
              <nav className="inspector-breadcrumb" aria-label="控件层级">
                {crumbParts.map((part, index) => (
                  <React.Fragment key={index}>
                    {index > 0 && <span>/</span>}
                    <button
                      disabled={!ready || busy}
                      onClick={() =>
                        selectNode(
                          view.screen,
                          "/" + crumbParts.slice(0, index + 1).join("/"),
                        )
                      }
                    >
                      {part}
                    </button>
                  </React.Fragment>
                ))}
              </nav>
              <div className="inspector-selection">
                <strong>
                  {view.details.name} · {view.details.type}
                </strong>
                <span>
                  {view.details.visible === undefined
                    ? "可见性未知"
                    : view.details.visible
                      ? "可见"
                      : "隐藏"}{" "}
                  · {view.details.childCount ?? "?"} 个子控件
                </span>
              </div>
              <details
                className="inspector-actions-disclosure"
                open={!workspace.popup}
              >
                <summary>控件操作</summary>
                <div className="inspector-node-actions">
                  <Button onClick={copyPath}>复制路径</Button>
                  <Button disabled={!ready || busy} onClick={refreshChildren}>
                    刷新子控件
                  </Button>
                  <Button
                    disabled={!ready || busy}
                    onClick={() => perform("刷新属性…", refreshNode)}
                  >
                    刷新属性
                  </Button>
                  <Button
                    disabled={!picker || busy}
                    onClick={() =>
                      perform("高亮控件…", () =>
                        call("highlight", {
                          screen: view.screen,
                          path: view.details.path,
                        }),
                      )
                    }
                  >
                    高亮控件
                  </Button>
                  <Button
                    disabled={!ready || busy || selectedUndo < 0 || dirty}
                    onClick={() => {
                      const record = view.undo[selectedUndo];
                      mutate(
                        properties.find((item) => item.key === record.property),
                        record.before,
                        record.after,
                        selectedUndo,
                      );
                    }}
                  >
                    撤销此控件修改
                  </Button>
                </div>
              </details>
              <div
                className="inspector-property-tabs"
                role="tablist"
                aria-label="属性视图"
              >
                <button
                  role="tab"
                  aria-selected={propertyTab === "overview"}
                  onClick={() => setPropertyTab("overview")}
                >
                  属性一览
                </button>
                <button
                  role="tab"
                  aria-selected={propertyTab === "edit"}
                  onClick={() => setPropertyTab("edit")}
                >
                  分组编辑
                </button>
                <button
                  role="tab"
                  aria-selected={propertyTab === "all"}
                  onClick={() => setPropertyTab("all")}
                >
                  全部属性
                </button>
              </div>
              <div className="inspector-property-scroll">
                {propertyTab === "overview" ? (
                  <>
                    <input
                      className="inspector-property-search"
                      aria-label="搜索属性"
                      placeholder="搜索属性名称或值"
                      value={view.propertyQuery || ""}
                      onChange={(e) =>
                        update({ propertyQuery: e.target.value })
                      }
                    />
                    <table
                      className="inspector-property-table"
                      aria-label="控件属性一览"
                    >
                      <thead>
                        <tr>
                          <th>属性</th>
                          <th>当前值</th>
                        </tr>
                      </thead>
                      <tbody>
                        {propertyRows(view.details)
                          .filter((row) =>
                            `${row.label} ${row.key} ${row.value}`
                              .toLowerCase()
                              .includes(
                                (view.propertyQuery || "").toLowerCase(),
                              ),
                          )
                          .map((row, i, rows) => (
                            <React.Fragment key={row.key}>
                              {(!i || rows[i - 1].group !== row.group) && (
                                <tr className="inspector-property-section">
                                  <th colSpan="2">{row.group}</th>
                                </tr>
                              )}
                              <tr>
                                <th title={row.key}>{row.label}</th>
                                <td>{row.value}</td>
                              </tr>
                            </React.Fragment>
                          ))}
                      </tbody>
                    </table>
                  </>
                ) : propertyTab === "all" ? (
                  <pre className="debug-json">
                    {JSON.stringify(view.details.properties, null, 2)}
                  </pre>
                ) : (
                  ["布局", "文字", "交互"].map((group) => {
                    const available = properties.filter(
                      (property) =>
                        property.group === group &&
                        supports(property, valueOf(view.details, property)),
                    );
                    return available.length ? (
                      <section className="inspector-property-group" key={group}>
                        <h3>{group}</h3>
                        {available.map((property) => {
                          const current = valueOf(view.details, property),
                            draft = view.drafts[property.key],
                            input =
                              draft?.input ?? formatValue(property, current);
                          let parsed,
                            error = "";
                          try {
                            parsed = parseValue(property, input);
                          } catch (cause) {
                            error = cause.message;
                          }
                          const conflict =
                            draft && !equal(draft.baseline, current);
                          return (
                            <div
                              className={`inspector-property ${draft ? "modified" : ""}`}
                              key={property.key}
                            >
                              <Field
                                label={property.label}
                                error={
                                  error ||
                                  (conflict
                                    ? "游戏中的值已变化，请重置此项后重新编辑。"
                                    : "")
                                }
                                hint={
                                  draft
                                    ? `读取值：${JSON.stringify(current)}`
                                    : undefined
                                }
                              >
                                <PropertyInput
                                  property={property}
                                  value={input}
                                  disabled={!ready || busy}
                                  onChange={(input) => edit(property, input)}
                                />
                              </Field>
                              <div className="inspector-property-actions">
                                {draft && (
                                  <>
                                    <Button
                                      primary
                                      disabled={
                                        !ready ||
                                        busy ||
                                        !draft ||
                                        !!error ||
                                        conflict
                                      }
                                      onClick={() =>
                                        mutate(property, parsed, draft.baseline)
                                      }
                                    >
                                      应用{property.label}
                                    </Button>
                                    <Button
                                      disabled={busy || !draft}
                                      onClick={() =>
                                        update((old) => {
                                          const drafts = { ...old.drafts };
                                          delete drafts[property.key];
                                          return { ...old, drafts };
                                        })
                                      }
                                    >
                                      重置{property.label}
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </section>
                    ) : null;
                  })
                )}
              </div>
            </>
          ) : (
            <Empty title="选择一个控件">
              点击控件树中的节点，或直接输入路径进行定位。
            </Empty>
          )}
          {workspace.popup && (view.pendingMutation || view.notice) && (
            <p className="inspector-action-feedback" role="status">
              {view.pendingMutation ? "正在应用并回读属性…" : view.notice}
            </p>
          )}
        </section>
      </div>
      {confirm && (
        <Modal
          title={confirm.title}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>继续编辑</Button>
              <Button
                primary
                onClick={() => {
                  const action = confirm.action;
                  update({ drafts: {} });
                  setConfirm(null);
                  action();
                }}
              >
                放弃草稿并切换
              </Button>
            </>
          }
        >
          <p>
            当前控件还有未应用的修改。取消会保留草稿；切换只会丢弃草稿，不会撤销已经应用到游戏的属性。
          </p>
        </Modal>
      )}
    </>
  );
}

function PropertyInput({ property, value, disabled, onChange }) {
  if (property.type === "bool")
    return (
      <label className="check-row">
        <input
          aria-label={property.label}
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {value ? "开启" : "关闭"}
      </label>
    );
  if (property.type.startsWith("vec"))
    return (
      <div className="inspector-vector">
        {value.map((part, index) => (
          <label key={index}>
            <small>
              {property.type === "vec4"
                ? ["R", "G", "B", "A"][index]
                : property.key.toLowerCase().includes("size")
                  ? ["W", "H"][index]
                  : ["X", "Y"][index]}
            </small>
            <input
              aria-label={`${property.label} ${property.type === "vec4" ? ["R", "G", "B", "A"][index] : index === 0 ? "X" : "Y"}`}
              type="number"
              step="any"
              value={part}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  value.map((item, i) =>
                    i === index ? event.target.value : item,
                  ),
                )
              }
            />
          </label>
        ))}
      </div>
    );
  if (property.type === "text")
    return (
      <textarea
        aria-label={property.label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
      />
    );
  return (
    <input
      aria-label={property.label}
      type="number"
      step={property.type === "int" ? "1" : "any"}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

const InspectorTreeRow = React.memo(
  function InspectorTreeRow({
    row,
    selected,
    expanded,
    filtering,
    disabled,
    selectionDisabled,
    onAction,
  }) {
    return (
      <div
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={selected}
        aria-expanded={row.childCount !== 0 ? expanded : undefined}
        className={`inspector-tree-row ${selected ? "selected" : ""}`}
        style={{ paddingLeft: 8 + row.depth * 16 }}
      >
        <button
          className="inspector-expand"
          aria-label={`${expanded ? "收起" : "展开"} ${row.path}`}
          disabled={disabled || row.childCount === 0 || filtering}
          onClick={() => onAction("expand", row)}
        >
          {row.childCount !== 0 ? (expanded ? "▾" : "▸") : "·"}
        </button>
        <button
          className={`inspector-eye ${row.visible === false ? "hidden-control" : ""}`}
          disabled={disabled}
          aria-label={`${row.visible === false ? "显示" : row.visible === true ? "隐藏" : "切换显隐"} ${row.path}`}
          aria-pressed={row.visible === false}
          title={
            row.visible === undefined
              ? "切换此控件的显示状态"
              : row.visible
                ? "点击隐藏此控件"
                : "点击显示此控件"
          }
          onClick={() => onAction("visible", row)}
        >
          <svg
            viewBox="0 0 24 24"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            {row.visible === false && <path d="m3 3 18 18" />}
          </svg>
        </button>
        <button
          className="ui-node"
          disabled={selectionDisabled}
          onClick={() => onAction("select", row)}
          title={row.path}
        >
          <strong>{row.name}</strong>
          <small>{filtering ? row.path : typeLabel(row.type)}</small>
        </button>
      </div>
    );
  },
  (a, b) =>
    a.selected === b.selected &&
    a.expanded === b.expanded &&
    a.filtering === b.filtering &&
    a.disabled === b.disabled &&
    a.selectionDisabled === b.selectionDisabled &&
    a.onAction === b.onAction &&
    ["path", "name", "type", "depth", "visible", "childCount"].every(
      (key) => a.row[key] === b.row[key],
    ),
);
