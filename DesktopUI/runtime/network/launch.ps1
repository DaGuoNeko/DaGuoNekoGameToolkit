param([string]$Helper,[string]$Pipe,[string]$Token,[int]$ParentId,[string]$ParentTicks,[string]$Sid)
$ErrorActionPreference='Stop'
try {
    $identity=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    $options=@{FilePath=$Helper;ArgumentList=@($Pipe,$Token,$ParentId,$ParentTicks,$Sid);WindowStyle='Hidden';PassThru=$true}
    if(-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){$options.Verb='RunAs'}
    $p=Start-Process @options
    @{pid=$p.Id}|ConvertTo-Json -Compress
} catch { Write-Output '{"error":"网络授权被取消或无法启动网络助手"}'; exit 1 }
