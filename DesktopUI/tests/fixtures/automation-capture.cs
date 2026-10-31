using System;
using System.IO;
using System.Drawing;
public static class CapturePixelFixture {
    static void Refuses(Action action,string message) {
        try {action();} catch(Exception e) {if(e.Message.Contains(message))return;throw;}
        throw new Exception("Expected refusal: "+message);
    }
    public static void Run() {
        byte[] pixels=new byte[5*5*4];
        for(int y=0;y<5;y++)for(int x=0;x<5;x++) {int i=(y*5+x)*4;pixels[i]=(byte)x;pixels[i+1]=(byte)y;pixels[i+2]=(byte)(x+y+10);pixels[i+3]=255;}
        var window=new DgnAutomationWindow.Window {width=3,height=2,frameWidth=5,frameHeight=5,clientX=1,clientY=2};
        foreach(bool dwm in new[]{false,true}) {
            window.dwmFrame=dwm?new DgnAutomationWindow.Bounds{width=5,height=5,x=1,y=2}:null;
            var result=DgnAutomationCapture.Encode(pixels,5,5,window,123);
            if(result.width!=3||result.height!=2||result.frameTimestamp!=123||!result.originalResolution)throw new Exception("Metadata mismatch");
            using(var stream=new MemoryStream(Convert.FromBase64String(result.data)))
            using(var image=new Bitmap(stream)) {
                for(int y=0;y<2;y++)for(int x=0;x<3;x++) {var p=image.GetPixel(x,y);if(p.B!=x+1||p.G!=y+2||p.R!=x+y+13)throw new Exception("Pixel was changed");}
            }
        }
        Refuses(()=>DgnAutomationCapture.Encode(new byte[100],5,5,window,0),"UNIFORM_FRAME");
        window.dwmFrame=null;window.clientX=4;
        Refuses(()=>DgnAutomationCapture.Encode(pixels,5,5,window,0),"BOUNDS_MISMATCH");
        window.frameHeight=6;
        Refuses(()=>DgnAutomationCapture.Encode(pixels,5,5,window,0),"RESOLUTION_MISMATCH");
    }
}
