$ErrorActionPreference = 'Stop'

# Boring supervisor for the Python AI Search agent (agent/app.py) - no new
# framework/dependency, just a while-loop that restarts the process if it
# exits. Built because the agent has crashed from port conflicts repeatedly
# throughout this project's history, nothing ever restarted it, and AI
# Search silently fell back to a worse pipeline with no visible signal.
#
# Run directly:
#   backend\scripts\run-agent.ps1
# run-indihomes.ps1 launches this automatically alongside the frontend/backend.

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AgentDir = Join-Path $RepoRoot 'agent'
$Python = Join-Path $AgentDir '.venv\Scripts\python.exe'
$AppPath = Join-Path $AgentDir 'app.py'
$Port = if ($env:AGENT_PORT) { [int]$env:AGENT_PORT } else { 8008 }
$MinRestartIntervalSec = 5

if (-not (Test-Path $Python)) {
  throw "Agent virtualenv not found at $Python. Set it up first (see agent/README.md)."
}

# The actual recurring failure mode in this project: an old agent instance
# never died, and a fresh one then failed to start with "port already in
# use". Checking first and doing nothing is simpler and safer than trying
# to find and kill whatever's listening.
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "[run-agent] Something is already listening on port $Port - assuming the agent is already running. Doing nothing."
  exit 0
}

Set-Location $AgentDir
Write-Host "[run-agent] Starting agent (python app.py) on port $Port, restarting automatically if it exits..."
while ($true) {
  $start = Get-Date
  & $Python $AppPath
  $exitCode = $LASTEXITCODE
  $elapsed = (Get-Date) - $start
  Write-Host "[run-agent] Agent process exited (code $exitCode) after $([math]::Round($elapsed.TotalSeconds, 1))s."
  if ($elapsed.TotalSeconds -lt $MinRestartIntervalSec) {
    $wait = $MinRestartIntervalSec - $elapsed.TotalSeconds
    Write-Host "[run-agent] Exited too quickly - waiting $([math]::Round($wait, 1))s before restarting (backoff, avoids a tight crash loop)."
    Start-Sleep -Seconds $wait
  }
  Write-Host "[run-agent] Restarting agent..."
}
