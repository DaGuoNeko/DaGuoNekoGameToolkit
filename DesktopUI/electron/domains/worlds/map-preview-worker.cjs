const {parentPort,workerData}=require("node:worker_threads");
const {renderWorld}=require("./map-preview.cjs");
const {verifySelection}=require("../../file-selection.cjs");
(async()=>{
  await verifySelection(workerData.identity);
  let last=0,lastStage="";
  const progress=(stage,completed=0,total=null)=>{
    if(stage!==lastStage||Date.now()-last>=100||completed===total) {last=Date.now();lastStage=stage;parentPort.postMessage({progress:{stage,completed,total}});}
  };
  const result=await renderWorld({...workerData.args,onProgress:progress,onBatch:batch=>parentPort.postMessage({batch})});
  await verifySelection(workerData.identity);
  parentPort.postMessage({result});
})().catch(e=>parentPort.postMessage({error:e.message}));
