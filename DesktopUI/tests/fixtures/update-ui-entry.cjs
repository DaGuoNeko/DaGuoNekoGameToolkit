// 只替换网络边界；界面、preload、IPC 与更新服务均使用构建产物。
const fs = require("node:fs/promises");
const path = require("node:path");
const { app, net, dialog } = require("electron");
dialog.showErrorBox = (title, message) => {
  console.error(title + ": " + message);
  app.exit(1);
};
const root = path.resolve(__dirname, "../..");
app.setAppPath(root);
app.getVersion = () => require(path.join(root, "package.json")).version;
const repository = "DaGuoNeko/DaGuoNekoGameToolkit";
const value = (version) => ({
  tag_name: `v${version}`,
  name: `大果喵游戏工具箱 ${version}`,
  body: "更新内容\n\n- 支持历史版本和手动检查更新\n- 保留存档、模组和配置\n- 修复私有仓库下载\n\n<script>不能执行更新说明中的 HTML</script>",
  html_url: `https://github.com/${repository}/releases/tag/v${version}`,
  published_at: "2026-10-24T00:00:00Z",
  assets: [
    {
      name: `DaGuoNeko-Game-Toolkit-${version}-win-x64.zip`,
      url: `https://api.github.com/repos/${repository}/releases/assets/1`,
    },
    {
      name: `DaGuoNeko-Game-Toolkit-${version}-win-x64.zip.sha256`,
      url: `https://api.github.com/repos/${repository}/releases/assets/2`,
    },
  ],
});
const actualFetch = net.fetch.bind(net);
net.fetch = async (url, options) => {
  if (String(url).startsWith("file:")) return actualFetch(url, options);
  const mode = await fs.readFile(
    process.env.DGN_UPDATE_FIXTURE_CONTROL,
    "utf8",
  );
  if (url.startsWith("https://github.com/")) {
    if (mode === "denied") return Response.json({ message: "failure" }, { status: 503 });
    if (!url.endsWith("latest.json")) return new Response("fixture");
    if (mode === "empty") return Response.json({ message: "Not Found" }, { status: 404 });
    const version = mode === "current" ? app.getVersion() : mode === "future" ? "99.0.1" : "99.0.0";
    return Response.json({
      version,
      platform: "win32",
      arch: "x64",
      releaseName: `大果喵游戏工具箱 ${version}`,
      releaseUrl: `https://github.com/${repository}/releases/tag/v${version}`,
      assetName: `DaGuoNeko-Game-Toolkit-${version}-win-x64.zip`,
      assetUrl: `https://github.com/${repository}/releases/download/v${version}/DaGuoNeko-Game-Toolkit-${version}-win-x64.zip`,
      checksumUrl: `https://github.com/${repository}/releases/download/v${version}/DaGuoNeko-Game-Toolkit-${version}-win-x64.zip.sha256`,
      sha256: "0".repeat(64),
      notes: "更新内容\n\n- 公开更新测试",
    });
  }
  if (!url.startsWith(`https://api.github.com/repos/${repository}/`)) throw Error("Unexpected fixture URL");
  if (mode === "denied")
    return Response.json({ message: "Not Found" }, { status: 404 });
  if (url.endsWith("/latest")) {
    if (mode === "empty")
      return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json(
      value(mode === "current" ? app.getVersion() : mode === "future" ? "99.0.1" : "99.0.0"),
    );
  }
  if (url.includes("/releases?")) {
    if (mode === "empty") return Response.json([]);
    if (url.endsWith("page=2")) return Response.json([value("0.0.1")]);
    return Response.json([
      value("99.0.0"),
      ...Array.from({ length: 29 }, (_, i) => value(`1.0.${29 - i}`)),
    ]);
  }
  throw Error("Unexpected fixture path");
};
require(path.join(root, "dist/main.cjs"));
