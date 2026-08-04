param(
  [Parameter(Mandatory = $true)][string]$BuildOutput,
  [Parameter(Mandatory = $true)][ValidateSet('app','installers')][string]$Stage,
  [Parameter(Mandatory = $true)][ValidateSet('x64','arm64')][string]$Arch,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$catalog = Get-Content (Join-Path $repoRoot 'config/client-release.json') -Raw | ConvertFrom-Json
$version = [string]$catalog.current_version
if (-not $version) { throw 'config/client-release.json has no current_version' }

$lane = Join-Path (Resolve-Path $BuildOutput).Path $Arch
if (-not (Test-Path -LiteralPath $lane -PathType Container)) { throw "build lane is absent: $lane" }
Remove-Item -LiteralPath $OutputDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null

$expected = if ($Stage -eq 'app') {
  @("GreenChat-$version-windows-$Arch-app.exe")
} else {
  @("GreenChat-$version-windows-$Arch-setup.exe", "GreenChat-$version-windows-$Arch.msi")
}
$files = foreach ($name in $expected) {
  $source = Join-Path $lane $name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "$Stage payload file is absent: $source" }
  $destination = Join-Path $OutputDirectory $name
  Copy-Item -LiteralPath $source -Destination $destination
  $signature = Get-AuthenticodeSignature -LiteralPath $destination
  if ($signature.Status -eq 'Valid') { throw "$name is already signed before the SignPath request" }
  [ordered]@{
    name = $name
    bytes = (Get-Item -LiteralPath $destination).Length
    sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    authenticode_status = [string]$signature.Status
  }
}

$sourceSha = (git -C $repoRoot rev-parse HEAD).Trim()
$manifest = [ordered]@{
  schema_version = 2
  stage = $Stage
  source_sha = $sourceSha
  version = $version
  architecture = $Arch
  signed = $false
  files = @($files)
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory "signpath-$Stage-input.json") -Encoding utf8
Write-Output (ConvertTo-Json ([ordered]@{ ok = $true; stage = $Stage; version = $version; source_sha = $sourceSha; output = $OutputDirectory }) -Compress)
