param(
  [Parameter(Mandatory = $true)][string]$SignedDirectory,
  [Parameter(Mandatory = $true)][ValidateSet('x64','arm64')][string]$Arch,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$catalog = Get-Content (Join-Path $repoRoot 'config/client-release.json') -Raw | ConvertFrom-Json
$version = [string]$catalog.current_version
if (-not $version) { throw 'config/client-release.json has no current_version' }

$signedRoot = (Resolve-Path $SignedDirectory).Path
$setup = Get-ChildItem -Path $signedRoot -Recurse -File -Filter "GreenChat-$version-windows-$Arch-setup.exe" | Select-Object -First 1
$msi = Get-ChildItem -Path $signedRoot -Recurse -File -Filter "GreenChat-$version-windows-$Arch.msi" | Select-Object -First 1
$portableExe = Get-ChildItem -Path $signedRoot -Recurse -File -Filter "GreenChat-$version-windows-$Arch-portable.exe" | Select-Object -First 1
foreach ($item in @($setup, $msi, $portableExe)) {
  if (-not $item) { throw 'SignPath output is missing one or more required GreenChat files' }
  $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
  if ($signature.Status -ne 'Valid') { throw "$($item.Name) signature is $($signature.Status): $($signature.StatusMessage)" }
  if (-not $signature.SignerCertificate) { throw "$($item.Name) has no signer certificate" }
  if ($signature.SignerCertificate.Subject -notmatch 'SignPath Foundation') {
    throw "$($item.Name) signer is not SignPath Foundation: $($signature.SignerCertificate.Subject)"
  }
  if (-not $signature.TimeStamperCertificate) { throw "$($item.Name) has no trusted timestamp" }
}

Remove-Item -LiteralPath $OutputDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
Copy-Item -LiteralPath $setup.FullName -Destination (Join-Path $OutputDirectory $setup.Name)
Copy-Item -LiteralPath $msi.FullName -Destination (Join-Path $OutputDirectory $msi.Name)

$portableRoot = Join-Path $env:RUNNER_TEMP "GreenChat-portable-$Arch"
Remove-Item -LiteralPath $portableRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $portableRoot | Out-Null
Copy-Item -LiteralPath $portableExe.FullName -Destination (Join-Path $portableRoot 'GreenChat.exe')
$runtime = Get-ChildItem -Path $signedRoot -Recurse -Directory | Where-Object { $_.Name -eq 'runtime' } | Select-Object -First 1
if (-not $runtime) { throw 'runtime directory is absent from SignPath output' }
Copy-Item -Path (Join-Path $runtime.FullName '*') -Destination $portableRoot -Recurse
if (-not (Test-Path -LiteralPath (Join-Path $portableRoot 'tdjson.dll') -PathType Leaf)) {
  throw 'portable package has no tdjson.dll'
}
$portableZip = Join-Path $OutputDirectory "GreenChat-$version-windows-$Arch-portable.zip"
Compress-Archive -Path (Join-Path $portableRoot '*') -DestinationPath $portableZip -CompressionLevel Optimal

$sourceSha = (git -C $repoRoot rev-parse HEAD).Trim()
$files = Get-ChildItem -Path $OutputDirectory -File | Sort-Object Name | ForEach-Object {
  [ordered]@{
    name = $_.Name
    bytes = $_.Length
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$manifest = [ordered]@{
  schema_version = 1
  release_id = "greenchat-$version-windows-$Arch"
  source_sha = $sourceSha
  version = $version
  architecture = $Arch
  signed = $true
  publisher = 'SignPath Foundation'
  timestamped = $true
  files = @($files)
}
$manifestPath = Join-Path $OutputDirectory "windows-$Arch-release.json"
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
$checksums = $files | ForEach-Object { "$($_.sha256)  $($_.name)" }
$checksums | Set-Content -LiteralPath (Join-Path $OutputDirectory "SHA256SUMS-windows-$Arch.txt") -Encoding ascii
Write-Output (ConvertTo-Json ([ordered]@{ ok = $true; version = $version; source_sha = $sourceSha; output = $OutputDirectory }) -Compress)
