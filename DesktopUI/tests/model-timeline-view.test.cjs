const test=require("node:test"), assert=require("node:assert/strict");
const {timelineTimeAt,timelineTicks,neighboringTime}=require("../shared/model-timeline-view.cjs");

test("timeline ruler and tracks share padding, snap absolute times and stay bounded across zoom",()=>{
  for(const width of [180,800,25600])for(const length of [0.05,1.55,10,10000]){
    for(const fraction of [0,0.1,0.35,0.5,0.8,1]){
      const actual=timelineTimeAt(6+(width-12)*fraction,width,length);
      assert.ok(Math.abs(actual-Math.round(length*fraction*20)/20)<1e-6);
    }
    assert.equal(timelineTimeAt(-50,width,length),0);
    assert.equal(timelineTimeAt(width+50,width,length),length);
  }
  assert.equal(timelineTimeAt(100,0,1),0);assert.equal(timelineTimeAt(NaN,800,1),0);
  assert.equal(timelineTimeAt(1000,800,1.03),1);
});

test("ticks remain sparse and visible for very short, fractional and long animations after scrolling",()=>{
  for(const length of [0.05,0.3,1.55,9.9,10000])for(const width of [180,800,25600]){
    const visible=Math.min(800,width);
    for(const scroll of [0,Math.max(0,width-visible)/2,Math.max(0,width-visible)]){
      const ticks=timelineTicks(length,width,scroll,visible);
      assert.ok(ticks.length>0&&ticks.length<=16);
      assert.equal(new Set(ticks.map(t=>t.time)).size,ticks.length);
      ticks.forEach(t=>{assert.ok(t.time>=0&&t.time<=length);assert.ok(Math.abs(t.x-(6+t.time/length*(width-12)))<1e-6);});
      for(let i=1;i<ticks.length;i++)assert.ok(ticks[i].x-ticks[i-1].x>=63.99);
    }
  }
  assert.deepEqual(timelineTicks(0,800),[]);assert.deepEqual(timelineTicks(1,0),[]);
});

test("previous and next navigation includes effect events, skips duplicates and respects duration",()=>{
  const times=[0,0.5,0.5,0.65,1.5,4,-1,NaN];
  assert.equal(neighboringTime(times,0.5,1,2),0.65);
  assert.equal(neighboringTime(times,0.5,-1,2),0);
  assert.equal(neighboringTime(times,1.9,1,2),2);
  assert.equal(neighboringTime(times,0,-1,2),0);
  assert.equal(neighboringTime([],0.75,1,2),2);
});
