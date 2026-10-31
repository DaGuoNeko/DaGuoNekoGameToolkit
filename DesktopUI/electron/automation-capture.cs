using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

public static class DgnAutomationCapture {
    [ComImport,Guid("905a0fef-bc53-11df-8c49-001e4fc686da"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IBufferByteAccess {void Buffer(out IntPtr pointer);}
    [ComImport,Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IGraphicsCaptureItemInterop {
        void CreateForWindow(IntPtr window,ref Guid iid,out IntPtr result);
        void CreateForMonitor(IntPtr monitor,ref Guid iid,out IntPtr result);
    }
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter,int type,IntPtr software,uint flags,IntPtr levels,uint count,uint sdk,out IntPtr device,out uint level,out IntPtr context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr device,out IntPtr result);
    public class Result { public int width,height; public long frameTimestamp; public string data,backend="windows-graphics-capture",frameTimestampClock="qpc_100ns"; public bool originalResolution=true; }
    static void Check(DgnAutomationWindow.Snapshot snapshot,long hwnd,string created) {
        if(snapshot.processCreatedAt!=created||snapshot.window==null||snapshot.window.hwnd!=hwnd)throw new Exception("CAPTURE_TARGET_CHANGED");
        if(!snapshot.window.visible||snapshot.window.minimized||snapshot.window.width<1||snapshot.window.height<1)throw new Exception("WINDOW_NOT_CAPTURABLE");
        if(snapshot.assertions.Count>0)throw new Exception("ASSERTION_PENDING");
    }
    public static Result Capture(int pid,int parentPid,string exe,long hwnd,string created) {
        var before=DgnAutomationWindow.Inspect(pid,parentPid,exe,"");
        Check(before,hwnd,created);
        var window=before.window;
        if(!GraphicsCaptureSession.IsSupported())throw new Exception("WGC_UNSUPPORTED");
        IntPtr device=IntPtr.Zero,context=IntPtr.Zero,dxgi=IntPtr.Zero,inspectable=IntPtr.Zero,itemPtr=IntPtr.Zero;
        IDirect3DDevice managedDevice=null;
        try {
            uint level;
            Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero,1,IntPtr.Zero,0x20,IntPtr.Zero,0,7,out device,out level,out context));
            var dxgiId=new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device,ref dxgiId,out dxgi));
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi,out inspectable));
            managedDevice=(IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable);
            var factory=(IGraphicsCaptureItemInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
            var itemId=new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
            factory.CreateForWindow(new IntPtr(hwnd),ref itemId,out itemPtr);
            var item=(GraphicsCaptureItem)Marshal.GetObjectForIUnknown(itemPtr);
            var size=item.Size;
            if(size.Width<1||size.Height<1||(long)size.Width*size.Height>16000000)throw new Exception("CAPTURE_SIZE_LIMIT");
            using(var pool=Direct3D11CaptureFramePool.CreateFreeThreaded(managedDevice,DirectXPixelFormat.B8G8R8A8UIntNormalized,2,size))
            using(var session=pool.CreateCaptureSession(item)) {
                session.IsCursorCaptureEnabled=false;
                session.StartCapture();
                var clock=Stopwatch.StartNew();
                while(clock.ElapsedMilliseconds<5000) {
                    using(var frame=pool.TryGetNextFrame()) {
                        if(frame==null) {Thread.Sleep(30);continue;}
                        if(frame.ContentSize.Width!=size.Width||frame.ContentSize.Height!=size.Height)throw new Exception("WGC_SIZE_CHANGED");
                        var copy=SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface);
                        while(copy.Status==Windows.Foundation.AsyncStatus.Started && clock.ElapsedMilliseconds<5000)Thread.Sleep(10);
                        if(copy.Status==Windows.Foundation.AsyncStatus.Started){copy.Cancel();throw new Exception("WGC_READBACK_TIMEOUT");}
                        using(var bitmap=copy.GetResults())
                        using(var bgra=SoftwareBitmap.Convert(bitmap,BitmapPixelFormat.Bgra8,BitmapAlphaMode.Ignore)) {
                            byte[] pixels=new byte[checked(bgra.PixelWidth*bgra.PixelHeight*4)];
                            var buffer=new Windows.Storage.Streams.Buffer((uint)pixels.Length);buffer.Length=(uint)pixels.Length;
                            bgra.CopyToBuffer(buffer);
                            IntPtr pointer;((IBufferByteAccess)(object)buffer).Buffer(out pointer);Marshal.Copy(pointer,pixels,0,pixels.Length);
                            var after=DgnAutomationWindow.Inspect(pid,parentPid,exe,"");
                            Check(after,hwnd,created);
                            if(after.window.width!=window.width||after.window.height!=window.height||after.window.screenX!=window.screenX||after.window.screenY!=window.screenY||after.window.frameWidth!=window.frameWidth||after.window.frameHeight!=window.frameHeight)throw new Exception("CAPTURE_TARGET_CHANGED");
                            return Encode(pixels,bgra.PixelWidth,bgra.PixelHeight,window,frame.SystemRelativeTime.Ticks);
                        }
                    }
                }
                throw new Exception("WGC_FRAME_TIMEOUT");
            }
        } finally {
            if(managedDevice!=null)managedDevice.Dispose();
            foreach(var pointer in new[]{itemPtr,inspectable,dxgi,context,device})if(pointer!=IntPtr.Zero)Marshal.Release(pointer);
        }
    }
    // 单独验证像素裁剪，不经过视频缩放；奇数尺寸也保留每一行与每一列。
    public static Result Encode(byte[] pixels,int width,int height,DgnAutomationWindow.Window window,long timestamp) {
        if(width<1||height<1||(long)width*height>16000000||pixels.Length!=(long)width*height*4||window.width<1||window.height<1)
            throw new Exception("CAPTURE_SIZE_LIMIT");
        int cropX,cropY;
        if(window.dwmFrame!=null && width==window.dwmFrame.width && height==window.dwmFrame.height) {cropX=window.dwmFrame.x;cropY=window.dwmFrame.y;}
        else if(width==window.frameWidth && height==window.frameHeight) {cropX=window.clientX;cropY=window.clientY;}
        else throw new Exception("CAPTURE_RESOLUTION_MISMATCH");
        if(cropX<0||cropY<0||cropX+window.width>width||cropY+window.height>height)throw new Exception("CAPTURE_CLIENT_BOUNDS_MISMATCH");
        bool varied=false;
        int first=(cropY*width+cropX)*4;
        for(int row=0;row<window.height&&!varied;row++)
            for(int col=0;col<window.width;col+=Math.Max(1,window.width/128)) {
                int i=((cropY+row)*width+cropX+col)*4;
                if(pixels[i]!=pixels[first]||pixels[i+1]!=pixels[first+1]||pixels[i+2]!=pixels[first+2]) {varied=true;break;}
            }
        if(!varied)throw new Exception("CAPTURE_UNIFORM_FRAME_UNVERIFIED");
        using(var image=new Bitmap(window.width,window.height,PixelFormat.Format32bppArgb))
        using(var encoded=new MemoryStream()) {
            var bits=image.LockBits(new Rectangle(0,0,image.Width,image.Height),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
            try {for(int row=0;row<image.Height;row++)Marshal.Copy(pixels,((cropY+row)*width+cropX)*4,IntPtr.Add(bits.Scan0,row*bits.Stride),image.Width*4);}
            finally {image.UnlockBits(bits);}
            image.Save(encoded,ImageFormat.Png);
            if(encoded.Length>16*1024*1024)throw new Exception("CAPTURE_SIZE_LIMIT");
            return new Result {width=window.width,height=window.height,frameTimestamp=timestamp,data=Convert.ToBase64String(encoded.ToArray())};
        }
    }

}
