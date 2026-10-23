const fs = require("node:fs/promises"),
  path = require("node:path");
const execFile = require("node:util").promisify(
  require("node:child_process").execFile,
);
const normalized = (s) =>
  String(s).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
function boxes(frame) {
  return frame.lines
    .filter((l) => l.words?.length)
    .map((l) => {
      const x = Math.min(...l.words.map((w) => w.x)),
        y = Math.min(...l.words.map((w) => w.y));
      const right = Math.max(...l.words.map((w) => w.x + w.width)),
        bottom = Math.max(...l.words.map((w) => w.y + w.height));
      return {
        text: normalized(l.text),
        x,
        y,
        width: right - x,
        height: bottom - y,
      };
    });
}
function uniqueBoxes(items) {
  const result = [];
  for (const b of items)
    if (
      !result.some(
        (a) => Math.abs(a.x - b.x) < 0.02 && Math.abs(a.y - b.y) < 0.02,
      )
    )
      result.push(b);
  return result;
}
function locateMenu(frame, room, hostName, allowDownload = false) {
  const all = boxes(frame),
    exact = (names) =>
      all.filter((b) => names.map(normalized).includes(b.text));
  if (
    all.some((b) =>
      /无法连接.*世界|无法连接.*服务器|unabletoconnecttoworld|serverisfull|服务器已满/.test(
        b.text,
      ),
    )
  )
    return { kind: "error", message: "游戏显示连接失败或房间已满" };
  if (allowDownload) {
    const download = uniqueBoxes(
      exact([
        "下载并加入",
        "下载并加入游戏",
        "Download & Join",
        "Download and Join",
      ]),
    );
    if (download.length === 1) return { kind: "download", box: download[0] };
  }
  const lan = uniqueBoxes(exact(["局域网世界", "LAN World", "LAN Worlds"]));
  const worlds = lan.length || exact(["创建新世界", "Create New World"]).length;
  if (worlds) {
    const titles = exact([room]);
    const pairs = [];
    for (const badge of lan) {
      // Only the native LAN card under its badge; never the local save cards.
      const nearby = (b) =>
        b.y > badge.y &&
        b.y - badge.y < 0.34 &&
        Math.abs(b.x - badge.x) < 0.035;
      const matches = titles.filter(nearby);
      if (matches.length) pairs.push(...matches);
    }
    const targets = uniqueBoxes(pairs);
    if (targets.length > 1)
      return {
        kind: "error",
        message: "有多张同名局域网房间卡片，无法确定主房间",
      };
    if (targets.length === 1) return { kind: "room", box: targets[0] };
    return {
      kind: "waiting",
      message: "等待识别目标局域网房间；不会点击本地存档或其他房间",
    };
  }
  // Pixel-font OCR sometimes drops/misreads 游. This only opens the menu;
  // room selection below still requires a LAN badge and exact identity text.
  const play = uniqueBoxes(
    all.filter((b) => b.text === "play" || /^开始.?戏$/.test(b.text)),
  );
  if (play.length === 1 && exact(["设置", "Settings"]).length)
    return { kind: "play", box: play[0] };
  return { kind: "waiting", message: "等待受支持的游戏主菜单或局域网卡片" };
}
class JoinMenu {
  constructor(runtime, { exec = execFile } = {}) {
    this.script = path.join(runtime, "automation/menu-ocr.ps1");
    this.exec = exec;
  }
  async invoke(worker, pid, options) {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.script,
      "-GameProcessId",
      String(pid),
      "-LauncherProcessId",
      String(worker.session.pid),
      "-GamePath",
      worker.sourceSnapshot.config.game_executable_path,
    ];
    for (const [key, value] of Object.entries(options))
      args.push("-" + key, String(value));
    let stdout;
    try {
      ({ stdout } = await this.exec(
        path.join(
          process.env.SystemRoot,
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        args,
        {
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        },
      ));
    } catch (e) {
      stdout = e.stdout;
      if (!stdout) throw Error("菜单识别助手未完成：" + e.message);
    }
    let value;
    try {
      value = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    } catch {
      throw Error("菜单识别助手未返回有效结果");
    }
    if (!value.ok) {
      const messages = {
        GAME_ASSERT_DIALOG:
          "新客户端弹出引擎断言，自动加入已停止；请检查资源包或游戏错误",
        GAME_OWNERSHIP_CHANGED: "游戏进程归属已变化",
        WINDOW_NOT_READY: "等待游戏主窗口启动",
        WINDOW_RESTORING: "正在恢复游戏窗口",
        WINDOW_SIZE_UNSUPPORTED: "游戏窗口尺寸不支持菜单识别",
        WINDOW_CAPTURE_FAILED: "无法读取游戏窗口画面",
        WINDOW_CHANGED: "窗口在识别后发生变化，未发送点击",
        INVALID_MENU_POINT: "无效菜单坐标",
        INPUT_RESULT_UNKNOWN: "菜单点击结果未知，不自动重放",
        IMAGE_TOO_LARGE: "菜单图像尺寸过大",
        OCR_LANGUAGE_MISSING: "请安装 Windows 中文或英文 OCR 语言功能",
        OCR_TEXT_UNAVAILABLE: "当前画面未识别到菜单文字",
      };
      const key = Object.keys(messages).find((k) =>
        String(value.error).includes(k),
      );
      const error = Error(key ? messages[key] : value.error || "菜单识别失败");
      if (key === "GAME_ASSERT_DIALOG")
        error.message +=
          "：" +
          String(value.error)
            .split("GAME_ASSERT_DIALOG:")
            .at(-1)
            .slice(0, 1600);
      error.fatal = [
        "GAME_ASSERT_DIALOG",
        "GAME_OWNERSHIP_CHANGED",
        "OCR_LANGUAGE_MISSING",
        "WINDOW_SIZE_UNSUPPORTED",
        "IMAGE_TOO_LARGE",
      ].includes(key);
      throw error;
    }
    return value;
  }
  async capture(worker, pid) {
    const dir = path.join(worker.session.runDirectory, "join-menu");
    await fs.mkdir(dir, { recursive: true });
    return this.invoke(worker, pid, {
      Mode: "capture",
      ImagePath: path.join(dir, "latest.png"),
      ExpectedRoomName: worker.session.autoJoin?.worldName || "",
    });
  }
  click(worker, pid, frame, box) {
    return this.invoke(worker, pid, {
      Mode: "click",
      Hwnd: frame.hwnd,
      Width: frame.width,
      Height: frame.height,
      X: box.x + box.width / 2,
      Y: box.y + box.height / 2,
    });
  }
}
module.exports = { JoinMenu, locateMenu };
