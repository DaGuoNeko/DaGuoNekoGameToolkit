param([Parameter(Mandatory=$true)][string]$PackageDirectory, [Parameter(Mandatory=$true)][string]$ZipPath, [Parameter(Mandatory=$true)][string]$ReleaseRoot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packagePath = (Resolve-Path -LiteralPath $PackageDirectory).Path
$releasePath = (Resolve-Path -LiteralPath $ReleaseRoot).Path.TrimEnd('\') + '\'
$zipTarget = [System.IO.Path]::GetFullPath($ZipPath)
if (-not $packagePath.StartsWith($releasePath, [StringComparison]::OrdinalIgnoreCase) -or -not $zipTarget.StartsWith($releasePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output is outside release directory' }
$temporaryZip = $zipTarget + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
try {
  [System.IO.Compression.ZipFile]::CreateFromDirectory($packagePath, $temporaryZip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $archive = [System.IO.Compression.ZipFile]::OpenRead($temporaryZip)
  try {
    $checked = 0
    foreach ($entry in $archive.Entries) {
      if (-not $entry.Name) { continue }
      $relative = $entry.FullName -replace '^[^/\\]+[/\\]', ''
      $file = [System.IO.Path]::GetFullPath((Join-Path $packagePath $relative))
      if (-not $file.StartsWith($packagePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid ZIP entry' }
      $stream = $entry.Open()
      $hasher = [System.Security.Cryptography.SHA256]::Create()
      $diskStream = [System.IO.File]::OpenRead($file)
      try {
        $hash = [BitConverter]::ToString($hasher.ComputeHash($stream))
        $diskHash = [BitConverter]::ToString($hasher.ComputeHash($diskStream))
      } finally { $stream.Dispose(); $diskStream.Dispose(); $hasher.Dispose() }
      if ($hash -ne $diskHash) { throw "ZIP verification failed: $relative" }
      $checked++
    }
    if ($checked -ne (Get-ChildItem -LiteralPath $packagePath -Recurse -File | Measure-Object).Count) { throw 'ZIP file count mismatch' }
  } finally { $archive.Dispose() }
  Move-Item -LiteralPath $temporaryZip -Destination $zipTarget -Force
  Write-Output "ZIP verified: $checked files; $zipTarget"
} finally {
  if (Test-Path -LiteralPath $temporaryZip) { Remove-Item -LiteralPath $temporaryZip }
}
