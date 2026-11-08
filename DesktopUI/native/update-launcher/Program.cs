using System;
using System.Diagnostics;
using System.IO;
using System.Text;

static class Program {
    static readonly object LogLock = new object();
    static string Quote(string value) {
        if (value.IndexOf('"') >= 0 || value.EndsWith("\\")) throw new ArgumentException("Invalid updater argument");
        return "\"" + value + "\"";
    }
    static void Log(string file, string text) {
        if (text == null) return;
        lock (LogLock) File.AppendAllText(file, text + Environment.NewLine, new UTF8Encoding(false));
    }
    static int Main(string[] args) {
        if (args.Length != 3) return 2;
        try {
            foreach (string value in args) if (!Path.IsPathRooted(value)) throw new ArgumentException("Updater paths must be absolute");
            string cacheDirectory = Path.GetDirectoryName(args[1]);
            if (string.IsNullOrEmpty(cacheDirectory)) throw new ArgumentException("Invalid update plan");
            Directory.SetCurrentDirectory(cacheDirectory);
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe");
            using (var process = new Process()) {
                process.StartInfo = new ProcessStartInfo(powershell,
                    "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(args[0]) + " -Plan " + Quote(args[1]) + " -LauncherPid " + Process.GetCurrentProcess().Id);
                process.StartInfo.UseShellExecute = false;
                process.StartInfo.CreateNoWindow = true;
                process.StartInfo.RedirectStandardOutput = true;
                process.StartInfo.RedirectStandardError = true;
                process.StartInfo.StandardOutputEncoding = Encoding.UTF8;
                process.StartInfo.StandardErrorEncoding = Encoding.UTF8;
                process.OutputDataReceived += (sender, data) => Log(args[2], data.Data);
                process.ErrorDataReceived += (sender, data) => Log(args[2], data.Data);
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                return process.ExitCode;
            }
        } catch (Exception error) {
            try { Log(args[2], error.Message); } catch { }
            return 1;
        }
    }
}
