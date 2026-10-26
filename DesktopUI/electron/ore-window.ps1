param([int]$GameProcessId,[int]$LauncherProcessId,[string]$GamePath,[ValidateSet('status','play','udp')][string]$Mode='status')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
 $p=Get-CimInstance Win32_Process -Filter "ProcessId = $GameProcessId"
 if($null -eq $p -or $p.ParentProcessId -ne $LauncherProcessId -or -not [string]::Equals($p.ExecutablePath,$GamePath,[StringComparison]::OrdinalIgnoreCase)){throw 'GAME_OWNERSHIP_CHANGED'}
 if($Mode -eq 'udp'){
  $rows=@(Get-NetUDPEndpoint -OwningProcess $GameProcessId -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -in @('::','::1','0.0.0.0','127.0.0.1')} | ForEach-Object {@{address=$_.LocalAddress;port=$_.LocalPort}})
  $after=Get-CimInstance Win32_Process -Filter "ProcessId = $GameProcessId"
  if($null -eq $after -or $after.CreationDate -ne $p.CreationDate -or $after.ParentProcessId -ne $LauncherProcessId){throw 'GAME_OWNERSHIP_CHANGED'}
  @{ok=$true;endpoints=$rows}|ConvertTo-Json -Compress -Depth 4
  exit 0
 }
 Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Threading;
public static class DgnOreWindow {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback cb,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Callback cb,IntPtr p);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern bool ShowWindowAsync(IntPtr h,int n);
 [DllImport("user32.dll")]static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static long Inspect(int pid,bool play){IntPtr game=IntPtr.Zero,assertion=IntPtr.Zero;int count=0;
  EnumWindows(delegate(IntPtr h,IntPtr u){uint owner;GetWindowThreadProcessId(h,out owner);if(owner==(uint)pid){var title=new StringBuilder(512);GetWindowText(h,title,512);if(title.ToString().StartsWith("Assert Failure"))assertion=h;var cls=new StringBuilder(64);GetClassName(h,cls,64);if(cls.ToString()=="OGLES"){game=h;count++;}}return true;},IntPtr.Zero);
  if(assertion!=IntPtr.Zero){var message=new StringBuilder();EnumChildWindows(assertion,delegate(IntPtr h,IntPtr p){var s=new StringBuilder(2048);GetWindowText(h,s,2048);if(s.ToString().Contains("Assertion failed"))message.Append(s);return message.Length<2048;},IntPtr.Zero);throw new Exception("GAME_ASSERT_DIALOG: "+message.ToString());}
  if(count!=1)throw new Exception("WINDOW_NOT_READY");
  if(!IsWindowVisible(game)||IsIconic(game)){ShowWindowAsync(game,4);throw new Exception("WINDOW_RESTORING");}
  if(play){if(!PostMessage(game,0x100,new IntPtr(13),new IntPtr(0x001c0001)))throw new Exception("INPUT_RESULT_UNKNOWN");Thread.Sleep(80);if(!PostMessage(game,0x101,new IntPtr(13),new IntPtr(unchecked((int)0xc01c0001))))throw new Exception("INPUT_RESULT_UNKNOWN");}
  return game.ToInt64();
 }
}
'@
 @{ok=$true;hwnd=[DgnOreWindow]::Inspect($GameProcessId,$Mode -eq 'play')}|ConvertTo-Json -Compress
}catch{@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress;exit 1}
