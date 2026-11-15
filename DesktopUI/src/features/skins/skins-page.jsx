import React, { useEffect, useRef, useState } from "react";
import { SkinViewer } from "skinview3d";
import { Button, Empty, ErrorBox, Field, Intro, Modal, Search, Select, useValidation } from "../../app/ui.jsx";
import { SkinBench, TargetFields } from "./skin-bench.jsx";
import { NpcModelView, captureNpcModel, npcClipsFor, npcModelFor, npcTextureFor } from "./npc-model-view.jsx";
import "./skins.css";

const api = (method, args) => window.toolkit.call(method, args);

const modelShots = new Map();
const npcShots = new Map();
let modelShotQueue = Promise.resolve();
function forgetModelShot(id) {
  modelShots.delete(id);
  npcShots.delete(id);
}
function humanTarget(targets, value) {
  if (!value) return true;
  const found = targets.find((item) => item.identifier === value);
  return !!(found && found.human);
}
function modelShot(id) {
  const cached = modelShots.get(id);
  if (typeof cached === "string" || cached) return Promise.resolve(cached);
  const job = modelShotQueue.then(async () => {
    const source = await api("skins.image", { id });
    const canvas = document.createElement("canvas");
    const viewer = new SkinViewer({
      canvas,
      width: 160,
      height: 230,
      pixelRatio: 1,
      renderPaused: true,
      preserveDrawingBuffer: true,
      enableControls: false,
      zoom: 0.68,
    });
    try {
      viewer.background = getComputedStyle(document.body).backgroundColor;
      viewer.autoRotate = false;
      viewer.playerObject.rotation.y = Math.PI / 8;
      await viewer.loadSkin(source, { model: "auto-detect" });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      viewer.render();
      const url = canvas.toDataURL("image/png");
      modelShots.set(id, url);
      return url;
    } finally {
      viewer.dispose();
    }
  }).catch((error) => {
    modelShots.delete(id);
    throw error;
  });
  modelShots.set(id, job);
  modelShotQueue = job.then(() => {}, () => {});
  return job;
}
function npcShot(id, model, modelId) {
  const cached = npcShots.get(id);
  if (typeof cached === "string" || cached) return Promise.resolve(cached);
  const job = modelShotQueue.then(async () => {
    const source = await api("skins.image", { id });
    const image = new Image();
    image.src = source;
    await image.decode();
    const copy = document.createElement("canvas");
    copy.width = image.width;
    copy.height = image.height;
    const context = copy.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
    const set = npcClipsFor(modelId);
    const clip = set?.clips?.find((item) => item.name === set.default) || null;
    const url = captureNpcModel(model, copy, 104, 156, clip);
    npcShots.set(id, url);
    return url;
  }).catch((error) => {
    npcShots.delete(id);
    throw error;
  });
  npcShots.set(id, job);
  modelShotQueue = job.then(() => {}, () => {});
  return job;
}
function SkinThumb({ id, alt, human = true, modelId = "" }) {
  const model = !human && modelId ? npcModelFor(modelId) : null;
  const [source, setSource] = useState("");
  useEffect(() => {
    let alive = true;
    const load = human ? modelShot(id) : model ? npcShot(id, model, modelId) : api("skins.image", { id });
    load.then((value) => { if (alive) setSource(value); }).catch(() => {
      if (!alive || !human) return;
      api("skins.image", { id }).then((value) => { if (alive) setSource(value); }).catch(() => {});
    });
    return () => { alive = false; };
  }, [id, human, modelId]);
  const shaped = human || !!model;
  return source
    ? <img className={shaped ? "skin-thumbnail skin-model-thumb" : "skin-thumbnail"} src={source} alt={alt} />
    : <span className={"image-placeholder skin-thumbnail" + (shaped ? " skin-model-thumb" : "")} />;
}

function AddSkins({ files, targets, busy, error, onClose, onSave }) {
  const [rows, setRows] = useState(files);
  const [author, setAuthor] = useState("");
  const [target, setTarget] = useState("");
  const [slot, setSlot] = useState("skin_4");
  const validation = useValidation({
    author: author.trim() ? "" : "请填写作者",
    ...Object.fromEntries(rows.map((row, index) => ["name" + index, row.name.trim() ? "" : "请填写人物名称"])),
  });
  function submit(event) {
    event?.preventDefault();
    if (!validation.check()) return;
    onSave(rows.map((row) => ({ ...row, author, targetIdentifier: target, textureSlot: slot })));
  }
  return <Modal
    title={files.length > 1 ? "批量添加皮肤" : "添加皮肤"}
    description={"已选择 " + files.length + " 张 PNG 贴图"}
    onClose={onClose}
    busy={busy}
    footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button primary disabled={busy} onClick={submit}>添加</Button></>}
  >
    <form onSubmit={submit}>
      <ErrorBox>{error}</ErrorBox>
      <TargetFields targets={targets} value={target} slot={slot} onChange={setTarget} onSlot={setSlot} />
      <div className="skin-inputs">
        {rows.map((row, index) => <div className="skin-input-row" key={row.token}>
          <SkinThumb id={row.token} alt={row.name} human={humanTarget(targets, target)} modelId={target} />
          <Field label={rows.length > 1 ? "人物名称 " + (index + 1) : "人物名称"} {...validation.field("name" + index)} hint={files[index].name}>
            <input autoFocus={index === 0} value={row.name} maxLength={120} onChange={(event) => setRows(rows.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />
          </Field>
        </div>)}
      </div>
      <Field label={rows.length > 1 ? "统一作者" : "作者"} {...validation.field("author")}>
        <input value={author} maxLength={120} placeholder="填写作者名称" onChange={(event) => setAuthor(event.target.value)} />
      </Field>
      <button hidden type="submit" />
    </form>
  </Modal>;
}

function HumanPreview({ id }) {
  const canvas = useRef(null);
  const host = useRef(null);
  const viewerRef = useRef(null);
  const [model, setModel] = useState("auto-detect");
  const [spin, setSpin] = useState(true);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    let viewer;
    let observer;
    setReady(false);
    setError("");
    (async () => {
      try {
        const source = await api("skins.image", { id });
        if (!alive) return;
        viewer = new SkinViewer({ canvas: canvas.current, width: 400, height: 380, preserveDrawingBuffer: true, pixelRatio: Math.min(devicePixelRatio, 2) });
        viewer.autoRotate = spin;
        viewerRef.current = viewer;
        viewer.playerObject.rotation.y = Math.PI / 6;
        observer = new ResizeObserver(() => {
          if (alive && host.current) {
            viewer.setSize(host.current.clientWidth, 380);
            viewer.render();
          }
        });
        observer.observe(host.current);
        await viewer.loadSkin(source, { model });
        if (alive) { viewer.render(); setReady(true); }
      } catch (loadError) {
        if (alive) setError("3D 预览加载失败：" + loadError.message + "。可以切换到原始贴图查看。");
      }
    })();
    return () => { alive = false; observer?.disconnect(); viewer?.dispose(); viewerRef.current = null; };
  }, [id, model]);
  function toggleSpin() {
    const next = !spin;
    setSpin(next);
    if (viewerRef.current) viewerRef.current.autoRotate = next;
  }
  function resetView() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.resetCameraPose();
    viewer.zoom = 0.9;
    viewer.playerObject.rotation.y = Math.PI / 6;
    viewer.render();
  }
  return <>
    <Field label="预览手臂模型">
      <Select value={model} onChange={setModel} options={[
        { value: "auto-detect", label: "自动识别" },
        { value: "default", label: "Steve（宽手臂）" },
        { value: "slim", label: "Alex（细手臂）" },
      ]} />
    </Field>
    <Button aria-pressed={spin} onClick={toggleSpin}>{spin ? "停止旋转" : "继续旋转"}</Button>
    <Button onClick={resetView}>重置视角</Button>
    <ErrorBox>{error}</ErrorBox>
    <div ref={host} className="skin-3d-host" data-ready={ready}>
      <canvas ref={canvas} aria-label="皮肤 3D 预览" />
      {!ready && !error && <span className="preview-loading">正在加载 3D 皮肤…</span>}
    </div>
    <p className="muted">拖动可旋转，滚轮可缩放。预览展示标准人型外观，游戏中的模型与动作以实际加载资源为准。</p>
  </>;
}

function PreviewSkin({ skin, targets, onClose }) {
  const found = targets.find((item) => item.identifier === skin.targetIdentifier);
  const human = !skin.targetIdentifier || !!(found && found.human);
  const npcModel = npcModelFor(skin.targetIdentifier);
  const [mode, setMode] = useState(human || npcModel ? "3d" : "texture");
  const [source, setSource] = useState("");
  useEffect(() => {
    if (mode === "3d" && human) return undefined;
    let alive = true;
    api("skins.image", { id: skin.id }).then((value) => { if (alive) setSource(value); }).catch(() => {});
    return () => { alive = false; };
  }, [mode, skin.id]);
  return <Modal title={skin.name} description={"作者：" + skin.author + " · ID：" + skin.id} onClose={onClose} wide footer={<Button primary onClick={onClose}>关闭</Button>}>
    {(human || npcModel) && <div className="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={mode === "3d"} onClick={() => setMode("3d")}>3D 预览</button>
      <button type="button" role="tab" aria-selected={mode === "texture"} onClick={() => setMode("texture")}>原始贴图</button>
    </div>}
    {mode === "3d" && human ? <HumanPreview id={skin.id} /> : mode === "3d" && npcModel ? <NpcModelView model={npcModel} defaultSrc={npcTextureFor(skin.targetIdentifier)} src={source} clips={npcClipsFor(skin.targetIdentifier)} /> : <div className="skin-preview">{source && <img src={source} alt={skin.name} />}</div>}
    {mode === "3d" && npcModel && <p className="muted">3D 预览使用目标模型的默认贴图，用于确认模型几何；切换到“原始贴图”可查看当前皮肤。</p>}
    {!human && !npcModel && <p className="muted">目标模型：{skin.targetIdentifier}，贴图槽位：{skin.textureSlot}。工具箱没有这个模型的几何体，当前展示原始贴图。</p>}
  </Modal>;
}

function NewSkin({ targets, busy, error, onClose, onCreate }) {
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [target, setTarget] = useState("");
  const [slot, setSlot] = useState("skin_4");
  const validation = useValidation({
    name: name.trim() ? "" : "请填写人物名称",
    author: author.trim() ? "" : "请填写作者",
  });
  function submit(event) {
    event?.preventDefault();
    if (!validation.check()) return;
    onCreate({ name, author, targetIdentifier: target, textureSlot: slot });
  }
  return <Modal title="新建皮肤" description="人型从底稿开始。非人型会用该模型的初始贴图作为画板。也可以继续导入已有贴图或拓展包。" onClose={onClose} busy={busy} footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button primary disabled={busy} onClick={submit}>开始绘制</Button></>}>
    <form onSubmit={submit}>
      <ErrorBox>{error}</ErrorBox>
      <Field label="人物名称" {...validation.field("name")}><input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="作者" {...validation.field("author")}><input value={author} maxLength={120} onChange={(event) => setAuthor(event.target.value)} /></Field>
      <TargetFields targets={targets} value={target} slot={slot} onChange={setTarget} onSlot={setSlot} />
      <button hidden type="submit" />
    </form>
  </Modal>;
}

export function SkinsPage() {
  const [items, setItems] = useState([]);
  const [targets, setTargets] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [bench, setBench] = useState(null);
  const [creating, setCreating] = useState(false);
  const [thumbEpoch, setThumbEpoch] = useState(0);
  const [preview, setPreview] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [selected, setSelected] = useState([]);
  const [replaceImport, setReplaceImport] = useState(false);
  const pendingRef = useRef(null);
  pendingRef.current = pending;
  async function load() {
    try {
      setItems((await api("skins.list")).items);
      setError("");
    } catch (loadError) { setError(loadError.message); }
  }
  useEffect(() => {
    load();
    api("skins.targets").then(setTargets).catch((loadError) => setError(loadError.message));
    return () => {
      const tokens = pendingRef.current?.map((item) => item.token);
      if (tokens?.length) api("skins.discard", { tokens }).catch(() => {});
    };
  }, []);
  async function discardPending() {
    const tokens = pending?.map((item) => item.token) || [];
    setPending(null);
    if (tokens.length) await api("skins.discard", { tokens }).catch(() => {});
  }
  async function prepare() {
    setBusy(true); setError(""); setNotice("");
    try {
      const staged = await api("skins.prepare");
      if (staged?.length) setPending(staged);
    } catch (prepareError) { setError(prepareError.message); }
    finally { setBusy(false); }
  }
  async function savePending(rows) {
    setBusy(true); setError("");
    try {
      setItems((await api("skins.add", { items: rows })).items);
      setPending(null);
      setNotice("已添加 " + rows.length + " 个皮肤");
    } catch (saveError) { setError(saveError.message); }
    finally { setBusy(false); }
  }
  async function createSkin(input) {
    setBusy(true); setError("");
    try {
      const result = await api("skins.create", input);
      setItems(result.items);
      setCreating(false);
      setBench(result.skin);
    } catch (createError) { setError(createError.message); }
    finally { setBusy(false); }
  }
  async function saveBench(patch) {
    setBusy(true); setError("");
    try {
      const result = await api("skins.update", patch);
      setItems(result.items);
      forgetModelShot(patch.id);
      setThumbEpoch((value) => value + 1);
      setBench(result.items.find((item) => item.id === patch.id) || null);
      return result;
    } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError("");
    try {
      const ids = removing.map((item) => item.id);
      setItems((await api("skins.remove", { id: ids })).items);
      setSelected((current) => current.filter((id) => !ids.includes(id)));
      setRemoving(null);
    } catch (removeError) { setError(removeError.message); }
    finally { setBusy(false); }
  }
  async function importPack() {
    setReplaceImport(false);
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api("skins.import");
      if (result) {
        setItems(result.items);
        setNotice("已导入 " + result.items.length + " 个皮肤");
      }
    } catch (importError) { setError(importError.message); }
    finally { setBusy(false); }
  }
  async function exportPack() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api("skins.export");
      if (result?.path) setNotice("已导出：" + result.path);
    } catch (exportError) { setError(exportError.message); }
    finally { setBusy(false); }
  }
  async function exportModern() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api("skins.export-modern");
      if (result) setNotice("已导出 " + result.converted + " 张 64×64 新版皮肤" + (result.copied ? "，" + result.copied + " 张原本就是新版并原样复制" : "") + "。");
    } catch (exportError) { setError(exportError.message); }
    finally { setBusy(false); }
  }
  const visible = items.filter((item) => (item.name + " " + item.author + " " + item.id + " " + item.targetIdentifier).toLowerCase().includes(query.trim().toLowerCase()));
  const visibleIds = visible.map((item) => item.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  function toggleSelected(id) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.concat(id));
  }
  function toggleVisible() {
    setSelected((current) => allVisibleSelected ? current.filter((id) => !visibleIds.includes(id)) : [...new Set(current.concat(visibleIds))]);
  }
  if (bench) return <div className="skins-page"><SkinBench skin={bench} targets={targets} busy={busy} error={error} onBack={() => setBench(null)} onSave={saveBench} /></div>;
  return <div className="skins-page">
    <Intro heading title="NPC皮肤" subtitle="整理人物贴图，预览标准人型外观，并导出网易 NPC 皮肤拓展包。草稿保存在工具箱数据目录。">
      <Button primary icon="plus" disabled={busy} onClick={prepare}>添加皮肤</Button>
      <Button disabled={busy} onClick={() => { setError(""); setCreating(true); }}>新建皮肤</Button>
      <Button icon="import" disabled={busy} onClick={() => items.length ? setReplaceImport(true) : importPack()}>导入拓展包</Button>
      <Button icon="export" disabled={busy || !items.length} onClick={exportPack}>导出拓展包</Button>
      <Button icon="export" disabled={busy || !items.length} onClick={exportModern}>导出新版皮肤</Button>
    </Intro>
    <ErrorBox>{error}</ErrorBox>
    {notice && <p className="muted">{notice}</p>}
    {!items.length ? <Empty icon="skin" title="还没有皮肤" action={<Button primary icon="plus" disabled={busy} onClick={prepare}>添加皮肤</Button>}>选择 PNG 贴图。通用人型皮肤需要 64×64 或 64×32 及其倍率。</Empty> : <>
      <Search value={query} onChange={setQuery} placeholder="搜索名称、作者或 ID…" />
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th className="check-cell"><input type="checkbox" aria-label="选择当前列表中的全部皮肤" checked={allVisibleSelected} onChange={toggleVisible} /></th>
            <th>皮肤</th><th>皮肤 ID</th><th>作者</th><th>目标</th>
            <th className="skin-actions">
              <div className="row-actions">
                <span className="skin-selection-count" data-empty={selected.length === 0}>已选 {selected.length} 个</span>
                <Button icon="trash" disabled={busy || selected.length === 0} aria-label="删除所选" title="删除所选" onClick={() => setRemoving(items.filter((item) => selected.includes(item.id)))} />
              </div>
            </th>
          </tr></thead>
          <tbody>
            {visible.map((item) => <tr key={item.id} className={selected.includes(item.id) ? "selected" : undefined}>
              <td className="check-cell"><input type="checkbox" aria-label={"选择 " + item.name} checked={selected.includes(item.id)} onChange={() => toggleSelected(item.id)} /></td>
              <td><div className="skin-name-cell"><button type="button" className="thumbnail-button" onClick={() => setPreview(item)}><SkinThumb key={item.id + ":" + thumbEpoch} id={item.id} alt={item.name} human={humanTarget(targets, item.targetIdentifier)} modelId={item.targetIdentifier} /></button><span>{item.name}</span></div></td>
              <td className="code skin-id-cell"><span>{item.id}</span></td>
              <td>{item.author}</td>
              <td>{item.targetIdentifier || "通用人型"}</td>
              <td className="skin-actions">
                <div className="row-actions">
                <Button icon="image" aria-label={"预览 " + item.name} onClick={() => setPreview(item)} />
                <Button icon="edit" title="皮肤工作台" aria-label={"打开皮肤工作台 " + item.name} onClick={() => setBench(item)} />
                <Button icon="trash" aria-label={"删除 " + item.name} onClick={() => setRemoving([item])} />
                </div>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {!visible.length && <p className="muted">没有匹配的皮肤。</p>}
    </>}
    {pending && <AddSkins files={pending} targets={targets} busy={busy} error={error} onClose={discardPending} onSave={savePending} />}
    {creating && <NewSkin targets={targets} busy={busy} error={error} onClose={() => setCreating(false)} onCreate={createSkin} />}
    {preview && <PreviewSkin skin={preview} targets={targets} onClose={() => setPreview(null)} />}
    {removing && <Modal title={removing.length > 1 ? "删除选中的 " + removing.length + " 个皮肤？" : "删除「" + removing[0].name + "」？"} description="只从当前草稿移除，不会删除已经导出的拓展包。" onClose={() => setRemoving(null)} busy={busy} footer={<><Button disabled={busy} onClick={() => setRemoving(null)}>取消</Button><Button primary disabled={busy} onClick={remove}>删除</Button></>}>
      <ErrorBox>{error}</ErrorBox>
    </Modal>}
    {replaceImport && <Modal title="导入会替换当前皮肤列表" description="校验通过后才会替换。失败时保留现在的草稿。" onClose={() => setReplaceImport(false)} busy={busy} footer={<><Button disabled={busy} onClick={() => setReplaceImport(false)}>取消</Button><Button primary disabled={busy} onClick={importPack}>继续导入</Button></>}>
    </Modal>}
  </div>;
}
