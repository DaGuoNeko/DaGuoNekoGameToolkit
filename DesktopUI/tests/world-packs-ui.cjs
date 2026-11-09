const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { artifactPath, testResultsRoot } = require("./fixtures/artifacts.cjs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { levelData } = require("./fixtures/zip.cjs");

(async () => {
  const root = artifactPath("data"), source = path.join(root,"source"), data = path.join(root,"app");
  await fs.mkdir(source,{recursive:true});
  await fs.writeFile(path.join(source,"level.dat"),levelData());
  const refs = {};
  for (const kind of ["behavior","resource"]) {
    const id = crypto.randomUUID(), dir = path.join(source,kind+"_packs","sample");
    refs[kind] = {pack_id:id,version:[1,0,0]};
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,"manifest.json"),JSON.stringify({format_version:2,
      header:{name:kind==="behavior"?"测试行为包":"测试资源包",uuid:id,version:[2,0,0]},
      modules:[{type:kind==="behavior"?"data":"resources",uuid:crypto.randomUUID(),version:[1,0,0]}]}));
    await fs.writeFile(path.join(source,"world_"+kind+"_packs.json"),JSON.stringify([refs[kind]]));
  }
  const store = new WorkspaceStore(data); await store.load();
  const profiles = new Profiles(store); await profiles.initialize();
  const worlds = new WorldLibrary(store,path.join(data,"game-data/MinecraftPE_Netease/minecraftWorlds"));
  const world = await worlds.importWorld(store.value.projects[0].id,"模组浏览验收",source);
  let app;
  try {
    app = await electron.launch({executablePath:process.env.DGN_GAME_TEST_EXE || undefined,
      args:process.env.DGN_GAME_TEST_EXE?[]:["."],env:{...process.env,DGN_GAME_HEADLESS:"1",DGN_GAME_DATA_DIR:data}});
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    await page.emulateMedia({reducedMotion:"reduce"});
    const errors=[]; page.on("pageerror",e=>errors.push(e.message));
    await page.getByRole("button",{name:"打开存档控制台",exact:true}).click();
    await page.getByRole("navigation",{name:"存档工作区"}).getByRole("button",{name:"模组",exact:true}).click();
    await page.getByText("测试行为包",{exact:true}).waitFor();
    const invoke = (method,args={})=>page.evaluate(({method,args})=>window.toolkit.call(method,args),{method,args});
    const report = await invoke("worlds.inspect-pack-health",{worldId:world.id});
    assert.equal(report.summary.total,2);
    const rejected = await invoke("worlds.edit-pack",{worldId:world.id,packId:refs.behavior.pack_id,values:{name:"bad"},revision:report.revision,confirmed:false}).then(()=>false,()=>true);
    assert(rejected);
    await page.getByRole("button",{name:"同步清单版本",exact:true}).click();
    await page.getByRole("button",{name:"取消",exact:true}).click();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(worlds.location(world.id),"world_behavior_packs.json"),"utf8"))[0].version,[1,0,0]);
    await page.getByRole("button",{name:"同步清单版本",exact:true}).click();
    await page.getByRole("button",{name:"确认执行",exact:true}).click();
    await page.getByText("静态检查通过",{exact:true}).waitFor();
    const card = page.locator(".pack-browser-card").filter({has:page.getByText("测试行为包",{exact:true})});
    await card.getByRole("button",{name:"编辑",exact:true}).click();
    await page.getByLabel("模组名称",{exact:true}).fill("编辑后的行为包");
    await page.getByRole("button",{name:"预览修改",exact:true}).click();
    await page.getByRole("button",{name:"确认执行",exact:true}).click();
    await page.getByText("编辑后的行为包",{exact:true}).waitFor();
    await page.getByRole("button",{name:"全体重绑 UUID",exact:true}).click();
    await page.getByRole("button",{name:"确认执行",exact:true}).click();
    await page.getByText("静态检查通过",{exact:true}).waitFor();
    const after = await invoke("worlds.inspect-pack-health",{worldId:world.id});
    assert(after.packs.every(p=>![refs.behavior.pack_id,refs.resource.pack_id].includes(p.packId)));
    assert.equal(after.summary.enabled,2);
    const sourceManifest = JSON.parse(await fs.readFile(path.join(source,"behavior_packs/sample/manifest.json"),"utf8"));
    assert.equal(sourceManifest.header.uuid,refs.behavior.pack_id);
    await page.getByRole("textbox",{name:"搜索存档模组"}).fill("编辑后");
    assert.equal(await page.locator(".pack-browser-card").count(),1);
    await page.getByRole("textbox",{name:"搜索存档模组"}).fill("");
    const png = await app.evaluate(async ({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.mkdir(testResultsRoot,{recursive:true});
    await fs.writeFile(path.join(testResultsRoot,"world-packs.png"),Buffer.from(png,"base64"));
    assert.deepEqual(errors,[]);
    console.log("PASS: real IPC browse, cancel, sync, edit, all UUID rebind, source preservation; "+testResultsRoot);
  } finally { if(app) await app.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
