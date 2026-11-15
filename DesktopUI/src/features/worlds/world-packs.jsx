import React, { useEffect, useRef, useState } from "react";
import { Button, ErrorBox, Modal } from "../../app/ui.jsx";
import { groupMods } from "../../../shared/mod-groups.cjs";

const listScroll = new Map();

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

export function WorldPacks({ world, onClose, onChanged, onImport, onContent, running, inline = false }) {
  const [health, setHealth] = useState(null);
  const [confirm, setConfirm] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const listRef = useRef(null);
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
  const apply = async () => {
    if (pending.current || blocked || !confirm) return;
    pending.current = true; setBusy(true); setError("");
    const action = confirm;
    try {
      const response = await call("worlds." + action.method, {
        worldId: world.id, revision: health.revision, confirmed: true, ...action.args,
      });
      setConfirm(null);
      setNotice(response.changed ? "已保存。恢复备份：" + response.backupPath : "没有需要修改的内容");
      await read(); await onChanged?.();
    } catch (e) {
      setError(e.message); setConfirm(null);
    } finally { pending.current = false; setBusy(false); }
  };
  const rebind = pack => setConfirm({ title: pack ? "确认重绑模组 UUID" : "确认全体重绑 UUID",
    method: "rebind-pack-uuids", args: pack ? { packId: pack.packId } : {},
    detail: "为" + (pack?.packName || "存档内全部包（包含未启用包）") + "生成新的包和模块 UUID，并同步存档清单及存档内依赖。保持启用顺序，不新增启用包。存档外引用与脚本中的自定义 UUID 不会自动改写。" });
  const needle = query.trim().toLowerCase();
  const mods = groupMods(health?.packs || []).filter(mod => !needle || [mod.name, mod.behavior?.packName, mod.behavior?.packId, mod.resource?.packName, mod.resource?.packId].join(" ").toLowerCase().includes(needle));
  const half = (pack, label) => pack ? label + " " + pack.packName + " · " + ver(pack.version) + " · " + (pack.enabled ? "清单已启用" : "清单未启用") : "无" + label;
  useEffect(() => {
    const node = listRef.current;
    if (!node) return undefined;
    const apply = () => { node.scrollTop = listScroll.get(world.id) || 0; };
    apply();
    const frame = requestAnimationFrame(apply);
    const remember = () => { if (node.scrollHeight > node.clientHeight) listScroll.set(world.id, node.scrollTop); };
    node.addEventListener("scroll", remember, { passive: true });
    return () => { cancelAnimationFrame(frame); remember(); node.removeEventListener("scroll", remember); };
  }, [world.id, health]);
  return <Modal inline={inline} wide title={confirm?.title || ("存档模组：" + world.name)}
    busy={busy} onClose={() => !busy && onClose()}
    footer={confirm ? <>
      <Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button>
      <Button primary disabled={blocked} onClick={apply}>确认执行</Button>
    </> : <><Button disabled={busy} onClick={onClose}>关闭</Button>
      <Button danger disabled={blocked || !health?.packs.length} onClick={() => rebind(null)}>全体重绑 UUID</Button></>}>
    <p className="muted break-all">{world.linkedPath ? "原目录模式：操作将修改原项目" : "副本模式：操作将修改此存档副本"} · {health?.path || world.path}</p>
    {running && <p className="world-hint">游戏运行中可浏览；请保存并退出游戏后再修改。</p>}
    <ErrorBox>{error || health?.readOnlyReason}</ErrorBox>
    {notice && <p role="status" className="break-all">{notice}</p>}
    {confirm && <><p>{confirm.detail}</p><p>确认后先创建独立恢复备份，再写入列出的修改；文件发生变化时停止。</p></>}
    <>
      <div className="pack-browser-toolbar"><div><strong>{health ? mods.length : "—"} 个模组</strong>
        <span>{health ? (health.ok ? "静态检查通过" : "发现 " + health.summary.issueCount + " 项提示") : "正在检查…"}</span></div>
        <Button disabled={busy} onClick={load}>重新检查</Button></div>
      <p className="muted">这里检查存档内的文件与启用清单；“已启用”不代表游戏已成功加载。外部启动配置与游戏运行结果需另行核对。</p>
      <div className="world-toolbar">
        <input aria-label="搜索存档模组" placeholder="名称、目录或 UUID" value={query} onChange={e => setQuery(e.target.value)} />
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
      <div className="pack-browser-list" ref={listRef}>{mods.map(mod => <div className="pack-browser-card" key={mod.packIds.join(":")}>
        <div className="pack-browser-info"><strong>{mod.name}</strong>
          <small>{half(mod.behavior, "行为包")} · {half(mod.resource, "资源包")}</small>
          <details className="pack-browser-details"><summary>查看两边的文件与依赖</summary>
            {[mod.behavior, mod.resource].filter(Boolean).map(pack => <div key={pack.packId}>
              <small>{pack.kind === "behavior" ? "行为包" : "资源包"} · {pack.packId}</small>
              <small className="break-all">{pack.path} / {pack.manifestFile}</small>
              {pack.modules.map((item, index) => <small key={index}>模块：{item.uuid || "无 UUID"} · {item.type} · {ver(item.version)}</small>)}
              {pack.dependencies.map((item, index) => <small key={index}>依赖：{item.uuid || item.moduleName || "未知"} · {ver(item.version)}</small>)}
            </div>)}
          </details></div>
        <div className="world-toolbar"><Button disabled={busy} onClick={() => onContent?.(mod)}>编辑内容</Button>
          {mod.behavior && <Button disabled={blocked} onClick={() => rebind(mod.behavior)}>重绑行为包</Button>}
          {mod.resource && <Button disabled={blocked} onClick={() => rebind(mod.resource)}>重绑资源包</Button>}
        </div>
      </div>)}</div>
      {health && !mods.length && <p>没有符合条件的模组。</p>}
    </>
  </Modal>;
}
