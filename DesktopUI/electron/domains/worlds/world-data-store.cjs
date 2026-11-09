const { Worker } = require("node:worker_threads");

// 快照与计算留在专用线程，主进程只保留来源元数据供导出边界检查。
class WorldDataStore {
  constructor(workerFile, { onError = () => {} } = {}) {
    this.workerFile = workerFile; this.onError = onError;
    this.worker = null; this.pending = new Map(); this.sequence = 0; this.closed = false;
  }
  request(operation, args) {
    if (this.closed) return Promise.reject(Error("世界数据服务已关闭"));
    if (!this.worker) {
      const worker = new Worker(this.workerFile, { resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 } });
      this.worker = worker;
      const fail = error => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        worker.terminate().catch(() => {});
        if (!this.closed) this.onError({ method: "world-data.compute", message: error.message });
      };
      worker.on("message", ({ id, result, error }) => {
        const request = this.pending.get(id); if (!request) return;
        this.pending.delete(id); if (error) request.reject(Error(error)); else request.resolve(result);
      });
      worker.on("error", error => fail(Error("世界数据计算失败，请重新扫描：" + error.message)));
      worker.on("exit", code => fail(Error("世界数据计算线程已退出，请重新扫描（" + code + "）")));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, operation, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async dispose() {
    this.closed = true;
    const worker = this.worker; this.worker = null;
    for (const request of this.pending.values()) request.reject(Error("世界数据服务已关闭"));
    this.pending.clear(); if (worker) await worker.terminate();
  }
}
module.exports = { WorldDataStore };
