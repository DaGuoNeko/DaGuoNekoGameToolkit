const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath } = require("./fixtures/artifacts.cjs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { bedrockMap } = require("./fixtures/map-world.cjs");
(async () => {
  let app;
  try {
    const data = artifactPath("data"), store = new WorkspaceStore(data); await store.load();
    const profiles = new Profiles(store); await profiles.initialize();
    const alternateProfile = await profiles.create("建筑测试配置");
    const worlds = new WorldLibrary(store, path.join(data, "game-data/MinecraftPE_Netease/minecraftWorlds"));
    for (const name of ["星河测试世界", "地形与建筑工作副本"]) {
      const world = await worlds.create(name === "星河测试世界" ? store.value.projects[0].id : alternateProfile.project.id, { name }); await bedrockMap(worlds.location(world.id));
    }
    const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.DGN_GAME_TEST_EXE || undefined, args: process.env.DGN_GAME_TEST_EXE ? [] : ["."], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.evaluate(() => {
      // 隐藏验收窗口仍走真实 View Transition；只调整可见性判定，不替换路由和动画。
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      window.navigationDirections = [];
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = update => { window.navigationDirections.push(document.documentElement.dataset.pageDirection); return start(update); };
    });
    const settle = () => page.waitForFunction(() => !document.documentElement.dataset.pageAnimating);
    const nav = async name => { await page.locator(".sidebar").getByRole("button", { name, exact: true }).click(); await settle(); };
    const names = await page.locator(".sidebar nav button").evaluateAll(items => items.map(item => item.getAttribute("aria-label")));
    assert.equal(names.length, 9);
    for (const name of names.slice(1)) await nav(name);
    assert.deepEqual(await page.evaluate(() => window.navigationDirections), Array(8).fill("forward"), "down the visible sidebar must always move forward");
    await page.evaluate(() => { window.navigationDirections = []; });
    for (const name of names.slice(0, -1).reverse()) await nav(name);
    assert.deepEqual(await page.evaluate(() => window.navigationDirections), Array(8).fill("backward"));
    await nav("模组与资源");
    await page.getByRole("navigation", { name: "工作区工具" }).getByRole("button", { name: "UI 编辑器", exact: true }).click(); await settle();
    await page.evaluate(() => { window.navigationDirections = []; });
    await nav("启动配置"); await nav("模组与资源");
    assert.deepEqual(await page.evaluate(() => window.navigationDirections), ["forward", "backward"], "remembered child page must not change workspace direction");
    await page.getByRole("button", { name: "新建", exact: true }).waitFor();
    const nativeClick = async locator => {
      assert.equal(await locator.evaluate(el => getComputedStyle(el).getPropertyValue("-webkit-app-region")), "no-drag", "title bar controls must accept native input");
      const box = await locator.boundingBox();
      await app.evaluate(({ BrowserWindow }, point) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
        contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      }, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
    };
    await nativeClick(page.locator(".app-bar").getByRole("button", { name: "会话", exact: true }));
    await page.getByRole("heading", { name: "会话控制台", exact: true }).waitFor(); await settle();
    await nativeClick(page.locator(".app-bar").getByRole("button", { name: "任务与记录", exact: true }));
    await page.getByRole("heading", { name: "任务与记录", exact: true }).waitFor(); await settle();
    await nav("存档");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const alternateCard = page.getByRole("article", { name: "存档 地形与建筑工作副本", exact: true });
    await alternateCard.getByRole("button", { name: "打开存档控制台", exact: true }).click();
    await page.getByRole("button", { name: "编辑绑定启动配置", exact: true }).click();
    await page.getByRole("heading", { name: "建筑测试配置", exact: true }).waitFor();
    await page.getByLabel("玩家名称", { exact: true }).fill("UnsavedBuilder");
    await page.getByRole("button", { name: "返回来源存档", exact: true }).click();
    await page.getByRole("heading", { name: "地形与建筑工作副本", exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑绑定启动配置", exact: true }).click();
    assert.equal(await page.getByLabel("玩家名称", { exact: true }).inputValue(), "UnsavedBuilder", "return to world must retain profile draft");
    await page.getByRole("button", { name: "返回来源存档", exact: true }).click();
    await page.getByRole("button", { name: "返回存档列表", exact: true }).click();
    const card = page.getByRole("article", { name: "存档 星河测试世界", exact: true });
    await card.getByRole("button", { name: "打开存档控制台", exact: true }).click();
    await page.getByRole("button", { name: "编辑绑定启动配置", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("heading", { name: "星河测试世界", exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑绑定启动配置", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认", exact: true }).click();
    await page.getByLabel("玩家名称", { exact: true }).waitFor();
    assert.notEqual(await page.getByLabel("玩家名称", { exact: true }).inputValue(), "UnsavedBuilder");
    await page.getByRole("button", { name: "返回来源存档", exact: true }).click();
    await page.getByRole("button", { name: "返回存档列表", exact: true }).click();
    assert.equal(await card.locator("details").count(), 0, "actions must not expand the card");
    const before = await card.boundingBox();
    for (const label of ["快速测试", "打开存档控制台", "删除存档", "打开目录"])
      assert(await card.getByRole("button", { name: label, exact: true }).isVisible(), label);
    for (const label of ["打开存档", "存档设置", "选择启动配置", "地图预览", "存档模组"])
      assert.equal(await card.getByRole("button", { name: label, exact: true }).count(), 0, label + " must use the console entry");
    assert.equal(await card.getByRole("button", { name: "打开存档控制台", exact: true }).count(), 1);
    await card.getByRole("button", { name: "打开存档控制台", exact: true }).focus();
    await page.keyboard.press("Enter");
    const tabs = page.getByRole("navigation", { name: "存档工作区" });
    await page.getByRole("heading", { name: "运行概况", exact: true }).waitFor();
    assert.equal(await tabs.getByRole("button", { name: "概览", exact: true }).getAttribute("aria-current"), "page");
    for (const name of ["地图", "模组", "设置"]) assert(await tabs.getByRole("button", { name, exact: true }).isVisible());
    await page.getByRole("button", { name: "存档设置", exact: true }).click();
    await page.getByRole("button", { name: "编辑存档设置", exact: true }).click();
    const settings = page.getByRole("dialog");
    await settings.waitFor();
    assert.equal(await page.locator(".world-workspace").count(), 1, "settings must keep the console mounted");
    assert.equal(await page.locator(".world-grid").count(), 0, "settings must not return to the library");
    for (const label of ["使用启动配置", "游戏模式", "世界类型"])
      assert(await settings.getByRole("combobox", { name: label, exact: true }).isVisible(), label);
    for (const label of ["存档名称", "世界种子", "允许作弊", "死亡不掉落", "天气变化", "昼夜循环"])
      assert(await settings.getByLabel(label, { exact: true }).isVisible(), label);
    assert(await settings.getByRole("combobox", { name: "世界类型", exact: true }).isDisabled());
    assert(await settings.getByLabel("世界种子", { exact: true }).isDisabled());
    await settings.locator("summary").filter({ hasText: "实验性世界选项" }).click();
    for (const label of ["自定义生物群系", "创作者功能", "实验性摄像机", "GameTest", "延迟渲染技术预览"])
      assert(await settings.getByLabel(label, { exact: true }).isVisible(), label);
    await settings.getByLabel("存档名称", { exact: true }).fill("取消的名称");
    await settings.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await tabs.getByRole("button", { name: "设置", exact: true }).getAttribute("aria-current"), "page");
    await page.getByRole("button", { name: "编辑存档设置", exact: true }).click();
    assert.equal(await settings.getByLabel("存档名称", { exact: true }).inputValue(), "星河测试世界");
    await settings.getByRole("combobox", { name: "使用启动配置", exact: true }).click();
    await page.getByRole("option", { name: "建筑测试配置", exact: true }).click();
    await settings.getByRole("combobox", { name: "游戏模式", exact: true }).click();
    await page.getByRole("option", { name: "冒险", exact: true }).click();
    await settings.getByLabel("死亡不掉落", { exact: true }).uncheck();
    await settings.locator("summary").filter({ hasText: "实验性世界选项" }).click();
    await settings.getByLabel("GameTest", { exact: true }).check();
    await settings.getByRole("button", { name: "保存存档设置", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
    await page.getByRole("status").filter({ hasText: "正在处理存档操作" }).waitFor({ state: "hidden" });
    const saved = (await page.evaluate(() => window.toolkit.call("worlds.list"))).worlds.find(world => world.name === "星河测试世界");
    assert.equal(saved.profileId, alternateProfile.project.id);
    assert.equal(saved.options.game_mode, 2);
    assert.equal(saved.options.keep_inventory, false);
    assert.equal(saved.options.experiment_options.gametest, true);
    assert.equal(await tabs.getByRole("button", { name: "设置", exact: true }).getAttribute("aria-current"), "page");
    await page.getByRole("button", { name: "返回存档列表", exact: true }).click();
    await card.waitFor();
    assert(Math.abs((await card.boundingBox()).height - before.height) < 1);
    const capture = async name => {
      const png = await app.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await new Promise(resolve => setTimeout(resolve, 350));
        return (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString("base64");
      });
      await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png, "base64"));
    };
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const [theme, width, height] of [["Light", 1240, 820], ["Dark", 900, 650]]) {
      await page.evaluate(theme => window.toolkit.call("settings.update", { AppearanceMode: theme }), theme);
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme.toLowerCase(), theme);
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
      await page.waitForFunction(() => {
        const button = document.querySelector(".world-card-primary-actions .button:not(.primary)");
        return button && getComputedStyle(button).color === getComputedStyle(document.body).color;
      });
      await capture("cards-" + theme);
      await card.getByRole("button", { name: "打开存档控制台", exact: true }).click();
      await page.getByRole("heading", { name: "运行概况", exact: true }).waitFor();
      assert.equal(await tabs.getByRole("button", { name: "概览", exact: true }).getAttribute("aria-current"), "page");
      const exit = page.getByRole("button", { name: "返回存档列表", exact: true });
      const heading = page.getByRole("heading", { name: "星河测试世界", exact: true }); await heading.waitFor();
      assert((await exit.boundingBox()).y < (await heading.boundingBox()).y, "workspace exit precedes its content");
      assert.equal(await page.locator(".world-context-actions").getByRole("button", { name: "返回存档列表", exact: true }).count(), 0);
      await page.evaluate(() => { const main = document.querySelector(".main-shell > main"); main.scrollTop = main.scrollHeight; });
      await page.waitForTimeout(100);
      const mainTop = await page.locator(".main-shell > main").evaluate(el => el.getBoundingClientRect().top);
      assert((await exit.boundingBox()).y >= mainTop, "exit stays reachable while scrolling");
      await page.evaluate(() => { document.querySelector(".main-shell > main").scrollTop = 0; });
      await capture("world-" + theme);
      const headerButtons = await page.locator(".app-bar button").evaluateAll(items => items.map(el => ({ x: el.getBoundingClientRect().right, drag: getComputedStyle(el).getPropertyValue("-webkit-app-region") })));
      const controls = await page.locator(".window-controls").boundingBox();
      assert(headerButtons.every(item => item.drag === "no-drag" && item.x < controls.x));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await exit.focus(); await page.keyboard.press("Enter"); await card.waitFor();
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => { window.navigationDirections = []; }); await nav("设置");
    assert.deepEqual(await page.evaluate(() => window.navigationDirections), []);
    assert.deepEqual(errors, []);
    console.log("PASS navigation order, remembered subpages, native title-bar input, bound profile roundtrip/draft guards, fixed card actions, sticky exit, keyboard and themes");
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
