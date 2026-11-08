const crypto = require("node:crypto"),
  fs = require("node:fs/promises"),
  path = require("node:path");
const p = require("./protocol.cjs");
const { atomicWrite } = require("../services.cjs");
const NEVER = Number.MAX_SAFE_INTEGER;
function roomCode(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 64 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error("邀请码需为 1–64 个可见字符");
  return value.trim();
}
function authKey(credential, id) {
  return crypto
    .createHmac("sha256", Buffer.from(credential, "base64"))
    .update("room-member:" + id)
    .digest("base64");
}
function encode(v) {
  return (
    "DGNROOM2:" +
    Buffer.from(
      JSON.stringify({
        version: 2,
        roomId: v.roomId,
        network: v.network,
        hostIp: v.hostIp,
        controlPort: v.controlPort,
        endpoint: v.endpoint,
        credential: v.credential,
        hostPublicKey: v.hostPublicKey,
      }),
    ).toString("base64url")
  );
}
function parse(text) {
  let v;
  try {
    v = JSON.parse(
      Buffer.from(text.trim().slice(9), "base64url").toString("utf8"),
    );
  } catch {
    throw Error("固定邀请内容无法解析");
  }
  if (!v || v.version !== 2) throw Error("固定邀请版本无效");
  // Reuse the strict address/key validation; expiry is solely a legacy-format field.
  const legacy = p.parseInvite(
    "DGNROOM1:" +
      Buffer.from(
        JSON.stringify({
          ...v,
          version: 1,
          inviteId: v.roomId,
          authKey: v.credential,
          guestIp: String(v.hostIp).replace(/\.1$/, ".2"),
          expires: Date.now() + 3600000,
        }),
      ).toString("base64url"),
  );
  return { ...legacy, fixed: true, expires: NEVER };
}
class RoomPreferences {
  constructor(root, protection) {
    this.file = path.join(root, "room-preferences.json");
    this.protection = protection;
    this.queue = Promise.resolve();
  }
  async read() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (saved.encrypted) {
        if (!this.protection) throw Error("无法解密本机保存的房间设置");
        return JSON.parse(
          this.protection.decryptString(Buffer.from(saved.encrypted, "base64")),
        );
      }
      return saved;
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw e;
    }
  }
  change(fn) {
    const op = this.queue.then(async () => {
      const data = await this.read(),
        result = await fn(data);
      const json = JSON.stringify(data);
      const saved = this.protection
        ? JSON.stringify({
            encrypted: this.protection.encryptString(json).toString("base64"),
          })
        : json;
      await atomicWrite(this.file, saved);
      return result;
    });
    this.queue = op.catch(() => {});
    return op;
  }
  async draft() {
    await this.queue;
    const d = await this.read();
    return d.draft || {};
  }
  saveDraft(input) {
    const limits = {
      roomCode: 64,
      invitation: 12000,
      playerName: 32,
      endpoint: 300,
      localPort: 5,
      worldId: 100,
      gamePath: 1024,
    };
    const patch = {};
    for (const [key, limit] of Object.entries(limits))
      if (Object.hasOwn(input, key)) {
        if (typeof input[key] !== "string" || input[key].length > limit)
          throw Error("房间设置长度或格式无效");
        patch[key] = input[key];
      }
    return this.change((d) => {
      d.draft = { ...d.draft, ...patch };
      return d.draft;
    });
  }
  identity(code, endpoint, allocate) {
    code = roomCode(code);
    return this.change(async (d) => {
      if (!d.host || d.host.code !== code) {
        const keys = crypto.generateKeyPairSync("x25519");
        d.host = {
          code,
          roomId: crypto.randomUUID(),
          network: "dgn-" + crypto.randomBytes(16).toString("hex"),
          hostIp: p.subnet(),
          controlPort: await allocate(),
          secret: p.randomKey(),
          privateKey: Buffer.from(
            keys.privateKey.export({ format: "jwk" }).d,
            "base64url",
          ).toString("base64"),
          hostPublicKey: Buffer.from(
            keys.publicKey.export({ format: "jwk" }).x,
            "base64url",
          ).toString("base64"),
          credential: crypto
            .scryptSync(code, crypto.randomBytes(32), 32)
            .toString("base64"),
        };
      } else {
        d.host.controlPort = await allocate(d.host.controlPort);
      }
      d.host.endpoint = endpoint;
      return { ...d.host };
    });
  }
  client() {
    return this.change((d) => {
      if (!d.client)
        d.client = { id: crypto.randomUUID(), resumeKey: p.randomKey() };
      return { ...d.client };
    });
  }
}
module.exports = { NEVER, roomCode, authKey, encode, parse, RoomPreferences };
