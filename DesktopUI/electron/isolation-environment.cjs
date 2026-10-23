function environmentBlock(environment) {
  const values = new Map();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      name.includes("\0") ||
      value.includes("\0") ||
      (name.includes("=") && !/^=[a-z]:$/i.test(name))
    )
      throw Error("无效的隔离启动环境变量");
    // Windows names are case-insensitive. Explicit APPDATA overrides must win
    // over an inherited 'AppData'; duplicate names could otherwise select the
    // shared data directory before the private one.
    values.set(
      name.replace(/[a-z]/g, (c) => c.toUpperCase()),
      value,
    );
  }
  return Buffer.from(
    [...values]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => k + "=" + v)
      .join("\0") + "\0\0",
    "utf16le",
  );
}
module.exports = { environmentBlock };
