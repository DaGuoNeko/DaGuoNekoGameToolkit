function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value.trim(),
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
    text: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${
      match[4] ? `-${match[4]}` : ""
    }`,
  };
}

function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  if (!a || !b) throw Error("版本号无效");
  for (const key of ["major", "minor", "patch"])
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const leftParts = a.prerelease.split("."),
    rightParts = b.prerelease.split(".");
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const x = leftParts[i],
      y = rightParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

module.exports = { parseVersion, compareVersions };
