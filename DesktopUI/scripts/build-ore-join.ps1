param([Parameter(Mandatory=$true)][string]$Zig)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nativeRoot=Join-Path $projectRoot 'native/ore-join'
$headers=Join-Path (Split-Path $Zig -Parent) 'lib/libc/include/any-windows-any'
$buildOutput=Join-Path $nativeRoot 'build'
New-Item -ItemType Directory -Path $buildOutput -Force | Out-Null
$sources=@('bridge.c','minhook/src/buffer.c','minhook/src/hook.c','minhook/src/trampoline.c','minhook/src/hde/hde64.c') | ForEach-Object {Join-Path $nativeRoot $_}
& $Zig cc -target x86_64-windows-gnu -O2 -s -ffreestanding -fno-stack-protector -nostdlib -isystem $headers -I (Join-Path $nativeRoot 'minhook/include') -shared $sources (Join-Path $projectRoot 'native/menu-name/support.c') '-Wl,--entry,DllMainCRTStartup' -lkernel32 -lws2_32 -o (Join-Path $buildOutput 'ore-join.dll')
if($LASTEXITCODE -ne 0){throw 'OreUI bridge DLL build failed'}
Copy-Item -LiteralPath (Join-Path $buildOutput 'ore-join.dll') -Destination (Join-Path $projectRoot 'runtime/native/ore-join.dll')
