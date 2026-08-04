[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [Parameter(Mandatory = $true)]
  [string]$EvidencePath
)

$ErrorActionPreference = 'Stop'

$resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
$evidenceParent = Split-Path -Parent $EvidencePath
if ($evidenceParent) {
  New-Item -ItemType Directory -Path $evidenceParent -Force | Out-Null
}

$platformRoot = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
$mpCmdRun = $null
if (Test-Path -LiteralPath $platformRoot -PathType Container) {
  $mpCmdRun = Get-ChildItem -LiteralPath $platformRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'MpCmdRun.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
}
if (-not $mpCmdRun) {
  $fallback = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
  if (Test-Path -LiteralPath $fallback -PathType Leaf) {
    $mpCmdRun = $fallback
  }
}
if (-not $mpCmdRun) {
  throw 'Microsoft Defender MpCmdRun.exe is unavailable; malware scan fails closed.'
}

$status = $null
$signatureUpdate = 'not_attempted'
try {
  if (Get-Command Update-MpSignature -ErrorAction SilentlyContinue) {
    Update-MpSignature -ErrorAction Stop
    $signatureUpdate = 'success'
  }
} catch {
  $signatureUpdate = "failed: $($_.Exception.Message)"
  Write-Warning "Microsoft Defender signature update failed; validating the installed definitions instead."
}
try {
  if (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue) {
    $status = Get-MpComputerStatus -ErrorAction Stop
  }
} catch {
  Write-Warning "Microsoft Defender status query failed; MpCmdRun will remain the scan authority."
}

$signatureAgeDays = $null
if ($status -and $status.AntivirusSignatureLastUpdated) {
  $signatureAgeDays = ((Get-Date) - [datetime]$status.AntivirusSignatureLastUpdated).TotalDays
  if ($signatureAgeDays -gt 14) {
    throw "Microsoft Defender signatures are stale ($([math]::Round($signatureAgeDays, 2)) days)."
  }
}

Write-Host "Scanning with Microsoft Defender: $resolved"
$scanOutput = @(& $mpCmdRun -Scan -ScanType 3 -File $resolved -DisableRemediation 2>&1)
$scanExitCode = $LASTEXITCODE
$scanOutput | ForEach-Object { Write-Host $_ }

$files = if (Test-Path -LiteralPath $resolved -PathType Leaf) {
  @(Get-Item -LiteralPath $resolved)
} else {
  @(Get-ChildItem -LiteralPath $resolved -Recurse -File | Sort-Object FullName)
}
$fileEvidence = @($files | ForEach-Object {
  $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
  [ordered]@{
    path = $_.FullName
    size = $_.Length
    sha256 = $hash.Hash.ToLowerInvariant()
  }
})

$evidence = [ordered]@{
  schema_version = 1
  scanned_at_utc = [datetime]::UtcNow.ToString('o')
  scanner = 'Microsoft Defender Antivirus MpCmdRun'
  scanner_path = $mpCmdRun
  scan_type = 'custom'
  remediation_disabled = $true
  scanned_path = $resolved
  scan_exit_code = $scanExitCode
  signature_update = $signatureUpdate
  antivirus_enabled = if ($status) { [bool]$status.AntivirusEnabled } else { $null }
  real_time_protection_enabled = if ($status) { [bool]$status.RealTimeProtectionEnabled } else { $null }
  signature_version = if ($status) { [string]$status.AntivirusSignatureVersion } else { $null }
  signature_last_updated = if ($status -and $status.AntivirusSignatureLastUpdated) { ([datetime]$status.AntivirusSignatureLastUpdated).ToUniversalTime().ToString('o') } else { $null }
  signature_age_days = if ($null -ne $signatureAgeDays) { [math]::Round($signatureAgeDays, 4) } else { $null }
  files = $fileEvidence
  output = @($scanOutput | ForEach-Object { [string]$_ })
}
$evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding utf8NoBOM

if ($scanExitCode -ne 0) {
  throw "Microsoft Defender custom scan failed or found an unremediated threat (exit code $scanExitCode)."
}

Write-Host "MICROSOFT-DEFENDER: CLEAN evidence=$EvidencePath"
