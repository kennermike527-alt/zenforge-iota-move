param(
  [switch]$SkipMoveTest
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location (Split-Path -Parent $root) # workspace root

Write-Host "[1/4] Build web data"
node xen-iota-move/scripts/build-web-data.mjs

Write-Host "[2/4] Web smoke checks"
node xen-iota-move/scripts/check-web-smoke.mjs

Write-Host "[3/4] On-chain protocol checks"
node xen-iota-move/scripts/check-onchain-state.mjs

if (-not $SkipMoveTest) {
  Write-Host "[4/4] Move tests"
  & C:\Users\gfhgh\.openclaw\workspace\tools\iota\iota.exe move test --skip-fetch-latest-git-deps --path xen-iota-move/move/xen
} else {
  Write-Host "[4/4] Move tests skipped"
}

Write-Host "Preflight PASS"
