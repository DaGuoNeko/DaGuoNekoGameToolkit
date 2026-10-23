// Only the OS attachment is mocked; the real Host Bridge registration and
// launcher ownership checks still run in source and packaged UI tests.
module.exports = async function mockMenuName(app) {
  await app.evaluate(() => {
    const cp = process.mainModule.require("node:child_process"),
      path = process.mainModule.require("node:path");
    const original = cp.execFile;
    globalThis.menuNameCalls = [];
    cp.execFile = function (file, args, options, callback) {
      if (path.basename(file) === "menu-name-helper.exe") {
        if (
          args.length !== 5 ||
          !/^\d+$/.test(args[0]) ||
          !/^\d+$/.test(args[1]) ||
          !path.isAbsolute(args[2]) ||
          !args[4]
        )
          throw Error("invalid identity helper request");
        globalThis.menuNameCalls.push(args);
        setImmediate(() => callback(null, '{"code":0,"win32":0}', ""));
        return { kill() {} };
      }
      return original.call(this, file, args, options, callback);
    };
  });
};
