const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path");
test("release WASM removes local source paths while retaining executable sections and exported functions", async () => {
  const { stripWasmDebug } = await import("../scripts/wasm-release.mjs");
  const published = await fs.readFile(
    path.join(__dirname, "../src/ui-layout.wasm"),
  );
  const leb = (n) => {
    const bytes = [];
    do {
      const b = n & 127;
      n >>>= 7;
      bytes.push(n ? b | 128 : b);
    } while (n);
    return Buffer.from(bytes);
  };
  const name = Buffer.from(".debug_line"),
    localPath = Buffer.from("C:/Users/example/build/layout.cpp");
  const payload = Buffer.concat([leb(name.length), name, localPath]);
  const original = Buffer.concat([
    published,
    Buffer.from([0]),
    leb(payload.length),
    payload,
  ]);
  const clean = stripWasmDebug(original);
  assert(clean.length < original.length);
  assert.deepEqual(clean, published);
  assert(!clean.includes(localPath));
  assert(!clean.includes(Buffer.from(".debug_")));
  assert.deepEqual(stripWasmDebug(clean), clean);
  const a = await WebAssembly.instantiate(original),
    b = await WebAssembly.instantiate(clean);
  assert.deepEqual(
    WebAssembly.Module.exports(a.module),
    WebAssembly.Module.exports(b.module),
  );
  assert.deepEqual(
    WebAssembly.Module.imports(a.module),
    WebAssembly.Module.imports(b.module),
  );
  for (const instance of [a.instance, b.instance]) {
    const k = instance.exports;
    assert.equal(k.layout(20001, 640, 360), -1);
    assert.equal(k.layout(0, 640, 360), 0);
  }
  assert.deepEqual(
    new Uint8Array(a.instance.exports.memory.buffer),
    new Uint8Array(b.instance.exports.memory.buffer),
  );
  for (const bad of [Buffer.alloc(8), original.subarray(0, 20)])
    assert.throws(() => stripWasmDebug(bad));
});
