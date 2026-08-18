# Registers a Windows Scheduled Task that keeps the LIVE web app fresh by
# scraping locally (this machine's IP isn't blocked) and publishing to Railway.
#
# Prereqs (one time):
#   - Local backend running:   npm run server        (port 3001)
#   - Logged into Railway CLI:  npx @railway/cli login   and   railway link
#   - git push works without a prompt (credential helper cached)
#
# Usage (from repo root, in an elevated PowerShell):
#   powershell -ExecutionPolicy Bypass -File backend\scripts\register-refresh-task.ps1
#   powershell -ExecutionPolicy Bypass -File backend\scripts\register-refresh-task.ps1 -IntervalHours 12
#   powershell -ExecutionPolicy Bypass -File backend\scripts\register-refresh-task.ps1 -Remove

param(
  [int]$IntervalHours = 6,
  [switch]$Remove
)

$TaskName = "IndiHomes-RefreshAndPublish"
# This script now lives at <repo-root>\backend\scripts\, two levels below the
# repo root (it used to be one level below, at <repo-root>\scripts\), so we
# go up two levels to land on the same true repo root as before.
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$NodeExe  = (Get-Command node).Source
$Script   = Join-Path $PSScriptRoot "refresh-and-publish.mjs"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Yellow
  return
}

$action  = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$Script`"" -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
             -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
             -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Scrape 99acres/MagicBricks locally and publish to the live IndiHomes web app" `
  -Force | Out-Null

Write-Host "Registered '$TaskName' — runs every $IntervalHours h." -ForegroundColor Green
Write-Host "It scrapes locally and pushes fresh data to the live site automatically." -ForegroundColor Green
Write-Host "Remove later with:  powershell -ExecutionPolicy Bypass -File scripts\register-refresh-task.ps1 -Remove"
