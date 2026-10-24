param(
  [Parameter(Mandatory = $true)]
  [string]$Plan
)

$ErrorActionPreference = 'Stop'
$planPath = [IO.Path]::GetFullPath($Plan)
$resultPath = Join-Path ([IO.Path]::GetDirectoryName($planPath)) 'update-result.json'
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

  $deadline = (Get-Date).AddSeconds(120)
  while ($true) {
    $running = Get-Process -Id ([int]$job.pid) -ErrorAction SilentlyContinue
    if (-not $running) { break }
    if ($running.Path -ne $executable) { throw 'Application process identity changed' }
    if ((Get-Date) -gt $deadline) { throw 'The old application did not exit' }
    Start-Sleep -Milliseconds 250
  }
  foreach ($running in @(Get-Process -Name 'DaGuoNeko-Game-Toolkit' -ErrorAction SilentlyContinue)) {
    if (-not $running.Path -or $running.Path -eq $executable) { throw 'Another application instance is still running' }
  }
  Assert-NoLink $target
  Assert-NoLink $source
  Move-Item -LiteralPath $target -Destination $backup
  $oldMoved = $true
  Move-Item -LiteralPath $source -Destination $target
  $newMoved = $true
  Start-Process -FilePath $executable -WorkingDirectory $target -WindowStyle Hidden -ErrorAction Stop | Out-Null
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
        Move-Item -LiteralPath $target -Destination ($stage + '.failed')
      }
      Assert-NoLink $backup
      Move-Item -LiteralPath $backup -Destination $target
      Start-Process -FilePath $executable -WorkingDirectory $target -WindowStyle Hidden -ErrorAction Stop | Out-Null
    } catch { $failure += '; rollback requires manual recovery: ' + $_.Exception.Message }
  }
  $outcome = @{ ok = $false; error = $failure; backup = $backup }
  [IO.File]::WriteAllText($resultPath, ($outcome | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  Write-Error $failure
} finally {
  if ($stage -and (Test-Path -LiteralPath $stage)) {
    if ([IO.Path]::GetDirectoryName($stage) -ne $parent -or -not [IO.Path]::GetFileName($stage).StartsWith('.dgn-update-')) { throw 'Invalid staging directory' }
    Assert-NoLink $stage
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
