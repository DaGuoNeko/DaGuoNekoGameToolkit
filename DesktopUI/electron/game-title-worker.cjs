const { NativeGameTitles } = require("./game-title-native.cjs");
let native,
  owner,
  targets = [],
  timer;
function stop() {
  clearInterval(timer);
  native?.dispose();
  if (owner) native.close(owner);
  process.exit(0);
}
process.parentPort.on("message", ({ data }) => {
  if (data.type === "init" && !native) {
    native = new NativeGameTitles(data.runtime);
    owner = native.open(0x100000, 0, data.ownerPid);
    if (!owner) return stop();
    timer = setInterval(() => {
      if (native.wait(owner, 0) !== 0x102) return stop();
      native.update(targets);
    }, 1000);
  } else if (
    data.type === "targets" &&
    native &&
    Array.isArray(data.targets) &&
    data.targets.length <= 100
  ) {
    targets = data.targets;
    native.update(targets);
  }
});
