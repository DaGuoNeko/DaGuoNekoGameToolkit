const fs = require("node:fs/promises");
const path = require("node:path");

const key = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
function identity(stat, type) {
  return [String(stat.dev), String(stat.ino), String(stat.birthtimeNs), type,
    ...(type === "file" ? [String(stat.size),String(stat.mtimeNs),String(stat.ctimeNs)] : [])].join(":");
}
async function inspectSelection(file, type) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw Error("所选路径无效");
  const stat = await fs.lstat(file, {bigint:true});
  const actualType = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  const real = await fs.realpath(file);
  if (stat.isSymbolicLink() || actualType === "other" || (type && actualType !== type) || key(real) !== key(file)) throw Error("所选路径是链接或类型发生变化，请重新选择");
  return { path:path.resolve(file), real, type:actualType, identity:identity(stat,actualType) };
}
async function verifySelection(record) {
  const current = await inspectSelection(record.path,record.type);
  if (current.identity !== record.identity || key(current.real) !== key(record.real)) throw Error("所选文件或目录已变化，请重新选择");
  return current;
}
class FileSelections {
  constructor({ttlMs=30*60*1000,maxEntries=256,now=()=>Date.now()}={}) {
    Object.assign(this,{ttlMs,maxEntries,now}); this.entries=new Map(); this.savedImage=null;
    this.timer=setInterval(()=>this.prune(),60000); this.timer.unref();
  }
  prune() {
    for(const [id,entry] of this.entries) if(entry.expires<=this.now()) this.entries.delete(id);
  }
  async allow(file,kind) {
    if(!["directory","archive","image","chunker"].includes(kind))throw Error("选择用途无效");
    if(kind==="archive"&&!/\.(zip|mcworld)$/i.test(file)||kind==="chunker"&&!/\.jar$/i.test(file)||kind==="image"&&!/\.(png|jpe?g|webp|bmp|gif)$/i.test(file))throw Error("所选文件类型不支持");
    const record=await inspectSelection(file,kind==="directory"?"directory":"file");
    this.prune();
    const id=kind+":"+key(file); this.entries.delete(id);
    while(this.entries.size>=this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(id,{...record,kind,expires:this.now()+this.ttlMs});
    if(kind==="image"&&this.savedImage&&key(file)===key(this.savedImage.path))this.savedImage=record;
    return record;
  }
  async require(file,kinds,{consume=false}={}) {
    this.prune();
    if(typeof file!=="string") throw Error("请先选择文件或目录");
    for(const kind of [].concat(kinds)) {
      const id=kind+":"+key(file),entry=this.entries.get(id);
      if(!entry) continue;
      try { await verifySelection(entry); } catch(e) {this.entries.delete(id);throw e;}
      if(consume) this.entries.delete(id);
      return entry;
    }
    throw Error("选择已过期或尚未授权，请重新选择文件或目录");
  }
  async setSavedImage(file) {
    if(!file) {this.savedImage=null;return;}
    if(this.savedImage && key(this.savedImage.path)===key(file)) return;
    const selected=this.entries.get("image:"+key(file));
    this.savedImage=await (selected?verifySelection(selected):inspectSelection(file,"file")).catch(()=>null);
  }
  async readImage(file,maxBytes=20*1024**2) {
    const record=this.savedImage && typeof file==="string" && key(this.savedImage.path)===key(file)
      ? this.savedImage : await this.require(file,"image");
    await verifySelection(record);
    const handle=await fs.open(record.path,"r");
    try {
      const before=await handle.stat({bigint:true});
      if(!before.isFile() || before.size>BigInt(maxBytes) || identity(before,"file")!==record.identity) throw Error("图片已变化或超过读取上限");
      const bytes=Buffer.alloc(Number(before.size)); let offset=0;
      while(offset<bytes.length) { const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset); if(!bytesRead) throw Error("图片在读取时变化");offset+=bytesRead; }
      if(identity(await handle.stat({bigint:true}),"file")!==record.identity) throw Error("图片在读取时变化");
      await verifySelection(record);
      return bytes;
    } finally {await handle.close();}
  }
  dispose(){clearInterval(this.timer);this.entries.clear();this.savedImage=null;}
}
module.exports={FileSelections,inspectSelection,verifySelection};
