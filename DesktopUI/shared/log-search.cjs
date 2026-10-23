const levels = new Set([
  "all",
  "errors",
  "stdout",
  "stderr",
  "system",
  "content",
  "engine",
  "important",
]);
function importantMessage(entry) {
  if (entry.stream !== "content") return null;
  const match =
    /^(?:\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s*)?(\[[^\]\r\n]+\]\[(?:warn(?:ing)?|error|fatal|critical)\]-[^\r\n]*)$/i.exec(
      entry.text,
    );
  return match ? match[1] : null;
}
function logQuery({ query = "", level = "all", caseSensitive = false } = {}) {
  if (
    typeof query !== "string" ||
    query.length > 256 ||
    !levels.has(level) ||
    typeof caseSensitive !== "boolean"
  )
    throw Error("日志搜索参数无效");
  const regex = query
    ? new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        caseSensitive ? "gu" : "giu",
      )
    : null;
  return {
    regex,
    query,
    level,
    caseSensitive,
    matches(entry) {
      const message =
        level === "important" ? importantMessage(entry) : entry.text;
      if (message === null) return false;
      if (
        level === "errors"
          ? !/\b(error|exception|traceback|fatal)\b|错误|失败/i.test(entry.text)
          : level !== "all" && level !== "important" && entry.stream !== level
      )
        return false;
      if (!regex) return true;
      regex.lastIndex = 0;
      return regex.test(message);
    },
  };
}
function highlightTokens(tokens, regex) {
  if (!regex) return tokens;
  const text = tokens.map((token) => token.text).join("");
  regex.lastIndex = 0;
  const ranges = [];
  for (let match; ranges.length < 64 && (match = regex.exec(text));) {
    ranges.push([match.index, match.index + match[0].length]);
    if (!match[0].length) break;
  }
  const result = [];
  let start = 0,
    range = 0;
  for (const token of tokens) {
    const end = start + token.text.length;
    let at = start;
    while (at < end) {
      while (range < ranges.length && ranges[range][1] <= at) range++;
      const hit = ranges[range],
        marked = !!hit && hit[0] <= at;
      const stop = Math.min(end, hit ? (marked ? hit[1] : hit[0]) : end);
      result.push({ type: token.type, text: text.slice(at, stop), marked });
      at = stop;
    }
    start = end;
  }
  return result;
}
module.exports = { logQuery, highlightTokens, importantMessage };
