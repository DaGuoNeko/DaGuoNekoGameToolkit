const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { buildScene } = require("../src/ui-document.cjs"),
  { withEngineTree, enginePath } = require("../src/ui-runtime-tree.cjs");
const { EditorEngine } = require("../electron/editor-engine.cjs"),
  { UiDocuments } = require("../electron/ui-editor.cjs");
test("engine tree exposes inherited nodes read-only and preserves source write paths", () => {
  const source = buildScene(
    '{"namespace":"x","main":{"type":"screen","controls":[{"own":{"type":"label","text":"draft"}}]}}',
  );
  const tree = {
    UIHeader: { mCurrent: "main" },
    main: {
      type: "screen",
      controls: [
        { own: { type: "label" } },
        {
          inherited: {
            type: "panel",
            controls: [{ nested: { type: "image" } }],
          },
        },
      ],
    },
  };
  const scene = withEngineTree(source, tree);
  assert.equal(scene.nodes.length, 4);
  assert.deepEqual(scene.nodes[1].path, ["main", "controls", 0, "own"]);
  assert.equal(scene.nodes[1].value.text, "draft");
  assert.equal(scene.nodes[2].path, null);
  assert.equal(scene.nodes[3].path, null);
  assert.equal(
    enginePath(scene.nodes, scene.nodes[3]),
    "/main/inherited/nested",
  );
  assert.equal(source.nodes.length, 2);
});
test("preview resources copy to a private world; source files and other worlds remain unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-preview-"));
  const previous = process.env.APPDATA;
  try {
    process.env.APPDATA = path.join(root, "roaming");
    const pack = path.join(root, "project");
    await fs.mkdir(path.join(pack, "ui"), { recursive: true });
    await fs.mkdir(path.join(pack, "textures"));
    await fs.writeFile(
      path.join(pack, "manifest.json"),
      JSON.stringify({ modules: [{ type: "resources" }] }),
    );
    await fs.writeFile(
      path.join(pack, "textures", "icon.png"),
      "texture fixture",
    );
    await fs.writeFile(
      path.join(pack, "ui", "_global_variables.json"),
      '{"$icon":"textures/icon"}',
    );
    const file = path.join(pack, "ui", "screen.json"),
      raw = '// keep\n{"namespace":"x","main":{"type":"screen"}}';
    await fs.writeFile(file, raw);
    const docs = new UiDocuments(root),
      doc = await docs.open(file),
      engine = new EditorEngine(root, root, docs);
    engine.run = path.join(root, "run");
    await fs.mkdir(engine.run);
    engine.documentId = doc.id;
    engine.uiSource = file;
    engine.worldName = "DGN_UI_PREVIEW_fixture";
    engine.worldId = "fixture-id";
    engine.worldDir = path.join(
      process.env.APPDATA,
      "MinecraftPE_Netease_Editor",
      "minecraftWorlds",
      engine.worldId,
    );
    await fs.mkdir(engine.worldDir, { recursive: true });
    await fs.writeFile(
      path.join(engine.worldDir, "levelname.txt"),
      engine.worldName,
    );
    await engine.stage(raw, true);
    assert.equal(await fs.readFile(file, "utf8"), raw);
    assert.equal(
      await fs.readFile(
        path.join(
          engine.worldDir,
          "resource_packs/dgn_preview/textures/icon.png",
        ),
        "utf8",
      ),
      "texture fixture",
    );
    assert.equal(
      await fs.readFile(
        path.join(engine.worldDir, "world_behavior_packs.json"),
        "utf8",
      ),
      "[]",
    );
    assert.equal(await engine.ownedWorld(), engine.worldDir);
    await fs.writeFile(
      path.join(engine.worldDir, "levelname.txt"),
      "user world",
    );
    await assert.rejects(engine.ownedWorld(), /归属/);
    engine.worldId = "../escape";
    await assert.rejects(engine.ownedWorld(), /标识/);
  } finally {
    process.env.APPDATA = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
