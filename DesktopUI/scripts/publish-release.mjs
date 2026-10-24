import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import yauzl from "yauzl";
import config from "../electron/domains/update/update-config.cjs";
import versions from "../shared/update-version.cjs";

const exec = promisify(execFile);
const run = async (command, args) =>
  (
    await exec(command, args, { windowsHide: true, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const parsed = versions.parseVersion(manifest.version);
if (!parsed || parsed.prerelease || parsed.text !== manifest.version)
  throw Error("发布版本必须是完整的正式语义版本号");
const tag = `v${manifest.version}`;
const commit = await run("git", ["rev-parse", "HEAD"]);
if (await run("git", ["status", "--porcelain"]))
  throw Error("发布前请提交源码、文档和版本号，工作区必须干净");
if ((await run("git", ["rev-list", "-n", "1", tag])) !== commit)
  throw Error("发布标签必须指向当前提交");
const notes = path.resolve("../docs/releases", `${manifest.version}.md`);
if (!(await readFile(notes, "utf8")).trim()) throw Error("缺少版本更新说明");
const directory = path.resolve(process.argv[2] || "release");
const archive = path.join(
  directory,
  `DaGuoNeko-Game-Toolkit-${manifest.version}-win-x64.zip`,
);
const checksum = `${archive}.sha256`;
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const expected = `${hash.digest("hex")}  ${path.basename(archive)}`;
if ((await readFile(checksum, "utf8")).trim() !== expected)
  throw Error("ZIP 与校验文件不匹配");
const info = await new Promise((resolve, reject) => {
  yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    let result;
    zip.on("error", reject);
    zip.on("entry", (entry) => {
      if (!/^(?:[^/]+\/)?release-info\.json$/.test(entry.fileName)) {
        zip.readEntry();
        return;
      }
      if (result || entry.uncompressedSize > 16384) {
        zip.close();
        reject(Error("发布元数据无效"));
        return;
      }
      zip.openReadStream(entry, (readError, stream) => {
        if (readError) {
          zip.close();
          reject(readError);
          return;
        }
        const chunks = [];
        stream.on("error", reject);
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () => {
          try {
            result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          } catch (parseError) {
            zip.close();
            reject(parseError);
          }
        });
      });
    });
    zip.on("end", () =>
      result ? resolve(result) : reject(Error("ZIP 缺少发布元数据")),
    );
    zip.readEntry();
  });
});
if (
  info.version !== manifest.version ||
  info.sourceCommit !== commit ||
  info.sourceDirty ||
  info.platform !== "win32" ||
  info.arch !== "x64"
)
  throw Error("ZIP 不是从当前标签的干净源码构建，请重新 npm run package");
const repo = config.repository;
const listed = JSON.parse(
  await run("gh", ["api", `repos/${repo}/releases`, "--paginate", "--slurp"]),
).flat();
const existing = listed.find((release) => release.tag_name === tag);
if (existing && !existing.draft)
  throw Error("该正式版本已经发布；不得覆盖资产，请递增版本号");
if (!existing)
  await run("gh", [
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--verify-tag",
    "--target",
    commit,
    "--title",
    `大果喵游戏工具箱 ${manifest.version}`,
    "--notes-file",
    notes,
    "--draft",
  ]);
else
  await run("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    repo,
    "--notes-file",
    notes,
  ]);
// 仅未发布草稿允许重试覆盖；两个资产全部传完后才对客户端可见。
await run("gh", [
  "release",
  "upload",
  tag,
  archive,
  checksum,
  "--repo",
  repo,
  "--clobber",
]);
await run("gh", [
  "release",
  "edit",
  tag,
  "--repo",
  repo,
  "--draft=false",
  "--latest",
]);
console.log(`已发布 ${tag}：https://github.com/${repo}/releases/tag/${tag}`);
