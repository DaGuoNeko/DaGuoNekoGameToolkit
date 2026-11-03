const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const repoRoot = path.resolve(__dirname, "../../..");
const task = (process.env.DGN_ARTIFACT_TASK || path.basename(process.argv[1] || "ui-acceptance", path.extname(process.argv[1] || "")))
  .replace(/[^a-zA-Z0-9._-]+/g, "-");
const defaultRoot = path.join(
  repoRoot,
  ".miao",
  "work",
  task + "-" +
    new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14) +
    "-" +
    crypto.randomBytes(3).toString("hex"),
);
const root = path.resolve(process.env.DGN_ARTIFACT_ROOT || defaultRoot);
const workRoot = path.join(repoRoot, ".miao", "work");
if (root !== workRoot && !root.toLowerCase().startsWith(workRoot.toLowerCase() + path.sep))
  throw Error("验收产物根目录必须位于 .miao/work 下");

function ensureArtifactRoot() {
  fs.mkdirSync(root, { recursive: true });
  const manifest = path.join(root, "manifest.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      JSON.stringify(
        {
          schema: 1,
          id: path.basename(root),
          kind: "ui-acceptance",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
          status: "running",
          preserve: false,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
  return root;
}

function artifactPath(relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    throw Error("无效验收产物路径");
  const target = path.resolve(ensureArtifactRoot(), relative);
  if (target !== root && !target.toLowerCase().startsWith(root.toLowerCase() + path.sep))
    throw Error("验收产物路径越界");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

const artifactRoot = ensureArtifactRoot();
const testResultsRoot = artifactPath("outputs");
process.on("exit", (code) => {
  try {
    const manifestPath = path.join(artifactRoot, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.status = code === 0 ? "passed" : "failed";
    manifest.completedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  } catch {}
});

module.exports = { artifactPath, artifactRoot, ensureArtifactRoot, testResultsRoot };
