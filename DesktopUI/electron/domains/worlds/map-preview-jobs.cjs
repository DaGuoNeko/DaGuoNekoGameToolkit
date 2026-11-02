const fs=require("node:fs/promises"),path=require("node:path");
const {Worker}=require("node:worker_threads");
const {inspectSelection,verifySelection}=require("../../file-selection.cjs");

class MapPreviewJobs {
  constructor(dataRoot,workerFile,{timeoutMs=120000,memoryMb=768}={}) {
    Object.assign(this,{dataRoot,workerFile,timeoutMs,memoryMb}); this.active=null; this.closed=false;
  }
  state(id) { const j=this.active; return j && j.id===id ? {id:j.id,...j.progress} : null; }
  render(id,args,resolveSource) {
    if(this.closed||this.active) throw Error("已有地图正在加载，请先取消或等待完成");
    if(typeof id!=="string"||!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error("地图请求标识无效");
    const job={id,cancelled:false,progress:{stage:"准备地图",completed:0,total:null}};
    this.active=job;
    job.promise=(async()=>{
      let directory;
      try {
        if(resolveSource) args={...args,...await resolveSource()};
        if(job.cancelled) throw Error("地图加载已取消");
        const identity=args.identity||await inspectSelection(args.source);
        const base=path.join(this.dataRoot,"map-preview-jobs");
        await fs.mkdir(base,{recursive:true});
        await inspectSelection(base,"directory");
        directory=await fs.mkdtemp(path.join(base,"job-"));
        await verifySelection(identity);
        if(job.cancelled) throw Error("地图加载已取消");
        return await new Promise((resolve,reject)=>{
          const worker=new Worker(this.workerFile,{workerData:{args:{...args,dataRoot:directory},identity},resourceLimits:{maxOldGenerationSizeMb:this.memoryMb,maxYoungGenerationSizeMb:64,stackSizeMb:4}});
          let settled=false,timer;
          const finish=(error,result)=>{
            if(settled)return;settled=true;clearTimeout(timer);
            worker.terminate().then(()=>error?reject(error):resolve(result),reject);
          };
          job.abort=()=>finish(Error("地图加载已取消"));
          timer=setTimeout(()=>finish(Error("地图加载超时，请降低区块上限后重试")),this.timeoutMs);
          worker.on("message",message=>{
            if(message.progress) job.progress=message.progress;
            else if(message.error) finish(Error(message.error));
            else if(message.result) finish(null,message.result);
          });
          worker.on("error",error=>finish(Error(error.code==="ERR_WORKER_OUT_OF_MEMORY"?"地图加载超过内存预算，请降低区块上限":error.message)));
          worker.on("exit",code=>{if(!settled)finish(Error("地图后台任务意外结束（"+code+"）"));});
          if(job.cancelled) job.abort();
        });
      } finally {
        try { if(directory) {
          const base=path.resolve(this.dataRoot,"map-preview-jobs");
          if(path.dirname(directory)!==base||!path.basename(directory).startsWith("job-")) throw Error("地图临时目录边界无效");
          await inspectSelection(directory,"directory");
          await fs.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
        } } finally {if(this.active===job)this.active=null;}
      }
    })();
    return job.promise;
  }
  async cancel(id) {
    const job=this.active;if(!job||job.id!==id)return false;
    job.cancelled=true;job.abort?.();await job.promise.catch(()=>{});return true;
  }
  async dispose(){this.closed=true;if(this.active)await this.cancel(this.active.id);}
}
module.exports={MapPreviewJobs};
