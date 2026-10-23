const modPath = (entry) => (typeof entry === "string" ? entry : entry.path);
const pathKey = (value) =>
  value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
function modRows(catalog, entries, snapshot) {
  const resolved = new Map(
    (snapshot?.config?.included_mod_dirs || []).map((entry, i) => [
      modPath(entry),
      snapshot.resolvedModPaths?.[i] || modPath(entry),
    ]),
  );
  const rows = catalog.map((m) => ({
    ...m,
    key: pathKey(m.path),
    indexes: [],
  }));
  const byPath = new Map(rows.map((row) => [row.key, row]));
  entries.forEach((entry, index) => {
    const original = modPath(entry),
      full = resolved.get(original) || original,
      key = pathKey(full);
    let row = byPath.get(key);
    if (!row) {
      row = {
        key,
        path: full,
        name: full.split(/[\\/]/).filter(Boolean).at(-1) || full,
        indexes: [],
        local: true,
      };
      byPath.set(key, row);
      rows.push(row);
    }
    row.indexes.push(index);
  });
  return rows.map((row) => ({
    ...row,
    enabled: row.indexes.some(
      (i) => typeof entries[i] === "string" || entries[i].enabled !== false,
    ),
    hotReload:
      row.indexes.length === 0 ||
      row.indexes.some(
        (i) =>
          typeof entries[i] === "string" || entries[i].hot_reload !== false,
      ),
  }));
}
function setModOption(entries, row, option, value) {
  if (!row.indexes.length)
    return option === "enabled" && value
      ? [...entries, { path: row.path, enabled: true, hot_reload: true }]
      : entries;
  const indexes = new Set(row.indexes);
  return entries.map((entry, index) =>
    !indexes.has(index)
      ? entry
      : {
          ...(typeof entry === "string"
            ? { path: entry, enabled: true, hot_reload: true }
            : entry),
          [option]: value,
        },
  );
}
module.exports = { modRows, setModOption };
