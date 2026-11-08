# Install the Conductor mesh native-messaging host for the current user (Windows).
# Usage:  powershell -ExecutionPolicy Bypass -File .\install-native-host.ps1
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostName = "ca.edgeagency.meshnode"
$manifestPath = Join-Path $dir "$hostName.json"
$manifest = @{
  name = $hostName
  description = "Edge Agency Mesh daemon for Conductor"
  path = (Join-Path $dir "native-host.bat")
  type = "stdio"
  allowed_origins = @(
    "chrome-extension://gfbfkjbimihafobafnnnbncgjepccafe/"
  )
} | ConvertTo-Json -Depth 3
Set-Content -Path $manifestPath -Value $manifest -Encoding ascii
$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $regPath -Force | Out-Null
Set-Item -Path $regPath -Value $manifestPath
Write-Host "Installed native host: $regPath -> $manifestPath"
Write-Host "Enroll this machine:  node `"$dir\daemon.mjs`" enroll --name `"$env:COMPUTERNAME`""
Write-Host "Start the node:       node `"$dir\daemon.mjs`" serve"
