const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AssertionTracker}=require('../electron/domains/automation/assertion-tracker.cjs');
test('multiple simultaneous dialogs, reorder and repeated reads never inflate counts',()=>{
  const t=new AssertionTracker(),b={connectionGeneration:1,minecraftPid:42};
  const a={id:'one',text:'fixture warning',ignore:{enabled:true}},c={id:'two',text:'another warning',ignore:{enabled:true}};
  const read=items=>t.observe('s',b,{processCreatedAt:'100',assertions:items});
  const first=read([a,c]);
  for(let i=0;i<4;i++)for(const x of read(i%2?[a,c]:[c,a]))assert.equal(x.occurrenceCount,1);
  assert.equal(read([a,c])[0].id,first[0].id);
  read([]);const next=read([a]);assert.equal(next[0].occurrenceCount,2);assert.notEqual(next[0].id,first[0].id);
  assert.equal(t.reserve('s',next[0].id),'one');assert.throws(()=>t.reserve('s',next[0].id),/ATTEMPTED/);
  assert.equal(read([a])[0].canIgnore,false);
  b.connectionGeneration=2;const reset=read([a]);assert.equal(reset[0].occurrenceCount,1);assert(reset[0].canIgnore);
  assert.throws(()=>t.reserve('s',next[0].id),/CHANGED/);
});
test('different sessions, changed processes and disabled parent dialogs stay isolated',()=>{
  const t=new AssertionTracker(),b={connectionGeneration:1,minecraftPid:42};
  const native={processCreatedAt:'100',assertions:[{id:'one',text:'same',enabled:false,ignore:{enabled:true}}]};
  const a=t.observe('a',b,native)[0],c=t.observe('b',b,native)[0];assert.notEqual(a.id,c.id);assert.equal(a.canIgnore,false);
  native.processCreatedAt='101';assert.equal(t.observe('a',b,native)[0].occurrenceCount,1);
  t.forget('a');assert.throws(()=>t.reserve('a',a.id),/CHANGED/);
});
