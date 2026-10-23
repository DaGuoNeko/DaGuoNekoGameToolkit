// Per-process development-game storage isolation. No registry or game files are patched.
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define INITGUID
#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <knownfolders.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <stdint.h>
#include <stddef.h>
#include "MinHook.h"
typedef struct { HANDLE process, thread, job, gate; DWORD pid, error; } DgnProcess;
_Static_assert(sizeof(DgnProcess)==40,"Unexpected x64 process ABI");
__declspec(dllexport) DWORD WINAPI DgnIsolationVersion(void){return 1;}
static HMODULE selfModule;
static WCHAR roaming[32768], localData[32768], lowData[32768], gameExe[32768], launcherExe[32768], dllPath[32768];
static LONG initialized;
static HRESULT (WINAPI *realKnown)(REFKNOWNFOLDERID,DWORD,HANDLE,PWSTR*);
static HRESULT (WINAPI *realFolderW)(HWND,int,HANDLE,DWORD,LPWSTR);
static HRESULT (WINAPI *realFolderA)(HWND,int,HANDLE,DWORD,LPSTR);
static BOOL (WINAPI *realSpecialW)(HWND,LPWSTR,int,BOOL);
static BOOL (WINAPI *realSpecialA)(HWND,LPSTR,int,BOOL);
static BOOL (WINAPI *realCreate)(LPCWSTR,LPWSTR,LPSECURITY_ATTRIBUTES,LPSECURITY_ATTRIBUTES,BOOL,DWORD,LPVOID,LPCWSTR,LPSTARTUPINFOW,LPPROCESS_INFORMATION);
static DWORD (WINAPI *realResume)(HANDLE);
static HANDLE waitingThread, waitingGate;
extern BYTE DgnBootstrap[],DgnBootstrapEnd[];
static BOOL same(const WCHAR *a,const WCHAR *b){return CompareStringOrdinal(a,-1,b,-1,TRUE)==CSTR_EQUAL;}
static BOOL variable(const WCHAR *name,WCHAR *value){DWORD n=GetEnvironmentVariableW(name,value,32768);return n>3&&n<32768&&value[1]==L':'&&value[2]==L'\\';}
static const WCHAR *folder(int id){id&=0xfff;return id==CSIDL_APPDATA?roaming:id==CSIDL_LOCAL_APPDATA?localData:NULL;}
static HRESULT WINAPI known(REFKNOWNFOLDERID id,DWORD flags,HANDLE token,PWSTR *out){
 const WCHAR *value=NULL;
 if(IsEqualGUID(id,&FOLDERID_RoamingAppData))value=roaming;
 else if(IsEqualGUID(id,&FOLDERID_LocalAppData))value=localData;
 else if(IsEqualGUID(id,&FOLDERID_LocalAppDataLow))value=lowData;
 if(!value)return realKnown(id,flags,token,out);
 if(!out)return E_INVALIDARG;
 SIZE_T bytes=(lstrlenW(value)+1)*sizeof(WCHAR);*out=CoTaskMemAlloc(bytes);
 if(!*out)return E_OUTOFMEMORY;CopyMemory(*out,value,bytes);return S_OK;
}
static HRESULT WINAPI folderW(HWND w,int id,HANDLE token,DWORD type,LPWSTR out){
 const WCHAR *value=folder(id);if(!value)return realFolderW(w,id,token,type,out);
 if(!out||lstrlenW(value)>=MAX_PATH)return E_INVALIDARG;lstrcpyW(out,value);return S_OK;
}
static HRESULT WINAPI folderA(HWND w,int id,HANDLE token,DWORD type,LPSTR out){
 const WCHAR *value=folder(id);if(!value)return realFolderA(w,id,token,type,out);
 if(!out||!WideCharToMultiByte(CP_ACP,0,value,-1,out,MAX_PATH,NULL,NULL))return E_INVALIDARG;return S_OK;
}
static BOOL WINAPI specialW(HWND w,LPWSTR out,int id,BOOL create){return folder(id)?SUCCEEDED(folderW(w,id,NULL,0,out)):realSpecialW(w,out,id,create);}
static BOOL WINAPI specialA(HWND w,LPSTR out,int id,BOOL create){return folder(id)?SUCCEEDED(folderA(w,id,NULL,0,out)):realSpecialA(w,out,id,create);}
static uintptr_t mappedModule(HANDLE process,const WCHAR *name){
 MEMORY_BASIC_INFORMATION info;uintptr_t cursor=0;WCHAR mapped[1024];
 while(VirtualQueryEx(process,(void*)cursor,&info,sizeof(info))==sizeof(info)){
  if(info.Type==MEM_IMAGE&&info.BaseAddress==info.AllocationBase&&GetMappedFileNameW(process,info.AllocationBase,mapped,1024)){
   const WCHAR *base=mapped;for(const WCHAR *p=mapped;*p;p++)if(*p==L'\\')base=p+1;
   if(same(base,name))return (uintptr_t)info.AllocationBase;
  }
  uintptr_t next=(uintptr_t)info.BaseAddress+info.RegionSize;if(next<=cursor)break;cursor=next;
 }
 return 0;
}
__declspec(dllexport) DWORD WINAPI DgnIsolateInit(void *unused);
typedef struct { uintptr_t load,wait,exitProcess,entry,arg,gate,init; USHORT len,max; DWORD padding; uintptr_t name,module; volatile LONG status; DWORD tail; } Boot;
_Static_assert(sizeof(Boot)==88&&offsetof(Boot,status)==80,"Unexpected bootstrap ABI");
static HANDLE prepareStartup(HANDLE process,HANDLE thread){
 CONTEXT context;ZeroMemory(&context,sizeof(context));context.ContextFlags=CONTEXT_INTEGER;
 if(!GetThreadContext(thread,&context))return NULL;
 HMODULE local=GetModuleHandleW(L"ntdll.dll");uintptr_t remote=mappedModule(process,L"ntdll.dll");
 if(!remote)return NULL;
 HANDLE gate=CreateEventW(NULL,TRUE,FALSE,NULL),remoteGate=NULL;
 if(!gate||!DuplicateHandle(GetCurrentProcess(),gate,process,&remoteGate,SYNCHRONIZE,FALSE,0)){if(gate)CloseHandle(gate);return NULL;}
 SIZE_T bytes=(lstrlenW(dllPath)+1)*sizeof(WCHAR),written=0,codeSize=(SIZE_T)(DgnBootstrapEnd-DgnBootstrap);
 void *data=VirtualAllocEx(process,NULL,sizeof(Boot)+bytes,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
 void *code=VirtualAllocEx(process,NULL,codeSize,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
 if(!data||!code){CloseHandle(gate);return NULL;}
 Boot boot;ZeroMemory(&boot,sizeof(boot));
 boot.load=remote+(uintptr_t)GetProcAddress(local,"LdrLoadDll")-(uintptr_t)local;
 boot.wait=remote+(uintptr_t)GetProcAddress(local,"NtWaitForSingleObject")-(uintptr_t)local;
 boot.exitProcess=remote+(uintptr_t)GetProcAddress(local,"RtlExitUserProcess")-(uintptr_t)local;
 boot.entry=context.Rcx;boot.arg=context.Rdx;boot.gate=(uintptr_t)remoteGate;
 boot.init=(uintptr_t)GetProcAddress(selfModule,"DgnIsolateInit")-(uintptr_t)selfModule;
 boot.len=(USHORT)(bytes-2);boot.max=(USHORT)bytes;boot.name=(uintptr_t)data+sizeof(Boot);
 DWORD old;
 BOOL ok=WriteProcessMemory(process,data,&boot,sizeof(boot),&written)&&written==sizeof(boot)&&
  WriteProcessMemory(process,(BYTE*)data+sizeof(Boot),dllPath,bytes,&written)&&written==bytes&&
  WriteProcessMemory(process,code,DgnBootstrap,codeSize,&written)&&written==codeSize&&
  VirtualProtectEx(process,code,codeSize,PAGE_EXECUTE_READ,&old)&&FlushInstructionCache(process,code,codeSize);
 context.Rcx=(DWORD64)code;context.Rdx=(DWORD64)data;
 if(ok)ok=SetThreadContext(thread,&context)&&(realResume?realResume(thread):ResumeThread(thread))!=(DWORD)-1;
 ULONGLONG deadline=GetTickCount64()+15000;
 while(ok&&GetTickCount64()<deadline){
  LONG status=0;SIZE_T got=0;
  if(!ReadProcessMemory(process,(BYTE*)data+80,&status,sizeof(status),&got)||WaitForSingleObject(process,0)==WAIT_OBJECT_0)break;
  if(status==1)return gate;
  if(status){SetLastError(0xD700+(DWORD)status);break;}
  Sleep(10);
 }
 CloseHandle(gate);return NULL;
}
static DWORD WINAPI resumeGame(HANDLE thread){
 if(thread==waitingThread&&waitingGate){HANDLE gate=waitingGate;waitingGate=NULL;waitingThread=NULL;BOOL ok=SetEvent(gate);CloseHandle(gate);return ok?1:(DWORD)-1;}
 return realResume(thread);
}
static BOOL WINAPI createGame(LPCWSTR app,LPWSTR cmd,LPSECURITY_ATTRIBUTES pa,LPSECURITY_ATTRIBUTES ta,BOOL inherit,DWORD flags,LPVOID env,LPCWSTR cwd,LPSTARTUPINFOW si,LPPROCESS_INFORMATION pi){
 int argc=0;WCHAR **argv=NULL;const WCHAR *exe=app;
 if(!exe&&cmd){argv=CommandLineToArgvW(cmd,&argc);if(argv&&argc)exe=argv[0];}
 BOOL target=exe&&same(exe,gameExe);if(argv)LocalFree(argv);
 if(!target)return realCreate(app,cmd,pa,ta,inherit,flags,env,cwd,si,pi);
 if(!realCreate(app,cmd,pa,ta,inherit,flags|CREATE_SUSPENDED,env,cwd,si,pi))return FALSE;
 HANDLE gate=prepareStartup(pi->hProcess,pi->hThread);BOOL ok=gate!=NULL;
 if(ok){if(flags&CREATE_SUSPENDED){waitingThread=pi->hThread;waitingGate=gate;}else{ok=SetEvent(gate);CloseHandle(gate);}}
 if(!ok){TerminateProcess(pi->hProcess,0xD601);WaitForSingleObject(pi->hProcess,5000);CloseHandle(pi->hThread);CloseHandle(pi->hProcess);ZeroMemory(pi,sizeof(*pi));SetLastError(ERROR_DLL_INIT_FAILED);return FALSE;}
 return TRUE;
}
static BOOL hook(const WCHAR *module,const char *name,void *target,void **original){return MH_CreateHookApi(module,name,target,original)==MH_OK;}
__declspec(dllexport) DWORD WINAPI DgnIsolateInit(void *unused){
 if(InterlockedCompareExchange(&initialized,1,0))return 100;
 if(!variable(L"DGN_ISO_ROAMING",roaming)||!variable(L"DGN_ISO_LOCAL",localData)||!variable(L"DGN_ISO_LOW",lowData)||!variable(L"DGN_ISO_GAME",gameExe)||!variable(L"DGN_ISO_MCDK",launcherExe)||!variable(L"DGN_ISO_DLL",dllPath))return 101;
 WCHAR actual[32768];DWORD length=32768;if(!QueryFullProcessImageNameW(GetCurrentProcess(),0,actual,&length))return 102;
 if(MH_Initialize()!=MH_OK)return 103;
 BOOL ok=FALSE;
 if(same(actual,launcherExe))ok=hook(L"kernel32.dll","CreateProcessW",createGame,(void**)&realCreate)&&hook(L"kernel32.dll","ResumeThread",resumeGame,(void**)&realResume);
 else if(same(actual,gameExe)){
  if(!LoadLibraryW(L"shell32.dll"))return 104;
  ok=hook(L"shell32.dll","SHGetKnownFolderPath",known,(void**)&realKnown)&&
     hook(L"shell32.dll","SHGetFolderPathW",folderW,(void**)&realFolderW)&&hook(L"shell32.dll","SHGetFolderPathA",folderA,(void**)&realFolderA)&&
     hook(L"shell32.dll","SHGetSpecialFolderPathW",specialW,(void**)&realSpecialW)&&hook(L"shell32.dll","SHGetSpecialFolderPathA",specialA,(void**)&realSpecialA);
 }
 if(!ok)return 105;return MH_EnableHook(MH_ALL_HOOKS)==MH_OK?0:106;
}
__declspec(dllexport) BOOL WINAPI DgnSpawn(LPCWSTR exe,LPCWSTR cwd,void *env,LPCWSTR outName,LPCWSTR errName,DgnProcess *out){
 ZeroMemory(out,sizeof(*out));
 // This entry is used by the toolbox worker only. Remote processes call Init.
 if(!GetModuleFileNameW(selfModule,dllPath,32768)){out->error=GetLastError();return FALSE;}
 SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE};
 HANDLE handles[3]={CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,0,NULL),
 CreateFileW(outName,GENERIC_WRITE,0,&sa,OPEN_EXISTING,0,NULL),CreateFileW(errName,GENERIC_WRITE,0,&sa,OPEN_EXISTING,0,NULL)};
 STARTUPINFOEXW si;ZeroMemory(&si,sizeof(si));si.StartupInfo.cb=sizeof(si);si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
 si.StartupInfo.hStdInput=handles[0];si.StartupInfo.hStdOutput=handles[1];si.StartupInfo.hStdError=handles[2];
 SIZE_T size=0;InitializeProcThreadAttributeList(NULL,2,0,&size);si.lpAttributeList=HeapAlloc(GetProcessHeap(),0,size);
 BOOL initializedList=FALSE,ok=FALSE;PROCESS_INFORMATION pi;ZeroMemory(&pi,sizeof(pi));HANDLE job=NULL;
 if(handles[0]==INVALID_HANDLE_VALUE||handles[1]==INVALID_HANDLE_VALUE||handles[2]==INVALID_HANDLE_VALUE||!si.lpAttributeList)goto finish;
 if(!(initializedList=InitializeProcThreadAttributeList(si.lpAttributeList,2,0,&size))||!UpdateProcThreadAttribute(si.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),NULL,NULL))goto finish;
 job=CreateJobObjectW(NULL,NULL);if(!job)goto finish;
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;ZeroMemory(&limits,sizeof(limits));limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
 if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))goto finish;
 if(!UpdateProcThreadAttribute(si.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job,sizeof(job),NULL,NULL))goto finish;
 WCHAR command[32768];if(lstrlenW(exe)>32760){SetLastError(ERROR_FILENAME_EXCED_RANGE);goto finish;}
 command[0]=L'"';lstrcpyW(command+1,exe);lstrcatW(command,L"\"");
 if(!CreateProcessW(exe,command,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,env,cwd,&si.StartupInfo,&pi))goto finish;
 out->gate=prepareStartup(pi.hProcess,pi.hThread);if(!out->gate)goto finish;
 out->process=pi.hProcess;out->thread=pi.hThread;out->job=job;out->pid=pi.dwProcessId;ok=TRUE;
 finish:
 if(!ok){out->error=GetLastError();if(pi.hProcess){TerminateProcess(pi.hProcess,0xD602);WaitForSingleObject(pi.hProcess,5000);CloseHandle(pi.hProcess);}if(pi.hThread)CloseHandle(pi.hThread);if(job)CloseHandle(job);}
 if(initializedList)DeleteProcThreadAttributeList(si.lpAttributeList);if(si.lpAttributeList)HeapFree(GetProcessHeap(),0,si.lpAttributeList);
 for(int i=0;i<3;i++)if(handles[i]!=INVALID_HANDLE_VALUE)CloseHandle(handles[i]);return ok;
}
__declspec(dllexport) BOOL WINAPI DgnResume(DgnProcess *p){return SetEvent(p->gate);}
__declspec(dllexport) BOOL WINAPI DgnPoll(DgnProcess *p,DWORD *code){if(WaitForSingleObject(p->process,0)!=WAIT_OBJECT_0)return FALSE;return GetExitCodeProcess(p->process,code);}
__declspec(dllexport) BOOL WINAPI DgnStop(DgnProcess *p){return TerminateJobObject(p->job,1);}
__declspec(dllexport) HANDLE WINAPI DgnAcquire(LPCWSTR name){
 HANDLE mutex=CreateMutexW(NULL,FALSE,name);if(!mutex)return NULL;
 DWORD status=WaitForSingleObject(mutex,0);
 if(status==WAIT_OBJECT_0)return mutex;
 if(status==WAIT_ABANDONED)ReleaseMutex(mutex);
 CloseHandle(mutex);SetLastError(ERROR_BUSY);return NULL;
}
__declspec(dllexport) void WINAPI DgnRelease(HANDLE mutex){if(mutex){ReleaseMutex(mutex);CloseHandle(mutex);}}
__declspec(dllexport) BOOL WINAPI DgnWorldFree(LPCWSTR file){
 HANDLE h=CreateFileW(file,GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,NULL);
 if(h==INVALID_HANDLE_VALUE){DWORD error=GetLastError();return error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND;}
 BY_HANDLE_FILE_INFORMATION info;OVERLAPPED ov;ZeroMemory(&ov,sizeof(ov));
 BOOL ok=GetFileInformationByHandle(h,&info)&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&LockFileEx(h,LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,1,0,&ov);
 if(ok)UnlockFileEx(h,0,1,0,&ov);CloseHandle(h);return ok;
}
__declspec(dllexport) void WINAPI DgnClose(DgnProcess *p){
 if(p->job){
  TerminateJobObject(p->job,1);
  ULONGLONG until=GetTickCount64()+5000;JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
  while(GetTickCount64()<until&&QueryInformationJobObject(p->job,JobObjectBasicAccountingInformation,&info,sizeof(info),NULL)&&info.ActiveProcesses)Sleep(10);
  CloseHandle(p->job);
 }
 if(p->gate)CloseHandle(p->gate);if(p->thread)CloseHandle(p->thread);if(p->process)CloseHandle(p->process);ZeroMemory(p,sizeof(*p));
}
BOOL WINAPI DllMainCRTStartup(HINSTANCE instance,DWORD reason,LPVOID reserved){if(reason==DLL_PROCESS_ATTACH){selfModule=instance;DisableThreadLibraryCalls(instance);}return TRUE;}
