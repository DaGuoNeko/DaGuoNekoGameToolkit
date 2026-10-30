const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const exec = require("node:util").promisify(execFile);
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-update-install-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-update-install-"));
    // Windows 启动夹具写出回执时进程可能尚在退出，短暂持有目录/EXE。
    // 仅对本测试已校验的临时目录进行有界清理重试，保留所有业务断言。
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const target = path.join(root, "app"),
    source = path.join(root, "new"),
    cache = path.join(root, "cache");
  for (const dir of [target, source])
    await fs.mkdir(path.join(dir, "resources"), { recursive: true });
  await fs.mkdir(cache);
  await fs.writeFile(
    path.join(target, "DaGuoNeko-Game-Toolkit.exe"),
    "old exe",
  );
  await fs.writeFile(path.join(target, "resources/app.asar"), "old asar");
  await fs.mkdir(path.join(root, "user-data"));
  await fs.writeFile(path.join(root, "user-data/world.dat"), "preserve world");
  await fs.mkdir(target + ".previous");
  await fs.writeFile(
    path.join(target + ".previous", "keep.txt"),
    "preserve existing backup",
  );
  await fs.writeFile(path.join(source, "resources/app.asar"), "new asar");
  await fs.writeFile(
    path.join(source, "release-info.json"),
    JSON.stringify({ version: "0.1.1", platform: "win32", arch: "x64" }),
  );
  const cs = path.join(root, "Fixture.cs");
  await fs.writeFile(
    cs,
    'using System;using System.IO;class Fixture{static void Main(){File.WriteAllText(System.Reflection.Assembly.GetExecutingAssembly().Location+".started","started");}}',
    "utf8",
  );
  await exec(
    path.join(
      process.env.SystemRoot,
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    ),
    [
      "/nologo",
      "/target:winexe",
      `/out:${path.join(source, "DaGuoNeko-Game-Toolkit.exe")}`,
      cs,
    ],
    { windowsHide: true },
  );
  const archive = path.join(cache, "update.zip");
  await exec(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(source)},${psQuote(archive)})`,
    ],
    { windowsHide: true },
  );
  const plan = {
    archive,
    targetDirectory: target,
    executablePath: path.join(target, "DaGuoNeko-Game-Toolkit.exe"),
    version: "0.1.1",
    pid: 2147483647,
    sha256: createHash("sha256")
      .update(await fs.readFile(archive))
      .digest("hex"),
  };
  const planPath = path.join(cache, "plan.json");
  const run = async () => {
    await fs.writeFile(planPath, JSON.stringify(plan), "utf8");
    let failed = false;
    try {
      await exec(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.resolve("electron/update-helper.ps1"),
          "-Plan",
          planPath,
        ],
        { windowsHide: true, timeout: 20000 },
      );
    } catch {
      failed = true;
    }
    return {
      failed,
      result: JSON.parse(
        await fs.readFile(path.join(cache, "update-result.json"), "utf8"),
      ),
    };
  };
  return { root, target, source, archive, plan, run };
}

test(
  "Windows updater installs checked package, preserves all backups and external user data",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    const { failed, result } = await f.run();
    assert.equal(failed, false, result.error);
    assert.equal(result.ok, true);
    assert.equal(
      await fs.readFile(path.join(f.target, "resources/app.asar"), "utf8"),
      "new asar",
    );
    assert.equal(
      await fs.readFile(path.join(result.backup, "resources/app.asar"), "utf8"),
      "old asar",
    );
    assert.equal(
      await fs.readFile(path.join(f.target + ".previous", "keep.txt"), "utf8"),
      "preserve existing backup",
    );
    assert.equal(
      await fs.readFile(path.join(f.root, "user-data/world.dat"), "utf8"),
      "preserve world",
    );
    for (let i = 0; i < 30; i++) {
      try {
        await fs.access(f.plan.executablePath + ".started");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(
      await fs.readFile(f.plan.executablePath + ".started", "utf8"),
      "started",
    );
  },
);

test(
  "Windows updater rejects tampering, version mismatch and traversal without replacing the old app",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    const hash = f.plan.sha256;
    f.plan.sha256 = "0".repeat(64);
    assert.match((await f.run()).result.error, /SHA-256 mismatch/);
    f.plan.sha256 = hash;
    f.plan.version = "0.1.2";
    assert.match((await f.run()).result.error, /version or layout/);
    f.plan.version = "0.1.1";
    await exec(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open(${psQuote(f.archive)},'Update'); $null=$z.CreateEntry('../escape.txt'); $z.Dispose()`,
      ],
      { windowsHide: true },
    );
    f.plan.sha256 = createHash("sha256")
      .update(await fs.readFile(f.archive))
      .digest("hex");
    assert.match((await f.run()).result.error, /Unsafe path/);
    assert.equal(
      await fs.readFile(path.join(f.target, "resources/app.asar"), "utf8"),
      "old asar",
    );
    assert.equal(
      await fs.readFile(path.join(f.root, "user-data/world.dat"), "utf8"),
      "preserve world",
    );
    await assert.rejects(fs.access(path.join(f.root, "escape.txt")), {
      code: "ENOENT",
    });
  },
);
