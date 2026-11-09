const fs = require("node:fs/promises"), path = require("node:path");
const { readFile, safeDirectory } = require("./map-preview.cjs");
const POLICY_FILE = ".daguoneko-versions.json";
function version(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+){1,4}$/.test(value) || value.length > 60) throw Error("版本应为点分隔的数字，例如 3.10.0.448891");
  const parts = value.split(".").map(Number);
  if (parts.some(n => !Number.isSafeInteger(n) || n < 0 || n > 2147483647)) throw Error("版本分量超出范围");
  return parts;
}
function compare(a, b) {
  const x = version(a), y = version(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
function validatePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["schema", "minimum", "maximum"].includes(key)) || value.schema !== 1) throw Error("启动版本范围格式无效");
  for (const key of ["minimum", "maximum"]) if (typeof value[key] !== "string") throw Error("启动版本范围必须是文本"); else if (value[key]) version(value[key]);
  if (value.minimum && value.maximum && compare(value.minimum, value.maximum) > 0) throw Error("最低启动版本不能高于最高启动版本");
  return value;
}
async function readPolicy(root) {
  await safeDirectory(root);
  const file = path.join(root, POLICY_FILE);
  const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return { schema: 1, minimum: "", maximum: "" };
  return validatePolicy(JSON.parse((await readFile(file, 8192)).toString("utf8")));
}
async function assertLaunchVersion(root, actualVersion) {
  const policy = await readPolicy(root);
  if (!policy.minimum && !policy.maximum) return;
  if (!actualVersion) throw Error("该存档设置了启动版本范围，但当前游戏构建版本无法可靠识别，已停止启动");
  if (policy.minimum && compare(actualVersion, policy.minimum) < 0 || policy.maximum && compare(actualVersion, policy.maximum) > 0)
    throw Error(`当前游戏版本 ${actualVersion} 不在此存档允许的范围 ${policy.minimum || "不限"} ～ ${policy.maximum || "不限"} 内，已停止启动`);
}
module.exports = { POLICY_FILE, readPolicy, validatePolicy, assertLaunchVersion, version };
