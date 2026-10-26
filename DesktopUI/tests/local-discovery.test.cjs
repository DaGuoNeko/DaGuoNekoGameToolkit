const { test } = require("node:test"),
  assert = require("node:assert/strict");
const dgram = require("node:dgram"),
  crypto = require("node:crypto");
const {
  LocalDiscovery,
  endpoints,
} = require("../electron/domains/client/local-discovery.cjs");
const {
  request,
  inspect,
} = require("../electron/domains/client/lan-packet.cjs");
function packet(type, id, recipient, text = "Ping") {
  const body = type === 1 ? Buffer.from("6162") : Buffer.from(text);
  const p = Buffer.alloc((type === 1 ? 24 : 32) + body.length);
  p.writeUInt16LE(p.length);
  p.writeUInt16LE(type, 2);
  p.writeBigUInt64LE(BigInt(id), 4);
  if (type === 2) p.writeBigUInt64LE(BigInt(recipient), 20);
  p.writeUInt32LE(body.length, type === 1 ? 20 : 28);
  body.copy(p, type === 1 ? 24 : 32);
  const app = Buffer.alloc(8);
  app.writeBigUInt64LE(0xdeadbeefn);
  const key = crypto.createHash("sha256").update(app).digest(),
    cipher = crypto.createCipheriv("aes-256-ecb", key, null);
  return Buffer.concat([
    crypto.createHmac("sha256", key).update(p).digest(),
    cipher.update(p),
    cipher.final(),
  ]);
}
test("LAN framing keeps uint64 identity, validates ciphertext and confines endpoints to loopback", () => {
  assert.equal(
    inspect(request("18446744073709551615")).id,
    "18446744073709551615",
  );
  assert.equal(inspect(packet(2, "123", "456")).recipient, "456");
  for (const data of [
    Buffer.alloc(0),
    Buffer.alloc(64),
    request("123").subarray(1),
  ])
    assert.equal(inspect(data), null);
  const altered = packet(1, "123");
  altered[0] ^= 1;
  assert.equal(inspect(altered), null);
  assert.deepEqual(endpoints([{ address: "::", port: 7551 }]), [
    { address: "::1", port: 7551, family: "udp6" },
  ]);
  assert.throws(
    () => endpoints([{ address: "192.168.1.1", port: 7551 }]),
    /无效/,
  );
  assert.throws(() => endpoints([{ address: "::", port: 0 }]), /无效/);
});
async function socket(t) {
  const s = dgram.createSocket("udp6");
  await new Promise((r) => s.bind(0, "::1", r));
  t.after(() => s.close());
  return s;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await wait(20);
  }
  assert.fail("UDP fixture timed out");
}
test("two real UDP pairs discover only their selected host and stop on ownership changes", async (t) => {
  const pairs = [];
  for (let i = 0; i < 2; i++) {
    const host = await socket(t),
      guest = await socket(t),
      stranger = await socket(t);
    const hostId = String(900 + i),
      guestId = String(700 + i),
      seen = [];
    let owned = true,
      relayAddress;
    host.on("message", (data, remote) => {
      const p = inspect(data);
      if (p?.type === 0) {
        relayAddress = remote;
        host.send(packet(1, hostId), remote.port, remote.address);
        stranger.send(packet(1, hostId), remote.port, remote.address);
        host.send(packet(1, "9999"), remote.port, remote.address);
      } else if (p?.type === 2)
        host.send(
          packet(2, hostId, guestId, "reply"),
          remote.port,
          remote.address,
        );
    });
    guest.on("message", (data, remote) => {
      const p = inspect(data);
      seen.push(p);
      if (p?.type === 1)
        guest.send(packet(2, guestId, hostId), remote.port, remote.address);
    });
    const discovery = new LocalDiscovery("test", {
      query: async (runtime, worker) => ({
        endpoints: [{ address: "::", port: worker.socket.address().port }],
      }),
    });
    const link = await discovery.open(
      { socket: host },
      { minecraftPid: 1 },
      { socket: guest },
      { minecraftPid: 2 },
      hostId,
      () => {
        if (!owned) throw Error("ownership changed");
      },
    );
    t.after(() => link.close());
    pairs.push({
      link,
      seen,
      hostId,
      host,
      guest,
      relay: () => relayAddress,
      revoke: () => {
        owned = false;
      },
    });
  }
  await until(() => pairs.every((p) => p.seen.some((x) => x?.type === 2)));
  for (const p of pairs) assert(p.seen.every((x) => x.id === p.hostId));
  pairs[0].revoke();
  const address = pairs[0].relay();
  pairs[0].host.send(packet(1, pairs[0].hostId), address.port, address.address);
  await until(() => {
    try {
      pairs[0].link.assert();
      return false;
    } catch {
      return true;
    }
  });
  pairs[1].link.assert();
  assert.throws(() => pairs[0].link.assert(), /ownership changed/);
  pairs[0].link.close();
  pairs[1].link.close();
});
