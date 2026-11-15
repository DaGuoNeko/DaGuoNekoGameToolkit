const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { inspectSelection, verifySelection } = require("./file-selection.cjs");

async function targetIdentity(file) {
  try { return await inspectSelection(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function renameWithRetry(from, to) {
  const source = await inspectSelection(from);
  const target = await targetIdentity(to);
  const parents = await Promise.all([...new Set([path.dirname(from), path.dirname(to)])].map(directory => inspectSelection(directory, "directory")));
  const waits = [50, 100, 200, 300, 400];
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === waits.length) throw error;
      // 只重试未成功的重命名，不删目标，不重复业务写入；持续占用仍明确失败。
      await delay(waits[attempt]);
      await verifySelection(source);
      for (const parent of parents) await verifySelection(parent);
      const current = await targetIdentity(to);
      if (target?.identity !== current?.identity) throw Error("重命名目标已变化，未覆盖新内容");
    }
  }
}

module.exports = { renameWithRetry };
