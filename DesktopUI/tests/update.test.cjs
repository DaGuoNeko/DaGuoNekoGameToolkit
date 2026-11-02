const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const {
  UpdateService,
  parseChecksum,
} = require("../electron/domains/update/update-service.cjs");
const {
  parseVersion,
  compareVersions,
} = require("../shared/update-version.cjs");

const protection = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8"),
};

test("update versions compare stable and prerelease values", () => {
  assert.deepEqual(parseVersion("v1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: "",
    text: "1.2.3",
  });
  assert.equal(compareVersions("1.2.3", "1.2.3-beta.1"), 1);
  assert.equal(compareVersions("1.2.3-beta.2", "1.2.3-beta.10"), -1);
  assert.equal(compareVersions("1.2.4", "1.2.3"), 1);
});

test("public GitHub release check validates the anonymous release asset", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-update-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("zip fixture");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const assetName = "DaGuoNeko-Game-Toolkit-0.1.1-win-x64.zip";
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/releases?")) return Response.json([]);
    if (url.endsWith("/releases/latest"))
      return new Response(
        JSON.stringify({
          tag_name: "v0.1.1",
          name: "工具箱 0.1.1",
          body: "修复更新流程",
          html_url:
            "https://github.com/DaGuoNeko/DaGuoNekoGameToolkit/releases/tag/v0.1.1",
          published_at: "2026-10-24T00:00:00Z",
          assets: [
            {
              name: assetName,
              url: "https://api.github.com/repos/DaGuoNeko/DaGuoNekoGameToolkit/releases/assets/1",
              browser_download_url: "https://api.github.com/repos/DaGuoNeko/DaGuoNekoGameToolkit/releases/assets/1",
            },
            {
              name: `${assetName}.sha256`,
              url: "https://api.github.com/repos/DaGuoNeko/DaGuoNekoGameToolkit/releases/assets/2",
              browser_download_url: "https://api.github.com/repos/DaGuoNeko/DaGuoNekoGameToolkit/releases/assets/2",
            },
          ],
        }),
        { status: 200 },
      );
    if (url.endsWith("/assets/2"))
      return new Response(`${digest}  ${assetName}\n`, { status: 200 });
    if (url.endsWith("/assets/1"))
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(bytes.length) }),
        body: Readable.toWeb(Readable.from([bytes])),
      };
    throw Error(`unexpected URL ${url}`);
  };
  const service = new UpdateService({
    currentVersion: "0.1.0",
    dataRoot: root,
    runtimeRoot: root,
    appDirectory: path.join(root, "app"),
    executablePath: path.join(root, "app", "DaGuoNeko-Game-Toolkit.exe"),
    isPackaged: true,
    protection,
    config: {
      repository: "DaGuoNeko/DaGuoNekoGameToolkit",
      feedUrl: "https://api.github.com/repos/DaGuoNeko/DaGuoNekoGameToolkit/releases/latest",
    },
    fetchImpl,
  });
  const available = await service.check();
  assert.equal(available.phase, "available");
  assert.equal(available.latestVersion, "0.1.1");
  assert.equal(available.assetName, assetName);
  const downloaded = await service.download();
  assert.equal(downloaded.phase, "downloaded");
  assert.equal(downloaded.progress, 100);
  assert.equal((await service.check()).phase, "downloaded");
  assert.ok(
    calls.includes(
      "https://api.github.com/repos/DaGuoNeko/DaGuoNekoGameToolkit/releases/latest",
    ),
  );
  assert.equal(parseChecksum(`${digest}  ${assetName}\n`, assetName), digest);
});

const repository = "DaGuoNeko/DaGuoNekoGameToolkit";
const endpoint = `https://api.github.com/repos/${repository}`;
const release = (tag = "v0.1.1") => ({
  tag_name: tag,
  name: `版本 ${tag}`,
  body: "修复问题\n保留原有数据",
  html_url: `https://github.com/${repository}/releases/tag/${tag}`,
  published_at: "2026-10-24T00:00:00Z",
  assets: [],
});
async function fixture(t, fetchImpl) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-update-test-"));
  await fs.mkdir(path.join(root, "update"), { recursive: true });
  t.after(async () => {
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const service = new UpdateService({
    currentVersion: "0.1.0",
    dataRoot: root,
    runtimeRoot: root,
    appDirectory: path.join(root, "app"),
    executablePath: path.join(root, "app", "DaGuoNeko-Game-Toolkit.exe"),
    isPackaged: true,
    protection,
    config: { repository, clientId: "fixture", scope: "repo" },
    fetchImpl,
  });
  return service;
}

test("empty releases is distinct from a public repository request failure", async (t) => {
  let denied = false;
  const service = await fixture(t, async (url) => {
    if (!denied && url.includes("/releases?")) return Response.json([]);
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  assert.equal((await service.check()).phase, "no-release");
  denied = true;
  const result = await service.check();
  assert.equal(result.phase, "no-release");
  assert.match(result.error, /暂时没有|更新服务请求失败/);
  assert.equal(result.canDownload, false);
});

test("history includes prereleases, filters drafts and paginates without duplicate tags", async (t) => {
  const releases = Array.from({ length: 30 }, (_, i) => release(`v0.0.${i}`));
  releases[0].draft = true;
  releases[1].prerelease = true;
  const service = await fixture(t, async (url) =>
    Response.json(
      url.endsWith("/latest")
        ? release()
        : url.endsWith("page=1")
          ? releases
          : [releases[29], release("v0.0.99")],
    ),
  );
  const state = await service.check();
  assert.equal(state.history.length, 29);
  assert.equal(state.history[0].prerelease, true);
  assert.equal(state.historyHasMore, true);
  assert.equal(state.canDownload, false);
  assert.match(state.error, /尚未上传完整|更新服务请求失败/);
  state.history[0].notes = "mutation";
  assert.notEqual(service.snapshot().history[0].notes, "mutation");
  const next = await service.loadMoreHistory();
  assert.equal(next.history.length, 30);
  assert.equal(next.historyHasMore, false);
  assert.equal(next.phase, "available");
  assert.equal(
    service.releaseUrl("v0.0.99"),
    `https://github.com/${repository}/releases/tag/v0.0.99`,
  );
  assert.throws(() => service.releaseUrl("unknown"), /无效/);
});

test("concurrent checks coalesce", async (t) => {
  let resolve,
    calls = 0;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const service = await fixture(t, async () => {
    calls++;
    await pending;
    return Response.json([]);
  });
  const a = service.check(),
    b = service.check();
  await new Promise((r) => setTimeout(r, 30));
  resolve();
  await Promise.all([a, b]);
  assert.equal(calls, 2);
});

test("public asset redirects carry no credentials and reject untrusted origins", async (t) => {
  const calls = [];
  const service = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith(endpoint))
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://release-assets.githubusercontent.com/fixture",
        },
      });
    return new Response("bytes");
  });
  await service.fetchAsset(`${endpoint}/releases/assets/1`, "asset.zip");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  await assert.rejects(
    service.fetchAsset("https://example.test/asset", "asset.zip"),
    /地址无效/,
  );
  assert.equal(calls.length, 2);
  service.fetchImpl = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://example.test/steal" },
    });
  await assert.rejects(
    service.fetchAsset(`${endpoint}/releases/assets/1`, "asset.zip"),
    /地址无效/,
  );
});

test("corrupt download is removed and cannot produce an install plan", async (t) => {
  const assetName = "DaGuoNeko-Game-Toolkit-0.1.1-win-x64.zip";
  const value = {
    ...release(),
    assets: [
      { name: assetName, url: `${endpoint}/releases/assets/1`, browser_download_url: `${endpoint}/releases/assets/1` },
      { name: `${assetName}.sha256`, url: `${endpoint}/releases/assets/2`, browser_download_url: `${endpoint}/releases/assets/2` },
    ],
  };
  const service = await fixture(t, async (url) => {
    if (url.endsWith("/assets/1")) return new Response("damaged bytes");
    if (url.endsWith("/assets/2"))
      return new Response(`${"0".repeat(64)}  ${assetName}`);
    return Response.json(url.endsWith("/latest") ? value : [value]);
  });
  await service.check();
  const failed = await service.download();
  assert.equal(failed.phase, "error");
  assert.match(failed.error, /SHA-256/);
  await assert.rejects(
    fs.access(path.join(service.cacheDirectory(), assetName)),
    { code: "ENOENT" },
  );
  assert.equal(service.plan, undefined);
  await assert.rejects(service.install(), /请先下载更新/);
});

test("a fresh checkout has a public update feed without credentials", () => {
  const config = require("../electron/domains/update/update-config.cjs");
  assert.equal(config.repository, repository);
  assert.match(config.feedUrl, /releases\/latest\/download\/latest\.json$/);
});

test("a prerelease tag cannot become an install target even when GitHub marks it stable", async (t) => {
  const value = release("v0.2.0-beta.1");
  const service = await fixture(t, async (url) =>
    Response.json(url.endsWith("/latest") ? value : [value]),
  );
  const state = await service.check();
  assert.equal(state.phase, "error");
  assert.equal(state.canDownload, false);
  assert.equal(state.history.length, 1);
});

test(
  "installer startup without a ready receipt keeps the client open",
  { skip: process.platform !== "win32" },
  async (t) => {
    const service = await fixture(t, async () => {
      throw Error("Unexpected network call");
    });
    await fs.mkdir(path.join(service.runtimeRoot, "native"), {
      recursive: true,
    });
    await fs.copyFile(
      path.resolve("runtime/native/update-launcher.exe"),
      path.join(service.runtimeRoot, "native/update-launcher.exe"),
    );
    await fs.mkdir(path.join(service.runtimeRoot, "automation"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(service.runtimeRoot, "automation/update-helper.ps1"),
      "exit 0\n",
      "utf8",
    );
    service.plan = path.join(service.cacheDirectory(), "install.json");
    await fs.writeFile(service.plan, "{}", "utf8");
    service.setState({ phase: "downloaded", latestVersion: "0.1.1" });
    let quit = false;
    service.requestQuit = () => {
      quit = true;
    };
    const state = await service.install();
    assert.equal(quit, false);
    assert.equal(state.phase, "downloaded");
    assert.match(state.error, /更新脚本未能启动/);
  },
);

test(
  "installer rechecks active work after preparing and cancels without quitting",
  { skip: process.platform !== "win32" },
  async (t) => {
    const service = await fixture(t, async () => {
      throw Error("Unexpected network call");
    });
    await fs.mkdir(path.join(service.runtimeRoot, "native"), {
      recursive: true,
    });
    await fs.copyFile(
      path.resolve("runtime/native/update-launcher.exe"),
      path.join(service.runtimeRoot, "native/update-launcher.exe"),
    );
    await fs.mkdir(path.join(service.runtimeRoot, "automation"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(service.runtimeRoot, "automation/update-helper.ps1"),
      `param([string]$Plan,[int]$LauncherPid)\n[IO.File]::WriteAllText($Plan+'.ready', ('{"pid":'+$LauncherPid+',"version":"0.1.1"}'))\nStart-Sleep -Milliseconds 600\n`,
      "utf8",
    );
    service.plan = path.join(service.cacheDirectory(), "install.json");
    await fs.writeFile(service.plan, "{}", "utf8");
    service.setState({ phase: "downloaded", latestVersion: "0.1.1" });
    let checks = 0,
      quit = false;
    service.canInstall = async () =>
      ++checks === 1 ? { ok: true } : { ok: false, reason: "游戏刚刚启动" };
    service.requestQuit = () => {
      quit = true;
    };
    const state = await service.install();
    assert.equal(quit, false);
    assert.equal(state.phase, "downloaded");
    assert.match(state.error, /游戏刚刚启动/);
    await fs.access(service.plan + ".cancelled");
  },
);
