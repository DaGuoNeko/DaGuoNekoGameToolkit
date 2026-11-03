const payload = value => `__import__('json').loads(__import__('base64').b64decode('${Buffer.from(JSON.stringify(value)).toString("base64")}'))`;
const runtime = String.raw`
import mod.server.extraServerApi as api
import time, json, math
def dgn_terrain_utf8(value):
    if isinstance(value,unicode): return value.encode('utf-8')
    if isinstance(value,list): return [dgn_terrain_utf8(v) for v in value]
    if isinstance(value,dict): return {dgn_terrain_utf8(k):dgn_terrain_utf8(v) for k,v in value.items()}
    return value
class DgnTerrainBatch(object):
    def __init__(self, data):
        self.data=dgn_terrain_utf8(data)
        self.result={'phase':'loading'}
        self.cancelled=False
        self.deadline=time.time()+45
        self.factory=api.GetEngineCompFactory()
        self.info=self.factory.CreateBlockInfo(api.GetLevelId())
        self.states=self.factory.CreateBlockState(api.GetLevelId())
        self.chunks=self.factory.CreateChunkSource(api.GetLevelId())
        self.area=('dgn_terrain_'+data['id']).encode('ascii')
        self.ownsArea=False
        self.liquidSkipped=False
    def cleanup(self):
        if self.ownsArea:
            self.chunks.DeleteArea(self.area)
            self.ownsArea=False
    def cancel(self):
        self.cancelled=True
        self.cleanup()
        self.result={'phase':'error','message':'Cancelled'}
    def guard(self):
        if self.cancelled or time.time()>self.deadline: raise RuntimeError('Terrain batch cancelled or expired')
        if str(self.data['player']) not in [str(x) for x in api.GetPlayerList()]: raise RuntimeError('Player left the world')
        if self.factory.CreateDimension(str(self.data['player'])).GetEntityDimensionId()!=self.data['dimension']: raise RuntimeError('Player dimension changed')
    def read(self,pos):
        b=self.info.GetBlockNew(tuple(pos),self.data['dimension'])
        if not b or not b.get('name'): raise RuntimeError('Block is unavailable')
        name=b['name']
        state=self.states.GetBlockStates(tuple(pos),self.data['dimension'])
        if state is None and name!='minecraft:air': raise RuntimeError('Block states are unavailable: '+name)
        entity=self.info.GetBlockEntityData(self.data['dimension'],tuple(pos)) if name!='minecraft:air' else None
        result={'name':name,'states':state or {},'entity':entity}
        liquid=self.info.GetLiquidBlock(tuple(pos),self.data['dimension'])
        if liquid and liquid.get('name')!=name and liquid.get('name')!='minecraft:air':
            result['liquid']={'name':liquid['name'],'aux':liquid.get('aux',0)}
        return dgn_terrain_utf8(result)
    def write(self,pos,b):
        name=b['name'].encode('utf-8') if isinstance(b['name'],unicode) else b['name']
        states={k.encode('utf-8') if isinstance(k,unicode) else k:v.encode('utf-8') if isinstance(v,unicode) else v for k,v in b['states'].items()}
        aux=self.states.GetBlockAuxValueFromStates(name,states)
        if aux is None or aux<0: raise RuntimeError('Unsupported block states: '+name)
        self.info.SetBlockNew(tuple(pos),{'name':name,'aux':aux},0,self.data['dimension'],True,False)
        liquid=b.get('liquid')
        currentLiquid=self.info.GetLiquidBlock(tuple(pos),self.data['dimension'])
        if liquid or (currentLiquid and currentLiquid.get('name')!=name):
            liquid=liquid or {'name':'minecraft:air','aux':0}
            liquid={'name':liquid['name'].encode('utf-8') if isinstance(liquid['name'],unicode) else liquid['name'],'aux':liquid['aux']}
            if not self.info.SetLiquidBlock(tuple(pos),liquid,self.data['dimension']): self.liquidSkipped=True
        if b.get('entity') is not None:
            if not self.info.SetBlockEntityData(self.data['dimension'],tuple(pos),b['entity']): raise RuntimeError('Block entity write failed')
    def verify(self):
        done=0
        try:
            self.guard()
            for w in self.data['writes']:
                wanted=w['before'] if self.data['op']=='undo' else w['after']
                actual=self.read(w['pos'])
                if wanted.get('liquid') or wanted.get(b'liquid') or self.liquidSkipped:
                    self.liquidSkipped=True
                    done+=1
                    continue
                if self.liquidSkipped or wanted.get('liquid'):
                    actual.pop('liquid',None); wanted=__import__('copy').deepcopy(wanted); wanted.pop('liquid',None)
                if actual!=wanted: raise RuntimeError('Block readback mismatch at '+str(w['pos']))
                done+=1
            import serverlevel
            serverlevel.save_game_data()
            self.result={'phase':'done','completed':done,'liquidSkipped':self.liquidSkipped}
        except Exception as error:
            self.result={'phase':'error','completed':done,'message':str(error)}
        finally: self.cleanup()
    def loaded(self,result):
        if self.cancelled: return
        done=0
        try:
            self.guard()
            if result.get('code')!=1: raise RuntimeError('Chunk loading failed')
            if self.data['op']=='read':
                lo,hi=self.data['min'],self.data['max']
                blocks=[self.read((x,y,z)) for x in range(lo[0],hi[0]+1) for z in range(lo[2],hi[2]+1) for y in range(lo[1],hi[1]+1)]
                self.result={'phase':'done','blocks':blocks}
                return
            writes=self.data['writes']
            for w in writes:
                actual=self.read(w['pos'])
                valid=actual==w['before'] or (self.data['op']=='undo' and actual==w['after'])
                if not valid: raise RuntimeError('Target changed after preview; no automatic overwrite')
            for w in writes:
                self.guard()
                wanted=w['before'] if self.data['op']=='undo' else w['after']
                if self.read(w['pos'])!=wanted: self.write(w['pos'],wanted)
                done+=1
            # 方块实体的原生字段可能到下一游戏帧才完成更新，只重读，不重放写入。
            self.factory.CreateGame(api.GetLevelId()).AddTimer(0.05,self.verify)
        except Exception as error:
            self.result={'phase':'error','completed':done,'message':str(error)}
        finally:
            if self.result['phase']!='loading': self.cleanup()
    def ready(self):
        if self.cancelled: return
        try:
            self.guard()
            lo,hi=self.data['min'],self.data['max']
            if all(self.chunks.CheckChunkState(self.data['dimension'],(x*16,lo[1],z*16)) for x in range(lo[0]//16,hi[0]//16+1) for z in range(lo[2]//16,hi[2]//16+1)):
                self.loaded({'code':1})
            else: self.factory.CreateGame(api.GetLevelId()).AddTimer(0.1,self.ready)
        except Exception as error:
            self.result={'phase':'error','completed':0,'message':str(error)}
            self.cleanup()
    def start(self):
        self.guard()
        if self.data['op']!='read':
            import serverlevel
            if not hasattr(serverlevel,'save_game_data'): raise RuntimeError('Game build cannot save terrain writes')
        lo,hi=self.data['min'],self.data['max']
        self.ownsArea=self.chunks.SetAddArea(self.area,self.data['dimension'],(lo[0]-80,lo[1],lo[2]-80),(hi[0]+80,max(lo[1]+1,hi[1]),hi[2]+80))
        if not self.ownsArea:
            self.result={'phase':'error','completed':0,'message':'Chunk load request rejected'}
        else: self.ready()
`;
function probeCode(player) {
  return `# DGN_TERRAIN_PROBE\nimport mod.server.extraServerApi as api\nimport math\np=${payload(player)}\nif p not in api.GetPlayerList(): raise RuntimeError('Player not ready')\nf=api.GetEngineCompFactory()\npos=f.CreatePos(p).GetFootPos()\ns=f.CreateChunkSource(p)\nc=(int(math.floor(pos[0]/16)),int(math.floor(pos[2]/16)))\n_result={'position':pos,'dimension':f.CreateDimension(p).GetEntityDimensionId(),'min':s.GetChunkMinPos(c),'max':s.GetChunkMaxPos(c)}`;
}
function dimensionProbeCode(player, targetDimension, candidates = []) {
  return `# DGN_DIMENSION_RUNTIME_PROBE
import mod.server.extraServerApi as api, math, json
player=${payload(player)}
target=${payload(targetDimension)}
candidates=${payload(candidates)}
if player not in api.GetPlayerList(): raise RuntimeError('Player not ready')
factory=api.GetEngineCompFactory()
dim=factory.CreateDimension(player)
posComp=factory.CreatePos(player)
originalDim=dim.GetEntityDimensionId()
originalPos=posComp.GetFootPos()
changed=False
try:
    if target is not None and target != originalDim:
        if not hasattr(dim,'ChangePlayerDimension') or not dim.ChangePlayerDimension(target,(originalPos[0],originalPos[1]+1.62,originalPos[2])): raise RuntimeError('DIMENSION_REJECTED')
        changed=True
    currentDim=dim.GetEntityDimensionId()
    position=posComp.GetFootPos()
    chunks=factory.CreateChunkSource(player)
    chunk=(int(math.floor(position[0]/16)),int(math.floor(position[2]/16)))
    minPos=chunks.GetChunkMinPos(chunk)
    maxPos=chunks.GetChunkMaxPos(chunk)
    info=factory.CreateBlockInfo(api.GetLevelId())
    reads=[]
    for y in candidates:
        block=info.GetBlockNew((int(math.floor(position[0])),int(y),int(math.floor(position[2]))),currentDim)
        reads.append({'y':int(y),'block':block})
    _result={'dimension':currentDim,'originalDimension':originalDim,'position':position,'originalPosition':originalPos,'chunk':chunk,'min':minPos,'max':maxPos,'candidateReads':reads,'restored':False}
finally:
    if changed:
        if not dim.ChangePlayerDimension(originalDim,(originalPos[0],originalPos[1]+1.62,originalPos[2])): raise RuntimeError('DIMENSION_RESTORE_FAILED')
        _result['restored']=True`;
}
function buildHeightProbeCode(player, dimension, ys) {
  return `# DGN_BUILD_HEIGHT_PROBE
import mod.server.extraServerApi as api, math
player=${payload(player)}
dimension=${payload(dimension)}
ys=${payload(ys)}
if player not in api.GetPlayerList(): raise RuntimeError('Player not ready')
factory=api.GetEngineCompFactory()
if factory.CreateDimension(player).GetEntityDimensionId()!=dimension: raise RuntimeError('Player dimension changed')
pos=factory.CreatePos(player).GetFootPos()
x,z=int(math.floor(pos[0])),int(math.floor(pos[2]))
info=factory.CreateBlockInfo(api.GetLevelId())
states=factory.CreateBlockState(api.GetLevelId())
def read(y):
    b=info.GetBlockNew((x,y,z),dimension)
    if not b or not b.get('name'): raise RuntimeError('Block unavailable at Y '+str(y))
    s=states.GetBlockStates((x,y,z),dimension)
    e=info.GetBlockEntityData(dimension,(x,y,z)) if b.get('name')!='minecraft:air' else None
    return {'name':b.get('name'),'aux':b.get('aux',0),'states':s or {},'entity':e}
def write(y,b):
    name=b['name'].encode('utf-8') if isinstance(b['name'],unicode) else b['name']
    st={k.encode('utf-8') if isinstance(k,unicode) else k:v.encode('utf-8') if isinstance(v,unicode) else v for k,v in (b.get('states') or {}).items()}
    aux=states.GetBlockAuxValueFromStates(name,st)
    if aux is None or aux<0: aux=b.get('aux',0)
    info.SetBlockNew((x,y,z),{'name':name,'aux':aux},0,dimension,True,False)
    if b.get('entity') is not None: info.SetBlockEntityData(dimension,(x,y,z),b['entity'])
before=[]
for y in ys: before.append({'y':int(y),'block':read(int(y))})
writeResult=[]
try:
    for item in before:
        write(item['y'],{'name':'minecraft:stone','states':{},'entity':None,'aux':0})
        writeResult.append({'y':item['y'],'ok':True,'block':read(item['y'])})
finally:
    restored=[]
    for item in before:
        write(item['y'],item['block'])
        restored.append({'y':item['y'],'block':read(item['y'])})
_result={'dimension':dimension,'position':[x,pos[1],z],'before':before,'write':writeResult,'readback':writeResult,'restored':restored}`;
}
function startCode(data) {
  return "# DGN_TERRAIN_START\n" + runtime + `\n_dgn_data=${payload(data)}\n_dgn_previous=globals().get('_dgn_terrain_batch')\nif _dgn_previous and _dgn_previous.result['phase']=='loading': raise RuntimeError('Terrain batch busy')\n_dgn_terrain_batch=DgnTerrainBatch(_dgn_data)\n_dgn_terrain_batch.start()\n_result={'accepted':True}`;
}
const statusCode = id => `# DGN_TERRAIN_STATUS\n_dgn_b=globals().get('_dgn_terrain_batch')\nif not _dgn_b or _dgn_b.data['id']!=${payload(id)}: raise RuntimeError('Terrain batch identity changed')\n_result=_dgn_b.result`;
const cancelCode = id => `# DGN_TERRAIN_CANCEL\n_dgn_b=globals().get('_dgn_terrain_batch')\nif _dgn_b and _dgn_b.data['id']==${payload(id)}: _dgn_b.cancel()\n_result=True`;
module.exports = { probeCode, dimensionProbeCode, buildHeightProbeCode, startCode, statusCode, cancelCode };
