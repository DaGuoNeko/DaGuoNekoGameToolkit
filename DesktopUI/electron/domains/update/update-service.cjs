const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createWriteStream } = require("node:fs");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { parseVersion, compareVersions } = require("../../../shared/update-version.cjs");
const defaultConfig = require("./update-config.cjs");

const API = "https://api.github.com";
const USER_AGENT = "DaGuoNeko-Game-Toolkit-Updater";
const BUSY_PHASES = ["checking", "downloading", "downloaded", "preparing", "installing"];

function defaultState(currentVersion) {
  return {
    phase: "idle",
    currentVersion,
    latestVersion: null,
    releaseName: "",
    releaseUrl: "",
    publishedAt: "",
    notes: "",
    assetName: "",
    progress: 0,
    checkedAt: null,
    error: "",
    canInstall: false,
    canDownload: false,
    history: [],
    historyPage: 0,
    historyHasMore: false,
    historyLoading: false,
    historyError: "",
    installation: null,
  };
}

function validText(value, max = 20000) {
  return typeof value === "string" && value.length <= max ? value : "";
}

function parseChecksum(text, assetName) {
  const line = String(text)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.endsWith(`  ${assetName}`) || item.endsWith(` *${assetName}`));
  const hash = line?.match(/^([a-f0-9]{64})\s+/i)?.[1];
  if (!hash) throw Error("发布缺少有效的 ZIP SHA-256 校验值");
  return hash.toLowerCase();
}

class UpdateService extends EventEmitter {
  constructor({
    currentVersion,
    dataRoot,
    runtimeRoot,
    appDirectory,
    executablePath,
    isPackaged,
    config = defaultConfig,
    fetchImpl = globalThis.fetch,
    canInstall = async () => ({ ok: true }),
    requestQuit = () => {},
  }) {
    super();
    if (typeof fetchImpl !== "function") throw Error("当前运行时不支持网络请求");
    this.currentVersion = currentVersion;
    this.dataRoot = dataRoot;
    this.runtimeRoot = runtimeRoot;
    this.appDirectory = appDirectory;
    this.executablePath = executablePath;
    this.isPackaged = isPackaged;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.canInstall = canInstall;
    this.requestQuit = requestQuit;
    this.state = defaultState(currentVersion);
    this.state.canInstall = !!isPackaged;
    this.release = null;
    this.queue = Promise.resolve();
    this.checkPromise = null;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.snapshot());
    return this.snapshot();
  }

  cacheDirectory() {
    return path.join(this.dataRoot, "update");
  }

  headers() {
    return { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT };
  }

  async requestJson(url, options = {}) {
    const response = await this.fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      ...options,
      headers: { ...this.headers(), ...(options.headers || {}) },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw Error(`更新服务返回了无效响应（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      const message =
        response.status === 404
          ? "暂时没有可用的正式版本"
          : response.status === 403
            ? "更新服务请求过于频繁，请稍后重试"
            : "更新服务请求失败，请检查网络后重试";
      throw Object.assign(Error(`${message}（HTTP ${response.status}）`), { status: response.status });
    }
    return body;
  }

  releaseSummary(release) {
    return {
      tag: validText(release.tag_name, 200),
      name: validText(release.name || release.tag_name, 200),
      notes: validText(release.body, 50000),
      publishedAt: validText(release.published_at, 100),
      url: this.validReleaseUrl(release.html_url) ? release.html_url : "",
      prerelease: !!release.prerelease,
    };
  }

  validReleaseUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === "https://github.com" && !url.username && !url.password &&
        url.pathname.startsWith(`/${this.config.repository}/releases/tag/`);
    } catch {
      return false;
    }
  }

  validDownloadUrl(value, assetName) {
    try {
      const url = new URL(value);
      return url.origin === "https://github.com" && !url.username && !url.password &&
        url.pathname.startsWith(`/${this.config.repository}/releases/download/`) &&
        url.pathname.endsWith(`/${assetName}`);
    } catch {
      return false;
    }
  }

  releaseUrl(tag) {
    const url = tag ? this.state.history.find((item) => item.tag === tag)?.url : this.state.releaseUrl;
    if (!this.validReleaseUrl(url)) throw Error("更新页面地址无效");
    return url;
  }

  async readHistory(page = 1) {
    const releases = await this.requestJson(`${API}/repos/${this.config.repository}/releases?per_page=30&page=${page}`);
    if (!Array.isArray(releases)) throw Error("更新历史响应无效");
    return {
      history: releases.filter((item) => !item.draft).map((item) => this.releaseSummary(item)),
      historyPage: page,
      historyHasMore: releases.length === 30,
      historyError: "",
    };
  }

  async loadMoreHistory() {
    return this.enqueue(async () => {
      if (this.state.historyLoading || !this.state.historyHasMore) return this.snapshot();
      this.setState({ historyLoading: true, historyError: "" });
      try {
        const next = await this.readHistory(this.state.historyPage + 1);
        const entries = new Map(this.state.history.map((item) => [item.tag, item]));
        for (const item of next.history) entries.set(item.tag, item);
        this.setState({ ...next, history: [...entries.values()] });
      } catch (error) {
        this.setState({ historyError: error.message || String(error) });
      } finally {
        this.setState({ historyLoading: false });
      }
      return this.snapshot();
    });
  }

  async readLatest() {
    const feedUrl = this.config.feedUrl || `${API}/repos/${this.config.repository}/releases/latest`;
    let manifest;
    try {
      manifest = await this.requestJson(feedUrl);
    } catch (error) {
      if (error.status !== 404) throw error;
      manifest = { release: await this.requestJson(`${API}/repos/${this.config.repository}/releases/latest`) };
    }
    const release = manifest.release || (manifest.tag_name ? manifest : null);
    if (release) {
      const version = parseVersion(release.tag_name);
      if (!version || version.prerelease || release.draft || release.prerelease) throw Error("正式 Release 版本无效");
      const assetName = `DaGuoNeko-Game-Toolkit-${version.text}-win-x64.zip`;
      const asset = (release.assets || []).find((item) => item.name === assetName);
      const checksum = (release.assets || []).find((item) => item.name === `${assetName}.sha256`);
      return {
        version,
        releaseName: validText(release.name || release.tag_name, 200),
        releaseUrl: this.validReleaseUrl(release.html_url) ? release.html_url : "",
        publishedAt: validText(release.published_at, 100),
        notes: validText(release.body, 50000),
        assetName,
        assetUrl: asset?.browser_download_url || `https://github.com/${this.config.repository}/releases/download/${release.tag_name}/${assetName}`,
        checksumUrl: checksum?.browser_download_url || `https://github.com/${this.config.repository}/releases/download/${release.tag_name}/${assetName}.sha256`,
        hasAsset: !!asset,
        hasChecksum: !!checksum,
      };
    }
    const version = parseVersion(manifest.version);
    if (!version || version.prerelease || manifest.platform !== "win32" || manifest.arch !== "x64") throw Error("更新清单版本或平台无效");
    const assetName = validText(manifest.assetName, 200);
    if (assetName !== `DaGuoNeko-Game-Toolkit-${version.text}-win-x64.zip`) throw Error("更新清单文件名无效");
    const assetUrl = validText(manifest.assetUrl, 1000);
    const checksumUrl = validText(manifest.checksumUrl, 1000);
    if (!this.validDownloadUrl(assetUrl, assetName) || !this.validDownloadUrl(checksumUrl, `${assetName}.sha256`)) throw Error("更新清单下载地址无效");
    if (!/^[a-f0-9]{64}$/i.test(manifest.sha256 || "")) throw Error("更新清单缺少有效的 SHA-256");
    return {
      version,
      releaseName: validText(manifest.releaseName || version.text, 200),
      releaseUrl: this.validReleaseUrl(manifest.releaseUrl) ? manifest.releaseUrl : "",
      publishedAt: validText(manifest.publishedAt, 100),
      notes: validText(manifest.notes, 50000),
      assetName,
      assetUrl,
      checksumUrl,
      sha256: manifest.sha256.toLowerCase(),
      hasAsset: true,
      hasChecksum: true,
    };
  }

  async check() {
    if (this.checkPromise) return this.checkPromise;
    if (BUSY_PHASES.includes(this.state.phase)) return this.snapshot();
    this.checkPromise = this.enqueue(async () => {
      if (BUSY_PHASES.includes(this.state.phase)) return this.snapshot();
      this.setState({ phase: "checking", error: "" });
      let history;
      try {
        history = await this.readHistory(1);
      } catch (error) {
        history = { history: [], historyPage: 0, historyHasMore: false, historyError: error.message };
      }
      try {
        const latest = await this.readLatest();
        const newer = compareVersions(latest.version, this.currentVersion) > 0;
        this.release = latest;
        this.setState({
          ...history,
          phase: newer ? "available" : "up-to-date",
          latestVersion: latest.version.text,
          releaseName: latest.releaseName,
          releaseUrl: latest.releaseUrl,
          publishedAt: latest.publishedAt,
          notes: latest.notes,
          assetName: latest.assetName,
          checkedAt: new Date().toISOString(),
          canDownload: newer && latest.hasAsset && latest.hasChecksum,
          error: newer && (!latest.hasAsset || !latest.hasChecksum)
            ? "该 Release 尚未上传完整的 ZIP 和 SHA-256 校验文件，请稍后重试。"
            : history.historyError ? "已找到版本信息，但近期更新记录暂时无法加载。" : "",
        });
      } catch (error) {
        this.release = null;
        this.setState({
          ...history,
          phase: error.status === 404 ? "no-release" : "error",
          checkedAt: new Date().toISOString(),
          canDownload: false,
          error: error.status === 404 ? "暂时没有可用的正式版本。" : error.name === "TimeoutError" ? "连接更新服务超时，请检查网络后重试。" : error.message || String(error),
        });
      }
      return this.snapshot();
    }).finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async fetchAsset(url, assetName) {
    const initial = new URL(url);
    const apiAsset = initial.origin === API && initial.pathname.startsWith(`/repos/${this.config.repository}/releases/assets/`) && /^\d+$/.test(initial.pathname.split("/").pop());
    if (!apiAsset && !this.validDownloadUrl(url, assetName)) throw Error("更新资产地址无效");
    let current = initial.href;
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await this.fetchImpl(current, { headers: { ...this.headers(), Accept: "application/octet-stream" }, redirect: "manual", signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.ok) throw Error(`无法下载更新文件（HTTP ${response.status}）`);
        return response;
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      const next = new URL(location, current);
      if (!location || next.protocol !== "https:" || next.username || next.password || (next.origin !== API && !next.hostname.endsWith(".githubusercontent.com"))) throw Error("更新下载重定向地址无效");
      current = next.href;
    }
    throw Error("更新下载重定向次数过多");
  }

  async download() {
    return this.enqueue(async () => {
      if (!this.release || this.state.phase !== "available" || !this.state.canDownload) throw Error("请先检查可用更新");
      if (!this.isPackaged) throw Error("开发环境不能安装更新");
      this.setState({ phase: "downloading", progress: 0, error: "" });
      const directory = this.cacheDirectory();
      await fs.mkdir(directory, { recursive: true });
      const archive = path.join(directory, this.release.assetName);
      try {
        let expected = this.release.sha256;
        if (!expected) {
          const checksumResponse = await this.fetchAsset(this.release.checksumUrl, `${this.release.assetName}.sha256`);
          expected = parseChecksum(await checksumResponse.text(), this.release.assetName);
        }
        const response = await this.fetchAsset(this.release.assetUrl, this.release.assetName);
        if (!response.body) throw Error("无法下载更新包");
        const total = Number(response.headers.get("content-length")) || 0;
        let received = 0;
        const digest = crypto.createHash("sha256");
        const stream = Readable.fromWeb(response.body).on("data", (chunk) => {
          received += chunk.length;
          digest.update(chunk);
          this.setState({ progress: total ? Math.min(100, Math.round((received / total) * 100)) : 0 });
        });
        await pipeline(stream, createWriteStream(archive));
        if (digest.digest("hex") !== expected) throw Error("更新包 SHA-256 校验失败");
        const plan = path.join(directory, `update-${this.release.version.text}.json`);
        await fs.writeFile(plan, JSON.stringify({ archive, targetDirectory: this.appDirectory, executablePath: this.executablePath, version: this.release.version.text, sha256: expected, pid: process.pid }), "utf8");
        this.plan = plan;
        this.setState({ phase: "downloaded", progress: 100, error: "" });
      } catch (error) {
        await fs.rm(archive, { force: true });
        this.setState({ phase: "error", error: error.message || String(error) });
      }
      return this.snapshot();
    });
  }

  async install() {
    return this.enqueue(async () => {
      if (this.state.phase !== "downloaded" || !this.plan) throw Error("请先下载更新");
      const allowed = await this.canInstall();
      if (!allowed?.ok) throw Error(allowed?.reason || "请先停止运行中的游戏和房间");
      const helper = path.join(this.cacheDirectory(), `update-helper-${crypto.randomUUID()}.ps1`);
      await fs.copyFile(path.join(this.runtimeRoot, "automation", "update-helper.ps1"), helper);
      const launcher = helper.replace(/\.ps1$/, ".exe");
      await fs.copyFile(path.join(this.runtimeRoot, "native", "update-launcher.exe"), launcher);
      const readyFile = this.plan + ".ready";
      const cancelledFile = this.plan + ".cancelled";
      await fs.rm(readyFile, { force: true });
      await fs.rm(cancelledFile, { force: true });
      const logFile = helper + ".log";
      await fs.writeFile(logFile, "", "utf8");
      this.setState({ phase: "preparing", error: "" });
      let child;
      try {
        child = spawn(launcher, [helper, this.plan, logFile], { detached: true, stdio: "ignore", windowsHide: true });
        await once(child, "spawn");
        let launchError;
        child.on("error", (error) => (launchError = error));
        const deadline = Date.now() + 60000;
        let ready = false;
        while (Date.now() < deadline) {
          if (launchError) throw launchError;
          try {
            const receipt = JSON.parse(await fs.readFile(readyFile, "utf8"));
            ready = receipt.pid === child.pid && receipt.version === this.state.latestVersion;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (ready) break;
          if (child.exitCode !== null) {
            const detail = (await fs.readFile(logFile, "utf8")).trim().slice(0, 2000);
            throw Error("更新脚本未能启动，当前程序已保留。" + (detail || `退出码 ${child.exitCode}`));
          }
          await delay(100);
        }
        if (!ready) throw Error("准备更新超时，当前程序已保留，请重试或查看更新缓存日志");
        const stillAllowed = await this.canInstall();
        if (!stillAllowed?.ok) throw Error(stillAllowed?.reason || "请先停止游戏并保存修改");
        child.unref();
        this.setState({ phase: "installing", error: "" });
        this.requestQuit();
      } catch (error) {
        await fs.writeFile(cancelledFile, "cancelled", "utf8");
        this.setState({ phase: "downloaded", error: error.message || String(error) });
      }
      return this.snapshot();
    });
  }

  enqueue(operation) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
}

module.exports = { UpdateService, parseChecksum };
