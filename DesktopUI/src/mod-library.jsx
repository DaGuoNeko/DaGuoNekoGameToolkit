import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Intro,
  Section,
  Field,
  Modal,
  ErrorBox,
  Empty,
  FileDropZone,
} from "./ui.jsx";
import { modRows, setModOption } from "./mod-selection.cjs";
import "./mod-library.css";
const call = (method, args = {}) => window.toolkit.call(method, args);
export function ModLibraryPage({ onRemoved }) {
  return (
    <>
      <Intro
        title="全局模组库"
        subtitle="集中登记模组目录，编辑启动配置时可直接勾选。移出模组时同步清理各套配置中的对应条目。"
      />
      <ModCatalog onRemoved={onRemoved} />
    </>
  );
}
export function ModSelector({ form, change, snapshot, onManage, busy }) {
  return (
    <Section
      title="模组列表"
      description="从全局模组库快速勾选本配置要加载的模组，取消勾选即停用。保存配置后用于下一次启动。"
    >
      <ModCatalog
        entries={form.included_mod_dirs}
        onChange={(value) => change("included_mod_dirs", value)}
        snapshot={snapshot}
        onManage={onManage}
        busy={busy}
      />
    </Section>
  );
}
function ModCatalog({
  entries,
  onChange,
  snapshot,
  onManage,
  onRemoved,
  busy = false,
}) {
  const selecting = !!onChange;
  const [library, setLibrary] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [query, setQuery] = useState(""),
    [working, setWorking] = useState(false),
    [dialog, setDialog] = useState(null),
    [name, setName] = useState(""),
    [directory, setDirectory] = useState("");
  const ticket = useRef(0);
  async function refresh() {
    const current = ++ticket.current;
    setWorking(true);
    setError("");
    try {
      const value = await call("mods.list");
      if (current === ticket.current) setLibrary(value);
    } catch (e) {
      if (current === ticket.current) setError(e.message);
    } finally {
      if (current === ticket.current) setWorking(false);
    }
  }
  useEffect(() => {
    refresh();
    return () => {
      ticket.current++;
    };
  }, []);
  const rows = selecting
    ? modRows(library?.mods || [], entries, snapshot)
    : library?.mods || [];
  const shown = rows.filter((m) =>
    `${m.name}\n${m.path}`.toLowerCase().includes(query.toLowerCase()),
  );
  function open(kind, mod) {
    setDialog({ kind, mod });
    setName(mod?.name || "");
    setDirectory(mod?.path || "");
    setError("");
    setNotice("");
  }
  async function pick() {
    try {
      const value = await call("files.directory");
      if (value) {
        setDirectory(value);
        if (!name)
          setName(value.split(/[\\/]/).filter(Boolean).at(-1).slice(0, 80));
      }
    } catch (e) {
      setError(e.message);
    }
  }
  async function submit() {
    setWorking(true);
    setError("");
    try {
      const value =
        dialog.kind === "remove"
          ? await call("mods.remove", {
              id: dialog.mod.id,
              revision: library.revision,
            })
          : await call("mods.save", {
              id: dialog.mod?.id,
              name,
              directory,
              revision: library.revision,
            });
      setLibrary(value);
      if (dialog.kind === "remove") await onRemoved?.(value);
      setDialog(null);
      setNotice(
        dialog.kind === "remove"
          ? `已移除，并清理 ${value.changes.length} 套启动配置中的 ${value.removedReferences} 条引用；模组文件保留，下次启动生效。`
          : "模组库已保存；已有配置保持不变。",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function importProfiles() {
    setWorking(true);
    setError("");
    try {
      const value = await call("mods.import-profiles", {
        revision: library.revision,
      });
      setLibrary(value);
      setNotice(`已收录 ${value.added} 个新目录，重复路径已跳过。`);
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  function selectShown(enabled) {
    let next = entries;
    for (const row of shown) {
      if (enabled && row.available === false && !row.enabled) continue;
      next = setModOption(next, row, "enabled", enabled);
    }
    onChange(next);
  }
  async function openFolder(mod) {
    setError("");
    try {
      await call(
        "mods.folder",
        mod.id
          ? { id: mod.id }
          : {
              profileId: snapshot.project.id,
              index: mod.indexes[0],
              expectedPath: mod.path,
            },
      );
    } catch (e) {
      setError(e.message);
    }
  }
  async function dropFiles(files) {
    if (files.some((file) => !file.directory))
      throw Error("请拖入模组目录，而不是文件");
    const current = ticket.current;
    setWorking(true);
    setError("");
    try {
      const value = await call("mods.add-directories", {
        directories: files.map((file) => file.path),
        revision: library.revision,
      });
      if (current !== ticket.current) return;
      setLibrary(value);
      if (selecting) {
        let next = entries;
        for (const row of modRows(value.mods, entries, snapshot))
          if (value.selectedIds.includes(row.id))
            next = setModOption(next, row, "enabled", true);
        onChange(next);
      }
      setNotice(
        selecting
          ? "拖入的模组已收录并启用，请保存启动配置。"
          : `已收录 ${value.added} 个新模组目录。`,
      );
    } finally {
      if (current === ticket.current) setWorking(false);
    }
  }
  return (
    <FileDropZone
      className="mod-catalog"
      onFiles={dropFiles}
      report={(e) => setError(e.message)}
      disabled={busy || working || !library}
      blockWhenModal
      hint={selecting ? "松开以收录并启用模组" : "松开以收录到全局模组库"}
    >
      <div className="mod-library-toolbar">
        <input
          aria-label="搜索模组"
          placeholder="搜索模组名称或路径…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          disabled={busy || working || !library}
          onClick={() => open("add")}
        >
          添加全局模组
        </Button>
        <Button disabled={busy || working} onClick={refresh}>
          刷新模组库
        </Button>
        {selecting ? (
          <Button disabled={busy || working} onClick={onManage}>
            管理模组库
          </Button>
        ) : (
          <Button disabled={working || !library} onClick={importProfiles}>
            从启动配置收录
          </Button>
        )}
      </div>
      {!dialog && <ErrorBox>{error}</ErrorBox>}
      {!!library?.warnings.length && (
        <ErrorBox>{library.warnings.join("；")}</ErrorBox>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {selecting && (
        <div className="mod-selection-toolbar">
          <span className="muted">
            已启用 {rows.filter((m) => m.enabled).length} / {rows.length}{" "}
            个模组目录
          </span>
          <Button
            disabled={busy || working || !shown.length}
            onClick={() => selectShown(true)}
          >
            启用筛选结果
          </Button>
          <Button
            disabled={busy || working || !shown.length}
            onClick={() => selectShown(false)}
          >
            停用筛选结果
          </Button>
        </div>
      )}
      <div className={selecting ? "mod-pick-list" : "mod-library-grid"}>
        {shown.map((m) => (
          <article
            className={`mod-library-card ${selecting ? "pick-row" : ""} ${m.enabled ? "enabled" : ""}`}
            key={m.key || m.id}
            aria-label={"模组 " + m.name}
          >
            {selecting && (
              <input
                type="checkbox"
                aria-label={"启用模组 " + m.name}
                checked={m.enabled}
                disabled={
                  busy || working || (m.available === false && !m.enabled)
                }
                onChange={(e) =>
                  onChange(
                    setModOption(entries, m, "enabled", e.target.checked),
                  )
                }
              />
            )}
            <div className="mod-library-info">
              <h3 title={m.name}>{m.name}</h3>
              <p title={m.path}>{m.path}</p>
              {(!selecting ||
                m.local ||
                !m.available ||
                m.indexes?.length > 1) && (
                <div
                  className="mod-library-status"
                  title={`${m.local ? "仅在此配置中，未登记到全局库" : m.available ? "目录可用" : "目录不存在或无法读取"}${m.indexes?.length > 1 ? ` · 此配置有 ${m.indexes.length} 条同路径记录，勾选同步切换` : ""}`}
                >
                  <small>
                    {m.local
                      ? "仅在此配置中，未登记到全局库"
                      : m.available
                        ? "目录可用"
                        : "目录不存在或无法读取"}
                  </small>
                  {m.indexes?.length > 1 && (
                    <small>
                      {" "}
                      · 此配置有 {m.indexes.length} 条同路径记录，勾选同步切换
                    </small>
                  )}
                </div>
              )}
              <ErrorBox>{m.error}</ErrorBox>
            </div>
            {selecting ? (
              <>
                <Button
                  icon="folder"
                  aria-label={"打开模组文件夹 " + m.name}
                  title="打开当前模组文件夹"
                  disabled={busy || working || m.available === false}
                  onClick={() => openFolder(m)}
                />
                <label className="check-row">
                  <input
                    type="checkbox"
                    aria-label={"模组热更新 " + m.name}
                    checked={m.hotReload}
                    disabled={busy || working || !m.enabled}
                    onChange={(e) =>
                      onChange(
                        setModOption(
                          entries,
                          m,
                          "hot_reload",
                          e.target.checked,
                        ),
                      )
                    }
                  />
                  热更新
                </label>
              </>
            ) : (
              <div className="mod-library-actions">
                <Button
                  icon="folder"
                  disabled={working || !m.available}
                  onClick={() => openFolder(m)}
                >
                  打开文件夹
                </Button>
                <Button disabled={working} onClick={() => open("edit", m)}>
                  编辑模组
                </Button>
                <Button
                  danger
                  disabled={working}
                  onClick={() => open("remove", m)}
                >
                  移出模组库
                </Button>
              </div>
            )}
          </article>
        ))}
      </div>
      {!shown.length && (
        <Empty
          title={
            working
              ? "正在读取模组库…"
              : query
                ? "没有匹配的模组"
                : "模组库为空"
          }
        >
          添加模组目录后，可以在每套启动配置中勾选使用。
        </Empty>
      )}
      {dialog && (
        <Modal
          title={
            dialog.kind === "remove"
              ? "移出全局模组库？"
              : dialog.kind === "edit"
                ? "编辑全局模组"
                : "添加全局模组"
          }
          onClose={() => !working && setDialog(null)}
          footer={
            <>
              <Button disabled={working} onClick={() => setDialog(null)}>
                取消
              </Button>
              <Button
                primary
                disabled={
                  working ||
                  (dialog.kind !== "remove" &&
                    (!name.trim() || !directory.trim()))
                }
                onClick={submit}
              >
                {working
                  ? "处理中…"
                  : dialog.kind === "remove"
                    ? "确认移出"
                    : "保存到模组库"}
              </Button>
            </>
          }
        >
          {dialog.kind === "remove" ? (
            <p>
              将“{dialog.mod.name}
              ”移出全局模组库，并从所有启动配置中删除同路径的模组条目（包括停用项和重复项）。磁盘文件不删除，已运行的游戏不受影响，下次启动生效。
            </p>
          ) : (
            <>
              <Field label="模组名称">
                <input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="模组目录">
                <div className="mod-library-toolbar">
                  <input
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                  />
                  <Button disabled={working} onClick={pick}>
                    选择模组目录
                  </Button>
                </div>
              </Field>
              {dialog.kind === "edit" && (
                <p className="muted">
                  更改目录只更新模组库。已有配置保留原路径，需要在配置中重新勾选。
                </p>
              )}
            </>
          )}
          <ErrorBox>{error}</ErrorBox>
        </Modal>
      )}
    </FileDropZone>
  );
}
