function joinLabel(session) {
  const phase = session?.autoJoin?.phase;
  const worldName =
    session?.autoJoin?.libraryWorldName ||
    session?.autoJoin?.worldName ||
    "联机存档";
  const result = {
    joined: "入房已验证",
    failed: "加入失败",
    needs_attention: "需要处理",
    waiting_assertion: "需要处理",
  }[phase];
  return `目标：${worldName} · ${result || (session?.running ? "正在加入" : "已结束")}`;
}
module.exports = { joinLabel };
