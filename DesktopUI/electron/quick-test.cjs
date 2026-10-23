function validateModIds(ids) {
  if (
    !Array.isArray(ids) ||
    ids.length > 1000 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
  )
    throw Error("快速测试模组选择无效，请刷新后重试");
  return [...ids];
}
async function quickTestMods(library, selection) {
  const ids = validateModIds(selection.modIds);
  if (!library) throw Error("模组库尚未就绪");
  const snapshot = await library.list();
  if (selection.revision !== snapshot.revision)
    throw Error("模组库已变化，请关闭并重新打开快速测试后再选择");
  return ids.map((id) => {
    const mod = snapshot.mods.find((m) => m.id === id);
    if (!mod) throw Error("选择的模组已移出模组库，请刷新");
    if (!mod.available || mod.error) throw Error(`模组目录不可用：${mod.name}`);
    return { path: mod.path, enabled: true, hot_reload: true };
  });
}
module.exports = { validateModIds, quickTestMods };
