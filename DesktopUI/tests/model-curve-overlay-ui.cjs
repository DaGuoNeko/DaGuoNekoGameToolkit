const {_electron:electron}=require("playwright");
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path");
const {trackOf,sampleTrack}=require("../src/features/skins/npc-clip.cjs");
const {importProject}=require("../electron/domains/profiles/bbmodel-codec.cjs");
const {artifactPath,artifactRoot}=require("./fixtures/artifacts.cjs");

(async()=>{
  const data=artifactPath("data"),folder=path.join(data,"model-studio","overlay"),file=path.join(folder,"model.animation.json"),modelFile=path.join(folder,"model.geo.json");
  await fs.mkdir(folder,{recursive:true});
  const geometry=JSON.stringify({"minecraft:geometry":[{description:{identifier:"geometry.overlay",texture_width:64,texture_height:64},bones:[{name:"body",pivot:[0,6,0],cubes:[{origin:[-4,0,-2],size:[8,12,4],uv:[0,0]}]}]}]});
  let source={loop:false,animation_length:2,bones:{body:{rotation:{"0":[0,-40,20],"0.50":{pre:[8,-20,25],post:[10,-10,30],lerp_mode:"catmullrom",extra:"keep"},"1.00":[20,40,-20],"2.00":[-5,0,10]},position:{"0.00":[0,0,0],"1.00":{pre:[0,0,0],post:[8,-5,20]},"2.00":[10,-10,0]},scale:[1,1,1]}},sound_effects:{"0.50":{effect:"test.click"}}};
  const expr={animation_length:2,bones:{body:{rotation:[0,"q.anim_time * 20",0]}}};
  await fs.writeFile(modelFile,geometry,"utf8");await fs.writeFile(file,JSON.stringify({animations:{"animation.overlay":source,"animation.expr":expr}}),"utf8");
  const env={...process.env,DGN_GAME_HEADLESS:"1",DGN_GAME_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  let app,page;const errors=[];
  const read=async()=>JSON.parse(await fs.readFile(file,"utf8")).animations["animation.overlay"];
  const button=name=>page.getByRole("button",{name,exact:true}),tab=name=>page.getByRole("tab",{name,exact:true});
  const graph=()=>page.getByRole("img",{name:"曲线",exact:true}),point=time=>graph().getByRole("slider",{name:"曲线点 "+time,exact:true}),prePoint=time=>graph().getByRole("slider",{name:"曲线入点 "+time,exact:true});
  const axis=label=>page.getByRole("toolbar",{name:"曲线轴",exact:true}).getByRole("button",{name:label,exact:true});
  const overlay=()=>page.getByRole("checkbox",{name:"叠加 XYZ",exact:true}),timeline=()=>page.locator(".model-timeline");
  const saved=async text=>{await page.getByText(text,{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="关键帧选择"]').textContent!=="保存中…");};
  const capture=async name=>{await page.waitForTimeout(200);const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));await fs.writeFile(artifactPath("outputs/"+name+".png"),Buffer.from(png,"base64"));};
  const launch=async()=>{
    app=await electron.launch({cwd:path.resolve(__dirname,".."),env,...(process.env.DGN_GAME_TEST_EXE?{executablePath:process.env.DGN_GAME_TEST_EXE,args:[]}:{args:["."]})});
    page=await app.firstWindow();page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,900);w.webContents.setBackgroundThrottling(false);w.show();w.focus();});
    await page.getByRole("heading",{name:"存档",exact:true}).waitFor();await button("模组与资源").click();await button("模型制作").click();await page.locator(".model-library-open").filter({hasText:"geometry.overlay"}).click();
    await button("动画").click();await button("animation.overlay").click();await page.locator(".model-bone-list").getByRole("button",{name:"body",exact:true}).click();await tab("曲线").click();await graph().waitFor();
  };
  const close=async()=>{if(!app)return;const instance=app;app=null;const timer=setTimeout(()=>instance.process().kill(),5000);try{await instance.close();}finally{clearTimeout(timer);}};
  const curves=async()=>graph().evaluate(node=>({min:Number(node.dataset.min),max:Number(node.dataset.max),width:node.viewBox.baseVal.width,height:node.viewBox.baseVal.height,edit:node.dataset.editAxis,lines:[...node.querySelectorAll('polyline')].map(line=>({axis:line.dataset.curveAxis,active:line.classList.contains('active-axis'),stroke:getComputedStyle(line).stroke,dash:getComputedStyle(line).strokeDasharray,points:line.getAttribute('points').split(' ').map(p=>p.split(',').map(Number))}))}));
  const verify=async(animation,channel="rotation")=>{
    const actual=await curves(),keys=trackOf(animation.bones.body[channel]);assert.equal(actual.lines.length,3);assert.equal(new Set(actual.lines.map(line=>line.stroke)).size,3);
    for(const line of actual.lines){const component="XYZ".indexOf(line.axis);for(const at of [0,0.25,0.5,1,1.5,2]){
      const x=6+at/2*(actual.width-12),matches=line.points.filter(p=>Math.abs(p[0]-x)<0.001);assert.ok(matches.length,"采样点 "+at);
      const value=actual.min+(1-(matches.at(-1)[1]-10)/(actual.height-20))*(actual.max-actual.min),expected=sampleTrack(keys,at)[component];assert.ok(Math.abs(value-expected)<0.001,line.axis+" 采样须与播放一致");
    }assert.equal(line.active,line.axis===actual.edit);assert.equal(line.dash==="none",line.active);}
    return actual;
  };
  const drag=async(from,to,delta,cancel="")=>{
    await point(from).scrollIntoViewIfNeeded();const p=await point(from).boundingBox(),b=await graph().boundingBox(),scale=await curves();
    await page.mouse.move(p.x+p.width/2,p.y+p.height/2);await page.mouse.down();await page.mouse.move(p.x+p.width/2+(b.width-12)*(to-from)/2,p.y+p.height/2-delta/(scale.max-scale.min)*(b.height-20),{steps:8});
    assert.deepEqual(await read(),await fs.readFile(artifactPath("outputs/before-drag.json"),"utf8").then(JSON.parse),"松手前不保存");
    if(cancel==="escape")await page.keyboard.press("Escape");if(cancel==="pointer")await point(from).dispatchEvent("pointercancel");if(cancel==="blur")await page.evaluate(()=>window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
  };
  try{
    await launch();assert.equal(await overlay().isChecked(),false);assert.equal(await graph().locator("polyline").count(),1);
    await overlay().check();await axis("Y").click();await page.getByRole("toolbar",{name:"曲线端点",exact:true}).getByRole("button",{name:"入点",exact:true}).click();await prePoint(0.5).press("ArrowUp");await saved("已改曲线");source=await read();assert.deepEqual(source.bones.body.rotation["0.50"].pre,[8,-19,25]);assert.deepEqual(source.bones.body.rotation["0.50"].post,[10,-10,30]);
    const baseline=await verify(source);assert.ok(baseline.min<=-40&&baseline.max>=40);assert.equal(await graph().getByRole("slider").count(),5);await fs.rm(file+".bak",{recursive:true,force:true});
    for(const name of ["Y","Z","X"]){await axis(name).click();const next=await verify(source);assert.equal(next.min,baseline.min);assert.equal(next.max,baseline.max);assert.equal(await axis(name).getAttribute("aria-pressed"),"true");}
    assert.deepEqual(await read(),source);
    await axis("Y").click();await point(0.5).click();assert.equal(await page.getByLabel("旋转Y",{exact:true}).inputValue(),"-10");await tab("轨道").click();assert.equal(await timeline().getByRole("button",{name:"关键帧 旋转 0.50",exact:true}).getAttribute("aria-pressed"),"true");
    await button("放大时间轴").click();await button("定位播放头").click();await tab("曲线").click();assert.equal(await overlay().isChecked(),true);assert.equal(await graph().getAttribute("data-edit-axis"),"Y");await verify(source);
    await button("适应时长").click();await capture("overlay-dark");await fs.writeFile(artifactPath("outputs/before-drag.json"),JSON.stringify(source),"utf8");
    for(const cancel of ["escape","pointer","blur"]){await drag(0.5,0.75,10,cancel);assert.deepEqual(await read(),source);await verify(source);}
    await fs.mkdir(file+".bak");await drag(0.5,0.75,10);await page.getByText(/EISDIR|EPERM|illegal operation|operation not permitted/).waitFor();assert.deepEqual(await read(),source);await fs.rmdir(file+".bak");
    await drag(0.5,0.75,10);await saved("已移动曲线关键帧");const moved=await read(),frame=moved.bones.body.rotation["0.75"];
    assert.ok(Math.abs(frame.post[1])<0.15);assert.equal(frame.post[0],10);assert.equal(frame.post[2],30);assert.equal(frame.extra,"keep");assert.equal(frame.lerp_mode,"catmullrom");assert.equal(moved.bones.body.rotation["0.50"],undefined);assert.deepEqual(moved.sound_effects,source.sound_effects);await verify(moved);
    await timeline().getByRole("button",{name:"撤销",exact:true}).click();await saved("已撤销");assert.deepEqual(await read(),source);await verify(source);await timeline().getByRole("button",{name:"重做",exact:true}).click();await saved("已重做");assert.deepEqual(await read(),moved);
    await axis("Z").click();await point(0.75).press("ArrowUp");await saved("已改曲线");const edited=await read();assert.deepEqual(edited.bones.body.rotation["0.75"].post,[10,frame.post[1],31]);await verify(edited);
    await overlay().uncheck();assert.equal(await graph().locator("polyline").count(),1);assert.equal(await graph().locator("polyline").getAttribute("data-curve-axis"),"Z");await overlay().check();await verify(edited);
    await page.getByLabel("曲线通道",{exact:true}).selectOption("position");const steps=await verify(edited,"position");for(const line of steps.lines)assert.ok(line.points.some((p,i)=>i&&p[0]===line.points[i-1][0]&&Math.abs(p[1]-line.points[i-1][1])>1),"三轴跳变保留");
    await page.getByLabel("曲线通道",{exact:true}).selectOption("scale");await verify(edited,"scale");assert.equal(await graph().getByRole("slider").count(),1);await axis("Y").click();assert.equal(await graph().locator("polyline").last().getAttribute("data-curve-axis"),"Y","重叠线当前轴位于最上层");
    await button("animation.expr").click();await page.getByLabel("曲线通道",{exact:true}).selectOption("rotation");await overlay().check();await page.getByText("当前通道含 Molang，仅支持预览；原表达式保留。",{exact:true}).waitFor();assert.equal(await graph().count(),0);
    await button("animation.overlay").click();await overlay().check();await axis("Z").click();await verify(edited);
    const output=artifactPath("outputs/overlay.bbmodel");await app.evaluate(({dialog},p)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:p});},output);await button("导出 .bbmodel").click();await page.getByText(/工程已导出：/).waitFor();const back=importProject(JSON.parse(await fs.readFile(output,"utf8"))).animations["animation.overlay"];
    for(const time of [0,0.25,0.75,1.5,2])assert.deepEqual(sampleTrack(trackOf(back.bones.body.rotation),time),sampleTrack(trackOf(edited.bones.body.rotation),time));
    console.log("PASS XYZ 同尺度采样/平滑/跳变/重叠、当前轴颜色/键盘/拖动、取消/失败/撤销、跨视图选择缩放和导出");
    await close();await launch();assert.equal(await overlay().isChecked(),false);await overlay().check();await verify(edited);assert.deepEqual(await read(),edited);
    await app.evaluate(({BrowserWindow,nativeTheme})=>{BrowserWindow.getAllWindows()[0].setSize(1000,720);nativeTheme.themeSource="light";});await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");await page.getByRole("separator",{name:"调整时间轴高度",exact:true}).press("Home");await axis("Y").click();await capture("overlay-small-light");await verify(edited);
    const fits=await page.locator(".model-graph-options").evaluate(node=>{const p=node.getBoundingClientRect();return [...node.children].every(c=>{const r=c.getBoundingClientRect();return r.left>=p.left&&r.right<=p.right+1;});});assert.ok(fits,"曲线选项在左侧标签栏内");
    assert.equal(await fs.readFile(modelFile,"utf8"),geometry);assert.deepEqual(errors,[]);await fs.writeFile(artifactPath("outputs/result.json"),JSON.stringify({passed:true,errors},null,2),"utf8");console.log("PASS Molang 保护、重启数据保留及浅色窄窗图例");console.log(artifactRoot);
  }catch(error){if(page)await capture("failure").catch(()=>{});console.error("renderer errors",errors);throw error;}finally{await close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
