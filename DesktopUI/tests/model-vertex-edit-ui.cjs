const {_electron:electron}=require("playwright");
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path");
const {importProject}=require("../electron/domains/profiles/bbmodel-codec.cjs");
const {artifactPath,artifactRoot}=require("./fixtures/artifacts.cjs");
(async()=>{
  const data=artifactPath("data"),folder=path.join(data,"model-studio","vertex-edit"),file=path.join(folder,"model.geo.json");await fs.mkdir(folder,{recursive:true});
  const geometry={"minecraft:geometry":[{description:{identifier:"geometry.vertex_edit",texture_width:64,texture_height:64},bones:[{name:"body",pivot:[0,0,0],cubes:[{origin:[-4,0,-2],size:[8,12,4],uv:[0,0],extension:true}]}]}],keep:"source"};const original=JSON.stringify(geometry);
  await fs.writeFile(file,original,"utf8");const env={...process.env,DGN_GAME_HEADLESS:"1",DGN_GAME_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;let app,page;const errors=[];
  const button=name=>page.getByRole("button",{name,exact:true}),read=async()=>JSON.parse(await fs.readFile(file,"utf8")),selectVertex=async name=>{await page.getByRole("combobox",{name:"顶点索引",exact:true}).click();await page.getByRole("option",{name,exact:true}).click();};
  const save=async()=>{await button("保存模型").click();await page.getByText("已写回模型文件，原文件保存在同名 .bak",{exact:true}).waitFor();return read();};
  const capture=async name=>{await page.waitForTimeout(250);const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));await fs.writeFile(artifactPath("outputs/"+name+".png"),Buffer.from(png,"base64"));};
  try{
    app=await electron.launch({cwd:path.resolve(__dirname,".."),env,...(process.env.DGN_GAME_TEST_EXE?{executablePath:process.env.DGN_GAME_TEST_EXE,args:[]}:{args:["."]})});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,900);w.webContents.setBackgroundThrottling(false);w.show();w.focus();});
    await page.getByRole("heading",{name:"存档",exact:true}).waitFor();await button("模组与资源").click();await button("模型制作").click();await page.locator(".model-library-open").filter({hasText:"geometry.vertex_edit"}).click();await button("body 立方体 1").click();
    await page.locator(".model-vertex-edit").scrollIntoViewIfNeeded();await page.getByRole("heading",{name:"顶点",exact:true}).waitFor();await selectVertex("顶点 0");assert.deepEqual(await page.getByLabel("坐标X",{exact:true}).inputValue(),"-4");
    await page.getByLabel("坐标X",{exact:true}).fill("-5");await page.getByLabel("坐标X",{exact:true}).press("Enter");await page.waitForTimeout(250);await page.getByRole("heading",{name:"顶点",exact:true}).waitFor();
    const draft=await read();assert.equal(draft["minecraft:geometry"][0].bones[0].cubes[0].dgn_vertices,undefined,"草稿编辑不能直接写源文件");
    const exported=artifactPath("outputs/vertex.bbmodel");await app.evaluate(({dialog},p)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:p});},exported);await button("导出 .bbmodel").click();await page.getByText(/工程已导出：/).waitFor();const project=JSON.parse(await fs.readFile(exported,"utf8"));assert.equal(project.elements[0].dgn_vertices[0][0],-5);
    const imported=importProject(project);assert.equal(imported.bones[0].cubes[0].dgn_vertices[0][0],-5);await capture("vertex-edit-dark");
    await button("撤销").click();await page.waitForFunction(()=>document.querySelector('[aria-label="坐标X"]').value==="-4");assert.equal(await page.getByLabel("坐标X",{exact:true}).inputValue(),"-4");await button("重做").click();await page.waitForFunction(()=>document.querySelector('[aria-label="坐标X"]').value==="-5");assert.equal(await page.getByLabel("坐标X",{exact:true}).inputValue(),"-5");
    await button("顶点").click();await page.getByRole("status",{name:"顶点编辑状态"}).waitFor();await page.keyboard.press("ArrowRight");await page.waitForFunction(()=>document.querySelector('[aria-label="坐标X"]').value==="-4");
    await page.getByRole("button",{name:"动画",exact:true}).click();await page.getByRole("button",{name:"animation.empty",exact:true}).count().catch(()=>{});
    await button("编辑").click();await app.evaluate(({BrowserWindow,nativeTheme})=>{BrowserWindow.getAllWindows()[0].setSize(1000,720);nativeTheme.themeSource="light";});await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");await page.waitForTimeout(250);await capture("vertex-edit-small-light");assert.equal(await fs.readFile(file,"utf8"),original);assert.deepEqual(errors,[]);console.log("PASS 顶点坐标编辑、预览/撤销重做、草稿隔离、自定义顶点 bbmodel 往返和窄窗浅色");console.log(artifactRoot);
  }catch(error){if(page)await capture("failure").catch(()=>{});console.error("renderer errors",errors);throw error;}finally{if(app)await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
