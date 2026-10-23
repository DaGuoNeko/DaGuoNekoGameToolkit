// Identifiers are Bedrock names (not Java aliases), checked against the supported
// development build's vanilla biome descriptors. Other loaded biomes use custom.
const BIOMES = [
  ["plains", "平原"],
  ["sunflower_plains", "向日葵平原"],
  ["forest", "森林"],
  ["flower_forest", "繁花森林"],
  ["birch_forest", "白桦森林"],
  ["roofed_forest", "黑森林"],
  ["pale_garden", "苍白之园"],
  ["cherry_grove", "樱花树林"],
  ["taiga", "针叶林"],
  ["mega_taiga", "巨型针叶林"],
  ["cold_taiga", "积雪针叶林"],
  ["jungle", "丛林"],
  ["bamboo_jungle", "竹林"],
  ["desert", "沙漠"],
  ["savanna", "热带草原"],
  ["savanna_plateau", "热带高原"],
  ["mesa", "恶地"],
  ["mesa_bryce", "风蚀恶地"],
  ["swampland", "沼泽"],
  ["mangrove_swamp", "红树林沼泽"],
  ["mushroom_island", "蘑菇岛"],
  ["meadow", "草甸"],
  ["grove", "雪林"],
  ["snowy_slopes", "积雪山坡"],
  ["jagged_peaks", "尖峭山峰"],
  ["frozen_peaks", "冰封山峰"],
  ["stony_peaks", "裸岩山峰"],
  ["extreme_hills", "山地"],
  ["ice_plains", "雪原"],
  ["ice_plains_spikes", "冰刺平原"],
  ["river", "河流"],
  ["frozen_river", "冻河"],
  ["beach", "沙滩"],
  ["stone_beach", "石岸"],
  ["ocean", "海洋"],
  ["deep_ocean", "深海"],
  ["warm_ocean", "暖水海洋"],
  ["lukewarm_ocean", "温水海洋"],
  ["cold_ocean", "冷水海洋"],
  ["frozen_ocean", "冻洋"],
  ["deep_frozen_ocean", "封冻深海"],
  ["lush_caves", "繁茂洞穴"],
  ["dripstone_caves", "溶洞"],
  ["deep_dark", "深暗之域"],
  ["hell", "下界荒地"],
  ["soulsand_valley", "灵魂沙峡谷"],
  ["crimson_forest", "绯红森林"],
  ["warped_forest", "诡异森林"],
  ["basalt_deltas", "玄武岩三角洲"],
  ["the_end", "末地"],
].map(([id, label]) => ({
  value: "minecraft:" + id,
  label: label + " · " + id,
}));
const SHAPES = { chunk: "当前区块", circle: "圆形", rectangle: "矩形" };
function integer(v, min, max, label) {
  if (!Number.isInteger(v) || v < min || v > max)
    throw Error(`${label}须为 ${min}–${max} 的整数`);
  return v;
}
function normalizeBiome(value) {
  const biome = typeof value.biome === "string" ? value.biome.trim() : "";
  if (biome.length > 160 || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(biome))
    throw Error("请填写有效的群系标识符，例如 minecraft:plains");
  if (!Object.hasOwn(SHAPES, value.shape)) throw Error("请选择群系修改范围");
  if (!["column", "range"].includes(value.heightMode))
    throw Error("请选择群系高度范围");
  const result = { biome, shape: value.shape, heightMode: value.heightMode };
  if (value.shape === "circle")
    result.radius = integer(value.radius, 0, 32, "圆形半径");
  if (value.shape === "rectangle") {
    result.length = integer(value.length, 1, 64, "X 方向长度");
    result.width = integer(value.width, 1, 64, "Z 方向宽度");
  }
  if (value.heightMode === "range") {
    result.minY = integer(value.minY, -64, 319, "最低 Y");
    result.maxY = integer(value.maxY, -64, 319, "最高 Y");
    if (result.minY > result.maxY) throw Error("最低 Y 不能高于最高 Y");
  }
  return result;
}
function biomeSummary(a) {
  return `${a.biome} · ${SHAPES[a.shape]}${a.shape === "circle" ? " R=" + a.radius : a.shape === "rectangle" ? " " + a.length + "×" + a.width : " 16×16"} · ${a.heightMode === "range" ? "Y " + a.minY + "～" + a.maxY : "整列高度"} · 房主当前维度`;
}
module.exports = { BIOMES, SHAPES, normalizeBiome, biomeSummary };
