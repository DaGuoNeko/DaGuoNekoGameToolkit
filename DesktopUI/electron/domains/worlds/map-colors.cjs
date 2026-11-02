const zlib = require("node:zlib");
const { colors: palette } = require("./map-palette.json");

const AIR = /(^|:)(air|cave_air|void_air|structure_void|barrier|light)$/;
const WATER = /(^|:)(water|flowing_water|bubble_column)$/;
// 地表小植被不遮住整格土地；树冠、雪层和建筑仍保留。
const DECORATION = /(^|:)(short_grass|tall_grass|tallgrass|fern|large_fern|dead_bush|vine|glow_lichen|torch|wall_torch|redstone_wire|tripwire|rail|powered_rail|detector_rail|activator_rail|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|seagrass|tall_seagrass|kelp|kelp_plant)$/;
const visible = name => !!name && !AIR.test(name) && !DECORATION.test(name);
const rgb = hex => [1,3,5].map(i => parseInt(hex.slice(i, i + 2), 16));
const hex = values => "#" + values.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const exact = {
  stone: "#7d7d7d", cobblestone: "#777777", mossy_cobblestone: "#68715a", stone_bricks: "#7a797a",
  granite: "#956756", polished_granite: "#9a6c5b", diorite: "#bdbdb9", andesite: "#888888", deepslate: "#4d4d51",
  tuff: "#6b6d63", calcite: "#deded6", basalt: "#525258", blackstone: "#302a31", obsidian: "#211b30",
  dirt: "#866043", coarse_dirt: "#77563b", rooted_dirt: "#8d6449", mud: "#3d3b40", clay: "#a0a6b3", gravel: "#827b77",
  sand: "#dbd3a0", sandstone: "#d8ca91", red_sand: "#bb6621", red_sandstone: "#b55f1f",
  snow: "#eff4f4", snow_layer: "#eff4f4", snow_block: "#eff4f4", powder_snow: "#e9f1f2", ice: "#8bb4e3", packed_ice: "#8aaddb", blue_ice: "#6b9df2",
  water: "#3d65bd", flowing_water: "#3d65bd", bubble_column: "#3d65bd", lava: "#e15b2a", flowing_lava: "#e15b2a",
  bricks: "#995c4e", brick_block: "#995c4e", terracotta: "#985e43", hardened_clay: "#985e43",
  netherrack: "#612727", nether_bricks: "#2c161a", end_stone: "#dadd9e", soul_sand: "#514033", soul_soil: "#4a382d",
  dirt_path: "#a28d53", grass_path: "#a28d53", farmland: "#715139", podzol: "#6b4b24", mycelium: "#75626c",
  glass: "#bdcfd0", chest: "#946a2b", barrel: "#806037", crafting_table: "#82542c", bookshelf: "#9f804c",
  iron_block: "#d5d5d5", gold_block: "#eccd3f", copper_block: "#bf6b4c", diamond_block: "#65d6ce", emerald_block: "#36ba54",
};
const dyes = { white:"d4d5ce", orange:"d57824", magenta:"a6429d", light_blue:"579bc5", yellow:"dfb92b", lime:"73ac22", pink:"d98caa", gray:"414548", light_gray:"95958c", cyan:"267d91", purple:"7344a2", blue:"333e94", brown:"744b2b", green:"546b28", red:"9c3330", black:"252529" };
const woods = { oak:"a0804e", spruce:"725432", birch:"c3b27c", jungle:"a77850", acacia:"aa5b35", dark_oak:"443017", mangrove:"753931", cherry:"deb0aa", bamboo:"b4a34c", crimson:"7b3754", warped:"30746d", pale_oak:"d7cbb4" };
function tintFor(name, biome = "minecraft:plains") {
  if (!/grass_block|^minecraft:grass$|leaves|vine|fern|moss_block/.test(name)) return null;
  const leaf = /leaves/.test(name);
  if (/spruce_leaves/.test(name)) return "#619961";
  if (/birch_leaves/.test(name)) return "#80a755";
  if (/cherry|azalea|pale_oak/.test(name)) return null;
  if (/swamp/.test(biome)) return "#6a7039";
  if (/desert|badlands/.test(biome)) return leaf ? "#9e814d" : "#bfb755";
  if (/savanna/.test(biome)) return leaf ? "#9c9340" : "#b7b15b";
  if (/snow|frozen|taiga|grove/.test(biome)) return leaf ? "#67906b" : "#80a27b";
  if (/jungle/.test(biome)) return leaf ? "#3f920d" : "#59c93c";
  if (/forest/.test(biome)) return leaf ? "#59ae30" : "#79b34f";
  return leaf ? "#77ab2f" : "#91bd59";
}
function colorFor(name, biome) {
  if (!visible(name)) return null;
  const id = name.replace(/^.*:/, "");
  const tint = tintFor(name, biome);
  const sampled = Object.hasOwn(palette,name) ? palette[name] : null;
  if (tint) return sampled ? hex(rgb(sampled).map((v,i)=>v*rgb(tint)[i]/255)) : hex(rgb(tint).map(v => v * (/leaves/.test(id) ? .73 : .82)));
  if (sampled) return sampled;
  if (exact[id]) return exact[id];
  for (const [key, value] of Object.entries(dyes)) if (id.startsWith(key + "_") && /wool|concrete|terracotta|carpet|glass/.test(id)) return "#" + value;
  for (const key of ["dark_oak","pale_oak",...Object.keys(woods)]) if (id.includes(key + "_")) return "#" + woods[key];
  if (/mossy/.test(id)) return "#697450";
  for (const key of ["red_sandstone","sandstone","deepslate","blackstone","granite","diorite","andesite","stone","brick","snow","copper","quartz"]) {
    if (id.includes(key)) return exact[key] || (key === "quartz" ? "#e4dfd3" : "#a16c56");
  }
  if (/leaves|lily_pad/.test(id)) return "#557c35";
  if (/glass/.test(id)) return "#aac4c8";
  // shortcut: 未收录的自定义方块以中性色显示，新增支持时扩充内置配色表。
  return "#938d85";
}

function shadeCells(cells, relief = true, inPlace = false) {
  // 按区块存高度数组，避免大地图为每个方块建立字符串键和第二份对象。
  const columns = new Map();
  for(const c of cells) {
    const cx=Math.floor(c.x/16),cz=Math.floor(c.z/16),key=cx+","+cz;
    let heights=columns.get(key);
    if(!heights){heights=new Float32Array(256).fill(NaN);columns.set(key,heights);}
    heights[(c.z-cz*16)*16+c.x-cx*16]=c.height??0;
  }
  const heightAt=(x,z,fallback)=>{
    const cx=Math.floor(x/16),cz=Math.floor(z/16),v=columns.get(cx+","+cz)?.[(z-cz*16)*16+x-cx*16];
    return Number.isFinite(v)?v:fallback;
  };
  const baseColors = new Map();
  const output=(cell,color)=>{if(inPlace){cell.color=color;return cell;}return {x:cell.x,z:cell.z,color};};
  const shade = cell => {
    const name = cell.name || "", key = name + "/" + cell.biome;
    let base = baseColors.get(key);
    if (!base) {
      base = rgb(colorFor(name, cell.biome) || cell.color || "#938d85");
      baseColors.set(key, base);
    }
    if(!relief) return output(cell,hex(base));
    if (WATER.test(name)) {
      const depth = Math.min(32, Math.max(1, cell.waterDepth || 1));
      const deep = /swamp/.test(cell.biome || "") ? [55,77,62] : [35,58,115];
      const shallow = /swamp/.test(cell.biome || "") ? [100,112,69] : [77,119,166];
      const a = 1 - Math.exp(-depth / 9);
      return output(cell,hex(shallow.map((v,i) => v * (1-a) + deep[i] * a)));
    }
    // 西北光照的局部坡面与邻柱遮蔽；缺失区块不当成零高度，避免边缘黑线。
    const h = cell.height ?? 0;
    const neighbor = (dx,dz) => heightAt(cell.x+dx,cell.z+dz,h);
    const slope = (neighbor(1,0) - neighbor(-1,0) + neighbor(0,1) - neighbor(0,-1)) / 2;
    const occlusion = Math.max(0, neighbor(-1,0)-h, neighbor(0,-1)-h);
    const light = /lava|glowstone|sea_lantern/.test(name) ? 1 : Math.max(.58, Math.min(1.22, 1 + Math.tanh(slope / 2.5) * .20 - Math.min(.15, occlusion * .025)));
    return output(cell,hex(base.map(v => v * light)));
  };
  if(inPlace){for(const cell of cells)shade(cell);return cells;}
  return cells.map(shade);
}
function tileImages(cells) {
  const size = 128, tiles = new Map();
  const bounds = { minX:Infinity, maxX:-Infinity, minZ:Infinity, maxZ:-Infinity };
  for (const c of cells) {
    const x = Math.floor(c.x / size) * size, z = Math.floor(c.z / size) * size, key = x + "," + z;
    let tile = tiles.get(key);
    if (!tile) {
      if(tiles.size>=4096)throw Error("地图分布过于分散，图片缓存超过 256 MiB 预算，请降低区块上限");
      tile = { x, z, bytes:Buffer.alloc((size * 4 + 1) * size) }; tiles.set(key, tile);
    }
    const at = (c.z - z) * (size * 4 + 1) + 1 + (c.x - x) * 4;
    const color = rgb(c.color); tile.bytes[at] = color[0]; tile.bytes[at+1] = color[1]; tile.bytes[at+2] = color[2]; tile.bytes[at+3] = 255;
    bounds.minX = Math.min(bounds.minX,c.x); bounds.maxX = Math.max(bounds.maxX,c.x);
    bounds.minZ = Math.min(bounds.minZ,c.z); bounds.maxZ = Math.max(bounds.maxZ,c.z);
  }
  const chunk = (type,data) => {
    const out = Buffer.alloc(data.length+12); out.writeUInt32BE(data.length); out.write(type,4,"ascii"); data.copy(out,8);
    out.writeUInt32BE(zlib.crc32(out.subarray(4,-4)),out.length-4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
  return { bounds:cells.length ? bounds : null, scale:1, tiles:[...tiles.values()].map(t => ({ x:t.x,z:t.z,size,
    image:"data:image/png;base64,"+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",zlib.deflateSync(t.bytes,{level:3})),chunk("IEND",Buffer.alloc(0))]).toString("base64") })) };
}
module.exports = { colorFor, visible, WATER, shadeCells, tileImages, rgb };
