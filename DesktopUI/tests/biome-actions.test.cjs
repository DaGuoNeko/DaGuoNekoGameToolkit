const test = require("node:test"),
  assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { normalizeBiome } = require("../shared/biome-model.cjs");
const {
  biomePlan,
  biomeProbeCode,
  biomeBatchCode,
} = require("../electron/domains/worlds/biome-actions.cjs");
const base = {
  biome: "minecraft:desert",
  shape: "chunk",
  heightMode: "column",
};
const probe = (position = [-0.1, 72.5, -16.1], dimension = 0) => ({
  known: true,
  position,
  dimension,
  min: [0, dimension === 1 ? 0 : -64, 0],
  max: [15, dimension === 1 ? 127 : 319, 15],
  chunks: Array.from({ length: 81 }, (_, i) => [
    (i % 9) - 4,
    Math.floor(i / 9) - 4,
  ]),
});
function cells(plan) {
  const values = new Set();
  for (const { min, max } of plan.volumes) {
    assert.equal(Math.floor(min[0] / 16), Math.floor(max[0] / 16));
    assert.equal(Math.floor(min[2] / 16), Math.floor(max[2] / 16));
    for (let x = min[0]; x <= max[0]; x++)
      for (let z = min[2]; z <= max[2]; z++) {
        const key = x + "," + z;
        assert.ok(!values.has(key), "volumes must not overlap");
        values.add(key);
      }
  }
  assert.equal(values.size, plan.columns);
  return values;
}
test("biome geometry uses floor for negative coordinates, exact rectangle sizes and circular membership", () => {
  const chunk = biomePlan(base, probe(), "-123");
  assert.deepEqual(chunk.origin, [-1, 72, -17]);
  assert.equal(chunk.columns, 256);
  assert.ok(cells(chunk).has("-16,-32"));
  assert.ok(cells(chunk).has("-1,-17"));
  for (const radius of [0, 1, 8, 32]) {
    const p = biomePlan(
      { ...base, shape: "circle", radius },
      probe([0.4, 64, 0.9]),
      "-123",
    );
    const actual = cells(p),
      expected = new Set();
    for (let x = -radius; x <= radius; x++)
      for (let z = -radius; z <= radius; z++)
        if (x * x + z * z <= radius * radius) expected.add(x + "," + z);
    assert.deepEqual(actual, expected);
  }
  for (const [length, width] of [
    [1, 1],
    [4, 3],
    [64, 64],
  ]) {
    const p = biomePlan(
      { ...base, shape: "rectangle", length, width },
      probe([0, 64, 0]),
      "-123",
    );
    const actual = cells(p);
    assert.equal(actual.size, length * width);
    assert.ok(
      actual.has(`${-Math.floor(length / 2)},${-Math.floor(width / 2)}`),
    );
    assert.ok(!actual.has(`${length - Math.floor(length / 2)},0`));
  }
});
test("biome input rejects invalid IDs/ranges and preflight prevents unloaded or unknown targets", () => {
  for (const bad of [
    { biome: "evil'\n" },
    { shape: "all" },
    { heightMode: "?" },
    { shape: "circle", radius: 33 },
    { shape: "circle", radius: 0.5 },
    { shape: "rectangle", length: 0, width: 1 },
    { heightMode: "range", minY: 10, maxY: 9 },
    { heightMode: "range", minY: -65, maxY: 319 },
  ])
    assert.throws(() => normalizeBiome({ ...base, ...bad }));
  assert.throws(
    () => biomePlan(base, { ...probe(), chunks: [] }, "-123"),
    /未加载/,
  );
  assert.throws(
    () => biomePlan(base, { ...probe(), known: false }, "-123"),
    /未找到/,
  );
  assert.throws(
    () =>
      biomePlan(
        { ...base, heightMode: "range", minY: 128, maxY: 129 },
        probe([0, 64, 0], 1),
        "-123",
      ),
    /超出当前维度/,
  );
  const custom = biomePlan(
    { ...base, heightMode: "range", minY: 30, maxY: 40 },
    probe([0, 36, 0], 23333),
    "-123",
  );
  assert.equal(custom.dimension, 23333);
  assert.deepEqual(custom.volumes[0].min, [0, 30, 0]);
});
test("generated Python uses actual player dimension, rejects changed/unloaded worlds and reports partial native failure", () => {
  const plan = biomePlan(
    { ...base, shape: "rectangle", length: 4, width: 4 },
    probe([0, 64, 0], 3),
    "-123",
  );
  const sources = [
    biomeProbeCode(base, "-123"),
    biomeBatchCode(plan, plan.volumes.slice(0, 2)),
  ];
  const script = `import sys,json,types
sources=json.load(sys.stdin)
api=types.ModuleType('mod.server.extraServerApi')
mod=types.ModuleType('mod');server=types.ModuleType('mod.server')
mod.server=server;server.extraServerApi=api
sys.modules.update({'mod':mod,'mod.server':server,'mod.server.extraServerApi':api})
dimension=3;loaded=[(-1,-1),(-1,0),(0,-1),(0,0)];calls=[];fail=False
class Factory(object):
 def CreateDimension(self,p):
  assert p=='-123';return self
 def CreateBiome(self,p):return self
 def CreatePos(self,p):return self
 def CreateChunkSource(self,p):return self
 def GetEntityDimensionId(self):return dimension
 def GetFootPos(self):return (0.5,64,0.5)
 def GetLoadedChunks(self,d):
  assert d==dimension;return loaded
 def GetChunkMinPos(self,c):return (0,-64,0)
 def GetChunkMaxPos(self,c):return (15,319,15)
 def GetBiomeInfo(self,n):
  assert n==b'minecraft:desert';return {'temperature':2}
 def SetBiomeByVolume(self,a,b,n,d):
  assert d==3 and n==b'minecraft:desert'
  calls.append((a,b));return not fail or len(calls)==1
api.GetEngineCompFactory=lambda:Factory()
api.GetLevelId=lambda:'level'
api.GetPlayerList=lambda:['-123']
ns={};exec(compile(sources[0],'probe','exec'),ns)
assert ns['_result']['dimension']==3 and ns['_result']['known']
for invalid in ['dimension','unloaded']:
 dimension=1 if invalid=='dimension' else 3
 loaded=[] if invalid=='unloaded' else [(-1,-1),(-1,0),(0,-1),(0,0)]
 try:
  exec(compile(sources[1],'batch','exec'),{})
  raise AssertionError('invalid mutation accepted')
 except RuntimeError:pass
 assert calls==[]
dimension=3;loaded=[(-1,-1),(-1,0),(0,-1),(0,0)];fail=True
ns={};exec(compile(sources[1],'batch','exec'),ns)
assert ns['_result']=={'ok':False,'completed':1}
print('ok')
`;
  const r = spawnSync("python", ["-c", script], {
    input: JSON.stringify(sources),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
});

test("height ranges use point lists at non-aligned edges instead of expanding the requested layers", () => {
  const plan = biomePlan(
    {
      ...base,
      shape: "rectangle",
      length: 1,
      width: 1,
      heightMode: "range",
      minY: 82,
      maxY: 130,
    },
    probe([1, 85, 1]),
    "-123",
  );
  const source = biomeBatchCode(plan, plan.volumes);
  const script = `import sys,json,types
source=json.load(sys.stdin);api=types.ModuleType('mod.server.extraServerApi')
mod=types.ModuleType('mod');server=types.ModuleType('mod.server');mod.server=server;server.extraServerApi=api
sys.modules.update({'mod':mod,'mod.server':server,'mod.server.extraServerApi':api})
written=set()
class F(object):
 def CreateDimension(self,p):return self
 def CreateBiome(self,p):return self
 def CreateChunkSource(self,p):return self
 def GetEntityDimensionId(self):return 0
 def GetLoadedChunks(self,d):return [(0,0)]
 def SetBiomeByVolume(self,lo,hi,n,d):
  assert lo[1]%16==0 and hi[1]%16==15
  written.update(range(lo[1],hi[1]+1));return True
 def SetBiomeByPosList(self,points,n,d):
  written.update(p[1] for p in points);return {'Update':True,'BlockList':[]}
api.GetEngineCompFactory=lambda:F();api.GetPlayerList=lambda:['-123'];api.GetLevelId=lambda:'level'
ns={};exec(compile(source,'range','exec'),ns)
assert ns['_result']=={'ok':True,'completed':1}
assert written==set(range(82,131))
`;
  const r = spawnSync("python", ["-c", script], {
    input: JSON.stringify(source),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
});
