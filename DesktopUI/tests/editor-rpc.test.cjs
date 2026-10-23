const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  net = require("node:net"),
  { once } = require("node:events");
const { EditorRpc } = require("../electron/editor-rpc.cjs");
const frame = (v) => {
  const data = Buffer.from(JSON.stringify(v)),
    header = Buffer.alloc(4);
  header.writeInt32LE(data.length);
  return Buffer.concat([header, data]);
};
test("editor RPC handles fragmented UTF-8 packets, correlated results and request timeouts without replay", async () => {
  const rpc = new EditorRpc();
  let peer;
  try {
    const port = await rpc.listen(async () => true),
      connected = once(rpc, "connected");
    peer = net.connect(port, "127.0.0.1");
    await connected;
    const notification = once(rpc, "notification"),
      packet = frame({
        jsonrpc: "2.0",
        method: "event",
        params: ["中文"],
        id: 71,
      });
    peer.write(packet.subarray(0, 3));
    peer.write(packet.subarray(3, 7));
    peer.write(packet.subarray(7));
    assert.deepEqual((await notification).slice(0, 2), ["event", ["中文"]]);
    const result = rpc.call("plugin", "read", [], 1000);
    peer.write(frame({ jsonrpc: "2.0", id: 1, result: "值" }));
    assert.equal(await result, "值");
    await assert.rejects(rpc.call("plugin", "write", [], 20), /没有自动重试/);
    assert.equal(rpc.pending.size, 0);
  } finally {
    peer?.destroy();
    rpc.close();
  }
});
test("editor RPC refuses foreign peers and closes on oversized framing", async () => {
  const rejected = new EditorRpc();
  const port = await rejected.listen(async () => false);
  const rejection = once(rejected, "rejected");
  const peer = net.connect(port, "127.0.0.1");
  await rejection;
  peer.destroy();
  rejected.close();
  const rpc = new EditorRpc();
  const accepted = await rpc.listen(async () => true),
    ready = once(rpc, "connected"),
    client = net.connect(accepted, "127.0.0.1");
  await ready;
  const fault = once(rpc, "fault");
  const b = Buffer.alloc(4);
  b.writeInt32LE(17 * 1024 * 1024);
  client.write(b);
  assert.match((await fault)[0], /长度/);
  client.destroy();
  rpc.close();
});
