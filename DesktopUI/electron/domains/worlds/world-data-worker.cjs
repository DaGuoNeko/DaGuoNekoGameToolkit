const { parentPort, workerData } = require("node:worker_threads");
const { verifySelection } = require("../../file-selection.cjs");
const { scanWorldData } = require("./world-data.cjs");
(async () => {
  await verifySelection(workerData.identity);
  let last = 0;
  const result = await scanWorldData({ ...workerData.args, onProgress(stage, completed, total) {
    if (Date.now() - last < 120 && completed !== total) return;
    last = Date.now(); parentPort.postMessage({ progress: { stage, completed, total } });
  } });
  await verifySelection(workerData.identity);
  parentPort.postMessage({ result });
})().catch(error => parentPort.postMessage({ error: error.message }));
