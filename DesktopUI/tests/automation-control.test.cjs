const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {spawn,execFile}=require("node:child_process"),exec=require("node:util").promisify(execFile);
const {once}=require("node:events");
const {inspectWindow,captureWindow}=require("../electron/domains/automation/automation-observation.cjs");
const {AutomationRouter}=require("../electron/domains/automation/automation-router.cjs");
const {WorkspaceStore}=require("../electron/services.cjs");
const {Profiles}=require("../electron/domains/profiles/profiles.cjs");
const {WorldLibrary}=require("../electron/domains/worlds/worlds.cjs");
const {levelData}=require("./fixtures/zip.cjs");
const {projectView,select,settingsSchema}=require("../electron/domains/automation/automation-config.cjs");
const {matches}=require("../electron/domains/automation/automation-scene.cjs");
const json=r=>JSON.parse(r.content[0].text);
function fixture(){
  const worker={session:{id:"s",pid:10,running:true,role:"world",bridgeRegistrationId:"reg"},sourceSnapshot:{config:{game_executable_path:"fixture"}},logs:[]};
  const b={id:"b",minecraftPid:20,mcdkPid:10,registrationId:"reg",connected:true,connectionGeneration:1,stateSequence:1,state:"game_ready",gameIpcConnected:true,debugCapabilityEnabled:true};
  const native={pid:20,processCreatedAt:"42",window:{hwnd:2,visible:true,minimized:false,width:800,height:500},assertions:[]};
  let calls=0,frames=0;
  const r=new AutomationRouter({sessions:{workers:[worker]},store:{value:{settings:{},projects:[]}},debug:{snapshot:()=>({sessions:[b]}),session(id,g){if(g!==b.connectionGeneration)throw Error("stale");return b;},async code(){calls++;return {playerId:"123",position:[0,4,0],world:"test",topUI:"in_game_play_screen"};}},
    inspectWindow:async()=>structuredClone(native),captureWindow:async()=>({data:Buffer.from("frame"+frames),width:800,height:500,frameTimestamp:null,backend:"fixture"})});
  return {r,worker,b,native,calls:()=>calls,changeFrame:()=>frames++};
}
test("readiness refuses assertions and unknown UI without blocking on game code; rejects changed generations",async()=>{
  const f=fixture();
  f.native.window.minimized=true;
  const minimized=json(await f.r.call("client_readiness",{sessionId:"s"}));
  assert(minimized.ready);assert.equal(minimized.safeToCaptureScene,false);
  f.native.window.minimized=false;
  const previousCalls=f.calls();
  f.native.assertions=[{id:"assert",text:"fixture",ignore:{enabled:true}}];
  const blocked=json(await f.r.call("client_readiness",{sessionId:"s"}));assert.equal(blocked.ready,false);assert.equal(f.calls(),previousCalls);
  f.native.assertions=[];f.r.debug.code=async()=>({playerId:"123",position:[0,4,0],world:"test",topUI:"loading"});
  assert.equal(json(await f.r.call("client_readiness",{sessionId:"s"})).ready,false);
  f.r.inspectWindow=async()=>{f.b.connectionGeneration++;return f.native;};
  assert.equal(json(await f.r.call("client_readiness",{sessionId:"s",generation:1})).ready,false);
});
test("repeated assertions warn but explicit one-shot ignore remains available",async()=>{
  const f=fixture();
  f.native.assertions=[{id:"first",pid:20,text:"Stream doesn't have enough charaters remaining to be a valid PNG!",ignore:{enabled:true}}];
  const first=json(await f.r.call("client_readiness",{sessionId:"s"}));
  assert.equal(first.assetLoadPhase,"resources");assert.equal(first.needsAttention,undefined);
  f.native.assertions=[{id:"second",pid:20,text:"Stream doesn't have enough charaters remaining to be a valid PNG!",ignore:{enabled:true}}];
  const second=json(await f.r.call("client_readiness",{sessionId:"s"}));
  assert.equal(second.needsAttention,true);assert(second.blockers.includes("REPEATED_ASSERTION"));assert.equal(second.worldLoaded,null);assert.equal(second.playerLoaded,null);
  let sent=0;
  f.r.inspectWindow=async(rt,w,b,id)=>{if(id){assert.equal(id,"second");sent++;f.native.assertions=[];return {...f.native,ignoreDispatched:true};}return structuredClone(f.native);};
  const answer=json(await f.r.call("resolve_client_assertion",{sessionId:"s",generation:1,assertionId:second.assertions[0].id,action:"ignore",confirmed:true}));
  assert.equal(sent,1);assert.equal(answer.resolved,true);assert.equal(answer.worldReady,null);
});
test("assertion resolution reports unresolved when the dialog remains",async()=>{
  const f=fixture();
  f.native.assertions=[{id:"native",pid:20,text:"warning",ignore:{enabled:true}}];
  let sent=false;
  f.r.inspectWindow=async(rt,w,b,id)=>{
    if(id){sent=true;return {...f.native,ignoreDispatched:true};}
    return structuredClone(f.native);
  };
  const observed=json(await f.r.call("list_client_assertions",{sessionId:"s",generation:1})).assertions[0];
  const answer=json(await f.r.call("resolve_client_assertion",{sessionId:"s",generation:1,assertionId:observed.id,action:"ignore",confirmed:true}));
  assert(sent);assert.equal(answer.dispatched,true);assert.equal(answer.resolved,false);
});
test("capture keeps raw metadata, refuses resized/changed targets and treats identical pixels as unknown freshness",async()=>{
  const f=fixture(),target={sessionId:"s",generation:1};
  let r=await f.r.call("capture_client_window",target);let meta=JSON.parse(r.content[1].text);
  assert.equal(meta.width,800);assert.equal(meta.freshness,"unknown");assert.equal(meta.sameAsPrevious,null);
  await assert.rejects(f.r.call("capture_client_window",{...target,requireChanged:true}),/UNCONFIRMED/);
  f.changeFrame();await f.r.call("capture_client_window",{...target,requireChanged:true});
  f.r.captureWindow=async()=>{f.native.window.occluded="yes";f.native.window.foreground=false;return {data:Buffer.from("covered"),width:800,height:500};};
  const covered=await f.r.call("capture_client_window",target);
  assert.equal(JSON.parse(covered.content[1].text).window.occluded,"yes");
  f.r.captureWindow=async()=>{f.b.stateSequence++;return {data:Buffer.from("x"),width:800,height:500};};
  await assert.rejects(f.r.call("capture_client_window",target),/WORLD_CHANGED/);
});
test("assertion resolution requires the exact current ID and never sends close or repeats a failed ignore",async()=>{
  const f=fixture();let sent=0;f.native.assertions=[{id:"one",ignore:{enabled:true}}];
  f.r.inspectWindow=async(rt,w,b,id)=>{if(id){sent++;throw Error("RESULT_UNKNOWN");}return f.native;};
  const args={sessionId:"s",generation:1,assertionId:"old",action:"ignore",confirmed:true};
  await assert.rejects(f.r.call("resolve_client_assertion",args),/ASSERT_CHANGED/);assert.equal(sent,0);
  const observed=json(await f.r.call("list_client_assertions",{sessionId:"s",generation:1})).assertions[0];
  await assert.rejects(f.r.call("resolve_client_assertion",{...args,assertionId:observed.id}),/RESULT_UNKNOWN/);assert.equal(sent,1);
  await assert.rejects(f.r.call("resolve_client_assertion",{...args,assertionId:observed.id}),/UNSUPPORTED|ATTEMPTED/);assert.equal(sent,1);
  await assert.rejects(f.r.call("resolve_client_assertion",{...args,action:"close"}),/参数/);
});
test("public config never returns unknown secret fields and rejects stale settings revisions",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dgn-control-"));
  t.after(async()=>{assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const store=new WorkspaceStore(root);await store.load();const profiles=new Profiles(store);await profiles.initialize();
  const revision=await store.settingsRevision();await store.updateSettings({ThemeHue:20},revision);
  await assert.rejects(store.updateSettings({ThemeHue:40},revision),/设置已变化/);
  const current=await store.settingsRevision();await fs.appendFile(store.file," ");await assert.rejects(store.updateSettings({ThemeHue:40},current),/设置已变化/);
  const v=projectView({project:{id:"p"},revision:"r",config:{user_name:"user",token:"fixture-secret",included_mod_dirs:[{path:"C:/mod",unknownCredential:"fixture-secret"}]},raw:"fixture-secret"});
  assert(!JSON.stringify(v).includes("fixture-secret"));
  const publicSettings=select({GameWindowSize:{enabled:true,width:800,height:500,unknownCredential:"fixture-secret"},ReloadKeys:{reload_key:"R",unknownCredential:"fixture-secret"}},settingsSchema);
  assert(!JSON.stringify(publicSettings).includes("fixture-secret"));
  const worlds=new WorldLibrary(store,path.join(root,"worlds"),{createImportProfile:name=>profiles.create(name)});
  const source=path.join(root,"source");await fs.mkdir(path.join(source,"db"),{recursive:true});await fs.writeFile(path.join(source,"level.dat"),levelData());await fs.writeFile(path.join(source,"db","sample"),"progress");
  const r=new AutomationRouter({sessions:{workers:[]},debug:{snapshot:()=>({sessions:[]})},worlds,profiles,store});
  const before=(await worlds.list()).worlds.length;await r.call("inspect_world_source",{source});assert.equal((await worlds.list()).worlds.length,before);
  const args={instanceId:r.instanceId,requestId:"one",name:"test",source,confirmed:true};
  const first=json(await r.call("import_world",args));assert.deepEqual(json(await r.call("import_world",args)),first);
  const clone=json(await r.call("clone_world",{instanceId:r.instanceId,requestId:"two",worldId:first.world.id,name:"copy",confirmed:true}));
  assert.notEqual(clone.world.id,first.world.id);assert.equal(await fs.readFile(path.join(worlds.location(clone.world.id),"db/sample"),"utf8"),"progress");
  await fs.writeFile(path.join(worlds.location(clone.world.id),"db/sample"),"changed");assert.equal(await fs.readFile(path.join(source,"db/sample"),"utf8"),"progress");
  await assert.rejects(r.call("update_settings",{revision:"r",patch:{AutomationEnabled:false}}),/参数/);
});
test("scene readback requires loaded chunks and measured camera, position, HUD, time and weather",()=>{
  const settings={position:[0,4,0],dimension:3,rotation:[0,20,0],fov:60,hudHidden:true,timeOfDay:6000,weather:"clear",perspective:0};
  const client={...settings,topUI:"hud_screen"},server={...settings,chunksLoaded:true,rules:{daylight_cycle:false,weather_cycle:false}};
  assert(matches(settings,client,server));assert(!matches(settings,client,{...server,chunksLoaded:false}));assert(!matches(settings,{...client,hudHidden:null,hudState:"unchanged"},server));assert(!matches(settings,client,{...server,position:[0,5,0]}));
  assert(!matches(settings,{...client,topUI:"pause_screen"},server));
});
test("unverifiable HUD requests fail before any game mutation",async()=>{
  const f=fixture();
  const response=await f.r.call("capture_scene",{sessionId:"s",generation:1,instanceId:f.r.instanceId,requestId:"hud",confirmed:true,settings:{hudHidden:true,timeOfDay:6000}});
  assert(response.isError);const report=json(response);
  assert.match(report.error,/HUD_READBACK_UNSUPPORTED/);assert.equal(report.effectsMayRemain,false);
  assert.equal(f.calls(),0);
});
test("per-session writes reject overlap; target identity is checked after asynchronous observations",async()=>{
  const f=fixture();let release;
  f.r.captureWindow=()=>new Promise(resolve=>{release=()=>resolve({data:Buffer.from("image"),width:800,height:500});});
  const pending=f.r.call("capture_client_window",{sessionId:"s",generation:1});
  while(!release)await new Promise(r=>setImmediate(r));
  await assert.rejects(f.r.call("execute_client_code",{sessionId:"s",generation:1,side:"client",code:"_result=1"}),/CLIENT_BUSY/);
  f.b.minecraftPid=999;release();await assert.rejects(pending,/WORLD_CHANGED/);
  assert.equal(f.calls(),0);
});
test("native capture refuses unavailable or minimized windows before probing",async()=>{
  const f=fixture();
  await assert.rejects(captureWindow(null,f.worker,f.b,{window:null}),/NOT_CAPTURABLE/);
  f.native.window.minimized=true;
  await assert.rejects(captureWindow(null,f.worker,f.b,f.native),/NOT_CAPTURABLE/);
});
test("native PNG crop preserves every pixel at odd dimensions and rejects invalid frames",{skip:process.platform!=="win32"},async()=>{
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const library=quote(path.resolve("runtime/automation/automation-window.dll")), fixture=quote(path.resolve("tests/fixtures/automation-capture.cs"));
  const script="$ErrorActionPreference='Stop'; Add-Type -Path "+library+"; Add-Type -Path "+fixture+" -ReferencedAssemblies @("+library+",'System.dll','System.Drawing.dll'); [CapturePixelFixture]::Run(); 'PASS pixels'";
  const result=await exec(path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,timeout:10000});
  assert.match(result.stdout,/PASS pixels/);
});
test("real Windows hidden assertion accepts English and Chinese Ignore accelerators without foreground input",{skip:process.platform!=="win32"},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dgn-window-probe-"));let child;
  t.after(async()=>{if(child&&child.exitCode===null){child.kill();await once(child,"exit");}assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const exe=path.join(root,"probe.exe");await exec(path.join(process.env.WINDIR,"Microsoft.NET/Framework64/v4.0.30319/csc.exe"),["/nologo","/target:exe","/r:System.Windows.Forms.dll","/out:"+exe,path.resolve("tests/fixtures/automation-window.cs")],{windowsHide:true});
  for (const label of ["&Ignore", "Ignore (&I)", "忽略(&I)", "忽略（I）"]) {
  child=spawn(exe,[label],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  await once(child.stdout,"data");
  const worker={session:{pid:process.pid},sourceSnapshot:{config:{game_executable_path:exe}}},bridge={minecraftPid:child.pid};
  const native=await inspectWindow(path.resolve("runtime"),worker,bridge);assert.equal(native.assertions.length,1);assert(native.assertions[0].text.includes("fixture only"));assert(native.assertions[0].ignore);
  await assert.rejects(inspectWindow(path.resolve("runtime"),{...worker,session:{pid:process.ppid}},bridge),/OWNERSHIP/);
  const exited=once(child,"exit");const answer=await inspectWindow(path.resolve("runtime"),worker,bridge,native.assertions[0].id);assert(answer.ignoreDispatched);await exited;
  }
  child=spawn(exe,["忽略(&I)","disabled"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  await once(child.stdout,"data");
  const worker={session:{pid:process.pid},sourceSnapshot:{config:{game_executable_path:exe}}},bridge={minecraftPid:child.pid};
  const disabled=await inspectWindow(path.resolve("runtime"),worker,bridge);
  assert.equal(disabled.assertions[0].enabled,false);
  const bogus={...disabled,window:{hwnd:disabled.assertions[0].hwnd,visible:true,minimized:false}};
  await assert.rejects(captureWindow(path.resolve("runtime"),worker,bridge,bogus),/CAPTURE_TARGET_CHANGED/);
  await assert.rejects(captureWindow(path.resolve("runtime"),{...worker,session:{pid:process.ppid}},bridge,bogus),/OWNERSHIP/);
  await assert.rejects(inspectWindow(path.resolve("runtime"),worker,bridge,disabled.assertions[0].id),/UNSUPPORTED/);
});
