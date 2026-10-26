const profiles = require("../../supported-engines.json");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const byHash = new Map(Object.entries(profiles));
const cache = new Map();
const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
function profileForDigest(digest) {
  const profile = byHash.get(digest);
  return profile ? { digest, ...profile } : null;
}
function profilesForDiscovery() {
  return [...byHash.entries()].map(([digest, profile]) => ({
    digest,
    ...profile,
  }));
}
async function inspectEngine(file) {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw Error("请选择游戏程序的绝对路径");
  const real = await fs.realpath(file),
    before = await fs.stat(real);
  if (!before.isFile() || before.size > 512 * 1024 * 1024)
    throw Error("游戏程序无效");
  const key = real.toLowerCase(),
    fingerprint = stamp(before);
  if (cache.get(key)?.stamp === fingerprint)
    return structuredClone(cache.get(key).value);
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(real)) hash.update(chunk);
  if (
    stamp(await fs.stat(real)) !== fingerprint ||
    (await fs.realpath(file)).toLowerCase() !== key
  )
    throw Error("游戏程序在检查期间发生变化");
  const digest = hash.digest("hex"),
    profile = profileForDigest(digest);
  const value = {
    file: real,
    digest,
    version: profile?.version || null,
    profile,
  };
  if (cache.size >= 128) cache.clear();
  cache.set(key, { stamp: fingerprint, value });
  return structuredClone(value);
}
module.exports = { profileForDigest, profilesForDiscovery, inspectEngine };
