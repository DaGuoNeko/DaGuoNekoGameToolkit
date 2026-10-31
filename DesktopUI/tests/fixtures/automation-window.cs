using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
class AssertionFixture {
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(int ex,string cls,string title,int style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
    class FixtureForm:Form {
        protected override void WndProc(ref Message m) {
            if(m.Msg==0x111 && (m.WParam.ToInt64()&0xffff)==5) { Console.WriteLine("ignored");Dispose();Application.ExitThread();return; }
            base.WndProc(ref m);
        }
    }
    [STAThread] static void Main(string[] args) {
        var form=new FixtureForm {Text="Assert Failure fixture"};
        var label=new Label {Text="Assertion failed: fixture only",AutoSize=true};
        form.Controls.Add(label);
        var h=form.Handle; var l=label.Handle;
        var b=CreateWindowEx(0,"Button",args.Length>0?args[0]:"&Ignore",0x40000000,0,40,80,30,h,new IntPtr(5),IntPtr.Zero,IntPtr.Zero);
        if(args.Length>1 && args[1]=="disabled") form.Enabled=false;
        Console.WriteLine("ready");
        Application.Run();
    }
}
