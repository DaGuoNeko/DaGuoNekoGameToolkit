using System;
using System.Collections.Generic;
using System.Drawing;
// Read glyphs from the selected game's font atlas; no game asset is redistributed.
public static class DgnPixelFont {
    class Mask {
        public bool[,] Bits; public int W,H,Top;
        public Mask(bool[,] bits,int top){Bits=bits;W=bits.GetLength(0);H=bits.GetLength(1);Top=top;}
    }
    static bool Ink(Color c){return c.A>128&&c.R>180&&c.G>180&&c.B>180;}
    static Mask Crop(Bitmap b,int x,int y,int w,int h){
        int left=w,right=-1,top=h,bottom=-1;
        for(int i=0;i<w;i++)for(int j=0;j<h;j++)if(Ink(b.GetPixel(x+i,y+j))){left=Math.Min(left,i);right=Math.Max(right,i);top=Math.Min(top,j);bottom=Math.Max(bottom,j);}
        if(right<0)return null;var bits=new bool[right-left+1,bottom-top+1];
        for(int i=0;i<bits.GetLength(0);i++)for(int j=0;j<bits.GetLength(1);j++)bits[i,j]=Ink(b.GetPixel(x+left+i,y+top+j));
        return new Mask(bits,y+top);
    }
    public static string Decode(string imagePath,string atlasPath,int x,int y,int width,int height){
        using(var image=new Bitmap(imagePath))using(var atlas=new Bitmap(atlasPath)){
            if(atlas.Width!=128||atlas.Height!=128||x<0||y<0||width<1||height<1||x+width>image.Width||y+height>image.Height||width>1600||height>160)return null;
            var glyphs=new Dictionary<char,Mask>();for(int c=33;c<127;c++){var m=Crop(atlas,(c%16)*8,(c/16)*8,8,8);if(m!=null)glyphs[(char)c]=m;}
            var pieces=new List<Mask>();int start=-1;
            for(int i=0;i<=width;i++){
                bool on=false;if(i<width)for(int j=0;j<height;j++)if(Ink(image.GetPixel(x+i,y+j))){on=true;break;}
                if(on&&start<0)start=i;
                if(!on&&start>=0){pieces.Add(Crop(image,x+start,y,i-start,height));start=-1;}
            }
            if(pieces.Count<1||pieces.Count>64)return null;
            int capHeight=0,capTop=Int32.MaxValue;foreach(var p in pieces){capHeight=Math.Max(capHeight,p.H);capTop=Math.Min(capTop,p.Top);}
            var text=new System.Text.StringBuilder();
            foreach(var p in pieces){
                // A baseline dot is clipped differently by the game's bitmap font renderer.
                if(p.W<=capHeight*.25&&p.H<=capHeight*.25&&p.Top-capTop>=capHeight*.65){text.Append('.');continue;}
                double best=10,second=10;char letter='\0';
                foreach(var item in glyphs){
                    var g=item.Value;double ratio=Math.Abs((double)p.W/p.H-(double)g.W/g.H);if(ratio>.2)continue;
                    int diff=0;for(int i=0;i<p.W;i++)for(int j=0;j<p.H;j++){
                        int gx=Math.Min(g.W-1,(int)((i+.5)*g.W/p.W)),gy=Math.Min(g.H-1,(int)((j+.5)*g.H/p.H));
                        if(p.Bits[i,j]!=g.Bits[gx,gy])diff++;
                    }
                    double score=ratio+(double)diff/(p.W*p.H);
                    if(score<best){second=best;best=score;letter=item.Key;}else if(score<second)second=score;
                }
                if(best>.14||second-best<.03)return null;
                text.Append(letter);
            }
            return text.ToString();
        }
    }
}
