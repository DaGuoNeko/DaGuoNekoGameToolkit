import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useContext,
  createContext,
} from "react";
import { Button, Modal, ErrorBox } from "../../app/ui.jsx";
import {
  buildScene,
  parseDocument,
  edit,
  changeNode,
  anchors,
} from "../../../shared/ui-document.cjs";
import wasmBytes from "./ui-layout.wasm";
import "./ui-editor.css";
import { useGamePreview, GamePreview } from "./ui-game-preview.jsx";
import { withEngineTree } from "../../../shared/ui-runtime-tree.cjs";
const api = (method, args = {}) => window.toolkit.call(method, args);
const FieldDraftContext = createContext(null);
function historyWith(list, raw) {
  const next = [...list, raw];
  let size = next.reduce((n, v) => n + v.length * 2, 0);
  while (next.length > 60 || (size > 20 * 1024 * 1024 && next.length > 1))
    size -= next.shift().length * 2;
  return next;
}
const templates = [
  ["panel", "面板"],
  ["label", "文本"],
  ["image", "图片"],
  ["button", "按钮"],
  ["stack_panel", "堆叠布局"],
  ["grid", "网格"],
  ["scroll_view", "滚动区域"],
  ["edit_box", "输入框"],
  ["toggle", "开关"],
  ["slider", "滑动条"],
  ["custom", "自定义"],
];
const initialText =
  JSON.stringify(
    {
      namespace: "new_ui",
      main: {
        type: "screen",
        size: ["100%", "100%"],
        controls: [
          {
            panel: {
              type: "panel",
              size: [320, 180],
              controls: [
                {
                  title: {
                    type: "label",
                    text: "我的界面",
                    size: [200, 30],
                    offset: [0, -50],
                    color: [1, 1, 1],
                  },
                },
              ],
            },
          },
        ],
      },
    },
    null,
    2,
  ) + "\n";
function newDocument() {
  return {
    editorKey: crypto.randomUUID(),
    raw: initialText,
    saved: "",
    file: "未命名.json",
    dependencies: [],
    warnings: [],
    undo: [],
    redo: [],
    selected: "",
    screen: "main",
    propertyDraft: null,
  };
}
function FieldEdit({
  label,
  value,
  onCommit,
  disabled,
  kind = "json",
  onDraft,
}) {
  const context = useContext(FieldDraftContext);
  const format = (v) =>
    kind === "text" ? String(v ?? "") : JSON.stringify(v ?? null);
  const [text, setText] = useState(format(value)),
    [error, setError] = useState("");
  useEffect(() => {
    setText(
      context?.draft?.kind === "field" && context.draft.label === label
        ? context.draft.text
        : format(value),
    );
    setError("");
  }, [JSON.stringify(value), context?.draft]);
  function commit() {
    if (text === format(value)) {
      if (context?.draft?.label === label) context.done();
      return;
    }
    try {
      const result = kind === "text" ? text : JSON.parse(text);
      onCommit(result);
      context?.done();
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <label className="ue-field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={text}
        disabled={
          disabled ||
          (context?.draft?.kind === "field" && context.draft.label !== label)
        }
        onChange={(e) => {
          setText(e.target.value);
          context?.change(label, e.target.value);
          onDraft?.(true);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {error && <small role="alert">{error}</small>}
    </label>
  );
}
function Tree({
  scene,
  selected,
  onSelect,
  onVisible,
  collapsed,
  setCollapsed,
}) {
  const [scroll, setScroll] = useState(0),
    [search, setSearch] = useState("");
  const box = useRef();
  const rows = useMemo(() => {
    const blocked = new Set();
    return scene.nodes.filter((n, i) => {
      if (blocked.has(n.parent)) {
        blocked.add(i);
        return false;
      }
      if (!search && collapsed.has(n.id)) blocked.add(i);
      return !search || n.name.toLowerCase().includes(search.toLowerCase());
    });
  }, [scene, collapsed, search]);
  useEffect(() => {
    const i = rows.findIndex((n) => n.id === selected);
    if (i >= 0 && box.current) {
      const top = i * 28;
      if (
        top < box.current.scrollTop ||
        top > box.current.scrollTop + box.current.clientHeight - 28
      )
        box.current.scrollTop = Math.max(0, top - 60);
    }
  }, [selected]);
  const start = Math.max(0, Math.floor(scroll / 28) - 6),
    shown = rows.slice(start, start + 36);
  return (
    <>
      <input
        aria-label="搜索控件"
        placeholder="搜索控件…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setScroll(0);
          if (box.current) box.current.scrollTop = 0;
        }}
      />
      <div
        className="ue-tree-scroll"
        ref={box}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        role="tree"
        aria-label="控件结构"
      >
        <div style={{ height: rows.length * 28, position: "relative" }}>
          {shown.map((n, i) => (
            <div
              className={"ue-tree-row " + (n.id === selected ? "selected" : "")}
              key={n.id}
              style={{
                top: (start + i) * 28,
                paddingLeft: Math.min(n.depth, 10) * 12,
              }}
              role="treeitem"
              aria-selected={n.id === selected}
            >
              <button
                title="折叠/展开"
                onClick={() =>
                  setCollapsed((old) => {
                    const next = new Set(old);
                    next.has(n.id) ? next.delete(n.id) : next.add(n.id);
                    return next;
                  })
                }
              >
                {collapsed.has(n.id) ? "▸" : "▾"}
              </button>
              <button
                className="ue-tree-name"
                title={n.key + (n.path ? "" : "（继承，只读）")}
                onClick={() => onSelect(n.id)}
              >
                {n.path ? "" : "↳ "}
                {n.name}
                <small>{n.value.type || "继承"}</small>
              </button>
              <button
                title={n.value.visible === false ? "显示控件" : "隐藏控件"}
                disabled={!n.path}
                onClick={() => onVisible(n)}
              >
                {n.value.visible === false ? "○" : "◉"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
function Canvas({
  scene,
  selected,
  onSelect,
  onTransform,
  width,
  height,
  zoom,
  setZoom,
  showBounds,
  onMetrics,
  documentId,
}) {
  const ref = useRef(),
    host = useRef(),
    kernel = useRef(),
    geometry = useRef(),
    images = useRef(new Map()),
    drag = useRef(),
    view = useRef({ scale: 1, x: 0, y: 0 }),
    frame = useRef(),
    latest = useRef();
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [textureErrors, setTextureErrors] = useState([]);
  const [size, setSize] = useState([700, 450]),
    [pan, setPan] = useState([0, 0]);
  useEffect(() => {
    let active = true;
    WebAssembly.instantiate(wasmBytes)
      .then(({ instance }) => {
        if (active) {
          kernel.current = instance.exports;
          setReady(true);
        }
      })
      .catch((e) => setError("C++ 布局核心加载失败：" + e.message));
    return () => {
      active = false;
      cancelAnimationFrame(frame.current);
    };
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize([entry.contentRect.width, entry.contentRect.height]),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const selectedIndex = scene.nodes.findIndex((n) => n.id === selected);
  function layout() {
    if (!kernel.current) return;
    const t = performance.now(),
      k = kernel.current;
    new Float32Array(k.memory.buffer, k.input_ptr(), scene.inputs.length).set(
      scene.inputs,
    );
    if (k.layout(scene.nodes.length, width, height) < 0)
      throw Error("布局超出边界");
    geometry.current = new Float32Array(
      k.memory.buffer,
      k.output_ptr(),
      scene.nodes.length * 11,
    );
    onMetrics({ nodes: scene.nodes.length, layoutMs: performance.now() - t });
  }
  function draw() {
    const canvas = ref.current,
      g = geometry.current;
    if (!canvas || !g) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size[0] * ratio);
    canvas.height = Math.round(size[1] * ratio);
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, ...size);
    const scale =
      Math.min((size[0] - 50) / width, (size[1] - 50) / height) * zoom;
    const x = (size[0] - width * scale) / 2 + pan[0],
      y = (size[1] - height * scale) / 2 + pan[1];
    view.current = { scale, x, y };
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = "#202732";
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    const ordered = scene.nodes
      .map((_, i) => i)
      .sort((a, b) => g[a * 11 + 5] - g[b * 11 + 5]);
    for (const i of ordered) {
      const n = scene.nodes[i],
        r = g.subarray(i * 11, i * 11 + 11),
        v = n.value;
      if (!r[4] || !r[6]) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r[7], r[8], r[9], r[10]);
      ctx.clip();
      ctx.globalAlpha = r[6];
      const rgba = Array.isArray(v.color)
        ? v.color
            .slice(0, 3)
            .map((c) =>
              Math.round(Math.min(1, Math.max(0, Number(c) || 0)) * 255),
            )
        : [220, 230, 245];
      if (v.type === "label") {
        ctx.fillStyle = `rgb(${rgba.join(",")})`;
        ctx.font = `${Math.max(8, 11 * (Number(v.font_scale_factor) || 1))}px 'Microsoft YaHei UI'`;
        ctx.textAlign =
          { left: "left", right: "right" }[v.text_alignment] || "center";
        ctx.textBaseline = "middle";
        ctx.fillText(
          typeof v.text === "string" ? v.text : "文本",
          r[0] +
            (ctx.textAlign === "left"
              ? 0
              : ctx.textAlign === "right"
                ? r[2]
                : r[2] / 2),
          r[1] + r[3] / 2,
        );
      } else if (
        v.type === "image" &&
        images.current.get(v.texture)?.complete
      ) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(images.current.get(v.texture), r[0], r[1], r[2], r[3]);
      } else if (i > 0) {
        ctx.fillStyle =
          v.type === "image"
            ? "#7085a54d"
            : v.type === "button"
              ? "#506b94aa"
              : "#6d92c019";
        ctx.fillRect(r[0], r[1], r[2], r[3]);
      }
      if (showBounds) {
        ctx.strokeStyle = "#7890a055";
        ctx.lineWidth = 1 / scale;
        ctx.strokeRect(r[0], r[1], r[2], r[3]);
      }
      ctx.restore();
    }
    ctx.restore();
    ctx.strokeStyle = "#6d7c94";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, width, height);
    if (selectedIndex >= 0) {
      const r = g.subarray(selectedIndex * 11, selectedIndex * 11 + 11);
      ctx.strokeStyle = "#47afff";
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeRect(r[0], r[1], r[2], r[3]);
      ctx.fillStyle = "#47afff";
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ])
        ctx.fillRect(
          r[0] + dx * r[2] - 3 / scale,
          r[1] + dy * r[3] - 3 / scale,
          6 / scale,
          6 / scale,
        );
    }
  }
  latest.current = { draw, layout };
  useEffect(() => {
    if (ready) {
      layout();
      draw();
    }
  }, [ready, scene, width, height]);
  useEffect(() => {
    if (ready) draw();
  }, [ready, selected, zoom, size, pan, showBounds]);
  useEffect(() => {
    let live = true;
    images.current = new Map();
    setTextureErrors([]);
    const names = [
      ...new Set(
        scene.nodes
          .map((n) => n.value.texture)
          .filter((n) => typeof n === "string" && n.startsWith("textures/")),
      ),
    ];
    if (!documentId) return;
    (async () => {
      for (const name of names.slice(0, 128)) {
        if (!live) return;
        try {
          const uri = await api("ui-editor.texture", { id: documentId, name });
          if (!live) return;
          const im = new Image();
          await new Promise((resolve, reject) => {
            im.onload = resolve;
            im.onerror = () => reject(Error("图片解码失败"));
            im.src = uri;
          });
          if (live) {
            images.current.set(name, im);
            latest.current.draw();
          }
        } catch (e) {
          if (live)
            setTextureErrors((old) => [...old, name + "：" + e.message]);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [documentId, JSON.stringify(scene.nodes.map((n) => n.value.texture))]);
  function point(e) {
    const b = ref.current.getBoundingClientRect(),
      v = view.current;
    return [
      (e.clientX - b.left - v.x) / v.scale,
      (e.clientY - b.top - v.y) / v.scale,
    ];
  }
  function down(e) {
    if (!ready) return;
    e.preventDefault();
    ref.current.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.altKey) {
      drag.current = { pan: true, start: [e.clientX, e.clientY], old: pan };
      return;
    }
    const [x, y] = point(e),
      k = kernel.current;
    let i = k.hit(x, y),
      resize = false;
    if (selectedIndex >= 0) {
      const r = geometry.current.subarray(
        selectedIndex * 11,
        selectedIndex * 11 + 11,
      );
      if (
        Math.abs(x - r[0] - r[2]) < 9 / view.current.scale &&
        Math.abs(y - r[1] - r[3]) < 9 / view.current.scale
      ) {
        i = selectedIndex;
        resize = true;
      }
    }
    if (i < 0) {
      onSelect("");
      return;
    }
    const n = scene.nodes[i];
    onSelect(n.id);
    if (!n.path) return;
    drag.current = {
      index: i,
      start: [x, y],
      resize,
      base: scene.inputs.slice(),
      dx: 0,
      dy: 0,
    };
  }
  function move(e) {
    const d = drag.current;
    if (!d) return;
    if (d.pan) {
      setPan([
        d.old[0] + e.clientX - d.start[0],
        d.old[1] + e.clientY - d.start[1],
      ]);
      return;
    }
    const [x, y] = point(e);
    d.dx = Math.round(x - d.start[0]);
    d.dy = Math.round(y - d.start[1]);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const k = kernel.current,
        input = new Float32Array(k.memory.buffer, k.input_ptr(), d.base.length);
      input.set(d.base);
      const at = d.index * 18;
      input[at + (d.resize ? 2 : 6)] += d.dx;
      input[at + (d.resize ? 4 : 8)] += d.dy;
      if (d.resize) {
        input[at + 6] += d.dx * d.base[at + 11];
        input[at + 8] += d.dy * d.base[at + 12];
      }
      k.layout(scene.nodes.length, width, height);
      latest.current.draw();
    });
  }
  function end(e, cancel = false) {
    const d = drag.current;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    if (ref.current.hasPointerCapture(e.pointerId))
      ref.current.releasePointerCapture(e.pointerId);
    if (!d || d.pan) return;
    latest.current.layout();
    latest.current.draw();
    if (!cancel && (d.dx || d.dy))
      onTransform(
        scene.nodes[d.index],
        d.resize ? "size" : "offset",
        d.dx,
        d.dy,
      );
  }
  return (
    <div className="ue-canvas-host" ref={host}>
      <canvas
        ref={ref}
        aria-label="UI 画布"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={(e) => end(e, true)}
        onWheel={(e) =>
          setZoom((z) =>
            Math.min(4, Math.max(0.25, z * (e.deltaY < 0 ? 1.1 : 0.9))),
          )
        }
      />
      <div className="ue-canvas-hint">
        滚轮缩放 · Alt 拖动平移 · 右下角拖动尺寸 · 静态预览
      </div>
      {error && <div className="ue-canvas-error">{error}</div>}
      {textureErrors.length > 0 && (
        <details className="ue-texture-errors">
          <summary>{textureErrors.length} 个贴图未载入</summary>
          {textureErrors.join("\n")}
        </details>
      )}
    </div>
  );
}
export function UiEditorPage({ draft, setDraft }) {
  const doc = draft;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState(null),
    [width, setWidth] = useState(640),
    [height, setHeight] = useState(360),
    [zoom, setZoom] = useState(1),
    [bounds, setBounds] = useState(true),
    [collapsed, setCollapsed] = useState(new Set()),
    [rename, setRename] = useState(null),
    [metrics, setMetrics] = useState({}),
    [showNative, setShowNative] = useState(true),
    [engineProperties, setEngineProperties] = useState(null);
  const result = useMemo(() => {
    if (!doc) return {};
    try {
      return { scene: buildScene(doc.raw, doc.dependencies, doc.screen) };
    } catch (e) {
      return { error: e.message };
    }
  }, [doc?.raw, doc?.dependencies, doc?.screen]);
  let scene = result.scene;
  const dirty = doc && (doc.raw !== doc.saved || doc.propertyDraft);
  const update = (patch) => setDraft((old) => ({ ...old, ...patch }));
  function gamePath(node) {
    const names = [];
    while (node) {
      names.unshift(node.name);
      node = scene.nodes[node.parent];
    }
    return "/" + names.join("/");
  }
  const preview = useGamePreview(doc, (event) => {
    if (!scene || doc.propertyDraft) return;
    const node = scene.nodes.find((n) => gamePath(n) === event.paths[0]);
    if (node) {
      update({ selected: node.id });
      setCollapsed((old) => {
        const next = new Set(old);
        let parent = scene.nodes[node.parent];
        while (parent) {
          next.delete(parent.id);
          parent = scene.nodes[parent.parent];
        }
        return next.size === old.size ? old : next;
      });
    } else if (event.paths[0])
      setNotice("游戏选中 " + event.paths[0] + "（可能来自继承定义）");
    const valid = (a) =>
      Array.isArray(a) && a.length === 2 && a.every(Number.isFinite);
    if (
      node?.path &&
      valid(event.offset) &&
      valid(event.size) &&
      [...event.offset, ...event.size].some((v) => v !== 0)
    ) {
      act(() => {
        const offset = node.value.offset || [0, 0],
          size = node.value.size || ["100%", "100%"];
        const add = (v, d) => {
          if (!d) return v;
          if (typeof v === "number") return v + d;
          const m = String(v).match(
            /^(-?\d+(?:\.\d+)?)%(?:\+?(-?\d+(?:\.\d+)?)px)?$/,
          );
          if (!m) throw Error("游戏拖拽涉及表达式，请通过属性编辑并更新预览");
          return m[1] + "%+" + (Number(m[2] || 0) + d) + "px";
        };
        const anchor = anchors[node.value.anchor_to] || anchors.center;
        let raw = changeNode(doc.raw, node.path, "property", {
          key: "offset",
          value: offset.map((v, i) =>
            add(v, event.offset[i] + event.size[i] * anchor[i]),
          ),
        });
        if (event.size.some((v) => v !== 0))
          raw = changeNode(raw, node.path, "property", {
            key: "size",
            value: size.map((v, i) => add(v, event.size[i])),
          });
        commit(raw);
      });
    }
  });
  const engineScene = useMemo(() => {
    try {
      return {
        value: withEngineTree(
          result.scene,
          preview.active && showNative && preview.state.documentId === doc?.id
            ? preview.state.tree
            : null,
        ),
      };
    } catch (e) {
      return { value: result.scene, error: e.message };
    }
  }, [
    result.scene,
    preview.active,
    preview.state.documentId,
    preview.state.tree,
    doc?.id,
    showNative,
  ]);
  scene = engineScene.value;
  useEffect(() => {
    const tree = preview.state.tree;
    if (
      !tree ||
      !preview.active ||
      preview.state.documentId !== doc?.id ||
      doc.propertyDraft
    )
      return;
    const key = Object.keys(tree).find(
      (k) => k.split("@")[0] === tree.UIHeader?.mCurrent,
    );
    if (key && Object.hasOwn(result.scene?.doc || {}, key))
      setDraft((old) => ({
        ...old,
        screen: key,
        selected: old.screen === key ? old.selected : "",
      }));
  }, [preview.state.tree, preview.state.documentId]);
  const selected = scene?.nodes.find((n) => n.id === doc.selected);
  function commit(raw) {
    if (raw === doc.raw) return;
    setDraft((old) => ({
      ...old,
      raw,
      undo: historyWith(old.undo, old.raw),
      redo: [],
      propertyDraft: null,
    }));
    setError("");
    if (preview.active)
      setNotice(
        "草稿已修改；点击“更新游戏预览”应用到引擎，点击“保存”写入源文件。",
      );
  }
  function act(fn) {
    try {
      fn();
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  function nodeAction(op, value, node = selected) {
    if (node) act(() => commit(changeNode(doc.raw, node.path, op, value)));
  }
  function property(key, value) {
    if (selected)
      commit(changeNode(doc.raw, selected.path, "property", { key, value }));
  }
  function guard(action) {
    if (dirty) setConfirm({ title: "放弃当前 UI 的未保存修改？", action });
    else action();
  }
  async function open() {
    setBusy(true);
    try {
      const value = await api("ui-editor.open");
      if (value)
        setDraft({
          ...value,
          editorKey: crypto.randomUUID(),
          saved: value.raw,
          undo: [],
          redo: [],
          selected: "",
          propertyDraft: null,
        });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(as = false) {
    if (!doc || busy) return;
    if (doc.propertyDraft) {
      setError("请先应用或取消属性/源码草稿");
      return;
    }
    setBusy(true);
    const requestKey = doc.editorKey,
      requestRaw = doc.raw;
    try {
      const value = await api(
        as || !doc.id ? "ui-editor.save-as" : "ui-editor.save",
        { id: doc.id, raw: doc.raw, revision: doc.revision },
      );
      if (value) {
        setDraft((old) =>
          old?.editorKey === requestKey
            ? { ...old, ...value, raw: old.raw, saved: requestRaw }
            : old,
        );
        setNotice(
          value.backup
            ? "已保存，修改前文件已备份"
            : "已另存；新界面需要在资源包 _ui_defs.json 中登记",
        );
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function undo(redo = false) {
    setDraft((old) => {
      const list = redo ? old.redo : old.undo;
      if (!list.length) return old;
      return {
        ...old,
        raw: list.at(-1),
        [redo ? "redo" : "undo"]: list.slice(0, -1),
        [redo ? "undo" : "redo"]: historyWith(
          redo ? old.undo : old.redo,
          old.raw,
        ),
        propertyDraft: null,
      };
    });
  }
  function select(id) {
    if (doc.propertyDraft) {
      setError("请先应用或取消右侧草稿");
      return;
    }
    update({ selected: id });
    if (
      preview.state.phase === "ready" &&
      preview.state.documentId === doc.id
    ) {
      const node = scene.nodes.find((n) => n.id === id);
      preview.action("select", {
        id: doc.id,
        generation: preview.state.generation,
        paths: node ? [gamePath(node)] : [],
      });
    }
  }
  function transform(n, key, dx, dy) {
    act(() => {
      if (doc.propertyDraft) throw Error("请先应用或取消属性草稿");
      const values =
        n.value[key] || (key === "size" ? ["100%", "100%"] : [0, 0]);
      const offset = (v, d) => {
        if (typeof v === "number")
          return key === "size" ? Math.max(0, v + d) : v + d;
        const match = String(v)
          .replace(/\s/g, "")
          .match(/^(-?\d+(?:\.\d+)?)%(?:\+?(-?\d+(?:\.\d+)?)px)?$/);
        if (!match)
          throw Error("该尺寸/偏移来自表达式，请在属性中明确设置后拖拽");
        return (
          match[1] +
          "%" +
          (Number(match[2] || 0) + d >= 0 ? "+" : "") +
          (Number(match[2] || 0) + d) +
          "px"
        );
      };
      let next = changeNode(doc.raw, n.path, "property", {
        key,
        value: [offset(values[0], dx), offset(values[1], dy)],
      });
      if (key === "size") {
        const anchor = anchors[n.value.anchor_to] || anchors.center;
        const previous = n.value.offset || [0, 0];
        const add = (v, d) => (typeof v === "number" ? v + d : offset(v, d));
        next = changeNode(next, n.path, "property", {
          key: "offset",
          value: [
            add(previous[0], dx * anchor[0]),
            add(previous[1], dy * anchor[1]),
          ],
        });
      }
      commit(next);
    });
  }
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest("input,textarea,select,[contenteditable]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save(e.shiftKey);
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "z" &&
        doc &&
        !doc.propertyDraft
      ) {
        e.preventDefault();
        undo(e.shiftKey);
      }
      if (e.key === "Delete" && selected && !doc.propertyDraft)
        setConfirm({
          title: "删除控件 " + selected.name + "？",
          action: () => nodeAction("delete"),
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const stageDraft = (kind, text) => {
    if (doc.propertyDraft && doc.propertyDraft.kind !== kind) {
      setError("请先应用或取消现有草稿");
      return;
    }
    update({ propertyDraft: { kind, text } });
  };
  return (
    <FieldDraftContext.Provider
      value={{
        draft: doc?.propertyDraft,
        change: (label, text) =>
          update({ propertyDraft: { kind: "field", label, text } }),
        done: () => update({ propertyDraft: null }),
      }}
    >
      <section className="ui-editor">
        <div className="ue-toolbar">
          <strong>UI 编辑器</strong>
          <Button
            disabled={busy}
            onClick={() => guard(() => setDraft(newDocument()))}
          >
            新建
          </Button>
          <Button disabled={busy} onClick={() => guard(open)}>
            打开 UI 文件
          </Button>
          <Button disabled={!doc || busy} onClick={() => save()}>
            保存
          </Button>
          <Button disabled={!doc || busy} onClick={() => save(true)}>
            另存为
          </Button>
          <span className="ue-file" title={doc?.file}>
            {doc?.file?.split(/[\\/]/).at(-1) || "未打开界面"}
            {dirty ? " ●" : ""}
          </span>
          <Button
            disabled={!doc?.undo.length || busy || !!doc?.propertyDraft}
            onClick={() => undo()}
          >
            撤销
          </Button>
          <Button
            disabled={!doc?.redo.length || busy || !!doc?.propertyDraft}
            onClick={() => undo(true)}
          >
            重做
          </Button>
        </div>
        <div className="ue-preview-actions">
          <Button
            disabled={
              !doc?.id ||
              busy ||
              preview.active ||
              preview.state.phase === "starting" ||
              !!doc?.propertyDraft
            }
            onClick={() =>
              preview.action("start", { id: doc.id, raw: doc.raw })
            }
          >
            启动内嵌游戏
          </Button>
          <Button
            disabled={
              !preview.active ||
              preview.state.documentId !== doc?.id ||
              preview.state.phase !== "ready" ||
              !!doc?.propertyDraft
            }
            onClick={() => preview.action("sync", { id: doc.id, raw: doc.raw })}
          >
            更新游戏预览
          </Button>
          <Button
            disabled={!preview.active}
            onClick={() => preview.action("stop")}
          >
            停止预览
          </Button>
          <Button
            disabled={preview.active}
            onClick={() => preview.action("pick-engine")}
          >
            选择编辑器引擎
          </Button>
          <span>
            {preview.state.message ||
              "复用本机官方编辑器引擎；先打开或保存 UI 文件"}
          </span>
        </div>
        <ErrorBox>
          {error || preview.error || result.error || engineScene.error}
        </ErrorBox>
        {doc?.propertyDraft?.kind === "field" && (
          <div className="ue-notice">
            属性草稿：{doc.propertyDraft.label}{" "}
            <button onClick={() => update({ propertyDraft: null })}>
              取消属性草稿
            </button>
          </div>
        )}
        {notice && (
          <div className="ue-notice" onClick={() => setNotice("")}>
            {notice}
          </div>
        )}
        {!doc ? (
          <div className="ue-welcome">
            <h2>创建你的游戏界面</h2>
            <p>打开资源包 ui 目录中的 JSON 文件，或从空白画布开始。</p>
            <p>控件结构 · 本地画布 · 属性编辑 · 源码保留</p>
            <Button onClick={() => setDraft(newDocument())}>新建界面</Button>
            <small>
              本地预览开发版，游戏动态绑定与高级布局尚未完整对齐官方。
            </small>
          </div>
        ) : (
          scene && (
            <>
              <div className="ue-options">
                <label>
                  界面{" "}
                  <select
                    aria-label="当前界面"
                    value={scene.current || ""}
                    disabled={!!doc.propertyDraft}
                    onChange={(e) => {
                      if (preview.active) setShowNative(false);
                      update({ screen: e.target.value, selected: "" });
                    }}
                  >
                    {scene.screens.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label>
                  分辨率{" "}
                  <select
                    aria-label="画布分辨率"
                    value={width + "x" + height}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split("x").map(Number);
                      setWidth(w);
                      setHeight(h);
                    }}
                  >
                    <option value="640x360">640 × 360</option>
                    <option value="960x540">960 × 540</option>
                    <option value="360x640">360 × 640</option>
                    <option value="800x600">800 × 600</option>
                    <option value="1920x1080">1920 × 1080</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={bounds}
                    onChange={(e) => setBounds(e.target.checked)}
                  />
                  控件边界
                </label>
                <Button onClick={() => setZoom(1)}>适应画布</Button>
                <span>{Math.round(zoom * 100)}%</span>
                {preview.active && (
                  <Button onClick={() => setShowNative((v) => !v)}>
                    {showNative ? "切换本地画布" : "切换游戏预览"}
                  </Button>
                )}
                <span className="ue-native" title="C++ / WebAssembly 布局核心">
                  {preview.active && showNative ? "真实引擎预览" : "静态预览"} ·
                  开发版
                </span>
              </div>
              <div className="ue-workspace">
                <aside className="ue-left">
                  <header>
                    控件结构 <small>{scene.nodes.length}</small>
                  </header>
                  <Tree
                    scene={scene}
                    selected={doc.selected}
                    onSelect={select}
                    collapsed={collapsed}
                    setCollapsed={setCollapsed}
                    onVisible={(n) => {
                      if (!doc.propertyDraft)
                        nodeAction(
                          "property",
                          { key: "visible", value: n.value.visible === false },
                          n,
                        );
                    }}
                  />
                  <header>控件库</header>
                  <div className="ue-library">
                    {templates.map(([type, label]) => (
                      <button
                        key={type}
                        disabled={
                          !selected?.path || !!doc.propertyDraft || busy
                        }
                        title={"添加 " + type}
                        onClick={() => nodeAction("add", { type })}
                      >
                        <b>
                          {type === "label"
                            ? "T"
                            : type === "image"
                              ? "▧"
                              : type === "button"
                                ? "▣"
                                : "▱"}
                        </b>
                        {label}
                      </button>
                    ))}
                  </div>
                  <small className="ue-tip">选择父控件，再添加子控件</small>
                </aside>
                <div className="ue-center">
                  {preview.active && showNative ? (
                    <GamePreview
                      preview={preview}
                      documentId={doc.id}
                      width={width}
                      height={height}
                    />
                  ) : (
                    <Canvas
                      scene={scene}
                      selected={doc.selected}
                      onSelect={select}
                      onTransform={transform}
                      width={width}
                      height={height}
                      zoom={zoom}
                      setZoom={setZoom}
                      showBounds={bounds}
                      onMetrics={setMetrics}
                      documentId={doc.id}
                    />
                  )}
                  <div className="ue-document-bar">
                    <button
                      onClick={() => {
                        stageDraft("document", doc.raw);
                      }}
                    >
                      文件源码
                    </button>
                    <span>namespace: {scene.doc.namespace}</span>
                    <span>
                      {metrics.nodes || 0} 节点 · 布局{" "}
                      {metrics.layoutMs?.toFixed(2) || "0.00"} ms
                    </span>
                  </div>
                  {(scene.warnings.length > 0 || doc.warnings?.length > 0) && (
                    <details className="ue-warnings">
                      <summary>
                        预览兼容提示（
                        {scene.warnings.length + (doc.warnings?.length || 0)}）
                      </summary>
                      {[...scene.warnings, ...(doc.warnings || [])].map(
                        (s, i) => (
                          <div key={i}>{s}</div>
                        ),
                      )}
                    </details>
                  )}
                </div>
                <aside className="ue-properties">
                  <header>
                    属性 <span>{selected?.name || "未选择"}</span>
                  </header>
                  <div className="ue-property-tabs">
                    <button
                      onClick={() => {
                        if (doc.propertyDraft)
                          setError("请先应用或取消现有草稿");
                      }}
                    >
                      常用属性
                    </button>
                    <button
                      disabled={!selected?.path}
                      onClick={() => {
                        stageDraft(
                          "node",
                          JSON.stringify(selected.source, null, 2),
                        );
                      }}
                    >
                      完整控件
                    </button>
                  </div>
                  {doc.propertyDraft &&
                  ["node", "document"].includes(doc.propertyDraft.kind) ? (
                    <div className="ue-code">
                      <p>
                        {doc.propertyDraft.kind === "node"
                          ? "原始控件 JSON，可编辑变量、绑定、动画等字段"
                          : "文件 JSONC，保留注释和未知字段"}
                      </p>
                      <textarea
                        aria-label="UI 源码草稿"
                        spellCheck={false}
                        value={doc.propertyDraft.text}
                        onChange={(e) =>
                          stageDraft(doc.propertyDraft.kind, e.target.value)
                        }
                      />
                      <Button
                        disabled={busy}
                        onClick={() =>
                          act(() => {
                            const draft = doc.propertyDraft;
                            if (draft.kind === "document") {
                              parseDocument(draft.text);
                              commit(draft.text);
                            } else {
                              const value = JSON.parse(draft.text);
                              if (
                                !value ||
                                Array.isArray(value) ||
                                typeof value !== "object"
                              )
                                throw Error("控件必须为对象");
                              commit(
                                changeNode(
                                  doc.raw,
                                  selected.path,
                                  "replace",
                                  value,
                                ),
                              );
                            }
                            update({ propertyDraft: null });
                          })
                        }
                      >
                        应用草稿
                      </Button>
                      <Button onClick={() => update({ propertyDraft: null })}>
                        取消草稿
                      </Button>
                    </div>
                  ) : selected ? (
                    <div className="ue-property-body" key={selected.id}>
                      <div className="ue-node-actions">
                        <Button
                          disabled={!selected.path || busy}
                          onClick={() => setRename(selected.key)}
                        >
                          重命名
                        </Button>
                        <Button
                          disabled={!selected.path || busy}
                          onClick={() => nodeAction("duplicate")}
                        >
                          复制
                        </Button>
                        <Button
                          disabled={!selected.path || busy}
                          onClick={() =>
                            setConfirm({
                              title: "删除控件 " + selected.name + "？",
                              action: () => nodeAction("delete"),
                            })
                          }
                        >
                          删除
                        </Button>
                        <Button
                          disabled={!selected.path || busy}
                          onClick={() => nodeAction("move", -1)}
                        >
                          上移
                        </Button>
                        <Button
                          disabled={!selected.path || busy}
                          onClick={() => nodeAction("move", 1)}
                        >
                          下移
                        </Button>
                      </div>
                      {!selected.path && <p>此控件来自继承定义，只读预览。</p>}
                      <FieldEdit
                        label="控件类型"
                        value={selected.value.type || ""}
                        kind="text"
                        disabled={!selected.path || busy}
                        onCommit={(v) => property("type", v)}
                      />
                      <FieldEdit
                        label="尺寸"
                        value={selected.value.size || ["100%", "100%"]}
                        disabled={!selected.path || busy}
                        onCommit={(v) => {
                          if (!Array.isArray(v) || v.length !== 2)
                            throw Error("尺寸需要两个数值或表达式");
                          property("size", v);
                        }}
                      />
                      <FieldEdit
                        label="偏移"
                        value={selected.value.offset || [0, 0]}
                        disabled={!selected.path || busy}
                        onCommit={(v) => {
                          if (!Array.isArray(v) || v.length !== 2)
                            throw Error("偏移需要两个数值或表达式");
                          property("offset", v);
                        }}
                      />
                      {["anchor_from", "anchor_to"].map((key, i) => (
                        <label className="ue-field" key={key}>
                          <span>{i ? "自身锚点" : "父级锚点"}</span>
                          <select
                            aria-label={i ? "自身锚点" : "父级锚点"}
                            disabled={!selected.path || busy}
                            value={selected.value[key] || "center"}
                            onChange={(e) => property(key, e.target.value)}
                          >
                            {Object.keys(anchors).map((a) => (
                              <option key={a}>{a}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                      <FieldEdit
                        label="层级"
                        value={selected.value.layer || 0}
                        disabled={!selected.path || busy}
                        onCommit={(v) => {
                          if (typeof v !== "number")
                            throw Error("层级需要数字");
                          property("layer", v);
                        }}
                      />
                      <FieldEdit
                        label="透明度"
                        value={selected.value.alpha ?? 1}
                        disabled={!selected.path || busy}
                        onCommit={(v) => {
                          if (typeof v !== "number" || v < 0 || v > 1)
                            throw Error("透明度为 0 到 1");
                          property("alpha", v);
                        }}
                      />
                      {["visible", "clips_children"].map((key) => (
                        <label className="ue-field" key={key}>
                          <span>
                            {key === "visible" ? "可见" : "裁剪子控件"}
                          </span>
                          <input
                            type="checkbox"
                            disabled={!selected.path || busy}
                            checked={
                              key === "visible"
                                ? selected.value[key] !== false
                                : !!selected.value[key]
                            }
                            onChange={(e) => property(key, e.target.checked)}
                          />
                        </label>
                      ))}
                      {selected.value.type === "label" && (
                        <>
                          <FieldEdit
                            label="文字"
                            value={selected.value.text || ""}
                            kind="text"
                            disabled={!selected.path || busy}
                            onCommit={(v) => property("text", v)}
                          />
                          <FieldEdit
                            label="文字颜色"
                            value={selected.value.color || [1, 1, 1]}
                            disabled={!selected.path || busy}
                            onCommit={(v) => property("color", v)}
                          />
                          <FieldEdit
                            label="文字缩放"
                            value={selected.value.font_scale_factor ?? 1}
                            disabled={!selected.path || busy}
                            onCommit={(v) => property("font_scale_factor", v)}
                          />
                        </>
                      )}
                      {selected.value.type === "image" && (
                        <FieldEdit
                          label="贴图"
                          value={selected.value.texture || ""}
                          kind="text"
                          disabled={!selected.path || busy}
                          onCommit={(v) => property("texture", v)}
                        />
                      )}
                      {selected.value.type === "stack_panel" && (
                        <label className="ue-field">
                          排列方向
                          <select
                            value={selected.value.orientation || "vertical"}
                            onChange={(e) =>
                              property("orientation", e.target.value)
                            }
                          >
                            <option value="vertical">纵向</option>
                            <option value="horizontal">横向</option>
                          </select>
                        </label>
                      )}
                      <details>
                        <summary>所有解析后属性（只读）</summary>
                        <pre>
                          {JSON.stringify(
                            Object.fromEntries(
                              Object.entries(selected.value).filter(
                                ([k]) => k !== "controls",
                              ),
                            ),
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                      {preview.active && (
                        <details>
                          <summary>引擎解析属性（只读）</summary>
                          <Button
                            onClick={async () => {
                              const target = selected.id;
                              const result = await preview.action(
                                "properties",
                                {
                                  id: doc.id,
                                  generation: preview.state.generation,
                                  path: gamePath(selected),
                                },
                              );
                              if (result)
                                setEngineProperties({ id: target, ...result });
                            }}
                          >
                            读取引擎解析结果
                          </Button>
                          {engineProperties?.id === selected.id && (
                            <pre>
                              {JSON.stringify(engineProperties.data, null, 2)}
                            </pre>
                          )}
                        </details>
                      )}
                    </div>
                  ) : (
                    <div className="ue-tip">在控件树或画布选择一个控件</div>
                  )}
                </aside>
              </div>
            </>
          )
        )}
        {confirm && (
          <Modal title={confirm.title} onClose={() => setConfirm(null)}>
            <p>此操作可以通过撤销恢复；切换文件前请保存需要保留的修改。</p>
            <div className="actions">
              <Button onClick={() => setConfirm(null)}>取消</Button>
              <Button
                onClick={() => {
                  const action = confirm.action;
                  setConfirm(null);
                  action();
                }}
              >
                确定
              </Button>
            </div>
          </Modal>
        )}
        {rename !== null && (
          <Modal title="重命名控件" onClose={() => setRename(null)}>
            <input
              aria-label="新控件名称"
              value={rename}
              onChange={(e) => setRename(e.target.value)}
            />
            <p>名称后的 @ 引用表示继承；重命名不会自动重写其他文件的引用。</p>
            <Button
              onClick={() => {
                if (!rename.trim()) return;
                nodeAction("rename", rename.trim());
                setRename(null);
              }}
            >
              应用名称
            </Button>
          </Modal>
        )}
      </section>
    </FieldDraftContext.Provider>
  );
}
