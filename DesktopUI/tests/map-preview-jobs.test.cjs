const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {MapPreviewJobs}=require("../electron/domains/worlds/map-preview-jobs.cjs");
const {javaMap,bedrockMap}=require("./fixtures/map-world.cjs");
const {NearestChunks}=require("../electron/domains/worlds/map-nearest.cjs");
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test("nearest index is bounded, keeps nearby chunks and retains all subchunks of admitted columns",()=>{
  const nearest=new NearestChunks(4,[-10,20]),all=[];
  for(let i=1000;i>=-1000;i--) {
    const p={x:i*16,z:(i%7)*16};all.push(p);nearest.add(String(i),p.x,p.z,()=>({keys:[]}));
    assert(nearest.heap.length<=4);assert(nearest.byId.size<=4);
  }
  const expected=all.sort((a,b)=>nearest.compare({...a,distance:nearest.distance(a.x,a.z)},{...b,distance:nearest.distance(b.x,b.z)})).slice(0,4);
  assert.deepEqual(nearest.sorted().map(({x,z})=>({x,z})),expected);
  const p=nearest.sorted()[0];assert.equal(nearest.add(p.id,p.x,p.z,()=>{throw Error("duplicate");}),p);
  assert(nearest.truncated);
});

test("real background worker renders both formats, tracks progress and cleans job directories",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dgn-map-jobs-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const workerFile=path.join(root,"runtime/automation/map-preview-worker.cjs");
  await require("esbuild").build({entryPoints:[path.resolve("electron/domains/worlds/map-preview-worker.cjs")],outfile:workerFile,bundle:true,platform:"node",mainFields:["module","main"],target:"node22"});
  const service=new MapPreviewJobs(root,workerFile);t.after(()=>service.dispose());
  for(const [kind,create] of [["java",javaMap],["bedrock",bedrockMap]]) {
    const source=path.join(root,kind);await create(source,kind==="java"?[64]:[]);
    let timerTicks=0;const timer=setInterval(()=>timerTicks++,5);
    const promise=service.render(kind,{source,maxChunks:4,centerX:-16,centerZ:-16});
    assert.throws(()=>service.render("other",{source}),/已有地图/);
    const value=await promise;clearInterval(timer);
    assert(timerTicks>0);assert.equal(value.chunksRead,4);assert(value.truncated);assert(value.tiles.length>0);
    const shifted=await service.render(kind+"-shift",{source,maxChunks:1,centerX:16,centerZ:16});
    assert.equal(shifted.bounds.minX,16);assert.equal(shifted.bounds.minZ,16);
    if(kind==="java") {
      const distant=await service.render("distant",{source,maxChunks:1,centerX:1024,centerZ:0});
      assert.equal(distant.bounds.minX,1024);assert.equal(distant.bounds.minZ,0);
    }
    assert.equal(service.state(kind),null);
    assert.deepEqual(await fs.readdir(path.join(root,"map-preview-jobs")),[]);
  }
});

test("cancel, timeout and shutdown stop CPU workers without blocking event loop or replaying requests",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dgn-map-cancel-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const worker=path.resolve("tests/fixtures/map-busy-worker.cjs"),service=new MapPreviewJobs(root,worker,{timeoutMs:2000});t.after(()=>service.dispose());
  const pending=service.render("cancel",{source:root});const rejected=assert.rejects(pending,/取消/);
  for(let i=0;i<100&&service.state("cancel")?.stage!=="busy fixture";i++)await wait(10);
  assert.equal(service.state("cancel").stage,"busy fixture");
  assert.equal(await service.cancel("wrong"),false);
  assert.equal(await service.cancel("cancel"),true);await rejected;
  const timed=new MapPreviewJobs(root,worker,{timeoutMs:50});
  await assert.rejects(timed.render("timeout",{source:root}),/超时/);await timed.dispose();
  const during=service.render("close",{source:root}),closed=assert.rejects(during,/取消/);
  await service.dispose();await closed;
  assert.equal(service.active,null);assert.deepEqual(await fs.readdir(path.join(root,"map-preview-jobs")),[]);
  assert.throws(()=>service.render("late",{source:root}),/加载/);
});
