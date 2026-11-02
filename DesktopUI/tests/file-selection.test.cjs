const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {FileSelections}=require("../electron/file-selection.cjs");

test("file selection approvals expire, are bounded, and reject replacement/link swaps",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dgn-selection-")); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let now=0;const selections=new FileSelections({ttlMs:100,maxEntries:2,now:()=>now});
  const one=path.join(root,"one.png"),two=path.join(root,"two.png"),three=path.join(root,"three.png");
  await fs.writeFile(one,"one");await fs.writeFile(two,"two");await fs.writeFile(three,"three");
  await selections.allow(one,"image");await selections.require(one,"image");
  now=101;await assert.rejects(selections.require(one,"image"),/过期/);
  await selections.allow(one,"image");await selections.allow(two,"image");await selections.allow(three,"image");
  await assert.rejects(selections.require(one,"image"),/过期/);
  await selections.allow(two,"image");await fs.rename(two,two+".old");await fs.writeFile(two,"replacement");
  await assert.rejects(selections.require(two,"image"),/变化/);
  const directory=path.join(root,"original"),other=path.join(root,"other"),link=path.join(root,"link");
  await fs.mkdir(directory);await fs.mkdir(other);
  await selections.allow(directory,"directory");
  await fs.rename(directory,directory+".old");
  await fs.symlink(other,directory,"junction");
  await assert.rejects(selections.require(directory,"directory"),/链接/);
  await fs.symlink(other,link,"junction");
  await assert.rejects(selections.allow(link,"directory"),/链接/);
  selections.dispose();
});

test("image reads verify opened file identity; saved image survives expiry but cannot be replaced",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dgn-selection-image-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,"a.png");await fs.writeFile(file,Buffer.from([1,2,3]));
  let now=0;const selections=new FileSelections({ttlMs:10,now:()=>now});t.after(()=>selections.dispose());
  await selections.allow(file,"image");await selections.setSavedImage(file);now=100;
  assert.deepEqual(await selections.readImage(file),Buffer.from([1,2,3]));
  await assert.rejects(selections.readImage(file,1),/上限/);
  await fs.rename(file,file+".old");await fs.writeFile(file,Buffer.from([4,5,6]));
  await assert.rejects(selections.readImage(file),/变化/);
  await selections.allow(file,"image");
  assert.deepEqual(await selections.readImage(file),Buffer.from([4,5,6]),"explicit re-selection replaces saved image identity");
});
