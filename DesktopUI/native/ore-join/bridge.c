// Own-process OreUI transport. No game file or persisted option is changed.
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdint.h>
#include "minhook/include/MinHook.h"
#include "scan.h"
typedef struct { DWORD magic,version; WCHAR name[65]; } Request;
static volatile LONG initialized, active;
static USHORT selectedPort;
static SOCKET listener=INVALID_SOCKET, clients[64];
static SRWLOCK socketLock=SRWLOCK_INIT;
static SRWLOCK leaseLock=SRWLOCK_INIT;
static DWORD clientLease[64], leaseId;
static ULONGLONG leaseDeadline;
static BYTE *flagAddress, oldFlag;
static HANDLE doneEvent;
static int (WSAAPI *realBind)(SOCKET,const struct sockaddr*,int);
static SOCKET (WSAAPI *realAccept)(SOCKET,struct sockaddr*,int*);
static int (WSAAPI *realRecv)(SOCKET,char*,int,int);
static int (WSAAPI *realClose)(SOCKET);
static BOOL copyAt(const void *address,void *target,SIZE_T size){SIZE_T got=0;return ReadProcessMemory(GetCurrentProcess(),address,target,size,&got)&&got==size;}
static BOOL httpCaller(void *address){
 HMODULE h=GetModuleHandleW(L"HttpServer.WindowsDesktop.dll");if(!h)return FALSE;
 IMAGE_DOS_HEADER dos;IMAGE_NT_HEADERS64 nt;
 if(!copyAt(h,&dos,sizeof(dos))||dos.e_magic!=IMAGE_DOS_SIGNATURE||dos.e_lfanew<0||dos.e_lfanew>1048576)return FALSE;
 if(!copyAt((BYTE*)h+dos.e_lfanew,&nt,sizeof(nt))||nt.Signature!=IMAGE_NT_SIGNATURE)return FALSE;
 return (BYTE*)address>=(BYTE*)h&&(uintptr_t)address-(uintptr_t)h<nt.OptionalHeader.SizeOfImage;
}
static int WSAAPI localBind(SOCKET s,const struct sockaddr *address,int length){
 if(!httpCaller(__builtin_return_address(0)))return realBind(s,address,length);
 if(!active){WSASetLastError(WSAEACCES);return SOCKET_ERROR;}
 int result=SOCKET_ERROR;
 if(address&&length>=sizeof(struct sockaddr_in)&&address->sa_family==AF_INET){
  struct sockaddr_in a=*(const struct sockaddr_in*)address;a.sin_port=htons(selectedPort);a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  result=realBind(s,(struct sockaddr*)&a,sizeof(a));
 }else if(address&&length>=sizeof(struct sockaddr_in6)&&address->sa_family==AF_INET6){
  struct sockaddr_in6 a=*(const struct sockaddr_in6*)address;memset(&a.sin6_addr,0,sizeof(a.sin6_addr));a.sin6_addr.u.Byte[15]=1;a.sin6_port=htons(selectedPort);
  result=realBind(s,(struct sockaddr*)&a,sizeof(a));
 }else{WSASetLastError(WSAEAFNOSUPPORT);return SOCKET_ERROR;}
 if(result==0){AcquireSRWLockExclusive(&socketLock);listener=s;ReleaseSRWLockExclusive(&socketLock);}return result;
}
static SOCKET WSAAPI localAccept(SOCKET s,struct sockaddr *address,int *length){
 SOCKET c=realAccept(s,address,length);if(c==INVALID_SOCKET)return c;
 AcquireSRWLockExclusive(&socketLock);BOOL owned=s==listener,keep=!owned; if(owned&&active)for(int i=0;i<64;i++)if(clients[i]==INVALID_SOCKET){clients[i]=c;clientLease[i]=leaseId;keep=TRUE;break;}
 ReleaseSRWLockExclusive(&socketLock);
 if(!keep){realClose(c);WSASetLastError(WSAECONNRESET);return INVALID_SOCKET;}return c;
}
static int WSAAPI localRecv(SOCKET s,char *buffer,int length,int flags){
 BOOL denied=FALSE;AcquireSRWLockShared(&socketLock);for(int i=0;i<64;i++)if(clients[i]==s){denied=!active||clientLease[i]!=leaseId;break;}ReleaseSRWLockShared(&socketLock);
 return denied?0:realRecv(s,buffer,length,flags);
}
static int WSAAPI localClose(SOCKET s){AcquireSRWLockExclusive(&socketLock);if(listener==s)listener=INVALID_SOCKET;for(int i=0;i<64;i++)if(clients[i]==s)clients[i]=INVALID_SOCKET;ReleaseSRWLockExclusive(&socketLock);return realClose(s);}
static void sealLocked(void){
 InterlockedExchange(&active,0);
 leaseDeadline=0;
 BYTE *address=InterlockedExchangePointer((void*volatile*)&flagAddress,NULL);
 if(address){BYTE current;SIZE_T written;if(copyAt(address,&current,1)&&current==1)WriteProcessMemory(GetCurrentProcess(),address,&oldFlag,1,&written);}
}
static void seal(void){AcquireSRWLockExclusive(&leaseLock);sealLocked();ReleaseSRWLockExclusive(&leaseLock);}
static DWORD WINAPI watchdog(void *unused){for(;;){WaitForSingleObject(doneEvent,1000);AcquireSRWLockExclusive(&leaseLock);if(active&&GetTickCount64()>=leaseDeadline)sealLocked();ReleaseSRWLockExclusive(&leaseLock);}return 0;}
static DWORD relative(DWORD at,DWORD instructionLength,const BYTE *bytes,int displacementOffset){LONG d;memcpy(&d,bytes+displacementOffset,4);int64_t n=(int64_t)at+instructionLength+d;return n>0&&n<imageSize?(DWORD)n:0;}
// Resolve the registered Python setter -> its service accessor. Addresses are
// derived from the loaded engine, never compiled-in RVAs.
static DWORD discover(DWORD *service){
 const BYTE key[]="\0set_enable_feature_option";DWORD strings[4],refs[8];
 int n=findBytes(key,sizeof(key),IMAGE_SCN_CNT_INITIALIZED_DATA,strings,4,FALSE,0);if(n!=1)return 21;
 n=findBytes(NULL,7,IMAGE_SCN_CNT_CODE,refs,8,TRUE,strings[0]+1);if(n!=1||refs[0]<10)return 22;
 BYTE registration[17];if(!readAt(refs[0]-10,registration,17)||registration[0]!=0x4c||registration[1]!=0x8d||registration[2]!=5)return 22;
 DWORD wrapper=relative(refs[0]-10,7,registration,3);if(!executable(wrapper))return 23;
 BYTE code[256];if(!readAt(wrapper,code,sizeof(code)))return 23;
 const BYTE unpack[]={0x48,0x8b,0x54,0x24,0x20,0x8b,0x4c,0x24,0x28,0xe8};DWORD body=0;
 for(int i=0;i<240;i++)if(equal(code+i,unpack,sizeof(unpack))){if(body)return 24;body=relative(wrapper+i+9,5,code+i+9,1);}
 if(!body||!executable(body))return 24;BYTE target[512];if(!readAt(body,target,sizeof(target)))return 24;
 const BYTE access[]={0x48,0x8d,0x4c,0x24,0x50,0xe8};const BYTE after[]={0x48,0x8b,0x48,0x10,0x48,0x85,0xc9};DWORD fn=0;
 for(int i=0;i<490;i++)if(equal(target+i,access,sizeof(access))&&equal(target+i+10,after,sizeof(after))){if(fn)return 25;fn=relative(body+i+5,5,target+i+5,1);}
 if(!fn||!executable(fn))return 25;*service=fn;return 0;
}
static DWORD enableFlag(DWORD service){
 BYTE code[512];if(!readAt(service,code,sizeof(code)))return 26;
 BYTE *candidate=NULL;DWORD stage=0;
 for(int i=0;i<480;i++){
  const BYTE load[]={0x48,0x8b,0x05};const BYTE test[]={0x48,0x85,0xc0};
  if(!equal(code+i,load,3)||!equal(code+i+7,test,3))continue;
  if(stage<1)stage=1;
  DWORD slot=relative(service+i,7,code+i,3);if(!slot)continue;
  uintptr_t control,features,start,end;if(!readAt(slot,&control,8)||!control)continue;
  BYTE valid;if(!copyAt((void*)control,&valid,1)||valid!=1||!readAt(slot+16,&features,8)||!features)continue;
  if(stage<2)stage=2;
  if(!copyAt((void*)(features+0x18),&start,8)||!copyAt((void*)(features+0x20),&end,8)||end<start||(end-start)%0x98||(end-start)/0x98>100)continue;
  if(stage<3)stage=3;
  for(uintptr_t a=start;a<end;a+=0x98){DWORD id;uintptr_t option,owner,vtable,override;BYTE value;
   if(!copyAt((void*)a,&id,4)||id!=5||!copyAt((void*)(a+8),&option,8)||!option)continue;
   if(!copyAt((void*)option,&vtable,8)||vtable<(uintptr_t)imageBase||vtable>=(uintptr_t)imageBase+imageSize||executable((DWORD)(vtable-(uintptr_t)imageBase)))return 27;
   if(!copyAt((void*)(option+0x10),&owner,8)||!owner||!copyAt((void*)(owner+0x1b8),&override,8)||override)return 27;
   if(!copyAt((void*)(option+0x18),&value,1)||value>1)return 27;
   if(candidate&&candidate!=(BYTE*)(option+0x18))return 27;candidate=(BYTE*)(option+0x18);oldFlag=value;
  }
 }
 if(!candidate)return 30+stage;
 // Restore independently when the request ends or its host disappears.
 flagAddress=candidate;BYTE one=1;SIZE_T written;if(!WriteProcessMemory(GetCurrentProcess(),candidate,&one,1,&written)||written!=1){flagAddress=NULL;return 29;}return 0;
}
__declspec(dllexport) DWORD WINAPI DgnInitialize(Request *request){
 if(!request||request->magic!=0x44474e4e||request->version!=1||request->name[64]!=0)return 1;
 if(request->name[0]=='s'&&request->name[1]=='e'&&request->name[2]=='a'&&request->name[3]=='l'&&request->name[4]==0){if(initialized!=2)return 2;seal();SetEvent(doneEvent);return 0;}
 BOOL resume=request->name[0]=='r'&&request->name[1]=='e'&&request->name[2]=='s'&&request->name[3]=='u'&&request->name[4]=='m'&&request->name[5]=='e'&&request->name[6]==':';int start=resume?7:0;
 DWORD port=0;for(int i=start;request->name[i];i++){if(i-start>=5||request->name[i]<'0'||request->name[i]>'9')return 3;port=port*10+request->name[i]-'0';}if(port<1024||port>65535)return 3;
 if(resume){
  AcquireSRWLockExclusive(&leaseLock);
  if(initialized!=2||active||port!=selectedPort){ReleaseSRWLockExclusive(&leaseLock);return 2;}
  DWORD service=0,result=loadImage()?discover(&service):20;
  if(!result){AcquireSRWLockExclusive(&socketLock);leaseId++;ReleaseSRWLockExclusive(&socketLock);leaseDeadline=GetTickCount64()+180000;InterlockedExchange(&active,1);result=enableFlag(service);}
  if(result)sealLocked();ReleaseSRWLockExclusive(&leaseLock);SetEvent(doneEvent);return result;
 }
 if(InterlockedCompareExchange(&initialized,1,0)!=0)return 2;selectedPort=(USHORT)port;
 for(int i=0;i<64;i++)clients[i]=INVALID_SOCKET;
 HMODULE ws=LoadLibraryW(L"ws2_32.dll");if(!ws||MH_Initialize()!=MH_OK)return 10;
 const char *names[]={"bind","accept","recv","closesocket"};void *hooks[]={localBind,localAccept,localRecv,localClose};void **originals[]={(void**)&realBind,(void**)&realAccept,(void**)&realRecv,(void**)&realClose};
 for(int i=0;i<4;i++){void *fn=(void*)GetProcAddress(ws,names[i]);if(!fn||MH_CreateHook(fn,hooks[i],originals[i])!=MH_OK)return 11;}
 leaseId=1;leaseDeadline=GetTickCount64()+180000;InterlockedExchange(&active,1);if(MH_EnableHook(MH_ALL_HOOKS)!=MH_OK){active=0;return 12;}
 DWORD result=20,service=0;ULONGLONG end=GetTickCount64()+25000;
 do{if(!service&&loadImage())result=discover(&service);if(service)result=enableFlag(service);if(!result)break;Sleep(25);}while(GetTickCount64()<end);
 if(result){seal();return result;}
 doneEvent=CreateEventW(NULL,FALSE,FALSE,NULL);if(!doneEvent){seal();return 13;}
 HANDLE thread=CreateThread(NULL,0,watchdog,NULL,0,NULL);if(!thread){seal();return 14;}CloseHandle(thread);
 InterlockedExchange(&initialized,2);return 0;
}
BOOL WINAPI DllMainCRTStartup(HINSTANCE module,DWORD reason,LPVOID reserved){return TRUE;}
