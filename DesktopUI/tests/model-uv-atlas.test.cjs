const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { repackTexture } = require("../shared/model-uv.cjs");
const { uvFaces } = require("../shared/model-edit.cjs");
const { assignedTextures } = require("../shared/model-materials.cjs");
const { prepareModelProject, writeModelProject, importModelProject } = require("../electron/domains/profiles/model-projects.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { encodeRgbaPng, decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { digest } = require("../electron/domains/profiles/texture-layers.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");

const pixels = offset => ({ width: 16, height: 16, data: Buffer.from(Array.from({ length: 256 }, (_, i) => [(i + offset) % 256, i % 16 * 15, offset, i % 3 * 127]).flat()) });
const png = image => encodeRgbaPng(image.width, image.height, image.data);
const url = image => "data:image/png;base64," + png(image).toString("base64");
const fixture = () => [{ name: "body", pivot: [0,0,0], locators: { tip: [0,2,0] }, cubes: [
  { origin: [0,0,0], size: [2,2,2], uv: { north: { uv: [6,2], uv_size: [-4,3], uv_rotation: 90, dgn_texture: "textures/a.png", extra: 42 }, south: { uv: [2,2], uv_size: [4,3], dgn_texture: "textures/b.png" }, up: { uv: [2,2], uv_size: [4,3] }, down: { uv: [0,0], uv_size: [0,0], dgn_texture: "textures/b.png" } } },
  { origin: [3,0,0], size: [2,2,1], mirror: true, uv: [1,1] },
] }, { name: "empty", parent: "body" }];
function compareFaces(before, after, sources, output) {
  const occupied = new Set();
  before.forEach((bone, b) => (bone.cubes || []).forEach((cube, c) => {
    const old = uvFaces(cube), next = uvFaces(after[b].cubes[c]);
    old.forEach((a, i) => {
      const z = next[i], image = sources[cube.uv?.[a.name]?.dgn_texture || ""];
      assert.equal(z.w, a.w); assert.equal(z.h, a.h);
      for (let y = 0; y < Math.abs(a.h); y++) for (let x = 0; x < Math.abs(a.w); x++) {
        const from = ((Math.min(a.y, a.y+a.h)+y)*image.width+Math.min(a.x,a.x+a.w)+x)*4;
        const to = ((Math.min(z.y,z.y+z.h)+y)*output.width+Math.min(z.x,z.x+z.w)+x)*4;
        assert.deepEqual([...output.data.subarray(to,to+4)], [...image.data.subarray(from,from+4)], a.name);
        occupied.add(to/4);
      }
    });
  }));
  for (let i=0;i<output.width*output.height;i++) if (!occupied.has(i)) assert.deepEqual([...output.data.subarray(i*4,i*4+4)],[0,0,0,0]);
}

test("atlas copies each face from its own image, including shared UV, default boxes, signed rotation and alpha", () => {
  const bones = fixture(), before = structuredClone(bones), sources = { "": pixels(5), "textures/a.png": pixels(70), "textures/b.png": pixels(190) };
  const originals = Object.fromEntries(Object.entries(sources).map(([key, image]) => [key, Buffer.from(image.data)]));
  const packed = repackTexture(bones, sources[""], 32, 32, 1, sources);
  compareFaces(bones, packed.bones, sources, packed);
  assert.deepEqual(assignedTextures(packed.bones), []);
  assert.equal(packed.bones[0].cubes[0].uv.north.uv_rotation,90);
  assert.equal(packed.bones[0].cubes[0].uv.north.extra,42);
  assert.equal(packed.bones[0].cubes[1].mirror,true);
  assert.deepEqual(packed.bones[1],bones[1]); assert.deepEqual(bones,before);
  for (const [key, image] of Object.entries(sources)) assert.deepEqual(image.data, originals[key]);
});

test("atlas rejects missing, inherited or malformed images and named materials even on a zero-area face", () => {
  const bones = fixture(), source = pixels(20), sources = { "": source, "textures/a.png": source, "textures/b.png": source };
  const before = structuredClone(bones);
  assert.throws(()=>repackTexture(bones,source,32,32,1,{"textures/a.png":source,"textures/b.png":source}),/默认/);
  assert.throws(()=>repackTexture(bones,source,32,32,1,Object.create(sources)),/缺少/);
  assert.throws(()=>repackTexture(bones,source,32,32,1,{...sources,"textures/b.png":{...source,width:8}}),/分辨率/);
  assert.throws(()=>repackTexture(bones,source,32,32,1,{...sources,"textures/b.png":{...source,data:[]}}),/像素/);
  assert.throws(()=>repackTexture(bones,source,32,32,1,{...sources,"extra.png":source}),/未绑定/);
  assert.deepEqual(bones,before);
  const named = structuredClone(bones); named[0].cubes[0].uv.down.material_instance="alpha_test";
  assert.throws(()=>repackTexture(named,source,32,32,1,sources),/命名分面材质/);
  const unsafe = structuredClone(bones); unsafe[0].cubes[0].uv.north.dgn_texture="../outside.png";
  assert.throws(()=>repackTexture(unsafe,source,32,32,1,sources),/相对路径/);
});

test("atlas bounds the full palette including default and validates zero-area bindings", () => {
  const image=pixels(10), bones=[{name:"body",cubes:Array.from({length:8},(_,i)=>({uv:{north:{uv:[0,0],uv_size:[1,1],dgn_texture:i+".png"}}}))}];
  const sources=Object.fromEntries(Array.from({length:8},(_,i)=>[i+".png",image]));
  assert.equal(assignedTextures(repackTexture(bones,image,32,32,1,sources).bones).length,0);
  bones[0].cubes.push({uv:{north:{uv:[0,0],uv_size:[0,0]}}});
  assert.throws(()=>repackTexture(bones,image,32,32,1,{...sources,"":image}),/最多 8/);
  bones[0].cubes.pop(); bones[0].cubes.length=5;
  const large={width:2048,height:2048,data:new Uint8Array(2048*2048*4)};
  assert.throws(()=>repackTexture(bones,large,32,32,1,Object.fromEntries(Array.from({length:5},(_,i)=>[i+".png",large]))),/1600 万/);
});

test("atlas export retains animations and display, validates revisions, and reimports without touching sources", async () => {
  const root=artifactPath("service"), studio=path.join(root,"studio"), folder=path.join(studio,"atlas"), file=path.join(folder,"model.geo.json");
  await fs.mkdir(path.join(folder,"textures"),{recursive:true});
  const bones=fixture(), source={"":pixels(5),"textures/a.png":pixels(70),"textures/b.png":pixels(190)};
  const original=JSON.stringify({"minecraft:geometry":[{description:{identifier:"geometry.atlas",texture_width:16,texture_height:16},bones}],unknown:42});
  await fs.writeFile(file,original,"utf8");
  const animationText=JSON.stringify({animations:{"animation.atlas":{loop:true,animation_length:1,bones:{body:{rotation:{"0.00":[0,0,0],"1.00":[0,30,0]}}},sound_effects:{"0.50":{effect:"test.click"}}}}});
  await fs.writeFile(path.join(folder,"model.animation.json"),animationText,"utf8");
  for(const key of ["textures/a.png","textures/b.png"]) await fs.writeFile(path.join(folder,key),png(source[key]));
  const library={list:async()=>({mods:[]})}, display={gui:{rotation:[10,20,30],translation:[1,0,0],scale:[1,1,1]}};
  const args={path:file,identifier:"geometry.atlas",bones,textureWidth:16,textureHeight:16,texture:url(source[""]),display,repack:{width:32,height:32,padding:1},textureOverrides:{"textures/a.png":url(source["textures/a.png"]),"textures/b.png":url(pixels(230))},textureRevisions:Object.fromEntries(["textures/a.png","textures/b.png"].map(key=>[key,digest(png(source[key]))]))};
  const bytes=await prepareModelProject(library,args,null,studio), model=JSON.parse(bytes), converted=importProject(model);
  assert.equal(model.meta.model_format,"bedrock");assert.equal(model.textures.length,1);assert.deepEqual(assignedTextures(converted.bones),[]);
  assert.equal(converted.animations["animation.atlas"].bones.body.rotation["1.00"][1],30);
  assert.equal(converted.animations["animation.atlas"].sound_effects["0.50"].effect,"test.click");
  assert.deepEqual(converted.display,display);assert.deepEqual(converted.bones[0].locators.tip.offset,[0,2,0]);
  const output=decodePng(Buffer.from(converted.texture.split(",")[1],"base64"));
  compareFaces(bones,converted.bones,{...source,"textures/b.png":pixels(230)},{width:32,height:32,data:output.pixels});
  const target=path.join(root,"atlas.bbmodel");await writeModelProject(target,bytes);const imported=await importModelProject(target,studio);
  assert.equal(imported.animations,1);assert.notEqual(path.dirname(imported.path),folder);
  assert.equal((await fs.readdir(path.join(path.dirname(imported.path),"textures"))).length,1);
  await assert.rejects(prepareModelProject(library,{...args,texture:""},null,studio),/默认/);
  await assert.rejects(prepareModelProject(library,{...args,textureRevisions:{"textures/a.png":"bad"}},null,studio),/版本快照/);
  await assert.rejects(prepareModelProject(library,{...args,textureOverrides:{"textures/a.png":""}},null,studio),/缺少 PNG/);
  await assert.rejects(prepareModelProject(library,{...args,textureOverrides:{sources:{}}},null,studio),/快照/);
  const boundOnly=structuredClone(bones); boundOnly[0].cubes.length=1;delete boundOnly[0].cubes[0].uv.up;
  const noDefault=JSON.parse(await prepareModelProject(library,{...args,bones:boundOnly,texture:""},null,studio));
  assert.equal(noDefault.textures.length,1);assert.equal(noDefault.animations.length,1);
  assert.equal(await fs.readFile(file,"utf8"),original);assert.equal(await fs.readFile(path.join(folder,"model.animation.json"),"utf8"),animationText);
  assert.deepEqual(await fs.readFile(path.join(folder,"textures/b.png")),png(source["textures/b.png"]));
  await fs.writeFile(path.join(folder,"textures/a.png"),png(pixels(99)));
  await assert.rejects(prepareModelProject(library,args,null,studio),/外部修改/);
  assert.deepEqual(await fs.readFile(target),bytes);
});
