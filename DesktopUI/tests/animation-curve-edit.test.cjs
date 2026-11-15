const test=require("node:test"),assert=require("node:assert/strict");
const {moveCurveKey,insertCurveKey,deleteCurveKey,trackOf,sampleTrack}=require("../src/features/skins/npc-clip.cjs");
const {exportProject,importProject}=require("../electron/domains/profiles/bbmodel-codec.cjs");
const fixture=()=>({animation_length:2,loop:false,bones:{body:{rotation:{"0":[0,0,0],"1.000":{pre:[3,4,5],post:[10,20.123456,30],lerp_mode:"catmullrom",note:"keep"},"2":[20,40,60]},position:[1,2,3]},arm:{scale:2}},sound_effects:{"0.50":{effect:"test.click"}}});

test("curve drag commits one axis and time atomically while preserving raw metadata, incoming values and other axes",()=>{
  const source=fixture(),before=structuredClone(source),frame=source.bones.body.rotation["1.000"];
  const same=moveCurveKey(source,"body","rotation",1,1,0,12.34567);
  assert.deepEqual(Object.keys(same.bones.body.rotation),["0","2","1.000"]);
  assert.deepEqual(same.bones.body.rotation["1.000"],{...frame,post:[12.346,20.123456,30]});
  const moved=moveCurveKey(source,"body","rotation",1,1.25,2,-8);
  assert.equal(moved.bones.body.rotation["1.000"],undefined);assert.deepEqual(moved.bones.body.rotation["1.25"],{...frame,post:[10,20.123456,-8]});
  assert.strictEqual(moved.sound_effects,source.sound_effects);assert.strictEqual(moved.bones.arm,source.bones.arm);assert.deepEqual(source,before);
  assert.strictEqual(moveCurveKey(source,"body","rotation",1,1,0,10),source);
  for(const args of [[1,2,0,9],[0.5,1.25,0,8],[1,-0.05,0,9],[1,1.25,0,Infinity],[1,1.25,0,1e6+1],[1,1.25,9,3]])assert.throws(()=>moveCurveKey(source,"body","rotation",...args));
  const duplicate=fixture();duplicate.bones.body.rotation["1.0"]=[1,1,1];assert.throws(()=>moveCurveKey(duplicate,"body","rotation",1,1.25,0,2),/重复/);
});

test("curve insertion samples all axes, preserves constants and rejects existing or ambiguous timestamps",()=>{
  const source=fixture(),before=structuredClone(source),expected=sampleTrack(trackOf(source.bones.body.rotation),0.5).map(n=>Math.round(n*1000)/1000);
  const inserted=insertCurveKey(source,"body","rotation",0.5);assert.deepEqual(inserted.bones.body.rotation["0.50"],expected);assert.deepEqual(source,before);
  const constant=insertCurveKey(source,"body","position",0.5);assert.deepEqual(constant.bones.body.position,{"0.00":[1,2,3],"0.50":[1,2,3]});
  const empty=insertCurveKey(source,"body","scale",0.5);assert.deepEqual(empty.bones.body.scale["0.50"],[1,1,1]);
  for(const time of [1,0.001,-1,Infinity])assert.throws(()=>insertCurveKey(source,"body","rotation",time));
  const scalar=moveCurveKey(source,"arm","scale",0,0,1,3);assert.deepEqual(scalar.bones.arm.scale["0.00"],[2,3,2]);
  assert.equal(deleteCurveKey(source,"arm","scale",0).bones.arm,undefined);
  assert.throws(()=>deleteCurveKey(source,"arm","scale",0.5));
  const large=fixture();large.bones.body.rotation=Object.fromEntries(Array.from({length:10000},(_,i)=>[i,[0,0,0]]));assert.throws(()=>insertCurveKey(large,"body","rotation",0.5),/10000/);
});

test("manual graph edits invalidate only the affected baked controls and protect Molang and stale deletion",()=>{
  const source=fixture();source.dgn_bezier=[{bone:"body",channel:"rotation",axis:0,from:0,to:1,control:[0,0,1,1]},{bone:"arm",channel:"scale",axis:1,from:0,to:1,control:[0,0,1,1]}];
  for(const next of [moveCurveKey(source,"body","rotation",1,1.25,0,11),insertCurveKey(source,"body","rotation",0.5),deleteCurveKey(source,"body","rotation",1)])assert.deepEqual(next.dgn_bezier,[source.dgn_bezier[1]]);
  assert.equal(source.dgn_bezier.length,2);assert.throws(()=>deleteCurveKey(source,"body","rotation",0.5),/变化/);
  const expression=fixture();expression.bones.body.rotation["1.000"].post[0]="q.anim_time";
  for(const fn of [()=>moveCurveKey(expression,"body","rotation",1,1.25,0,12),()=>insertCurveKey(expression,"body","rotation",0.5),()=>deleteCurveKey(expression,"body","rotation",1)])assert.throws(fn,/Molang/);
});

test("edited graph survives project exchange with the same key times and playback",()=>{
  let source=fixture();source=moveCurveKey(source,"body","rotation",1,1.25,0,15);source=insertCurveKey(source,"body","rotation",0.5);source=deleteCurveKey(source,"body","rotation",0);
  const project=exportProject({identifier:"geometry.curve",bones:[{name:"body",cubes:[]},{name:"arm",cubes:[]}],textureWidth:64,textureHeight:64,animations:{"animation.curve":source}});
  const back=importProject(project).animations["animation.curve"];
  for(const time of [0,0.5,0.75,1.25,1.9])assert.deepEqual(sampleTrack(trackOf(back.bones.body.rotation),time),sampleTrack(trackOf(source.bones.body.rotation),time));
});
