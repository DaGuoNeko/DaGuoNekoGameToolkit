const test = require("node:test"), assert = require("node:assert/strict"), { spawnSync } = require("node:child_process");
const runtime = require("../electron/domains/worlds/terrain-runtime.cjs");
test("terrain Python guards unloaded/changed dimensions, compares before writes, detects partial failure and safely undoes", () => {
  const air = { name: "minecraft:air", states: {}, entity: null }, stone = { name: "minecraft:stone", states: {}, entity: null };
  const data = { id: "fixture", player: "123", dimension: 3, min: [0,64,0], max: [1,64,0], op: "write", writes: [0,1].map(x=>({pos:[x,64,0],before:air,after:stone})) };
  const setup = `import sys,types,json,copy
unicode=type('LegacyUnicode',(str,),{})
world={(0,64,0):json.loads('${JSON.stringify(air)}'),(1,64,0):json.loads('${JSON.stringify(air)}')}
state={'dimension':3,'loaded':True,'writes':0,'saved':0,'areas':set(),'timers':[],'fail':None}
class Comp:
 def CreateBlockInfo(self,*a):return self
 def CreateBlockState(self,*a):return self
 def CreateChunkSource(self,*a):return self
 def CreateDimension(self,*a):return self
 def CreateGame(self,*a):return self
 def GetEntityDimensionId(self):return state['dimension']
 def GetBlockNew(self,p,d):return {'name':world[p]['name'],'aux':0}
 def GetBlockStates(self,p,d):return copy.deepcopy(world[p]['states'])
 def GetBlockEntityData(self,d,p):return copy.deepcopy(world[p]['entity'])
 def GetLiquidBlock(self,p,d):return None
 def GetBlockAuxValueFromStates(self,n,s):return -1 if n==b'minecraft:unknown' else 0
 def SetBlockNew(self,p,b,*a):
  if state['fail']==p:return False
  world[p]={'name':b['name'].decode() if isinstance(b['name'],bytes) else b['name'],'states':{},'entity':None};state['writes']+=1;return True
 def SetBlockEntityData(self,d,p,n):world[p]['entity']=copy.deepcopy(n);return True
 def SetAddArea(self,k,*a):state['areas'].add(k);return True
 def DeleteArea(self,k):state['areas'].discard(k);return True
 def CheckChunkState(self,*a):return state['loaded']
 def AddTimer(self,t,fn):state['timers'].append(fn)
c=Comp()
api=types.ModuleType('mod.server.extraServerApi');api.GetEngineCompFactory=lambda:c;api.GetLevelId=lambda:'level';api.GetPlayerList=lambda:['123']
mod=types.ModuleType('mod');server=types.ModuleType('mod.server');mod.server=server;server.extraServerApi=api
sys.modules.update({'mod':mod,'mod.server':server,'mod.server.extraServerApi':api})
sv=types.ModuleType('serverlevel')
def save():state['saved']+=1
sv.save_game_data=save;sys.modules['serverlevel']=sv
`;
  const advance = "\nif state['loaded'] and state['timers']:state['timers'].pop()()\n";
  const start = `exec(${JSON.stringify(runtime.startCode(data))})\n` + advance;
  const script = setup + start + `assert _dgn_terrain_batch.result['phase']=='done'
assert state['writes']==2 and state['saved']==1 and not state['areas']
` + start + `assert _dgn_terrain_batch.result['phase']=='error' and state['writes']==2
` + `exec(${JSON.stringify(runtime.startCode({ ...data, op: "undo" }))})
${advance}
assert _dgn_terrain_batch.result['phase']=='done' and world[(0,64,0)]['name']=='minecraft:air'
state['loaded']=False
` + start + `assert _dgn_terrain_batch.result['phase']=='loading' and state['areas']
state['dimension']=4
state['timers'].pop()()
assert _dgn_terrain_batch.result['phase']=='error' and not state['areas'] and state['writes']==4
state['loaded']=True;state['dimension']=3;state['fail']=(1,64,0)
` + start + `assert _dgn_terrain_batch.result['phase']=='error' and _dgn_terrain_batch.result['completed']==1
state['fail']=None
exec(${JSON.stringify(runtime.startCode({ ...data, op: "undo" }))})
${advance}
assert _dgn_terrain_batch.result['phase']=='done'
assert all(b['name']=='minecraft:air' for b in world.values())
state['loaded']=False
` + start + `exec(${JSON.stringify(runtime.cancelCode("fixture"))})
state['timers'].pop()()
assert not state['areas'] and all(b['name']=='minecraft:air' for b in world.values())
print('ok')
`;
  const result = spawnSync("python", ["-"], { input: script, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /ok/);
});
