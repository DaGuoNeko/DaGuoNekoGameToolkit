#define UNICODE
#define _UNICODE
#define INITGUID
#include <windows.h>
#include <shlobj.h>
#include <knownfolders.h>
static void line(const WCHAR *value){char b[4096];int n=WideCharToMultiByte(CP_UTF8,0,value,-1,b,4095,NULL,NULL);DWORD written;if(n>0){b[n-1]='\n';WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),b,n,&written,NULL);}}
void mainCRTStartup(void){
 WCHAR self[1024],launcher[1024],game[1024],expected[1024],legacy[MAX_PATH];
 GetModuleFileNameW(NULL,self,1024);GetEnvironmentVariableW(L"DGN_ISO_MCDK",launcher,1024);GetEnvironmentVariableW(L"DGN_ISO_GAME",game,1024);
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
