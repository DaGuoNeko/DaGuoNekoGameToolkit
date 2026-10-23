// Palette and precedence verified against the installed Safaia LogTextHighlighter.
// Independent text tokenizer: never interprets log text as HTML or clickable URLs.
const palette = {
  normal: "#B3B3B3",
  tags: "#81EF66",
  number: "#AE81FF",
  brackets: "#75715E",
  angle: "#E126D5",
  punctuation: "#FEAB2D",
  url: "#66D9EF",
  error: "#EB2665",
  debug: "#60A5FF",
  mcp: "#93C5FD",
};
const rules = [
  ["brackets", /\[[^\[\]\r\n]+\]/g],
  ["angle", /<[^<>\r\n]+>/g],
  ["punctuation", /[(){}]/g],
  [
    "number",
    /\b(?:0[xX][0-9a-fA-F]+[lL]?|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[lL]?)\b/g,
  ],
  ["url", /https?:\/\/[^\s<>"'\[\]{}]+/g],
  ["tags", /\[(?:Engine|Developer|NOTICE|INFO)\]/g],
];
const types = ["normal", ...rules.map(([type]) => type)];
function colorLog(text, stream = "stdout") {
  // Error/debug have whole-line precedence in the official highlighter.
  // Bare stderr and traceback source locations also retain visible error styling.
  if (
    /\[error\]/i.test(text) ||
    (stream === "engine" &&
      /^\[[^\]]*\b(?:ERROR|FATAL)\b[^\]]*\]/.test(text)) ||
    text.includes("Traceback") ||
    /^\s*File ".+", line \d+/m.test(text)
  )
    return [{ type: "error", text }];
  // MCP's logger also writes INFO to stderr. The tag takes precedence over
  // the output stream; explicit failures above and fatal levels stay red.
  if (/^\s*\[mcp\]/i.test(text))
    return [
      {
        type: /\[(?:critical|fatal|exception)\]/i.test(text) ? "error" : "mcp",
        text,
      },
    ];
  if (/\[debug\]/i.test(text)) return [{ type: "debug", text }];
  if (stream === "stderr") return [{ type: "error", text }];
  if (text.length > 32768) return [{ type: "normal", text }];
  const colors = new Uint8Array(text.length);
  for (let i = 0; i < rules.length; i++) {
    const regex = rules[i][1];
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex))
      colors.fill(i + 1, match.index, match.index + match[0].length);
  }
  const tokens = [];
  for (let start = 0; start < text.length;) {
    let end = start + 1;
    while (end < text.length && colors[end] === colors[start]) end++;
    tokens.push({ type: types[colors[start]], text: text.slice(start, end) });
    if (tokens.length > 128) return [{ type: "normal", text }];
    start = end;
  }
  return tokens;
}
module.exports = { palette, colorLog };
