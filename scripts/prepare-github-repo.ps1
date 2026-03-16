param(
  [string]$TargetPath = "C:\Users\gfhgh\.openclaw\workspace\tmp\zenforge-repo"
)

$ErrorActionPreference = 'Stop'

$source = "C:\Users\gfhgh\.openclaw\workspace\xen-iota-move"

if (Test-Path $TargetPath) {
  Remove-Item -Recurse -Force $TargetPath
}

New-Item -ItemType Directory -Path $TargetPath | Out-Null

# Copy project files only (no parent workspace state)
robocopy $source $TargetPath /E /XD .git node_modules | Out-Null

# Initialize standalone git repository
Set-Location $TargetPath
git init | Out-Null
git branch -M main

# Ensure local identity exists for first commit in exported repo
$hasName = git config user.name
$hasEmail = git config user.email
if (-not $hasName) { git config user.name "ZenForge Local Export" }
if (-not $hasEmail) { git config user.email "zenforge-local-export@example.com" }

git add .
$commitOk = $true
try {
  git commit -m "zenforge: initial export with web/onchain preflight tooling" | Out-Null
} catch {
  $commitOk = $false
}

Write-Host "Standalone repo prepared: $TargetPath"
if ($commitOk) {
  Write-Host "Initial commit created in export repo."
} else {
  Write-Host "Initial commit not created automatically. Run 'git commit' in export repo after setting preferred identity."
}
Write-Host "Next: add remote + push (see GITHUB_PUBLISH.md)"
