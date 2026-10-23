const key = (value) =>
  value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
function sharedSources(roots, sessions, ownId) {
  const result = [],
    seen = new Set();
  for (const other of sessions) {
    if (!other.running || other.id === ownId) continue;
    for (const a of roots || [])
      for (const b of other.sourceRoots || []) {
        const x = key(a),
          y = key(b);
        const common =
          x === y || x.startsWith(y + "/")
            ? a
            : y.startsWith(x + "/")
              ? b
              : null;
        if (!common) continue;
        const id = other.id + ":" + key(common);
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({
          path: common,
          sessionId: other.id,
          worldId: other.worldId,
          name: other.worldName || other.profileName,
        });
      }
  }
  return result;
}
module.exports = { sharedSources };
