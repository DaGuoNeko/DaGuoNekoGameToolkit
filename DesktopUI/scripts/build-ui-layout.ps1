param([Parameter(Mandatory=$true)][string]$Zig)
$ErrorActionPreference = 'Stop'
$uiRoot = Split-Path $PSScriptRoot -Parent
& $Zig c++ -target wasm32-freestanding -std=c++17 -O3 -nostdlib -fno-exceptions -fno-rtti '-Wl,--no-entry' '-Wl,--export=input_ptr' '-Wl,--export=output_ptr' '-Wl,--export=layout' '-Wl,--export=hit' '-Wl,-z,stack-size=65536' (Join-Path $uiRoot 'native/ui-layout/layout.cpp') -o (Join-Path $uiRoot 'src/ui-layout.wasm')
if ($LASTEXITCODE -ne 0) { throw 'UI layout compilation failed' }
