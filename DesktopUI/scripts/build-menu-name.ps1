param([Parameter(Mandatory=$true)][string]$Zig)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nativeRoot = Join-Path $projectRoot 'native/menu-name'
$output = Join-Path $projectRoot 'runtime/native'
$headers = Join-Path (Split-Path $Zig -Parent) 'lib/libc/include/any-windows-any'
$buildOutput = Join-Path $nativeRoot 'build'
New-Item -ItemType Directory -Path $output -Force | Out-Null
New-Item -ItemType Directory -Path $buildOutput -Force | Out-Null
& $Zig cc -target x86_64-windows-gnu -O2 -s -ffreestanding -fno-stack-protector -nostdlib -isystem $headers -shared (Join-Path $nativeRoot 'identity.c') (Join-Path $nativeRoot 'support.c') '-Wl,--entry,DllMainCRTStartup' -lkernel32 -o (Join-Path $buildOutput 'menu-name.dll')
if ($LASTEXITCODE -ne 0) { throw 'Menu identity DLL build failed' }
& $Zig cc -target x86_64-windows-gnu -O2 -s -ffreestanding -fno-stack-protector -nostdlib -isystem $headers (Join-Path $nativeRoot 'helper.c') (Join-Path $nativeRoot 'support.c') '-Wl,--entry,mainCRTStartup' '-Wl,--subsystem,console' -lkernel32 -lshell32 -o (Join-Path $buildOutput 'menu-name-helper.exe')
if ($LASTEXITCODE -ne 0) { throw 'Menu identity helper build failed' }
Copy-Item -LiteralPath (Join-Path $buildOutput 'menu-name.dll') -Destination (Join-Path $output 'menu-name.dll')
Copy-Item -LiteralPath (Join-Path $buildOutput 'menu-name-helper.exe') -Destination (Join-Path $output 'menu-name-helper.exe')
