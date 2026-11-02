const { spawnSync } = require("node:child_process");
let cached;
function findPython3(run = spawnSync, explicit = process.env.DGN_TEST_PYTHON3) {
  const candidates = explicit ? [[explicit, []]] : process.platform === "win32" ? [["py", ["-3"]], ["python3", []], ["python", []]] : [["python3", []], ["python", []]];
  for (const [command, prefix] of candidates) {
    const result = run(command, [...prefix, "-c", "import sys; print(sys.version_info[0])"], { encoding:"utf8", windowsHide:true, timeout:10000 });
    if (result.status === 0 && result.stdout.trim() === "3") return { command, prefix };
  }
  throw Error("测试需要 Python 3；请安装 Python 3 或将 DGN_TEST_PYTHON3 设为其可执行文件路径（不会修改系统默认解释器）");
}
function runPython3(args, options = {}) {
  cached ||= findPython3();
  const next = [...args], settings = { ...options };
  const coding = "# -*- coding: utf-8 -*-\n";
  if (next[0] === "-c") next[1] = coding + next[1];
  if (next[0] === "-" && typeof settings.input === "string") settings.input = coding + settings.input;
  return spawnSync(cached.command, [...cached.prefix, ...next], { encoding:"utf8", windowsHide:true, timeout:30000, ...settings });
}
module.exports = { findPython3, runPython3 };
