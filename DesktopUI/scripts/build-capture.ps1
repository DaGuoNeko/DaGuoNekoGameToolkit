$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$fx=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$output=Join-Path $root 'runtime/automation'
$null=New-Item -ItemType Directory -Path $output -Force
$refs=@('System.dll','System.Core.dll','System.Drawing.dll',(Join-Path $fx 'System.Runtime.WindowsRuntime.dll'),(Join-Path $fx 'System.Runtime.InteropServices.WindowsRuntime.dll'))
foreach($name in @('System.Runtime','System.Runtime.InteropServices','System.ObjectModel')) {
    $file=Get-ChildItem -Path (Join-Path $env:WINDIR "Microsoft.NET/assembly/GAC_MSIL/$name/*/$name.dll") | Select-Object -First 1 -ExpandProperty FullName
    if (!$file) { throw "Missing framework assembly: $name" }
    $refs+=$file
}
foreach($name in @('Windows.Foundation','Windows.Graphics','Windows.Storage')) {
    $refs+=Join-Path $env:WINDIR "System32/WinMetadata/$name.winmd"
}
$argsList=@('/nologo','/target:library',('/out:'+(Join-Path $output 'automation-window.dll')))+@($refs|ForEach-Object {'/r:'+$_})+@((Join-Path $root 'electron/automation-window.cs'),(Join-Path $root 'electron/automation-capture.cs'))
& (Join-Path $fx 'csc.exe') $argsList
if ($LASTEXITCODE -ne 0) { throw 'Window capture helper compilation failed' }
