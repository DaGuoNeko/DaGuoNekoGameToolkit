const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const {
  parseDocument,
  edit,
  buildScene,
  changeNode,
} = require("../src/ui-document.cjs");
const { UiDocuments } = require("../electron/ui-editor.cjs");
const raw =
  '\uFEFF{\r\n // 保留注释\r\n "namespace":"test", "main":{"type":"screen","unknown":42,"controls":[{"box":{"type":"panel","size":[100,40]}}]},\r\n}\r\n';
test("JsonUI edits preserve BOM, comments, unknown fields and structural undo inputs", () => {
  const result = edit(raw, ["main", "controls", 0, "box", "offset"], [10, 20]);
  assert.ok(result.startsWith("\uFEFF"));
  assert.ok(result.includes("// 保留注释"));
  assert.ok(result.includes("\r\n"));
  assert.equal(parseDocument(result).main.unknown, 42);
  const duplicate = changeNode(
    result,
    ["main", "controls", 0, "box"],
    "duplicate",
  );
  assert.equal(parseDocument(duplicate).main.controls.length, 2);
  const renamed = changeNode(
    duplicate,
    ["main", "controls", 1, "box_copy"],
    "rename",
    "renamed",
  );
  assert.ok(parseDocument(renamed).main.controls[1].renamed);
  assert.equal(
    parseDocument(changeNode(renamed, ["main", "controls", 0, "box"], "delete"))
      .main.controls.length,
    1,
  );
});
test("inheritance, static variables, missing definitions and inherited children stay distinct from editable source", () => {
  const data = {
    namespace: "x",
    main: { type: "screen", controls: [{ "use@common.base": { $w: 60 } }] },
  };
  const scene = buildScene(JSON.stringify(data), [
    {
      data: {
        namespace: "common",
        base: {
          type: "panel",
          size: ["$w", 30],
          controls: [{ inherited: { type: "label", text: "ok" } }],
        },
      },
    },
  ]);
  assert.deepEqual(scene.nodes[1].value.size, [60, 30]);
  assert.equal(scene.nodes[2].path, null);
  assert.equal(scene.inputs[20], 60);
  assert.throws(
    () =>
      changeNode(JSON.stringify(data), null, "property", {
        key: "size",
        value: [1, 2],
      }),
    /继承/,
  );
  assert.ok(buildScene('{"namespace":"x","a@missing.a":{}}').warnings.length);
});
test("C++ WASM geometry: anchors, visibility, hit order and bounded input", async () => {
  const { instance } = await WebAssembly.instantiate(
    await fs.readFile(path.join(__dirname, "../src/ui-layout.wasm")),
  );
  const k = instance.exports;
  const scene = buildScene(
    JSON.stringify({
      namespace: "x",
      main: {
        type: "screen",
        controls: [
          {
            box: {
              type: "panel",
              size: [100, 40],
              offset: [10, 20],
              controls: [{ label: { type: "label", size: [10, 10] } }],
            },
          },
        ],
      },
    }),
  );
  new Float32Array(k.memory.buffer, k.input_ptr(), scene.inputs.length).set(
    scene.inputs,
  );
  assert.equal(k.layout(scene.nodes.length, 640, 360), 3);
  const out = new Float32Array(k.memory.buffer, k.output_ptr(), 33);
  assert.deepEqual([...out.slice(11, 15)], [280, 180, 100, 40]);
  assert.equal(k.hit(330, 200), 2);
  assert.equal(k.layout(20001, 640, 360), -1);
  const hidden = scene.inputs.slice();
  hidden[18 + 13] = 0;
  new Float32Array(k.memory.buffer, k.input_ptr(), hidden.length).set(hidden);
  k.layout(3, 640, 360);
  assert.equal(k.hit(330, 200), 0);
});
test("document save detects external changes, backs up exact original and refuses unapproved or existing save-as paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-editor-test-"));
  try {
    const file = path.join(root, "screen.json");
    await fs.writeFile(file, raw);
    const docs = new UiDocuments(path.join(root, "data")),
      doc = await docs.open(file);
    const changed = edit(raw, ["main", "visible"], false);
    const saved = await docs.save({
      id: doc.id,
      revision: doc.revision,
      raw: changed,
    });
    assert.equal(await fs.readFile(saved.backup, "utf8"), raw);
    await fs.writeFile(file, raw + " ");
    await assert.rejects(
      docs.save({ id: doc.id, revision: saved.revision, raw: changed }),
      /其他程序/,
    );
    assert.equal(await fs.readFile(file, "utf8"), raw + " ");
    await assert.rejects(
      docs.save({ id: "foreign", revision: "", raw: changed }),
      /授权/,
    );
    await assert.rejects(docs.create(file, changed), { code: "EEXIST" });
    await assert.rejects(docs.texture(doc.id, "textures/../../secret"), /路径/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
