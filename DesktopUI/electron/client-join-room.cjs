const fs = require("node:fs/promises"),
  path = require("node:path");
const { loadWorldInfo } = require("./world-info.cjs");
async function readJoinRoom(worlds, worldId) {
  const record = worlds.find(await worlds.read(), null, worldId);
  const info = await worlds.inspect(record),
    directory = info.path;
  if (!info.present || info.deleted || record.copying)
    throw Error("房主存档目录不存在，无法读取实际房间名");
  const file = path.join(directory, "level.dat"),
    stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("房主 level.dat 不是普通文件");
  const { levelName } = await loadWorldInfo(file);
  if (
    typeof levelName !== "string" ||
    !levelName.trim() ||
    levelName.length > 512 ||
    /[\x00-\x1f\x7f]/.test(levelName)
  )
    throw Error(
      "存档缺少有效的 LevelName，无法确定局域网房间名；不会用工具箱卡片名猜测",
    );
  return { name: levelName, source: "level.dat/LevelName" };
}
module.exports = { readJoinRoom };
