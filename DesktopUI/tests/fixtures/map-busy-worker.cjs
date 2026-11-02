const {parentPort}=require("node:worker_threads");
parentPort.postMessage({progress:{stage:"busy fixture",completed:1,total:2}});
// 模拟不可让步的 CPU 工作，验证主线程仍响应且可强制取消。
for(;;) Math.sqrt(Math.random());
