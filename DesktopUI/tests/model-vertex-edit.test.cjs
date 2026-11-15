const test=require("node:test"),assert=require("node:assert/strict");
const {buildSync}=require("esbuild"),fs=require("node:fs"),path=require("node:path");
const {cubeVertices,defaultVertices,setCubeVertices}=require("../shared/model-vertex-edit.cjs");
const {moveCubeGeometry,resizeCubeGeometry}=require("../shared/model-vertex-edit.cjs");
const {moveVertex,moveVertices,setVertexComponent,transformVertices,faceCorners,mirrorVertices}=require("../shared/model-vertex-edit.cjs");
const {extrudeCubeFace}=require("../shared/model-vertex-edit.cjs");
const {pushFace,insetFace}=require("../shared/model-vertex-edit.cjs");
const {splitCube}=require("../shared/model-vertex-edit.cjs");
const {inflateCubeVertices}=require("../shared/model-vertex-edit.cjs");
const {exportProject,importProject}=require("../electron/domains/profiles/bbmodel-codec.cjs");
const {transformSelection,mirrorSelection}=require("../shared/model-edit.cjs");
const {artifactPath}=require("./fixtures/artifacts.cjs");
const bones=()=>[{name:"body",pivot:[0,0,0],cubes:[{origin:[-4,0,-2],size:[8,12,4],uv:[0,0],extension:true}]}];

test("cube vertex defaults are immutable and restore to ordinary origin/size storage",()=>{
  const source=bones(),before=structuredClone(source),vertices=cubeVertices(source[0].cubes[0]);
  assert.deepEqual(vertices[0],[-4,0,-2]);assert.deepEqual(vertices[6],[4,12,2]);
  const changed=structuredClone(vertices);changed[0][0]=-5;const next=setCubeVertices(source,"body",0,changed);
  assert.equal(next[0].cubes[0].dgn_vertices[0][0],-5);assert.deepEqual(source,before);
  const restored=setCubeVertices(next,"body",0,defaultVertices(source[0].cubes[0]));assert.equal(restored[0].cubes[0].dgn_vertices,undefined);assert.deepEqual(restored,source);
  for(const bad of [[],Array(7).fill([0,0,0]),Array(8).fill([0,0,Infinity]),Array(8).fill([1000001,0,0])])assert.throws(()=>setCubeVertices(source,"body",0,bad),/顶点/);
});

test("custom cube vertices render as 24 face vertices and survive the restricted bbmodel roundtrip",()=>{
  const root=artifactPath("build"),entry=path.resolve(__dirname,"../src/features/skins/npc-model-view.jsx"),out=path.join(root,"vertex-model.cjs");fs.mkdirSync(root,{recursive:true});
  buildSync({entryPoints:[entry],bundle:true,platform:"node",format:"cjs",outfile:out,logLevel:"silent"});
  const {buildModel}=require(out);
  const source=bones(),vertices=cubeVertices(source[0].cubes[0]);vertices[0]=[-5,0,-2];source[0].cubes[0].dgn_vertices=vertices;
  const built=buildModel({tw:64,th:64,bones:source});assert.equal(built.meshes[0].geometry.getAttribute("position").count,24);assert.equal(built.meshes[0].geometry.groups.length,6);
  const grownCube=source[0].cubes[0]; grownCube.inflate=1; const grown=buildModel({tw:64,th:64,bones:source});
  const xs=[...grown.meshes[0].geometry.getAttribute("position").array].filter((_,index)=>index%3===0);
  assert.ok(xs.some(value=>Math.abs(value-(-6/16))<1e-5)); grownCube.inflate=0;
  source[0].cubes[0].size=[0,12,4];const flat=buildModel({tw:64,th:64,bones:source});assert.equal(flat.meshes.length,1);
  for(const mesh of built.meshes){mesh.geometry.dispose();mesh.material.dispose?.();}
  for(const mesh of flat.meshes){mesh.geometry.dispose();mesh.material.dispose?.();}
  for(const mesh of grown.meshes){mesh.geometry.dispose();mesh.material.dispose?.();}
  const project=exportProject({identifier:"geometry.vertex",bones:source,textureWidth:64,textureHeight:64,texture:""});
  const returned=importProject(project);assert.deepEqual(returned.bones[0].cubes[0].dgn_vertices,vertices);
});

test("stored custom vertices follow cube translation and mirroring",()=>{
  const source=bones(),vertices=cubeVertices(source[0].cubes[0]);vertices[0]=[-5,0,-2];source[0].cubes[0].dgn_vertices=vertices;
  const moved=transformSelection(source,{bone:"body",cube:0},"move",[1,2,0]);
  assert.deepEqual(moved[0].cubes[0].dgn_vertices[0],[-4,2,-2]);assert.deepEqual(moved[0].cubes[0].origin,[-3,2,-2]);
  const mirrored=mirrorSelection(moved,[{bone:"body",cube:0}],0).bones;
  assert.deepEqual(mirrored[0].cubes[1].dgn_vertices[0],[4,2,-2]);
});

test("origin, size and scale move custom vertices around the same anchors as the cube",()=>{
  const cube={origin:[-4,0,-2],size:[8,12,4],pivot:[0,6,0],dgn_vertices:cubeVertices({origin:[-4,0,-2],size:[8,12,4]})};
  cube.dgn_vertices[0]=[-5,0,-2];
  const moved=moveCubeGeometry(cube,[0,2,-2]);
  assert.deepEqual(moved.origin,[0,2,-2]);assert.deepEqual(moved.dgn_vertices[0],[-1,2,-2]);assert.equal(moved.pivot[0],0);
  const plain={origin:[-4,0,-2],size:[8,12,4]};plain.dgn_vertices=cubeVertices(plain);
  const resized=resizeCubeGeometry(plain,[16,12,4]);
  assert.equal(resized.dgn_vertices,undefined);assert.deepEqual(resized.size,[16,12,4]);
  const deformed=resizeCubeGeometry(cube,[16,12,4]);
  assert.deepEqual(deformed.dgn_vertices[0],[-6,0,-2]);assert.deepEqual(deformed.origin,[-4,0,-2]);
  const source=[{name:"body",pivot:[0,0,0],cubes:[cube]}];
  const scaled=transformSelection(source,{bone:"body",cube:0},"scale",[8,0,0]);
  assert.deepEqual(scaled[0].cubes[0].origin,[-8,0,-2]);assert.deepEqual(scaled[0].cubes[0].size,[16,12,4]);assert.deepEqual(scaled[0].cubes[0].dgn_vertices[0],[-10,0,-2]);
  assert.throws(()=>resizeCubeGeometry({...cube,size:[0,12,4]},[8,12,4]),/0/);
});

test("moving one stored vertex keeps the other corners and clears the field when restored",()=>{
  const source=bones(),before=structuredClone(source);
  const moved=moveVertex(source,"body",0,0,[1,0,0]);
  assert.deepEqual(source,before);assert.equal(moved[0].cubes[0].dgn_vertices[0][0],-3);assert.deepEqual(moved[0].cubes[0].dgn_vertices[6],[4,12,2]);
  const restored=moveVertex(moved,"body",0,0,[-1,0,0]);
  assert.equal(restored[0].cubes[0].dgn_vertices,undefined);
  assert.throws(()=>moveVertex(source,"body",0,8,[0,0,0]),/顶点/);
});

test("selected vertices move together and a shared component can be assigned",()=>{
  const source=bones();
  const moved=moveVertices(source,"body",0,[0,6,0],[1,0,0]);
  assert.equal(moved[0].cubes[0].dgn_vertices[0][0],-3);assert.equal(moved[0].cubes[0].dgn_vertices[6][0],5);assert.equal(moved[0].cubes[0].dgn_vertices[1][0],4);
  const changed=setVertexComponent(moved,"body",0,[0,6],1,3);
  assert.equal(changed[0].cubes[0].dgn_vertices[0][1],3);assert.equal(changed[0].cubes[0].dgn_vertices[6][1],3);assert.equal(changed[0].cubes[0].dgn_vertices[1][1],0);
  assert.throws(()=>moveVertices(source,"body",0,[],[1,0,0]),/顶点/);
});

test("selected vertices rotate and scale around their own center",()=>{
  const source=bones();
  const rotated=transformVertices(source,"body",0,[0,1],"rotate",[0,90,0]);
  assert.deepEqual(rotated[0].cubes[0].dgn_vertices[0],[0,0,2]);assert.deepEqual(rotated[0].cubes[0].dgn_vertices[1],[0,0,-6]);assert.equal(rotated[0].cubes[0].dgn_vertices[2][0],4);
  const scaled=transformVertices(source,"body",0,[0,1],"scale",[4,0,0]);
  assert.equal(scaled[0].cubes[0].dgn_vertices[0][0],-8);assert.equal(scaled[0].cubes[0].dgn_vertices[1][0],8);assert.equal(scaled[0].cubes[0].dgn_vertices[2][0],4);
  assert.throws(()=>transformVertices(source,"body",0,[0],"scale",[1,0,0]),/跨度/);
});

test("cube faces use four corners and mirroring flips only the selected vertices",()=>{
  for (const index of [0,1,2,3,4,5,6,7]) assert.equal(Object.values(faceCorners).filter(face => face.includes(index)).length,3);
  assert.deepEqual(faceCorners.north,[0,1,2,3]);
  const moved=moveVertex(bones(),"body",0,0,[1,0,0]);
  const flipped=mirrorVertices(moved,"body",0,[0,1],0);
  assert.equal(flipped[0].cubes[0].dgn_vertices[0][0],4);assert.equal(flipped[0].cubes[0].dgn_vertices[1][0],-3);assert.equal(flipped[0].cubes[0].dgn_vertices[2][0],4);
  assert.throws(()=>mirrorVertices(moved,"body",0,[0],3),/轴/);
});

test("extruding a box face adds a flush cube and a deformed cube keeps the same shift",()=>{
  const source=bones(), before=structuredClone(source);
  const north=extrudeCubeFace(source,"body",0,"north");
  assert.deepEqual(source,before); assert.equal(north[0].cubes.length,2);
  assert.deepEqual(north[0].cubes[1].origin,[-4,0,-6]); assert.deepEqual(north[0].cubes[1].size,[8,12,4]); assert.equal(north[0].cubes[1].dgn_vertices,undefined); assert.equal(north[0].cubes[1].uv[0],0);
  const east=extrudeCubeFace(source,"body",0,"east"); assert.deepEqual(east[0].cubes[1].origin,[4,0,-2]);
  const custom=structuredClone(source); custom[0].cubes[0].dgn_vertices=cubeVertices(custom[0].cubes[0]); custom[0].cubes[0].dgn_vertices[6][0]=5;
  const extruded=extrudeCubeFace(custom,"body",0,"north");
  assert.equal(extruded[0].cubes[1].dgn_vertices[0][2],-6); assert.equal(extruded[0].cubes[1].dgn_vertices[4][2],-2);
  assert.throws(()=>extrudeCubeFace(source,"body",0,"bad"),/面/);
});

test("pushing a face grows the box outward and inset stops at the face center",()=>{
  const source=bones(), before=structuredClone(source);
  const pushed=pushFace(source,"body",0,"north",1);
  assert.deepEqual(source,before); assert.deepEqual(pushed[0].cubes[0].origin,[-4,0,-3]); assert.deepEqual(pushed[0].cubes[0].size,[8,12,5]); assert.equal(pushed[0].cubes[0].dgn_vertices,undefined);
  const inward=pushFace(source,"body",0,"north",-1); assert.deepEqual(inward[0].cubes[0].origin,[-4,0,-1]); assert.deepEqual(inward[0].cubes[0].size,[8,12,3]);
  const shrunk=insetFace(source,"body",0,"north",100);
  assert.deepEqual(shrunk[0].cubes[0].dgn_vertices[0],[0,6,-2]); assert.equal(shrunk[0].cubes[0].dgn_vertices[4][2],2);
  assert.throws(()=>pushFace(source,"body",0,"north",0),/距离/); assert.throws(()=>insetFace(source,"body",0,"north",0),/距离/);
});

test("splitting a cube along an axis keeps the outer corners and shares the cut",()=>{
  const source=bones(), before=structuredClone(source);
  const split=splitCube(source,"body",0,0,2);
  assert.deepEqual(source,before); assert.equal(split[0].cubes.length,2);
  assert.deepEqual(split[0].cubes[0].origin,[-4,0,-2]); assert.deepEqual(split[0].cubes[0].size,[4,12,4]);
  assert.deepEqual(split[0].cubes[1].origin,[0,0,-2]); assert.deepEqual(split[0].cubes[1].size,[4,12,4]);
  assert.equal(split[0].cubes[0].dgn_vertices,undefined); assert.equal(split[0].cubes[0].uv[0],0);
  const custom=structuredClone(source); custom[0].cubes[0].dgn_vertices=cubeVertices(custom[0].cubes[0]); custom[0].cubes[0].dgn_vertices[1][1]=3;
  const parts=splitCube(custom,"body",0,0,2);
  assert.equal(parts[0].cubes[0].dgn_vertices[1][1],1.5); assert.equal(parts[0].cubes[1].dgn_vertices[0][1],1.5); assert.equal(parts[0].cubes[1].dgn_vertices[1][1],3);
  assert.throws(()=>splitCube(source,"body",0,1,1),/段数/); assert.throws(()=>splitCube([{name:"flat",cubes:[{origin:[0,0,0],size:[0,2,2],uv:[0,0]}]}],"flat",0,0,2),/厚度/);
});

test("inflate pushes custom corners away from the box center without changing stored vertices",()=>{
  const cube={origin:[0,0,0],size:[8,8,8],inflate:1}; cube.dgn_vertices=cubeVertices(cube); cube.dgn_vertices[0]=[1,4,0];
  const inflated=inflateCubeVertices(cube);
  assert.deepEqual(inflated[0],[0,4,-1]); assert.deepEqual(inflated[6],[9,9,9]); assert.equal(cube.dgn_vertices[0][0],1);
  assert.deepEqual(inflateCubeVertices({...cube,inflate:-1})[6],[7,7,7]);
});
