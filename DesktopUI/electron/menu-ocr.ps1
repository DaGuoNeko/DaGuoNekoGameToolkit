param([string]$ImagePath, [int]$GameProcessId, [int]$LauncherProcessId, [string]$GamePath, [string]$ExpectedRoomName,
      [ValidateSet('capture','click')][string]$Mode='capture', [long]$Hwnd, [int]$Width, [int]$Height, [double]$X, [double]$Y)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-Operation($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
}
$stream = $null
$bitmap = $null
try {
    $window = $null
    if ($GameProcessId -gt 0) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $GameProcessId"
        if ($null -eq $processInfo -or $processInfo.ParentProcessId -ne $LauncherProcessId -or -not [string]::Equals($processInfo.ExecutablePath, $GamePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'GAME_OWNERSHIP_CHANGED' }
        Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class DgnMenuWindow {
    public delegate bool EnumProc(IntPtr hwnd,IntPtr data);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn,IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,EnumProc fn,IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder name,int size);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int size);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd,int command);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public static IntPtr Find(int pid) {
        IntPtr found=IntPtr.Zero,assertion=IntPtr.Zero; int count=0;
        EnumWindows(delegate(IntPtr h,IntPtr p) { uint owner;GetWindowThreadProcessId(h,out owner);if(owner==(uint)pid){var title=new StringBuilder(512);GetWindowText(h,title,512);if(title.ToString().StartsWith("Assert Failure"))assertion=h;var cls=new StringBuilder(256);GetClassName(h,cls,256);if(cls.ToString()=="OGLES"){found=h;count++;}}return true;},IntPtr.Zero);
        if(assertion!=IntPtr.Zero){var details=new StringBuilder();EnumChildWindows(assertion,delegate(IntPtr h,IntPtr p){var text=new StringBuilder(2048);GetWindowText(h,text,2048);if(text.ToString().Contains("Assertion failed"))details.Append(text);return details.Length<2048;},IntPtr.Zero);throw new Exception("GAME_ASSERT_DIALOG: "+details.ToString());}
        if(count!=1)throw new Exception("WINDOW_NOT_READY"); return found;
    }
    public static long[] Capture(int pid,string output) {
        var previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            var h=Find(pid);
            if(!IsWindowVisible(h)||IsIconic(h)){ShowWindowAsync(h,4);throw new Exception("WINDOW_RESTORING");}
            Rect outer,client;Point origin=new Point();GetWindowRect(h,out outer);GetClientRect(h,out client);ClientToScreen(h,ref origin);
            int w=outer.Right-outer.Left,he=outer.Bottom-outer.Top,cw=client.Right,ch=client.Bottom;
            if(w<320||he<200||w>5000||he>5000||((long)w*he)>10000000)throw new Exception("WINDOW_SIZE_UNSUPPORTED");
            using(var full=new Bitmap(w,he,PixelFormat.Format32bppArgb)){
                using(var g=Graphics.FromImage(full)){var dc=g.GetHdc();try{if(!PrintWindow(h,dc,2))throw new Exception("WINDOW_CAPTURE_FAILED");}finally{g.ReleaseHdc(dc);}}
                using(var crop=full.Clone(new Rectangle(origin.X-outer.Left,origin.Y-outer.Top,cw,ch),PixelFormat.Format32bppArgb))crop.Save(output,ImageFormat.Png);
            }
            return new long[]{h.ToInt64(),cw,ch};
        } finally {if(previous!=IntPtr.Zero)SetThreadDpiAwarenessContext(previous);}
    }
    public static void Click(int pid,long hwnd,int width,int height,double x,double y) {
        var previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
        try{
            var h=Find(pid);Rect r;GetClientRect(h,out r);
            if(h.ToInt64()!=hwnd||r.Right!=width||r.Bottom!=height||!IsWindowVisible(h)||IsIconic(h))throw new Exception("WINDOW_CHANGED");
            if(x<0||x>1||y<0||y>1||Double.IsNaN(x)||Double.IsNaN(y))throw new Exception("INVALID_MENU_POINT");
            var p=new IntPtr(((int)(y*height)<<16)|(int)(x*width));
            if(!PostMessage(h,0x200,IntPtr.Zero,p)||!PostMessage(h,0x201,new IntPtr(1),p)||!PostMessage(h,0x202,IntPtr.Zero,p))throw new Exception("INPUT_RESULT_UNKNOWN");
        }finally{if(previous!=IntPtr.Zero)SetThreadDpiAwarenessContext(previous);}
    }
}
'@
        if ($Mode -eq 'click') {
            [DgnMenuWindow]::Click($GameProcessId,$Hwnd,$Width,$Height,$X,$Y)
            @{ok=$true; dispatched=$true} | ConvertTo-Json -Compress
            exit 0
        }
        $window = [DgnMenuWindow]::Capture($GameProcessId,$ImagePath)
    }
    $file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if ($decoder.PixelWidth -gt 4096 -or $decoder.PixelHeight -gt 4096) { throw 'IMAGE_TOO_LARGE' }
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $preferredScale = $(if ($decoder.PixelWidth -lt 1000) { 2 } else { 1 })
    $scale = [Math]::Min($preferredScale, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight))
    $transform.ScaledWidth = [uint32]($decoder.PixelWidth * $scale)
    $transform.ScaledHeight = [uint32]($decoder.PixelHeight * $scale)
    $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore, $transform, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $lines = @()
    $engineCount = 0
    foreach ($tag in @('zh-Hans-CN','en-US')) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($tag))
      if ($null -eq $engine) { continue }
      $engineCount++
      $recognized = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $lines += @($recognized.Lines | ForEach-Object {
        $words = @($_.Words | ForEach-Object { @{ text=$_.Text; x=$_.BoundingRect.X/$bitmap.PixelWidth; y=$_.BoundingRect.Y/$bitmap.PixelHeight; width=$_.BoundingRect.Width/$bitmap.PixelWidth; height=$_.BoundingRect.Height/$bitmap.PixelHeight } })
        @{ text=$_.Text; words=$words; language=$tag }
      })
    }
    if ($engineCount -eq 0) { throw 'OCR_LANGUAGE_MISSING' }
    if ($lines.Count -eq 0) { throw 'OCR_TEXT_UNAVAILABLE' }
    if ($ExpectedRoomName -match '^([\x20-\x7e]{1,64})([^\x00-\x7f].*)$' -and $GamePath) {
        $prefix = $Matches[1] -replace '\s',''
        $suffix = $Matches[2] -replace '\s',''
        $atlas = Join-Path ([IO.Path]::GetDirectoryName($GamePath)) 'data/resource_packs/vanilla/font/default8.png'
        if (Test-Path -LiteralPath $atlas -PathType Leaf) {
            Add-Type -ReferencedAssemblies System.Drawing -Path (Join-Path $PSScriptRoot 'menu-pixel-font.cs')
            $extra = @()
            foreach ($line in $lines) {
                if (-not (($line.text -replace '\s','').EndsWith($suffix))) { continue }
                for ($i=1; $i -lt $line.words.Count; $i++) {
                    $tail = ($line.words[$i..($line.words.Count-1)] | ForEach-Object { $_.text }) -join ''
                    if (($tail -replace '\s','') -ne $suffix) { continue }
                    $head = @($line.words[0..($i-1)])
                    $left = [Math]::Max(0,[Math]::Floor(($head.x | Measure-Object -Minimum).Minimum * $decoder.PixelWidth)-3)
                    $top = [Math]::Max(0,[Math]::Floor(($head.y | Measure-Object -Minimum).Minimum * $decoder.PixelHeight)-3)
                    $right = [Math]::Floor($line.words[$i].x * $decoder.PixelWidth)-1
                    $bottom = [Math]::Min($decoder.PixelHeight,[Math]::Ceiling((($head | ForEach-Object { $_.y+$_.height }) | Measure-Object -Maximum).Maximum * $decoder.PixelHeight)+3)
                    $decoded = [DgnPixelFont]::Decode($ImagePath,$atlas,$left,$top,$right-$left,$bottom-$top)
                    if ($decoded -ceq $prefix) {
                        $extra += @{text=$decoded+$suffix;words=$line.words;language='minecraft-bitmap'}
                    }
                    break
                }
            }
            $lines += $extra
        }
    }
    @{ ok=$true; hwnd= $(if($null -ne $window){$window[0]}else{0}); width=$decoder.PixelWidth; height=$decoder.PixelHeight; lines=$lines } | ConvertTo-Json -Depth 8 -Compress
} catch {
    @{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
}
