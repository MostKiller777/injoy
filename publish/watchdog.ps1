# injoy - keep the published URL alive while this machine is on
#
#   powershell -ExecutionPolicy Bypass -File publish\watchdog.ps1
#
# Cloudflare's quick tunnel can be reclaimed at any time ("Tunnel not found"),
# and a reaped tunnel never comes back on its own - cloudflared retries a
# registration that no longer exists. This checks the published URL and, if it
# is dead, restarts the tunnel and rewrites data\public-url.txt.
#
# publish\autostart.ps1 registers it on a ten-minute schedule.

[CmdletBinding()]
param(
  [int]$Port = 6967,
  [string]$Host_ = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$start = Join-Path $PSScriptRoot 'start.ps1'
$urlFile = Join-Path $root 'data\public-url.txt'

function Test-Url([string]$url) {
  try {
    $res = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 12
    return $res.StatusCode -eq 200
  } catch {
    return $false
  }
}

$serverUp = Test-Url "http://${Host_}:$Port/api/health"
$public = ''
if (Test-Path $urlFile) { $public = (Get-Content $urlFile -Raw).Trim() }
$publicUp = $false
if ($public) { $publicUp = Test-Url "$public/api/health" }

if ($serverUp -and $publicUp) {
  Write-Host "healthy - $public" -ForegroundColor DarkGray
  return
}

if (-not $serverUp) {
  Write-Host 'server is down - starting it and the tunnel' -ForegroundColor Yellow
  & $start -Port $Port
} else {
  Write-Host 'tunnel is dead - restarting it' -ForegroundColor Yellow
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  & $start -Port $Port -NoServer
}
