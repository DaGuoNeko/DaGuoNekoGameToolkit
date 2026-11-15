const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), zlib = require("node:zlib");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

function png(pixels) {
  const chunk = (name, bytes) => {
    const size = Buffer.alloc(4), body = Buffer.concat([Buffer.from(name), bytes]), crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); crc.writeUInt32BE(zlib.crc32(body)); return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13), raw = Buffer.alloc(16 * 65);
  header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < 16; y++) pixels.copy(raw, y * 65 + 1, y * 64, y * 64 + 64);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const put = (pixels, x, y, color) => pixels.set(color, (y * 16 + x) * 4);
const pixel = (pixels, x, y) => pixels.subarray((y * 16 + x) * 4, (y * 16 + x + 1) * 4);
const clockwise = [0,0,1,0,0, 0,4,1,2,0, 7,7,5,3,3, 0,8,9,6,0, 0,0,9,0,0];
const counterclockwise = [0,0,3,0,0, 0,2,3,6,0, 1,1,5,9,9, 0,4,7,8,0, 0,0,7,0,0];

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "rotation"), texture = path.join(folder, "textures/ink.png");
  await fs.mkdir(path.dirname(texture), { recursive: true });
  const source = Buffer.alloc(16 * 16 * 4, 255);
  const colors = [[0,0,0,0], [255,0,0,255], [0,255,0,255], [0,0,255,128], [255,0,255,255], [0,255,255,255], [255,255,0,128], [0,0,0,255], [255,255,255,128]];
  for (let i = 0; i < 9; i++) {
    put(source, 2 + i % 3, 2 + Math.floor(i / 3), colors[i]);
    put(source, 9 + i % 3, 9 + Math.floor(i / 3), i === 4 ? [0,255,255,255] : [255,0,0,255]);
  }
  await fs.writeFile(texture, png(source));
  const file = path.join(folder, "model.geo.json"), geometry = JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.rotation", texture_width: 16, texture_height: 16 }, bones: [{ name: "body", cubes: [{ origin: [-4,0,-2], size: [8,12,4], uv: Object.fromEntries(["east","west","north","south","up","down"].map(name => [name, { uv: [0,0], uv_size: [16,16] }])) }] }] }] });
  await fs.writeFile(file, geometry, "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.join(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.rotation" }).click();
    await page.getByRole("button", { name: "ink.png", exact: true }).waitFor(); await page.getByRole("button", { name: "绘制", exact: true }).click();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const button = name => page.locator(".model-brush").getByRole("button", { name, exact: true }), modal = () => page.locator("dialog[open]");
  const canvas = () => page.getByLabel("贴图绘制画布", { exact: true });
  const at = async (x, y) => { const b = await canvas().boundingBox(), s = Math.min(b.width, b.height) / 16; return { x: b.x + (b.width - s * 16) / 2 + (x + .5) * s, y: b.y + (b.height - s * 16) / 2 + (y + .5) * s }; };
  const select = async (x = 2, y = 2, w = 3, h = 3) => {
    await button("选区").click(); const a = await at(x,y), b = await at(x+w-1,y+h-1);
    await page.keyboard.down("Shift"); await page.mouse.move(a.x,a.y); await page.mouse.down(); await page.mouse.move(b.x,b.y,{steps:3}); await page.mouse.up(); await page.keyboard.up("Shift");
  };
  const save = async () => {
    await button("保存贴图").click();
    await page.waitForFunction(() => { const b = [...document.querySelectorAll(".model-brush button")]; return b.some(n => n.textContent.trim() === "保存贴图" && !n.disabled) && b.some(n => n.textContent.trim() === "放弃" && n.disabled); });
    return decodePng(await fs.readFile(texture)).pixels;
  };
  const undo = async expected => { await button("撤销").click(); assert.deepEqual(await save(), expected); };
  const open = async angle => { await button("自定义旋转").click(); await modal().getByRole("heading", { name: "旋转选区", exact: true }).waitFor(); await modal().getByLabel("选区旋转角度").fill(String(angle)); };
  const preview = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const url = await modal().getByLabel("选区旋转预览").evaluate(node => node.toDataURL("image/png"));
    return decodePng(Buffer.from(url.split(",")[1], "base64")).pixels;
  };
  const apply = async () => { await modal().getByRole("button", { name: "应用旋转", exact: true }).click(); await page.locator("dialog[open]").waitFor({ state: "detached" }); };
  const capture = async name => {
    await page.waitForTimeout(350);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png,"base64"));
  };
  const expected = (mapping, x = 2, y = 2, ring = false) => {
    const output = Buffer.from(source), width = Math.sqrt(mapping.length);
    for (let i = 0; i < 9; i++) if (!ring || i !== 4) put(output, x+i%3, y+Math.floor(i/3), [0,0,0,0]);
    for (let i = 0; i < mapping.length; i++) if (mapping[i] && (!ring || mapping[i] !== 5)) put(output, x+i%width, y+Math.floor(i/width), pixel(source,x+(mapping[i]-1)%3,y+Math.floor((mapping[i]-1)/3)));
    return output;
  };
  try {
    await launch(); await select();
    for (const angle of ["", 0, 361, -361]) {
      await open(angle); await modal().getByRole("alert").waitFor();
      assert.equal(await modal().getByRole("button",{ name:"应用旋转",exact:true }).isDisabled(), true);
      await modal().getByRole("button",{ name:"取消",exact:true }).click(); assert.deepEqual(await save(), source);
    }
    await open(45); assert.deepEqual(await preview(), expected(clockwise)); await capture("rotation-preview-dark");
    await modal().getByLabel("选区旋转角度").fill("90"); assert.deepEqual(await preview(), expected([7,4,1,8,5,2,9,6,3]));
    await modal().getByRole("button",{ name:"45°",exact:true }).click(); assert.deepEqual(await preview(), expected(clockwise), "重复预览从原图重新计算");
    await page.keyboard.press("Escape"); assert.deepEqual(await save(), source);
    assert.equal(await button("撤销").isDisabled(), true, "取消预览不增加历史");
    for (const [angle, mapping] of [[45,clockwise],[-45,counterclockwise],[90,[7,4,1,8,5,2,9,6,3]]]) {
      await select(); await open(angle); assert.deepEqual(await preview(), expected(mapping)); await apply();
      assert.deepEqual(await save(), expected(mapping)); await undo(source); await button("重做").click(); assert.deepEqual(await save(), expected(mapping)); await undo(source);
    }
    await open(360); await apply(); assert.deepEqual(await save(), source); assert.equal(await button("撤销").isDisabled(),true);
    await select(14,14,2,2); await open(45); await modal().getByRole("alert").filter({hasText:"选区超出贴图范围"}).waitFor();
    assert.equal(await modal().getByRole("button",{ name:"应用旋转",exact:true }).isDisabled(),true); await page.keyboard.press("Escape"); assert.deepEqual(await save(),source);
    console.log("PASS 正负角度逐像素、90度对照、360度无修改、预览切换/取消、边角背景/透明像素、越界与撤销重做");

    await button("取消选区").click(); await button("魔棒").click(); const p = await at(9,9); await page.mouse.click(p.x,p.y);
    await open(45); assert.deepEqual(await preview(),expected(clockwise,9,9,true)); await apply(); assert.deepEqual(await save(),expected(clockwise,9,9,true)); await undo(source);
    await page.getByRole("button",{name:"锁定图层 背景",exact:true}).click(); await select();
    await button("自定义旋转").click(); await page.getByText("当前图层已锁定或隐藏，请先解锁或显示",{exact:true}).waitFor();
    assert.equal(await modal().count(),0); await page.getByRole("button",{name:"解锁图层 背景",exact:true}).click(); await save(); await select();
    await button("立体").click(); await open(-22.5); const decimal = await preview(); await apply();
    await capture("rotation-solid-applied");
    const exported = artifactPath("outputs/rotated.bbmodel");
    await app.evaluate(({dialog},file) => { dialog.showSaveDialog = async () => ({canceled:false,filePath:file}); }, exported);
    await page.getByRole("button",{name:"导出 .bbmodel",exact:true}).click(); await page.getByText(/工程已导出：/).waitFor();
    assert.deepEqual(decodePng(Buffer.from(JSON.parse(await fs.readFile(exported,"utf8")).textures[0].source.split(",")[1],"base64")).pixels,decimal);
    assert.deepEqual(decodePng(await fs.readFile(texture)).pixels,source);
    await fs.unlink(texture+".bak"); await fs.mkdir(texture+".bak"); await button("保存贴图").click();
    await page.getByText("所选路径是链接或类型发生变化，请重新选择",{exact:true}).waitFor(); assert.deepEqual(decodePng(await fs.readFile(texture)).pixels,source);
    await fs.rmdir(texture+".bak"); assert.deepEqual(await save(),decimal); assert.deepEqual(decodePng(await fs.readFile(texture+".bak")).pixels,source);
    await close(); await launch(); assert.deepEqual(await save(),decimal); assert.equal(await fs.readFile(file,"utf8"),geometry);
    await select(); await open(45);
    await app.evaluate(({BrowserWindow,nativeTheme}) => { BrowserWindow.getAllWindows()[0].setSize(1000,720); nativeTheme.themeSource="light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme==="light"); await capture("rotation-preview-small-light");
    assert.equal(await modal().evaluate(node => { const r=node.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight; }),true);
    await modal().getByRole("button",{name:"取消",exact:true}).click(); assert.deepEqual(await save(),decimal);
    assert.deepEqual(errors,[]);
    await fs.writeFile(artifactPath("outputs/result.json"),JSON.stringify({passed:true,errors},null,2),"utf8");
    console.log("PASS 魔棒孔洞、锁定保护、小数角度、立体预览、未保存导出、备份/失败重试、重启和窄窗浅色"); console.log(artifactRoot);
  } catch(error) { if(page)await capture("failure").catch(()=>{});throw error; }
  finally { await close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
