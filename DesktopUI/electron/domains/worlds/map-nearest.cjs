// 仅保留距离中心最近的 K 个区块；堆顶为最远项，避免为整个世界建立对象索引。
class NearestChunks {
  constructor(limit, center) { this.limit=limit; this.center=center; this.heap=[]; this.byId=new Map(); this.truncated=false; }
  distance(x,z) { return Math.max(Math.abs(x-this.center[0]),Math.abs(z-this.center[1])); }
  compare(a,b) { return a.distance-b.distance || a.z-b.z || a.x-b.x; }
  swap(i,j) { [this.heap[i],this.heap[j]]=[this.heap[j],this.heap[i]]; }
  get full() { return this.heap.length===this.limit; }
  get farthest() { return this.full ? this.heap[0].distance : Infinity; }
  add(id,x,z,create) {
    if(this.byId.has(id)) return this.byId.get(id);
    const candidate={x,z,distance:this.distance(x,z)};
    if(this.full) {
      this.truncated=true;
      if(this.compare(candidate,this.heap[0])>=0) return null;
    }
    const entry={...candidate,id,...create()};
    if(!this.full) {
      this.heap.push(entry); this.byId.set(id,entry);
      for(let i=this.heap.length-1;i>0;) { const parent=(i-1)>>1;if(this.compare(this.heap[i],this.heap[parent])<=0)break;this.swap(i,parent);i=parent; }
    } else {
      this.byId.delete(this.heap[0].id);this.heap[0]=entry;this.byId.set(id,entry);
      for(let i=0;;) { let next=i,left=i*2+1,right=left+1;
        if(left<this.heap.length&&this.compare(this.heap[left],this.heap[next])>0)next=left;
        if(right<this.heap.length&&this.compare(this.heap[right],this.heap[next])>0)next=right;
        if(next===i)break;this.swap(i,next);i=next;
      }
    }
    return entry;
  }
  sorted() { return [...this.heap].sort((a,b)=>this.compare(a,b)); }
}
module.exports={NearestChunks};
