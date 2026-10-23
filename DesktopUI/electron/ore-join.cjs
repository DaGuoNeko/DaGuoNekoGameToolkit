const { OreCdp } = require("./ore-cdp.cjs");
const native = require("./ore-native.cjs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function hostIdentity(value) {
  const id = value?.netherNetId;
  if (
    typeof id !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(id) ||
    BigInt(id) > 0xffffffffffffffffn
  )
    throw Error(
      "房主没有有效的 NetherNet 房间标识；必须保留字符串，不能转换成数字",
    );
  return id;
}
function selectRoom(rows, target) {
  if (!Array.isArray(rows) || rows.length > 128)
    throw Error("原生局域网列表无效");
  const candidates = [];
  for (const row of rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      row.id.length > 2048 ||
      typeof row.name !== "string" ||
      row.name.length > 512 ||
      typeof row.ownerName !== "string" ||
      row.ownerName.length > 128
    )
      throw Error("原生房间数据无效");
    if (row.name !== target.name || row.ownerName !== target.owner) continue;
    // This tested transport exposes its 64-bit NetherNet ID in the native ID.
    // Never fall back to the title alone, card order, or a truncated numeric ID.
    const expected =
      row.ownerName +
      row.name +
      "v" +
      target.netherNetId +
      "UNASSIGNED_SYSTEM_ADDRESSUNASSIGNED_RAKNET_GUID";
    if (
      row.address === "UNASSIGNED_SYSTEM_ADDRESS" &&
      row.port === 0 &&
      row.id === expected
    )
      candidates.push(row);
  }
  if (candidates.length > 1)
    throw Error("原生列表中存在多个相同身份的房间，已停止");
  return candidates[0] || null;
}
function scripts(key, lanId, joinId) {
  const k = JSON.stringify(key),
    l = JSON.stringify(lanId),
    j = JSON.stringify(joinId);
  return {
    init: `(function(){const k=${k};if(window[k])throw Error('duplicate setup');const s=window[k]={errors:[]};s.lanUpdate=d=>s.lan=d;s.joinUpdate=d=>s.join=d;s.failure=e=>s.errors.push(String(e));engine.on('facet:updated:'+${l},s.lanUpdate);engine.on('facet:updated:'+${j},s.joinUpdate);engine.on('facet:error:'+${l},s.failure);engine.on('facet:error:'+${j},s.failure);engine.trigger('facet:request','vanilla.lanWorldList',${l},{});engine.trigger('facet:request','vanilla.networkWorldJoiner',${j},{});return true;})()`,
    read: `(function(){const s=window[${k}];if(!s)throw Error('missing setup');if(s.errors.length)throw Error(s.errors.join(';'));const a=s.lan?s.lan.lanWorlds:[];if(a.length>128)throw Error('too many rooms');const rows=[];for(let i=0;i<a.length;i++){const w=a[i];rows.push({id:w.id,name:w.name,ownerName:w.ownerName,address:w.address,port:w.port});}return JSON.stringify({rows,ready:!!s.join,state:s.join?s.join.joinLANServerTaskState:null,result:s.join?s.join.joinLANServerResult:null});})()`,
    send: (id) =>
      `(function(){const s=window[${k}];if(!s||!s.join||s.sent)throw Error('not ready or already sent');const a=s.lan.lanWorlds;if(a.length>128)throw Error('too many rooms');let n=0;for(let i=0;i<a.length;i++)if(a[i].id===${JSON.stringify(id)})n++;if(n!==1)throw Error('room changed');s.sent=true;s.join.joinLanServer(${JSON.stringify(id)});return true;})()`,
    cleanup: `(function(){const s=window[${k}];if(!s)return;engine.off('facet:updated:'+${l},s.lanUpdate);engine.off('facet:updated:'+${j},s.joinUpdate);engine.off('facet:error:'+${l},s.failure);engine.off('facet:error:'+${j},s.failure);engine.trigger('facet:discard',${l});engine.trigger('facet:discard',${j});delete window[${k}];})()`,
  };
}
class OreJoin {
  constructor(
    runtime,
    {
      checkEngine = native.checkEngine,
      reservePort = native.reservePort,
      call = native.nativeCall,
      window = native.windowCall,
      Cdp = OreCdp,
      sleep = wait,
      menuDelay = 10000,
    } = {},
  ) {
    Object.assign(this, {
      runtime,
      checkEngine,
      reservePort,
      call,
      window,
      Cdp,
      sleep,
      menuDelay,
    });
  }
  async create(config, token, check) {
    const engine = await this.checkEngine(config.game_executable_path);
    check();
    const reservation = await this.reservePort();
    let released = false;
    const context = {
      engine,
      port: reservation.port,
      check,
      script: scripts(
        "__dgn_join_" + token,
        "dgn_lan_" + token,
        "dgn_join_" + token,
      ),
      release: async () => {
        if (!released) {
          released = true;
          await reservation.release();
        }
      },
    };
    return context;
  }
  async prepare(context, worker, bridge) {
    context.check();
    context.worker = worker;
    context.pid = bridge.minecraftPid;
    context.registration = bridge.id;
    context.generation = bridge.connectionGeneration;
    await context.release();
    context.attempted = true;
    await this.call(this.runtime, worker, context.pid, context.port);
    context.preparedAt = Date.now();
    context.check();
  }
  async resume(config, token, worker, bridge, port, check) {
    const engine = await this.checkEngine(config.game_executable_path);
    check();
    const context = {
      engine,
      port,
      check,
      worker,
      pid: bridge.minecraftPid,
      registration: bridge.id,
      generation: bridge.connectionGeneration,
      attempted: true,
      reconnecting: true,
      preparedAt: Date.now(),
      release: async () => {},
      script: scripts(
        "__dgn_join_" + token,
        "dgn_lan_" + token,
        "dgn_join_" + token,
      ),
    };
    try {
      await this.call(
        this.runtime,
        worker,
        bridge.minecraftPid,
        "resume:" + port,
      );
      check();
      return context;
    } catch (error) {
      await this.close(context);
      throw error;
    }
  }
  async inspect(context) {
    for (;;) {
      context.check();
      try {
        await this.window(this.runtime, context.worker, context.pid, "status");
        context.check();
        if (context.assertionPending) {
          if (Date.now() >= context.deadline)
            throw Object.assign(Error("断言处理超过本次自动加入等待期限"), {
              code: "GAME_ASSERT_PENDING",
            });
          context.assertionPending = false;
          context.onAssertion(null);
        }
        return;
      } catch (error) {
        if (error.code !== "GAME_ASSERT_DIALOG") throw error;
        context.check();
        context.assertionPending = true;
        context.onAssertion(error.message);
        if (Date.now() >= context.deadline) {
          error.code = "GAME_ASSERT_PENDING";
          throw error;
        }
        // Only inspect the owned dialog while paused. Never replay menu/join
        // actions, call game code, or extend the native/proof watchdog lifetime.
        await this.sleep(1000);
      }
    }
  }
  async open(context, check, progress, deadline, onAssertion = () => {}) {
    Object.assign(context, { check, deadline, onAssertion });
    if (!context.attempted || !context.pid)
      throw Error("客户端没有完成原生调试初始化");
    while (Date.now() - context.preparedAt < this.menuDelay) {
      check();
      if (Date.now() > deadline) throw Error("等待菜单超时");
      await this.sleep(200);
    }
    for (;;) {
      check();
      try {
        await this.inspect(context);
        break;
      } catch (e) {
        if (!e.transient || Date.now() > deadline) throw e;
        await this.sleep(400);
      }
    }
    check();
    await this.window(this.runtime, context.worker, context.pid, "play");
    progress("finding_room", "正在读取游戏原生局域网房间列表");
    const end = Math.min(deadline, Date.now() + 20000);
    let lastError;
    // Only retry read-only discovery/connect. Never replay the Enter or join call.
    while (Date.now() < end) {
      check();
      const cdp = new this.Cdp(context.port, context.pid, check);
      context.cdp = cdp;
      try {
        await cdp.connect();
        context.connected = true;
        break;
      } catch (e) {
        lastError = e;
        cdp.close();
        await this.inspect(context);
        // A disconnect confirmation may consume the first Enter. Only advance
        // once more after the owned HTTP endpoint repeatedly confirms no OreUI
        // page exists; transport errors never authorize another key press.
        if (
          context.reconnecting &&
          !context.advancedMenu &&
          e.code === "ORE_MENU_NOT_PRESENT"
        ) {
          context.absentSince ||= Date.now();
          if (Date.now() - context.absentSince >= 5000) {
            context.advancedMenu = true;
            await this.window(
              this.runtime,
              context.worker,
              context.pid,
              "play",
            );
          }
        }
        await this.sleep(400);
      }
    }
    if (!context.connected)
      throw Error("原生游戏菜单未就绪：" + (lastError?.message || "超时"));
    context.setup = true;
    await context.cdp.evaluate(context.script.init);
  }
  async discover(context, target) {
    const data = JSON.parse(await context.cdp.evaluate(context.script.read));
    if (!data.ready) return null;
    return selectRoom(data.rows, target);
  }
  async dispatch(context, row) {
    if (context.sent) throw Error("入房请求已经发送，不自动重放");
    context.sent = true;
    await context.cdp.evaluate(context.script.send(row.id));
  }
  async status(context) {
    let d;
    try {
      d = JSON.parse(await context.cdp.evaluate(context.script.read));
    } catch (e) {
      if (/连接|关闭|context|missing setup|操作超时/.test(e.message)) return;
      throw e;
    }
    if (d.state === 2 && d.result !== 0 && d.result !== null)
      throw Error("游戏拒绝加入房间（原生结果码 " + d.result + "）");
  }
  async close(context) {
    if (!context || context.closed) return;
    await context.release();
    let cleanupError;
    if (context.setup && context.cdp && !context.assertionPending)
      try {
        await context.cdp.evaluate(context.script.cleanup);
      } catch (e) {
        cleanupError = e;
      }
    context.cdp?.close();
    if (context.attempted && context.worker?.session?.running) {
      await this.call(this.runtime, context.worker, context.pid, "seal");
      context.sealed = true;
    }
    context.closed = true;
    if (cleanupError && context.worker?.session?.running)
      context.worker.log(
        "system",
        "原生菜单已封闭，页面清理未确认：" + cleanupError.message,
      );
  }
}
module.exports = { OreJoin, hostIdentity, selectRoom, scripts };
