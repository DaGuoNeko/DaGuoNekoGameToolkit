const { _electron: electron } = require("playwright");
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path");
const {encodeRgbaPng,decodePng}=require("../electron/domains/skins/npc-skins.cjs");
const {writeLayerPng}=require("../electron/domains/profiles/texture-layers.cjs");
const {importProject}=require("../electron/domains/profiles/bbmodel-codec.cjs");
const {uvFaces}=require("../shared/model-edit.cjs");
const {assignedTextures}=require("../shared/model-materials.cjs");
const {artifactPath,artifactRoot}=require("./fixtures/artifacts.cjs");
const solid=color=>Buffer.from(Array.from({length:256},()=>color).flat());
const url=pixels=>"data:image/png;base64,"+encodeRgbaPng(16,16,pixels).toString("base64");
function compareFaces(bones,packed,sources,image){
  for(let b=0;b<bones.length;b++)for(let c=0;c<(bones[b].cubes||[]).length;c++){
    const cube=bones[b].cubes[c],before=uvFaces(cube),after=uvFaces(packed[b].cubes[c]);
    before.forEach((a,i)=>{
      const z=after[i],pixels=sources[cube.uv?.[a.name]?.dgn_texture||""];assert.equal(a.w,z.w);assert.equal(a.h,z.h);
      for(let y=0;y<Math.abs(a.h);y++)for(let x=0;x<Math.abs(a.w);x++){
        const from=((Math.min(a.y,a.y+a.h)+y)*16+Math.min(a.x,a.x+a.w)+x)*4;
        const to=((Math.min(z.y,z.y+z.h)+y)*image.width+Math.min(z.x,z.x+z.w)+x)*4;
        assert.deepEqual([...image.pixels.subarray(to,to+4)],[...pixels.subarray(from,from+4)],a.name+" 必须取自对应来源");
      }
    });
  }
}
(async()=>{
  const data=artifactPath("data"),folder=path.join(data,"model-studio","atlas"),file=path.join(folder,"model.geo.json"),redFile=path.join(folder,"textures/a.png"),blueFile=path.join(folder,"textures/b.png");
  await fs.mkdir(path.dirname(redFile),{recursive:true});
  const red=solid([255,0,0,255]),blue=solid([0,0,255,255]),green=solid([0,255,0,255]),transparent=solid([0,0,0,0]),mask=solid([255,255,255,255]);
  mask.set([0,0,0,255],(2*16+2)*4);const merged=Buffer.from(red);merged.set([0,0,0,0],(2*16+2)*4);
  const redPng=writeLayerPng(url(merged),{version:3,active:1,editTarget:"image",layers:[{name:"底图",visible:true,locked:false,opacity:100,source:url(transparent)},{name:"红色蒙版",visible:true,locked:false,opacity:100,source:url(red),mask:{enabled:true,source:url(mask)}},{name:"隐藏绿层",visible:false,locked:false,opacity:100,source:url(green)}]});
  const bluePng=encodeRgbaPng(16,16,blue);
  await fs.writeFile(redFile,redPng);await fs.writeFile(blueFile,bluePng);await fs.writeFile(path.join(folder,"textures/c.png"),encodeRgbaPng(16,16,green));
  const faces=Object.fromEntries(["east","west","north","south","up","down"].map(name=>[name,{uv:[1,1],uv_size:[3,3],...(name==="up"?{}:{dgn_texture:name==="south"?"textures/b.png":"textures/a.png"})}]));
  faces.north={...faces.north,uv:[4,1],uv_size:[-3,3],uv_rotation:90};
  const bones=[{name:"body",pivot:[0,0,0],cubes:[{origin:[-4,0,-4],size:[8,8,8],uv:faces},{origin:[6,0,0],size:[2,2,1],mirror:true,uv:[1,1]}]}];
  const geometry=JSON.stringify({"minecraft:geometry":[{description:{identifier:"geometry.atlas",texture_width:16,texture_height:16},bones}],unknown:42});
  const animation=JSON.stringify({animations:{"animation.atlas":{loop:true,animation_length:1,bones:{body:{rotation:{"0.00":[0,0,0],"1.00":[0,30,0]}}}}}});
  const animFile=path.join(folder,"model.animation.json");await fs.writeFile(file,geometry,"utf8");await fs.writeFile(animFile,animation,"utf8");
  const env={...process.env,DGN_GAME_HEADLESS:"1",DGN_GAME_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  let app,page;const errors=[];
  const button=name=>page.getByRole("button",{name,exact:true}),modal=()=>page.locator("dialog[open]");
  const capture=async name=>{await page.waitForTimeout(300);const bytes=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));await fs.writeFile(artifactPath("outputs/"+name+".png"),Buffer.from(bytes,"base64"));};
  const preview=async()=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));return decodePng(Buffer.from((await modal().getByLabel("贴图重排预览").evaluate(node=>node.toDataURL("image/png"))).split(",")[1],"base64"));};
  const open=async()=>{await button("带贴图重排").click();await modal().getByLabel("重排贴图宽").fill("32");await modal().getByLabel("重排贴图高").fill("24");await modal().getByLabel("贴图重排预览").waitFor();};
  const original=async()=>{assert.equal(await fs.readFile(file,"utf8"),geometry);assert.equal(await fs.readFile(animFile,"utf8"),animation);assert.deepEqual(await fs.readFile(redFile),redPng);assert.deepEqual(await fs.readFile(blueFile),bluePng);};
  const checkColors=async()=>{await page.waitForTimeout(450);const image=decodePng(await page.locator(".model-view-canvas").screenshot());let red=0,blue=0;for(let i=0;i<image.pixels.length;i+=4){const[r,g,b]=image.pixels.subarray(i,i+3);if(r>60&&r>g*1.7&&r>b*1.7)red++;if(b>60&&b>r*1.7&&b>g*1.7)blue++;}assert.ok(red>400,"模型应显示红色贴图");assert.ok(blue>400,"模型应显示蓝色贴图");};
  const target=artifactPath("outputs/atlas.bbmodel");
  try{
    app=await electron.launch({cwd:path.resolve(__dirname,".."),env,...(process.env.DGN_GAME_TEST_EXE?{executablePath:process.env.DGN_GAME_TEST_EXE,args:[]}:{args:["."]})});
    page=await app.firstWindow();page.setDefaultTimeout(15000);page.on("pageerror",error=>errors.push(error.message));
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setSize(1440,900);w.show();w.focus();});
    await page.getByRole("heading",{name:"存档",exact:true}).waitFor();await button("模组与资源").click();await button("模型制作").click();await page.locator(".model-library-open").filter({hasText:"geometry.atlas"}).click();
    await button("b.png").click();await page.waitForFunction(()=>[...document.querySelectorAll("button")].some(n=>n.textContent.trim()==="带贴图重排"&&!n.disabled));await button("body 立方体 1").click();await checkColors();await capture("atlas-source-dark");
    await button("导出 .bbmodel").click();await page.getByText(/多贴图方块工程不支持动画/).waitFor();
    await button("绘制").click();await page.getByLabel("画笔颜色").fill("#ffffff");const canvas=page.getByLabel("贴图绘制画布",{exact:true}),bounds=await canvas.boundingBox(),scale=Math.min(bounds.width,bounds.height)/16;
    await page.mouse.click(bounds.x+(bounds.width-scale*16)/2+1.5*scale,bounds.y+(bounds.height-scale*16)/2+1.5*scale);
    const painted=Buffer.from(blue);painted.set([255,255,255,255],(1*16+1)*4);await button("编辑").click();await open();const first=await preview();await capture("atlas-preview-dark");
    await modal().getByLabel("重排贴图宽").fill("2");await modal().getByRole("alert").filter({hasText:"放不下"}).waitFor();assert.equal(await button("导出重排工程").isDisabled(),true);await modal().getByLabel("重排贴图宽").fill("32");assert.deepEqual((await preview()).pixels,first.pixels);
    await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});await button("导出重排工程").click();await page.waitForFunction(()=>[...document.querySelectorAll("dialog button")].some(n=>n.textContent.trim()==="导出重排工程"&&!n.disabled));assert.equal(await modal().count(),1);await original();
    await fs.writeFile(redFile,encodeRgbaPng(16,16,green));await button("导出重排工程").click();await modal().getByRole("alert").filter({hasText:"外部修改"}).waitFor();assert.deepEqual((await preview()).pixels,first.pixels);
    await fs.writeFile(redFile,redPng);const occupied=artifactPath("outputs/occupied.bbmodel");await fs.mkdir(occupied);await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},occupied);
    await button("导出重排工程").click();await modal().getByRole("alert").filter({hasText:"类型发生变化"}).waitFor();await original();
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},target);await button("导出重排工程").click();await modal().waitFor({state:"detached"});
    const model=JSON.parse(await fs.readFile(target,"utf8")),packed=importProject(model),image=decodePng(Buffer.from(packed.texture.split(",")[1],"base64"));
    assert.equal(model.meta.model_format,"bedrock");assert.equal(model.textures.length,1);assert.equal(model.animations.length,1);assert.deepEqual(assignedTextures(packed.bones),[]);assert.deepEqual(image.pixels,first.pixels);
    compareFaces(bones,packed.bones,{"":painted,"textures/a.png":merged,"textures/b.png":painted},image);assert.equal(packed.animations["animation.atlas"].bones.body.rotation["1.00"][1],30);await original();
    console.log("PASS 三来源区分/默认当前贴图、隐藏层与蒙版、未保存笔画、逐面像素和预览一致、来源变化拒绝、取消和失败重试、动画图集合并");
    await button("绘制").click();await page.locator(".model-brush").getByRole("button",{name:"放弃",exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll(".model-brush button")].some(n=>n.textContent.trim()==="放弃"&&n.disabled));await button("编辑").click();
    await button("退出编辑").click();await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},target);await button("导入 .bbmodel").click();await button("texture.png").waitFor();await button("body 立方体 1").click();await checkColors();await capture("atlas-reimported");
    await button("动画").click();await button("animation.atlas").click();await button("播放").click();await page.waitForFunction(()=>Number(document.querySelector('input[aria-label="时间"]').value)>0.1);await button("暂停").click();await capture("atlas-animation");await button("编辑").click();
    await button("保存模型").click();await page.getByText("已写回模型文件，原文件保存在同名 .bak",{exact:true}).waitFor();await original();
    await app.evaluate(({BrowserWindow,nativeTheme})=>{BrowserWindow.getAllWindows()[0].setSize(1000,720);nativeTheme.themeSource="light";});await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");await open();await capture("atlas-small-light");
    assert.equal(await modal().evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}),true);await page.keyboard.press("Escape");
    assert.deepEqual(errors,[]);await fs.writeFile(artifactPath("outputs/result.json"),JSON.stringify({passed:true,errors},null,2),"utf8");console.log("PASS 重导入单图颜色、动画实际播放、继续保存、原文件保留和窄窗浅色");console.log(artifactRoot);
  }catch(error){if(page)await capture("failure").catch(()=>{});console.error("renderer errors",errors);throw error;}finally{if(app){const timer=setTimeout(()=>app.process().kill(),5000);try{await app.close();}finally{clearTimeout(timer);}}}
})().catch(error=>{console.error(error);process.exitCode=1;});
