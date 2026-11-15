const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { renameWithRetry } = require("../electron/file-rename.cjs");
const { atomicWrite } = require("../electron/services.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");

function lockFile(file, directory = false) {
  const koffi = require(path.resolve("runtime/native/koffi.node"));
  const dll = koffi.load("kernel32.dll");
  const open = dll.func("CreateFileW", "intptr_t", ["str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "void *"]);
  const close = dll.func("CloseHandle", "bool", ["intptr_t"]);
  // 允许读写但不给 FILE_SHARE_DELETE，真实复现 Windows 扫描/读取占用。
  let handle = open(file, 0x80000000, 3, null, 3, directory ? 0x02000000 : 0x80, null);
  assert.notEqual(handle, -1); assert.notEqual(handle, -1n);
  return () => { if (handle !== null) { close(handle); handle = null; dll.unload(); } };
}

test("atomic write waits for an actual Windows sharing lock without exposing a missing target", { skip: process.platform !== "win32" }, async () => {
  const target = artifactPath("temporary-lock/target.json");
  await fs.writeFile(target, "old");
  const unlock = lockFile(target), timer = setTimeout(unlock, 180);
  try {
    const write = atomicWrite(target, "new");
    assert.equal(await fs.readFile(target, "utf8"), "old");
    await write;
    assert.equal(await fs.readFile(target, "utf8"), "new");
    assert.deepEqual(await fs.readdir(path.dirname(target)), ["target.json"]);
  } finally { clearTimeout(timer); unlock(); }
});

test("directory rename handles a short sharing lock and preserves the directory identity", { skip: process.platform !== "win32" }, async () => {
  const source = artifactPath("directory/source"), target = artifactPath("directory/destination");
  await fs.mkdir(source); await fs.writeFile(path.join(source, "keep.txt"), "keep");
  const before = await fs.stat(source, { bigint: true });
  const unlock = lockFile(source, true), timer = setTimeout(unlock, 120);
  try {
    await renameWithRetry(source, target);
    assert.equal((await fs.stat(target, { bigint: true })).ino, before.ino);
    assert.equal(await fs.readFile(path.join(target, "keep.txt"), "utf8"), "keep");
  } finally { clearTimeout(timer); unlock(); }
});

test("persistent lock fails after bounded retries and keeps old target and source", { skip: process.platform !== "win32" }, async () => {
  const source = artifactPath("persistent/source.tmp"), target = artifactPath("persistent/target.json");
  await fs.writeFile(source, "new"); await fs.writeFile(target, "old");
  const unlock = lockFile(target);
  try {
    await assert.rejects(renameWithRetry(source, target), error => ["EPERM", "EACCES", "EBUSY"].includes(error.code));
    assert.equal(await fs.readFile(source, "utf8"), "new"); assert.equal(await fs.readFile(target, "utf8"), "old");
  } finally { unlock(); }
});

test("target or source changes during retry abort instead of overwriting concurrent work", { skip: process.platform !== "win32" }, async t => {
  for (const which of ["target", "source"]) {
    const source = artifactPath(which + "-change/source.tmp"), target = artifactPath(which + "-change/target.json");
    await fs.writeFile(source, "new"); await fs.writeFile(target, "old");
    const rename = fs.rename.bind(fs); let calls = 0;
    const mock = t.mock.method(fs, "rename", async (...args) => {
      calls++;
      if (calls === 1) { await fs.writeFile(which === "target" ? target : source, "concurrent change"); throw Object.assign(Error("sharing violation"), { code: "EPERM" }); }
      return rename(...args);
    });
    try {
      await assert.rejects(renameWithRetry(source, target), /变化/);
      assert.equal(calls, 1);
      assert.equal(await fs.readFile(target, "utf8"), which === "target" ? "concurrent change" : "old");
    } finally { mock.mock.restore(); }
  }
});

test("nonsharing failures never retry; missing source and redirected parents remain errors", async t => {
  const source = artifactPath("other/source.tmp"), target = artifactPath("other/target.json");
  await fs.writeFile(source, "new");
  const mock = t.mock.method(fs, "rename", async () => { throw Object.assign(Error("disk failure"), { code: "EIO" }); });
  try { await assert.rejects(renameWithRetry(source, target), { code: "EIO" }); assert.equal(mock.mock.callCount(), 1); }
  finally { mock.mock.restore(); }
  await assert.rejects(renameWithRetry(source + ".missing", target), { code: "ENOENT" });
  if (process.platform === "win32") {
    const link = artifactPath("linked"); await fs.symlink(path.dirname(source), link, "junction");
    await assert.rejects(renameWithRetry(path.join(link, "source.tmp"), target), /链接|变化/);
  }
});
