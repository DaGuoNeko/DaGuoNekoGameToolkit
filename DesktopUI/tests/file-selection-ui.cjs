const {_electron:electron}=require("playwright");
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dgn-selection-ui-"));let app;
  try {
    const file=path.join(root,"background.png");await fs.writeFile(file,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3cAAAAASUVORK5CYII=","base64"));
    const env={...process.env,DGN_GAME_HEADLESS:"1",DGN_GAME_DATA_DIR:path.join(root,"data")};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({args:["."],env});const page=await app.firstWindow();
    await page.getByRole("heading",{name:"存档",exact:true}).waitFor();
    const ipc=(method,args={})=>page.evaluate(({method,args})=>window.toolkit.call(method,args),{method,args});
    await assert.rejects(ipc("image.read",{path:file}),/授权|选择/);
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
    await ipc("files.pick",{kind:"background"});
    assert.match(await ipc("image.read",{path:file}),/^data:image\/png;base64,/);
    await ipc("settings.update",{BgImagePath:file});
    await fs.rename(file,file+".old");await fs.copyFile(file+".old",file);
    await assert.rejects(ipc("image.read",{path:file}),/变化/);
    await ipc("files.pick",{kind:"background"});
    assert.match(await ipc("image.read",{path:file}),/^data:image\/png;base64,/);
    const source=path.join(root,"world");await fs.mkdir(source);
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},source);
    await ipc("map-preview.pick",{kind:"folder"});
    await fs.rename(source,source+".old");await fs.mkdir(source);
    await assert.rejects(ipc("map-preview.render",{source,requestId:"changed-source"}),/变化/);
    console.log("PASS file selection real IPC: unselected refused, saved background, replacement refused, explicit reselect, replaced world refused");
  } finally {
    if(app)await app.close();
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith("dgn-selection-ui-"));
    await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
