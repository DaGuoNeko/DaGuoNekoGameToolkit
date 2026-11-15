const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const data=artifactPath("data"),folder=path.join(data,"model-studio","curve-edit"),file=path.join(folder,"curve.animation.json"),modelFile=path.join(folder,"model.geo.json");
  await fs.mkdir(folder,{recursive:true});
  const geometry=JSON.stringify({"minecraft:geometry":[{description:{identifier:"geometry.curve_edit",texture_width:64,texture_height:64},bones:[{name:"body",pivot:[0,6,0],cubes:[{origin:[-4,0,-2],size:[8,12,4],uv:[0,0]}]}]}]});
  const source={loop:false,animation_length:1,bones:{body:{rotation:{"0.00":[0,0,0],"1.00":[20,10,0]},position:[1,2,3]}}};
  const expression={loop:false,animation_length:1,bones:{body:{rotation:[0,"q.anim_time * 30",0]}}};
  await fs.writeFile(modelFile,geometry,"utf8");await fs.writeFile(file,JSON.stringify({animations:{"animation.curve_edit":source,"animation.expression":expression}}),"utf8");
  const env={...process.env,DGN_GAME_HEADLESS:"1",DGN_GAME_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  let app,page;const errors=[];
  const read=async()=>JSON.parse(await fs.readFile(file,"utf8")).animations["animation.curve_edit"];
  const button=name=>page.getByRole("button",{name,exact:true}),tab=name=>page.getByRole("tab",{name,exact:true});
  const curve=()=>page.getByRole("img",{name:"曲线",exact:true}),point=time=>curve().getByRole("slider",{name:"曲线点 "+time,exact:true});
  const timeline=()=>page.locator(".model-timeline"),slider=()=>page.getByRole("slider",{name:"时间",exact:true});
  const saved=async text=>{await page.getByText(text,{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="关键帧选择"]').textContent!=="保存中…");};
  const capture=async name=>{await page.waitForTimeout(250);const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));await fs.writeFile(artifactPath("outputs/"+name+".png"),Buffer.from(png,"base64"));};
  const launch=async()=>{
    app=await electron.launch({cwd:path.resolve(__dirname,".."),env,...(process.env.DGN_GAME_TEST_EXE?{executablePath:process.env.DGN_GAME_TEST_EXE,args:[]}:{args:["."]})});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,900);w.webContents.setBackgroundThrottling(false);w.show();w.focus();});
    await page.getByRole("heading",{name:"存档",exact:true}).waitFor();await button("模组与资源").click();await button("模型制作").click();await page.locator(".model-library-open").filter({hasText:"geometry.curve_edit"}).click();
    await button("动画").click();await button("animation.curve_edit").click();await page.locator(".model-bone-list").getByRole("button",{name:"body",exact:true}).click();
  };
  const close=async()=>{if(!app)return;const instance=app;app=null;const timer=setTimeout(()=>instance.process().kill(),5000);try{await instance.close();}finally{clearTimeout(timer);}};
  const insert=async time=>{const b=await curve().boundingBox();await page.mouse.dblclick(b.x+6+(b.width-12)*time,b.y+b.height*0.25);};
  const drag=async(from,to,valueDelta=0,cancel="")=>{
    await point(from).scrollIntoViewIfNeeded();const p=await point(from).boundingBox(),b=await curve().boundingBox(),range=await curve().evaluate(n=>Number(n.dataset.max)-Number(n.dataset.min));
    const x=p.x+p.width/2,y=p.y+p.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+(b.width-12)*(to-from),y-valueDelta/range*(b.height-20),{steps:6});
    if(cancel==="escape")await page.keyboard.press("Escape");if(cancel==="pointer")await point(from).dispatchEvent("pointercancel");if(cancel==="blur")await page.evaluate(()=>window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
  };
  try{
    await launch();await tab("曲线").click();await curve().waitFor();
    assert.equal(await page.locator(".model-anim-props .model-curve").count(),0);assert.equal(await timeline().locator(".model-curve").count(),1);
    const before=await read();await point(0).click();assert.deepEqual(await read(),before);await assert.rejects(fs.stat(file+".bak"),{code:"ENOENT"});
    await fs.mkdir(file+".bak");await insert(0.5);await page.getByText(/EISDIR|EPERM|illegal operation|operation not permitted/).waitFor();assert.deepEqual(await read(),source);assert.equal(await point(0.5).count(),0);await fs.rmdir(file+".bak");
    await insert(0.5);await saved("已插入曲线关键帧");const inserted=await read();assert.deepEqual(inserted.bones.body.rotation["0.50"],[10,5,0]);
    await point(0.5).click();assert.equal(Number(await slider().inputValue()),0.5);assert.equal(await page.getByLabel("旋转X",{exact:true}).inputValue(),"10");
    await tab("轨道").click();assert.equal(await timeline().getByRole("button",{name:"关键帧 旋转 0.50",exact:true}).getAttribute("aria-pressed"),"true");
    await button("放大时间轴").click();await button("放大时间轴").click();await button("定位播放头").click();const scroll=await page.locator(".model-timeline-scroll").evaluate(n=>n.scrollLeft);
    await tab("曲线").click();assert.equal(await page.getByLabel("时间轴缩放").innerText(),"400%");assert.ok(Math.abs(await page.locator(".model-timeline-scroll").evaluate(n=>n.scrollLeft)-scroll)<3);
    await point(0.5).scrollIntoViewIfNeeded();
    const aligned=await page.evaluate(()=>{const c=document.querySelector('.model-curve circle[aria-label="曲线点 0.5"]').getBoundingClientRect(),p=document.querySelector('.model-key-playhead').getBoundingClientRect();return Math.abs(c.x+c.width/2-p.x);});assert.ok(aligned<1.1,"曲线、刻度和播放头对齐");
    for(const cancel of ["escape","pointer","blur"]){await drag(0.5,0.55,1,cancel);assert.deepEqual(await read(),inserted);assert.equal(await point(0.5).count(),1);}
    await button("适应时长").click();await drag(0.5,1);await page.getByText("目标时间已有关键帧，未覆盖任何帧",{exact:true}).waitFor();assert.deepEqual(await read(),inserted);assert.equal(await point(0.5).count(),1);
    await drag(0.5,0.75,2);await saved("已移动曲线关键帧");const moved=await read();assert.equal(moved.bones.body.rotation["0.50"],undefined);assert.ok(Math.abs(moved.bones.body.rotation["0.75"][0]-12)<0.02);assert.deepEqual(moved.bones.body.rotation["0.75"].slice(1),[5,0]);
    await capture("curve-bottom-dark");await tab("轨道").click();assert.equal(await timeline().getByRole("button",{name:"关键帧 旋转 0.75",exact:true}).getAttribute("aria-pressed"),"true");
    await timeline().getByRole("button",{name:"撤销",exact:true}).click();await saved("已撤销");assert.deepEqual(await read(),inserted);await timeline().getByRole("button",{name:"重做",exact:true}).click();await saved("已重做");assert.deepEqual(await read(),moved);
    await tab("曲线").click();await point(0.75).press("ArrowLeft");await saved("已移动曲线关键帧");assert.ok((await read()).bones.body.rotation["0.70"]);await point(0.7).press("ArrowRight");await saved("已移动曲线关键帧");
    await point(0.75).press("Backspace");await saved("已删除曲线关键帧");assert.deepEqual(await read(),source);
    await page.getByLabel("曲线通道",{exact:true}).selectOption("position");await point(0).press("ArrowUp");await saved("已改曲线");assert.deepEqual((await read()).bones.body.position["0.00"],[2,2,3]);
    await page.getByLabel("曲线通道",{exact:true}).selectOption("scale");await curve().waitFor();await insert(0.5);await saved("已插入曲线关键帧");assert.deepEqual((await read()).bones.body.scale["0.50"],[1,1,1]);await page.getByRole("toolbar",{name:"曲线轴",exact:true}).getByRole("button",{name:"Y",exact:true}).click();await point(0.5).press("ArrowUp");await saved("已改曲线");assert.deepEqual((await read()).bones.body.scale["0.50"],[1,2,1]);
    const final=await read();const exported=artifactPath("outputs/curve.bbmodel");await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exported);await button("导出 .bbmodel").click();await page.getByText(/工程已导出：/).waitFor();const imported=importProject(JSON.parse(await fs.readFile(exported,"utf8")));assert.deepEqual(imported.animations["animation.curve_edit"].bones.body.scale,final.bones.body.scale);
    await button("animation.expression").click();await page.getByLabel("曲线通道",{exact:true}).selectOption("rotation");await page.getByText("当前通道含 Molang，仅支持预览；原表达式保留。",{exact:true}).waitFor();assert.equal(await curve().count(),0);
    assert.deepEqual(JSON.parse(await fs.readFile(file,"utf8")).animations["animation.expression"],expression);
    await button("animation.curve_edit").click();await page.getByLabel("曲线通道",{exact:true}).selectOption("rotation");await button("贝塞尔缓动").click();await page.getByRole("dialog").waitFor();await page.keyboard.press("Escape");
    await close();await launch();await tab("曲线").click();await page.getByLabel("曲线通道",{exact:true}).selectOption("scale");await point(0.5).waitFor();assert.deepEqual(await read(),final);
    await app.evaluate(({BrowserWindow,nativeTheme})=>{BrowserWindow.getAllWindows()[0].setSize(1000,720);nativeTheme.themeSource="light";});await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");
    await page.getByRole("separator",{name:"调整时间轴高度",exact:true}).press("Home");await capture("curve-bottom-small-light");await point(0.5).click();assert.equal(await slider().inputValue(),"0.5");assert.equal(await fs.readFile(modelFile,"utf8"),geometry);assert.deepEqual(errors,[]);
    await fs.writeFile(artifactPath("outputs/result.json"),JSON.stringify({passed:true,errors},null,2),"utf8");console.log("PASS 底部轨道/曲线切换、共享缩放刻度播放头、选择和属性联动、二维拖动与取消/冲突/失败、键盘/插删/撤销、常量/空通道、Molang 保护、工程导出和重启窄窗");console.log(artifactRoot);
  }catch(error){if(page)await capture("failure").catch(()=>{});console.error("renderer errors",errors);throw error;}finally{await close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
