// Window IPC transfers changed fields and parent pages; a full snapshot is only
// needed for initial ownership handoff or recovery after a failed transfer.
function diffCache(previous, current) {
  if (!previous) return { replace: current };
  const fields = {};
  for (const key of Object.keys(current))
    if (key !== "pages" && current[key] !== previous[key])
      fields[key] = current[key];
  const patch = { fields };
  if (current.pages !== previous.pages) {
    const set = {},
      remove = [];
    for (const key of Object.keys(current.pages || {}))
      if (current.pages[key] !== previous.pages?.[key])
        set[key] = current.pages[key];
    for (const key of Object.keys(previous.pages || {}))
      if (!Object.hasOwn(current.pages || {}, key)) remove.push(key);
    if (Object.keys(set).length || remove.length) patch.pages = { set, remove };
  }
  return patch;
}
function applyCache(previous, patch) {
  if (patch.replace) return patch.replace;
  if (!previous) throw Error("调试缓存需要重新同步");
  const next = { ...previous, ...patch.fields };
  if (patch.pages) {
    next.pages = { ...previous.pages, ...patch.pages.set };
    for (const key of patch.pages.remove || []) delete next.pages[key];
  }
  return next;
}
module.exports = { diffCache, applyCache };
