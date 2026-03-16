param(
  [string]$IotaExe = "C:\Users\gfhgh\.openclaw\workspace\tools\iota\iota.exe",
  [string]$PackageDir = "C:\Users\gfhgh\.openclaw\workspace\xen-iota-move\move\xen",
  [string]$ClockId = "0x6",
  [int]$GasBudget = 200000000,
  [int]$ClaimTermDays = 7,
  [string]$PackageId = "",
  [string]$ProtocolId = ""
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-IotaJson {
  param(
    [string[]]$CmdArgs,
    [string]$Workdir = ""
  )

  if ($Workdir) {
    Push-Location $Workdir
  }

  try {
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()

    $proc = Start-Process -FilePath $IotaExe -ArgumentList $CmdArgs -Wait -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile

    $stdout = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
    $stderr = Get-Content $errFile -Raw -ErrorAction SilentlyContinue

    Remove-Item $outFile,$errFile -Force -ErrorAction SilentlyContinue

    $combined = ($stdout + "`n" + $stderr).Trim()
    if (-not $combined) {
      throw "No output from iota command: $($CmdArgs -join ' ')"
    }

    $m = [regex]::Match($combined, '(?s)(\{.*\})')
    if (-not $m.Success) {
      throw "Could not parse JSON from output for: $($CmdArgs -join ' ')`n$combined"
    }

    return ($m.Groups[1].Value | ConvertFrom-Json)
  }
  finally {
    if ($Workdir) { Pop-Location }
  }
}

Write-Host "[xen] Switching to testnet..."
& $IotaExe client switch --env testnet --json 2>$null | Out-Null

if (-not $PackageId -or -not $ProtocolId) {
  Write-Host "[xen] Publishing package to testnet..."
  Remove-Item (Join-Path $PackageDir 'Move.lock') -Force -ErrorAction SilentlyContinue

  $publish = Invoke-IotaJson -CmdArgs @("client","publish","--skip-fetch-latest-git-deps","--gas-budget",$GasBudget,"--json") -Workdir $PackageDir

  $published = $publish.objectChanges | Where-Object { $_.type -eq 'published' } | Select-Object -First 1
  $pkg = $published.packageId
  if (-not $pkg) { throw "Could not parse packageId from publish output" }

  $protocol = $publish.objectChanges | Where-Object { $_.objectType -eq "$pkg::xen::Protocol" } | Select-Object -First 1
  if (-not $protocol) { throw "Could not parse Protocol object from publish output" }

  $PackageId = $pkg
  $ProtocolId = $protocol.objectId

  Write-Host "[xen] Publish digest: $($publish.digest)"
  Write-Host "[xen] Package ID:   $PackageId"
  Write-Host "[xen] Protocol ID:  $ProtocolId"
}

Write-Host "[xen] Running claim_rank(term=$ClaimTermDays)..."
$claim = Invoke-IotaJson -CmdArgs @(
  "client","call","--json",
  "--package",$PackageId,
  "--module","xen",
  "--function","claim_rank",
  "--args",$ProtocolId,$ClockId,$ClaimTermDays,
  "--gas-budget",$GasBudget
)

$receipt = $claim.objectChanges | Where-Object { $_.objectType -eq "$PackageId::xen::MintReceipt" } | Select-Object -First 1

Write-Host "[xen] claim tx digest: $($claim.digest)"
if ($receipt) {
  Write-Host "[xen] MintReceipt ID:  $($receipt.objectId)"
} else {
  Write-Host "[xen] MintReceipt ID:  (not found in objectChanges)"
}

Write-Host ""
Write-Host "=== RESULT ==="
Write-Host "Package ID : $PackageId"
Write-Host "Protocol ID: $ProtocolId"
Write-Host "Claim Tx   : $($claim.digest)"
if ($receipt) { Write-Host "Receipt ID : $($receipt.objectId)" }
