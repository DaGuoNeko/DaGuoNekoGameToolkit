const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  os = require("node:os");
const { reserveIsolation } = require("./isolation-spawn.cjs");
const { folderFor } = require("./domains/worlds/world-path.cjs");
const { readWorldInfo } = require("./domains/worlds/world-info.cjs");
const template = require("./domains/worlds/world-template.cjs");
const GAME_HASH =
  "489a164d5f37048fcebf941bfefba4a50ee0dabfbb7f2f2169c09600b2a4579c";
const MCDK_HASH =
  "2cd4348c05a1b3855f4397526a9c4c3deea359d2e57f07a61e2669bd5b47349b";
const same = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function stat(file) {
  try {
    return await fs.lstat(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function directory(dir) {
  await fs.mkdir(dir, { recursive: true });
  const s = await fs.lstat(dir);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    !same(await fs.realpath(dir), dir)
  )
    throw Error("隔离目录被重定向，请检查：" + dir);
}
function initialLevel(config) {
  let data = Buffer.from(template);
  function field(type, name) {
    const bytes = Buffer.from(name),
      header = Buffer.alloc(3 + bytes.length);
    header[0] = type;
    header.writeUInt16LE(bytes.length, 1);
    bytes.copy(header, 3);
    const index = data.indexOf(header, 11);
    if (index < 0 || data.indexOf(header, index + 1) >= 0)
      throw Error("默认存档模板字段不唯一：" + name);
    return index + header.length;
  }
  const at = field(8, "LevelName"),
    oldLength = data.readUInt16LE(at),
    name = Buffer.from(config.world_name),
    text = Buffer.alloc(2 + name.length);
  text.writeUInt16LE(name.length);
  name.copy(text, 2);
  data = Buffer.concat([
    data.subarray(0, at),
    text,
    data.subarray(at + 2 + oldLength),
  ]);
  data.writeInt32LE(config.world_type, field(3, "Generator"));
  data.writeInt32LE(config.game_mode, field(3, "GameType"));
  const seed =
    config.world_seed == null
      ? crypto.randomBytes(8).readBigInt64LE()
      : BigInt(config.world_seed);
  data.writeBigInt64LE(seed, field(4, "RandomSeed"));
  data.writeUInt32LE(data.length - 8, 4);
  const parsed = readWorldInfo(data);
  if (
    parsed.levelName !== config.world_name ||
    parsed.worldType !== config.world_type ||
    parsed.gameMode !== config.game_mode
  )
    throw Error("默认存档模板校验失败");
  return data;
}
class HostIsolation {
  constructor(
    runtime,
    worlds,
    gameOptions,
    {
      base = path.join(os.homedir(), "DgnGameToolkitHosts"),
      reserve = reserveIsolation,
    } = {},
  ) {
    Object.assign(this, { runtime, worlds, gameOptions, base, reserve });
    this.hashes = new Map();
  }
  async digest(file) {
    const s = await fs.stat(file),
      key = s.size + ":" + s.mtimeMs + ":" + s.ctimeMs;
    const cached = this.hashes.get(file);
    if (cached?.key === key) return cached.hash;
    const hash = crypto
      .createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
    const after = await fs.stat(file);
    if (
      s.size !== after.size ||
      s.mtimeMs !== after.mtimeMs ||
      s.ctimeMs !== after.ctimeMs
    )
      throw Error("游戏或启动器在校验期间变化，请重试");
    this.hashes.set(file, { key, hash });
    return hash;
  }
  async prepare(worldId, config, launcher, runDirectory, allowPrivate = true) {
    // Preserve legacy/custom launcher compatibility, but never allow it to run
    // a second host by pretending that its shared deployment is isolated.
    if (
      process.platform !== "win32" ||
      config.world_source_path
    )
      return null;
    if (!same(launcher, path.join(this.runtime, "mcdk.exe"))) return null;
    const gameHash = await this.digest(config.game_executable_path);
    const privateHost = allowPrivate && gameHash === GAME_HASH &&
      same(launcher, path.join(this.runtime, "mcdk.exe"));
    if (!privateHost && !runDirectory) return null;
    if ((await this.digest(launcher)) !== MCDK_HASH)
      throw Error("原目录保护需要使用已验证的内置 MCDK，请在设置中恢复内置启动器");
    const before = await this.worlds.run(async () => {
      const w = this.worlds.find(await this.worlds.read(), null, worldId),
        info = await this.worlds.inspect(w);
      if (info.deleted || w.copying || (info.present && !info.ready))
        throw Error("存档不可用，已停止独立主机启动");
      const actual = info.present
        ? await fs.realpath(info.path)
        : path.resolve(info.path);
      return { actual, ready: info.ready };
    });
    const fingerprint = crypto
      .createHash("sha256")
      .update(before.actual.toLowerCase())
      .digest("hex");
    const roaming = privateHost
        ? path.join(this.base, "DgnGT-R-" + fingerprint.slice(0, 16))
        : this.worlds.appDataOverride || process.env.APPDATA,
      local = privateHost
        ? path.join(this.base, "DgnGT-L-" + fingerprint.slice(0, 16))
        : this.worlds.appDataOverride ? path.join(path.dirname(this.worlds.appDataOverride), "game-local-data") : process.env.LOCALAPPDATA,
      low = privateHost
        ? path.join(this.base, "DgnGT-W-" + fingerprint.slice(0, 16))
        : this.worlds.appDataOverride ? path.join(path.dirname(this.worlds.appDataOverride), "game-low-data") : path.join(os.homedir(), "AppData/LocalLow");
    // This native game's Windows Python loader slices module paths by segment
    // count. Match the normal C:/Users/<user>/AppData/Roaming depth exactly.
    if (privateHost && roaming.replaceAll("\\", "/").split("/").length !== 5)
      throw Error(
        "当前用户目录层级不支持此版本的独立主机，请使用标准 Windows 用户目录",
      );
    const lease = await this.reserve(
      this.runtime,
      "Local\\DgnHost-" + fingerprint,
      path.join(before.actual, "db/LOCK"),
    );
    try {
      for (const root of privateHost ? [roaming, local, low] : []) {
        const exists = await stat(root);
        const ownerPath = path.join(root, ".dgn-owner.json");
        if (exists && !(await stat(ownerPath)))
          throw Error("隔离目录没有归属记录，已保留原内容：" + root);
        await directory(root);
        const ownerFile = path.join(root, ".dgn-owner.json"),
          owner = await stat(ownerFile);
        if (owner) {
          if (!owner.isFile() || owner.isSymbolicLink() || owner.size > 8192)
            throw Error("隔离目录归属无效");
          const value = JSON.parse(await fs.readFile(ownerFile, "utf8"));
          if (
            typeof value.world !== "string" ||
            !same(value.world, before.actual) ||
            value.version !== 1
          )
            throw Error("隔离目录与存档不匹配");
        } else
          await fs.writeFile(
            ownerFile,
            JSON.stringify({ version: 1, world: before.actual }),
            { flag: "wx" },
          );
      }
      await this.worlds.run(async () => {
        const w = this.worlds.find(await this.worlds.read(), null, worldId),
          info = await this.worlds.inspect(w);
        if (
          info.deleted ||
          w.copying ||
          (!same(info.path, before.actual) &&
            !(
              info.present && same(await fs.realpath(info.path), before.actual)
            ))
        )
          throw Error("存档位置在准备期间变化");
        if (!before.ready) {
          if (info.present) throw Error("新存档目录在准备期间出现，未覆盖");
          await fs.mkdir(before.actual);
          await fs.writeFile(
            path.join(before.actual, "level.dat"),
            initialLevel(config),
            { flag: "wx" },
          );
        }
      });
      const worldsRoot = path.join(
          roaming,
          "MinecraftPE_Netease/minecraftWorlds",
        ),
        parent = path.join(worldsRoot, path.dirname(folderFor(worldId)));
      for (const dir of [
        path.join(roaming, "MinecraftPE_Netease"),
        worldsRoot,
        parent,
      ])
        await directory(dir);
      const mount = path.join(worldsRoot, folderFor(worldId)),
        s = await stat(mount);
      if (privateHost && s) {
        if (
          !s.isSymbolicLink() ||
          !same(await fs.realpath(mount), before.actual)
        )
          throw Error("隔离存档入口被替换，已停止启动");
      } else if (privateHost) await fs.symlink(before.actual, mount, "junction");
      if (privateHost) await directory(path.join(local, "Temp"));
      await directory(path.join(roaming, "MinecraftPE_Netease/minecraftpe"));
      const optionsFile = path.join(
        roaming,
        "MinecraftPE_Netease/minecraftpe/options.txt",
      );
      const env = {
        APPDATA: roaming,
        LOCALAPPDATA: local,
        ...(privateHost ? { TEMP: path.join(local, "Temp"), TMP: path.join(local, "Temp") } : {}),
        DGN_ISO_ROAMING: roaming,
        DGN_ISO_LOCAL: local,
        DGN_ISO_LOW: low,
        DGN_ISO_GAME: config.game_executable_path,
        DGN_ISO_MCDK: launcher,
        DGN_ISO_DLL: path.join(this.runtime, "native/dgn-host-isolation.dll"),
      };
      if (runDirectory) {
        const view = path.join(runDirectory, "world-files");
        const relative = path.relative(before.actual, view);
        if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
          throw Error("运行目录不能位于原地图内");
        await directory(view);
        for (const name of ["behavior_packs", "resource_packs", ".toolbox-packs"])
          await directory(path.join(view, name));
        Object.assign(env, {
          DGN_WORLD_SOURCE: before.actual, DGN_WORLD_MOUNT: mount, DGN_WORLD_VIEW: view,
          DGN_PACK_VIEW: path.join(runDirectory, "world-packs"),
          DGN_PACK_MANIFESTS: path.join(runDirectory, "pack-manifests"),
        });
      }
      return {
        roaming,
        actualWorld: before.actual,
        mode: privateHost ? "isolated" : "shared",
        stop: () => lease.stop(),
        options: () => privateHost ? this.gameOptions.prepareIsolated(optionsFile) : this.gameOptions.prepare(),
        spawn: async (exe, args, options) => {
          if (
            (await this.digest(config.game_executable_path)) !== gameHash ||
            (await this.digest(exe)) !== MCDK_HASH
          )
            throw Error("游戏或启动器已变化");
          return lease.spawn(exe, {
            cwd: options.cwd,
            env: { ...options.env, ...env },
          });
        },
      };
    } catch (e) {
      await lease.stop();
      throw e;
    }
  }
}
module.exports = { HostIsolation, initialLevel };
