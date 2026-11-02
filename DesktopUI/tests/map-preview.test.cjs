const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { javaWorld } = require("./fixtures/java-world.cjs");
const { renderWorld, colorFor, javaCells, bedrockCells } = require("../electron/domains/worlds/map-preview.cjs");
const { shadeCells, tileImages, visible } = require("../electron/domains/worlds/map-colors.cjs");
const { javaMap, bedrockMap, zipMap, indexAt, names } = require("./fixtures/map-world.cjs");

test("map preview reads Java Anvil chunks and returns colored top-down cells", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-map-preview-java-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await javaWorld(root);
  const result = await renderWorld({ source: root, format: "java", maxChunks: 8, maxPixels: 10000, dataRoot: root });
  assert.equal(result.format, "java");
  assert.equal(result.chunksRead, 2);
  assert(result.tiles.length > 0);
  const raw=await javaCells(root,"overworld");
  assert.deepEqual(raw.cells.sort((a,b)=>a.x-b.x).map(c => [c.x, c.z]), [[-1, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
  assert.equal(colorFor("minecraft:air"), null);
  assert.equal(result.scale,1);
});

for (const [format, create] of [["java", javaMap], ["bedrock", bedrockMap]]) {
  test(`${format} preview preserves X/Z, highest surface, packed palettes and source bytes`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-map-check-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const world = path.join(root, "world"); await create(world);
    const digest = async () => {
      const crypto = require("node:crypto"), hash = crypto.createHash("sha256");
      for (const file of (await fs.readdir(world, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).sort((a,b) => (a.parentPath+a.name).localeCompare(b.parentPath+b.name))) {
        hash.update(file.name); hash.update(await fs.readFile(path.join(file.parentPath, file.name)));
      }
      return hash.digest("hex");
    };
    const before = await digest();
    const result = await renderWorld({ source: world, dataRoot: root });
    assert.equal(result.format, format);
    const raw=await (format==="java"?javaCells:bedrockCells)(world,"overworld");
    assert.equal(raw.cells.length,48*48);
    const colors = new Map(raw.cells.map(c => [`${c.x},${c.z}`, c.color]));
    for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++) {
      const expected = indexAt(x, 13, z) || indexAt(x, 3, z);
      assert.equal(colors.get(`${x},${z}`), colorFor(names[expected]), `${format} surface at ${x},${z}`);
    }
    const other = await renderWorld({ source: world, dimension: "the_end", dataRoot: root });
    assert.equal(other.tiles.length, 0);
    if (format === "bedrock") {
      const nether = await renderWorld({ source: world, dimension: "nether", dataRoot: root });
      assert.equal(nether.tiles.length, 1);
      const rawNether=await bedrockCells(world,"nether");
      assert.equal(rawNether.cells.length,256);
      assert(rawNether.cells.every(c => c.color === colorFor("minecraft:stone")));
    }
    const archive = path.join(root, "world.zip"); await zipMap(world, archive);
    const fromZip = await renderWorld({ source: archive, dataRoot: root });
    assert.deepEqual(fromZip, result);
    assert.equal(await digest(), before);
  });
}

test("dense map keeps every block pixel in bounded PNG tiles, including negative coordinates", () => {
  const cells = Array.from({ length: 250000 }, (_, i) => ({ x: i % 500 - 250, z: Math.floor(i / 500) - 250, color: "#ffffff" }));
  const result = tileImages(cells);
  assert.equal(result.tiles.length,16);
  assert.equal(result.scale,1);
  assert.deepEqual(result.bounds, { minX: -250, maxX: 249, minZ: -250, maxZ: 249 });
  let pixels=0;
  for(const tile of result.tiles) {
    const bytes=Buffer.from(tile.image.split(",")[1],"base64"),data=[];
    for(let o=8;o<bytes.length;) { const n=bytes.readUInt32BE(o); if(bytes.toString("ascii",o+4,o+8)==="IDAT") data.push(bytes.subarray(o+8,o+8+n)); o+=n+12; }
    const raw=require("node:zlib").inflateSync(Buffer.concat(data));
    for(let y=0;y<128;y++) for(let x=0;x<128;x++) if(raw[y*513+1+x*4+3]===255) pixels++;
  }
  assert.equal(pixels,250000);
});

test("terrain shading reveals slopes and water depth without noisy plant or unknown colors",()=>{
  const stone=(x,z,height)=>({x,z,height,name:"minecraft:stone"});
  const flat=shadeCells([stone(0,0,64)])[0].color;
  const shadow=shadeCells([stone(0,0,64),stone(-1,0,70),stone(1,0,70),stone(0,-1,70),stone(0,1,70)])[0].color;
  assert.notEqual(flat,shadow);
  const water=shadeCells([1,20].map((waterDepth,x)=>({x,z:0,height:64,name:"minecraft:water",waterDepth})));
  assert.notEqual(water[0].color,water[1].color);
  assert.equal(visible("minecraft:short_grass"),false);
  assert.notEqual(colorFor("minecraft:sandstone"),colorFor("minecraft:stone"));
  assert.notEqual(colorFor("minecraft:spruce_planks"),colorFor("minecraft:birch_planks"));
  assert.notEqual(colorFor("minecraft:dark_oak_planks"),colorFor("minecraft:oak_planks"));
  assert.notEqual(colorFor("minecraft:grass_block","minecraft:desert"),colorFor("minecraft:grass_block","minecraft:forest"));
  assert.equal(colorFor("example:unknown"),"#938d85");
});

test("built-in map palette covers materials without any external resources",()=>{
  const {format,colors}=require("../electron/domains/worlds/map-palette.json");
  assert.equal(format,1);
  assert.equal(Object.keys(colors).length,824);
  for(const [name,value] of Object.entries(colors)) {
    assert.match(name,/^minecraft:[a-z0-9_]+$/);
    assert.match(value,/^#[0-9a-f]{6}$/);
  }
  assert.equal(colorFor("minecraft:oak_planks"),"#a2834f");
  assert.equal(colorFor("minecraft:lava"),"#d9691a");
  assert.equal(colorFor("minecraft:grass_block","minecraft:plains"),"#546d33");
  const cell={x:0,z:0,height:64,name:"minecraft:oak_planks"};
  assert.equal(shadeCells([cell])[0].color,"#a2834f");
  assert.equal(shadeCells([cell],false)[0].color,"#a2834f");
});

test("standalone compiled preview includes palette and renders Java/Bedrock with external assets forbidden",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dgn-map-bundle-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bundle=path.join(root,"map.cjs");
  await require("esbuild").build({
    entryPoints:[path.resolve("electron/domains/worlds/map-preview.cjs")],outfile:bundle,
    bundle:true,platform:"node",format:"cjs",target:"node22",mainFields:["module","main"],
  });
  for(const [kind,create] of [["java",javaMap],["bedrock",bedrockMap]]) {
    const world=path.join(root,kind); await create(world);
    const child=require("node:child_process").spawnSync(process.execPath,["-e",String.raw`
      const fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path");
      const allowed=path.resolve(process.env.DGN_MAP_SANDBOX);
      const guard=file=>{
        if(typeof file==="number")return;
        const resolved=path.resolve(String(file));
        if(resolved!==allowed&&!resolved.startsWith(allowed+path.sep))throw Error("external file read denied");
        if(/\.(jar|png)$/i.test(resolved))throw Error("external image/JAR read denied");
      };
      for(const [object,methods] of [[fs,["readFileSync","openSync","statSync","lstatSync","readdirSync"]],[fsp,["readFile","open","stat","lstat","readdir","realpath"]]]) for(const name of methods) {
        const original=object[name]; object[name]=function(file,...args){guard(file);return original.call(this,file,...args);};
      }
      global.fetch=()=>{throw Error("network access denied");};
      const {renderWorld}=require(path.join(allowed,"map.cjs"));
      renderWorld({source:path.join(allowed,process.env.DGN_MAP_KIND),dataRoot:allowed}).then(r=>{
        if(r.format!==process.env.DGN_MAP_KIND||!r.tiles.length)throw Error("no rendered tiles");
        console.log("OK "+r.format+" "+r.tiles.length);
      }).catch(e=>{console.error(e.message);process.exitCode=1;});
    `],{cwd:root,env:{...process.env,DGN_MAP_SANDBOX:root,DGN_MAP_KIND:kind},encoding:"utf8",windowsHide:true,timeout:20000});
    assert.equal(child.status,0,child.stdout+child.stderr);
    assert.match(child.stdout,new RegExp("OK "+kind));
  }
});

test("invalid sources and corrupt ZIP fail explicitly and leave no extracted world", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-map-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(renderWorld({ source: root, dataRoot: root }), /ENOENT/);
  const source = path.join(root, "source"); await javaMap(source);
  await assert.rejects(renderWorld({ source, dataRoot: root, dimension: "bad" }), /维度/);
  await assert.rejects(renderWorld({ source, dataRoot: root, format: "bedrock" }), /不匹配/);
  const { zip } = require("./fixtures/zip.cjs");
  const file = path.join(root, "bad.zip");
  await fs.writeFile(file, zip([
    { name: "level.dat", data: await fs.readFile(path.join(source, "level.dat")) },
    { name: "region/r.0.0.mca", data: "bad bytes", crc: 0 },
  ]));
  await assert.rejects(renderWorld({ source: file, dataRoot: root }), /CRC/);
  assert.deepEqual(await fs.readdir(path.join(root, "map-previews")), []);
});
