const LIMIT = 64 * 1024 * 1024;
function integer(value, label, min = -29999984, max = 29999984) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw Error(label + `必须为 ${min}～${max} 的整数`);
  return value;
}
function region(input) {
  const a = ["x1", "y1", "z1"].map(k => integer(input[k], k));
  const b = ["x2", "y2", "z2"].map(k => integer(input[k], k));
  const min = a.map((v, i) => Math.min(v, b[i]));
  const max = a.map((v, i) => Math.max(v, b[i]));
  const size = min.map((v, i) => max[i] - v + 1);
  const volume = size.reduce((a, b) => a * b, 1);
  if (volume > LIMIT || size[1] > 1024) throw Error("单次选区最多 67108864 格、高度最多 1024；请把大地图分区导入");
  return { min, max, size, volume };
}
function placement(input, source) {
  const origin = ["targetX", "targetY", "targetZ"].map(k => integer(input[k], k));
  if (!["overwrite", "keep"].includes(input.policy)) throw Error("请选择覆盖或保留策略");
  if (typeof input.includeAir !== "boolean") throw Error("请选择是否导入空气");
  const max = origin.map((v, i) => integer(v + source.size[i] - 1, "目标边界"));
  return { origin, max, policy: input.policy, includeAir: input.includeAir };
}
function* tiles(bounds) {
  // 每批严格落在一个区块内，最多 512 格，负坐标也按区块边界切分。
  for (let x = bounds.min[0]; x <= bounds.max[0];) {
    const xx = Math.min(bounds.max[0], Math.floor(x / 8) * 8 + 7);
    for (let z = bounds.min[2]; z <= bounds.max[2];) {
      const zz = Math.min(bounds.max[2], Math.floor(z / 8) * 8 + 7);
      for (let y = bounds.min[1]; y <= bounds.max[1]; y += 8)
        yield { min: [x, y, z], max: [xx, Math.min(y + 7, bounds.max[1]), zz] };
      z = zz + 1;
    }
    x = xx + 1;
  }
}
function positions(tile) {
  const result = [];
  for (let x = tile.min[0]; x <= tile.max[0]; x++)
    for (let z = tile.min[2]; z <= tile.max[2]; z++)
      for (let y = tile.min[1]; y <= tile.max[1]; y++) result.push([x, y, z]);
  return result;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const air = block => ["minecraft:air", "minecraft:cave_air", "minecraft:void_air"].includes(block.name);
function relocate(block, offset) {
  const copy = structuredClone(block);
  // 原版方块实体只平移自身坐标及双箱配对坐标，不猜测业务模组字段含义。
  for (const [key, axis] of [["x",0],["y",1],["z",2],["pairx",0],["pairz",2]]) {
    const tag = copy.entity?.[key];
    if (Number.isInteger(tag)) copy.entity[key] += offset[axis];
    else if (Number.isInteger(tag?.__value__)) tag.__value__ += offset[axis];
  }
  return copy;
}
function changes(source, before, tile, offset, options) {
  const points = positions(tile);
  if (source.length !== points.length || before.length !== points.length) throw Error("地形批次长度不一致");
  const writes = [];
  const counts = { changed: 0, kept: 0, air: 0, identical: 0 };
  source.forEach((block, i) => {
    if (!options.includeAir && air(block)) { counts.air++; return; }
    if (options.policy === "keep" && !air(before[i])) { counts.kept++; return; }
    const after = relocate(block, offset);
    if (equal(after, before[i])) { counts.identical++; return; }
    writes.push({ pos: points[i].map((v, a) => v + offset[a]), before: before[i], after });
    counts.changed++;
  });
  return { writes, counts };
}
module.exports = { LIMIT, integer, region, placement, tiles, positions, equal, air, changes };
