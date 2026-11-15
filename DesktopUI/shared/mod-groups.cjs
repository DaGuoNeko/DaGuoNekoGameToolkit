function stem(pack) {
  return String(pack.packName || pack.name || "")
    .replace(/[._-]?(behavior_packs?|resource_packs?|behavior|resource|bp|rp)$/i, "")
    .replace(/[BR]$/, "")
    .toLowerCase();
}

// 行为包和资源包是同一个模组的两半。只在文件夹名或显示名能唯一对上时合并。
function groupMods(packs) {
  const list = Array.isArray(packs) ? packs : [];
  const used = new Set();
  const resources = list.filter(pack => pack.kind === "resource");
  const byStem = new Map();
  const byName = new Map();
  for (const pack of resources) {
    const folder = stem(pack);
    const named = String(pack.name || "").trim().toLowerCase();
    if (!byStem.has(folder)) byStem.set(folder, []);
    byStem.get(folder).push(pack);
    if (!byName.has(named)) byName.set(named, []);
    byName.get(named).push(pack);
  }
  const mods = [];
  const push = (name, behavior, resource) => {
    const halves = [behavior, resource].filter(Boolean);
    mods.push({
      name: name || halves[0]?.packName || "未命名模组",
      behavior: behavior || null,
      resource: resource || null,
      packIds: halves.map(pack => pack.packId).filter(Boolean),
    });
  };
  for (const pack of list.filter(item => item.kind === "behavior")) {
    let match = (byStem.get(stem(pack)) || []).find(item => !used.has(item));
    if (!match) {
      const named = (byName.get(String(pack.name || "").trim().toLowerCase()) || []).filter(item => !used.has(item));
      if (named.length === 1) match = named[0];
    }
    if (match) used.add(match);
    push(pack.name || match?.name, pack, match);
  }
  for (const pack of resources) if (!used.has(pack)) push(pack.name, null, pack);
  for (const pack of list) {
    if (pack.kind === "behavior" || pack.kind === "resource") continue;
    mods.push({ name: pack.name || pack.packName || "未命名模组", behavior: null, resource: null, packIds: [pack.packId].filter(Boolean) });
  }
  return mods;
}

module.exports = { groupMods, stem };
