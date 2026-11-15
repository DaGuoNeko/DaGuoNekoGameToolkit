const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { encodeRgbaPng, decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { writeLayerPng } = require("../electron/domains/profiles/texture-layers.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { uvFaces } = require("../shared/model-edit.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");
const url = pixels => "data:image/png;base64," + encodeRgbaPng(16,16,pixels).toString("base64");
const fixture = () => [{ name:"body",pivot:[0,3,0],cubes:[
  {origin:[-2,0,-1],size:[2,3,1],uv:[1,1],mirror:true},
  {origin:[2,0,-1],size:[2,2,1],uv:[1,1]},
  {origin:[0,4,-1],size:[2,2,1],uv:{north:{uv:[5,4],uv_size:[-3,2],uv_rotation:90},south:{uv:[2,3],uv_size:[2,-2]}}},
] }];
function checkAppearance(bones, packed, source, image) {
  for(let b=0;b<bones.length;b++)for(let c=0;c<bones[b].cubes.length;c++){
    const before=uvFaces(bones[b].cubes[c]),after=uvFaces(packed[b].cubes[c]);
    for(let i=0;i<before.length;i++){
      const a=before[i],z=after[i];assert.equal(a.w,z.w);assert.equal(a.h,z.h);
      for(let y=0;y<Math.abs(a.h);y++)for(let x=0;x<Math.abs(a.w);x++){
        const si=((Math.min(a.y,a.y+a.h)+y)*16+Math.min(a.x,a.x+a.w)+x)*4;
        const di=((Math.min(z.y,z.y+z.h)+y)*image.width+Math.min(z.x,z.x+z.w)+x)*4;
        assert.deepEqual(image.pixels.subarray(di,di+4),source.subarray(si,si+4),a.name+" 重排前后贴图应一致");
      }
    }
  }
}
(async()=>{
  const data=artifactPath("data"),folder=path.join(data,"model-studio","repack"),file=path.join(folder,"model.geo.json"),texture=path.join(folder,"textures/ink.png");
  await fs.mkdir(path.dirname(texture),{recursive:true});
  const bones=fixture(),geometry=JSON.stringify({"minecraft:geometry":[{description:{identifier:"geometry.repack",texture_width:16,texture_height:16},bones}]});
  await fs.writeFile(file,geometry,"utf8");
  const animFile=path.join(folder,"model.animation.json"),anim=JSON.stringify({animations:{"animation.repack":{loop:true,animation_length:1,bones:{body:{rotation:{"0.00":[0,0,0],"1.00":[0,10,0]}}}}}});
  await fs.writeFile(animFile,anim,"utf8");
  const base=Buffer.alloc(16*16*4),top=Buffer.alloc(base.length),mask=Buffer.alloc(base.length,255),merged=Buffer.alloc(base.length);
  for(let i=0;i<256;i++){
    base.set([0,255,0,255],i*4);
    const alpha=i%3===0?0:i%3===1?128:255,red=i%2?255:0,blue=i%4?0:255;
    top.set([red,0,blue,alpha],i*4);if(i===34)mask.set([0,0,0,255],i*4);
    const a=i===34?0:alpha;merged.set([Math.round(red*a/255),255-a,Math.round(blue*a/255),255],i*4);
  }
  const layers={version:3,active:1,editTarget:"image",layers:[{name:"底色",visible:true,locked:false,opacity:100,source:url(base)},{name:"图案",visible:true,locked:false,opacity:100,source:url(top),mask:{enabled:true,source:url(mask)}}]};
  const originalPng=writeLayerPng(url(merged),layers);await fs.writeFile(texture,originalPng);
  const env={...process.env,DGN_GAME_HEADLESS:"1",DGN_GAME_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  let app,page;const errors=[];
  const launch=async()=>{
    app=await electron.launch({cwd:path.resolve(__dirname,".."),env,...(process.env.DGN_GAME_TEST_EXE?{executablePath:process.env.DGN_GAME_TEST_EXE,args:[]}:{args:["."]})});
    page=await app.firstWindow();page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setSize(1440,900);w.show();w.focus();});
    await page.getByRole("heading",{name:"存档",exact:true}).waitFor();await page.getByRole("button",{name:"模组与资源",exact:true}).click();await page.getByRole("button",{name:"模型制作",exact:true}).click();
    await page.locator(".model-library-open").filter({hasText:"geometry.repack"}).click();await page.getByRole("button",{name:"ink.png",exact:true}).waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll("button")].some(n=>n.textContent.trim()==="带贴图重排"&&!n.disabled));
  };
  const close=async()=>{if(!app)return;const instance=app;app=null;const timer=setTimeout(()=>instance.process().kill(),5000);try{await instance.close();}finally{clearTimeout(timer);}};
  const button=name=>page.getByRole("button",{name,exact:true}),modal=()=>page.locator("dialog[open]");
  const open=async(w=24,h=20)=>{await button("带贴图重排").click();await modal().getByLabel("重排贴图宽").fill(String(w));await modal().getByLabel("重排贴图高").fill(String(h));};
  const capture=async name=>{await page.waitForTimeout(350);const bytes=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));await fs.writeFile(artifactPath("outputs/"+name+".png"),Buffer.from(bytes,"base64"));};
  const preview=async()=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));return decodePng(Buffer.from((await modal().getByLabel("贴图重排预览").evaluate(n=>n.toDataURL("image/png"))).split(",")[1],"base64"));};
  const original=async()=>{assert.equal(await fs.readFile(file,"utf8"),geometry);assert.equal(await fs.readFile(animFile,"utf8"),anim);assert.deepEqual(await fs.readFile(texture),originalPng);};
  try{
    await launch();
    const checkHeader=async()=>{
      for(const name of ["自动排列","带贴图重排"]) assert.equal(await button(name).evaluate(node=>{
        const label=node.querySelector(".visually-hidden"),r=node.getBoundingClientRect(),panel=node.closest(".model-uv").getBoundingClientRect(),board=node.closest(".model-uv").querySelector(".model-texture-view").getBoundingClientRect();
        return !label&&r.width>=40&&r.left>=panel.left&&r.right<=panel.right&&r.bottom<=board.top;
      }),true,"UV 操作文字须可见且不压住画板");
    };
    await checkHeader();await button("body 立方体 1").click();await open();await capture("repack-preview-dark");
    const first=await preview();
    await modal().getByLabel("重排贴图宽").fill("4");await modal().getByRole("alert").waitFor();assert.equal(await button("导出重排工程").isDisabled(),true);
    await modal().getByLabel("重排贴图宽").fill("24");await modal().getByLabel("间距（像素）").fill("");await modal().getByRole("alert").waitFor();assert.equal(await button("导出重排工程").isDisabled(),true);
    await modal().getByLabel("间距（像素）").fill("1");assert.deepEqual((await preview()).pixels,first.pixels);
    await page.keyboard.press("Escape");await original();assert.equal(await page.getByLabel("U",{exact:true}).inputValue(),"1");assert.equal(await button("撤销").isDisabled(),true);
    await open();await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});await button("导出重排工程").click();
    await page.waitForFunction(()=>[...document.querySelectorAll("dialog button")].some(n=>n.textContent.trim()==="导出重排工程"&&!n.disabled));assert.equal(await modal().count(),1);await original();
    const exported=artifactPath("outputs/repacked.bbmodel");
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exported);
    await button("导出重排工程").click();await modal().waitFor({state:"detached"});
    const packed=importProject(JSON.parse(await fs.readFile(exported,"utf8"))),decoded=decodePng(Buffer.from(packed.texture.split(",")[1],"base64"));
    assert.equal(packed.textureWidth,24);assert.equal(packed.textureHeight,20);assert.deepEqual(decoded.pixels,first.pixels);
    checkAppearance(bones,packed.bones,merged,decoded);assert.equal(packed.animations["animation.repack"].bones.body.rotation["1.00"][1],10);
    await original();assert.equal(await page.getByLabel("U",{exact:true}).inputValue(),"1");assert.equal(await button("撤销").isDisabled(),true);
    await open();await button("导出重排工程").click();await modal().waitFor({state:"detached"});
    assert.equal((await fs.readdir(path.dirname(exported))).filter(n=>n.startsWith("repacked.bbmodel.")&&n.endsWith(".bak")).length,1);
    console.log("PASS 重排预览/尺寸和间距拒绝/取消，像素与 UV 同步导出，镜像/带符号 UV/面旋转/源重叠、合成图层蒙版、动画及覆盖备份");

    await page.getByLabel("U",{exact:true}).fill("1.5");await open();await modal().getByRole("alert").filter({hasText:"整数像素"}).waitFor();assert.equal(await button("导出重排工程").isDisabled(),true);await page.keyboard.press("Escape");
    await button("撤销").click();assert.equal(await page.getByLabel("U",{exact:true}).inputValue(),"1");
    await page.getByLabel("U",{exact:true}).fill("-1");await open();await modal().getByRole("alert").filter({hasText:"源 UV 超出"}).waitFor();await page.keyboard.press("Escape");await button("撤销").click();
    await page.getByLabel("贴图宽",{exact:true}).fill("32");await open();await modal().getByRole("alert").filter({hasText:"尺寸必须"}).waitFor();await page.keyboard.press("Escape");await page.getByLabel("贴图宽",{exact:true}).fill("16");
    await open();const failedTarget=artifactPath("outputs/occupied.bbmodel");await fs.mkdir(failedTarget);
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},failedTarget);
    await button("导出重排工程").click();await modal().getByRole("alert").filter({hasText:"类型发生变化"}).waitFor();await original();assert.deepEqual((await preview()).pixels,first.pixels);
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exported);
    await button("导出重排工程").click();await modal().waitFor({state:"detached"});await original();
    console.log("PASS 小数/越界源 UV、尺寸不匹配拒绝，真实导出失败保留预览并重试，原文件不变");

    await button("绘制").click();await page.getByLabel("画笔颜色").fill("#ffffff");const canvas=page.getByLabel("贴图绘制画布",{exact:true}),b=await canvas.boundingBox(),scale=Math.min(b.width,b.height)/16;
    await page.mouse.click(b.x+(b.width-scale*16)/2+1.5*scale,b.y+(b.height-scale*16)/2+1.5*scale);
    await button("编辑").click();await open();const dirtyPreview=await preview();await button("导出重排工程").click();await modal().waitFor({state:"detached"});
    const dirtyProject=importProject(JSON.parse(await fs.readFile(exported,"utf8"))),dirtyImage=decodePng(Buffer.from(dirtyProject.texture.split(",")[1],"base64"));
    assert.deepEqual(dirtyImage.pixels,dirtyPreview.pixels);const dirtySource=Buffer.from(merged);dirtySource.set([255,255,255,255],(1*16+1)*4);checkAppearance(bones,dirtyProject.bones,dirtySource,dirtyImage);await original();
    await button("绘制").click();await page.locator(".model-brush").getByRole("button",{name:"放弃",exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll(".model-brush button")].some(n=>n.textContent.trim()==="放弃"&&n.disabled));await button("编辑").click();
    await button("退出编辑").click();await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},exported);await button("导入 .bbmodel").click();
    await button("texture.png").waitFor();await page.waitForFunction(()=>document.querySelector(".model-texture-list .active")?.textContent==="texture.png");
    assert.equal(await page.getByLabel("贴图宽",{exact:true}).inputValue(),"24");assert.equal(await page.getByLabel("贴图高",{exact:true}).inputValue(),"20");
    await button("body 立方体 1").click();assert.equal(Number(await page.getByLabel("U",{exact:true}).inputValue()),dirtyProject.bones[0].cubes[0].uv[0]);
    await button("动画").click();await button("animation.repack").waitFor();await button("编辑").click();await capture("reimported-model");
    await button("保存模型").click();await page.getByText("已写回模型文件，原文件保存在同名 .bak",{exact:true}).waitFor();await original();
    await app.evaluate(({BrowserWindow,nativeTheme})=>{BrowserWindow.getAllWindows()[0].setSize(1000,720);nativeTheme.themeSource="light";});await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");
    await page.waitForTimeout(350);await checkHeader();await capture("repack-workspace-small-light");
    await open(32,32);await capture("repack-small-light");assert.equal(await modal().evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}),true);
    await page.keyboard.press("Escape");assert.deepEqual(errors,[]);
    await fs.writeFile(artifactPath("outputs/result.json"),JSON.stringify({passed:true,errors},null,2),"utf8");
    console.log("PASS 未保存绘制合成导出、重导入继续编辑、动画保留、模型/原图不变及窄窗浅色");console.log(artifactRoot);
  }catch(error){if(page)await capture("failure").catch(()=>{});throw error;}finally{await close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
