const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const jsonc = require("jsonc-parser");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-mod-remove-ui-"));
  let app;
  try {
    const dataRoot = path.join(root, "data"),
      target = path.join(root, "remove-me"),
      keep = path.join(root, "keep-me");
    await fs.mkdir(target);
    await fs.mkdir(keep);
    await fs.writeFile(path.join(target, "keep.py"), "SOURCE");
    const store = new WorkspaceStore(dataRoot);
    await store.load();
    const profiles = new Profiles(store);
    await profiles.initialize();
    const initial = await profiles.read(store.value.projects[0].id);
    const entries = [
      path.relative(initial.project.root, target),
      { path: target.toUpperCase(), enabled: false },
      { path: keep, custom: "KEEP" },
    ];
    await profiles.save(
      initial.project.id,
      initial.revision,
      undefined,
      `{// preserve\n"included_mod_dirs":${JSON.stringify(entries)},"unknown":42}`,
    );
    const second = await profiles.create("第二套配置", initial.project.id);
    const third = await profiles.create("无关配置");
    const beforeThird = (await profiles.read(third.project.id)).raw;
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
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const nav = async (label) => {
      await page
        .locator(".sidebar")
        .getByRole("button", { name: label, exact: true })
        .click();
      await page.waitForFunction(
        () => !document.documentElement.dataset.pageAnimating,
      );
    };
    await nav("启动配置");
    const edit = () =>
      page
        .getByRole("article", { name: "启动配置 默认配置", exact: true })
        .getByRole("button", { name: "编辑配置", exact: true })
        .click();
    await edit();
    await page
      .getByRole("button", { name: "完整配置 JSON", exact: true })
      .click();
    const draft = `{// unsaved comment\n"included_mod_dirs":${JSON.stringify([...entries, target + "/./"])},"unknown":99,"user_name":"DraftPlayer"}`;
    await page
      .getByRole("textbox", { name: "完整启动配置 JSON", exact: true })
      .fill(draft);
    await nav("模组库");
    const card = page.getByRole("article", {
      name: "模组 remove-me",
      exact: true,
    });
    await card.getByRole("button", { name: "移出模组库", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    assert.equal(
      (await profiles.read(second.project.id)).config.included_mod_dirs.length,
      3,
    );
    await card.getByRole("button", { name: "移出模组库", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByText(/从所有启动配置中删除/)
      .waitFor();
    await page.getByRole("button", { name: "确认移出", exact: true }).click();
    await page.getByText(/清理 2 套启动配置中的 4 条引用/).waitFor();
    assert.equal(
      (await profiles.read(second.project.id)).config.included_mod_dirs.length,
      1,
    );
    assert.equal((await profiles.read(third.project.id)).raw, beforeThird);
    assert.equal(
      await fs.readFile(path.join(target, "keep.py"), "utf8"),
      "SOURCE",
    );
    await nav("启动配置");
    await edit();
    const text = await page
      .getByRole("textbox", { name: "完整启动配置 JSON", exact: true })
      .inputValue();
    const parsed = jsonc.parse(text);
    assert.match(text, /unsaved comment/);
    assert.equal(parsed.unknown, 99, text);
    assert.equal(parsed.user_name, "DraftPlayer");
    assert.deepEqual(parsed.included_mod_dirs, [entries[2]]);
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page
      .getByText("启动配置已保存，原文件已备份", { exact: true })
      .waitFor();
    const saved = await profiles.read(initial.project.id);
    assert.equal(jsonc.parse(saved.raw).unknown, 99);
    assert.deepEqual(saved.config.included_mod_dirs, [entries[2]]);
    await nav("模组库");
    await page
      .getByRole("button", { name: "从启动配置收录", exact: true })
      .click();
    await page.getByText(/已收录 0/).waitFor();
    assert.equal(await card.count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS mod removal UI: confirmation/cancel, all profiles, disabled duplicates, valid JSONC draft rebasing, disk files, no reimport",
    );
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-mod-remove-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
