const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const jsonc = require("jsonc-parser");

const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const jsonExt = new Set([".json", ".jsonc", ".material"]);
const refKey = /(?:texture|textures|image|images|resource|path|file|atlas|material|sprite)/i;
const pathValue = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./\\-]+(?:\.(?:png|tga|jpg|jpeg|json|jsonc|material))?$/i;
const crcTable = Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes) { let c=0xffffffff; for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8); return (c^0xffffffff)>>>0; }

function digest(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
function inside(root, file) {
  const rel = path.relative(root, path.resolve(file));
  return rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}
async function walk(root, limit = 200000) {
  const files = [], queue = [root];
  while (queue.length) {
    const dir = queue.pop();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error("资源目录含链接：" + file);
      if (entry.isDirectory()) queue.push(file);
      else if (entry.isFile()) {
        files.push(file);
        if (files.length > limit) throw Error("资源文件超过预检上限");
      }
    }
  }
  return files;
}
async function pngError(file) {
  const bytes = Buffer.isBuffer(file) ? file : await fs.readFile(file);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "PNG 签名或文件长度无效";
  let offset = 8, sawHeader = false, sawData = false, sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) return "PNG chunk 超出文件长度";
    if (!/^[A-Za-z]{4}$/.test(type)) return "PNG chunk 类型无效";
    if (!sawHeader && type !== "IHDR") return "PNG 首个 chunk 不是 IHDR";
    if (type === "IHDR") {
      if (sawHeader || length !== 13 || bytes.readUInt32BE(offset + 8) < 1 || bytes.readUInt32BE(offset + 12) < 1)
        return "PNG IHDR 无效";
      sawHeader = true;
    }
    const expected = bytes.readUInt32BE(offset + 8 + length);
    const actual = crc32(Buffer.concat([Buffer.from(type, "ascii"), bytes.subarray(offset + 8, offset + 8 + length)]));
    if (expected !== actual) return "PNG chunk CRC 无效";
    if (type === "IDAT" && length > 0) sawData = true;
    offset += 12 + length;
    if (type === "IEND") {
      if (length !== 0) return "PNG IEND 无效";
      sawEnd = true; break;
    }
  }
  if (!sawHeader || !sawData || !sawEnd || offset !== bytes.length) return "PNG 缺少图像数据、完整 IEND 或含截断尾部";
  return null;
}
function readJson(bytes) {
  try {
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    const errors = [];
    const value = jsonc.parse(text, errors, { allowTrailingComma: true });
    if (errors.length) throw Error("JSONC 解析失败");
    return value;
  } catch (error) {
    return { __parseError: error.message };
  }
}
function collectReferences(value, key, out, file) {
  if (typeof value === "string") {
    if (refKey.test(key || "") && !value.trim()) out.push({ type: "empty_resource_path", file, key });
    if (refKey.test(key || "") && value && pathValue.test(value) &&
        (/[\\/]/.test(value) || /\.(?:png|tga|jpg|jpeg|json|jsonc|material)$/i.test(value)))
      out.push({ type: "reference", file, key, value });
    return;
  }
  if (Array.isArray(value)) return value.forEach(item => collectReferences(item, key, out, file));
  if (!value || typeof value !== "object") return;
  for (const [child, item] of Object.entries(value)) collectReferences(item, child, out, file);
}
function candidatePaths(packRoot, value) {
  const raw = value.replaceAll("\\", "/").replace(/^\//, "");
  const candidates = [path.resolve(packRoot, raw)];
  if (!path.extname(raw)) candidates.push(path.resolve(packRoot, raw + ".png"));
  if (raw.startsWith("textures/")) candidates.push(path.resolve(packRoot, raw));
  return candidates.filter(file => inside(packRoot, file));
}
async function validateAssetRoot(root, label = root) {
  const result = { root, label, ok: true, files: 0, pngs: 0, references: 0, errors: [], warnings: [], digest: null };
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("资源根目录被重定向或不是文件夹：" + root);
  const files = (await walk(root)).sort();
  const fileSet = new Set(files);
  const hashes = crypto.createHash("sha256");
  for (const file of files) {
    const rel = path.relative(root, file).replaceAll("\\", "/");
    const bytes = await fs.readFile(file);
    hashes.update(rel + "\0").update(bytes);
    result.files++;
    if (path.extname(file).toLowerCase() === ".png") {
      result.pngs++;
      const error = await pngError(bytes);
      if (error) result.errors.push({ type: "invalid_png", file: rel, error });
    }
    if (!jsonExt.has(path.extname(file).toLowerCase())) continue;
    const value = readJson(bytes);
    if (value?.__parseError) {
      result.errors.push({ type: "invalid_json", file: rel, error: value.__parseError });
      continue;
    }
    const refs = [];
    collectReferences(value, "", refs, rel);
    for (const ref of refs) {
      if (ref.type === "empty_resource_path") { result.errors.push(ref); continue; }
      result.references++;
      if (ref.value.includes(":") && !ref.value.includes("/")) continue;
      if (!candidatePaths(root, ref.value).some(file => fileSet.has(file))) {
        const explicit = /\.(?:png|tga|jpg|jpeg|json|jsonc|material)$/i.test(ref.value);
        (explicit ? result.errors : result.warnings).push({
          type: "missing_resource_reference", file: rel, key: ref.key, value: ref.value,
          reason: explicit ? "explicit_file_missing" : "extensionless_alias_or_vanilla_reference",
        });
      }
    }
  }
  result.digest = hashes.digest("hex");
  result.ok = result.errors.length === 0;
  return result;
}
async function validateWorldAssets(root) {
  const result = { root, ok: true, packs: [], errors: [], warnings: [] };
  const dirs = ["behavior_packs", "resource_packs", ".toolbox-packs/behavior_packs", ".toolbox-packs/resource_packs"];
  for (const relative of dirs) {
    const dir = path.join(root, relative);
    let entries;
    try {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("资源目录被重定向或不是文件夹");
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") result.errors.push({ type: "asset_scan_failed", file: relative, error: error.message });
      continue;
    }
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      try {
        if (entry.isSymbolicLink()) throw Error("资源包目录含链接");
        if (!entry.isDirectory()) continue;
        const pack = await validateAssetRoot(path.join(dir, entry.name), relative + "/" + entry.name);
        result.packs.push(pack);
        result.errors.push(...pack.errors.map(error => ({ ...error, pack: pack.label })));
        result.warnings.push(...pack.warnings.map(warning => ({ ...warning, pack: pack.label })));
      } catch (error) {
        result.errors.push({ type: "asset_scan_failed", file: relative + "/" + entry.name, error: error.message });
      }
    }
  }
  result.ok = result.errors.length === 0;
  result.digest = digest(JSON.stringify(result.packs.map(p => ({ label: p.label, digest: p.digest }))));
  return result;
}
module.exports = { validateAssetRoot, validateWorldAssets, pngError };
