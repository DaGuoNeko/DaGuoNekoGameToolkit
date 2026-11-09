const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { Database } = require("@jsprismarine/leveldb");
const { parseNbtRecord, MAX_BYTES } = require("./world-data-codec.cjs");
const { patchRecord } = require("./world-data-edit-codec.cjs");
const { readFile, safeDirectory, levelFormat } = require("./map-preview.cjs");
const { inspectSelection, verifySelection } = require("../../file-selection.cjs");
const { POLICY_FILE, validatePolicy } = require("./world-version-policy.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const idPattern = /^[a-f0-9-]{36}$/;
async function safeDatabase(root) {
  const directory = path.join(root, "db"); await safeDirectory(directory);
  for (const name of await fs.readdir(directory)) {
    const stat = await fs.lstat(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw Error("数据库含链接或非普通文件，拒绝写入");
  }
}
async function durableWrite(file, bytes, exclusive = false) {
  const temporary = exclusive ? file : file + "." + crypto.randomUUID() + ".tmp";
  const handle = await fs.open(temporary, "wx");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) {
    try { await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}
function lockMetadata(runtime, file) {
  if (process.platform !== "win32") throw Error("离线写入目前仅支持 Windows");
  const koffi = require(path.join(runtime, "native/koffi.node")), kernel = koffi.load("kernel32.dll");
  const open = kernel.func("CreateFileW", "intptr_t", ["str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "void *"]);
  const close = kernel.func("CloseHandle", "bool", ["intptr_t"]);
  const handle = open(file, 0xc0000000, 0, null, 4, 0x80, null);
  if (handle === -1 || handle === -1n) throw Error("存档数据库被占用或不可写，请保存退出游戏后重试");
  return () => { close(handle); kernel.unload(); };
}
class WorldDataEdits {
  constructor(dataRoot, runtime, { guard, reserve } = {}) {
    this.root = path.join(dataRoot, "world-data-backups"); this.runtime = runtime;
    this.guard = guard; this.reserve = reserve; this.plans = new Map(); this.queue = Promise.resolve();
  }
  async target(target) {
    if (!target?.editable || target.format !== "bedrock" || /\.(zip|mcworld)$/i.test(target.source)) throw Error("此来源仅支持查看；请先将基岩/网易存档解压到独立目录再编辑");
    await safeDirectory(target.source); await safeDatabase(target.source);
    const e = target.evidence;
    if (!e || !Number.isSafeInteger(e.offset) || e.offset < 0 || !/^[a-f0-9]{64}$/.test(e.revision || "")) throw Error("对象缺少可写的原始记录证据，请重新扫描");
    if (target.kind === "item") throw Error("物品定义应在模组源码中编辑");
    const storage = e.key === "level.dat" ? "level" : "db";
    const key = storage === "db" ? e.key.startsWith("hex:") ? Buffer.from(e.key.slice(4), "hex") : Buffer.from(e.key, "utf8") : null;
    if (key && (!key.length || key.length > 4096)) throw Error("数据库键无效");
    return { source: target.source, storage, key, evidence: e, name: target.name, identity: await inspectSelection(target.source, "directory") };
  }
  async readRaw(target) {
    await verifySelection(target.identity);
    if (target.storage !== "db") {
      const file = path.join(target.source, target.storage === "level" ? "level.dat" : POLICY_FILE);
      try { return await readFile(file, target.storage === "level" ? MAX_BYTES : 8192); }
      catch (error) { if (target.storage === "policy" && error.code === "ENOENT") return null; throw error; }
    }
    const db = await Database.open(path.join(target.source, "db"), { readOnly: true, createIfMissing: false });
    try { const value = db.get(target.key); if (!value) throw Error("源记录已不存在"); return Buffer.from(value); }
    finally { await db.close(); }
  }
  body(target, raw) {
    if (target.storage === "level") {
      if (levelFormat(raw) !== "bedrock" || raw.readUInt32LE(4) !== raw.length - 8) throw Error("level.dat 头部或长度无效，拒绝写入");
      return raw.subarray(8);
    }
    return raw;
  }
  async read(target, field) {
    const actual = await this.target(target), raw = await this.readRaw(actual), body = this.body(actual, raw);
    if (hash(body) !== actual.evidence.revision) throw Error("存档已变化，请重新扫描后编辑");
    const absoluteField = actual.evidence.field + field;
    const parsed = parseNbtRecord(body.subarray(actual.evidence.offset), { worldScript: actual.evidence.key === "scriptData", capture: true });
    const scriptPath = Object.keys(parsed.scripts).find(key => absoluteField === key || absoluteField.startsWith(key + "/"));
    const node = scriptPath ? parsed.scripts[scriptPath].nodes[absoluteField] : parsed.nodes[absoluteField];
    if (!node) throw Error("字段不存在");
    if (Buffer.byteLength(JSON.stringify(node.value)) > 2 * 1024 * 1024) throw Error("字段过大，请选择更小的内部字段编辑");
    return { value: node.value, field, type: parsed.types[absoluteField] || typeof node.value, revision: actual.evidence.revision, name: actual.name };
  }
  remember(plan) {
    for (const [id, item] of this.plans) if (item.expires < Date.now()) this.plans.delete(id);
    while (this.plans.size >= 8) this.plans.delete(this.plans.keys().next().value);
    const token = crypto.randomUUID(); this.plans.set(token, { ...plan, expires: Date.now() + 10 * 60 * 1000 });
    return { token, changes: plan.changes, source: plan.target.source, beforeBytes: plan.before?.length || 0, afterBytes: plan.after?.length || 0 };
  }
  async prepare(target, changes) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 50) throw Error("一次只能修改 1–50 个字段");
    const actual = await this.target(target), before = await this.readRaw(actual), body = this.body(actual, before);
    if (hash(body) !== actual.evidence.revision) throw Error("存档已变化，请重新扫描后编辑");
    let edited = body; const preview = [];
    for (const change of changes) {
      if (typeof change?.field !== "string") throw Error("编辑字段无效");
      const field = actual.evidence.field + change.field;
      if (/^\/(MinimumCompatibleClientVersion|lastOpenedWithVersion|baseGameVersion)$/.test(field)) {
        if (actual.storage !== "level") throw Error("版本标记只能在世界元数据中修改");
        if (field !== "/baseGameVersion" && (!Array.isArray(change.value) || change.value.length < 3 || change.value.length > 5 || change.value.some(n => !Number.isInteger(n) || n < 0 || n > 2147483647))) throw Error("兼容版本需为 3–5 个非负整数分量");
      }
      const patched = patchRecord(edited.subarray(actual.evidence.offset), field, change.value, { worldScript: actual.evidence.key === "scriptData" });
      edited = Buffer.concat([edited.subarray(0, actual.evidence.offset), patched.bytes]);
      preview.push({ field, before: patched.before, after: patched.after, type: patched.type });
    }
    let after = edited;
    if (actual.storage === "level") { const header = Buffer.from(before.subarray(0, 8)); header.writeUInt32LE(edited.length, 4); after = Buffer.concat([header, edited]); }
    return this.remember({ target: actual, before, after, changes: preview });
  }
  async preparePolicy(source, value, expected) {
    validatePolicy(value);
    const target = { source, storage: "policy", identity: await inspectSelection(source, "directory") };
    await safeDirectory(path.join(source, "db"));
    const before = await this.readRaw(target), previous = before ? validatePolicy(JSON.parse(before.toString("utf8"))) : { schema: 1, minimum: "", maximum: "" };
    if (JSON.stringify(previous) !== JSON.stringify(expected)) throw Error("启动范围已变化，请重新扫描");
    if (JSON.stringify(previous) === JSON.stringify(value)) throw Error("启动范围没有变化");
    return this.remember({ target, before, after: Buffer.from(JSON.stringify(value, null, 2) + "\n"), changes: [{ field: "工具箱允许启动版本", before: previous, after: value }] });
  }
  run(task) { const result = this.queue.catch(() => {}).then(task); this.queue = result; return result; }
  async writeLocked(target, before, after, onBackup) {
    await verifySelection(target.identity);
    await safeDatabase(target.source);
    const lock = path.join(target.source, "db", "LOCK"), stat = await fs.lstat(lock).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error("数据库 LOCK 不是普通文件");
    await this.guard(target.source);
    const lease = await this.reserve(target.source);
    let db, release;
    try {
      await safeDatabase(target.source);
      if (target.storage === "db") db = await Database.open(path.join(target.source, "db"), { createIfMissing: false });
      else release = lockMetadata(this.runtime, lock);
      const current = db ? Buffer.from(db.get(target.key) || []) : await this.readRaw(target);
      if ((current === null) !== (before === null) || current && !current.equals(before)) throw Error("保存目标已变化，未覆盖新内容，请重新扫描");
      await verifySelection(target.identity);
      await onBackup();
      const fresh = db ? Buffer.from(db.get(target.key) || []) : await this.readRaw(target);
      if ((fresh === null) !== (before === null) || fresh && !fresh.equals(before)) throw Error("备份期间目标已变化，未执行写入");
      if (db) { db.put(target.key, after); await db.flush(); }
      else {
        const file = path.join(target.source, target.storage === "level" ? "level.dat" : POLICY_FILE);
        if (after === null) await fs.unlink(file); else await durableWrite(file, after);
      }
      const check = db ? Buffer.from(db.get(target.key) || []) : await this.readRaw(target);
      if ((check === null) !== (after === null) || check && !check.equals(after)) throw Error("写后校验失败，请保留备份并重新读取；不要重复保存");
    } finally {
      try { if (db) await db.close(); } finally { release?.(); await lease.stop(); }
    }
  }
  apply(token, confirmed) {
    return this.run(async () => {
      const plan = this.plans.get(token);
      if (confirmed !== true || !plan || plan.expires < Date.now()) throw Error("请重新预览并确认保存");
      this.plans.delete(token);
      await fs.mkdir(this.root, { recursive: true }); await safeDirectory(this.root);
      const backupId = crypto.randomUUID(), directory = path.join(this.root, backupId);
      const journal = { schema: 1, backupId, source: plan.target.source, identity: plan.target.identity, storage: plan.target.storage, key: plan.target.key?.toString("hex"), beforeHash: plan.before && hash(plan.before), afterHash: plan.after && hash(plan.after), createdAt: new Date().toISOString(), state: "prepared" };
      let backedUp = false;
      try {
        await this.writeLocked(plan.target, plan.before, plan.after, async () => {
          await fs.mkdir(directory); await safeDirectory(directory);
          if (plan.before) await durableWrite(path.join(directory, "before.bin"), plan.before, true);
          await durableWrite(path.join(directory, "after.bin"), plan.after, true);
          await durableWrite(path.join(directory, "journal.json"), Buffer.from(JSON.stringify(journal, null, 2)), true); backedUp = true;
        });
        journal.state = "applied"; await durableWrite(path.join(directory, "journal.json"), Buffer.from(JSON.stringify(journal, null, 2)));
        return { backupId, source: plan.target.source, backupDirectory: directory };
      } catch (error) {
        if (backedUp) { journal.state = "needs-review"; await durableWrite(path.join(directory, "journal.json"), Buffer.from(JSON.stringify(journal, null, 2))).catch(() => {}); error.message += "；已保留备份 " + backupId + "，请重新扫描确认结果，勿直接重放保存"; }
        throw error;
      }
    });
  }
  restore(source, backupId, confirmed) {
    return this.run(async () => {
      if (confirmed !== true || !idPattern.test(backupId)) throw Error("请确认恢复有效备份");
      await safeDirectory(this.root); const directory = path.join(this.root, backupId); await safeDirectory(directory);
      const journal = JSON.parse((await readFile(path.join(directory, "journal.json"), 16384)).toString("utf8"));
      if (journal.source !== source || journal.backupId !== backupId || journal.state !== "applied" || !["db", "level", "policy"].includes(journal.storage)) throw Error("备份归属或状态不允许自动恢复");
      const before = journal.beforeHash ? await readFile(path.join(directory, "before.bin"), MAX_BYTES) : null, after = await readFile(path.join(directory, "after.bin"), MAX_BYTES);
      if (before && hash(before) !== journal.beforeHash || hash(after) !== journal.afterHash) throw Error("备份校验失败");
      await this.writeLocked({ source, storage: journal.storage, key: journal.key ? Buffer.from(journal.key, "hex") : null, identity: journal.identity }, after, before, async () => {});
      journal.state = "restored"; await durableWrite(path.join(directory, "journal.json"), Buffer.from(JSON.stringify(journal, null, 2)));
      return { restored: true, source };
    });
  }
}
module.exports = { WorldDataEdits };
