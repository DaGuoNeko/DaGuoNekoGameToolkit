const dgram = require("node:dgram"),
  crypto = require("node:crypto");
const { windowCall } = require("./ore-native.cjs");
const { request, inspect } = require("./lan-packet.cjs");
function endpoints(value) {
  if (!Array.isArray(value) || value.length > 64)
    throw Error("本机游戏 UDP 端口列表无效");
  return value.map(({ address, port }) => {
    if (
      !["::", "::1", "0.0.0.0", "127.0.0.1"].includes(address) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw Error("本机游戏 UDP 端口无效");
    return {
      address: address.includes(":") ? "::1" : "127.0.0.1",
      port,
      family: address.includes(":") ? "udp6" : "udp4",
    };
  });
}
class LocalDiscovery {
  constructor(
    runtime,
    { query = windowCall, socket = (type) => dgram.createSocket(type) } = {},
  ) {
    Object.assign(this, { runtime, query, socket });
  }
  async open(host, hb, guest, gb, hostId, check) {
    check();
    const hosts = endpoints(
      (await this.query(this.runtime, host, hb.minecraftPid, "udp")).endpoints,
    );
    check();
    const guests = endpoints(
      (await this.query(this.runtime, guest, gb.minecraftPid, "udp")).endpoints,
    );
    check();
    if (!hosts.length || !guests.length)
      throw Error("所选游戏尚未创建本机联机端口");
    let closed = false,
      error = null,
      timer,
      selectedHost,
      selectedGuest,
      guestId;
    const sockets = new Map(),
      probe = request(crypto.randomBytes(8).readBigUInt64LE() || 1n);
    const same = (a, b) => a.address === b.address && a.port === b.port;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const socket of sockets.values()) {
        try {
          socket.close();
        } catch (e) {
          if (e.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw e;
        }
      }
    };
    const fail = (e) => {
      error = e;
      close();
    };
    const send = (data, endpoint) => {
      if (!closed)
        sockets
          .get(endpoint.family)
          .send(data, endpoint.port, endpoint.address, (e) => {
            if (e) fail(e);
          });
    };
    try {
      for (const family of new Set(
        [...hosts, ...guests].map((e) => e.family),
      )) {
        const socket = this.socket(family);
        sockets.set(family, socket);
        socket.on("error", fail);
        socket.on("message", (data, remote) => {
          if (closed) return;
          try {
            check();
            const packet = inspect(data);
            if (!packet) return;
            const h = hosts.find((e) => e.family === family && same(e, remote));
            const g = guests.find(
              (e) => e.family === family && same(e, remote),
            );
            if (h && packet.id === hostId) {
              // 同一所属进程可同时监听 IPv4/IPv6，固定首个正确身份的端点。
              if (selectedHost && !same(selectedHost, h)) return;
              selectedHost = h;
              if (packet.type === 1) {
                for (const endpoint of selectedGuest ? [selectedGuest] : guests)
                  send(data, endpoint);
              } else if (
                packet.type === 2 &&
                selectedGuest &&
                packet.recipient === guestId
              )
                send(data, selectedGuest);
            } else if (
              g &&
              selectedHost &&
              packet.type === 2 &&
              packet.recipient === hostId
            ) {
              if (guestId && (guestId !== packet.id || !same(selectedGuest, g)))
                throw Error("新客户端的局域网端口身份发生变化");
              guestId = packet.id;
              selectedGuest = g;
              send(data, selectedHost);
            }
          } catch (e) {
            fail(e);
          }
        });
        await new Promise((resolve, reject) => {
          socket.once("error", reject);
          socket.bind(0, family === "udp6" ? "::1" : "127.0.0.1", () => {
            socket.off("error", reject);
            resolve();
          });
        });
      }
      const pulse = () => {
        if (closed) return;
        try {
          check();
          for (const endpoint of selectedHost ? [selectedHost] : hosts)
            send(probe, endpoint);
        } catch (e) {
          fail(e);
        }
      };
      pulse();
      if (closed) throw error;
      timer = setInterval(pulse, 1000);
      return {
        close,
        assert() {
          if (error) throw error;
        },
      };
    } catch (e) {
      close();
      throw e;
    }
  }
}
module.exports = { LocalDiscovery, endpoints };
