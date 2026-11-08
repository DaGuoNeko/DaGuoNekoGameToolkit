param(
  [Parameter(Mandatory = $true)]
  [string]$Plan,
  [int]$LauncherPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$planPath = [IO.Path]::GetFullPath($Plan)
$cacheDirectory = [IO.Path]::GetDirectoryName($planPath)
Set-Location -LiteralPath $cacheDirectory
[IO.Directory]::SetCurrentDirectory($cacheDirectory)
$resultPath = Join-Path ([IO.Path]::GetDirectoryName($planPath)) 'update-result.json'
$readyPath = $planPath + '.ready'
$cancelledPath = $planPath + '.cancelled'
$stage = $null
$backup = $null
$oldMoved = $false
$newMoved = $false

function Assert-NoLink([string]$Location) {
  $cursor = [IO.Path]::GetFullPath($Location)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Update paths must not contain directory links'
      }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}

function Get-ArchiveHash([string]$Location) {
  $stream = [IO.File]::OpenRead($Location)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}

function Move-UpdateDirectory([string]$From, [string]$To) {
  # HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION). Avoid localized text in this UTF-8 script.
  $sharingViolation = -2147024864
  $until = (Get-Date).AddSeconds(20)
  while ($true) {
    try { Move-Item -LiteralPath $From -Destination $To; return }
    catch {
      $locked = $_.Exception.HResult -eq $sharingViolation -or $_.Exception.InnerException.HResult -eq $sharingViolation
      if (-not $locked -or (Get-Date) -gt $until) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

try {
  $job = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $archive = [IO.Path]::GetFullPath([string]$job.archive)
  $target = [IO.Path]::GetFullPath([string]$job.targetDirectory).TrimEnd('\')
  $executable = [IO.Path]::GetFullPath([string]$job.executablePath)
  $parent = [IO.Path]::GetDirectoryName($target)
  if (-not $parent -or $target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\')) { throw 'Invalid application directory' }
  foreach ($location in @($planPath, $archive, $target, $executable)) { Assert-NoLink $location }
  if ([IO.Path]::GetFileName($executable) -ne 'DaGuoNeko-Game-Toolkit.exe' -or
      [IO.Path]::GetDirectoryName($executable) -ne $target) { throw 'Invalid update executable' }
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $target 'resources/app.asar') -PathType Leaf)) { throw 'Invalid installed application' }
  if ($archive.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or
      $planPath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Update cache must be outside the application directory' }
  if ([string]$job.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      (Get-ArchiveHash $archive) -ne $job.sha256) { throw 'Update archive SHA-256 mismatch' }

  # Stage beside the application so both directory moves remain on the same volume.
  $stage = Join-Path $parent ('.dgn-update-' + [guid]::NewGuid().ToString('N'))
  $backup = $target + '.previous-' + [guid]::NewGuid().ToString('N')
  New-Item -ItemType Directory -Path $stage | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      $entryPath = [IO.Path]::GetFullPath((Join-Path $stage $entry.FullName))
      if ($entry.FullName -match '(^[\\/]|:|(^|[\\/])\.\.([\\/]|$))' -or
          -not $entryPath.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe path in update archive' }
      if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Links in update archive are not supported' }
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $stage)
  $children = @(Get-ChildItem -LiteralPath $stage -Force)
  $source = $stage
  if ($children.Count -eq 1 -and $children[0].PSIsContainer) { $source = $children[0].FullName }
  $newInfo = Get-Content -LiteralPath (Join-Path $source 'release-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($newInfo.version -ne $job.version -or $newInfo.platform -ne 'win32' -or $newInfo.arch -ne 'x64' -or
      -not (Test-Path -LiteralPath (Join-Path $source 'DaGuoNeko-Game-Toolkit.exe') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $source 'resources/app.asar') -PathType Leaf)) { throw 'Update package version or layout is invalid' }

  if (Test-Path -LiteralPath $cancelledPath) { throw 'Update cancelled before replacing the application' }
  $receiptPid = if ($LauncherPid -gt 0) { $LauncherPid } else { $PID }
  [IO.File]::WriteAllText($readyPath + '.tmp', (@{pid=$receiptPid;version=$job.version} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath ($readyPath + '.tmp') -Destination $readyPath -Force
  $deadline = (Get-Date).AddSeconds(120)
  while ($true) {
    if (Test-Path -LiteralPath $cancelledPath) { throw 'Update cancelled before replacing the application' }
    $running = Get-Process -Id ([int]$job.pid) -ErrorAction SilentlyContinue
    if (-not $running) { break }
    $path = $null
    try { $path = $running.Path } catch { $path = $null }
    if ($path -and $path -ne $executable) { throw 'Application process identity changed' }
    if ((Get-Date) -gt $deadline) { throw 'The old application did not exit' }
    Start-Sleep -Milliseconds 250
  }
  while ($true) {
    if (Test-Path -LiteralPath $cancelledPath) { throw 'Update cancelled before replacing the application' }
    $blocking = @(Get-Process -Name 'DaGuoNeko-Game-Toolkit' -ErrorAction SilentlyContinue | Where-Object {
      $path = $null
      try { $path = $_.Path } catch { $path = $null }
      -not $path -or $path -eq $executable
    })
    if ($blocking.Count -eq 0) { break }
    if ((Get-Date) -gt $deadline) { throw 'Another application instance is still running' }
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $cancelledPath) { throw 'Update cancelled before replacing the application' }
  Assert-NoLink $target
  Assert-NoLink $source
  Move-UpdateDirectory $target $backup
  $oldMoved = $true
  Move-UpdateDirectory $source $target
  $newMoved = $true
  Start-Process -FilePath $executable -WorkingDirectory $target -WindowStyle Normal -ErrorAction Stop | Out-Null
  $outcome = @{ ok = $true; version = $job.version; backup = $backup }
  [IO.File]::WriteAllText($resultPath, ($outcome | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  [IO.File]::Delete($archive)
  [IO.File]::Delete($planPath)
} catch {
  $failure = $_.Exception.Message
  if ($oldMoved) {
    try {
      if ($newMoved) {
        Assert-NoLink $target
        Move-UpdateDirectory $target ($stage + '.failed')
      }
      Assert-NoLink $backup
      Move-UpdateDirectory $backup $target
      Start-Process -FilePath $executable -WorkingDirectory $target -WindowStyle Normal -ErrorAction Stop | Out-Null
    } catch { $failure += '; rollback requires manual recovery: ' + $_.Exception.Message }
  }
  $outcome = @{ ok = $false; error = $failure }
  if ($backup -and (Test-Path -LiteralPath $backup)) { $outcome.backup = $backup }
  [IO.File]::WriteAllText($resultPath, ($outcome | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  [Console]::Error.WriteLine($failure)
  exit 1
} finally {
  [IO.File]::Delete($readyPath)
  [IO.File]::Delete($readyPath + '.tmp')
  if ($stage -and (Test-Path -LiteralPath $stage)) {
    if ([IO.Path]::GetDirectoryName($stage) -ne $parent -or -not [IO.Path]::GetFileName($stage).StartsWith('.dgn-update-')) { throw 'Invalid staging directory' }
    Assert-NoLink $stage
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
