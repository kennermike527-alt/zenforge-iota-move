param(
  [string]$RepoPath = "C:\Users\gfhgh\.openclaw\workspace\tmp\zenforge-repo",
  [string]$RemoteUrl = "https://github.com/kennermike527-alt/zenforge-iota-move.git"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $RepoPath)) {
  throw "Repo path not found: $RepoPath"
}

Set-Location $RepoPath

$hasOrigin = git remote 2>$null | Select-String '^origin$'
if ($hasOrigin) {
  git remote set-url origin $RemoteUrl
} else {
  git remote add origin $RemoteUrl
}

git push -u origin main

Write-Host "Push complete: $RemoteUrl"
