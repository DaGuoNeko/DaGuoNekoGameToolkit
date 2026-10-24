// 仅重定向本次世界的包目录和启动配置，数据库及游戏进度直接写回原存档。
#include <winternl.h>
static WCHAR worldSource[32768],worldMount[32768],worldView[32768],packView[32768],packManifests[32768],globalPacks[32768];
static NTSTATUS (NTAPI *realNtCreate)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
static NTSTATUS (NTAPI *realNtOpen)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,ULONG,ULONG);
static NTSTATUS (NTAPI *realNtAttributes)(POBJECT_ATTRIBUTES,PVOID);
static NTSTATUS (NTAPI *realNtFullAttributes)(POBJECT_ATTRIBUTES,PVOID);
static NTSTATUS (NTAPI *realNtSet)(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,FILE_INFORMATION_CLASS);
#define WORLD_INVALID ((WCHAR*)1)
static BOOL runtimePart(const WCHAR *part){
 const WCHAR *names[]={L"behavior_packs",L"resource_packs",L".toolbox-packs",L"world_behavior_packs.json",L"world_resource_packs.json",L"netease_world_behavior_packs.json",L"netease_world_resource_packs.json",L"world_behavior_pack_history.json",L"world_resource_pack_history.json",L"dev_config.cppconfig"};
 for(unsigned i=0;i<sizeof(names)/sizeof(names[0]);i++){
  int n=lstrlenW(names[i]);
  if(lstrlenW(part)>=n&&CompareStringOrdinal(part,n,names[i],n,TRUE)==CSTR_EQUAL&&(!part[n]||part[n]==L'\\'||(i>=3&&part[n]==L'.')))return TRUE;
 }
 return FALSE;
}
static const WCHAR *worldRelative(const WCHAR *file,const WCHAR *root){
 int n=lstrlenW(root);
 return n&&lstrlenW(file)>n&&file[n]==L'\\'&&CompareStringOrdinal(file,n,root,n,TRUE)==CSTR_EQUAL?file+n+1:NULL;
}
static BOOL packManifest(const WCHAR *file,WCHAR *result){
 const WCHAR *relative=worldRelative(file,packView);
 if(!relative)relative=worldRelative(file,globalPacks);
 if(!relative)return FALSE;
 const WCHAR *id=NULL;
 if(lstrlenW(relative)>15&&CompareStringOrdinal(relative,15,L"behavior_packs\\",15,TRUE)==CSTR_EQUAL)id=relative+15;
 else if(lstrlenW(relative)>15&&CompareStringOrdinal(relative,15,L"resource_packs\\",15,TRUE)==CSTR_EQUAL)id=relative+15;
 if(!id||lstrlenW(id)!=46||!same(id+32,L"\\manifest.json"))return FALSE;
 for(int i=0;i<32;i++)if(!((id[i]>=L'0'&&id[i]<=L'9')||(id[i]>=L'a'&&id[i]<=L'f')||(id[i]>=L'A'&&id[i]<=L'F')))return FALSE;
 lstrcpyW(result,L"\\??\\");lstrcatW(result,packManifests);lstrcatW(result,L"\\");
 int n=lstrlenW(result);CopyMemory(result+n,id,32*sizeof(WCHAR));result[n+32]=0;lstrcatW(result,L".json");
 return GetFileAttributesW(result+4)!=INVALID_FILE_ATTRIBUTES;
}
static WCHAR *mappedWorldName(HANDLE parent,const UNICODE_STRING *name){
 if(!worldView[0]||!name||!name->Buffer||!name->Length)return NULL;
 if(name->Length%2)return WORLD_INVALID;
 WCHAR *memory=HeapAlloc(GetProcessHeap(),0,3*32768*sizeof(WCHAR));
 if(!memory)return WORLD_INVALID;
 WCHAR *input=memory,*absolute=memory+32768,*result=memory+65536;
 DWORD used=0;unsigned chars=name->Length/2;
 if(parent){
  used=GetFinalPathNameByHandleW(parent,input,32768,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if(!used||used>=32767)goto invalid;
  input[used++]=L'\\';
 }
 if(used+chars>=32768)goto invalid;
 CopyMemory(input+used,name->Buffer,name->Length);input[used+chars]=0;
 WCHAR *dos=input;
 if(lstrlenW(dos)>4&&((dos[0]==L'\\'&&dos[1]==L'?'&&dos[2]==L'?'&&dos[3]==L'\\')||(dos[0]==L'\\'&&dos[1]==L'\\'&&dos[2]==L'?'&&dos[3]==L'\\')))dos+=4;
 if(lstrlenW(dos)<3||dos[1]!=L':'||(dos[2]!=L'\\'&&dos[2]!=L'/'))goto unrelated;
 DWORD n=GetFullPathNameW(dos,32768,absolute,NULL);
 if(!n||n>=32768)goto invalid;
 if(packView[0]&&packManifest(absolute,result))goto mapped;
 const WCHAR *relative=worldRelative(absolute,worldMount);
 if(!relative)relative=worldRelative(absolute,worldSource);
 if(!relative||!runtimePart(relative))goto unrelated;
 if(lstrlenW(worldView)+lstrlenW(relative)+6>=32767)goto invalid;
 lstrcpyW(result,L"\\??\\");lstrcatW(result,worldView);lstrcatW(result,L"\\");lstrcatW(result,relative);
 mapped:;
 SIZE_T bytes=(lstrlenW(result)+1)*sizeof(WCHAR);
 if(bytes>65534)goto invalid;
 MoveMemory(memory,result,bytes);return memory;
 unrelated:HeapFree(GetProcessHeap(),0,memory);return NULL;
 invalid:HeapFree(GetProcessHeap(),0,memory);return WORLD_INVALID;
}
typedef struct {OBJECT_ATTRIBUTES attributes;UNICODE_STRING name;WCHAR *buffer;} WorldObject;
static POBJECT_ATTRIBUTES worldObject(POBJECT_ATTRIBUTES original,WorldObject *value){
 value->buffer=original?mappedWorldName(original->RootDirectory,original->ObjectName):NULL;
 if(!value->buffer||value->buffer==WORLD_INVALID)return original;
 value->name.Buffer=value->buffer;value->name.Length=(USHORT)(lstrlenW(value->buffer)*2);value->name.MaximumLength=value->name.Length+2;
 value->attributes=*original;value->attributes.RootDirectory=NULL;value->attributes.ObjectName=&value->name;return &value->attributes;
}
static void freeWorldObject(WorldObject *value){if(value->buffer&&value->buffer!=WORLD_INVALID)HeapFree(GetProcessHeap(),0,value->buffer);}
static NTSTATUS NTAPI worldCreate(PHANDLE h,ACCESS_MASK access,POBJECT_ATTRIBUTES attr,PIO_STATUS_BLOCK io,PLARGE_INTEGER size,ULONG flags,ULONG share,ULONG disposition,ULONG options,PVOID ea,ULONG eaLength){
 WorldObject value;POBJECT_ATTRIBUTES mapped=worldObject(attr,&value);
 if(value.buffer==WORLD_INVALID)return (NTSTATUS)0xC0000033;
 NTSTATUS status=realNtCreate(h,access,mapped,io,size,flags,share,disposition,options,ea,eaLength);freeWorldObject(&value);return status;
}
static NTSTATUS NTAPI worldOpen(PHANDLE h,ACCESS_MASK access,POBJECT_ATTRIBUTES attr,PIO_STATUS_BLOCK io,ULONG share,ULONG options){
 WorldObject value;POBJECT_ATTRIBUTES mapped=worldObject(attr,&value);
 if(value.buffer==WORLD_INVALID)return (NTSTATUS)0xC0000033;
 NTSTATUS status=realNtOpen(h,access,mapped,io,share,options);freeWorldObject(&value);return status;
}
static NTSTATUS NTAPI worldAttributes(POBJECT_ATTRIBUTES attr,PVOID out){
 WorldObject value;POBJECT_ATTRIBUTES mapped=worldObject(attr,&value);
 if(value.buffer==WORLD_INVALID)return (NTSTATUS)0xC0000033;
 NTSTATUS status=realNtAttributes(mapped,out);freeWorldObject(&value);return status;
}
static NTSTATUS NTAPI worldFullAttributes(POBJECT_ATTRIBUTES attr,PVOID out){
 WorldObject value;POBJECT_ATTRIBUTES mapped=worldObject(attr,&value);
 if(value.buffer==WORLD_INVALID)return (NTSTATUS)0xC0000033;
 NTSTATUS status=realNtFullAttributes(mapped,out);freeWorldObject(&value);return status;
}
typedef struct {ULONG flags;HANDLE root;ULONG length;WCHAR name[1];} WorldRename;
static NTSTATUS NTAPI worldSet(HANDLE file,PIO_STATUS_BLOCK io,PVOID buffer,ULONG size,FILE_INFORMATION_CLASS kind){
 if((kind==10||kind==11||kind==65||kind==72)&&buffer&&size>=offsetof(WorldRename,name)){
  WorldRename *old=buffer;
  if(old->length<=size - offsetof(WorldRename,name)&&old->length<=65534){
   UNICODE_STRING name={(USHORT)old->length,(USHORT)old->length,old->name};
   WCHAR *mapped=mappedWorldName(old->root,&name);
   if(mapped==WORLD_INVALID)return (NTSTATUS)0xC0000033;
   if(mapped){
    ULONG bytes=(ULONG)lstrlenW(mapped)*2,total=(ULONG)offsetof(WorldRename,name)+bytes;
    WorldRename *next=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,total);
    if(!next){HeapFree(GetProcessHeap(),0,mapped);return (NTSTATUS)0xC0000017;}
    next->flags=old->flags;next->length=bytes;CopyMemory(next->name,mapped,bytes);
    NTSTATUS status=realNtSet(file,io,next,total,kind);HeapFree(GetProcessHeap(),0,next);HeapFree(GetProcessHeap(),0,mapped);return status;
   }
  }
 }
 return realNtSet(file,io,buffer,size,kind);
}
static BOOL installWorldView(void){
 WCHAR enabled[2];if(!GetEnvironmentVariableW(L"DGN_WORLD_VIEW",enabled,2))return TRUE;
 if(!variable(L"DGN_WORLD_SOURCE",worldSource)||!variable(L"DGN_WORLD_MOUNT",worldMount)||!variable(L"DGN_WORLD_VIEW",worldView))return FALSE;
 if(!variable(L"DGN_PACK_VIEW",packView)||!variable(L"DGN_PACK_MANIFESTS",packManifests)||lstrlenW(packManifests)>32000||lstrlenW(roaming)>32000)return FALSE;
 lstrcpyW(globalPacks,roaming);lstrcatW(globalPacks,L"\\MinecraftPE_Netease");
 return hook(L"ntdll.dll","NtCreateFile",worldCreate,(void**)&realNtCreate)&&hook(L"ntdll.dll","NtOpenFile",worldOpen,(void**)&realNtOpen)&&hook(L"ntdll.dll","NtQueryAttributesFile",worldAttributes,(void**)&realNtAttributes)&&hook(L"ntdll.dll","NtQueryFullAttributesFile",worldFullAttributes,(void**)&realNtFullAttributes)&&hook(L"ntdll.dll","NtSetInformationFile",worldSet,(void**)&realNtSet);
}
