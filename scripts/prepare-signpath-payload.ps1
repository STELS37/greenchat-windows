param(
  [Parameter(Mandatory = $true)][string]$BuildOutput,
  [Parameter(Mandatory = $true)][string]$RustTarget,
  [Parameter(Mandatory = $true)][ValidateSet('x64','arm64')][string]$Arch,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$catalog = Get-Content (Join-Path $repoRoot 'config/client-release.json') -Raw | ConvertFrom-Json
$version = [string]$catalog.current_version
if (-not $version) { throw 'config/client-release.json has no current_version' }

$lane = Join-Path (Resolve-Path $BuildOutput).Path $Arch
$setup = Get-ChildItem -Path $lane -File -Filter 'GreenChat-*-setup.exe' | Select-Object -First 1
$msi = Get-ChildItem -Path $lane -File -Filter 'GreenChat-*.msi' | Select-Object -First 1
$binary = Join-Path $repoRoot "clients/desktop/src-tauri/target/$RustTarget/release/green-chat-desktop.exe"
if (-not $setup) { throw "NSIS setup is absent under $lane" }
if (-not $msi) { throw "MSI is absent under $lane" }
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "desktop executable is absent: $binary" }

Remove-Item -LiteralPath $OutputDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$runtime = Join-Path $OutputDirectory 'runtime'
New-Item -ItemType Directory -Path $runtime | Out-Null

$setupName = "GreenChat-$version-windows-$Arch-setup.exe"
$msiName = "GreenChat-$version-windows-$Arch.msi"
$portableName = "GreenChat-$version-windows-$Arch-portable.exe"
Copy-Item -LiteralPath $setup.FullName -Destination (Join-Path $OutputDirectory $setupName)
Copy-Item -LiteralPath $msi.FullName -Destination (Join-Path $OutputDirectory $msiName)
Copy-Item -LiteralPath $binary -Destination (Join-Path $OutputDirectory $portableName)

$tdlibRoot = Join-Path $repoRoot 'clients/desktop/src-tauri/resources/tdlib'
foreach ($name in @('tdjson.dll','BUILD-MANIFEST.windows.txt','TDLIB_LICENSE_1_0.txt','OPENSSL_LICENSE.txt','README.md')) {
  $source = Join-Path $tdlibRoot $name
  if (Test-Path -LiteralPath $source -PathType Leaf) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $runtime $name)
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'tdjson.dll') -PathType Leaf)) {
  throw 'tdjson.dll was not staged for the portable package'
}

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
  source_sha = $sourceSha
  version = $version
  architecture = $Arch
  rust_target = $RustTarget
  signed = $false
  signable_files = @($files)
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'signpath-input.json') -Encoding utf8
Write-Output (ConvertTo-Json ([ordered]@{ ok = $true; version = $version; source_sha = $sourceSha; output = $OutputDirectory }) -Compress)
