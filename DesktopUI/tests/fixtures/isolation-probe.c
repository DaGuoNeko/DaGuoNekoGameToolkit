#define UNICODE
#define _UNICODE
#define INITGUID
#include <windows.h>
#include <shlobj.h>
#include <knownfolders.h>
static void line(const WCHAR *value){char b[4096];int n=WideCharToMultiByte(CP_UTF8,0,value,-1,b,4095,NULL,NULL);DWORD written;if(n>0){b[n-1]='\n';WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),b,n,&written,NULL);}}
static void probeWrite(const WCHAR *root,const WCHAR *name){
 WCHAR file[4096];lstrcpyW(file,root);lstrcatW(file,L"\\");lstrcatW(file,name);
 HANDLE h=CreateFileW(file,GENERIC_WRITE,FILE_SHARE_READ,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);DWORD written;
 if(h==INVALID_HANDLE_VALUE)ExitProcess(71);
 if(!WriteFile(h,"probe",5,&written,NULL)||written!=5)ExitProcess(72);CloseHandle(h);
}
static void probeWorld(void){
 WCHAR root[2048],source[2048],file[4096],other[4096],packs[2048];
 if(!GetEnvironmentVariableW(L"DGN_PROBE_WORLD",root,2048))return;
 GetEnvironmentVariableW(L"DGN_WORLD_SOURCE",source,2048);
 probeWrite(root,L"world_behavior_packs.json");
 probeWrite(source,L"dev_config.cppconfig");
 probeWrite(root,L"level.dat");probeWrite(root,L"db\\progress");
 probeWrite(root,L"world_resource_packs.json.tmp");
 lstrcpyW(file,root);lstrcatW(file,L"\\world_resource_packs.json.tmp");
 lstrcpyW(other,root);lstrcatW(other,L"\\world_resource_packs.json");
 if(!MoveFileExW(file,other,MOVEFILE_REPLACE_EXISTING))ExitProcess(73);
 lstrcpyW(file,root);lstrcatW(file,L"\\behavior_packs\\sentinel.txt");
 if(GetFileAttributesW(file)!=INVALID_FILE_ATTRIBUTES)ExitProcess(74);
 lstrcpyW(file,root);lstrcatW(file,L"\\behavior_packs\\*");
 WIN32_FIND_DATAW entry;HANDLE search=FindFirstFileW(file,&entry);
 if(search!=INVALID_HANDLE_VALUE){do{if(lstrcmpiW(entry.cFileName,L"sentinel.txt")==0)ExitProcess(75);}while(FindNextFileW(search,&entry));FindClose(search);}
 GetEnvironmentVariableW(L"DGN_PACK_VIEW",packs,2048);
 lstrcpyW(file,packs);lstrcatW(file,L"\\behavior_packs\\0123456789abcdef0123456789abcdef\\manifest.json");
 HANDLE h=CreateFileW(file,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,0,NULL);char b[4];DWORD read;
 if(h==INVALID_HANDLE_VALUE||!ReadFile(h,b,4,&read,NULL)||read!=4||b[0]!='t'||b[3]!='t')ExitProcess(76);CloseHandle(h);
 lstrcpyW(other,source);lstrcatW(other,L"-neighbor");probeWrite(other,L"dev_config.cppconfig");
}
void mainCRTStartup(void){
 WCHAR self[1024],launcher[1024],game[1024],expected[1024],legacy[MAX_PATH];
 GetModuleFileNameW(NULL,self,1024);GetEnvironmentVariableW(L"DGN_ISO_MCDK",launcher,1024);GetEnvironmentVariableW(L"DGN_ISO_GAME",game,1024);
 probeWorld();
 if(CompareStringOrdinal(self,-1,launcher,-1,TRUE)==CSTR_EQUAL){
  STARTUPINFOW si;ZeroMemory(&si,sizeof(si));si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES;si.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);si.hStdError=GetStdHandle(STD_ERROR_HANDLE);si.hStdInput=GetStdHandle(STD_INPUT_HANDLE);
  PROCESS_INFORMATION pi;WCHAR cmd[1028];cmd[0]='"';lstrcpyW(cmd+1,game);lstrcatW(cmd,L"\"");
  if(!CreateProcessW(game,cmd,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi))ExitProcess(GetLastError());
  WaitForSingleObject(pi.hProcess,30000);DWORD code=0;GetExitCodeProcess(pi.hProcess,&code);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);ExitProcess(code);
 }
 PWSTR result=NULL;
 GetEnvironmentVariableW(L"DGN_ISO_ROAMING",expected,1024);
 if(FAILED(SHGetKnownFolderPath(&FOLDERID_RoamingAppData,0,NULL,&result)))ExitProcess(61);
 line(result);if(CompareStringOrdinal(expected,-1,result,-1,TRUE)!=CSTR_EQUAL)ExitProcess(62);CoTaskMemFree(result);
 if(FAILED(SHGetFolderPathW(NULL,CSIDL_APPDATA,NULL,0,legacy))||CompareStringOrdinal(expected,-1,legacy,-1,TRUE)!=CSTR_EQUAL)ExitProcess(63);
 GetEnvironmentVariableW(L"DGN_ISO_LOCAL",expected,1024);
 if(FAILED(SHGetKnownFolderPath(&FOLDERID_LocalAppData,0,NULL,&result)))ExitProcess(64);
 line(result);if(CompareStringOrdinal(expected,-1,result,-1,TRUE)!=CSTR_EQUAL)ExitProcess(65);CoTaskMemFree(result);
 WCHAR lockFile[1024];if(GetEnvironmentVariableW(L"DGN_PROBE_LOCK",lockFile,1024)){HANDLE file=CreateFileW(lockFile,GENERIC_READ|GENERIC_WRITE,0,NULL,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);if(file==INVALID_HANDLE_VALUE)ExitProcess(67);}
 WCHAR pid[20],reverse[16];DWORD n=GetCurrentProcessId();int count=0;do{reverse[count++]=L'0'+n%10;n/=10;}while(n);for(int i=0;i<count;i++)pid[i]=reverse[count-i-1];pid[count]=0;line(pid);
 WCHAR hold[4];if(GetEnvironmentVariableW(L"DGN_PROBE_HOLD",hold,4))Sleep(30000);
 ExitProcess(0);
}
