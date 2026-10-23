const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const VERSION = 1,
  MAX = 65536;
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const key = (v) => typeof v === "string" && /^[A-Za-z0-9+/]{43}=$/.test(v);
const randomKey = () => crypto.randomBytes(32).toString("base64");
function endpoint(value) {
  if (typeof value !== "string" || value.length > 300 || /[\s\\]/.test(value))
    throw Error("请填写樱花 TCP 隧道的公网地址:端口");
  const u = new URL(value.startsWith("tcp://") ? value : "tcp://" + value);
  if (
    u.protocol !== "tcp:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname && u.pathname !== "/") ||
    !u.port ||
    !/^([a-z0-9-]+\.)*[a-z0-9-]+$/i.test(u.hostname)
  )
    throw Error("樱花入口格式无效，应为主机名:端口");
  return "tcp://" + u.host;
}
function parseInvite(text, now = Date.now()) {
  if (
    typeof text === "string" &&
    text.length <= 12000 &&
    text.trim().startsWith("DGNROOM2:")
  )
    return require("./fixed-room.cjs").parse(text);
  if (
    typeof text !== "string" ||
    text.length > 12000 ||
    !text.trim().startsWith("DGNROOM1:")
  )
    throw Error("邀请格式无效，请粘贴完整邀请文本");
  let v;
  try {
    v = JSON.parse(
      Buffer.from(text.trim().slice(9), "base64url").toString("utf8"),
    );
  } catch {
    throw Error("邀请内容无法解析");
  }
  if (
    v.version !== VERSION ||
    !uuid(v.roomId) ||
    !uuid(v.inviteId) ||
    !key(v.authKey) ||
    !key(v.credential) ||
    !key(v.hostPublicKey) ||
    !/^dgn-[a-f0-9]{32}$/.test(v.network) ||
    !/^10\.\d{1,3}\.\d{1,3}\.1$/.test(v.hostIp) ||
    !/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v.guestIp)
  )
    throw Error("邀请缺少有效的房间身份");
  const a = v.hostIp.split(".").map(Number),
    b = v.guestIp.split(".").map(Number);
  if (
    [...a, ...b].some((n) => n > 255) ||
    a.slice(0, 3).join(".") !== b.slice(0, 3).join(".") ||
    b[3] < 2 ||
    b[3] > 254
  )
    throw Error("邀请的虚拟地址无效");
  if (
    !Number.isSafeInteger(v.controlPort) ||
    v.controlPort < 1024 ||
    v.controlPort > 65535 ||
    !Number.isSafeInteger(v.expires) ||
    v.expires <= now ||
    v.expires > now + 86400000 + 60000
  )
    throw Error("邀请已过期或有效期无效");
  return {
    version: VERSION,
    roomId: v.roomId,
    inviteId: v.inviteId,
    network: v.network,
    hostIp: v.hostIp,
    guestIp: v.guestIp,
    controlPort: v.controlPort,
    expires: v.expires,
    endpoint: endpoint(v.endpoint),
    authKey: v.authKey,
    credential: v.credential,
    hostPublicKey: v.hostPublicKey,
  };
}
function encodeInvite(v) {
  const text =
    "DGNROOM1:" + Buffer.from(JSON.stringify(v)).toString("base64url");
  parseInvite(text);
  return text;
}
function seal(value, secret, aad) {
  const iv = crypto.randomBytes(12),
    c = crypto.createCipheriv("aes-256-gcm", Buffer.from(secret, "base64"), iv);
  c.setAAD(Buffer.from(aad));
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX / 2) throw Error("房间消息过大");
  return Buffer.concat([
    iv,
    c.update(bytes),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
function open(box, secret, aad) {
  if (typeof box !== "string" || box.length > MAX) throw Error("房间消息过大");
  const b = Buffer.from(box, "base64");
  if (b.length < 28) throw Error("房间消息无效");
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(secret, "base64"),
    b.subarray(0, 12),
  );
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(-16));
  return JSON.parse(
    Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString("utf8"),
  );
}
const aad = (v, direction) =>
  `${VERSION}:${v.roomId}:${v.inviteId}:${direction}`;
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const b of req) {
    size += b.length;
    if (size > MAX) throw Error("请求过大");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function request(invite, action, data = {}, timeout = 15000) {
  const requestId = crypto.randomUUID(),
    payload = { requestId, time: Date.now(), action, data };
  const text = JSON.stringify({
    inviteId: invite.inviteId,
    box: seal(payload, invite.authKey, aad(invite, "request")),
  });
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: invite.hostIp,
        port: invite.controlPort,
        path: "/room",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
        },
        timeout,
        agent: false,
      },
      async (res) => {
        try {
          if (res.statusCode !== 200) {
            res.resume();
            throw Object.assign(Error("房间请求被拒绝，请确认邀请仍有效"), {
              code:
                res.statusCode === 403
                  ? "ROOM_AUTH_REJECTED"
                  : "ROOM_HTTP_ERROR",
            });
          }
          resolve(await body(res));
        } catch (e) {
          reject(e);
        }
      },
    );
    req.on("timeout", () =>
      req.destroy(Error("无法联系房主，请检查樱花隧道和虚拟网络")),
    );
    req.on("error", reject);
    req.end(text);
  });
  const decoded = open(result.box, invite.authKey, aad(invite, "response"));
  if (decoded.requestId !== requestId) throw Error("房间响应身份不匹配");
  if (!decoded.ok) throw Error(decoded.error);
  return decoded.result;
}
function subnetConflict(ip, interfaces = os.networkInterfaces()) {
  const n = ip.split(".").reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0);
  return Object.values(interfaces)
    .flat()
    .some((v) => {
      if (!v || v.family !== "IPv4" || v.internal) return false;
      const mask = v.netmask
          .split(".")
          .reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0),
        a = v.address
          .split(".")
          .reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0);
      return (n & mask) === (a & mask);
    });
}
function localHostAddress(ip, interfaces = os.networkInterfaces()) {
  return Object.values(interfaces)
    .flat()
    .some((v) => v && v.family === "IPv4" && !v.internal && v.address === ip);
}
function subnet() {
  for (let n = 0; n < 128; n++) {
    const bytes = crypto.randomBytes(2),
      ip = `10.${bytes[0]}.${bytes[1]}.1`;
    if (!subnetConflict(ip)) return ip;
  }
  throw Error("无法分配不冲突的虚拟网段");
}
module.exports = {
  VERSION,
  MAX,
  uuid,
  key,
  randomKey,
  endpoint,
  parseInvite,
  encodeInvite,
  seal,
  open,
  aad,
  body,
  request,
  subnet,
  subnetConflict,
  localHostAddress,
};
