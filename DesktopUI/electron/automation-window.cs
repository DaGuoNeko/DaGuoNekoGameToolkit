using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

// 探针在独立进程中运行；不恢复窗口、不激活窗口、不发送全局键鼠。
public static class DgnAutomationWindow {
    public delegate bool Callback(IntPtr window, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window, Callback cb, IntPtr state);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect rect, int size);
    [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int DwmGetIntAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
    static extern IntPtr ReadText(IntPtr h, uint m, UIntPtr w, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int type, byte[] info, int length, out int written);
    public class Button { public long hwnd; public int id; public string text; public bool enabled; }
    public class Assertion { public string id, text, title; public long hwnd; public int pid; public bool enabled; public Button ignore; }
    public class Bounds { public int width,height,x,y; }
    public class Window { public long hwnd; public int width, height, frameWidth, frameHeight, clientX, clientY, screenX, screenY; public bool visible, minimized, foreground; public string occluded="unknown"; public Bounds dwmFrame; }
    public class Snapshot { public int pid; public string processCreatedAt; public Window window; public List<Assertion> assertions=new List<Assertion>(); public bool ignoreDispatched; }
    static string Class(IntPtr h) { var b=new StringBuilder(128); GetClassName(h,b,b.Capacity); return b.ToString(); }
    static string Title(IntPtr h) { var b=new StringBuilder(512); GetWindowText(h,b,b.Capacity); return b.ToString(); }
    static string ControlText(IntPtr h) {
        var b=new StringBuilder(4096); UIntPtr result;
        if(ReadText(h,13,(UIntPtr)b.Capacity,b,0x23,100,out result)==IntPtr.Zero) throw new Exception("WINDOW_TEXT_UNAVAILABLE");
        return b.ToString();
    }
    static string Hash(string text) { using(var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant(); }
    static void Guard(Process p, Process parent, string exe, long created) {
        if(p.HasExited || parent.HasExited || p.StartTime.ToFileTimeUtc()!=created) throw new Exception("GAME_OWNERSHIP_CHANGED");
        var basic=new byte[48]; int written;
        if(NtQueryInformationProcess(p.Handle,0,basic,48,out written)!=0 || written!=48 || BitConverter.ToInt64(basic,40)!=parent.Id)
            throw new Exception("GAME_OWNERSHIP_CHANGED");
        if(!String.Equals(p.MainModule.FileName,exe,StringComparison.OrdinalIgnoreCase) || p.SessionId!=Process.GetCurrentProcess().SessionId)
            throw new Exception("GAME_OWNERSHIP_CHANGED");
    }
    public static Snapshot Inspect(int pid, int parentPid, string exe, string expectedId) {
        using(var p=Process.GetProcessById(pid)) using(var parent=Process.GetProcessById(parentPid)) {
            long created=p.StartTime.ToFileTimeUtc(); Guard(p,parent,exe,created);
            var snapshot=new Snapshot {pid=pid,processCreatedAt=created.ToString()};
            var windows=new List<IntPtr>();
            EnumWindows(delegate(IntPtr h,IntPtr state) { uint owner; GetWindowThreadProcessId(h,out owner); if(owner==(uint)pid) windows.Add(h); return windows.Count<128; },IntPtr.Zero);
            var dpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
            try {
                foreach(var h in windows) {
                    uint owner; GetWindowThreadProcessId(h,out owner);
                    string title=Title(h);
                    if(owner==(uint)pid && Class(h)=="OGLES") {
                        if(snapshot.window!=null) throw new Exception("AMBIGUOUS_GAME_WINDOW");
                        Rect rect; if(!GetClientRect(h,out rect)) throw new Exception("WINDOW_BOUNDS_UNAVAILABLE");
                        Rect frame; var origin=new Point();
                        if(!GetWindowRect(h,out frame) || !ClientToScreen(h,ref origin)) throw new Exception("WINDOW_FRAME_UNAVAILABLE");
                        snapshot.window=new Window {hwnd=h.ToInt64(),width=rect.Right,height=rect.Bottom,frameWidth=frame.Right-frame.Left,frameHeight=frame.Bottom-frame.Top,clientX=origin.X-frame.Left,clientY=origin.Y-frame.Top,visible=IsWindowVisible(h),minimized=IsIconic(h),foreground=GetForegroundWindow()==h};
                        snapshot.window.screenX=origin.X; snapshot.window.screenY=origin.Y;
                        bool found=false,blocked=false,unknown=false;
                        EnumWindows(delegate(IntPtr other,IntPtr state) {
                            if(other==h) {found=true;return false;}
                            if(!IsWindowVisible(other)||IsIconic(other)) return true;
                            int cloaked; if(DwmGetIntAttribute(other,14,out cloaked,4)==0 && cloaked!=0) return true;
                            Rect bounds; if(!GetWindowRect(other,out bounds)) {unknown=true;return true;}
                            if(bounds.Left<origin.X+rect.Right && bounds.Right>origin.X && bounds.Top<origin.Y+rect.Bottom && bounds.Bottom>origin.Y) blocked=true;
                            return true;
                        },IntPtr.Zero);
                        snapshot.window.occluded=blocked?"yes":found&&!unknown?"no":"unknown";
                        Rect dwm;
                        if(DwmGetWindowAttribute(h,9,out dwm,16)==0) snapshot.window.dwmFrame=new Bounds {width=dwm.Right-dwm.Left,height=dwm.Bottom-dwm.Top,x=origin.X-dwm.Left,y=origin.Y-dwm.Top};
                    }
                    if(!title.StartsWith("Assert Failure",StringComparison.Ordinal)) continue;
                    var children=new List<IntPtr>();
                    EnumChildWindows(h,delegate(IntPtr child,IntPtr state) { children.Add(child); return children.Count<64; },IntPtr.Zero);
                    var texts=new List<string>(); var buttons=new List<Button>();
                    foreach(var child in children) {
                        string text=ControlText(child);
                        if(Class(child)=="Button") buttons.Add(new Button {hwnd=child.ToInt64(),id=GetDlgCtrlID(child),text=text,enabled=IsWindowEnabled(child)});
                        else if(text.Length>0) texts.Add(text);
                    }
                    var assertion=new Assertion {hwnd=h.ToInt64(),pid=(int)owner,title=title,text=String.Join("\n",texts.ToArray()),enabled=IsWindowEnabled(h)};
                    foreach(var b in buttons) {
                        string label=b.text.Normalize(NormalizationForm.FormKC).Replace("&","").Trim();
                        if(Regex.IsMatch(label,@"^(Ignore|忽略)(\s*\(I\))?$",RegexOptions.IgnoreCase)) {
                            if(assertion.ignore!=null) throw new Exception("AMBIGUOUS_ASSERT_IGNORE");
                            assertion.ignore=b;
                        }
                    }
                    assertion.id=Hash(pid+":"+created+":"+assertion.hwnd+":"+title+":"+assertion.text+":"+(assertion.ignore==null?"":assertion.ignore.hwnd+":"+assertion.ignore.text));
                    snapshot.assertions.Add(assertion);
                }
                Guard(p,parent,exe,created);
                if(!String.IsNullOrEmpty(expectedId)) {
                    var target=snapshot.assertions.Find(a=>a.id==expectedId);
                    if(target==null || target.ignore==null || !target.ignore.enabled || !target.enabled) throw new Exception("ASSERT_CHANGED_OR_IGNORE_UNSUPPORTED");
                    uint owner; GetWindowThreadProcessId(new IntPtr(target.hwnd),out owner);
                    if(owner!=(uint)pid) throw new Exception("GAME_OWNERSHIP_CHANGED");
                    var button=new IntPtr(target.ignore.hwnd); var dialog=new IntPtr(target.hwnd);
                    if(GetParent(button)!=dialog || GetDlgCtrlID(button)!=target.ignore.id || !IsWindowEnabled(dialog) || !IsWindowEnabled(button) || ControlText(button)!=target.ignore.text)
                        throw new Exception("ASSERT_CHANGED_OR_IGNORE_UNSUPPORTED");
                    Guard(p,parent,exe,created);
                    // 等同于该按钮/助记键产生的通知；后台 BM_CLICK 可能失效，不激活窗口或发送桌面 I。
                    if(target.ignore.id<=0 || target.ignore.id>65535 || !PostMessage(dialog,0x111,new IntPtr(target.ignore.id),button))
                        throw new Exception("ASSERT_IGNORE_RESULT_UNKNOWN");
                    snapshot.ignoreDispatched=true;
                }
                return snapshot;
            } finally { if(dpi!=IntPtr.Zero) SetThreadDpiAwarenessContext(dpi); }
        }
    }
}
