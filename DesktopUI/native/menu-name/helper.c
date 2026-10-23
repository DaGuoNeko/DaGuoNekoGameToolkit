// Only attaches to the expected child of the launcher supplied by the host.
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <tlhelp32.h>
#include <shellapi.h>
#include <stdint.h>
typedef struct { DWORD magic,version; WCHAR name[65]; } Request;
static DWORD parseId(const WCHAR *s){uint64_t n=0;if(!*s)return 0;while(*s){if(*s<L'0'||*s>L'9')return 0;n=n*10+*s++-L'0';if(n>0xffffffff)return 0;}return (DWORD)n;}
static const WCHAR *baseName(const WCHAR *s){const WCHAR *last=s;while(*s){if(*s==L'\\'||*s==L'/')last=s+1;s++;}return last;}
static BOOL same(const WCHAR *a,const WCHAR *b){return CompareStringOrdinal(a,-1,b,-1,TRUE)==CSTR_EQUAL;}
static SIZE_T length(const WCHAR *s){SIZE_T n=0;while(s[n])n++;return n;}
static int decimal(char *out,DWORD n){char digits[12];int count=0;do{digits[count++]=(char)('0'+n%10);n/=10;}while(n);for(int i=0;i<count;i++)out[i]=digits[count-1-i];return count;}
static void finish(DWORD code,DWORD nativeError){char output[100];const char *prefix="{\"code\":";int n=0;while(*prefix)output[n++]=*prefix++;n+=decimal(output+n,code);prefix=",\"win32\":";while(*prefix)output[n++]=*prefix++;n+=decimal(output+n,nativeError);output[n++]='}';output[n++]='\n';DWORD written;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output,n,&written,NULL);ExitProcess(code);}
static uintptr_t moduleBase(DWORD pid,const WCHAR *name){
    HANDLE snapshot=INVALID_HANDLE_VALUE;
    for(int i=0;i<100;i++){snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPMODULE|TH32CS_SNAPMODULE32,pid);if(snapshot!=INVALID_HANDLE_VALUE||GetLastError()!=ERROR_BAD_LENGTH)break;Sleep(20);}
    if(snapshot==INVALID_HANDLE_VALUE)return 0;
    MODULEENTRY32W entry;entry.dwSize=sizeof(entry);uintptr_t result=0;
    if(Module32FirstW(snapshot,&entry))do{if(same(entry.szModule,name)){result=(uintptr_t)entry.modBaseAddr;break;}}while(Module32NextW(snapshot,&entry));
    CloseHandle(snapshot);return result;
}
static BOOL owned(DWORD pid,DWORD parent){
    HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);if(snapshot==INVALID_HANDLE_VALUE)return FALSE;
    PROCESSENTRY32W entry;entry.dwSize=sizeof(entry);BOOL result=FALSE;
    if(Process32FirstW(snapshot,&entry))do{if(entry.th32ProcessID==pid){result=entry.th32ParentProcessID==parent;break;}}while(Process32NextW(snapshot,&entry));
    CloseHandle(snapshot);return result;
}
void mainCRTStartup(void){
    int argc;WCHAR **argv=CommandLineToArgvW(GetCommandLineW(),&argc);
    if(!argv||argc!=6)finish(1,0);
    DWORD pid=parseId(argv[1]),parent=parseId(argv[2]);
    if(!pid||!parent||pid==parent||!owned(pid,parent))finish(2,0);
    SIZE_T nameLength=length(argv[5]);if(!nameLength||nameLength>64)finish(1,0);
    for(SIZE_T i=0;i<nameLength;i++)if(argv[5][i]<32||argv[5][i]==127)finish(1,0);
    HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_CREATE_THREAD|PROCESS_VM_OPERATION|PROCESS_VM_WRITE|PROCESS_VM_READ|SYNCHRONIZE,FALSE,pid);
    HANDLE parentHandle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,parent);
    if(!process||!parentHandle)finish(3,GetLastError());
    FILETIME pc,pe,pk,pu,gc,ge,gk,gu;
    if(!GetProcessTimes(process,&gc,&ge,&gk,&gu)||!GetProcessTimes(parentHandle,&pc,&pe,&pk,&pu)||CompareFileTime(&gc,&pc)<0)finish(2,0);
    CloseHandle(parentHandle);
    WCHAR *actual=(WCHAR*)HeapAlloc(GetProcessHeap(),0,32768*sizeof(WCHAR));DWORD size=32768;
    if(!actual||!QueryFullProcessImageNameW(process,0,actual,&size)||!same(actual,argv[3]))finish(4,GetLastError());
    HeapFree(GetProcessHeap(),0,actual);
    BOOL wow64=TRUE;if(!IsWow64Process(process,&wow64)||wow64)finish(5,GetLastError());
    SIZE_T bytes=(length(argv[4])+1)*sizeof(WCHAR),written;
    void *remote=VirtualAllocEx(process,NULL,bytes,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
    if(!remote||!WriteProcessMemory(process,remote,argv[4],bytes,&written)||written!=bytes)finish(6,GetLastError());
    FARPROC localLoader=GetProcAddress(GetModuleHandleW(L"kernel32.dll"),"LoadLibraryW");HMODULE loaderModule=NULL;
    if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,(LPCWSTR)localLoader,&loaderModule))finish(7,GetLastError());
    WCHAR loaderPath[MAX_PATH];if(!GetModuleFileNameW(loaderModule,loaderPath,MAX_PATH))finish(7,GetLastError());
    uintptr_t remoteLoader=moduleBase(pid,baseName(loaderPath));if(!remoteLoader)finish(7,GetLastError());
    remoteLoader+=(uintptr_t)localLoader-(uintptr_t)loaderModule;
    HANDLE thread=CreateRemoteThread(process,NULL,0,(LPTHREAD_START_ROUTINE)remoteLoader,remote,0,NULL);
    if(!thread||WaitForSingleObject(thread,15000)!=WAIT_OBJECT_0)finish(8,GetLastError());
    CloseHandle(thread);VirtualFreeEx(process,remote,0,MEM_RELEASE);
    uintptr_t module=moduleBase(pid,baseName(argv[4]));if(!module)finish(9,GetLastError());
    HMODULE local=LoadLibraryExW(argv[4],NULL,DONT_RESOLVE_DLL_REFERENCES);if(!local)finish(10,GetLastError());
    FARPROC initializer=GetProcAddress(local,"DgnInitialize");if(!initializer)finish(10,GetLastError());
    uintptr_t offset=(uintptr_t)initializer-(uintptr_t)local;FreeLibrary(local);
    Request request={.magic=0x44474e4e,.version=1};for(SIZE_T i=0;i<nameLength;i++)request.name[i]=argv[5][i];
    remote=VirtualAllocEx(process,NULL,sizeof(request),MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
    if(!remote||!WriteProcessMemory(process,remote,&request,sizeof(request),&written)||written!=sizeof(request))finish(6,GetLastError());
    thread=CreateRemoteThread(process,NULL,0,(LPTHREAD_START_ROUTINE)(module+offset),remote,0,NULL);DWORD result=0;
    if(!thread||WaitForSingleObject(thread,30000)!=WAIT_OBJECT_0||!GetExitCodeThread(thread,&result))finish(11,GetLastError());
    CloseHandle(thread);VirtualFreeEx(process,remote,0,MEM_RELEASE);CloseHandle(process);LocalFree(argv);
    finish(result?100+result:0,0);
}
