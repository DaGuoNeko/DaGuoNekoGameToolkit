import React, { useEffect, useState } from "react";
import { Modal, Button, ErrorBox } from "./ui.jsx";
export function QuickTestDialog({ world, onClose, onStart }) {
  const [library, setLibrary] = useState(null),
    [selected, setSelected] = useState([]),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    window.toolkit
      .call("mods.list")
      .then((v) => {
        if (!active) return;
        setLibrary(v);
        setSelected(
          (world.quickTestModIds || []).filter((id) =>
            v.mods.some((m) => m.id === id),
          ),
        );
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [world.id]);
  const matches = (library?.mods || []).filter((m) =>
    (m.name + " " + m.path).toLowerCase().includes(query.toLowerCase()),
  );
  const unavailable = (library?.mods || []).some(
    (m) => selected.includes(m.id) && !m.available,
  );
  return (
    <Modal
      title={"快速测试 · " + world.name}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            primary
            disabled={busy || !library || unavailable}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onStart({
                  worldId: world.id,
                  modIds: selected,
                  revision: library.revision,
                });
              } catch (e) {
                setError(e.message);
                setBusy(false);
              }
            }}
          >
            {busy ? "正在启动…" : "开始测试"}
          </Button>
        </>
      }
    >
      <p>
        使用默认启动参数和已保存的全局设置，不新建或修改启动配置。存档进度保留，自带模组和调试辅助模组自动加载。
      </p>
      <p className="muted">
        选中的模组默认开启脚本热更新；上次选择会按存档记住。不勾选时仅加载存档自带模组和辅助模组。
      </p>
      <input
        aria-label="搜索测试模组"
        placeholder="搜索模组名称或目录…"
        value={query}
        disabled={busy}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="muted">已选择 {selected.length} 个模组</p>
      <div className="quick-mod-grid">
        {matches.map((mod) => (
          <label className="quick-mod-card" key={mod.id} title={mod.path}>
            <input
              type="checkbox"
              aria-label={"测试模组 " + mod.name}
              checked={selected.includes(mod.id)}
              disabled={busy || (!mod.available && !selected.includes(mod.id))}
              onChange={(e) =>
                setSelected((old) =>
                  e.target.checked
                    ? [...old, mod.id]
                    : old.filter((id) => id !== mod.id),
                )
              }
            />
            <span>
              <strong>{mod.name}</strong>
              <small>
                {mod.available
                  ? mod.path
                  : "目录不可用，请取消勾选或到模组库修复"}
              </small>
            </span>
          </label>
        ))}
      </div>
      {library && !library.mods.length && (
        <p className="muted">
          模组库为空，请先在“模组库”中添加目录；也可不选额外模组直接测试。
        </p>
      )}
      {library?.mods.length > 0 && !matches.length && (
        <p className="muted">没有匹配的模组。</p>
      )}
      <ErrorBox>{error}</ErrorBox>
    </Modal>
  );
}
