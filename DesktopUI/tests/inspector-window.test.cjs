const { test } = require("node:test");
const assert = require("node:assert/strict");
const { InspectorWindow } = require("../electron/inspector-window.cjs");
function windowStub(id, messages) {
  return {
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      send: (event, value) => messages.push({ event, value }),
    },
  };
}
test("inspector settings relay accepts only main-window commands and current-popup replies", async () => {
  const messages = [],
    main = windowStub(1, []),
    child = windowStub(2, messages);
  const manager = new InspectorWindow(main, {}, ".", () => "#fff");
  manager.window = child;
  assert.throws(
    () => manager.command(child, { action: "refresh" }),
    /尚未就绪/,
  );
  assert.throws(() => manager.command(main, { action: "execute" }), /不支持/);
  assert.throws(
    () =>
      manager.command(main, {
        sessionId: "s",
        generation: 1,
        action: "bounds",
        value: "yes",
      }),
    /开关/,
  );
  const request = manager.command(main, {
    sessionId: "s",
    generation: 1,
    action: "bounds",
    value: true,
    id: "spoof",
  });
  const message = messages.at(-1);
  assert.equal(message.event, "inspector-command");
  assert.notEqual(message.value.id, "spoof");
  assert.throws(
    () => manager.commandResult(main, { id: message.value.id }),
    /无效/,
  );
  manager.commandResult(child, { id: message.value.id });
  assert.equal(await request, true);
  assert.equal(manager.commands.size, 0);
  const failed = manager.command(main, {
    sessionId: "s",
    generation: 1,
    action: "screen",
    value: "hud",
  });
  manager.commandResult(child, {
    id: messages.at(-1).value.id,
    error: "draft changed",
  });
  await assert.rejects(failed, /draft changed/);
  assert.equal(manager.commandResult(child, { id: "stale" }), false);
});
