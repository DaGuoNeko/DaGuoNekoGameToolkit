// 显式实机验收：仅新建测试数据与地图；不读写真实业务存档，不使用桌面输入。
const fs=require("node:fs/promises"),path=require("node:path"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {Client}=require("@modelcontextprotocol/sdk/client/index.js");
const {StdioClientTransport}=require("@modelcontextprotocol/sdk/client/stdio.js");
const {WorkspaceStore,validateConfig}=require("../electron/services.cjs");
const {Profiles}=require("../electron/domains/profiles/profiles.cjs");
const {initialLevel}=require("../electron/host-isolation.cjs");
const {inspectEngine}=require("../electron/domains/client/engine-profiles.cjs");
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const { artifactRoot, testResultsRoot } = require("./fixtures/artifacts.cjs");
(async()=>{
  const game=process.env.DGN_LIVE_GAME_EXE;
  if(!game||!path.isAbsolute(game)) throw Error("Set DGN_LIVE_GAME_EXE explicitly");
  const engine=await inspectEngine(game);
  assert(engine.profile?.isolatedHost,"Require registered isolated host");
  const root=path.join(artifactRoot, "data");
  const source=path.join(root,"source"),data=path.join(root,"data");
  await fs.mkdir(path.join(source,"db"),{recursive:true});
  await fs.writeFile(path.join(source,"level.dat"),initialLevel(validateConfig({world_name:"Automation acceptance",world_type:2,world_seed:1234})));
  const original=crypto.createHash("sha256").update(await fs.readFile(path.join(source,"level.dat"))).digest("hex");
  const store=new WorkspaceStore(data);await store.load();const profiles=new Profiles(store);await profiles.initialize();
  await store.updateSettings({GamePath:game,GameWindowSize:{enabled:true,width:800,height:500}});
  const report={root,engine:engine.version,events:[],passed:false};
  let app,client,call;
  async function record(label,value){report.events.push({label,value});console.log(label+" "+JSON.stringify(value));await fs.mkdir(testResultsRoot,{recursive:true});await fs.writeFile(path.join(testResultsRoot, "automation-live.json"),JSON.stringify(report,null,2));}
  try {
    const env={...process.env,DGN_GAME_DATA_DIR:data,DGN_GAME_HEADLESS:"1"};delete env.ELECTRON_RUN_AS_NODE;
    app=spawn(require("electron"),[process.cwd()],{env,windowsHide:true,stdio:"ignore"});
    for(let i=0;i<100;i++){try{await fs.access(path.join(data,"mcp/connection.json"));break;}catch{await delay(200);}}
    client=new Client({name:"automation-acceptance",version:"1"});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(data,"mcp/server.cjs"),"--data-dir",data],stderr:"pipe"}));
    const raw=async(name,args={})=>client.callTool({name,arguments:args},undefined,{timeout:110000});
    call=async(name,args={})=>{const r=await raw(name,args);if(r.isError)throw Error(r.content.find(x=>x.type==="text")?.text);return JSON.parse(r.content.find(x=>x.type==="text").text);};
    const status=await call("toolbox_status");assert.equal((await call("list_clients")).clients.length,0);
    assert.equal((await call("list_worlds")).worlds.length,0);
    const base={instanceId:status.instanceId,confirmed:true};
    const p=await call("create_project",{...base,requestId:"profile",name:"MCP acceptance"});
    await call("update_project",{projectId:p.project.id,revision:p.revision,patch:{user_name:"AutoHost",included_mod_dirs:[]}});
    const settings=await call("read_settings");await call("update_settings",{revision:settings.revision,patch:{IndependentWorlds:true}});
    const options=await call("read_game_options");await call("update_game_options",{revision:options.revision,overrides:{gfx_max_framerate:"30",audio_main:"0"}});
    await record("source",await call("inspect_world_source",{source}));
    const imported=await call("import_world",{...base,requestId:"import",name:"MCP copy",source,mode:"copy"});
    const clone=await call("clone_world",{...base,requestId:"clone",name:"MCP clone",worldId:imported.world.id});
    assert.notEqual(imported.world.id,clone.world.id);
    await record("import-clone",{original:imported.world.id,clone:clone.world.id});
    const launch=await call("launch_world",{instanceId:status.instanceId,requestId:"launch",worldId:clone.world.id});
    const sessionId=launch.client.sessionId;
    let ready;
    for(let i=0;i<90;i++){
      ready=await call("client_readiness",{sessionId});
      if(i%10===0)await record("waiting",ready);
      if(ready.ready)break;
      if(ready.assertions.length)throw Error("Game assertion requires explicit handling; test did not ignore it");
      if(!ready.running)throw Error("Test game exited");
      await delay(1000);
    }
    assert(ready.ready,JSON.stringify(ready));await record("ready",ready);
    const target={sessionId,generation:ready.generation};
    const secondLaunch=await call("launch_world",{instanceId:status.instanceId,requestId:"second-host",worldId:imported.world.id});
    let secondReady;
    for(let i=0;i<90;i++){
      secondReady=await call("client_readiness",{sessionId:secondLaunch.client.sessionId});
      if(secondReady.ready)break;
      if(secondReady.assertions.length||!secondReady.running)throw Error("Second test host blocked");
      await delay(1000);
    }
    assert(secondReady.ready);assert.notEqual(secondReady.gamePid,ready.gamePid);
    await record("second-host",secondReady);
    await record("assertions",await call("list_client_assertions",target));
    let capture;
    for(let i=0;i<8;i++){
      capture=await raw("capture_client_window",target);
      if(!capture.isError)break;
      if(!capture.content.some(x=>x.text?.includes("CAPTURE_UNIFORM_FRAME_UNVERIFIED")))break;
      await delay(1000);
    }
    await record("capture",capture.content.filter(x=>x.type==="text"));assert(!capture.isError);
    for(const item of capture.content)if(item.type==="image")await fs.writeFile(path.join(testResultsRoot, "automation-window.png"),Buffer.from(item.data,"base64"));
    const unsupportedHud=await raw("capture_scene",{...base,...target,requestId:"unsupported-hud",settings:{hudHidden:true}});
    assert(unsupportedHud.isError);assert(unsupportedHud.content.some(x=>x.text?.includes("HUD_READBACK_UNSUPPORTED")));
    const scene=await raw("capture_scene",{...base,...target,requestId:"scene",settings:{position:[ready.position[0]+1,ready.position[1],ready.position[2]],dimension:0,fov:70,perspective:0,rotation:[0,20,0],timeOfDay:6000,weather:"clear",chunkRadius:0},timeoutMs:60000});
    await record("scene",scene.content.filter(x=>x.type==="text"));assert(!scene.isError);
    for(const item of scene.content)if(item.type==="image")await fs.writeFile(path.join(testResultsRoot, "automation-scene.png"),Buffer.from(item.data,"base64"));
    await call("close_client",{sessionId,confirmed:true});
    const survived=await call("client_readiness",{sessionId:secondLaunch.client.sessionId,generation:secondReady.generation});
    assert(survived.ready);await record("independent-host-survived",survived);
    assert.equal(crypto.createHash("sha256").update(await fs.readFile(path.join(source,"level.dat"))).digest("hex"),original);
    report.passed=true;
  } catch(e){report.error=e.message;console.error(e.message);process.exitCode=1;}
  finally {
    report.cleanup=[];
    if(call)for(const c of (await call("list_clients").catch(()=>({clients:[]}))).clients.filter(c=>c.running)){
      await call("close_client",{sessionId:c.sessionId,confirmed:true}).then(()=>report.cleanup.push({sessionId:c.sessionId,stopped:true})).catch(e=>{report.cleanup.push({sessionId:c.sessionId,error:e.message});process.exitCode=1;});
    }
    await client?.close();
    if(app?.pid){app.kill();await delay(500);}
    await record("complete",{passed:report.passed,error:report.error,cleanup:report.cleanup});
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
