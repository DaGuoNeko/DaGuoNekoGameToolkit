function enginePath(nodes, node) {
  const names = [];
  let depth = 0;
  while (node) {
    if (++depth > 100) throw Error("控件层级过深");
    names.unshift(node.name);
    node = nodes[node.parent];
  }
  return "/" + names.join("/");
}
// The engine's materialized controls are for inspection; only original source
// nodes retain a write path. Never save an expanded inherited tree as source.
function withEngineTree(source, tree) {
  if (!source || !tree) return source;
  const rootName = tree.UIHeader?.mCurrent || source.current?.split("@")[0];
  const rootKey = Object.keys(tree).find((k) => k.split("@")[0] === rootName);
  const root = tree[rootKey];
  if (!root || typeof root !== "object") return source;
  const writable = new Map(
    source.nodes.map((n) => [enginePath(source.nodes, n), n]),
  );
  const nodes = [];
  function walk(name, value, parent, prefix, depth) {
    if (nodes.length >= 20000 || depth > 80)
      throw Error("引擎控件树超过预览上限");
    const path = prefix + "/" + name,
      original = writable.get(path),
      index = nodes.length;
    nodes.push({
      id: original?.id || "engine:" + path,
      name,
      key: original?.key || name,
      parent,
      depth,
      path: original?.path || null,
      value: { ...value, ...(original?.value || {}) },
      source: original?.source || value,
      enginePath: path,
    });
    if (Array.isArray(value.controls))
      for (const entry of value.controls) {
        if (!entry || typeof entry !== "object") continue;
        for (const [key, child] of Object.entries(entry))
          if (child && typeof child === "object")
            walk(
              child.mName || key.split("@")[0],
              child,
              index,
              path,
              depth + 1,
            );
      }
  }
  walk(rootName, root, -1, "", 0);
  return { ...source, nodes, current: rootKey, warnings: [] };
}
module.exports = { enginePath, withEngineTree };
