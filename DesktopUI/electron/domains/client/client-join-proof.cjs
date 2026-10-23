// Temporary random event on the existing debug systems. Nothing is persisted
// in a world. Only the engine-injected __id__ proves which player replied.
function proofCode(token, action) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw Error("无效联机验证令牌");
  const key = "dgn_join_" + token;
  const common = [
    "import mod.server.extraServerApi as api",
    "from DEBUG_ENV_SCRIPT.QuModLibs.Systems.Loader.SharedRes import NAMESPACE,SYSTEMNAME",
    "s=api.GetSystem(NAMESPACE,SYSTEMNAME)",
    `key='${key}'`,
  ];
  if (action === "prepare")
    return common
      .concat([
        "if s is None: raise RuntimeError('Host debug system is unavailable')",
        "class DgnJoinProof(object):",
        " def __init__(self, system, namespace, systemname, event):",
        "  self.system=system; self.namespace=namespace; self.systemname=systemname; self.event=event; self.seen=[]; self.active=True",
        " def receive(self,args):",
        "  if len(self.seen)<16 and args.get('nonce')==self.event and args.get('__id__') is not None:",
        "   self.seen.append(str(args['__id__']))",
        " def cleanup(self):",
        "  if self.active:",
        "   self.active=False; self.system.UnListenForEvent(self.namespace,self.systemname,self.event,self,self.receive)",
        "   if hasattr(self.system,self.event): delattr(self.system,self.event)",
        "o=DgnJoinProof(s,NAMESPACE,SYSTEMNAME,key)",
        "setattr(s,key,o)",
        "s.ListenForEvent(NAMESPACE,SYSTEMNAME,key,o,o.receive)",
        "api.GetEngineCompFactory().CreateGame(api.GetLevelId()).AddTimer(180,o.cleanup)",
        "_result=True",
      ])
      .join("\n");
  if (action === "read")
    return common
      .concat([
        "o=getattr(s,key,None)",
        "_result={'players':o.seen[:] if o else []}",
      ])
      .join("\n");
  if (action === "cleanup")
    return common
      .concat(["o=getattr(s,key,None)", "if o: o.cleanup()", "_result=True"])
      .join("\n");
  if (action === "send")
    return [
      "import mod.client.extraClientApi as api",
      "from DEBUG_ENV_SCRIPT.QuModLibs.Systems.Loader.SharedRes import NAMESPACE,SYSTEMNAME",
      "s=api.GetSystem(NAMESPACE,SYSTEMNAME)",
      "if s is None: raise RuntimeError('Client debug system is unavailable')",
      `s.NotifyToServer('${key}',{'nonce':'${key}'})`,
      "_result={'playerId':str(api.GetLocalPlayerId())}",
    ].join("\n");
  throw Error("无效联机验证操作");
}
module.exports = { proofCode };
