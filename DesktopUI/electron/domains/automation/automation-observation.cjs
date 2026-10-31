const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const gameplayUIs = ["hud_screen", "hud.hud_screen", "in_game_play_screen"];

async function queryWindow(runtime, worker, bridge, assertionId, capture) {
  if (!runtime || !bridge?.minecraftPid) throw Error("WINDOW_PROBE_UNAVAILABLE");
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(runtime, "automation/automation-window.ps1"),
    "-GameProcessId", String(bridge.minecraftPid),
    "-LauncherProcessId", String(worker.session.pid),
    "-GamePath", worker.sourceSnapshot.config.game_executable_path,
  ];
  if (assertionId) args.push("-AssertionId", assertionId);
  if (capture) args.push("-Capture", "-WindowHandle", String(capture.window.hwnd), "-ProcessCreatedAt", capture.processCreatedAt);
  let stdout;
  try {
    ({ stdout } = await execFile(
      path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      args, { windowsHide: true, timeout: 10000, maxBuffer: capture ? 24 * 1024 * 1024 : 128 * 1024, encoding: "utf8" },
    ));
  } catch (error) {
    if (!error.stdout) throw Error("WINDOW_PROBE_FAILED_OR_RESULT_UNKNOWN");
    stdout = error.stdout;
  }
  const response = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  if (!response.ok) throw Error(response.error || "WINDOW_PROBE_FAILED");
  return response.value;
}
function inspectWindow(runtime, worker, bridge, assertionId) {
  return queryWindow(runtime, worker, bridge, assertionId);
}
async function captureWindow(runtime, worker, bridge, snapshot) {
  if (!snapshot.window || !snapshot.window.visible || snapshot.window.minimized) throw Error("WINDOW_NOT_CAPTURABLE");
  const frame = await queryWindow(runtime, worker, bridge, null, snapshot);
  return {...frame, data: Buffer.from(frame.data, "base64")};
}

const readinessCode = `# DGN_AUTOMATION_READINESS
import mod.client.extraClientApi as api
import clientlevel
p=api.GetLocalPlayerId()
f=api.GetEngineCompFactory()
valid=p is not None and str(p) not in ('-1','0','')
pos=f.CreatePos(p).GetFootPos() if valid else None
_result={'playerId':str(p) if valid else None,'position':pos,'world':clientlevel.get_level_name(),'topUI':api.GetTopUI() if hasattr(api,'GetTopUI') else None}
`;

module.exports = { inspectWindow, captureWindow, readinessCode, gameplayUIs };
