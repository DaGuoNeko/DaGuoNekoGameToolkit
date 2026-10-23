$ErrorActionPreference = 'Stop'
function Get-DgnHash([string]$file) {
    $stream=[IO.File]::OpenRead($file)
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $root 'runtime/network'
$source = Join-Path $root 'native/network-helper'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$pinned = Get-Content -LiteralPath (Join-Path $source 'runtime-files.json') -Raw | ConvertFrom-Json
$files = @('easytier-core.exe','easytier-cli.exe','wintun.dll','WinDivert64.sys','Packet.dll')
$hashes = [ordered]@{}
$lines = @('using System.Collections.Generic;', 'static class RuntimeHashes { public static Dictionary<string,string> Files = new Dictionary<string,string> {')
foreach($file in $files) {
    $hash = [string]$pinned.PSObject.Properties[$file].Value
    if($hash -notmatch '^[a-f0-9]{64}$'){throw ('Missing pinned network hash: '+$file)}
    # A fresh checkout has no downloaded network binaries. If a developer has
    # cached them here, reject substitutions instead of changing the allowlist.
    $local = Join-Path $runtime $file
    if((Test-Path -LiteralPath $local) -and (Get-DgnHash $local) -ne $hash){throw ('Network component hash mismatch: '+$file)}
    $hashes[$file] = $hash
    $lines += ('{{"{0}","{1}"}},' -f $file,$hash)
}
$lines += '}; public static HashSet<string> Games = new HashSet<string> {'
$engines = Get-Content -LiteralPath (Join-Path $root 'electron/supported-engines.json') -Raw | ConvertFrom-Json
if(-not @($engines.PSObject.Properties).Count){throw 'Supported engine list is empty'}
foreach($entry in $engines.PSObject.Properties | Sort-Object Name) {
    if($entry.Name -notmatch '^[a-f0-9]{64}$' -or $entry.Value -notmatch '^\d+\.\d+\.\d+\.\d+$'){throw 'Invalid supported engine entry'}
    $lines += ('"{0}",' -f $entry.Name)
}
$lines += '}; }'
[IO.File]::WriteAllLines((Join-Path $source 'RuntimeHashes.cs'),$lines,(New-Object Text.UTF8Encoding($false)))
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $csc /nologo /target:winexe /platform:x64 /optimize+ /r:System.Web.Extensions.dll /r:Microsoft.CSharp.dll "/out:$runtime/network-helper.exe" (Join-Path $source 'Program.cs') (Join-Path $source 'RuntimeHashes.cs')
if($LASTEXITCODE -ne 0){throw 'Network helper compilation failed'}
$hashes['network-helper.exe']=Get-DgnHash (Join-Path $runtime 'network-helper.exe')
[IO.File]::WriteAllText((Join-Path $runtime 'manifest.json'),(@{version='2.7.0-8b7f1f01';prerelease=$true;files=$hashes}|ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding($false)))
