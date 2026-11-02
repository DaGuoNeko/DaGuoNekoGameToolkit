const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const nbt = require("prismarine-nbt");
const { Database } = require("@jsprismarine/leveldb");
const { openWorldZip } = require("./world-zip.cjs");
const { readWorldInfo } = require("./world-info.cjs");

const { colorFor, visible, WATER, shadeCells, tileImages } = require("./map-colors.cjs");
const { NearestChunks } = require("./map-nearest.cjs");

function longValue(value) {
  if (typeof value === "bigint") return value;
  if (Array.isArray(value)) return (BigInt(value[0]) << 32n) + BigInt(value[1] >>> 0);
  return BigInt(value || 0);
}

function packedValue(data, index, bits) {
  if (!data?.length || bits <= 0) return 0;
  // 现代 Java 调色板每个 long 单独填充，剩余位不能跨字拼接。
  const perWord = Math.floor(64 / bits);
  const word = Math.floor(index / perWord), shift = index % perWord * bits;
  const value = longValue(data[word]);
  return Number((value >> BigInt(shift)) & ((1n << BigInt(bits)) - 1n));
}

function javaSectionBlocks(section) {
  const root = section?.value || section || {};
  const states = root.block_states?.value;
  if (!states) return null;
  const palettes = states.palette?.value?.value || [];
  const names = palettes.map((entry) => entry?.Name?.value || entry?.value?.Name?.value || "minecraft:air");
  const data = states.data?.value || [];
  const bits = Math.max(4, Math.ceil(Math.log2(Math.max(1, names.length))));
  if (!names.length || names.length > 4096 || (names.length > 1 && data.length < Math.ceil(4096 / Math.floor(64 / bits))))
    throw Error("Java 区块调色板数据不完整");
  return { y: root.Y?.value ?? 0, names, data, bits, biomes:root.biomes?.value };
}

function javaChunkCells(parsed) {
  const root = parsed?.value || {};
  const x = root.xPos?.value, z = root.zPos?.value;
  if (!Number.isInteger(x) || !Number.isInteger(z)) return [];
  if (!root.sections) throw Error("暂不支持该 Java 区块格式");
  const sections = (root.sections?.value?.value || []).map(javaSectionBlocks).filter(Boolean).sort((a, b) => b.y - a.y);
  const result = [];
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    let name = null, height=0, biome="minecraft:plains", ground=null;
    for (const section of sections) {
      for (let ly = 15; ly >= 0; ly--) {
        const index = ly * 256 + lz * 16 + lx;
        const candidate = section.names[packedValue(section.data, index, section.bits)];
        if (!candidate) throw Error("Java 区块调色板索引无效");
        if (!visible(candidate)) continue;
        if (!name) {
          name=candidate; height=section.y*16+ly;
          const palette=section.biomes?.palette?.value?.value;
          if(palette?.length) biome=palette[packedValue(section.biomes?.data?.value, (ly>>2)*16+(lz>>2)*4+(lx>>2), Math.max(1,Math.ceil(Math.log2(palette.length))))] || biome;
          if(!WATER.test(name)) break;
        }
        if(!WATER.test(candidate)) { ground=section.y*16+ly; break; }
        if(height-(section.y*16+ly)>=32) { ground=height-32; break; }
      }
      if (name && (!WATER.test(name)||ground!==null)) break;
    }
    const color = colorFor(name,biome);
    if (color) result.push({ x: x * 16 + lx, z: z * 16 + lz, color, name, height, biome, waterDepth:WATER.test(name) ? height-(ground??height-32) : 0 });
  }
  return result;
}

function bedrockChunkKey(key) {
  const typeOffset = key.length === 14 ? 12 : 8;
  if (![10, 14].includes(key.length) || key[typeOffset] !== 0x2f) return null;
  const dimensionId = key.length === 14 ? key.readInt32LE(8) : 0;
  return { x: key.readInt32LE(0), z: key.readInt32LE(4), sub: key.readInt8(key.length - 1), dimension: ["overworld", "nether", "the_end"][dimensionId] ?? `dimension:${dimensionId}` };
}

async function parseBedrockSubchunk(raw) {
  const version = raw[0];
  if (![8, 9].includes(version)) throw Error(`暂不支持基岩子区块版本 ${version}`);
  const layerCount = raw[1], subChunkIndex = version >= 9 ? raw.readInt8(2) : null;
  if (!Number.isInteger(layerCount) || layerCount > 8) throw Error("基岩子区块层数无效");
  let offset = version >= 9 ? 3 : 2;
  const layers = [];
  for (let layer = 0; layer < layerCount; layer++) {
    const storageVersion = raw[offset++], runtimePalette = (storageVersion & 1) === 0, bits = storageVersion >> 1;
    if (!runtimePalette || ![0,1,2,3,4,5,6,8,16].includes(bits)) throw Error("基岩子区块存储格式不支持");
    const blocksPerWord = bits ? Math.floor(32 / bits) : 4096, words = bits ? Math.ceil(4096 / blocksPerWord) : 0, dataOffset = offset;
    offset += words * 4;
    let paletteSize = bits === 0 ? 1 : raw.readInt32LE(offset);
    if (bits > 0) offset += 4;
    if (paletteSize < 1 || paletteSize > 4096) throw Error("基岩子区块调色板无效");
    const palette = [];
    for (let i = 0; i < paletteSize; i++) {
      const result = await nbt.parse(raw.subarray(offset), "little");
      offset += result.metadata.size;
      palette.push(result.parsed?.value?.name?.value || "minecraft:air");
    }
    const indices = new Array(4096).fill(0);
    if (bits > 0) for (let i = 0; i < 4096; i++) {
      const word = raw.readUInt32LE(dataOffset + Math.floor(i / blocksPerWord) * 4);
      indices[i] = (word >>> ((i % blocksPerWord) * bits)) & ((1 << bits) - 1);
    }
    layers.push({ subChunkIndex, palette, indices });
  }
  return layers;
}

function parseAnvilChunk(buffer, index) {
  if (buffer.length < 8192 || index < 0 || index >= 1024) return null;
  const location = buffer.readUInt32BE(index * 4);
  if (!location) return null;
  const offset = (location >>> 8) * 4096, sectors = (location & 255) * 4096;
  if (offset < 8192 || offset + sectors > buffer.length || offset + 5 > buffer.length) return null;
  const length = buffer.readUInt32BE(offset);
  if (length < 1 || length > sectors - 4) return null;
  const compressed = buffer.subarray(offset + 5, offset + 4 + length);
  try {
      const type = buffer[offset + 4];
      if (![1, 2, 3].includes(type)) throw Error("Java 区块压缩方式暂不支持");
      const decoded = type === 1 ? zlib.gunzipSync(compressed, { maxOutputLength: 16 * 1024 ** 2 }) : type === 2 ? zlib.inflateSync(compressed, { maxOutputLength: 16 * 1024 ** 2 }) : compressed;
    return nbt.parseUncompressed(decoded, "big");
  } catch { return null; }
}

async function javaCells(root, dimension, maxChunks = 2500, center = [0,0], onProgress = ()=>{}) {
  const directory = dimension === "nether" ? path.join(root, "DIM-1") : dimension === "the_end" ? path.join(root, "DIM1") : root;
  const region = path.join(directory, "region");
  const files = (await fs.readdir(region, { withFileTypes: true }).catch(e => { if (e.code === "ENOENT") return []; throw e; })).filter((e) => e.isFile() && /^r\.-?\d+\.-?\d+\.mca$/i.test(e.name));
  if (files.length > 4096) throw Error("Java 地图区域文件过多，未继续预览");
  const distance=entry=>{const [,rx,rz]=/^r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(entry.name);return Math.max(Number(rx)*512-center[0],center[0]-(Number(rx)*512+496),Number(rz)*512-center[1],center[1]-(Number(rz)*512+496),0);};
  files.sort((a,b)=>distance(a)-distance(b));
  const cells = [], nearest=new NearestChunks(maxChunks,center);
  let chunksRead = 0, skipped = 0, scanned=0;
  for (const entry of files) {
    if(distance(entry)>nearest.farthest) {nearest.truncated=true;break;}
    onProgress("索引 Java 区域",scanned++,files.length);
    const handle=await fs.open(path.join(region,entry.name),"r"), header=Buffer.alloc(8192);
    let bytesRead;
    try { ({bytesRead}=await handle.read(header,0,8192,0)); } finally { await handle.close(); }
    if(bytesRead<8192) continue;
    const [,rx,rz]=/^r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(entry.name);
    for(let i=0;i<1024;i++) if(header.readUInt32BE(i*4)) {
      const x=(Number(rx)*32+i%32)*16,z=(Number(rz)*32+Math.floor(i/32))*16;
      nearest.add(x+","+z,x,z,()=>({file:entry.name,index:i}));
    }
  }
  const locations=nearest.sorted();
  const groups=new Map();
  for(const item of locations.slice(0,maxChunks)) { if(!groups.has(item.file)) groups.set(item.file,[]); groups.get(item.file).push(item.index); }
  for(const [file,indices] of groups) {
    const buffer=await readFile(path.join(region,file),256*1024**2);
    for(const i of indices) {
      const parsed = parseAnvilChunk(buffer, i);
      if (parsed) {
        try { cells.push(...javaChunkCells(parsed)); chunksRead++; }
        catch { skipped++; }
      } else skipped++;
      onProgress("读取 Java 区块", chunksRead + skipped, Math.min(locations.length, maxChunks));
      if ((chunksRead + skipped) % 16 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  }
  return { cells, truncated:nearest.truncated, chunksRead, skipped };
}

async function bedrockCells(root, dimension, maxChunks = 2500, center = [0,0], onProgress = ()=>{}) {
  const db = await Database.open(path.join(root, "db"), { readOnly: true });
  const nearest = new NearestChunks(maxChunks,center), cells=[];
  let skipped = 0, entriesRead = 0;
  try {
    for (const key of db.keys()) {
      if (++entriesRead > 5000000) throw Error("基岩索引超过 500 万条记录，请使用较小的存档副本");
      if (entriesRead % 256 === 0) {onProgress("索引基岩数据",entriesRead,null);await new Promise(resolve => setImmediate(resolve));}
      const info=bedrockChunkKey(key); if(!info || info.dimension!==dimension) continue;
      const id=info.x+","+info.z;
      const retained=nearest.add(id,info.x*16,info.z*16,()=>({keys:[]}));
      if(retained)retained.keys.push({key,info});
    }
    const selected=nearest.sorted();
    let completed=0;
    for(const chunk of selected) {
      const columns=new Map(), floors=new Map();
      for(const {key,info} of chunk.keys) {
        let layers;
        try { layers=await parseBedrockSubchunk(db.get(key)); } catch { skipped++; continue; }
        for(const layer of layers) for(let x=0;x<16;x++) for(let z=0;z<16;z++) {
          let top=null, ground=null;
          for(let y=15;y>=0;y--) {
            const name=layer.palette[layer.indices[x*256+z*16+y]];
            if(!name) throw Error("基岩区块调色板索引无效");
            if(!visible(name)) continue;
            const height=(layer.subChunkIndex??info.sub)*16+y;
            if(!top) top={x:info.x*16+x,z:info.z*16+z,name,height,color:colorFor(name)};
            if(!WATER.test(name)) { ground=height; break; }
          }
          const id=x+","+z, old=columns.get(id);
          if(top && (!old||top.height>old.height)) columns.set(id,top);
          if(ground!==null) floors.set(id,Math.max(ground,floors.get(id)??-Infinity));
        }
      }
      for(const [id,cell] of columns) cells.push({...cell,waterDepth:WATER.test(cell.name)?Math.min(32,cell.height-(floors.get(id)??cell.height-32)):0});
      onProgress("读取基岩区块", ++completed, selected.length);
      await new Promise(resolve => setImmediate(resolve));
    }
    return {cells,truncated:nearest.truncated,chunksRead:selected.length,skipped};
  } finally { await db.close(); }
}

function levelFormat(bytes) {
  if (bytes.length > 8 * 1024 ** 2) throw Error("地图 level.dat 超出读取上限");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const root = nbt.parseUncompressed(zlib.gunzipSync(bytes, { maxOutputLength: 16 * 1024 ** 2 }), "big");
    if (!root.value?.Data) throw Error("Java 地图 level.dat 无效");
    return "java";
  }
  readWorldInfo(bytes);
  return "bedrock";
}

async function safeDirectory(directory) {
  const stat = await fs.lstat(directory), real = await fs.realpath(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real.toLowerCase() !== path.resolve(directory).toLowerCase())
    throw Error("地图或缓存目录不能是链接");
}
async function readFile(file, maxBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw Error("地图文件无效或超过读取上限");
  return fs.readFile(file);
}
async function extractArchive(source, destination) {
  const archive = await openWorldZip(source, levelFormat);
  try { await archive.extract(destination, safeDirectory); }
  finally { await archive.close(); }
}
async function sourceStamp(root, format, dimension, onProgress) {
  const rows = [];
  const dirs = format === "bedrock" ? ["db"] : [dimension==="nether"?"DIM-1/region":dimension==="the_end"?"DIM1/region":"region"];
  for (const relative of dirs) {
    const dir = path.join(root, relative);
    try { await safeDirectory(dir); } catch (e) { if (e.code === "ENOENT" && format === "java") continue; throw e; }
    const files = await fs.readdir(dir, { withFileTypes: true });
    if (files.length > 100000) throw Error("地图文件过多");
    for (const entry of files) {
      if(rows.length%64===0)onProgress("检查地图文件",rows.length,files.length);
      if (entry.isSymbolicLink()) throw Error("地图数据包含链接");
      if (!entry.isFile()) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      rows.push([relative, entry.name, stat.size, stat.mtimeMs, stat.ctimeMs]);
    }
  }
  if (format === "bedrock") {
    const current = (await readFile(path.join(root, "db/CURRENT"), 256)).toString("utf8").trim();
    if (!/^MANIFEST-\d+$/.test(current)) throw Error("基岩 CURRENT 文件无效");
  }
  return JSON.stringify(rows.sort((a,b) => (a[0]+a[1]).localeCompare(b[0]+b[1])));
}
async function renderWorld({ source, format = "auto", dimension = "overworld", maxChunks = 2500, centerX = 0, centerZ = 0, relief = true, dataRoot, onProgress = ()=>{} }) {
  if (typeof source !== "string" || !path.isAbsolute(source)) throw Error("地图来源必须是绝对路径");
  if (!["auto","java","bedrock"].includes(format) || !["overworld","nether","the_end"].includes(dimension))
    throw Error("地图格式或维度无效");
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 10000 || ![centerX,centerZ].every(v=>Number.isInteger(v)&&Math.abs(v)<=30000000) || typeof relief!=="boolean")
    throw Error("地图预览范围无效");
  let root = path.resolve(source), temporary = false;
  try {
    if (/\.(zip|mcworld)$/i.test(root)) {
      onProgress("解压存档",0,null);
      const cache = path.join(dataRoot, "map-previews");
      await fs.mkdir(cache, { recursive: true }); await safeDirectory(cache);
      root = path.join(cache, crypto.randomUUID()); temporary = true;
      await extractArchive(source, root);
    }
    await safeDirectory(root);
    const detected = levelFormat(await readFile(path.join(root, "level.dat"), 8 * 1024 ** 2));
    if (format !== "auto" && format !== detected) throw Error("所选格式与地图不匹配");
    const before = await sourceStamp(root, detected,dimension,onProgress);
    const captured = detected === "bedrock" ? await bedrockCells(root, dimension, maxChunks,[centerX,centerZ],onProgress) : await javaCells(root, dimension, maxChunks,[centerX,centerZ],onProgress);
    if (before !== await sourceStamp(root, detected,dimension,onProgress)) throw Error("地图在预览期间发生变化，请保存退出游戏后重新预览");
    if (!captured.cells.length && captured.skipped) throw Error("地图区块损坏或格式不支持，未生成预览");
    onProgress("计算地形明暗",0,null);
    const rendered=shadeCells(captured.cells,relief,true);
    onProgress("生成地图图片",0,null);
    return { format: detected, dimension, centerX,centerZ,maxChunks, truncated: captured.truncated, chunksRead: captured.chunksRead, skipped: captured.skipped, ...tileImages(rendered) };
  } finally {
    if (temporary && await fs.lstat(root).catch(() => null)) {
      await safeDirectory(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

module.exports = { renderWorld, colorFor, javaCells, bedrockCells };
