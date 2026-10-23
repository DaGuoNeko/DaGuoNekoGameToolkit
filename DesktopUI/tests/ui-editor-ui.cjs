const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-ui-editor-"));
  let app;
  try {
    const file = path.join(root, "screen.json"),
      out = path.join(root, "copy.json");
    const raw =
      "// original comment\n" +
      JSON.stringify(
        {
          namespace: "test",
          main: {
            type: "screen",
            controls: [
              {
                box: {
                  type: "panel",
                  size: [200, 120],
                  unknown: "keep",
                  controls: [
                    {
                      title: {
                        type: "label",
                        text: "测试标题",
                        size: [100, 20],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        null,
        2,
      );
    await fs.writeFile(file, raw);
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
      args: process.env.DGN_GAME_TEST_EXE ? [] : ["."],
      env: {
        ...process.env,
        DGN_GAME_HEADLESS: "1",
        DGN_GAME_DATA_DIR: path.join(root, "data"),
      },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await app.evaluate(
      ({ dialog, BrowserWindow }, v) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [v.file],
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: v.out,
        });
        BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
          false,
        );
      },
      { file, out },
    );
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    const nav = async (name) => {
      await page
        .locator(".sidebar")
        .getByRole("button", { name, exact: true })
        .click();
      await page.waitForFunction(
        () => !document.documentElement.dataset.pageAnimating,
      );
    };
    await nav("UI 编辑器");
    await page
      .getByRole("button", { name: "打开 UI 文件", exact: true })
      .click();
    await page.locator(".ue-tree-name").filter({ hasText: "box" }).click();
    await page.getByLabel("尺寸", { exact: true }).fill("[240,140]");
    await page.getByLabel("尺寸", { exact: true }).press("Enter");
    assert.equal(
      await page.getByLabel("尺寸", { exact: true }).inputValue(),
      "[240,140]",
    );
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('input[aria-label="尺寸"]')?.value ===
        "[200,120]",
    );
    assert.equal(
      await page.getByLabel("尺寸", { exact: true }).inputValue(),
      "[200,120]",
    );
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("已保存，修改前文件已备份", { exact: true }).waitFor();
    const saved = await fs.readFile(file, "utf8");
    assert.ok(saved.includes("// original comment"));
    assert.ok(saved.includes('"unknown": "keep"'));
    assert.match(saved, /240/);
    const box = await page.getByLabel("UI 画布", { exact: true }).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 30);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 30,
      box.y + box.height / 2 + 50,
      { steps: 6 },
    );
    await page.mouse.up();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.locator(".ue-tree-name").filter({ hasText: "box" }).click();
    await page.getByLabel("偏移", { exact: true }).fill("[10,");
    await page.getByLabel("偏移", { exact: true }).press("Tab");
    await nav("运行日志");
    await nav("UI 编辑器");
    assert.equal(
      await page.getByLabel("偏移", { exact: true }).inputValue(),
      "[10,",
    );
    await page
      .getByRole("button", { name: "取消属性草稿", exact: true })
      .click();
    await page.getByRole("button", { name: "另存为", exact: true }).click();
    await page
      .getByText("已另存；新界面需要在资源包 _ui_defs.json 中登记", {
        exact: true,
      })
      .waitFor();
    assert.ok((await fs.readFile(out, "utf8")).includes("// original comment"));
    await page.getByRole("button", { name: "文件源码", exact: true }).click();
    const large = JSON.stringify({
      namespace: "perf",
      main: {
        type: "screen",
        controls: Array.from({ length: 5000 }, (_, i) => ({
          ["node" + i]: {
            type: "panel",
            size: [8, 8],
            offset: [i % 640, i % 360],
          },
        })),
      },
    });
    await page.getByLabel("UI 源码草稿").fill(large);
    await page.getByRole("button", { name: "应用草稿", exact: true }).click();
    await page.getByText(/5001 节点/).waitFor();
    assert.ok(
      (await page.getByRole("treeitem").count()) < 40,
      "tree is virtualized",
    );
    assert.deepEqual(errors, []);
    assert.equal(
      await page.locator(".ue-canvas-error").count(),
      0,
      "native kernel loaded",
    );
    await fs.mkdir("test-results", { recursive: true });
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.locator(".ue-tree-name").filter({ hasText: "box" }).click();
    const screenshot = await app.evaluate(async ({ BrowserWindow }) =>
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
      "test-results/ui-editor.png",
      Buffer.from(screenshot, "base64"),
    );
    await app.evaluate(({ app }) => app.quit());
    await app.close();
    app = null;
    console.log(
      "PASS UI editor: C++ canvas, property edit/undo/save, preserved fields, draft handoff, 5000-node virtual tree, clean exit",
    );
  } finally {
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
