const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { logQuery, highlightTokens } = require("../shared/log-search.cjs");
const { colorLog } = require("../shared/log-colors.cjs");
const { SessionHistory } = require("../electron/domains/game/history.cjs");
const { importantMessage } = require("../shared/log-search.cjs");

test("literal search/highlight preserves text and colors across token boundaries, Unicode and metacharacters", () => {
  for (const query of ["[Json][error]", "中文", "a.*[b]", '<img src="x">']) {
    const text = `Before ${query} after`,
      filter = logQuery({ query });
    assert(filter.matches({ text, stream: "content" }));
    const tokens = highlightTokens(colorLog(text), filter.regex);
    assert.equal(tokens.map((t) => t.text).join(""), text);
    assert.equal(
      tokens
        .filter((t) => t.marked)
        .map((t) => t.text)
        .join(""),
      query,
    );
  }
  assert(
    logQuery({ query: "FLOWER_POT" }).matches({
      text: "minecraft:flower_pot",
      stream: "content",
    }),
  );
  assert(
    !logQuery({ query: "FLOWER_POT", caseSensitive: true }).matches({
      text: "minecraft:flower_pot",
      stream: "content",
    }),
  );
  assert(
    !logQuery({ query: "a.*b" }).matches({ text: "a123b", stream: "stdout" }),
  );
  assert.throws(() => logQuery({ query: "x".repeat(257) }), /参数/);
  assert.throws(() => logQuery({ level: "unknown" }), /参数/);
  assert(
    highlightTokens(
      [{ type: "normal", text: "x".repeat(10000) }],
      logQuery({ query: "x" }).regex,
    ).length <= 129,
  );
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-log-query-"));
  const history = new SessionHistory(path.join(root, "logs"), () => {}),
    id = crypto.randomUUID();
  await history.begin({
    id,
    projectName: "query",
    startedAt: new Date().toISOString(),
  });
  t.after(async () => {
    await history.finish();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-log-query-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, history, id };
}
test("full-archive search finds screenshot errors before last 2000 records and filters before applying the display cap", async (t) => {
  const { history, id } = await fixture(t);
  const messages = [
    '[Json][error]-Invalid aux value in item ID "minecraft:flower_pot:*minecraft:frame:*"',
    '[Json][error]-Excessive number of tokens in item ID "minecraft:flower_pot:*minecraft:frame:*"',
    "[Actor][error]-minecraft:input_air_controlled was not parsed.",
  ];
  for (const text of messages)
    history.append({ time: "time", stream: "content", text });
  for (let n = 0; n < 5000; n++)
    history.append({
      time: "time",
      stream: "engine",
      text: "noisy engine " + n,
    });
  await history.flush();
  assert(
    !(await history.read(id)).logs.some((x) => x.text.includes("flower_pot")),
  );
  const hits = await history.query(id, {
    query: "flower_pot",
    level: "content",
  });
  assert.equal(hits.total, 5003);
  assert.equal(hits.matched, 2);
  assert.equal(hits.logs[0].id, 1);
  assert.equal((await history.query(id, { level: "errors" })).logs.length, 3);
  assert.equal((await history.query(id, { level: "content" })).logs.length, 3);
  assert.equal(
    (await history.query(id, { query: "input_air_controlled" })).matched,
    1,
  );
});
test("matching pages have no overlaps; changing file size invalidates cached searches", async (t) => {
  const { history, id } = await fixture(t);
  for (let n = 0; n < 4505; n++)
    history.append({ time: "time", stream: "stdout", text: "match " + n });
  const latest = await history.query(id, { query: "match" });
  assert(latest.hasOlder);
  assert.equal(latest.logs[0].id, 2506);
  const middle = await history.query(id, {
    query: "match",
    before: latest.logs[0].id,
  });
  const oldest = await history.query(id, {
    query: "match",
    before: middle.logs[0].id,
  });
  assert.equal(oldest.hasOlder, false);
  assert.equal(oldest.logs.length, 505);
  assert.equal(
    new Set([...oldest.logs, ...middle.logs, ...latest.logs].map((l) => l.id))
      .size,
    4505,
  );
  history.append({ time: "time", stream: "stdout", text: "match new" });
  assert.equal((await history.query(id, { query: "match" })).matched, 4506);
  await assert.rejects(history.query(id, { before: -1 }), /分页/);
  await assert.rejects(
    history.query("../outside", { query: "match" }),
    /无效历史/,
  );
});
test("empty/deleted histories and redirected paths are reported without stale cached results", async (t) => {
  const { history, id, root } = await fixture(t);
  assert.equal((await history.query(id, { query: "nothing" })).matched, 0);
  await history.finish();
  await history.remove(id);
  assert.equal((await history.query(id)).missing, true);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, id + ".log"), "secret");
  const link = path.join(root, "link");
  await fs.symlink(outside, link, "junction");
  await assert.rejects(new SessionHistory(link, () => {}).query(id), /重定向/);
});

test("important view parses native severity instead of keywords and excludes engine/script duplicates", () => {
  const filter = logQuery({ level: "important" });
  for (const severity of ["warn", "warning", "error", "fatal", "critical"]) {
    assert(
      filter.matches({
        stream: "content",
        text: `12:00:00[Json][${severity}]-problem`,
      }),
    );
  }
  assert(
    !filter.matches({
      stream: "content",
      text: "12:00:00[Json][inform]-error count 0",
    }),
  );
  assert(!filter.matches({ stream: "engine", text: "[Json][error]-problem" }));
  assert(!filter.matches({ stream: "stderr", text: "[Json][error]-problem" }));
  assert(
    !filter.matches({
      stream: "content",
      text: "some text contains [Json][error]-problem",
    }),
  );
  assert.equal(
    importantMessage({
      stream: "content",
      text: "12:00:00[Json][error]-problem",
    }),
    "[Json][error]-problem",
  );
});

test("important view groups the ten screenshot errors into three problems without changing the archive", async (t) => {
  const { history, id } = await fixture(t);
  const problems = [
    "[Json][error]-Invalid aux value",
    "[Json][error]-Excessive number of tokens",
    "[Actor][error]-input_air_controlled was not parsed",
  ];
  for (let i = 0; i < problems.length; i++)
    for (let repeat = 0; repeat < [2, 2, 6][i]; repeat++)
      history.append({
        time: `t${repeat}`,
        stream: "content",
        text: `12:00:0${repeat}` + problems[i],
      });
  history.append({
    time: "time",
    stream: "content",
    text: "12:00:00[Json][inform]-not important",
  });
  history.append({ time: "time", stream: "engine", text: problems[0] });
  await history.flush();
  const before = await fs.readFile(history.file(id));
  const result = await history.query(id, { level: "important" });
  assert.equal(result.total, 12);
  assert.equal(result.matched, 3);
  assert.equal(result.occurrences, 10);
  assert.deepEqual(
    result.logs.map((l) => l.occurrences),
    [2, 2, 6],
  );
  assert.deepEqual(
    result.logs.map((l) => l.text),
    problems,
  );
  assert.deepEqual(
    result.logs.map((l) => l.id),
    [1, 3, 5],
  );
  assert.deepEqual(await fs.readFile(history.file(id)), before);
  const searched = await history.query(id, {
    level: "important",
    query: "input_air_controlled",
  });
  assert.equal(searched.matched, 1);
  assert.equal(searched.occurrences, 6);
  const page = await history.query(id, { level: "important", before: 5 });
  assert.deepEqual(
    page.logs.map((l) => l.occurrences),
    [2, 2],
  );
  assert.equal((await history.query(id, { level: "content" })).logs.length, 11);
});

test("important pagination counts groups once even when duplicates occur after the page cursor", async (t) => {
  const { history, id } = await fixture(t);
  for (let i = 0; i < 2010; i++)
    history.append({
      time: "time",
      stream: "content",
      text: `01:00:00[Json][warn]-problem ${i}`,
    });
  for (let i = 0; i < 10; i++)
    history.append({
      time: "later",
      stream: "content",
      text: `02:00:00[Json][warn]-problem ${i}`,
    });
  const latest = await history.query(id, { level: "important" });
  assert.equal(latest.matched, 2010);
  assert.equal(latest.occurrences, 2020);
  assert(latest.hasOlder);
  const older = await history.query(id, {
    level: "important",
    before: latest.logs[0].id,
  });
  assert.equal(older.logs.length, 10);
  assert(older.logs.every((l) => l.occurrences === 2));
  assert(!older.hasOlder);
});
