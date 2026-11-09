const { parentPort } = require("node:worker_threads");
const { compareWorldData, queryWorldData, exportWorldData } = require("../../../shared/world-data-model.cjs");
const snapshots = new Map(), indexes = new Map();
const get = id => { const value = snapshots.get(id); if (!value) throw Error("数据快照已过期，请重新扫描"); return value; };
parentPort.on("message", ({ id, operation, args }) => {
  try {
    let result;
    if (operation === "put") {
      snapshots.set(args.requestId, args.snapshot);
      indexes.delete(args.requestId);
      while (snapshots.size > 4) { const oldest = snapshots.keys().next().value; snapshots.delete(oldest); indexes.delete(oldest); }
      result = true;
    } else if (operation === "compare") result = compareWorldData(get(args.left), get(args.right));
    else if (operation === "export") {
      const snapshot = get(args.requestId);
      result = exportWorldData(args.compareWith ? compareWorldData(snapshot, get(args.compareWith)) : snapshot, args.format, args.kind);
    } else if (operation === "query") {
      const snapshot = get(args.requestId), view = args.view || "objects";
      let index;
      if (args.query && ["objects", "relations"].includes(view)) {
        const saved = indexes.get(args.requestId) || {};
        index = saved[view] || (saved[view] = snapshot[view].map(row => JSON.stringify(row).toLowerCase()));
        indexes.set(args.requestId, saved);
      }
      result = queryWorldData(snapshot, args, index);
    } else throw Error("无效世界数据计算操作");
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
