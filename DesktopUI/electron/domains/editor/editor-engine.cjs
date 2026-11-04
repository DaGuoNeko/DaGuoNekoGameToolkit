const fs = require("node:fs/promises"),
  path = require("node:path"),
  { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util"),
  { randomUUID } = require("node:crypto"),
  { EventEmitter } = require("node:events");
const { EditorRpc } = require("./editor-rpc.cjs"),
  { EditorWindow } = require("./editor-window.cjs");
const { parseDocument } = require("../../../shared/ui-document.cjs");
const MC = "773baab2-511b-49a7-8e94-0e7f0d316da3",
  UI = "694d4e0e-74b8-47dc-b9ca-6fb77e0508e9";
const exec = promisify(execFile),
  delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = path.join(
  process.env.SystemRoot || "C:/Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
class EditorEngine extends EventEmitter {
  constructor(root, runtime, documents, { onError = () => {} } = {}) {
    super();
    this.root = root;
    this.runtime = runtime;
    this.documents = documents;
    this.onError = onError;
    this.status = { phase: "stopped", message: "" };
    this.queue = Promise.resolve();
    this.generation = 0;
  }
  snapshot() {
    return {
      ...this.status,
      generation: this.generation,
      pid: this.child?.pid || null,
      documentId: this.documentId || null,
    };
  }
  publish(patch) {
    Object.assign(this.status, patch);
    if (patch.phase === "error" && patch.message)
      this.onError({ method: "ui-editor.preview", message: patch.message });
    this.emit("state", this.snapshot());
  }
  async resolveExe() {
    try {
      const value = JSON.parse(
        await fs.readFile(
          path.join(this.root, "ui-editor-engine.json"),
          "utf8",
        ),
      );
      return this.validateExe(value.path);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const { stdout } = await exec(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name = 'MC_Editor.exe'\" | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 10000 },
    );
    const candidates = stdout.trim()
      ? []
          .concat(JSON.parse(stdout))
          .filter(Boolean)
          .map((p) =>
            path.join(path.dirname(p), "Game", "Minecraft.Windows.Editor.exe"),
          )
      : [];
    for (const drive of ["D:", "C:"])
      candidates.push(
        path.join(
          drive + "/",
          "MCStudioDownload",
          "MCX64Editor",
          "Game",
          "Minecraft.Windows.Editor.exe",
        ),
      );
    for (const file of candidates) {
      try {
        return await this.validateExe(file);
      } catch (e) {
        if (e.code !== "ENOENT") continue;
      }
    }
    throw Error(
      "未找到官方编辑器引擎，请选择 MCX64Editor/Game/Minecraft.Windows.Editor.exe",
    );
  }
  async validateExe(file) {
    if (
      typeof file !== "string" ||
      !path.isAbsolute(file) ||
      path.basename(file).toLowerCase() !== "minecraft.windows.editor.exe"
    )
      throw Error(
        "请选择 Minecraft.Windows.Editor.exe；普通游戏客户端不能代替编辑器引擎",
      );
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("编辑器引擎路径无效");
    await fs.access(path.join(path.dirname(file), "data"));
    return fs.realpath(file);
  }
  async configure(file) {
    if (this.child) throw Error("请先停止预览");
    const checked = await this.validateExe(file);
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(
      path.join(this.root, "ui-editor-engine.json"),
      JSON.stringify({ path: checked }, null, 2),
      "utf8",
    );
    return checked;
  }
  async accept(socket) {
    if (!this.child?.pid) return false;
    const port = Number(socket.remotePort);
    const { stdout } = await exec(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -RemotePort ${this.port} -State Established -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, timeout: 10000 },
    );
    return (
      stdout.trim() &&
      [].concat(JSON.parse(stdout)).some((p) => p === this.child?.pid)
    );
  }
  start(args, window) {
    const task = this.queue.then(() => this._start(args, window));
    this.queue = task.catch(() => {});
    return task;
  }
  async _start({ id, raw }, window) {
    if (this.child) throw Error("已有编辑器预览，请先停止");
    parseDocument(raw);
    const document = this.documents.documents.get(id);
    if (!document) throw Error("请先保存或打开 UI 文件");
    const exe = await this.resolveExe();
    this.generation++;
    this.documentId = id;
    this.window = window;
    this.uiSource = document.file;
    this.run = path.join(this.root, "ui-editor-preview", randomUUID());
    await fs.mkdir(this.run, { recursive: true });
    this.worldName = "DGN_UI_PREVIEW_" + randomUUID().replaceAll("-", "");
    this.worldId = null;
    this.loaded = false;
    this.inGame = false;
    this.stopping = false;
    this.details = Object.create(null);
    this.detailSizes = new Map();
    this.detailBytes = 0;
    this.rpcNotes = [];
    this.tree = null;
    this.selection = [];
    this.publish({
      phase: "starting",
      showGame: false,
      message: "正在启动官方编辑器引擎…",
      engine: exe,
    });
    try {
      this.rpc = new EditorRpc();
      this.rpc.on("notification", (method, params) =>
        this.notification(method, params),
      );
      this.rpc.on("fault", (message) =>
        this.publish({ phase: "error", message }),
      );
      this.rpc.on("disconnected", () => {
        if (!this.stopping && this.child)
          this.publish({
            phase: "error",
            message: "预览引擎已断开，请停止后重新启动",
          });
      });
      const connected = new Promise((resolve, reject) => {
        const timeout = (this.connectTimer = setTimeout(
          () => reject(Error("编辑器引擎连接超时")),
          45000,
        ));
        this.rpc.once("connected", () => {
          clearTimeout(timeout);
          resolve();
        });
        this.rpc.once("disconnected", () => {
          clearTimeout(timeout);
          reject(Error("引擎提前断开"));
        });
      });
      // Observe the rejection immediately even if process creation fails first.
      connected.catch(() => {});
      this.port = await this.rpc.listen((socket) => this.accept(socket));
      const log = await fs.open(path.join(this.run, "engine.log"), "wx");
      try {
        this.child = spawn(
          exe,
          [
            "port=" + this.port,
            "account=DGNPreview",
            "userName=DGNPreview",
            "userId=0",
            "serverName=MYL",
            "sunshineLog=" + path.join(this.run, "editor.log"),
            "gameLog=" + path.join(this.run, "game.log"),
            "openRenderDebugMsg=true",
          ],
          {
            cwd: path.dirname(exe),
            windowsHide: true,
            stdio: ["ignore", log.fd, log.fd],
          },
        );
      } finally {
        await log.close();
      }
      this.exitPromise = new Promise((resolve) => {
        this.child.once("exit", (code, signal) => {
          this.exitInfo = { code, signal };
          resolve();
          if (!this.stopping)
            this.publish({
              phase: "error",
              message: "预览引擎已退出：" + (code ?? signal),
            });
        });
        this.child.once("error", (e) => {
          this.publish({ phase: "error", message: e.message });
          resolve();
        });
      });
      await connected;
      const hwnd = await this.rpc.call(MC, "GetWindowHandle");
      this.native = new EditorWindow(this.runtime);
      this.native.attach(hwnd, this.child.pid, window);
      this.restoreBounds = () => {
        if (this.lastRect) this.native?.bounds(this.lastRect, window);
      };
      window.on("show", this.restoreBounds);
      window.on("restore", this.restoreBounds);
      window.on("move", this.restoreBounds);
      window.on("resize", this.restoreBounds);
      window.on("minimize", this.restoreBounds);
      this.publish({ message: "正在创建独立预览世界…" });
      this.worldId = await this.rpc.call(MC, "NewMap", [
        {
          level_name: this.worldName,
          mode: 1,
          worldtype: 2,
          seed: "1",
          ewblocks: 1,
          nsblocks: 1,
          x: 0,
          y: 64,
          z: 0,
        },
      ]);
      this.worldDir = await this.ownedWorld();
      await fs.writeFile(
        path.join(this.run, "ownership.json"),
        JSON.stringify(
          {
            pid: this.child.pid,
            worldId: this.worldId,
            worldName: this.worldName,
            worldDir: this.worldDir,
          },
          null,
          2,
        ),
        "utf8",
      );
      await this.stage(raw, true);
      this.publish({ message: "正在加载预览世界…" });
      await this.rpc.call(MC, "SetCodeEnable", [true]);
      const loaded = await this.rpc.call(MC, "LoadMap", [this.worldId], 45000);
      if (loaded === false) throw Error("预览世界加载失败");

      await this.rpc.call(MC, "SetEditorMode", ["UI"]);
      await this.rpc.call(UI, "initUIEditor");
      await this.rpc.call(UI, "newEditorMode");
      await this.rpc.call(UI, "HandleEditMode", [true]);
      await this.rpc.call(UI, "SetShowControlBox", [true]);
      await this.rpc.call(UI, "SetEditControlBox", [true]);
      await this.rpc.call(MC, "SetOnlyRenderUi", [true]);
      await this.loadSnapshot();
      this.publish({ phase: "ready", message: "真实引擎预览已就绪" });
      return this.snapshot();
    } catch (error) {
      await this._stop();
      this.publish({ phase: "error", message: error.message });
      throw error;
    }
  }
  async ownedWorld() {
    if (
      typeof this.worldId !== "string" ||
      !/^[A-Za-z0-9_+=-]{1,100}$/.test(this.worldId)
    )
      throw Error("引擎返回了不支持的预览世界标识");
    const base = path.resolve(
        process.env.APPDATA,
        "MinecraftPE_Netease_Editor",
        "minecraftWorlds",
      ),
      dir = path.join(base, this.worldId);
    if (
      path.dirname(dir) !== base ||
      (await fs.realpath(dir)).toLowerCase() !== dir.toLowerCase()
    )
      throw Error("预览世界路径不安全");
    if (
      (await fs.readFile(path.join(dir, "levelname.txt"), "utf8")).trim() !==
      this.worldName
    )
      throw Error("预览世界归属不匹配");
    return dir;
  }
  async stage(raw, first = false) {
    parseDocument(raw);
    const pack = path.join(this.worldDir, "resource_packs", "dgn_preview");
    if (first) {
      await fs.mkdir(path.join(pack, "ui"), { recursive: true });
      const doc = await this.documents.open(this.uiSource);
      const header = randomUUID(),
        module = randomUUID();
      this.packHeader = header;
      await fs.writeFile(
        path.join(pack, "manifest.json"),
        JSON.stringify({
          format_version: 2,
          header: {
            name: "DGN UI Preview",
            description: "Temporary UI editor preview",
            uuid: header,
            version: [1, 0, 0],
            min_engine_version: [1, 16, 0],
          },
          modules: [{ type: "resources", uuid: module, version: [1, 0, 0] }],
        }),
      );
      const sourceRoot = await this.documents.resourceRoot(this.documentId);
      if (sourceRoot) {
        let entries = 0,
          bytes = 0;
        const copy = async (source, target, depth = 0) => {
          if (depth > 25 || ++entries > 15000)
            throw Error("预览资源超过 15000 项或目录过深");
          const stat = await fs.lstat(source);
          if (stat.isSymbolicLink())
            throw Error("预览资源不接受目录链接：" + path.basename(source));
          if (stat.isDirectory()) {
            await fs.mkdir(target, { recursive: true });
            for (const entry of await fs.readdir(source))
              await copy(
                path.join(source, entry),
                path.join(target, entry),
                depth + 1,
              );
          } else if (stat.isFile()) {
            bytes += stat.size;
            if (bytes > 256 * 1024 * 1024)
              throw Error("预览贴图和字体超过 256 MiB");
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(source, target);
          } else throw Error("预览资源包含特殊文件");
        };
        for (const folder of ["textures", "font"]) {
          try {
            await fs.access(path.join(sourceRoot, folder));
          } catch (e) {
            if (e.code === "ENOENT") continue;
            throw e;
          }
          await copy(path.join(sourceRoot, folder), path.join(pack, folder));
        }
        const globals = path.join(sourceRoot, "ui", "_global_variables.json");
        try {
          await copy(globals, path.join(pack, "ui", "_global_variables.json"));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      for (const dep of doc.dependencies)
        await fs.writeFile(
          path.join(pack, "ui", path.basename(dep.name)),
          JSON.stringify(dep.data),
        );
      const files = doc.dependencies.map((d) => "ui/" + path.basename(d.name));
      files.push("ui/" + path.basename(this.uiSource));
      await fs.writeFile(
        path.join(pack, "ui", "_ui_defs.json"),
        JSON.stringify({ ui_defs: [...new Set(files)] }),
      );
      await fs.writeFile(
        path.join(this.worldDir, "world_resource_packs.json"),
        JSON.stringify([{ pack_id: header, version: [1, 0, 0] }]),
      );
      await fs.writeFile(
        path.join(this.worldDir, "world_behavior_packs.json"),
        "[]",
      );
      this.previewFile = path.join(pack, "ui", path.basename(this.uiSource));
    }
    await fs.writeFile(this.previewFile, raw, "utf8");
    this.snapshotRaw = raw;
  }
  async loadSnapshot() {
    this.details = Object.create(null);
    this.detailSizes = new Map();
    this.detailBytes = 0;
    const file = this.previewFile;
    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("analysis", handler);
        reject(Error("引擎未确认 UI 解析完成"));
      }, 25000);
      const handler = (p, success) => {
        if (path.resolve(p).toLowerCase() !== file.toLowerCase()) return;
        clearTimeout(timer);
        this.off("analysis", handler);
        success
          ? resolve()
          : reject(Error("引擎拒绝加载 UI 文件，请查看预览日志"));
      };
      this.on("analysis", handler);
    });
    finished.catch(() => {});
    await this.rpc.call(UI, "LoadProject", [file, true, ""]);
    await finished;
    const activeScreen = this.tree?.UIHeader?.mCurrent;
    if (typeof activeScreen === "string") {
      await this.rpc.call(UI, "ChangeEditorScreen", [activeScreen]);
      await this.rpc.call(UI, "SetSelectedControl", [
        JSON.stringify(["/" + activeScreen]),
      ]);
    }
    this.loaded = true;
  }
  storeDetails(controlPath, data) {
    if (
      typeof controlPath !== "string" ||
      !controlPath.startsWith("/") ||
      controlPath.length > 2048 ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    )
      throw Error("引擎控件属性格式无效");
    const { controls, ...value } = data,
      size = JSON.stringify(value).length * 2;
    if (size > 2 * 1024 * 1024) throw Error("单个控件属性过大");
    if (this.detailSizes.has(controlPath))
      this.detailBytes -= this.detailSizes.get(controlPath);
    delete this.details[controlPath];
    this.detailSizes.delete(controlPath);
    while (
      this.detailBytes + size > 16 * 1024 * 1024 &&
      this.detailSizes.size
    ) {
      const [key, n] = this.detailSizes.entries().next().value;
      this.detailBytes -= n;
      this.detailSizes.delete(key);
      delete this.details[key];
    }
    this.details[controlPath] = value;
    this.detailSizes.set(controlPath, size);
    this.detailBytes += size;
    return value;
  }
  notification(method, params) {
    if (method === "_" + MC + "_InformInGame") {
      this.inGame =
        (Array.isArray(params) ? params[0] : params?.ingame) === true;
      this.emit("in-game", this.inGame);
    }
    if (
      /Property|Operation|Solved|Control/.test(method) &&
      this.rpcNotes?.length < 100
    )
      this.rpcNotes.push({
        method,
        params: Array.isArray(params)
          ? params.map((v) => (typeof v === "string" ? v.slice(0, 12000) : v))
          : params,
      });
    const name = method.startsWith("_" + UI + "_")
      ? method.slice(UI.length + 2)
      : "";
    if (
      name === "OnUIOperationFinshed" &&
      Array.isArray(params) &&
      params[0] === 27 &&
      typeof params[2] === "string"
    ) {
      try {
        const change = JSON.parse(params[2]);
        if (
          typeof change.path === "string" &&
          typeof change.property === "string"
        ) {
          if (params[1] === true && this.details[change.path])
            this.storeDetails(change.path, {
              ...this.details[change.path],
              [change.property]: change.value,
            });
        }
      } catch (error) {
        this.publish({ message: "引擎属性确认解析失败：" + error.message });
      }
    }
    if (
      ["RefreshshUIControlData", "OnUIOperationFinshed"].includes(name) &&
      this.rpcNotes?.length < 100
    )
      this.rpcNotes.push({
        name,
        params: Array.isArray(params)
          ? params.map((v) => (typeof v === "string" ? v.slice(0, 12000) : v))
          : params,
      });
    if (
      name === "RefreshshUIControlData" &&
      Array.isArray(params) &&
      typeof params[0] === "string" &&
      typeof params[1] === "string" &&
      typeof params[3] === "string"
    ) {
      try {
        const value = JSON.parse(params[3]),
          key = params[0] + "/" + params[1];
        if (value && typeof value === "object") {
          this.storeDetails(key, value);
          this.emit("property", key, value);
        }
      } catch (error) {
        this.publish({ message: "引擎控件回包解析失败：" + error.message });
      }
    }
    if (
      name === "AnalysisUIFinish" &&
      Array.isArray(params) &&
      typeof params[0] === "string"
    ) {
      this.emit("analysis", params[0], params[2] === true);
      if (
        params[2] === true &&
        typeof params[1] === "string" &&
        params[1].length < 8 * 1024 * 1024
      ) {
        try {
          this.tree = JSON.parse(params[1]);
          this.emit("tree", {
            generation: this.generation,
            documentId: this.documentId,
            tree: this.tree,
          });
        } catch (error) {
          this.publish({ message: "引擎控件树解析失败：" + error.message });
        }
      }
      this.publish({ analysis: params[2] === true ? "ok" : "failed" });
    }
    if (name === "SetSelectedControl" && Array.isArray(params)) {
      try {
        const paths =
          typeof params[0] === "string" ? JSON.parse(params[0]) : params[0];
        if (
          Array.isArray(paths) &&
          paths.length <= 100 &&
          paths.every((p) => typeof p === "string" && p.length < 2048)
        ) {
          this.selection = paths;
          this.emit("selection", {
            generation: this.generation,
            documentId: this.documentId,
            paths,
            offset: params[2],
            size: params[3],
          });
        }
      } catch (error) {
        this.publish({ message: "引擎选择事件解析失败：" + error.message });
      }
    }
    if (
      name === "OnSendControlValue" &&
      Array.isArray(params) &&
      typeof params[0] === "string" &&
      typeof params[1] === "string" &&
      params[1].length < 1024 * 1024
    ) {
      try {
        const value = this.storeDetails(params[0], JSON.parse(params[1]));
        this.emit("property", params[0], value);
      } catch (error) {
        this.publish({ message: "引擎属性解析失败：" + error.message });
      }
    }
  }
  sync({ id, raw }) {
    const task = this.queue.then(async () => {
      if (!this.child || !this.loaded || id !== this.documentId)
        throw Error("请为当前文件启动预览");
      this.publish({ phase: "syncing", message: "正在更新游戏预览…" });
      try {
        await this.stage(raw);
        await this.loadSnapshot();
        this.publish({ phase: "ready", message: "游戏预览已更新" });
        return this.snapshot();
      } catch (e) {
        this.publish({ phase: "error", message: e.message });
        throw e;
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async select({ id, paths, generation }) {
    if (
      id !== this.documentId ||
      generation !== this.generation ||
      !this.loaded
    )
      return;
    if (
      !Array.isArray(paths) ||
      paths.length > 100 ||
      !paths.every(
        (p) => typeof p === "string" && p.startsWith("/") && p.length < 2048,
      )
    )
      throw Error("控件路径无效");
    await this.rpc.call(UI, "SetSelectedControl", [JSON.stringify(paths)]);
  }
  async showGame(value) {
    if (typeof value !== "boolean" || !this.loaded) throw Error("预览未就绪");
    await this.rpc.call(MC, "SetOnlyRenderUi", [!value]);
    this.publish({ showGame: value });
    return this.snapshot();
  }
  async properties({ id, generation, path: controlPath }) {
    if (
      id !== this.documentId ||
      generation !== this.generation ||
      !this.loaded ||
      typeof controlPath !== "string" ||
      !controlPath.startsWith("/") ||
      controlPath.length > 2048
    )
      throw Error("预览会话或控件路径无效");
    if (Object.hasOwn(this.details, controlPath))
      return { path: controlPath, data: this.details[controlPath], generation };
    const value = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("property", handler);
        reject(Error("引擎没有返回该控件属性"));
      }, 8000);
      const handler = (p, data) => {
        if (p !== controlPath) return;
        clearTimeout(timer);
        this.off("property", handler);
        resolve({ path: p, data, generation });
      };
      this.on("property", handler);
    });
    value.catch(() => {});
    await this.rpc.call(UI, "SetSelectedControl", [
      JSON.stringify([controlPath]),
    ]);
    return value;
  }

  bounds({ generation, rect }, window) {
    if (generation !== this.generation) return;
    this.lastRect = rect;
    this.native?.bounds(rect, window);
  }
  stop() {
    const task = this.queue.then(() => this._stop());
    this.queue = task.catch(() => {});
    return task;
  }
  async _stop() {
    this.stopping = true;
    clearTimeout(this.connectTimer);
    if (this.restoreBounds && this.window && !this.window.isDestroyed()) {
      this.window.removeListener("show", this.restoreBounds);
      this.window.removeListener("restore", this.restoreBounds);
      this.window.removeListener("move", this.restoreBounds);
      this.window.removeListener("resize", this.restoreBounds);
      this.window.removeListener("minimize", this.restoreBounds);
    }
    this.restoreBounds = null;
    this.lastRect = null;
    this.native?.close();
    if (this.child) {
      await Promise.race([this.exitPromise, delay(3000)]);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill();
        await Promise.race([this.exitPromise, delay(3000)]);
      }
    }
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
      throw Error("无法结束自身预览进程；未移动其世界");
    this.rpc?.close();
    this.rpc = null;
    this.child = null;
    this.native = null;
    this.loaded = false;
    let message = "预览已停止";
    if (this.worldId) {
      try {
        const owned = await this.ownedWorld();
        const dest = path.join(this.run, "world");
        if (path.dirname(dest) !== this.run) throw Error("归档目录无效");
        await fs.rename(owned, dest);
      } catch (e) {
        message += "；预览世界保留：" + e.message;
      }
    }
    this.worldId = null;
    this.worldDir = null;
    if (this.run && this.rpcNotes?.length) {
      try {
        await fs.writeFile(
          path.join(this.run, "preview-events.json"),
          JSON.stringify(this.rpcNotes, null, 2),
          "utf8",
        );
      } catch (error) {
        message += "；预览诊断记录未保存：" + error.message;
      }
    }
    this.publish({ phase: "stopped", message });
    return this.snapshot();
  }
}
module.exports = { EditorEngine, MC, UI };
