const { normalizeBiome } = require("../src/biome-model.cjs");
const payload = (v) =>
  `__import__('json').loads(__import__('base64').b64decode('${Buffer.from(JSON.stringify(v)).toString("base64")}'))`;
const setup = (data) => [
  "import mod.server.extraServerApi as api",
  `data=${payload(data)}`,
  "player=data['playerId']",
  "if player not in api.GetPlayerList(): raise RuntimeError('Target player has left the world')",
  "factory=api.GetEngineCompFactory()",
  "dimension=factory.CreateDimension(player).GetEntityDimensionId()",
  "biome=factory.CreateBiome(api.GetLevelId())",
  "name=data['biome'].encode('utf-8')",
];
function biomeProbeCode(action, playerId) {
  return [
    "# DGN_BIOME_PROBE",
    ...setup({ biome: action.biome, playerId }),
    "import math",
    "position=factory.CreatePos(player).GetFootPos()",
    "chunk=(int(math.floor(position[0]/16)),int(math.floor(position[2]/16)))",
    "source=factory.CreateChunkSource(player)",
    "_result={'dimension':dimension,'position':position,'known':biome.GetBiomeInfo(name) is not None,'chunks':source.GetLoadedChunks(dimension),'min':source.GetChunkMinPos(chunk),'max':source.GetChunkMaxPos(chunk)}",
  ].join("\n");
}
function biomePlan(input, probe, playerId) {
  const a = normalizeBiome(input);
  if (!probe?.known) throw Error("游戏未找到该群系：" + a.biome);
  if (
    !Number.isInteger(probe.dimension) ||
    probe.dimension < 0 ||
    !Array.isArray(probe.position) ||
    probe.position.length !== 3 ||
    !probe.position.every(Number.isFinite) ||
    !Array.isArray(probe.chunks) ||
    ![probe.min, probe.max].every(
      (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isInteger),
    )
  )
    throw Error("无法读取房主位置、维度或已加载区块");
  const origin = probe.position.map(Math.floor),
    [x, , z] = origin;
  if (Math.abs(x) > 29999900 || Math.abs(z) > 29999900)
    throw Error("房主位置超出支持范围");
  // Entity-bound ChunkSource reports this player's actual dimension bounds,
  // including custom dimensions. Never assume every dimension is overworld.
  const minY = a.heightMode === "column" ? probe.min[1] : a.minY;
  const maxY = a.heightMode === "column" ? probe.max[1] : a.maxY;
  if (minY > maxY || minY < probe.min[1] || maxY > probe.max[1])
    throw Error(`指定高度超出当前维度范围（${probe.min[1]}～${probe.max[1]}）`);
  if (maxY - minY > 1023) throw Error("当前维度高度超出支持范围");
  const rows = [];
  if (a.shape === "circle") {
    for (let dz = -a.radius; dz <= a.radius; dz++) {
      const dx = Math.floor(Math.sqrt(a.radius ** 2 - dz ** 2));
      rows.push({ x1: x - dx, x2: x + dx, z1: z + dz, z2: z + dz });
    }
  } else {
    const x1 =
      a.shape === "chunk"
        ? Math.floor(x / 16) * 16
        : x - Math.floor(a.length / 2);
    const z1 =
      a.shape === "chunk"
        ? Math.floor(z / 16) * 16
        : z - Math.floor(a.width / 2);
    rows.push({
      x1,
      z1,
      x2: x1 + (a.shape === "chunk" ? 16 : a.length) - 1,
      z2: z1 + (a.shape === "chunk" ? 16 : a.width) - 1,
    });
  }
  // Merge equal circular spans, then split at chunk edges. Each native call
  // touches at most one chunk and the UI can yield between batches.
  const spans = [];
  for (const row of rows) {
    const last = spans.at(-1);
    if (
      last &&
      last.x1 === row.x1 &&
      last.x2 === row.x2 &&
      last.z2 + 1 === row.z1
    )
      last.z2 = row.z2;
    else spans.push({ ...row });
  }
  const volumes = [],
    needed = new Set(),
    loaded = new Set(probe.chunks.map((v) => v.join(",")));
  let columns = 0;
  for (const s of spans)
    for (let cx = Math.floor(s.x1 / 16); cx <= Math.floor(s.x2 / 16); cx++)
      for (let cz = Math.floor(s.z1 / 16); cz <= Math.floor(s.z2 / 16); cz++) {
        needed.add(cx + "," + cz);
        const min = [Math.max(s.x1, cx * 16), minY, Math.max(s.z1, cz * 16)];
        const max = [
          Math.min(s.x2, cx * 16 + 15),
          maxY,
          Math.min(s.z2, cz * 16 + 15),
        ];
        const count = (max[0] - min[0] + 1) * (max[2] - min[2] + 1);
        columns += count;
        volumes.push({ min, max, columns: count, chunk: [cx, cz] });
      }
  const missing = [...needed].filter((k) => !loaded.has(k));
  if (missing.length)
    throw Error(
      `范围内有 ${missing.length} 个区块未加载（如 ${missing.slice(0, 3).join("；")}），未开始修改；请靠近目标范围或缩小范围`,
    );
  return {
    biome: a.biome,
    playerId,
    dimension: probe.dimension,
    origin,
    minY,
    maxY,
    columns,
    volumes,
  };
}
function biomeBatchCode(plan, volumes) {
  return [
    "# DGN_BIOME_BATCH",
    ...setup({
      playerId: plan.playerId,
      biome: plan.biome,
      dimension: plan.dimension,
      volumes,
    }),
    "if dimension != data['dimension']: raise RuntimeError('Player dimension changed; remaining biome edits cancelled')",
    "loaded=set(tuple(p) for p in (factory.CreateChunkSource(api.GetLevelId()).GetLoadedChunks(dimension) or []))",
    "if any(tuple(v['chunk']) not in loaded for v in data['volumes']): raise RuntimeError('Target chunk unloaded; remaining biome edits cancelled')",
    "done=0",
    "for v in data['volumes']:",
    "    lo,hi=v['min'],v['max']",
    // Native volume writes expand non-aligned Y to 16-block subchunks.
    // Keep aligned slabs fast while writing boundary layers precisely.
    "    first=((lo[1]+15)//16)*16",
    "    last=((hi[1]+1)//16)*16-1",
    "    if first<=last:",
    "        if not biome.SetBiomeByVolume((lo[0],first,lo[2]),(hi[0],last,hi[2]),name,dimension): break",
    "        ys=list(range(lo[1],first))+list(range(last+1,hi[1]+1))",
    "    else: ys=range(lo[1],hi[1]+1)",
    "    if ys:",
    "        points=[(x,y,z) for x in range(lo[0],hi[0]+1) for z in range(lo[2],hi[2]+1) for y in ys]",
    "        if not biome.SetBiomeByPosList(points,name,dimension)['Update']: break",
    "    done+=1",
    "_result={'ok':done==len(data['volumes']),'completed':done}",
  ].join("\n");
}
module.exports = {
  biomeProbeCode,
  biomePlan,
  biomeBatchCode,
};
