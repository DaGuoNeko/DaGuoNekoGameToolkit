// NetherNet LAN wire format, based on df-mc/go-nethernet discovery (MIT).
// See licenses/NetherNet-MIT.txt and licenses/NOTICE.md. This is discovery
// framing, not authentication; process ownership and the host proof remain required.
const crypto = require("node:crypto");
const application = Buffer.alloc(8);
application.writeBigUInt64LE(0xdeadbeefn);
const key = crypto.createHash("sha256").update(application).digest();
function request(id) {
  const payload = Buffer.alloc(20);
  payload.writeUInt16LE(payload.length);
  payload.writeBigUInt64LE(BigInt(id), 4);
  const cipher = crypto.createCipheriv("aes-256-ecb", key, null);
  return Buffer.concat([
    crypto.createHmac("sha256", key).update(payload).digest(),
    cipher.update(payload),
    cipher.final(),
  ]);
}
function inspect(data) {
  if (data.length < 64 || data.length > 65507 || (data.length - 32) % 16)
    return null;
  let payload;
  try {
    const cipher = crypto.createDecipheriv("aes-256-ecb", key, null);
    payload = Buffer.concat([cipher.update(data.subarray(32)), cipher.final()]);
  } catch {
    return null;
  }
  if (
    payload.length < 20 ||
    payload.readUInt16LE() !== payload.length ||
    !crypto.timingSafeEqual(
      data.subarray(0, 32),
      crypto.createHmac("sha256", key).update(payload).digest(),
    )
  )
    return null;
  const type = payload.readUInt16LE(2),
    id = payload.readBigUInt64LE(4).toString();
  if (id === "0" || type > 2 || (type === 0 && payload.length !== 20))
    return null;
  if (
    type === 1 &&
    (payload.length < 24 || payload.readUInt32LE(20) !== payload.length - 24)
  )
    return null;
  if (
    type === 2 &&
    (payload.length < 32 || payload.readUInt32LE(28) !== payload.length - 32)
  )
    return null;
  return {
    type,
    id,
    recipient: type === 2 ? payload.readBigUInt64LE(20).toString() : null,
  };
}
module.exports = { request, inspect };
