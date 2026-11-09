import React, { useEffect } from "react";
import { Button, ErrorBox } from "../../app/ui.jsx";
import { WorkspaceTabs, useWorkspaceState } from "../../app/workspaces.jsx";
import { WorldData } from "./world-data.jsx";
import { MapPreview } from "./map-preview.jsx";
import { WorldPacks } from "./world-packs.jsx";
import { ArchitectureImport } from "./architecture-import.jsx";
import { ContentBrowserV2 } from "../mods/mod-library.jsx";

export function WorldWorkspace({ world, worlds, initialTab = "overview", request, overview, actions, primaryAction, onBack, onSettings, onChanged, onImport, running, onActivity }) {
  const scope = world?.id || "external";
  const [tab, setTab] = useWorkspaceState("world-workspace:" + scope, initialTab);
  const [external, setExternal] = useWorkspaceState("external-world", { source: "", worldId: "" });
  const [snapshot, setSnapshot] = useWorkspaceState("world-data-snapshot:" + scope, null);
  const [selected, setSelected] = useWorkspaceState("world-data-selected:" + scope, "");
  const [mapState, setMapState] = useWorkspaceState("world-map:" + scope, null);
  const [focus, setFocus] = useWorkspaceState("world-map-focus:" + scope, null);
  const [pack, setPack] = useWorkspaceState("world-pack-content:" + scope, null);
  const [terrain, setTerrain] = useWorkspaceState("world-terrain:" + scope, null);
  useEffect(() => { if (request?.tab) { setTab(request.tab); setTerrain(null); } }, [request?.id]);
  const source = world ? { source: world.path, worldId: world.id } : external;
  const data = snapshot?.source === source.source ? snapshot : null;
  const tabs = world ? [["overview", "概览"], ["map", "地图"], ["data", "世界数据"], ["packs", "模组"], ["settings", "设置"]] : [["map", "地图"], ["data", "世界数据"]];
  const navigate = next => { setTerrain(null); setTab(next); };
  return <div className="world-workspace">
    <nav className="world-workspace-nav" aria-label="存档位置">
      <Button icon="arrow" className="world-exit" aria-label="返回存档列表" title="退出当前工作区，返回存档库" onClick={onBack}>{world ? "退出存档" : "退出查看"}</Button>
      <span aria-hidden="true">/</span><span className="world-workspace-location">{world?.name || "外部存档"}</span>
    </nav>
    <header className="world-context"><div><h1>{world?.name || "外部存档查看"}</h1><p>{world ? world.linkedPath ? "原目录模式 · 游戏进度写回原存档" : "独立副本" : "只读查看 · 不登记、不启动"}</p><small className="world-location" title={source.source}>{source.source || "请选择来源"}</small></div>
      <div className="world-context-actions">{primaryAction}<Button onClick={() => setTerrain({ targetWorldId: world?.id || "" })}>地形与建筑导入</Button></div>
    </header>
    <WorkspaceTabs label="存档工作区" tabs={tabs} value={terrain ? "terrain" : tab} onChange={navigate} />
    <ErrorBox>{world?.error}</ErrorBox>
    {terrain ? <ArchitectureImport inline worldId={terrain.targetWorldId} worlds={worlds} sourceSelection={terrain.sourceSelection} onClose={() => setTerrain(null)} /> : <>
      {tab === "overview" && overview}
      {tab === "map" && <MapPreview key={source.source} inline lockedSource={!!world} worldId={source.worldId} initialSource={source.source} worlds={worlds} onSource={setExternal} remembered={mapState} onRemember={value => { setMapState(value); setFocus(null); }} focus={focus} markers={data?.objects || []}
        initialDimension={focus?.dimension || source.dimension || mapState?.dimension || "overworld"} onObject={id => { setSelected(id); setTab("data"); }} onTerrain={setTerrain} onClose={world ? () => navigate("overview") : onBack} />}
      {tab === "data" && <WorldData key={source.source} {...source} data={data} onData={setSnapshot} selectedId={selected} onSelected={setSelected} onSource={setExternal} onLocate={object => { setFocus({ position: object.position, dimension: ["overworld", "nether", "the_end"][object.dimension] }); setTab("map"); }} />}
      {tab === "packs" && world && (pack ? <><div className="workspace-actions"><Button onClick={() => setPack(null)}>返回存档模组</Button></div><ContentBrowserV2 key={pack.packId} request={{ worldId: world.id, worldName: world.name, packId: pack.packId, packName: pack.packName }} onManage={() => setPack(null)} /></> : <WorldPacks inline world={world} running={running} onChanged={onChanged} onImport={onImport} onContent={setPack} onClose={() => navigate("overview")} />)}
      {tab === "settings" && world && <><section className="section"><h2>存档设置</h2><p>世界选项、启动配置绑定与自动操作归当前存档。启动配置是可复用模板，修改后影响下一次运行。</p><Button primary onClick={onSettings}>编辑存档设置</Button></section>{actions}</>}
    </>}
  </div>;
}
