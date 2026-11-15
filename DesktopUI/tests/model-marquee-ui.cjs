const {_electron:electron}=require("playwright");
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path");
const {artifactPath,artifactRoot}=require("./fixtures/artifacts.cjs");
(async()=>{
  const data=artifactPath("data"),folder=path.join(data,"model-studio","marquee"),file=path.join(folder,"model.geo.json");await fs.mkdir(folder,{recursive:true});
  const geometry={"minecraft:geometry":[{description:{identifier:"geometry.marquee",texture_width:64,texture_height:64},bones:[{name:"body",pivot:[0,0,0],cubes:[{origin:[-8,0,-2],size:[4,4,4],uv:[0,0]},{origin:[0,0,-2],size:[4,4,4],uv:[16,0]},{origin:[12,0,-2],size:[4,4,4],pivot:[14,2,0],rotation:[0,0,35],inflate:0.6,uv:[32,0]}]}]}]};await fs.writeFile(file,JSON.stringify(geometry),"utf8");
  const env={...process.env,DGN_GAME_HEADLESS:"1",DGN_GAME_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;let app,page;const errors=[];
  const button=name=>page.getByRole("button",{name,exact:true}),canvas=()=>page.locator(".model-view-canvas canvas").first();
  const selected=()=>page.locator(".model-tree .model-cube.active").count();
  const capture=async name=>{const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));await fs.writeFile(artifactPath("outputs/"+name+".png"),Buffer.from(png,"base64"));};
  try{
    app=await electron.launch({cwd:path.resolve(__dirname,".."),env,...(process.env.DGN_GAME_TEST_EXE?{executablePath:process.env.DGN_GAME_TEST_EXE,args:[]}:{args:["."]})});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,900);w.webContents.setBackgroundThrottling(false);w.show();w.focus();});
    await page.getByRole("heading",{name:"存档",exact:true}).waitFor();await button("模组与资源").click();await button("模型制作").click();await page.locator(".model-library-open").filter({hasText:"geometry.marquee"}).click();await button("编辑").click();await canvas().waitFor();await button("聚焦").click();
    const box=await canvas().boundingBox();assert.ok(box.width>200&&box.height>160);
    await page.mouse.move(box.x+box.width*.15,box.y+box.height*.15);await page.mouse.down();await page.mouse.move(box.x+box.width*.85,box.y+box.height*.85,{steps:8});await page.mouse.up();
    await page.waitForFunction(()=>document.querySelectorAll(".model-tree .model-cube.active").length>=2);assert.ok(await selected()>=2);await page.screenshot({path:artifactPath("outputs/marquee-all.png")});
    await page.getByLabel("过滤大纲",{exact:true}).fill("body");assert.equal(await page.getByRole("button",{name:"body 立方体 1",exact:true}).count(),1);await page.getByLabel("过滤大纲",{exact:true}).fill("missing");assert.equal(await page.getByRole("button",{name:"body 立方体 1",exact:true}).count(),0);await page.getByLabel("过滤大纲",{exact:true}).press("Escape");assert.equal(await page.getByRole("button",{name:"body 立方体 1",exact:true}).count(),1);
    await button("聚焦").click();
    await page.keyboard.press("Escape");assert.ok(await selected()>=2);
    await page.mouse.move(box.x+box.width*.1,box.y+box.height*.1);await page.mouse.down();await page.mouse.move(box.x+box.width*.45,box.y+box.height*.9,{steps:8});await page.mouse.up();await page.waitForTimeout(200);const left=await selected();assert.ok(left>=1&&left<3);
    await page.mouse.move(box.x+box.width*.55,box.y+box.height*.1);await page.keyboard.down("Control");await page.mouse.down();await page.mouse.move(box.x+box.width*.95,box.y+box.height*.9,{steps:8});await page.mouse.up();await page.keyboard.up("Control");await page.waitForTimeout(250);assert.ok(await selected()>=left);await capture("marquee-additive-dark");
    assert.equal(await button("撤销").isDisabled(),true,"框选只改变选择，不伪造模型撤销");
    await app.evaluate(({BrowserWindow,nativeTheme})=>{BrowserWindow.getAllWindows()[0].setSize(1000,720);nativeTheme.themeSource="light";});await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");await page.waitForTimeout(250);await capture("marquee-small-light");assert.deepEqual(errors,[]);console.log("PASS 3D 视口框选、Ctrl 增量选择、取消、撤销重做及浅色窄窗");console.log(artifactRoot);
  }catch(error){if(page)await capture("failure").catch(()=>{});console.error("renderer errors",errors);throw error;}finally{if(app)await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
