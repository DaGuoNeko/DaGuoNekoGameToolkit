const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const { Transform, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { crc32 } = require("node:zlib");
const yauzl = require("yauzl");
const { readWorldInfo } = require("./world-info.cjs");
const MAX_TOTAL = 8 * 1024 ** 3;
function entryPath(entry) {
  const name = entry.fileName;
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (
    (mode && mode !== 0x8000 && mode !== 0x4000) ||
    entry.externalFileAttributes & 0x400
  )
    throw Error("ZIP 包含链接或特殊文件，不能导入");
  if (entry.generalPurposeBitFlag & 0x41)
    throw Error("不支持加密 ZIP，请先解密");
  if (![0, 8].includes(entry.compressionMethod))
    throw Error("ZIP 压缩方式不支持，请使用普通 ZIP");
  const directory =
    name.endsWith("/") ||
    mode === 0x4000 ||
    !!(entry.externalFileAttributes & 0x10);
  const parts = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  while (parts[0] === ".") parts.shift();
  if (
    !name ||
    (!parts.length && !directory) ||
    name.length > 2048 ||
    parts.length > 32 ||
    parts.some(
      (p) =>
        !p ||
        p.length > 255 ||
        p === "." ||
        p === ".." ||
        /[\\:\x00-\x1f<>"|?*]/.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(
          p.split(".")[0].replace(/ +$/, ""),
        ),
    )
  )
    throw Error("ZIP 包含不安全或 Windows 不支持的路径：" + name);
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > 2 * 1024 ** 3 ||
    (directory && entry.uncompressedSize)
  )
    throw Error("ZIP 文件大小无效或单文件超过 2 GiB");
  return { entry, parts, name: parts.join("/"), directory };
}
function checkedStream(entry, limit) {
  let count = 0,
    checksum = 0;
  return new Transform({
    transform(chunk, _, done) {
      count += chunk.length;
      if (count > limit || count > entry.uncompressedSize)
        return done(Error("ZIP 解压大小超出声明或上限"));
      checksum = crc32(chunk, checksum);
      done(null, chunk);
    },
    flush(done) {
      done(
        count !== entry.uncompressedSize || checksum !== entry.crc32
          ? Error("ZIP 数据长度或 CRC 校验失败")
          : null,
      );
    },
  });
}
async function openWorldZip(source) {
  const zip = await yauzl.openPromise(source, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  let zipError, closing;
  zip.on("error", (e) => {
    zipError = e;
  });
  const close = () =>
    (closing ||= new Promise((resolve, reject) => {
      zip.once("close", resolve);
      zip.once("error", reject);
      zip.close();
    }));
  try {
    const entries = [],
      paths = new Map();
    let total = 0,
      nameBytes = 0;
    for await (const entry of zip.eachEntry()) {
      if (entries.length >= 100000) throw Error("ZIP 文件条目超过 100000 项");
      const item = entryPath(entry);
      total += entry.uncompressedSize;
      nameBytes += Buffer.byteLength(entry.fileName);
      if (total > MAX_TOTAL || nameBytes > 16 * 1024 ** 2)
        throw Error("ZIP 解压总量超过 8 GiB 或路径表过大");
      for (let i = 1; i <= item.parts.length; i++) {
        const name = item.parts.slice(0, i).join("/"),
          key = name.toLowerCase();
        const directory = i < item.parts.length || item.directory;
        const old = paths.get(key);
        if (old && (!old.directory || !directory || old.name !== name))
          throw Error("ZIP 包含重复、大小写冲突或文件/目录冲突：" + name);
        paths.set(key, { name, directory });
        if (paths.size > 250000) throw Error("ZIP 目录结构过大");
      }
      entries.push(item);
    }
    const levels = entries.filter(
      (e) => !e.directory && e.parts.at(-1).toLowerCase() === "level.dat",
    );
    if (!levels.length) throw Error("ZIP 中没有找到 level.dat 存档文件");
    levels.sort((a, b) => a.parts.length - b.parts.length);
    const level = levels[0],
      prefixParts = level.parts.slice(0, -1),
      prefix = prefixParts.length ? prefixParts.join("/") + "/" : "";
    if (levels.some((e) => !e.name.startsWith(prefix)))
      throw Error("ZIP 包含多个存档，请分别导入");
    if (level.entry.uncompressedSize > 8 * 1024 ** 2)
      throw Error("存档 level.dat 超过 8 MiB");
    const chunks = [];
    await pipeline(
      await zip.openReadStreamPromise(level.entry),
      checkedStream(level.entry, 8 * 1024 ** 2),
      new Writable({
        write(chunk, _, done) {
          chunks.push(chunk);
          done();
        },
      }),
    );
    const metadata = readWorldInfo(Buffer.concat(chunks));
    if (zipError) throw zipError;
    return {
      metadata,
      close,
      async extract(destination, safeDirectory) {
        await fs.mkdir(destination);
        await safeDirectory(destination);
        const checkedDirs = new Set([destination.toLowerCase()]);
        async function directory(dir) {
          if (checkedDirs.has(dir.toLowerCase())) {
            await safeDirectory(dir);
            return;
          }
          const relative = path.relative(destination, dir);
          if (
            !relative ||
            relative === ".." ||
            relative.startsWith(".." + path.sep) ||
            path.isAbsolute(relative)
          )
            throw Error("ZIP 目录超出目标范围");
          await directory(path.dirname(dir));
          await fs.mkdir(dir, { recursive: false }).catch((e) => {
            if (e.code !== "EEXIST") throw e;
          });
          await safeDirectory(dir);
          checkedDirs.add(dir.toLowerCase());
        }
        for (const item of entries) {
          if (!item.name.startsWith(prefix)) continue;
          const parts = item.parts.slice(prefixParts.length);
          if (!parts.length) continue;
          const target = path.resolve(destination, ...parts);
          if (
            !target
              .toLowerCase()
              .startsWith(destination.toLowerCase() + path.sep)
          )
            throw Error("ZIP 文件超出目标范围");
          if (zipError) throw zipError;
          if (item.directory) {
            await directory(target);
            continue;
          }
          await directory(path.dirname(target));
          const input = await zip.openReadStreamPromise(item.entry);
          await pipeline(
            input,
            checkedStream(item.entry, MAX_TOTAL),
            createWriteStream(target, { flags: "wx" }),
          );
        }
        if (zipError) throw zipError;
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
module.exports = { openWorldZip, entryPath };
