param([int]$GameProcessId,[int]$LauncherProcessId,[string]$GamePath,[string]$Directory)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
 $gameProcess=Get-CimInstance Win32_Process -Filter "ProcessId = $GameProcessId"
 if($null -eq $gameProcess -or $gameProcess.ParentProcessId -ne $LauncherProcessId -or -not [string]::Equals($gameProcess.ExecutablePath,$GamePath,[StringComparison]::OrdinalIgnoreCase)){throw 'GAME_OWNERSHIP_CHANGED'}
 $started=[Diagnostics.Process]::GetProcessById($GameProcessId).StartTime.ToUniversalTime()
 Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Text;using System.IO;using System.Collections.Generic;using System.Text.RegularExpressions;
public static class DgnContentOwner {
 [DllImport("ntdll.dll")]static extern int NtQuerySystemInformation(int type,IntPtr buffer,int length,out int needed);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")]static extern uint GetFileType(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder name,uint size,uint flags);
 public static string[] Files(int pid,string directory) {
  if(IntPtr.Size!=8)throw new Exception("WINDOWS_X64_REQUIRED");
  var root=Path.GetFullPath(directory).TrimEnd('\\');var found=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  IntPtr process=OpenProcess(0x1040,false,pid);if(process==IntPtr.Zero)throw new Exception("PROCESS_ACCESS_"+Marshal.GetLastWin32Error());
  IntPtr buffer=IntPtr.Zero;
  try {
   int size=1024*1024,needed,result;
   for(;;){buffer=Marshal.AllocHGlobal(size);result=NtQuerySystemInformation(64,buffer,size,out needed);if(result==0)break;Marshal.FreeHGlobal(buffer);buffer=IntPtr.Zero;if(result!=unchecked((int)0xc0000004)||size>=64*1024*1024)throw new Exception("HANDLE_QUERY_"+result);size=Math.Max(size*2,needed+65536);if(size>64*1024*1024)throw new Exception("HANDLE_LIMIT");}
   long count=Marshal.ReadInt64(buffer);if(count<0||count>(size-16)/40)throw new Exception("HANDLE_LAYOUT");
   int inspected=0;
   for(long i=0;i<count;i++){
    IntPtr entry=IntPtr.Add(buffer,checked((int)(16+i*40)));if(Marshal.ReadInt64(entry,8)!=pid)continue;
    if(++inspected>16384)throw new Exception("PROCESS_HANDLE_LIMIT");
    IntPtr copy;if(!DuplicateHandle(process,new IntPtr(Marshal.ReadInt64(entry,16)),GetCurrentProcess(),out copy,0,false,2))continue;
    try {
     if(GetFileType(copy)!=1)continue;
     var name=new StringBuilder(32768);uint length=GetFinalPathNameByHandle(copy,name,32768,0);if(length==0||length>=32768)continue;
     var file=name.ToString();if(file.StartsWith(@"\\?\"))file=file.Substring(4);
     if(!String.Equals(Path.GetDirectoryName(file),root,StringComparison.OrdinalIgnoreCase))continue;
     var leaf=Path.GetFileName(file);if(Regex.IsMatch(leaf,@"^(ContentLog|Debug_Log)\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(_\d+)?\.txt$"))found.Add(leaf);
    }finally{CloseHandle(copy);}
   }
   var output=new string[found.Count];found.CopyTo(output);return output;
  }finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);CloseHandle(process);}
 }
}
'@
 $ownedFiles=@([DgnContentOwner]::Files($GameProcessId,$Directory))
 $current=Get-CimInstance Win32_Process -Filter "ProcessId = $GameProcessId"
 if($null -eq $current -or $current.ParentProcessId -ne $LauncherProcessId -or $current.CreationDate -ne $gameProcess.CreationDate -or -not [string]::Equals($current.ExecutablePath,$GamePath,[StringComparison]::OrdinalIgnoreCase)){throw 'GAME_OWNERSHIP_CHANGED'}
 @{ok=$true;files=$ownedFiles;startedAt=$started.ToString('o')}|ConvertTo-Json -Compress
}catch{@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress;exit 1}
