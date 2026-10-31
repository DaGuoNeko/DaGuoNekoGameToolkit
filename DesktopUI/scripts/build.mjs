import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { stripWasmDebug } from "./wasm-release.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import updateConfig from "../electron/domains/update/update-config.cjs";
if (process.platform === "win32") {
  await promisify(execFile)(
    path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/build-capture.ps1")],
    { windowsHide: true },
  );
  await promisify(execFile)(
    path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/build-update.ps1")],
    { windowsHide: true },
  );
  await promisify(execFile)(
    path.join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("scripts/build-network.ps1"),
    ],
    { windowsHide: true },
  );
}
await mkdir("dist", { recursive: true });
await rm("dist/capture.html", { force: true });
await rm("runtime/automation/automation-window.cs", { force: true });
await build({
  entryPoints: ["src/app/main.jsx"],
  bundle: true,
  minify: true,
  outfile: "dist/app.js",
  platform: "browser",
  mainFields: ["module", "main"],
  target: "chrome142",
  jsx: "automatic",
  loader: { ".wasm": "binary" },
  plugins: [
    {
      name: "release-wasm",
      setup(builder) {
        builder.onLoad({ filter: /\.wasm$/ }, async ({ path: file }) => ({
          contents: stripWasmDebug(await readFile(file)),
          loader: "binary",
        }));
      },
    },
  ],
  define: { "process.env.NODE_ENV": '"production"' },
});
await build({
  entryPoints: ["electron/main.cjs"],
  bundle: true,
  outfile: "dist/main.cjs",
  platform: "node",
  mainFields: ["module", "main"],
  target: "node22",
  external: ["electron"],
});
await copyFile("electron/preload.cjs", "dist/preload.cjs");
await build({
  entryPoints: ["electron/isolation-worker.cjs"],
  bundle: true,
  outfile: "dist/isolation-worker.cjs",
  platform: "node",
  target: "node22",
  external: ["electron"],
});
await copyFile("src/index.html", "dist/index.html");
await build({
  entryPoints: ["electron/game-title-worker.cjs"],
  bundle: true,
  outfile: "dist/game-title-worker.cjs",
  platform: "node",
  target: "node22",
});
await copyFile("assets/icon.ico", "dist/icon.ico");
await mkdir("runtime/automation", { recursive: true });
await writeFile(
  "runtime/update-config.json",
  JSON.stringify(updateConfig, null, 2) + "\n",
  "utf8",
);
await copyFile("electron/ore-window.ps1", "runtime/automation/ore-window.ps1");
await copyFile("electron/automation-window.ps1", "runtime/automation/automation-window.ps1");
await copyFile(
  "electron/content-log-owner.ps1",
  "runtime/automation/content-log-owner.ps1",
);
await copyFile(
  "electron/update-helper.ps1",
  "runtime/automation/update-helper.ps1",
);
await build({
  entryPoints: ["electron/domains/automation/automation-stdio.cjs"],
  bundle: true,
  outfile: "dist/toolbox-mcp.cjs",
  platform: "node",
  target: "node22",
});
