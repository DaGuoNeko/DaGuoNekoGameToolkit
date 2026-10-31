param([int]$GameProcessId, [int]$LauncherProcessId, [string]$GamePath, [string]$AssertionId='', [switch]$Capture, [long]$WindowHandle, [string]$ProcessCreatedAt)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'automation-window.dll')
    if ($Capture) {
        if ($AssertionId) { throw 'Capture cannot dispatch assertion actions' }
        $value=[DgnAutomationCapture]::Capture($GameProcessId,$LauncherProcessId,$GamePath,$WindowHandle,$ProcessCreatedAt)
    } else {
        $value=[DgnAutomationWindow]::Inspect($GameProcessId,$LauncherProcessId,$GamePath,$AssertionId)
    }
    @{ok=$true;value=$value} | ConvertTo-Json -Compress -Depth 8
} catch {
    @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress
    exit 1
}
