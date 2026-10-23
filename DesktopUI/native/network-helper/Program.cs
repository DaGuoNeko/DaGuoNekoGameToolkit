using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Diagnostics;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Threading;

// A bounded, session-scoped broker. It never accepts an executable, shell command,
// configuration path, route, proxy subnet or arbitrary CLI arguments from the UI.
class Program {
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
    static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 262144 };
    static Process Core;
    static Process Parent;
    static DateTime ParentStart;
    static string Root, Rpc, Instance;
    static bool Ending;
    static bool Cleaning;
    static bool CleanupFailed;
    static object Gate = new object();
    static List<string> FirewallRules = new List<string>();
    static void Firewall(string suffix,string app,string ip,int protocol,int port) {
        dynamic policy=Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2"));
        dynamic rule=Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FWRule"));
        string name="DaGuoNeko-Room-"+Instance+"-"+suffix;
        rule.Name=name;rule.Description="大果喵工具箱本次联机会话，退出后移除";rule.ApplicationName=app;rule.Protocol=protocol;
        rule.LocalAddresses=ip;rule.RemoteAddresses=ip.Substring(0,ip.LastIndexOf('.'))+".0/24";
        if(port>0)rule.LocalPorts=port.ToString();rule.Direction=1;rule.Action=1;rule.Enabled=true;rule.Profiles=7;
        policy.Rules.Add(rule);FirewallRules.Add(name);
    }
    static string Text(Dictionary<string, object> d, string k) { return d.ContainsKey(k) ? Convert.ToString(d[k]) : ""; }
    static int Port(string s) { int p; if (!int.TryParse(s, out p) || p < 1024 || p > 65535) throw new Exception("端口必须为 1024–65535"); return p; }
    static string Id(string s) { return Guid.Parse(s).ToString(); }
    static string Key(string s) { if (Convert.FromBase64String(s).Length != 32) throw new Exception("密钥长度无效"); return s; }
    static string Quote(string s) { return Json.Serialize(s); }
    static string Arg(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }
    static string Ip(string s) { if (!Regex.IsMatch(s, @"^10\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})$")) throw new Exception("虚拟地址无效"); foreach(var n in s.Split('.')) if(int.Parse(n)>255) throw new Exception("虚拟地址无效"); return s; }
    static string Endpoint(string s) { Uri u; if(!Uri.TryCreate(s, UriKind.Absolute, out u) || u.Scheme!="tcp" || u.Port<1 || u.Port>65535 || u.UserInfo!="" || u.AbsolutePath!="/" || u.Query!="" || u.Fragment!="") throw new Exception("公网入口无效"); return u.GetLeftPart(UriPartial.Authority); }
    static string Hash(string p) { using(var f=File.OpenRead(p)) using(var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(f)).Replace("-", "").ToLowerInvariant(); }
    static ProcessStartInfo StartInfo(string exe, string args) {
        var i=new ProcessStartInfo(Path.Combine(Root,exe),args) { WorkingDirectory=Root, UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true };
        var keys=new List<string>(); foreach(string k in i.EnvironmentVariables.Keys) if(k.StartsWith("ET_",StringComparison.OrdinalIgnoreCase) || k=="RUST_LOG") keys.Add(k);
        foreach(var k in keys) i.EnvironmentVariables.Remove(k);
        return i;
    }
    static object Cli(string args) {
        var i=StartInfo("easytier-cli.exe", "-p "+Rpc+" -i "+Instance+" -o json "+args);
        using(var p=Process.Start(i)) {
            var output=p.StandardOutput.ReadToEndAsync(); var error=p.StandardError.ReadToEndAsync();
            if(!p.WaitForExit(12000)){p.Kill();throw new Exception("EasyTier 管理请求超时");}
            if(p.ExitCode!=0) throw new Exception("EasyTier 管理请求失败（"+p.ExitCode+"），请检查网络组件状态");
            if(output.Result.Length>262144) throw new Exception("EasyTier 响应过大");
            return Json.DeserializeObject(output.Result);
        }
    }
    static object Handle(Dictionary<string,object> d) {
        string op=Text(d,"op");
        if(Cleaning && op!="stop")throw new Exception("正在清理网络，只允许重试停止");
        if(op=="start") {
            if(Core!=null) throw new Exception("网络已经启动");
            Instance=Id(Text(d,"instance")); Rpc="127.0.0.1:"+Port(Text(d,"rpcPort"));
            string ip=Ip(Text(d,"ip")), name=Text(d,"network"), role=Text(d,"role");
            if(!Regex.IsMatch(name,@"^dgn-[a-f0-9]{32}$") || (role!="host" && role!="guest")) throw new Exception("房间参数无效");
            string secret=Key(Text(d,"secret")), localKey=Key(Text(d,"privateKey"));
            string game=Path.GetFullPath(Text(d,"gamePath"));
            if(!RuntimeHashes.Games.Contains(Hash(game)))throw new Exception("游戏程序尚未适配联机网络规则");
            bool dynamicIp=role=="guest" && Text(d,"dynamicIp")=="True";
            Firewall("game",game,ip,17,0);
            if(dynamicIp) {
                dynamic policy=Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2"));
                policy.Rules.Item("DaGuoNeko-Room-"+Instance+"-game").LocalAddresses=ip.Substring(0,ip.LastIndexOf('.'))+".0/24";
            }
            if(role=="host")Firewall("control",Parent.MainModule.FileName,ip,6,Port(Text(d,"controlPort")));
            string cfg="instance_id = "+Quote(Instance)+"\ninstance_name = "+Quote(name)+"\nipv4 = "+Quote(ip+"/24")+"\ndhcp = "+(dynamicIp ? "true" : "false")+"\nstun_servers = []\nstun_servers_v6 = []\n";
            // Deny inbound virtual-network TCP except this room's authenticated
            // coordinator. EasyTier's own transport uses the physical socket.
            cfg += "tcp_whitelist = ["+Quote(role=="host" ? Port(Text(d,"controlPort")).ToString() : "0")+"]\n";
            cfg += "listeners = "+(role=="host" ? "["+Quote("tcp://127.0.0.1:"+Port(Text(d,"localPort")))+"]" : "[]")+"\n";
            cfg += "[network_identity]\nnetwork_name = "+Quote(name)+"\n";
            if(role=="host") cfg += "network_secret = "+Quote(secret)+"\n";
            cfg += "[secure_mode]\nenabled = true\nlocal_private_key = "+Quote(localKey)+"\n";
            if(role=="guest") cfg += "[[peer]]\nuri = "+Quote(Endpoint(Text(d,"endpoint")))+"\npeer_public_key = "+Quote(Key(Text(d,"hostPublicKey")))+"\n";
            cfg += "[flags]\nenable_encryption = true\nenable_ipv6 = false\nprivate_mode = true\ndisable_p2p = true\ndisable_relay_data = true\nenable_udp_broadcast_relay = true\n";
            if(role=="host" && Text(d,"fixedCredential")!="") {
                // EasyTier requires an integer expiry even for a persistent grant.
                // Use its maximum calendar timestamp; no product TTL or renewal.
                cfg += "[[managed_credentials]]\ncredential_id = "+Quote(Id(Text(d,"fixedId")))+"\ncredential_secret = "+Quote(Key(Text(d,"fixedCredential")))+"\nexpiry_unix = 253402300799\nreusable = true\nallow_relay = false\nallowed_proxy_cidrs = []\n";
            }
            var file=Path.Combine(Root,"session.toml"); File.WriteAllText(file,cfg,new UTF8Encoding(false));
            var i=StartInfo("easytier-core.exe","-c "+Arg(file)+" -r "+Rpc+" --rpc-portal-whitelist 127.0.0.1/32 --console-log-level error --file-log-level off");
            if(role=="guest") i.EnvironmentVariables["ET_CREDENTIAL"]=secret;
            Core=Process.Start(i); Core.OutputDataReceived+=(s,e)=>{}; Core.ErrorDataReceived+=(s,e)=>{}; Core.BeginOutputReadLine(); Core.BeginErrorReadLine();
            return new { pid=Core.Id };
        }
        if(op=="stop") { Clean(); if(CleanupFailed)throw new Exception("网络清理未完成，请检查本次网络进程与防火墙规则"); return true; }
        if(Core==null || Core.HasExited) throw new Exception("EasyTier 网络进程已退出");
        if(op=="status") {
            var n=Cli("node info");
            Scrub(n);
            return new { node=n, peers=Cli("peer list"), routes=Cli("route"), pid=Core.Id };
        }
        if(op=="invite") { int ttl=int.Parse(Text(d,"ttl")); if(ttl<600 || ttl>86400) throw new Exception("邀请有效期无效"); return Cli("credential generate --ttl "+ttl+" --credential-id "+Id(Text(d,"id"))+" --reusable false"); }
        if(op=="revoke") return Cli("credential revoke "+Id(Text(d,"id")));
        throw new Exception("不支持的网络操作");
    }
    static void Scrub(object value) {
        var d=value as Dictionary<string,object>;if(d!=null){d.Remove("config");d.Remove("network_secret");d.Remove("local_private_key");foreach(var v in d.Values)Scrub(v);return;}
        var a=value as object[];if(a!=null)foreach(var v in a)Scrub(v);
    }
    static void Clean() { lock(Gate) { Cleaning=true; CleanupFailed=false; if(Core!=null) { bool exited=false; try { if(!Core.HasExited){Core.Kill();exited=Core.WaitForExit(5000);}else exited=true; } catch(InvalidOperationException){exited=true;} catch(System.ComponentModel.Win32Exception){} if(exited){Core.Dispose();Core=null;}else CleanupFailed=true; }
        var remaining=new List<string>();foreach(string name in FirewallRules)try{dynamic policy=Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2"));policy.Rules.Remove(name);}catch(System.Runtime.InteropServices.COMException){CleanupFailed=true;remaining.Add(name);}FirewallRules=remaining;
        if(Root!=null)try{File.Delete(Path.Combine(Root,"session.toml"));}catch(IOException){CleanupFailed=true;}catch(UnauthorizedAccessException){CleanupFailed=true;}
        Ending=!CleanupFailed;
        if(Root!=null && !CleanupFailed) { foreach(var file in RuntimeHashes.Files.Keys)try{File.Delete(Path.Combine(Root,file));}catch(IOException){}catch(UnauthorizedAccessException){}
            try{Directory.Delete(Root,false);}catch(IOException){}catch(UnauthorizedAccessException){}
        }
    } }
    static string ReadBounded(StreamReader r) { var b=new StringBuilder(); for(int c;(c=r.Read())!=-1;) {if(c==10)return b.ToString();if(b.Length>=65536)throw new Exception("请求过大");b.Append((char)c);}return null; }
    static int Main(string[] args) {
        try {
            SetErrorMode(0x8003); // Child loader failures become errors, not modal OS dialogs.
            if(args.Length!=5 || !Regex.IsMatch(args[0],@"^dgn-network-[a-f0-9]{32}$") || !Regex.IsMatch(args[1],@"^[a-f0-9]{64}$")) return 2;
            Parent=Process.GetProcessById(int.Parse(args[2]));ParentStart=Parent.StartTime.ToUniversalTime();
            if(ParentStart.Ticks.ToString()!=args[3]) return 3;
            var sid=new SecurityIdentifier(args[4]);
            Root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"DaGuoNeko_GameToolkit","network-runtime",Guid.NewGuid().ToString());
            var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);
            acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
            Directory.CreateDirectory(Root,acl);
            foreach(var kv in RuntimeHashes.Files) { var src=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,kv.Key);if(Hash(src)!=kv.Value)throw new Exception("网络组件校验失败");var dst=Path.Combine(Root,kv.Key);File.Copy(src,dst);if(Hash(dst)!=kv.Value)throw new Exception("网络组件复制校验失败"); }
            var ps=new PipeSecurity();ps.SetAccessRuleProtection(true,false);ps.AddAccessRule(new PipeAccessRule(sid,PipeAccessRights.ReadWrite,AccessControlType.Allow));ps.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
            using(var pipe=new NamedPipeServerStream(args[0],PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,ps))
            using(var timer=new Timer(_=>{try {if(Parent.HasExited || Parent.StartTime.ToUniversalTime()!=ParentStart){Clean();Environment.Exit(0);}}catch{Clean();Environment.Exit(0);}},null,1000,1000)) {
                var pending=pipe.BeginWaitForConnection(null,null);if(!pending.AsyncWaitHandle.WaitOne(90000))return 4;pipe.EndWaitForConnection(pending);
                using(var reader=new StreamReader(pipe,new UTF8Encoding(false))) using(var writer=new StreamWriter(pipe,new UTF8Encoding(false)) {AutoFlush=true}) {
                    if(ReadBounded(reader)!=args[1])return 5;
                    writer.WriteLine("{\"ready\":true}");
                    while(!Ending) {string line=ReadBounded(reader);if(line==null)break;try {var d=Json.Deserialize<Dictionary<string,object>>(line);writer.WriteLine(Json.Serialize(new {ok=true,result=Handle(d)}));}catch(Exception e){writer.WriteLine(Json.Serialize(new {ok=false,error=e is FormatException ? "网络参数格式无效" : e.Message}));} }
                }
            }
            return 0;
        } catch { return 1; }
        finally { Clean(); if(Root!=null){try {File.Delete(Path.Combine(Root,"session.toml"));}catch(IOException){} } }
    }
}
