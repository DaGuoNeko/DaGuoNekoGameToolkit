const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { repackTexture } = require("../shared/model-uv.cjs");
const { uvFaces } = require("../shared/model-edit.cjs");
const { decodePng, encodeRgbaPng } = require("../electron/domains/skins/npc-skins.cjs");
const { prepareModelProject, writeModelProject, importModelProject } = require("../electron/domains/profiles/model-projects.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");

const fixture = () => [{ name: "body", pivot: [0, 0, 0], cubes: [
  { origin: [0,0,0], size: [2,3,1], uv: [1,1], mirror: true },
  { origin: [3,0,0], size: [2,2,1], uv: [1,1] },
  { origin: [0,4,0], size: [2,2,1], uv: { north: { uv: [5,4], uv_size: [-3,2], uv_rotation: 90 }, south: { uv: [2,3], uv_size: [2,-2] } } },
] }];
const pixels = () => Buffer.from(Array.from({ length: 16 * 16 }, (_, i) => [i % 16 * 16, Math.floor(i / 16) * 16, 128, i % 3 === 0 ? 0 : i % 3 === 1 ? 128 : 255]).flat());
function checkFaces(before, after, image, output) {
  const occupied = new Set();
  for (let b = 0; b < before.length; b++) for (let c = 0; c < before[b].cubes.length; c++) {
    const from = uvFaces(before[b].cubes[c]), to = uvFaces(after[b].cubes[c]);
    for (let i = 0; i < from.length; i++) {
      assert.equal(from[i].w, to[i].w); assert.equal(from[i].h, to[i].h);
      for (let y = 0; y < Math.abs(from[i].h); y++) for (let x = 0; x < Math.abs(from[i].w); x++) {
        const sx = Math.min(from[i].x, from[i].x + from[i].w) + x, sy = Math.min(from[i].y, from[i].y + from[i].h) + y;
        const tx = Math.min(to[i].x, to[i].x + to[i].w) + x, ty = Math.min(to[i].y, to[i].y + to[i].h) + y;
        const a = (sy * image.width + sx) * 4, d = (ty * output.width + tx) * 4;
        assert.deepEqual([...output.data.slice(d,d+4)], [...image.data.slice(a,a+4)], from[i].name + " 原有像素必须保持");
        occupied.add(ty * output.width + tx);
      }
    }
  }
  for (let i = 0; i < output.width * output.height; i++) if (!occupied.has(i)) assert.deepEqual([...output.data.slice(i*4,i*4+4)],[0,0,0,0]);
}

test("repack duplicates overlapping sources and keeps signed faces, mirrors, rotations and exact RGBA", () => {
  const bones = fixture(), before = structuredClone(bones), image = { width: 16, height: 16, data: pixels() }, original = Buffer.from(image.data);
  const packed = repackTexture(bones, image, 24, 20, 1);
  checkFaces(bones, packed.bones, image, packed);
  assert.equal(packed.bones[0].cubes[0].mirror,true);
  assert.equal(packed.bones[0].cubes[2].uv.north.uv_rotation,90);
  assert.deepEqual(bones,before); assert.deepEqual(image.data,original);
  assert.deepEqual(repackTexture(bones,image,24,20,1),packed);
});

test("unsafe source UV, fractional boundaries, excessive work and invalid requests fail without mutation", () => {
  const source = fixture(), image = { width: 16, height: 16, data: pixels() };
  for (const [mutate, pattern] of [
    [b => { b[0].cubes[0].uv[0] = -.5; }, /整数/],
    [b => { b[0].cubes[0].uv[0] = -1; }, /源 UV/],
    [b => { b[0].cubes[2].uv.north.uv_size[0] = -3.5; }, /整数/],
    [b => { b[0].cubes[2].uv.north.material_instance = "other"; }, /分面材质/],
  ]) { const bones = structuredClone(source); mutate(bones); const before = structuredClone(bones); assert.throws(()=>repackTexture(bones,image,32,32,1),pattern); assert.deepEqual(bones,before); }
  assert.throws(()=>repackTexture(source,image,4,4,1),/放不下/);
  assert.throws(()=>repackTexture(source,image,32,32,-1),/间距/);
  assert.throws(()=>repackTexture(source,{...image,data:new Uint8Array(4)},32,32),/像素/);
  assert.throws(()=>repackTexture(source,image,2049,32),/边长/);
  const huge = [{ cubes: Array.from({ length: 9 },()=>({uv:{north:{uv:[0,0],uv_size:[2048,2048]}}})) }];
  assert.throws(()=>repackTexture(huge,{width:2048,height:2048,data:new Uint8Array(2048*2048*4)},2048,2048),/过多/);
});

test("repacked project is prepared on the backend, exported with backups and reimports as an isolated draft", async () => {
  const root=artifactPath("service"),studio=path.join(root,"studio"),folder=path.join(studio,"source");
  await fs.mkdir(folder,{recursive:true});
  const file=path.join(folder,"model.geo.json"),bones=fixture();
  const original=JSON.stringify({"minecraft:geometry":[{description:{identifier:"geometry.repack",texture_width:16,texture_height:16},bones}]});
  await fs.writeFile(file,original,"utf8");
  const animation={loop:true,animation_length:1,bones:{body:{rotation:{"0.00":[0,0,0],"1.00":[0,10,0]}}}};
  const animationText=JSON.stringify({animations:{"animation.repack":animation}});
  await fs.writeFile(path.join(folder,"model.animation.json"),animationText,"utf8");
  const sourcePng=encodeRgbaPng(16,16,pixels());await fs.writeFile(path.join(folder,"source.png"),sourcePng);
  const library={list:async()=>({mods:[]})};
  const args={path:file,identifier:"geometry.repack",bones,textureWidth:16,textureHeight:16,texture:"data:image/png;base64,"+sourcePng.toString("base64"),display:{gui:{rotation:[10,20,30],translation:[0,0,0],scale:[1,1,1]}},repack:{width:24,height:20,padding:1}};
  const bytes=await prepareModelProject(library,args,null,studio),model=JSON.parse(bytes),converted=importProject(model);
  assert.equal(converted.textureWidth,24);assert.equal(converted.textureHeight,20);
  const decoded=decodePng(Buffer.from(converted.texture.split(",")[1],"base64"));
  checkFaces(bones,converted.bones,{width:16,height:16,data:pixels()},{width:24,height:20,data:decoded.pixels});
  assert.equal(converted.animations["animation.repack"].loop,true);assert.equal(converted.animations["animation.repack"].bones.body.rotation["1.00"][1],10);
  assert.deepEqual(converted.display,args.display);
  const output=path.join(root,"packed.bbmodel");await writeModelProject(output,bytes);await writeModelProject(output,bytes);
  assert.equal((await fs.readdir(root)).filter(name=>name.endsWith(".bak")).length,1);
  const reopened=await importModelProject(output,studio);
  assert.notEqual(path.dirname(reopened.path),folder);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(reopened.path),"textures/texture.png")),Buffer.from(converted.texture.split(",")[1],"base64"));
  assert.equal(await fs.readFile(file,"utf8"),original);assert.equal(await fs.readFile(path.join(folder,"model.animation.json"),"utf8"),animationText);assert.deepEqual(await fs.readFile(path.join(folder,"source.png")),sourcePng);
  for(const repack of [null,[],false,{width:24,height:20,padding:1,extra:true},{width:0,height:20,padding:1}])await assert.rejects(prepareModelProject(library,{...args,repack},null,studio));
  await assert.rejects(prepareModelProject(library,{...args,texture:""},null,studio),/需要当前贴图/);
  await assert.rejects(prepareModelProject(library,{...args,textureWidth:32},null,studio),/尺寸/);
  await assert.rejects(prepareModelProject(library,{...args,path:path.join(root,"packed.bbmodel")},null,studio),/只能修改/);
});
