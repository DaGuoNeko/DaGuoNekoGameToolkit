// Read only the small metadata values needed by world cards. No NBT writes.
function readWorldInfo(buffer) {
  if (
    buffer.length < 11 ||
    buffer.length > 8 * 1024 * 1024 ||
    buffer.readUInt32LE(4) > buffer.length - 8
  )
    throw Error("存档 level.dat 头部无效");
  let offset = 8,
    budget = 200000;
  const take = (n) => {
    if (n < 0 || offset + n > buffer.length) throw Error("存档元数据长度无效");
    const start = offset;
    offset += n;
    return start;
  };
  const byte = () => buffer.readUInt8(take(1));
  const int = () => buffer.readInt32LE(take(4));
  const string = () => {
    const n = buffer.readUInt16LE(take(2));
    return buffer.toString("utf8", take(n), offset);
  };
  function payload(type, depth) {
    if (--budget < 0 || depth > 64) throw Error("存档元数据结构过大");
    switch (type) {
      case 1:
        return buffer.readInt8(take(1));
      case 2:
        return buffer.readInt16LE(take(2));
      case 3:
        return int();
      case 4: {
        const n = buffer.readBigInt64LE(take(8));
        return n >= BigInt(Number.MIN_SAFE_INTEGER) &&
          n <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(n)
          : null;
      }
      case 5:
        return buffer.readFloatLE(take(4));
      case 6:
        return buffer.readDoubleLE(take(8));
      case 8:
        return string();
      case 7:
      case 11:
      case 12: {
        const n = int();
        take(n * (type === 7 ? 1 : type === 11 ? 4 : 8));
        return null;
      }
      case 9: {
        const item = byte(),
          n = int();
        if (n < 0 || n > budget) throw Error("存档数组过大");
        for (let i = 0; i < n; i++) payload(item, depth + 1);
        return null;
      }
      case 10: {
        const result = Object.create(null);
        for (let type; (type = byte()) !== 0;) {
          const name = string();
          result[name] = payload(type, depth + 1);
        }
        return result;
      }
      default:
        throw Error("不支持的存档元数据类型");
    }
  }
  if (byte() !== 10) throw Error("存档元数据根类型无效");
  string();
  const root = payload(10, 0);
  const options = {};
  for (const [key, tag] of Object.entries({
    enable_cheats: "cheatsEnabled",
    keep_inventory: "keepInventory",
    do_weather_cycle: "doweathercycle",
    do_daylight_cycle: "dodaylightcycle",
  }))
    if (root[tag] !== undefined) options[key] = !!root[tag];
  if (root.experiments)
    options.experiment_options = Object.fromEntries(
      [
        "data_driven_biomes",
        "upcoming_creator_features",
        "experimental_creator_cameras",
        "gametest",
        "deferred_technical_preview",
      ]
        .filter((key) => root.experiments[key] !== undefined)
        .map((key) => [key, !!root.experiments[key]]),
    );
  if (root.keepinventory !== undefined)
    options.keep_inventory = !!root.keepinventory;
  return {
    levelName: typeof root.LevelName === "string" ? root.LevelName : null,
    seed: root.RandomSeed ?? null,
    gameMode: [0, 1, 2].includes(root.GameType) ? root.GameType : 1,
    worldType: [0, 1, 2].includes(root.Generator) ? root.Generator : 1,
    options,
  };
}
async function loadWorldInfo(file) {
  const handle = await require("node:fs/promises").open(file, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > 8 * 1024 * 1024) throw Error("存档 level.dat 超过读取上限");
    const buffer = Buffer.alloc(stat.size);
    let at = 0;
    while (at < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        at,
        buffer.length - at,
        at,
      );
      if (!bytesRead) throw Error("存档元数据在读取时变化");
      at += bytesRead;
    }
    return readWorldInfo(buffer);
  } finally {
    await handle.close();
  }
}
module.exports = { readWorldInfo, loadWorldInfo };
