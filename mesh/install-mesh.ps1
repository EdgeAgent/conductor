# Conductor Mesh — one-command install (Windows)
# Downloads the Agent Mesh daemon (the engine behind Conductor Mesh Mode),
# registers the Chrome Native Messaging host, and enrolls this machine.
# Usage:  powershell -ExecutionPolicy Bypass -File .\install-mesh.ps1
$ErrorActionPreference = "Stop"
$zipUrl = "https://github.com/EdgeAgent/conductor/releases/download/mesh-v1.0.0/conductor-mesh-v1.0.0.zip"
$dest = Join-Path $env:LOCALAPPDATA "ConductorMesh"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 18+ is required: https://nodejs.org" }
if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) { Write-Warning "OpenSSL not found on PATH — certificate issuance needs it (Git for Windows ships one). Continuing; enroll may fail." }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$zip = Join-Path $env:TEMP "agent-mesh-v1.0.0.zip"
Invoke-WebRequest -Uri $zipUrl -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $dest -Force
Remove-Item $zip

& (Join-Path $dest "install-native-host.ps1")
node (Join-Path $dest "daemon.mjs") enroll --name $env:COMPUTERNAME
Write-Host ""
Write-Host "Mesh engine installed in $dest"
Write-Host "Start this machine's node:  node `"$dest\daemon.mjs`" serve"
Write-Host "Then install Conductor from the Chrome Web Store and open its Mesh tab."
