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
const {
  parseVersion,
  compareVersions,
} = require("../../../shared/update-version.cjs");
const defaultConfig = require("./update-config.cjs");

const API = "https://api.github.com";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_AGENT = "DaGuoNeko-Game-Toolkit-Updater";

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
    authenticated: false,
    account: "",
    authAction: "",
    verificationUri: "",
    userCode: "",
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
    .find(
      (item) =>
        item.endsWith(`  ${assetName}`) || item.endsWith(` *${assetName}`),
    );
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
    protection,
    config = defaultConfig,
    fetchImpl = globalThis.fetch,
    canInstall = async () => ({ ok: true }),
    requestQuit = () => {},
  }) {
    super();
    if (typeof fetchImpl !== "function")
      throw Error("当前运行时不支持网络请求");
    this.currentVersion = currentVersion;
    this.dataRoot = dataRoot;
    this.runtimeRoot = runtimeRoot;
    this.appDirectory = appDirectory;
    this.executablePath = executablePath;
    this.isPackaged = isPackaged;
    this.protection = protection;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.canInstall = canInstall;
    this.requestQuit = requestQuit;
    this.state = defaultState(currentVersion);
    this.state.canInstall = !!isPackaged;
    this.release = null;
    this.authPoll = null;
    this.queue = Promise.resolve();
    this.authEpoch = 0;
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

  authFile() {
    return path.join(this.cacheDirectory(), "github-auth.json");
  }

  async readAuth() {
    try {
      const saved = JSON.parse(await fs.readFile(this.authFile(), "utf8"));
      if (!saved.encrypted || !this.protection) return null;
      const value = JSON.parse(
        this.protection.decryptString(Buffer.from(saved.encrypted, "base64")),
      );
      if (!value.token || typeof value.token !== "string") return null;
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      return null;
    }
  }

  async writeAuth(value) {
    if (!this.protection?.isEncryptionAvailable?.())
      throw Error("当前 Windows 用户无法安全保存 GitHub 授权");
    await fs.mkdir(this.cacheDirectory(), { recursive: true });
    const encrypted = this.protection
      .encryptString(JSON.stringify(value))
      .toString("base64");
    await fs.writeFile(this.authFile(), JSON.stringify({ encrypted }), "utf8");
  }

  async clearAuth() {
    if (["downloading", "preparing", "installing"].includes(this.state.phase))
      throw Error("请等待当前更新操作完成后退出授权");
    this.authEpoch++;
    this.authController?.abort();
    this.authPoll = null;
    await fs.rm(this.authFile(), { force: true });
    this.release = null;
    this.plan = null;
    this.setState({
      ...defaultState(this.currentVersion),
      canInstall: !!this.isPackaged,
    });
  }

  headers(token) {
    return {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
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
      throw Error(`GitHub 返回了无效响应（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      const message =
        response.status === 401
          ? "GitHub 授权已失效，请重新授权"
          : response.status === 403
            ? "GitHub 拒绝请求，请检查仓库权限、组织授权或 API 访问频率"
            : response.status === 404
              ? "GitHub 资源不存在或当前账号无权访问"
              : "GitHub 请求失败，请稍后重试";
      throw Object.assign(Error(`${message}（HTTP ${response.status}）`), {
        status: response.status,
      });
    }
    return body;
  }

  async authState() {
    try {
      const result = JSON.parse(
        await fs.readFile(
          path.join(this.cacheDirectory(), "update-result.json"),
          "utf8",
        ),
      );
      this.setState({
        installation: {
          ok: result.ok === true,
          version: validText(result.version, 100),
          error: validText(result.error, 2000),
          backup: validText(result.backup, 1000),
        },
      });
    } catch {
      /* 尚未安装过更新或结果文件不可读。 */
    }
    const auth = await this.readAuth();
    if (!auth) {
      this.setState({ authenticated: false, account: "" });
      return this.snapshot();
    }
    this.setState({
      authenticated: true,
      account: validText(auth.account, 100),
    });
    return this.snapshot();
  }

  async authorize() {
    if (this.authPoll) return this.snapshot();
    if (this.authStart) return this.authStart;
    this.authStart = this.beginAuthorization().finally(() => {
      this.authStart = null;
    });
    return this.authStart;
  }

  async beginAuthorization() {
    if (!this.config.clientId)
      throw Error("更新服务尚未配置 GitHub OAuth Client ID");
    if (this.authPoll) return this.snapshot();
    const epoch = ++this.authEpoch;
    this.authController = new AbortController();
    const response = await this.fetchImpl(DEVICE_CODE_URL, {
      method: "POST",
      signal: AbortSignal.any([
        this.authController.signal,
        AbortSignal.timeout(30000),
      ]),
      headers: {
        ...this.headers(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        scope: this.config.scope || "",
      }),
    });
    const value = await response.json();
    if (!response.ok || !value.device_code)
      throw Error("无法启动 GitHub 授权，请检查网络和应用的 Device Flow 设置");
    if (value.verification_uri !== "https://github.com/login/device")
      throw Error("GitHub 授权页面地址无效");
    if (epoch !== this.authEpoch) return this.snapshot();
    this.setState({
      phase: "idle",
      authAction: "授权中",
      verificationUri: value.verification_uri,
      userCode: value.user_code || "",
      error: "",
    });
    const interval = Math.max(5, Number(value.interval) || 5) * 1000;
    this.authPoll = this.pollAuthorization(
      value.device_code,
      interval,
      Number(value.expires_in) || 900,
      epoch,
    ).catch((error) => {
      if (epoch === this.authEpoch)
        this.setState({
          authAction: "",
          userCode: "",
          verificationUri: "",
          error: error.message || String(error),
        });
    });
    return this.snapshot();
  }

  async pollAuthorization(deviceCode, interval, expiresIn, epoch) {
    const started = Date.now();
    try {
      while (
        epoch === this.authEpoch &&
        Date.now() - started < expiresIn * 1000
      ) {
        await delay(interval, undefined, {
          signal: this.authController.signal,
        });
        if (epoch !== this.authEpoch) return;
        const response = await this.fetchImpl(ACCESS_TOKEN_URL, {
          method: "POST",
          signal: AbortSignal.any([
            this.authController.signal,
            AbortSignal.timeout(30000),
          ]),
          headers: {
            ...this.headers(),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: this.config.clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        const value = await response.json();
        if (epoch !== this.authEpoch) return;
        if (value.access_token) {
          const user = await this.requestJson(`${API}/user`, {
            headers: this.headers(value.access_token),
          });
          if (epoch !== this.authEpoch) return;
          await this.writeAuth({
            token: value.access_token,
            account: validText(user.login, 100),
          });
          if (epoch !== this.authEpoch) {
            await fs.rm(this.authFile(), { force: true });
            return;
          }
          this.setState({
            authenticated: true,
            account: validText(user.login, 100),
            authAction: "",
            userCode: "",
            verificationUri: "",
          });
          await this.check();
          return;
        }
        if (value.error === "authorization_pending") continue;
        if (value.error === "slow_down") {
          interval += 5000;
          continue;
        }
        throw Error(
          value.error === "access_denied"
            ? "已取消 GitHub 授权"
            : "GitHub 授权已过期或失败，请重试",
        );
      }
      throw Error("GitHub 授权已过期，请重新开始");
    } finally {
      if (epoch === this.authEpoch) this.authPoll = null;
      if (epoch === this.authEpoch && this.state.authAction)
        this.setState({ authAction: "" });
    }
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
      return (
        url.origin === "https://github.com" &&
        !url.username &&
        !url.password &&
        url.pathname.startsWith(`/${this.config.repository}/releases/tag/`)
      );
    } catch {
      return false;
    }
  }

  releaseUrl(tag) {
    const url = tag
      ? this.state.history.find((item) => item.tag === tag)?.url
      : this.state.releaseUrl;
    if (!this.validReleaseUrl(url)) throw Error("更新页面地址无效");
    return url;
  }

  async readHistory(token, page = 1) {
    const releases = await this.requestJson(
      `${API}/repos/${this.config.repository}/releases?per_page=30&page=${page}`,
      { headers: this.headers(token) },
    );
    if (!Array.isArray(releases)) throw Error("GitHub 更新历史响应无效");
    return {
      history: releases
        .filter((item) => !item.draft)
        .map((item) => this.releaseSummary(item)),
      historyPage: page,
      historyHasMore: releases.length === 30,
      historyError: "",
    };
  }

  async loadMoreHistory() {
    return this.enqueue(async () => {
      if (!this.state.historyHasMore) return this.snapshot();
      const epoch = this.authEpoch;
      this.setState({ historyLoading: true, historyError: "" });
      try {
        const auth = await this.readAuth();
        if (!auth) throw Error("请先授权 GitHub");
        const next = await this.readHistory(
          auth.token,
          this.state.historyPage + 1,
        );
        if (epoch !== this.authEpoch) return this.snapshot();
        const entries = new Map(
          this.state.history.map((item) => [item.tag, item]),
        );
        for (const item of next.history) entries.set(item.tag, item);
        this.setState({ ...next, history: [...entries.values()] });
      } catch (error) {
        if (epoch === this.authEpoch)
          this.setState({ historyError: error.message });
      } finally {
        if (epoch === this.authEpoch) this.setState({ historyLoading: false });
      }
      return this.snapshot();
    });
  }

  async check({ automatic = false } = {}) {
    if (this.checkPromise) return this.checkPromise;
    // 下载完成后保留安装计划，后台检查不能覆盖正在进行的更新。
    if (
      ["downloading", "downloaded", "preparing", "installing"].includes(
        this.state.phase,
      )
    )
      return this.snapshot();
    this.checkPromise = this.enqueue(async () => {
      if (
        ["downloading", "downloaded", "preparing", "installing"].includes(
          this.state.phase,
        )
      )
        return this.snapshot();
      const epoch = this.authEpoch;
      const auth = await this.readAuth();
      if (!auth && automatic) return this.snapshot();
      this.setState({ phase: "checking", error: "" });
      try {
        if (!auth) throw Error("请先授权 GitHub");
        // 列表返回 200/空数组和 404 分别表示尚未发布和没有仓库访问权限。
        const history = await this.readHistory(auth.token);
        if (epoch !== this.authEpoch) return this.snapshot();
        this.setState({
          ...history,
          authenticated: true,
          checkedAt: new Date().toISOString(),
        });
        let release;
        try {
          release = await this.requestJson(
            `${API}/repos/${this.config.repository}/releases/latest`,
            { headers: this.headers(auth.token) },
          );
        } catch (error) {
          if (error.status !== 404) throw error;
          if (epoch !== this.authEpoch) return this.snapshot();
          this.release = null;
          return this.setState({
            phase: "no-release",
            latestVersion: null,
            notes: "",
            releaseName: "",
            releaseUrl: "",
            assetName: "",
            canDownload: false,
          });
        }
        if (epoch !== this.authEpoch) return this.snapshot();
        const version = parseVersion(release.tag_name);
        if (
          !version ||
          version.prerelease ||
          release.draft ||
          release.prerelease
        )
          throw Error("GitHub Release 版本无效");
        const assetName = `DaGuoNeko-Game-Toolkit-${version.text}-win-x64.zip`;
        const asset = (release.assets || []).find(
          (item) => item.name === assetName,
        );
        const checksum = (release.assets || []).find(
          (item) => item.name === `${assetName}.sha256`,
        );
        this.release = { release, version, asset, checksum };
        const newer = compareVersions(version, this.currentVersion) > 0;
        const summary = this.releaseSummary(release);
        this.setState({
          phase: newer ? "available" : "up-to-date",
          latestVersion: version.text,
          releaseName: validText(release.name || release.tag_name, 200),
          releaseUrl: summary.url,
          publishedAt: validText(release.published_at, 100),
          notes: validText(release.body, 50000),
          assetName,
          checkedAt: new Date().toISOString(),
          authenticated: true,
          canDownload: newer && !!asset && !!checksum,
          error:
            newer && (!asset || !checksum)
              ? "该 Release 尚未上传完整的 ZIP 和 SHA-256 校验文件，请等待维护者完成发布。"
              : "",
        });
      } catch (error) {
        if (epoch !== this.authEpoch) return this.snapshot();
        this.release = null;
        if (error.status === 401) await this.clearAuth();
        this.setState({
          phase: "error",
          canDownload: false,
          error:
            error.status === 404
              ? "当前 GitHub 授权无法读取此私有仓库。请确认该账号已接受仓库邀请，并检查组织的 OAuth/SSO 授权。（HTTP 404）"
              : error.name === "TimeoutError"
                ? "连接 GitHub 超时，请检查网络后重试"
                : error.message || String(error),
        });
      }
      return this.snapshot();
    }).finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  async fetchAsset(asset, token) {
    const initial = new URL(asset.url);
    if (
      initial.origin !== API ||
      initial.username ||
      initial.password ||
      !initial.pathname.startsWith(
        `/repos/${this.config.repository}/releases/assets/`,
      ) ||
      !/^\d+$/.test(initial.pathname.split("/").pop())
    )
      throw Error("更新资产地址无效");
    let url = initial.href;
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await this.fetchImpl(url, {
        headers: {
          ...this.headers(new URL(url).origin === API ? token : null),
          Accept: "application/octet-stream",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.ok)
          throw Error(`无法下载更新文件（HTTP ${response.status}）`);
        return response;
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      const next = new URL(location, url);
      if (
        !location ||
        next.protocol !== "https:" ||
        next.username ||
        next.password ||
        !(
          next.origin === API ||
          next.hostname.endsWith(".githubusercontent.com")
        )
      )
        throw Error("更新下载重定向地址无效");
      url = next.href;
    }
    throw Error("更新下载重定向次数过多");
  }

  async download() {
    return this.enqueue(async () => {
      if (
        !this.release ||
        this.state.phase !== "available" ||
        !this.state.canDownload
      )
        throw Error("请先检查可用更新");
      if (!this.isPackaged) throw Error("开发环境不能安装更新");
      const auth = await this.readAuth();
      if (!auth) throw Error("请先授权 GitHub");
      this.setState({ phase: "downloading", progress: 0, error: "" });
      const directory = this.cacheDirectory();
      await fs.mkdir(directory, { recursive: true });
      const archive = path.join(directory, this.release.asset.name);
      try {
        const checksumResponse = await this.fetchAsset(
          this.release.checksum,
          auth.token,
        );
        const expected = parseChecksum(
          await checksumResponse.text(),
          this.release.asset.name,
        );
        const response = await this.fetchAsset(this.release.asset, auth.token);
        if (!response.ok || !response.body) throw Error("无法下载更新包");
        const total = Number(response.headers.get("content-length")) || 0;
        let received = 0;
        const digest = crypto.createHash("sha256");
        const stream = Readable.fromWeb(response.body).on("data", (chunk) => {
          received += chunk.length;
          digest.update(chunk);
          this.setState({
            progress: total
              ? Math.min(100, Math.round((received / total) * 100))
              : 0,
          });
        });
        await pipeline(stream, createWriteStream(archive));
        const actual = digest.digest("hex");
        if (actual !== expected) throw Error("更新包 SHA-256 校验失败");
        const plan = path.join(
          directory,
          `update-${this.release.version.text}.json`,
        );
        await fs.writeFile(
          plan,
          JSON.stringify({
            archive,
            targetDirectory: this.appDirectory,
            executablePath: this.executablePath,
            version: this.release.version.text,
            sha256: expected,
            pid: process.pid,
          }),
          "utf8",
        );
        this.plan = plan;
        this.setState({ phase: "downloaded", progress: 100, error: "" });
      } catch (error) {
        await fs.rm(archive, { force: true });
        this.setState({
          phase: "error",
          error: error.message || String(error),
        });
      }
      return this.snapshot();
    });
  }

  async install() {
    return this.enqueue(async () => {
      if (this.state.phase !== "downloaded" || !this.plan)
        throw Error("请先下载更新");
      const allowed = await this.canInstall();
      if (!allowed?.ok)
        throw Error(allowed?.reason || "请先停止运行中的游戏和房间");
      // 更新进程从缓存运行，避免脚本自身留在即将被替换的程序目录。
      const helper = path.join(
        this.cacheDirectory(),
        `update-helper-${crypto.randomUUID()}.ps1`,
      );
      await fs.copyFile(
        path.join(this.runtimeRoot, "automation", "update-helper.ps1"),
        helper,
      );
      const launcher = helper.replace(/\.ps1$/, ".exe");
      await fs.copyFile(
        path.join(this.runtimeRoot, "native", "update-launcher.exe"),
        launcher,
      );
      const readyFile = this.plan + ".ready";
      const cancelledFile = this.plan + ".cancelled";
      await fs.rm(readyFile, { force: true });
      await fs.rm(cancelledFile, { force: true });
      const logFile = helper + ".log";
      await fs.writeFile(logFile, "", "utf8");
      this.setState({ phase: "preparing", error: "" });
      let child;
      try {
        child = spawn(
          launcher,
          [helper, this.plan, logFile],
          // 由无控制台的独立启动器托管 PowerShell，避免随主程序退出或空启动。
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        await once(child, "spawn");
        let launchError;
        child.on("error", (error) => {
          launchError = error;
        });
        const deadline = Date.now() + 60000;
        let ready = false;
        while (Date.now() < deadline) {
          if (launchError) throw launchError;
          try {
            const receipt = JSON.parse(await fs.readFile(readyFile, "utf8"));
            ready =
              receipt.pid === child.pid &&
              receipt.version === this.state.latestVersion;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (ready) break;
          if (child.exitCode !== null) {
            const detail = (await fs.readFile(logFile, "utf8"))
              .trim()
              .slice(0, 2000);
            throw Error(
              "更新脚本未能启动，当前程序已保留。" +
                (detail || `退出码 ${child.exitCode}`),
            );
          }
          await delay(100);
        }
        if (!ready)
          throw Error("准备更新超时，当前程序已保留，请重试或查看更新缓存日志");
        const stillAllowed = await this.canInstall();
        if (!stillAllowed?.ok)
          throw Error(stillAllowed?.reason || "请先停止游戏并保存修改");
        child.unref();
        this.setState({ phase: "installing", error: "" });
        this.requestQuit();
      } catch (error) {
        await fs.writeFile(cancelledFile, "cancelled", "utf8");
        this.setState({
          phase: "downloaded",
          error: error.message || String(error),
        });
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
