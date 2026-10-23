param([Parameter(Mandatory=$true)][string]$Zig)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nativeRoot=Join-Path $projectRoot 'native/host-isolation'
$minhookRoot=Join-Path $projectRoot 'native/ore-join/minhook'
$headers=Join-Path (Split-Path $Zig -Parent) 'lib/libc/include/any-windows-any'
$buildOutput=Join-Path $nativeRoot 'build'
New-Item -ItemType Directory -Path $buildOutput -Force | Out-Null
$sources=@('src/buffer.c','src/hook.c','src/trampoline.c','src/hde/hde64.c') | ForEach-Object {Join-Path $minhookRoot $_}
$sources += Join-Path $nativeRoot 'bootstrap.S'
& $Zig cc -target x86_64-windows-gnu -O2 -s -ffreestanding -fno-stack-protector -nostdlib -isystem $headers -I (Join-Path $minhookRoot 'include') -shared (Join-Path $nativeRoot 'bridge.c') $sources (Join-Path $projectRoot 'native/menu-name/support.c') '-Wl,--entry,DllMainCRTStartup' -lkernel32 -lshell32 -lole32 -lpsapi -o (Join-Path $buildOutput 'dgn-host-isolation.dll')
if($LASTEXITCODE -ne 0){throw 'Host isolation DLL build failed'}
Copy-Item -LiteralPath (Join-Path $buildOutput 'dgn-host-isolation.dll') -Destination (Join-Path $projectRoot 'runtime/native/dgn-host-isolation.dll')
& $Zig cc -target x86_64-windows-gnu -O2 -s -ffreestanding -fno-stack-protector -nostdlib -isystem $headers (Join-Path $projectRoot 'tests/fixtures/isolation-probe.c') (Join-Path $projectRoot 'native/menu-name/support.c') '-Wl,--entry,mainCRTStartup' '-Wl,--subsystem,console' -lkernel32 -lshell32 -lole32 -o (Join-Path $buildOutput 'isolation-probe.exe')
if($LASTEXITCODE -ne 0){throw 'Host isolation native probe build failed'}
