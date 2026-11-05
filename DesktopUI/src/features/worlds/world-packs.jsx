import React, { useEffect, useRef, useState } from "react";
import { Button, ErrorBox, Field, Modal, Select } from "../../app/ui.jsx";

const call = (method, args = {}) => window.toolkit.call(method, args);
const issueText = {
  "missing-pack": "加载清单引用的包不在存档目录中，可在启动配置补齐外部模组",
  "unlisted-pack": "未列入存档清单，确认需要后可编辑启用",
  "version-mismatch": "包版本与存档清单不一致，可同步版本",
  "duplicate-pack-uuid": "包 UUID 重复，请先确认应保留的包",
  "duplicate-module-uuid": "模块 UUID 重复，请先消除身份歧义",
  "missing-dependency": "依赖未在存档内找到，请补齐或检查启动配置",
  "disabled-dependency": "依赖包未启用",
  "dependency-version": "依赖版本不匹配，请核对配套版本",
  "missing-list": "缺少加载清单，请补齐后重新检查",
  "invalid-list": "加载清单无效，请检查文件",
  "missing-manifest": "缺少 manifest.json 或 pack_manifest.json",
  "invalid-manifest": "manifest 无法解析或字段无效",
  "invalid-module-uuid": "模块 UUID 无效",
  "invalid-dependency": "依赖描述无效，请先核对 manifest",
  "pack-type": "包类型与目录或清单不一致",
  "pack-link": "包目录是链接，禁止修改",
};
const ver = value => Array.isArray(value) ? value.join(".") : value || "未指定";

export function WorldPacks({ world, onClose, onChanged, onImport, onContent, running }) {
  const [health, setHealth] = useState(null), [selected, setSelected] = useState(null);
  const [name, setName] = useState(""), [version, setVersion] = useState(""), [enabled, setEnabled] = useState(true);
  const [confirm, setConfirm] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""), [kind, setKind] = useState("");
  const pending = useRef(false);
  const read = async () => setHealth(await call("worlds.inspect-pack-health", { worldId: world.id }));
  const load = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await read(); } catch (e) { setError(e.message); }
    finally { pending.current = false; setBusy(false); }
  };
  useEffect(() => { load(); }, [world.id]);
  const blocked = busy || running || !health?.revision || !!health?.readOnlyReason;
  const edit = pack => {
    setSelected(pack); setName(pack.name); setVersion(ver(pack.version)); setEnabled(pack.enabled); setError("");
  };
  const apply = async () => {
    if (pending.current || blocked || !confirm) return;
    pending.current = true; setBusy(true); setError("");
    const action = confirm;
    try {
      const response = await call("worlds." + action.method, {
        worldId: world.id, revision: health.revision, confirmed: true, ...action.args,
      });
      setConfirm(null); setSelected(null);
      setNotice(response.changed ? "已保存。恢复备份：" + response.backupPath : "没有需要修改的内容");
      await read(); await onChanged?.();
    } catch (e) {
      setError(e.message); setConfirm(null);
    } finally { pending.current = false; setBusy(false); }
  };
  const prepareSave = () => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) { setError("版本须为三个整数，例如 1.0.0"); return; }
    setConfirm({ title: "确认修改模组", method: "edit-pack",
      detail: "保存名称、包版本和清单启用状态；存档内引用此包的依赖版本将同步。停用可能影响使用其内容的世界。",
      args: { packId: selected.packId, values: { name, version: version.split(".").map(Number), enabled } } });
  };
  const rebind = pack => setConfirm({ title: pack ? "确认重绑模组 UUID" : "确认全体重绑 UUID",
    method: "rebind-pack-uuids", args: pack ? { packId: pack.packId } : {},
    detail: "为" + (pack?.packName || "存档内全部包（包含未启用包）") + "生成新的包和模块 UUID，并同步存档清单及存档内依赖。保持启用顺序，不新增启用包。存档外引用与脚本中的自定义 UUID 不会自动改写。" });
  const filtered = (health?.packs || []).filter(p => (!kind || p.kind === kind) &&
    [p.name, p.packName, p.packId].some(s => String(s).toLowerCase().includes(query.toLowerCase())));
  return <Modal wide title={confirm?.title || (selected ? "编辑模组：" + selected.packName : "存档模组：" + world.name)}
    busy={busy} onClose={() => !busy && onClose()}
    footer={confirm ? <>
      <Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button>
      <Button primary disabled={blocked} onClick={apply}>确认执行</Button>
    </> : selected ? <>
      <Button disabled={busy} onClick={() => setSelected(null)}>返回列表</Button>
      <Button primary disabled={blocked} onClick={prepareSave}>预览修改</Button>
    </> : <><Button disabled={busy} onClick={onClose}>关闭</Button>
      <Button danger disabled={blocked || !health?.packs.length} onClick={() => rebind(null)}>全体重绑 UUID</Button></>}>
    <p className="muted break-all">{world.linkedPath ? "原目录模式：操作将修改原项目" : "副本模式：操作将修改此存档副本"} · {health?.path || world.path}</p>
    {running && <p className="world-hint">游戏运行中可浏览；请保存并退出游戏后再修改。</p>}
    <ErrorBox>{error || health?.readOnlyReason}</ErrorBox>
    {notice && <p role="status" className="break-all">{notice}</p>}
    {confirm ? <><p>{confirm.detail}</p><p>确认后先创建独立恢复备份，再写入列出的修改；文件发生变化时停止。</p></> :
    selected ? <fieldset disabled={blocked}>
      <Field label="模组名称"><input value={name} onChange={e => setName(e.target.value)} maxLength={80} /></Field>
      <Field label="版本" hint="包头版本，不改变模块版本"><input value={version} onChange={e => setVersion(e.target.value)} /></Field>
      <label className="pack-browser-check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />列入地图加载清单</label>
    </fieldset> : <>
      <div className="pack-browser-toolbar"><div><strong>{health?.summary.total ?? "—"} 个包</strong>
        <span>{health ? (health.ok ? "静态检查通过" : "发现 " + health.summary.issueCount + " 项提示") : "正在检查…"}</span></div>
        <Button disabled={busy} onClick={load}>重新检查</Button></div>
      <p className="muted">这里检查存档内的文件与启用清单；“已启用”不代表游戏已成功加载。外部启动配置与游戏运行结果需另行核对。</p>
      <div className="world-toolbar">
        <input aria-label="搜索存档模组" placeholder="名称、目录或 UUID" value={query} onChange={e => setQuery(e.target.value)} />
        <Select value={kind} onChange={setKind} options={[{value:"",label:"全部类型"},{value:"behavior",label:"行为包"},{value:"resource",label:"资源包"}]} />
        <Button disabled={blocked || !health?.issues.some(i => i.code === "version-mismatch")}
          onClick={() => setConfirm({ title: "确认同步清单版本", method: "sync-pack-versions", detail: "以当前包头版本更新已启用包的存档清单和工具箱登记。请先确认这批模组就是你要使用的版本。", args: {} })}>同步清单版本</Button>
        {onImport && <Button disabled={busy || running} onClick={onImport}>重新导入副本</Button>}
      </div>
      {!!health?.issues.length && <details className="pack-health-issues" open><summary>检查结果（{health.issues.length}）</summary>
        {health.issues.map((item, i) => <div className="world-hint" key={i}>
          <strong>{issueText[item.code] || item.code}</strong><p>{item.packName || item.packId || item.moduleId || item.kind}</p>
          {item.dependency && <small>依赖：{item.dependency}</small>}
          {(item.expected || item.actual) && <small>清单 {ver(item.expected)} → 当前 {ver(item.actual)}</small>}
          {item.packs && <small>{item.packs.join("、")}</small>}{item.detail && <small>{item.detail}</small>}
        </div>)}</details>}
      <div className="pack-browser-list">{filtered.map(pack => <div className="pack-browser-card" key={pack.kind + ":" + pack.packName}>
        <div className="pack-browser-info"><strong>{pack.name}</strong>
          <small>{pack.packName} · {pack.kind === "behavior" ? "行为包" : "资源包"} · {ver(pack.version)} · {pack.enabled ? "清单已启用" : "清单未启用"}</small>
          <small className="pack-browser-id">{pack.packId}</small>
          <details className="pack-browser-details"><summary>查看文件、模块与依赖</summary>
            <small className="break-all">{pack.path} / {pack.manifestFile}</small>
            <small>清单版本：{ver(pack.expectedVersion)}</small>
            {pack.modules.map((m,i) => <small key={i}>模块：{m.uuid || "无 UUID"} · {m.type} · {ver(m.version)}</small>)}
            {pack.dependencies.map((d,i) => <small key={i}>依赖：{d.uuid || d.moduleName || "未知"} · {ver(d.version)}</small>)}
          </details></div>
        <div className="world-toolbar"><Button disabled={busy} onClick={() => onContent?.(pack)}>编辑内容</Button><Button disabled={blocked} onClick={() => edit(pack)}>编辑</Button>
          <Button disabled={blocked} onClick={() => rebind(pack)}>重绑 UUID</Button></div>
      </div>)}</div>
      {health && !filtered.length && <p>没有符合条件的模组。</p>}
    </>}
  </Modal>;
}
