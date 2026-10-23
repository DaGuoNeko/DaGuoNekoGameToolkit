const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const yauzl = require("yauzl");
const FILES = [
  "easytier-core.exe",
  "easytier-cli.exe",
  "wintun.dll",
  "WinDivert64.sys",
  "Packet.dll",
];
const URL =
  "https://github.com/EasyTier/EasyTier/releases/download/v2.7.0/easytier-windows-x86_64-v2.7.0.zip";
const ZIP_HASH =
  "790fd9be347b00753570ac2b65f874a591ede9427603fe34e74a86b2b084847f";
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
async function complete(dir, manifest, helper = true) {
  for (const f of helper ? [...FILES, "network-helper.exe"] : FILES) {
    try {
      const stat = await fs.lstat(path.join(dir, f));
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        hash(await fs.readFile(path.join(dir, f))) !== manifest.files[f]
      )
        return false;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }
  return true;
}
async function prepareComponents(bundled, cacheRoot, signal) {
  signal?.throwIfAborted();
  const manifest = JSON.parse(
    await fs.readFile(path.join(bundled, "manifest.json"), "utf8"),
  );
  if (await complete(bundled, manifest)) return bundled;
  const target = path.join(cacheRoot, "network-components", "2.7.0-8b7f1f01");
  await fs.mkdir(target, { recursive: true });
  if (
    (await fs.realpath(target)).toLowerCase() !==
    path.resolve(target).toLowerCase()
  )
    throw Error("联机组件目录不能是链接");
  const lock = path.join(target, "install.lock");
  let handle;
  try {
    handle = await fs.open(lock, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
  } catch (e) {
    if (e.code === "EEXIST") {
      const saved = await fs.readFile(lock, "utf8");
      let owner;
      try {
        owner = JSON.parse(saved).pid;
      } catch {
        throw Error("联机组件安装中断，请删除组件目录中的 install.lock 后重试");
      }
      let gone = false;
      if (Number.isInteger(owner) && owner > 0)
        try {
          process.kill(owner, 0);
        } catch (err) {
          if (err.code === "ESRCH") gone = true;
        }
      if (gone) {
        await fs.unlink(lock);
        return prepareComponents(bundled, cacheRoot, signal);
      }
      throw Error("另一个工具箱正在准备联机组件，请稍后重试");
    }
    throw e;
  }
  const tmp = path.join(target, "download-" + crypto.randomUUID() + ".zip");
  try {
    if (!(await complete(target, manifest, false))) {
      const response = await fetch(URL, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(120000),
      });
      if (!response.ok) throw Error("无法下载官方联机组件，请检查网络后重试");
      const chunks = [];
      let size = 0;
      for await (const b of response.body) {
        size += b.length;
        if (size > 128 * 1024 * 1024) throw Error("联机组件下载超过大小限制");
        chunks.push(b);
      }
      const archive = Buffer.concat(chunks);
      if (hash(archive) !== ZIP_HASH)
        throw Error("官方联机组件校验失败，未执行下载文件");
      await fs.writeFile(tmp, archive);
      await new Promise((resolve, reject) =>
        yauzl.open(tmp, { lazyEntries: true }, (error, zip) => {
          if (error) {
            reject(error);
            return;
          }
          const found = new Set();
          const fail = (e) => {
            zip.close();
            reject(e);
          };
          zip.on("error", fail);
          zip.on("end", () =>
            found.size === FILES.length
              ? resolve()
              : reject(Error("官方组件包缺少运行文件")),
          );
          zip.on("entry", (entry) => {
            const name = entry.fileName.replaceAll("\\", "/");
            const file = FILES.find(
              (f) => name === "easytier-windows-x86_64/" + f,
            );
            if (!file) {
              zip.readEntry();
              return;
            }
            if (found.has(file) || entry.uncompressedSize > 64 * 1024 * 1024) {
              fail(Error("组件包条目无效"));
              return;
            }
            found.add(file);
            zip.openReadStream(entry, (e, stream) => {
              if (e) {
                fail(e);
                return;
              }
              const blocks = [];
              let total = 0;
              stream.on("data", (b) => {
                total += b.length;
                if (total > 64 * 1024 * 1024)
                  stream.destroy(Error("组件文件过大"));
                else blocks.push(b);
              });
              stream.on("error", fail);
              stream.on("end", () => {
                const bytes = Buffer.concat(blocks);
                if (hash(bytes) !== manifest.files[file]) {
                  fail(Error("联机组件文件校验失败"));
                  return;
                }
                fs.writeFile(path.join(target, file), bytes).then(
                  () => zip.readEntry(),
                  fail,
                );
              });
            });
          });
          zip.readEntry();
        }),
      );
    }
    for (const file of ["network-helper.exe", "manifest.json", "launch.ps1"])
      await fs.copyFile(path.join(bundled, file), path.join(target, file));
    if (!(await complete(target, manifest))) throw Error("联机组件未完整安装");
    return target;
  } finally {
    await handle.close();
    await fs.unlink(lock);
    await fs.unlink(tmp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
module.exports = { prepareComponents, FILES, ZIP_HASH };
