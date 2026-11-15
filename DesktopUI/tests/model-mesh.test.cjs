const test = require("node:test");
const assert = require("node:assert/strict");
const { convertCubeToMesh, createMesh, addMeshVertex, addMeshFace, removeMeshFace, removeMeshVertex, subdivideMeshFace, setMeshFaceTexture, moveMeshVertex, setMeshVertex, removeMesh, weldPoint } = require("../shared/model-mesh.cjs");
const { assignedTextures } = require("../shared/model-materials.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");

const bones = () => [{ name: "body", pivot: [0, 0, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }];

test("a cube becomes one welded mesh and the source stays unchanged", () => {
  const source = bones();
  const next = convertCubeToMesh(source, "body", 0);
  assert.equal(source[0].cubes.length, 1);
  assert.equal(source[0].poly_mesh, undefined);
  assert.equal(next[0].cubes.length, 0);
  assert.equal(next[0].poly_mesh.positions.length, 24);
  assert.equal(next[0].poly_mesh.polys.length, 6);
  assert.equal(next[0].dgn_mesh_welds.filter(index => index === 1).length, 3);
  assert.deepEqual(weldPoint(next[0].poly_mesh, next[0].dgn_mesh_welds, 1), [4, 0, -2]);
  const east = next[0].poly_mesh.uvs[next[0].poly_mesh.polys[0][0]];
  assert.deepEqual(east, [0, 4]);
  assert.throws(() => convertCubeToMesh(next, "body", 0), /已经有网格/);
  const textured = convertCubeToMesh([{ name: "body", cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: { north: { uv: [0, 0], uv_size: [1, 1], dgn_texture: "textures/a.png" }, south: { uv: [0, 0], uv_size: [1, 1] } } }] }], "body", 0);
  assert.deepEqual(textured[0].poly_mesh.face_textures, ["", "textures/a.png"]);
  assert.throws(() => convertCubeToMesh([{ name: "body", cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: { north: { uv: [0, 0], uv_size: [1, 1], material_instance: "stone" } } }] }], "body", 0), /命名材质/);
});

test("rotated cubes bake the preview rotation and a face can be subdivided", () => {
  const turned = convertCubeToMesh([{ name: "body", cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0], rotation: [0, 90, 0] }] }], "body", 0);
  assert.deepEqual(weldPoint(turned[0].poly_mesh, turned[0].dgn_mesh_welds, 0), [1, 0, 0]);
  const quad = addMeshFace(addMeshVertex(addMeshVertex(addMeshVertex(addMeshVertex(createMesh([{ name: "body", cubes: [] }], "body"), "body", [0, 0, 0]), "body", [4, 0, 0]), "body", [4, 0, 4]), "body", [0, 0, 4]), "body", [0, 1, 2, 3]);
  const split = subdivideMeshFace(quad, "body", 0);
  assert.equal(split[0].poly_mesh.polys.length, 4);
  assert.deepEqual(weldPoint(split[0].poly_mesh, split[0].dgn_mesh_welds, 0), [0, 0, 0]);
  const center = split[0].dgn_mesh_welds.reduce((max, id) => Math.max(max, id), 0);
  assert.deepEqual(weldPoint(split[0].poly_mesh, split[0].dgn_mesh_welds, center), [2, 0, 2]);
  assert.throws(() => subdivideMeshFace(split, "body", 9), /不存在/);
});

test("subdividing a face splits the shared edge on the neighbor", () => {
  let mesh = createMesh([{ name: "body", cubes: [] }], "body");
  for (const point of [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4], [0, 2, 4], [0, 2, 0]]) mesh = addMeshVertex(mesh, "body", point);
  mesh = addMeshFace(mesh, "body", [0, 1, 2, 3]);
  mesh = addMeshFace(mesh, "body", [0, 3, 4, 5]);
  const split = subdivideMeshFace(mesh, "body", 0);
  assert.equal(split[0].poly_mesh.polys.length, 6);
  const mid = [...new Set(split[0].dgn_mesh_welds)].find(id => {
    const point = weldPoint(split[0].poly_mesh, split[0].dgn_mesh_welds, id);
    return point[0] === 0 && point[1] === 0 && point[2] === 2;
  });
  assert.equal(split[0].dgn_mesh_welds.filter(id => id === mid).length >= 2, true);
  const moved = moveMeshVertex(split, "body", mid, [1, 0, 0]);
  assert.deepEqual(weldPoint(moved[0].poly_mesh, moved[0].dgn_mesh_welds, mid), [1, 0, 2]);
  assert.equal(moved[0].dgn_mesh_welds.filter(id => id === mid).every(id => true), true);
});

test("mesh face textures survive subdivision and bbmodel", () => {
  let mesh = createMesh([{ name: "body", cubes: [] }], "body");
  for (const point of [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [0, 0, 2], [2, 0, 2]]) mesh = addMeshVertex(mesh, "body", point);
  mesh = addMeshFace(mesh, "body", [0, 1, 2, 3]);
  mesh = addMeshFace(mesh, "body", [0, 3, 4, 5]);
  mesh = setMeshFaceTexture(mesh, "body", 0, "textures/a.png");
  mesh = setMeshFaceTexture(mesh, "body", 1, "textures/b.png");
  const split = subdivideMeshFace(mesh, "body", 0);
  assert.equal(split[0].poly_mesh.face_textures.filter(path => path === "textures/a.png").length >= 4, true);
  assert.equal(split[0].poly_mesh.face_textures.includes("textures/b.png"), true);
  assert.deepEqual(assignedTextures(split), ["textures/a.png", "textures/b.png"]);
  const png = "data:image/png;base64,AAAA";
  const project = exportProject({ identifier: "geometry.meshtex", textureWidth: 16, textureHeight: 16, bones: split, textures: [{ key: "textures/a.png", source: png }, { key: "textures/b.png", source: png }] });
  assert.equal(project.meta.model_format, "bedrock_block");
  const imported = importProject(project);
  assert.equal(imported.bones[0].poly_mesh.face_textures.filter(Boolean).length, split[0].poly_mesh.face_textures.filter(Boolean).length);
});

test("moving a welded corner moves every copy and can be removed", () => {
  const created = convertCubeToMesh(bones(), "body", 0);
  const moved = moveMeshVertex(created, "body", 1, [1, 0, 0]);
  assert.deepEqual(weldPoint(moved[0].poly_mesh, moved[0].dgn_mesh_welds, 1), [5, 0, -2]);
  assert.deepEqual(weldPoint(moved[0].poly_mesh, moved[0].dgn_mesh_welds, 0), [-4, 0, -2]);
  const set = setMeshVertex(moved, "body", 1, [6, 1, -2]);
  assert.deepEqual(weldPoint(set[0].poly_mesh, set[0].dgn_mesh_welds, 1), [6, 1, -2]);
  assert.equal(removeMesh(set, "body")[0].poly_mesh, undefined);
  assert.throws(() => moveMeshVertex(created, "body", 9, [1, 0, 0]), /不存在/);
});

test("bbmodel keeps the welded mesh and rejects a cube marked as mesh", () => {
  const mesh = convertCubeToMesh(bones(), "body", 0);
  const project = exportProject({ identifier: "geometry.mesh", textureWidth: 64, textureHeight: 64, bones: mesh });
  const element = project.elements.find(item => item.type === "mesh");
  assert.equal(element.vertices["1"][0], -4);
  assert.deepEqual(element.dgn_mesh_welds.filter(index => index === 1).length, 3);
  const imported = importProject(project);
  assert.deepEqual(weldPoint(imported.bones[0].poly_mesh, imported.bones[0].dgn_mesh_welds, 1), [4, 0, -2]);
  const broken = structuredClone(project);
  broken.elements[0].type = "mesh";
  delete broken.elements[0].vertices;
  assert.throws(() => importProject(broken), /网格顶点无效/);
});

test("vertices and faces can be added and deleted without changing unrelated corners", () => {
  const empty = createMesh([{ name: "body", pivot: [0, 1, 0], cubes: [] }], "body");
  assert.equal(empty[0].poly_mesh.polys.length, 0);
  assert.throws(() => exportProject({ identifier: "geometry.empty", textureWidth: 16, textureHeight: 16, bones: empty }), /空网格/);
  let next = empty;
  for (const point of [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]) next = addMeshVertex(next, "body", point);
  const faced = addMeshFace(next, "body", [0, 1, 2, 3]);
  assert.equal(faced[0].poly_mesh.polys.length, 1);
  assert.deepEqual(weldPoint(faced[0].poly_mesh, faced[0].dgn_mesh_welds, 1), [2, 0, 0]);
  const dropped = removeMeshFace(faced, "body", 0);
  assert.equal(dropped[0].poly_mesh.polys.length, 0);
  assert.equal(dropped[0].dgn_mesh_welds.length, 4);
  const removed = removeMeshVertex(dropped, "body", 3);
  assert.equal(removed[0].dgn_mesh_welds.includes(3), false);
  const project = exportProject({ identifier: "geometry.loose", textureWidth: 16, textureHeight: 16, bones: removed });
  const imported = importProject(project);
  assert.deepEqual(weldPoint(imported.bones[0].poly_mesh, imported.bones[0].dgn_mesh_welds, 1), [2, 0, 0]);
  assert.throws(() => addMeshFace(next, "body", [0, 1]), /3 或 4/);
  assert.throws(() => createMesh(empty, "body"), /已经有网格/);
});
