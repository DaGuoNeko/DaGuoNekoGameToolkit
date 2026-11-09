const fs=require("node:fs/promises"),path=require("node:path");
const {Worker}=require("node:worker_threads");
const {inspectSelection,verifySelection}=require("../../file-selection.cjs");

class MapPreviewJobs {
  constructor(dataRoot,workerFile,{timeoutMs=120000,memoryMb=768,onError=()=>{},label="地图",method="map-preview.render",cachePreview=false,cacheIdleMs=60000}={}) {
    Object.assign(this,{dataRoot,workerFile,timeoutMs,memoryMb,onError,label,method,cachePreview,cacheIdleMs}); this.active=null; this.closed=false;
    this.previewCache=null; this.cacheDirectory=null; this.cacheCleanup=Promise.resolve(); this.cacheTimer=null;
  }
  state(id) { const j=this.active; return j && j.id===id ? {id:j.id,...j.progress} : null; }
  render(id,args,resolveSource,onBatch=()=>{}) {
    if(this.closed||this.active) throw Error(`已有${this.label}正在加载，请先取消或等待完成`);
    if(typeof id!=="string"||!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error("地图请求标识无效");
    const job={id,cancelled:false,progress:{stage:"准备"+this.label,completed:0,total:null}};
    this.active=job;
    clearTimeout(this.cacheTimer);
    job.promise=(async()=>{
      let directory, failure;
      try {
        if(resolveSource) args={...args,...await resolveSource()};
        if(job.cancelled) throw Error("地图加载已取消");
        const identity=args.identity||await inspectSelection(args.source);
        const base=path.join(this.dataRoot,"map-preview-jobs");
        await fs.mkdir(base,{recursive:true});
        await inspectSelection(base,"directory");
        await this.cacheCleanup;
        if(this.cachePreview&&!this.cacheDirectory) this.cacheDirectory=await fs.mkdtemp(path.join(base,"cache-"));
        directory=await fs.mkdtemp(path.join(base,"job-"));
        await verifySelection(identity);
        if(job.cancelled) throw Error("地图加载已取消");
        return await new Promise((resolve,reject)=>{
          const worker=new Worker(this.workerFile,{workerData:{args:{...args,dataRoot:directory},identity,previewCache:this.previewCache,cacheDirectory:this.cacheDirectory},resourceLimits:{maxOldGenerationSizeMb:this.memoryMb,maxYoungGenerationSizeMb:64,stackSizeMb:4}});
          let settled=false,timer;
          const finish=(error,result)=>{
            if(settled)return;settled=true;clearTimeout(timer);
            worker.terminate().then(()=>error?reject(error):resolve(result),reject);
          };
          job.abort=()=>finish(Error(this.label+"加载已取消"));
          timer=setTimeout(()=>finish(Error(this.label+"加载超时，请缩小读取范围后重试")),this.timeoutMs);
          worker.on("message",message=>{
            if(message.progress) job.progress=message.progress;
            else if(message.batch) {
              try { onBatch(message.batch); }
              catch (error) { finish(error); }
            }
            else if(message.error) finish(Error(message.error));
            else if(message.result) { if(this.cachePreview)this.previewCache=message.previewCache||null; finish(null,message.result); }
          });
          worker.on("error",error=>finish(Error(error.code==="ERR_WORKER_OUT_OF_MEMORY"?this.label+"加载超过内存预算，请缩小读取范围":error.message)));
          worker.on("exit",code=>{if(!settled)finish(Error(this.label+"后台任务意外结束（"+code+"）"));});
          if(job.cancelled) job.abort();
        });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try { if(directory) {
          const base=path.resolve(this.dataRoot,"map-preview-jobs");
          if(path.dirname(directory)!==base||!path.basename(directory).startsWith("job-")) throw Error("地图临时目录边界无效");
          await inspectSelection(directory,"directory");
          await fs.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
        } } catch (cleanupError) {
          if (failure) failure.message += "；临时目录清理失败：" + cleanupError.message;
          else throw cleanupError;
        } finally {
          if(this.active===job)this.active=null;
          if(this.cachePreview) {
            if(failure||job.cancelled) await this.clearCache();
            else { this.cacheTimer=setTimeout(()=>this.clearCache().catch(error=>this.onError({method:this.method,message:error.message})),this.cacheIdleMs); this.cacheTimer.unref(); }
          }
        }
      }
      })().catch(error => { if (!job.cancelled) { error.activityLogged = true; this.onError({ method: this.method, message: error.message }); } throw error; });
    return job.promise;
  }
  async cancel(id) {
    const job=this.active;if(!job||job.id!==id)return false;
    job.cancelled=true;job.abort?.();await job.promise.catch(()=>{});return true;
  }
  clearCache() {
    clearTimeout(this.cacheTimer); this.previewCache=null;
    const directory=this.cacheDirectory; this.cacheDirectory=null;
    this.cacheCleanup=this.cacheCleanup.then(async()=>{
      if(!directory)return;
      const base=path.resolve(this.dataRoot,"map-preview-jobs");
      if(path.dirname(directory)!==base||!path.basename(directory).startsWith("cache-"))throw Error("地图缓存目录边界无效");
      await inspectSelection(directory,"directory");
      await fs.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    });
    return this.cacheCleanup;
  }
  async dispose(){this.closed=true;if(this.active)await this.cancel(this.active.id);await this.clearCache();}
}
module.exports={MapPreviewJobs};
