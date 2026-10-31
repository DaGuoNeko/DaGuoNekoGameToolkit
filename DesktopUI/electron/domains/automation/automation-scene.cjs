const payload = value => `__import__('json').loads(__import__('base64').b64decode('${Buffer.from(JSON.stringify(value)).toString("base64")}'))`;
const { gameplayUIs } = require("./automation-observation.cjs");
const clientBase = `import mod.client.extraClientApi as api
p=api.GetLocalPlayerId()
if p is None or str(p) in ('-1','0',''): raise RuntimeError('PLAYER_UNAVAILABLE')
f=api.GetEngineCompFactory()
camera=f.CreateCamera(api.GetLevelId())
view=f.CreatePlayerView(p)
`;
function clientCode(settings, write = false) {
  return `# DGN_SCENE_CLIENT_${write ? "APPLY" : "READ"}\n` + clientBase + `
d=${payload(settings)}
needed=['GetCameraRotation','GetFov']+(['SetCameraRotation'] if 'rotation' in d else [])+(['SetFov'] if 'fov' in d else [])
if not all(callable(getattr(camera,n,None)) for n in needed): raise RuntimeError('CAMERA_UNSUPPORTED')
if not callable(getattr(view,'GetPerspective',None)) or ('perspective' in d and not callable(getattr(view,'SetPerspective',None))): raise RuntimeError('PERSPECTIVE_UNSUPPORTED')
` + (write ? `
if 'perspective' in d and not view.SetPerspective(d['perspective']): raise RuntimeError('PERSPECTIVE_REJECTED')
if 'fov' in d and not camera.SetFov(float(d['fov'])): raise RuntimeError('FOV_REJECTED')
if 'rotation' in d and not camera.SetCameraRotation(tuple(d['rotation'])): raise RuntimeError('CAMERA_REJECTED')
` : "") + `
_result={'playerId':str(p),'position':f.CreatePos(p).GetFootPos(),'rotation':camera.GetCameraRotation(),'fov':camera.GetFov(),'perspective':view.GetPerspective(),'hudHidden':None,'topUI':api.GetTopUI()}
`;
}
function serverCode(playerId, settings, write = false) {
  return `# DGN_SCENE_SERVER_${write ? "APPLY" : "READ"}
import mod.server.extraServerApi as api
import math
p=${payload(playerId)}
if p not in api.GetPlayerList(): raise RuntimeError('PLAYER_LEFT')
d=${payload(settings)}
f=api.GetEngineCompFactory()
dimension=f.CreateDimension(p)
position=f.CreatePos(p)
clock=f.CreateTime(api.GetLevelId())
weather=f.CreateWeather(api.GetLevelId())
game=f.CreateGame(api.GetLevelId())
chunks=f.CreateChunkSource(api.GetLevelId())
targetDim=d.get('dimension',dimension.GetEntityDimensionId())
if 'weather' in d and (targetDim in (1,2) or not hasattr(weather,'GetDimensionUseLocalWeather') or weather.GetDimensionUseLocalWeather(targetDim)): raise RuntimeError('LOCAL_OR_NON_WEATHER_DIMENSION_UNSUPPORTED')
required=[(dimension,'GetEntityDimensionId'),(position,'GetFootPos'),(clock,'GetTime'),(weather,'IsRaining'),(weather,'IsThunder'),(chunks,'CheckChunkState'),(game,'GetGameRulesInfoServer')]
if 'position' in d: required.append((position,'SetFootPos'))
if 'dimension' in d: required.append((dimension,'ChangePlayerDimension'))
if 'timeOfDay' in d: required.extend([(clock,'SetTimeOfDay'),(game,'SetGameRulesInfoServer')])
if 'weather' in d: required.extend([(weather,'SetRaining'),(weather,'SetThunder'),(game,'SetGameRulesInfoServer')])
if not all(callable(getattr(o,n,None)) for o,n in required): raise RuntimeError('SCENE_API_UNSUPPORTED')
` + (write ? `
rules={}
if 'timeOfDay' in d: rules['daylight_cycle']=False
if 'weather' in d: rules['weather_cycle']=False
if rules and not game.SetGameRulesInfoServer({'cheat_info':rules}): raise RuntimeError('SCENE_RULES_REJECTED')
if 'timeOfDay' in d and not clock.SetTimeOfDay(d['timeOfDay']): raise RuntimeError('TIME_REJECTED')
if 'weather' in d:
    if not weather.SetRaining(0.0 if d['weather']=='clear' else 1.0,12000): raise RuntimeError('RAIN_REJECTED')
    if not weather.SetThunder(1.0 if d['weather']=='thunder' else 0.0,12000): raise RuntimeError('THUNDER_REJECTED')
if targetDim!=dimension.GetEntityDimensionId():
    pos=d.get('position')
    if pos is None: raise RuntimeError('DIMENSION_REQUIRES_POSITION')
    if not dimension.ChangePlayerDimension(targetDim,(pos[0],pos[1]+1.62,pos[2])): raise RuntimeError('DIMENSION_REJECTED')
elif 'position' in d and not position.SetFootPos(tuple(d['position'])): raise RuntimeError('POSITION_REJECTED')
` : "") + `
pos=position.GetFootPos()
dim=dimension.GetEntityDimensionId()
radius=d.get('chunkRadius',1)
loaded=pos is not None and all(chunks.CheckChunkState(dim,(int(math.floor(pos[0]))+x*16,int(math.floor(pos[1])),int(math.floor(pos[2]))+z*16)) for x in range(-radius,radius+1) for z in range(-radius,radius+1))
_result={'playerId':str(p),'position':pos,'dimension':dim,'timeOfDay':clock.GetTime()%24000,'weather':'thunder' if weather.IsThunder() else ('rain' if weather.IsRaining() else 'clear'),'chunksLoaded':bool(loaded),'chunkRadius':radius,'rules':game.GetGameRulesInfoServer().get('cheat_info',{})}
`;
}
const near = (a, b, tolerance, angle = false) => Array.isArray(a) && a.length === b.length && a.every((x,i) => Number.isFinite(x) && Math.abs(angle ? ((x-b[i]+540)%360)-180 : x-b[i]) <= tolerance);
function matches(settings, client, server) {
  return server.chunksLoaded === true && gameplayUIs.includes(client.topUI) &&
    (settings.position === undefined || (near(server.position,settings.position,0.15) && near(client.position,settings.position,0.15))) &&
    (settings.dimension === undefined || server.dimension === settings.dimension) &&
    (settings.rotation === undefined || near(client.rotation,settings.rotation,0.5,true)) &&
    (settings.fov === undefined || Math.abs(client.fov-settings.fov)<0.1) &&
    (settings.perspective === undefined || client.perspective===settings.perspective) &&
    (settings.hudHidden === undefined || client.hudHidden===settings.hudHidden) &&
    (settings.timeOfDay === undefined || (server.timeOfDay===settings.timeOfDay && server.rules?.daylight_cycle===false)) &&
    (settings.weather === undefined || (server.weather===settings.weather && server.rules?.weather_cycle===false));
}
async function captureScene(router, args) {
  const worker=router.worker(args.sessionId), b={...router.bridge(worker,args.generation,true)};
  if (worker.session.role!=="world") throw Error("SCENE_HOST_REQUIRED：固定拍摄需要本工具的存档主机会话");
  const settings=args.settings, deadline=Date.now()+(args.timeoutMs ?? 30000);
  const report={phase:"preflight",requested:settings,applied:[],before:null,actual:null};
  const run=async (code,client) => {
    router.guard(worker,args.generation,b.stateSequence,b.minecraftPid);
    if(Date.now()>=deadline) throw Error("SCENE_TIMEOUT");
    const value=await router.debug.code(b.id,args.generation,code,client,()=>router.guard(worker,args.generation,b.stateSequence,b.minecraftPid));
    router.guard(worker,args.generation,b.stateSequence,b.minecraftPid);
    if(Date.now()>=deadline) throw Error("SCENE_TIMEOUT");
    return value;
  };
  try {
    // 尚无经验证的 HUD 状态回读，不能拿请求值充当结果。
    if (settings.hudHidden !== undefined) throw Error("HUD_READBACK_UNSUPPORTED：当前版本无法验证 HUD 实际状态，请省略 hudHidden");
    const readiness=await router.readiness(args);
    if(!readiness.ready || readiness.safeToCaptureScene !== true)
      throw Error("SCENE_NOT_READY："+readiness.blockers.join(","));
    const c=await run(clientCode(settings),true), s=await run(serverCode(c.playerId,settings),false);
    report.before={client:c,server:s};
    report.phase="applying";
    await run(serverCode(c.playerId,settings,true),false);
    report.applied.push("server");
    await run(clientCode(settings,true),true);
    report.applied.push("client");
    report.phase="waiting_readback";
    for(;;) {
      await new Promise(r=>setTimeout(r,250));
      const client=await run(clientCode(settings),true), server=await run(serverCode(c.playerId,settings),false);
      report.actual={client,server};
      if(client.playerId!==c.playerId) throw Error("SCENE_PLAYER_CHANGED");
      if(!matches(settings,client,server)) continue;
      const capture=await router.capture(args);
      const afterClient=await run(clientCode(settings),true), afterServer=await run(serverCode(c.playerId,settings),false);
      report.actual={client:afterClient,server:afterServer};
      if(afterClient.playerId!==c.playerId) throw Error("SCENE_PLAYER_CHANGED");
      if(!matches(settings,afterClient,afterServer)) throw Error("SCENE_CHANGED_DURING_CAPTURE");
      report.phase="captured";
      return {content:[...capture.content,{type:"text",text:JSON.stringify(report)}]};
    }
  } catch(error) {
    return {isError:true,content:[{type:"text",text:JSON.stringify({...report,notComparable:true,error:error.message,effectsMayRemain:report.phase!=="preflight",retry:"先读取状态；不自动重放"})}]};
  }
}
module.exports={clientCode,serverCode,matches,captureScene};
