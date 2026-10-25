const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const safePath = (value, label) => {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value))
    throw Error(label + "必须是绝对路径");
  return path.resolve(value);
};
async function statFile(pathname, label, directory = false) {
  const stat = await fs.stat(pathname).catch((error) => {
    throw Error(label + "不存在：" + error.message);
  });
  if (directory ? !stat.isDirectory() : !stat.isFile())
    throw Error(label + (directory ? "不是目录" : "不是文件"));
}

function convertChunker({ javaPath, chunkerJar, outputDirectory, format = "BEDROCK_1_20_80", signal, onOutput }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error("Chunker 转换已取消"));
    const child = spawn("java", ["-jar", chunkerJar, "-i", javaPath, "-f", format, "-o", outputDirectory], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", settled = false;
    const cancel = () => {
      child.kill();
      finish(Error("Chunker 转换已取消"));
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      error ? reject(error) : resolve(result);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        const text = String(chunk);
        if (stream === child.stdout) stdout = (stdout + text).slice(-32000);
        else stderr = (stderr + text).slice(-32000);
        onOutput?.(text);
      });
    child.once("error", (error) => finish(Error("无法启动 Chunker：" + error.message)));
    child.once("close", async (code) => {
      if (settled) return;
      if (code !== 0) return finish(Error("Chunker 转换失败（" + code + "）：" + (stderr || stdout).slice(-4000)));
      try {
        let worldDirectory = outputDirectory;
        if (!(await fs.stat(path.join(worldDirectory, "level.dat")).catch(() => null))) {
          const candidates = await fs.readdir(outputDirectory, { withFileTypes: true });
          const worlds = [];
          for (const entry of candidates) {
            if (!entry.isDirectory()) continue;
            if (await fs.stat(path.join(outputDirectory, entry.name, "level.dat")).catch(() => null)) {
              worlds.push(path.join(outputDirectory, entry.name));
            }
          }
          if (worlds.length !== 1) throw Error("Chunker 没有生成唯一的基岩世界");
          worldDirectory = worlds[0];
        }
        await statFile(path.join(worldDirectory, "level.dat"), "Chunker 输出世界");
        await statFile(path.join(worldDirectory, "db"), "Chunker 输出数据库", true);
        finish(null, { outputDirectory: worldDirectory, stdout, stderr });
      } catch (error) { finish(error); }
    });
  });
}

async function prepareChunker({ javaPath, chunkerJar, outputRoot, format, signal, onOutput }) {
  javaPath = safePath(javaPath, "Java 世界目录");
  chunkerJar = safePath(chunkerJar, "Chunker CLI JAR");
  outputRoot = safePath(outputRoot, "转换输出目录");
  await statFile(javaPath, "Java 世界目录", true);
  await statFile(path.join(javaPath, "level.dat"), "Java 世界 level.dat");
  await statFile(chunkerJar, "Chunker CLI JAR");
  if (!/\.jar$/i.test(chunkerJar)) throw Error("请选择 Chunker CLI JAR 文件");
  if (format && !/^BEDROCK_\d+_\d+_\d+$/.test(format)) throw Error("转换输出格式无效");
  await fs.mkdir(outputRoot, { recursive: true });
  const outputDirectory = path.join(outputRoot, crypto.randomUUID());
  await fs.mkdir(outputDirectory);
  return convertChunker({ javaPath, chunkerJar, outputDirectory, format, signal, onOutput });
}

module.exports = { prepareChunker, safePath };
