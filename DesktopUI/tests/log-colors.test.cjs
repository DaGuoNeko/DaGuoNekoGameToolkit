const { test } = require("node:test");
const assert = require("node:assert/strict");
const { colorLog, palette } = require("../shared/log-colors.cjs");
test("official log palette and precedence distinguish tags, numbers, URLs and whole-line errors", () => {
  const text =
    "[INFO][Engine][Client] value=12.5e-2 (0xFF) <Player> https://example.test/a?q=12";
  const tokens = colorLog(text);
  assert.equal(tokens.map((t) => t.text).join(""), text);
  assert.deepEqual(
    tokens.filter((t) => t.type === "tags").map((t) => t.text),
    ["[INFO][Engine]"],
  );
  assert.ok(tokens.some((t) => t.type === "brackets" && t.text === "[Client]"));
  assert.ok(tokens.some((t) => t.type === "number" && t.text === "12.5e-2"));
  assert.ok(
    tokens.some(
      (t) => t.type === "url" && t.text === "https://example.test/a?q=12",
    ),
  );
  assert.equal(palette.error, "#EB2665");
  assert.deepEqual(colorLog("[ERROR][DEBUG] 123"), [
    { type: "error", text: "[ERROR][DEBUG] 123" },
  ]);
  assert.equal(colorLog("[DEBUG] [INFO] 123")[0].type, "debug");
  assert.equal(colorLog("Traceback (most recent call last):")[0].type, "error");
  assert.equal(colorLog('  File "x.py", line 12, in run')[0].type, "error");
  assert.equal(colorLog("plain stderr", "stderr")[0].type, "error");
  assert.equal(colorLog("[WARNING] warning")[0].type, "brackets");
});
test("MCP status lines are pale blue without hiding errors or changing text", () => {
  for (const text of [
    "[MCP] [INFO] 2026-10-09 04:39:30 Method call successful: tools/call",
    '[MCP] [INFO] 2026-10-09 04:39:30 ::1:56514 - "POST /mcp HTTP/1.1" 200',
    " [mcp] [DEBUG] status",
  ]) {
    assert.deepEqual(colorLog(text), [{ type: "mcp", text }]);
    assert.deepEqual(colorLog(text, "stderr"), [{ type: "mcp", text }]);
  }
  assert.equal(colorLog("[MCP] [ERROR] request failed")[0].type, "error");
  for (const stream of ["stdout", "stderr"]) {
    for (const level of ["ERROR", "CRITICAL", "FATAL", "EXCEPTION"])
      assert.equal(
        colorLog(`[MCP] [${level}] request failed`, stream)[0].type,
        "error",
      );
    assert.equal(
      colorLog("[MCP] Traceback (most recent call last):", stream)[0].type,
      "error",
    );
  }
  assert.equal(
    colorLog("[MCP] Traceback (most recent call last):")[0].type,
    "error",
  );
  assert.ok(
    colorLog("ordinary text mentioning [MCP]").every((t) => t.type !== "mcp"),
  );
});
test("highlighting preserves arbitrary log text, never creates HTML, and bounds long or dense lines", () => {
  for (const text of [
    "中文\n<script>alert(12)</script>&{}",
    "a".repeat(40000),
    "(1) ".repeat(1000),
    "",
  ]) {
    const result = colorLog(text);
    assert.equal(result.map((t) => t.text).join(""), text);
    assert.ok(result.length <= 128);
  }
  assert.deepEqual(
    colorLog("a".repeat(40000)).map((t) => t.type),
    ["normal"],
  );
});
