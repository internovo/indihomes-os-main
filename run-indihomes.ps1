$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not installed. Install Node.js 20+ and run this script again.'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm is not available. Reinstall Node.js with npm enabled and run this script again.'
}

if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
  Write-Host 'Installing project dependencies...'
  npm install
}

# Launch the Python AI Search agent through its supervisor (restarts it
# automatically if it crashes; does nothing if one's already running) in
# the background, non-blocking - npm run start below still owns the
# foreground. Skipped, with an explanation, if agent\.venv isn't set up
# yet - AI Search still works via the Places-direct/Node connector
# fallback in that case, just without the agent's deep-research pipeline.
$agentVenvPython = Join-Path $ProjectRoot 'agent\.venv\Scripts\python.exe'
if (Test-Path $agentVenvPython) {
  Write-Host 'Starting IndiHomes AI Search agent at http://localhost:8008 (auto-restart supervisor)'
  Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoLogo', '-NoProfile', '-File', (Join-Path $ProjectRoot 'backend\scripts\run-agent.ps1') -WindowStyle Minimized
} else {
  Write-Host 'Skipping the AI Search agent (agent\.venv not set up yet - see agent/README.md). AI Search will use the Places-direct/Node fallback instead.'
}

Write-Host 'Starting IndiHomes frontend at http://localhost:5174'
Write-Host 'Starting IndiHomes API at http://localhost:3001'
Write-Host 'Press Ctrl+C to stop both services.'

npm run start
