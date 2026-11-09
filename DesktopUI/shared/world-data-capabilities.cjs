// 按已启用包及已知脚本布局识别，目录名和遗留存档键不能证明模组已装载。
const definitions = {
  npc: { name: "自定义 NPC", scripts: ["customNPCScripts/modMain.py", "customNPCScripts/customNPCServerSystem/customNPCServerSystem.py"], kinds: ["npc", "template", "dialogue"] },
  quest: { name: "任务引擎", scripts: ["quest_engineScripts/modMain.py", "quest_engineScripts/quest_engineServerSystem/SerContQuest.py"], kinds: ["quest", "questGroup", "objective", "progress"] },
  library: { name: "前置指令库", scripts: ["DAGUOMIAO_API_MODScripts/modMain.py", "DAGUOMIAO_API_MODScripts/DAGUOMIAO_API_MODServerSystem/CommandLibrary.py"], kinds: ["library"] },
  attributes: { name: "自定义属性", scripts: ["custom_attrScripts/modMain.py", "custom_attrScripts/custom_attrServerSystem/custom_attrServerSystem.py"], kinds: ["attributes"] },
};
function detectCapabilities(packs, bindings) {
  return Object.fromEntries(Object.entries(definitions).map(([id, definition]) => {
    const candidates = packs.filter(pack => pack.kind === "behavior" && definition.scripts.every(file => pack.assets?.some(asset => asset.relative === file && asset.size > 0)));
    const enabled = candidates.filter(pack => bindings?.some(binding => binding.pack_id?.toLowerCase() === pack.id && JSON.stringify(binding.version) === JSON.stringify(pack.version)));
    const ambiguous = enabled.some(pack => packs.filter(other => other.id === pack.id).length !== 1 || bindings.filter(binding => binding.pack_id?.toLowerCase() === pack.id).length !== 1);
    const state = bindings === null ? "unconfirmed" : ambiguous || enabled.length > 1 ? "ambiguous" : enabled.length === 1 ? "enabled"
      : candidates.some(pack => bindings.some(binding => binding.pack_id?.toLowerCase() === pack.id)) ? "version-mismatch" : "disabled";
    return [id, { name: definition.name, state, packs: candidates.map(pack => ({ id: pack.id, name: pack.name, version: pack.version })), basis: "world_behavior_packs.json + manifest UUID/版本 + 已知脚本布局" }];
  }));
}
const enabled = (capabilities, id) => capabilities?.[id]?.state === "enabled";
function availableKinds(capabilities, extraData = false) {
  return ["world", "player", "command", "container", "entity", "blockEntity", "structure", "item",
    ...Object.entries(definitions).flatMap(([id, definition]) => enabled(capabilities, id) ? definition.kinds : []), ...(extraData ? ["extra"] : [])];
}
module.exports = { definitions, detectCapabilities, enabled, availableKinds };
