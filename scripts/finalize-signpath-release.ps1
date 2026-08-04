param(
  [Parameter(Mandatory = $true)][string]$SignedAppDirectory,
  [Parameter(Mandatory = $true)][string]$SignedInstallerDirectory,
  [Parameter(Mandatory = $true)][string]$BundleOutput,
  [Parameter(Mandatory = $true)][ValidateSet('x64','arm64')][string]$Arch,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$catalog = Get-Content (Join-Path $repoRoot 'config/client-release.json') -Raw | ConvertFrom-Json
$version = [string]$catalog.current_version
if (-not $version) { throw 'config/client-release.json has no current_version' }

function Find-ExactFile([string]$Root, [string]$Name) {
  $resolved = (Resolve-Path $Root).Path
  $matches = @(Get-ChildItem -Path $resolved -Recurse -File | Where-Object { $_.Name -eq $Name })
  if ($matches.Count -ne 1) { throw "expected exactly one $Name under $resolved, found $($matches.Count)" }
  return $matches[0]
}

function Assert-SignPathSignature([System.IO.FileInfo]$File) {
  $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
  if ($signature.Status -ne 'Valid') { throw "$($File.Name) signature is $($signature.Status): $($signature.StatusMessage)" }
  if (-not $signature.SignerCertificate) { throw "$($File.Name) has no signer certificate" }
  if ($signature.SignerCertificate.Subject -notmatch 'SignPath Foundation') {
    throw "$($File.Name) signer is not SignPath Foundation: $($signature.SignerCertificate.Subject)"
  }
  if (-not $signature.TimeStamperCertificate) { throw "$($File.Name) has no trusted timestamp" }
  return [ordered]@{
    status = [string]$signature.Status
    subject = [string]$signature.SignerCertificate.Subject
    thumbprint = [string]$signature.SignerCertificate.Thumbprint
    timestamp_subject = [string]$signature.TimeStamperCertificate.Subject
  }
}

$app = Find-ExactFile $SignedAppDirectory "GreenChat-$version-windows-$Arch-app.exe"
$setup = Find-ExactFile $SignedInstallerDirectory "GreenChat-$version-windows-$Arch-setup.exe"
$msi = Find-ExactFile $SignedInstallerDirectory "GreenChat-$version-windows-$Arch.msi"
$appSignature = Assert-SignPathSignature $app
$setupSignature = Assert-SignPathSignature $setup
$msiSignature = Assert-SignPathSignature $msi

$bundleLane = Join-Path (Resolve-Path $BundleOutput).Path $Arch
$bundleManifestPath = Join-Path $bundleLane "windows-$Arch-release.json"
$portablePath = Join-Path $bundleLane "GreenChat-$version-windows-$Arch-portable.zip"
if (-not (Test-Path -LiteralPath $bundleManifestPath -PathType Leaf)) { throw 'bundle-stage manifest is absent' }
if (-not (Test-Path -LiteralPath $portablePath -PathType Leaf)) { throw 'portable package is absent' }
$bundleManifest = Get-Content $bundleManifestPath -Raw | ConvertFrom-Json
if ([string]$bundleManifest.source_sha -ne (git -C $repoRoot rev-parse HEAD).Trim()) { throw 'bundle source SHA mismatch' }
if ([string]$bundleManifest.build_stage -ne 'bundle') { throw 'bundle manifest has the wrong build stage' }
if ([string]$bundleManifest.authenticode.binary.Status -ne 'Valid') { throw 'bundle was not created around a signed application' }
$appHash = (Get-FileHash -LiteralPath $app.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ([string]$bundleManifest.embedded_app.sha256 -ne $appHash) { throw 'installer input app hash differs from the signed SignPath app' }

$temp = Join-Path $env:RUNNER_TEMP "greenchat-portable-verify-$Arch"
Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $portablePath -DestinationPath $temp -Force
$portableApp = Get-ChildItem -Path $temp -Recurse -File -Filter 'GreenChat.exe' | Select-Object -First 1
if (-not $portableApp) { throw 'portable ZIP contains no GreenChat.exe' }
if ((Get-FileHash -LiteralPath $portableApp.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $appHash) {
  throw 'portable GreenChat.exe differs from the signed SignPath app'
}
$portableSignature = Assert-SignPathSignature $portableApp
Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue

Remove-Item -LiteralPath $OutputDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
Copy-Item -LiteralPath $setup.FullName -Destination (Join-Path $OutputDirectory $setup.Name)
Copy-Item -LiteralPath $msi.FullName -Destination (Join-Path $OutputDirectory $msi.Name)
Copy-Item -LiteralPath $portablePath -Destination (Join-Path $OutputDirectory (Split-Path $portablePath -Leaf))

$sourceSha = (git -C $repoRoot rev-parse HEAD).Trim()
$files = Get-ChildItem -Path $OutputDirectory -File | Sort-Object Name | ForEach-Object {
  [ordered]@{
    name = $_.Name
    bytes = $_.Length
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$manifest = [ordered]@{
  schema_version = 2
  release_id = "greenchat-$version-windows-$Arch"
  source_sha = $sourceSha
  version = $version
  architecture = $Arch
  signed = $true
  publisher = 'SignPath Foundation'
  timestamped = $true
  two_stage_signing = $true
  embedded_app_sha256 = $appHash
  authenticode = [ordered]@{
    app = $appSignature
    setup = $setupSignature
    msi = $msiSignature
    portable_app = $portableSignature
  }
  files = @($files)
}
$manifestPath = Join-Path $OutputDirectory "windows-$Arch-release.json"
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8
$checksums = $files | ForEach-Object { "$($_.sha256)  $($_.name)" }
$checksums | Set-Content -LiteralPath (Join-Path $OutputDirectory "SHA256SUMS-windows-$Arch.txt") -Encoding ascii
Write-Output (ConvertTo-Json ([ordered]@{ ok = $true; version = $version; source_sha = $sourceSha; output = $OutputDirectory }) -Compress)
