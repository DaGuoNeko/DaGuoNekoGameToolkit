const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  net = require("node:net"),
  { EventEmitter } = require("node:events");
const { freePort } = require("../electron/network/easytier.cjs");

test("an available preferred port is reused and released after probing", async (t) => {
  const port = await freePort();
  assert.equal(await freePort("127.0.0.1", port), port);
  const server = net.createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  assert.equal(server.address().port, port);
});

test("an occupied preferred port gets a different port without disturbing its owner", async (t) => {
  const server = net.createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const original = server.address().port,
    selected = await freePort("127.0.0.1", original);
  assert.notEqual(selected, original);
  assert.equal(await freePort("127.0.0.1", selected), selected);
  assert.equal(server.listening, true);
  assert.equal(server.address().port, original);
});

for (const scenario of [
  { name: "denied preferred port", preferred: 52210, errors: ["EACCES", null] },
  { name: "unavailable address", preferred: 52210, errors: ["EADDRNOTAVAIL"] },
  { name: "unexpected failure", preferred: 52210, errors: ["EMFILE"] },
  { name: "denied automatic port", preferred: 0, errors: ["EACCES"] },
  { name: "failed fallback", preferred: 52210, errors: ["EACCES", "EACCES"] },
])
  test(`port selection handles ${scenario.name} without unbounded retry`, async (t) => {
    const calls = [];
    let closed = 0;
    t.mock.method(net, "createServer", () => {
      const server = new EventEmitter();
      server.listen = (port, host, ready) => {
        const code = scenario.errors[calls.length];
        calls.push({ port, host });
        queueMicrotask(() => {
          if (code) server.emit("error", Object.assign(Error(code), { code }));
          else ready();
        });
      };
      server.address = () => ({ port: 33002 });
      server.close = (done) => {
        closed++;
        done();
      };
      return server;
    });
    const lastError = scenario.errors.at(-1);
    if (lastError)
      await assert.rejects(freePort("127.0.0.1", scenario.preferred), { code: lastError });
    else assert.equal(await freePort("127.0.0.1", scenario.preferred), 33002);
    assert.deepEqual(
      calls,
      scenario.errors.map((_, index) => ({
        port: index ? 0 : scenario.preferred,
        host: "127.0.0.1",
      })),
    );
    assert.equal(closed, lastError ? 0 : 1);
  });
