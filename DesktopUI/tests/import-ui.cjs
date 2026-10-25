const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { zip, levelData } = require("./fixtures/zip.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-import-ui-"));
  let app;
  try {
    const dataRoot = path.join(root, "data"),
      mod = path.join(root, "模组A"),
      source = path.join(root, "外部世界"),
      archive = path.join(root, "打包存档.zip");
    await fs.mkdir(mod);
    await fs.mkdir(path.join(source, "db"), { recursive: true });
    await fs.writeFile(path.join(source, "level.dat"), levelData());
    await fs.writeFile(path.join(source, "db", "progress"), "FOLDER_SAVE");
    const packId = "d1dd0070-a7a2-4acb-af6b-d01337361f61";
    const archiveBytes = zip([
      { name: "外层/世界/level.dat", data: levelData() },
      { name: "外层/世界/db/progress", data: "ZIP_SAVE" },
      {
        name: "外层/世界/world_behavior_packs.json",
        data: JSON.stringify([{ pack_id: packId, version: [1, 0, 0] }]),
      },
      {
        name: "外层/世界/behavior_packs/内置包/pack_manifest.json",
        data: JSON.stringify({
          format_version: 1,
          header: { name: "内置包", uuid: packId, version: [1, 0, 0] },
          modules: [
            {
              type: "data",
              uuid: "725e64f8-210b-4adc-95a0-1310dd123665",
              version: [1, 0, 0],
            },
          ],
        }),
      },
    ]);
    await fs.writeFile(archive, archiveBytes);
    const store = new WorkspaceStore(dataRoot);
    await store.load();
    const profiles = new Profiles(store);
    await profiles.initialize();
    const initial = await profiles.read(store.value.projects[0].id);
    await profiles.save(initial.project.id, initial.revision, {
      included_mod_dirs: [mod],
    });
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
      args: process.env.DGN_GAME_TEST_EXE ? [] : ["."],
      env: {
        ...process.env,
        DGN_GAME_HEADLESS: "1",
        DGN_GAME_DATA_DIR: dataRoot,
      },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await app.evaluate(({ BrowserWindow, shell, dialog }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
        false,
      );
      globalThis.opened = [];
      shell.openPath = async (target) => {
        globalThis.opened.push(target);
        return "";
      };
      dialog.showOpenDialog = async (...args) => {
        const opts = args.at(-1);
        globalThis.pickerOptions = opts;
        return { canceled: false, filePaths: [globalThis.fixturePick] };
      };
    });
    const nav = async (name) => {
      await page
        .locator(".sidebar")
        .getByRole("button", { name, exact: true })
        .click();
      await page.waitForFunction(
        () => !document.documentElement.dataset.pageAnimating,
      );
    };
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await nav("模组库");
    await page
      .getByRole("article", { name: "模组 模组A", exact: true })
      .getByRole("button", { name: "打开文件夹", exact: true })
      .click();
    assert.deepEqual(await app.evaluate(() => globalThis.opened), [mod]);
    const catalog = await page.evaluate(() => window.toolkit.call("mods.list"));
    await page.evaluate(
      (value) =>
        window.toolkit.call("mods.remove", {
          id: value.mods[0].id,
          revision: value.revision,
        }),
      catalog,
    );
    // Removing a library mod now also removes its profile references. Explicitly
    // add a profile-only entry before testing that separate folder-opening path.
    const cleaned = await page.evaluate(
      (id) => window.toolkit.call("project.read", { id }),
      initial.project.id,
    );
    assert.deepEqual(cleaned.config.included_mod_dirs, []);
    await page.evaluate(
      ({ id, revision, mod }) =>
        window.toolkit.call("project.save", {
          id,
          revision,
          patch: { included_mod_dirs: [mod] },
        }),
      { id: initial.project.id, revision: cleaned.revision, mod },
    );
    await nav("启动配置");
    await page.getByRole("button", { name: "编辑配置", exact: true }).click();
    await page
      .getByRole("button", { name: "打开模组文件夹 模组A", exact: true })
      .click();
    assert.deepEqual(await app.evaluate(() => globalThis.opened), [mod, mod]);
    await nav("存档");
    const cdp = await page.context().newCDPSession(page);
    async function drop(file) {
      await page.locator(".world-home").scrollIntoViewIfNeeded();
      const b = await page.locator(".world-home").boundingBox();
      const data = { items: [], files: [file], dragOperationsMask: 1 };
      for (const type of ["dragEnter", "dragOver", "drop"])
        await cdp.send("Input.dispatchDragEvent", {
          type,
          x: b.x + 80,
          y: b.y + 30,
          data,
        });
    }
    await drop(source);
    assert.match(
      await page
        .getByRole("combobox", { name: "存档使用方式", exact: true })
        .textContent(),
      /直接使用原目录/,
    );
    await page
      .getByRole("dialog")
      .getByLabel("存档名称", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("dialog")
        .getByLabel("存档名称", { exact: true })
        .inputValue(),
      "外部世界",
    );
    assert.match(
      await page
        .getByRole("combobox", { name: "使用启动配置", exact: true })
        .textContent(),
      /自动匹配/,
    );
    const beforeAutomatic = await page.evaluate(
      (id) => window.toolkit.call("project.read", { id }),
      initial.project.id,
    );
    await fs.mkdir("test-results", { recursive: true });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const importShot = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        )
      )
        .toPNG()
        .toString("base64"),
    );
    await fs.writeFile(
      "test-results/world-import-auto.png",
      Buffer.from(importShot, "base64"),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    assert.equal(
      (await page.evaluate(() => window.toolkit.call("worlds.list"))).worlds
        .length,
      0,
    );
    assert.equal(
      (await page.evaluate(() => window.toolkit.call("profiles.list"))).length,
      1,
    );
    await drop(source);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "开始导入", exact: true })
      .click();
    await page
      .getByRole("article", { name: "存档 外部世界", exact: true })
      .waitFor();
    const linked = (
      await page.evaluate(() => window.toolkit.call("worlds.list"))
    ).worlds.find((w) => w.name === "外部世界");
    assert.equal(linked.path, source);
    assert.equal(linked.linkedPath, source);
    await fs.writeFile(path.join(source, "db/progress"), "EDITED_SOURCE");
    assert.equal(
      await fs.readFile(path.join(linked.path, "db/progress"), "utf8"),
      "EDITED_SOURCE",
    );
    const linkedCard = page.getByRole("article", {
      name: "存档 外部世界",
      exact: true,
    });
    await linkedCard
      .getByRole("button", { name: "打开目录", exact: true })
      .click();
    await app.evaluate(async (_, expected) => {
      for (let i = 0; i < 100 && globalThis.opened.at(-1) !== expected; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }, source);
    assert.equal((await app.evaluate(() => globalThis.opened)).at(-1), source);
    await linkedCard
      .getByRole("button", { name: "移除存档", exact: true })
      .click();
    await page.getByText(/原目录、游戏进度和模组文件保留/).waitFor();
    await page.getByRole("button", { name: "移入回收站", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.evaluate(
      (id) => window.toolkit.call("worlds.restore", { worldId: id }),
      linked.id,
    );
    await nav("启动配置");
    await nav("存档");
    await drop(archive);
    await page
      .getByRole("dialog")
      .getByLabel("存档名称", { exact: true })
      .fill("ZIP 导入");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "开始导入", exact: true })
      .click();
    await page
      .getByRole("article", { name: "存档 ZIP 导入", exact: true })
      .waitFor();
    let worlds = await page.evaluate(() => window.toolkit.call("worlds.list"));
    const imported = worlds.worlds.find((w) => w.name === "ZIP 导入");
    assert.notEqual(imported.profileId, initial.project.id);
    const automatic = await page.evaluate(
      (id) => window.toolkit.call("project.read", { id }),
      imported.profileId,
    );
    assert.deepEqual(automatic.config.included_mod_dirs, []);
    assert.equal(automatic.config.game_executable_path, "");
    assert.match(automatic.project.name, /自动匹配/);
    assert.equal(
      (
        await page.evaluate(
          (id) => window.toolkit.call("project.read", { id }),
          initial.project.id,
        )
      ).raw,
      beforeAutomatic.raw,
    );
    assert.deepEqual(imported.embeddedPacks.behavior, [
      { pack_id: packId, version: [1, 0, 0] },
    ]);
    await page
      .getByRole("article", { name: "存档 ZIP 导入", exact: true })
      .getByText("地图模组清单：1 个行为包 · 0 个资源包（自动加载）", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await fs.readFile(path.join(imported.path, "db", "progress"), "utf8"),
      "ZIP_SAVE",
    );
    assert.equal(imported.options.keep_inventory, false);
    assert.equal(
      await fs.readFile(path.join(source, "db", "progress"), "utf8"),
      "EDITED_SOURCE",
    );
    assert.deepEqual(await fs.readFile(archive), archiveBytes);
    // The picker also accepts ZIP files and preserves an explicitly edited card name.
    await app.evaluate((_, file) => {
      globalThis.fixturePick = file;
    }, archive);
    await page.getByRole("button", { name: "导入旧存档", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("存档名称", { exact: true })
      .fill("按钮 ZIP");
    await page
      .getByRole("button", { name: "选择存档 ZIP", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("dialog")
        .getByLabel("存档名称", { exact: true })
        .inputValue(),
      "按钮 ZIP",
    );
    // Leaving to add a profile preserves the approved archive and edited name.
    const profileCount = (
      await page.evaluate(() => window.toolkit.call("profiles.list"))
    ).length;
    await page
      .getByRole("button", { name: "前去添加配置", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: "新建启动配置", exact: true })
      .waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page
      .getByRole("button", { name: "返回导入存档", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: "导入旧存档", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("存档名称", { exact: true }).inputValue(),
      "按钮 ZIP",
    );
    assert.match(
      await page
        .getByRole("combobox", { name: "使用启动配置", exact: true })
        .textContent(),
      /自动匹配/,
    );
    assert.equal(
      (await page.evaluate(() => window.toolkit.call("profiles.list"))).length,
      profileCount,
    );
    await page
      .getByRole("button", { name: "前去添加配置", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: "新建启动配置", exact: true })
      .waitFor();
    await page.getByLabel("配置名称", { exact: true }).fill("地图自定义配置");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByLabel("玩家名称", { exact: true }).fill("ImportFriend");
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page
      .getByRole("button", { name: "返回导入存档", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: "导入旧存档", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("存档名称", { exact: true }).inputValue(),
      "按钮 ZIP",
    );
    assert.match(
      await page
        .getByRole("combobox", { name: "使用启动配置", exact: true })
        .textContent(),
      /地图自定义配置/,
    );
    await page.getByText(archive, { exact: true }).waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "开始导入", exact: true })
      .click();
    await page
      .getByRole("article", { name: "存档 按钮 ZIP", exact: true })
      .waitFor();
    const customWorld = (
      await page.evaluate(() => window.toolkit.call("worlds.list"))
    ).worlds.find((w) => w.name === "按钮 ZIP");
    const custom = await page.evaluate(
      (id) => window.toolkit.call("project.read", { id }),
      customWorld.profileId,
    );
    assert.equal(custom.config.user_name, "ImportFriend");
    assert.equal(
      (await page.evaluate(() => window.toolkit.call("profiles.list"))).length,
      profileCount + 1,
    );
    assert.deepEqual(
      (await app.evaluate(() => globalThis.pickerOptions)).filters[0]
        .extensions,
      ["zip", "mcworld"],
    );
    await fs.rename(archive, archive + ".kept");
    await fs.mkdir("test-results", { recursive: true });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const shot = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        )
      )
        .toPNG()
        .toString("base64"),
    );
    await fs.writeFile(
      "test-results/world-import.png",
      Buffer.from(shot, "base64"),
    );
    assert.deepEqual(errors, []);
  } finally {
    if (app) {
      let timer;
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("import UI exit timeout")),
              20000,
            );
          }),
        ]);
      } catch (e) {
        if (app.process().exitCode === null)
          spawnSync(
            path.join(process.env.SystemRoot, "System32/taskkill.exe"),
            ["/PID", String(app.process().pid), "/T", "/F"],
            { windowsHide: true },
          );
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-import-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(
    "PASS import UI: library/profile folders, native directory and ZIP drops, cancel, picker, bytes preserved, clean exit",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
