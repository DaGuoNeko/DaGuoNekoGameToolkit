const test = require("node:test"), assert = require("node:assert/strict");
const { containsPixel, selectionBounds, moveSelection, transformPixels, transformSelectedPixels, connectedPixels, paintMasked, lassoSelection } = require("../shared/paint-selection.cjs");

const image = () => ({ width: 3, height: 2, data: new Uint8ClampedArray([1, 10, 20, 0, 2, 11, 21, 64, 3, 12, 22, 128, 4, 13, 23, 192, 5, 14, 24, 254, 6, 15, 25, 255]) });
const ids = value => Array.from(value.data).filter((_, i) => i % 4 === 0);

test("rectangular rotations and flips preserve every RGBA channel without interpolation", () => {
  const source = image(), before = source.data.slice();
  assert.deepEqual(ids(transformPixels(source, "flipX")), [3, 2, 1, 6, 5, 4]);
  assert.deepEqual(ids(transformPixels(source, "flipY")), [4, 5, 6, 1, 2, 3]);
  const rotated = transformPixels(source, "rotate");
  assert.equal(rotated.width, 2); assert.equal(rotated.height, 3); assert.deepEqual(ids(rotated), [4, 1, 5, 2, 6, 3]);
  for (const operation of ["flipX", "flipY", "rotate"]) {
    const result = transformPixels(source, operation);
    for (let i = 0; i < result.data.length; i += 4) {
      const original = (result.data[i] - 1) * 4;
      assert.deepEqual(result.data.slice(i, i + 4), source.data.slice(original, original + 4));
    }
  }
  assert.deepEqual(source.data, before);
});

test("irregular mask transforms follow the same pixel mapping and never use alpha as membership", () => {
  const source = { ...image(), mask: Uint8Array.from([1, 0, 1, 1, 1, 0]) };
  const original = structuredClone(source);
  assert.deepEqual([...transformPixels(source, "flipX").mask], [1, 0, 1, 0, 1, 1]);
  assert.deepEqual([...transformPixels(source, "flipY").mask], [1, 1, 0, 1, 0, 1]);
  const rotated = transformPixels(source, "rotate");
  assert.deepEqual([...rotated.mask], [1, 1, 1, 0, 0, 1]);
  assert.equal(rotated.data[7], 0, "透明的已选像素仍参与变换");
  for (const action of ["flipX", "flipY"]) assert.deepEqual(transformPixels(transformPixels(source, action), action), source);
  let restored = source;
  for (let i = 0; i < 4; i++) restored = transformPixels(restored, "rotate");
  assert.deepEqual(restored, source);
  assert.deepEqual(transformPixels(transformPixels(source, "scale2"), "scaleHalf"), source);
  assert.deepEqual(source, original);
});

test("irregular transformations clear only the source mask and preserve background in target holes", () => {
  const source = { width: 5, height: 4, data: new Uint8ClampedArray(5 * 4 * 4).fill(255) };
  const set = (x, y, color) => source.data.set(color, (y * 5 + x) * 4);
  set(1, 1, [0, 0, 0, 0]); set(2, 1, [0, 255, 0, 255]);
  set(1, 2, [255, 0, 0, 128]); set(2, 2, [0, 0, 255, 255]);
  const selection = { x: 1, y: 1, w: 2, h: 2, mask: Uint8Array.from([1, 0, 1, 1]) };
  const before = structuredClone(source);
  const changed = transformSelectedPixels(source, selection, "flipX");
  const pixel = (x, y) => [...changed.data.subarray((y * 5 + x) * 4, (y * 5 + x + 1) * 4)];
  assert.deepEqual(pixel(1, 1), [0, 0, 0, 0], "原选中像素被清除");
  assert.deepEqual(pixel(2, 1), [0, 0, 0, 0], "透明的选中像素覆盖目标");
  assert.deepEqual(pixel(1, 2), [0, 0, 255, 255]); assert.deepEqual(pixel(2, 2), [255, 0, 0, 128]);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) if (x < 1 || x > 2 || y < 1 || y > 2) assert.deepEqual(pixel(x, y), [255, 255, 255, 255]);
  const grown = transformSelectedPixels(source, { ...selection, x: 0, y: 0 }, "scale2");
  assert.equal(grown.selection.w, 4); assert.equal(grown.selection.h, 4);
  assert.deepEqual([...grown.data.subarray(3 * 4, 4 * 4)], [255, 255, 255, 255], "放大后孔洞不覆盖新区域的背景");
  assert.deepEqual(source, before);
});

test("bad masks, empty downsampling and overflowing targets fail without clearing pixels", () => {
  const source = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) };
  for (const mask of [[], [1, 0, 1], [1, 2, 0, 1], [0, 0, 0, 0], {}, "1001"]) {
    assert.throws(() => transformPixels({ ...source, mask }, "rotate"), /遮罩/);
  }
  const selection = { x: 0, y: 0, w: 2, h: 2, mask: Uint8Array.from([0, 1, 1, 1]) };
  assert.throws(() => transformSelectedPixels(source, selection, "scaleHalf"), /没有像素/);
  assert.throws(() => transformSelectedPixels(source, selection, "scale2"), /范围/);
  assert.deepEqual([...source.data], Array(16).fill(255));
  const thin = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(17) };
  assert.throws(() => transformSelectedPixels(thin, { x: 3, y: 0, w: 1, h: 3, mask: Uint8Array.from([1, 0, 1]) }, "rotate"), /范围/);
  assert.deepEqual([...thin.data], Array(64).fill(17));
});

test("45-degree nearest-neighbor rotation fills the footprint without projecting holes or mixing colors", () => {
  const source = { width: 3, height: 3, data: Uint8ClampedArray.from(Array.from({ length: 9 }, (_, i) => [i + 1, 20, 40, i * 30]).flat()) };
  const rotated = transformPixels(source, { type: "rotateAngle", angle: 45 });
  assert.equal(rotated.width, 5); assert.equal(rotated.height, 5);
  const mapping = [0,0,1,0,0, 0,4,1,2,0, 7,7,5,3,3, 0,8,9,6,0, 0,0,9,0,0];
  assert.deepEqual(ids(rotated), mapping);
  assert.deepEqual([...rotated.mask], mapping.map(value => value ? 1 : 0));
  for (let i = 0; i < mapping.length; i++) if (mapping[i]) assert.deepEqual(rotated.data.slice(i * 4, i * 4 + 4), source.data.slice((mapping[i] - 1) * 4, mapping[i] * 4));
  const masked = transformPixels({ ...source, mask: Uint8Array.from([1,1,1,1,0,1,1,1,1]) }, { type: "rotateAngle", angle: 45 });
  assert.equal(masked.mask[12], 0, "孔洞不变成透明的选中像素");
  assert.equal(masked.mask[2], 1); assert.equal(masked.data[11], 0, "透明像素仍被选中");
});

test("custom quarter turns match exact transforms; signed and full turns preserve all RGBA and masks", () => {
  for (const source of [image(), { ...image(), width: 1, height: 6 }, { ...image(), mask: Uint8Array.from([1,0,1,1,1,0]) }]) {
    let expected = source;
    for (const angle of [90, 180, 270, 360]) {
      expected = transformPixels(expected, "rotate");
      assert.deepEqual(transformPixels(source, { type: "rotateAngle", angle }), expected);
      assert.deepEqual(transformPixels(source, { type: "rotateAngle", angle: angle - 360 || -360 }), expected);
    }
  }
  const tiny = { width: 1, height: 1, data: Uint8ClampedArray.from([1,2,3,0]) };
  assert.throws(() => transformPixels(tiny, { type: "rotateAngle", angle: 45 }), /没有像素/, "采样不到像素时整次拒绝");
});

test("custom rotation preserves destination corners and refuses invalid or overflowing results atomically", () => {
  const data = new Uint8ClampedArray(8 * 8 * 4).fill(255), selection = { x: 2, y: 2, w: 3, h: 3 };
  for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) data.set([200,0,0,128], (y * 8 + x) * 4);
  data.set([0,0,0,0], (2 * 8 + 2) * 4);
  const image = { width: 8, height: 8, data }, before = data.slice();
  const rotated = transformSelectedPixels(image, selection, { type: "rotateAngle", angle: 45 });
  assert.deepEqual({ ...rotated.selection, mask: undefined }, { x: 2, y: 2, w: 5, h: 5, mask: undefined });
  assert.deepEqual([...rotated.data.slice((6 * 8 + 6) * 4, (6 * 8 + 7) * 4)], [255,255,255,255], "外接框新增边角保留目标背景");
  assert.deepEqual([...rotated.data.slice((2 * 8 + 4) * 4, (2 * 8 + 5) * 4)], [0,0,0,0], "选中的透明像素覆盖原目标");
  assert.equal(rotated.selection.mask[2], 1);
  for (const angle of [0, 361, -361, Infinity, NaN, "", "45", null, true]) assert.throws(() => transformSelectedPixels(image, selection, { type: "rotateAngle", angle }), /角度/);
  assert.throws(() => transformPixels(image, null), /变换/);
  assert.throws(() => transformSelectedPixels(image, { ...selection, x: 5 }, { type: "rotateAngle", angle: 45 }), /范围/);
  assert.throws(() => transformPixels({ width: 2048, height: 2048, data: new Uint8ClampedArray(2048 * 2048 * 4) }, { type: "rotateAngle", angle: 45 }), /范围/);
  assert.deepEqual(data, before);
  const decimal = transformSelectedPixels(image, selection, { type: "rotateAngle", angle: -22.5 });
  assert.ok(decimal.selection.mask.some(value => value === 1));
});

test("custom dimensions resample independent axes and keep mask membership separate from RGBA", () => {
  const source = { ...image(), mask: Uint8Array.from([1,0,1,1,1,0]) }, before = structuredClone(source);
  const resized = transformPixels(source, { type: "resize", width: 5, height: 3 });
  assert.equal(resized.width, 5); assert.equal(resized.height, 3);
  const mapping = [1,1,2,2,3, 1,1,2,2,3, 4,4,5,5,6];
  assert.deepEqual(ids(resized), mapping);
  assert.deepEqual([...resized.mask], mapping.map(id => source.mask[id - 1]));
  for (let i = 0; i < mapping.length; i++) assert.deepEqual(resized.data.slice(i * 4, i * 4 + 4), source.data.slice((mapping[i] - 1) * 4, mapping[i] * 4));
  assert.deepEqual(ids(transformPixels(source, { type: "resize", width: 2, height: 1 })), [1,2], "奇数宽度允许自定缩小，沿用左上对齐的最近邻采样");
  assert.deepEqual(transformPixels(source, { type: "resize", width: 3, height: 2 }), source);
  assert.deepEqual(transformPixels(source, { type: "resize", width: 6, height: 4 }), transformPixels(source, "scale2"));
  const enlarged = transformPixels(source, "scale2");
  assert.deepEqual(transformPixels(enlarged, { type: "resize", width: 3, height: 2 }), transformPixels(enlarged, "scaleHalf"));
  const single = { width: 1, height: 1, data: Uint8ClampedArray.from([13,17,19,0]) };
  assert.deepEqual(ids(transformPixels(single, { type: "resize", width: 2048, height: 1 })), Array(2048).fill(13));
  assert.deepEqual(source, before);
});

test("resized selections replace selected pixels only, clear old coverage and preserve destination holes", () => {
  const image = { width: 8, height: 6, data: new Uint8ClampedArray(8 * 6 * 4).fill(255) };
  image.data.set([0,0,0,0], (1 * 8 + 1) * 4);
  image.data.set([100,20,30,128], (2 * 8 + 1) * 4);
  const selection = { x: 1, y: 1, w: 3, h: 2, mask: Uint8Array.from([1,0,0,1,1,1]) };
  const before = image.data.slice();
  const grown = transformSelectedPixels(image, selection, { type: "resize", width: 5, height: 4 });
  const pixel = (x, y) => [...grown.data.slice((y * 8 + x) * 4, (y * 8 + x + 1) * 4)];
  assert.deepEqual(pixel(2, 1), [0,0,0,0], "透明的选中像素覆盖目标");
  assert.deepEqual(pixel(5, 1), [255,255,255,255], "目标孔洞保留背景");
  assert.deepEqual(pixel(2, 3), [100,20,30,128]);
  assert.deepEqual(pixel(7, 5), [255,255,255,255]);
  assert.equal(grown.selection.mask[4], 0);
  const shrunk = transformSelectedPixels(image, selection, { type: "resize", width: 1, height: 1 });
  assert.deepEqual([...shrunk.data.slice((2 * 8 + 3) * 4, (2 * 8 + 4) * 4)], [0,0,0,0], "缩小后旧选区多余像素清除");
  assert.deepEqual(image.data, before);
});

test("invalid dimensions, empty resized masks and edge overflow fail before clearing the source", () => {
  const source = { ...image(), mask: Uint8Array.from([0,1,1,1,1,1]) }, before = structuredClone(source);
  for (const value of [0,-1,1.5,2049,NaN,Infinity,"3",null,undefined,true]) {
    assert.throws(() => transformPixels(source, { type: "resize", width: value, height: 2 }), /宽高/);
    assert.throws(() => transformPixels(source, { type: "resize", width: 3, height: value }), /宽高/);
  }
  assert.throws(() => transformPixels(source, { type: "resize", width: 1, height: 1 }), /没有像素/);
  const full = { width: 8, height: 8, data: new Uint8ClampedArray(256).fill(99) };
  assert.throws(() => transformSelectedPixels(full, { x: 7, y: 5, w: 1, h: 2 }, { type: "resize", width: 2, height: 3 }), /范围/);
  assert.deepEqual(source, before); assert.ok(full.data.every(value => value === 99));
});

test("four rotations and two flips restore non-square images and single-pixel axes", () => {
  for (const source of [image(), { width: 1, height: 6, data: image().data }, { width: 6, height: 1, data: image().data }]) {
    let result = source;
    for (let i = 0; i < 4; i++) result = transformPixels(result, "rotate");
    assert.deepEqual(result, source);
    for (const action of ["flipX", "flipY"]) assert.deepEqual(transformPixels(transformPixels(source, action), action), source);
  }
});

test("movement clamps the whole selection, while invalid or overflowing rectangles are rejected", () => {
  const rect = { x: 3, y: 4, w: 6, h: 5 };
  assert.deepEqual(moveSelection(rect, 100, -100, 16, 16), { x: 10, y: 0, w: 6, h: 5 });
  assert.deepEqual(rect, { x: 3, y: 4, w: 6, h: 5 });
  assert.throws(() => selectionBounds({ x: 15, y: 0, w: 2, h: 1 }, 16, 16), /范围/);
  assert.throws(() => moveSelection(rect, 0.5, 0, 16, 16), /整数/);
  assert.throws(() => selectionBounds({ ...rect, h: 0 }, 16, 16));
  assert.throws(() => transformPixels({ ...image(), data: new Uint8Array(2) }, "rotate"));
  assert.throws(() => transformPixels(image(), "invalid"));
  assert.throws(() => transformPixels({ width: 2049, height: 1, data: [] }, "flipX"));
  const pixel = { width: 1, height: 1, data: Uint8ClampedArray.from([9, 8, 7, 6]) };
  const grown = transformPixels(pixel, "scale2");
  assert.equal(grown.width, 2); assert.equal(grown.height, 2);
  assert.deepEqual(grown.data, Uint8ClampedArray.from([9, 8, 7, 6, 9, 8, 7, 6, 9, 8, 7, 6, 9, 8, 7, 6]));
  assert.deepEqual(transformPixels(grown, "scaleHalf"), pixel);
  assert.throws(() => transformPixels(pixel, "scaleHalf"), /偶数/);
  assert.throws(() => transformPixels({ width: 1025, height: 1, data: new Uint8ClampedArray(1025 * 4) }, "scale2"), /范围/);
});

test("selection clipping includes left/top and excludes right/bottom, with no mask when deselected", () => {
  const rect = { x: 2, y: 3, w: 4, h: 5 };
  assert.equal(containsPixel(rect, 2, 3), true); assert.equal(containsPixel(rect, 5, 7), true);
  for (const [x, y] of [[1, 3], [2, 2], [6, 4], [4, 8]]) assert.equal(containsPixel(rect, x, y), false);
  assert.equal(containsPixel(null, 100, 100), true);
});

test("magic wand keeps only four-connected pixels of the same color", () => {
  const data = new Uint8ClampedArray(4 * 3 * 4);
  const set = (x, y, color) => data.set(color, (y * 4 + x) * 4);
  const red = [8, 0, 0, 255], blue = [0, 0, 8, 255];
  for (let index = 0; index < 12; index++) data.set(blue, index * 4);
  set(0, 0, red); set(1, 0, red); set(0, 1, red); set(2, 1, red);
  const image = { width: 4, height: 3, data };
  const shape = connectedPixels(image, 0, 0);
  assert.equal(shape.count, 3);
  assert.equal(containsPixel(shape, 0, 1), true);
  assert.equal(containsPixel(shape, 1, 1), false);
  assert.equal(connectedPixels(image, 2, 1).count, 1);
  assert.equal(connectedPixels(image, 0, 0, { x: 0, y: 0, w: 1, h: 2 }).count, 2);
  assert.throws(() => connectedPixels(image, 3, 2, { x: 0, y: 0, w: 1, h: 1 }), /选区/);
  const solid = connectedPixels({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(7) }, 1, 1);
  assert.equal(solid.mask, undefined);
  assert.equal(solid.count, 4);
  const cleared = paintMasked(image, shape, "clear");
  assert.deepEqual([cleared.data[0], cleared.data[4], cleared.data[8]], [0, 0, 0]);
});

test("lasso selects pixel centers inside the closed outline", () => {
  const region = lassoSelection([[0, 0], [4, 0], [4, 4], [0, 4]], 5, 5);
  assert.equal(region.count, 16);
  assert.equal(containsPixel(region, 3, 3), true);
  assert.equal(containsPixel(region, 4, 0), false);
  assert.equal(containsPixel(region, 4, 4), false);
  const triangle = lassoSelection([[0, 0], [4, 0], [0, 4]], 5, 5);
  assert.equal(containsPixel(triangle, 0, 0), true);
  assert.equal(containsPixel(triangle, 3, 3), false);
  assert.equal(lassoSelection([[0, 0], [4, 0], [4, 4], [0, 4]], 5, 5, { x: 0, y: 0, w: 1, h: 5 }).count, 4);
  assert.throws(() => lassoSelection([[0, 0], [1, 0]], 5, 5), /3 个点/);
});
