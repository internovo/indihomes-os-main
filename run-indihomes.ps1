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

Write-Host 'Starting IndiHomes frontend at http://localhost:5174'
Write-Host 'Starting IndiHomes API at http://localhost:3001'
Write-Host 'Press Ctrl+C to stop both services.'

npm run start
