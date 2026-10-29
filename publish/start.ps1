# injoy - start the server and publish it on a free public URL
#
#   powershell -ExecutionPolicy Bypass -File publish\start.ps1
#
# Starts `node server/index.js` if it is not already answering, then opens a
# Cloudflare quick tunnel in front of it. No account, no card, no quota. The
# printed https URL is written to data/public-url.txt so other tools can read
# it. The URL changes every time the tunnel restarts; a named tunnel (see the
# README) keeps one forever.

[CmdletBinding()]
param(
  [int]$Port = 6967,
  [string]$Host_ = '127.0.0.1',
  [switch]$NoTunnel,
  [switch]$NoServer,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $PSScriptRoot 'bin'
$logs = Join-Path $root 'data\logs'
$exe = Join-Path $bin 'cloudflared.exe'
$tunnelLog = Join-Path $logs 'tunnel.log'
$serverOut = Join-Path $logs 'server-out.log'
$serverErr = Join-Path $logs 'server-stderr.log'
$urlFile = Join-Path $root 'data\public-url.txt'

New-Item -ItemType Directory -Force -Path $bin, $logs | Out-Null

function Get-Health {
  try {
    $res = Invoke-WebRequest -Uri "http://${Host_}:$Port/api/health" -UseBasicParsing -TimeoutSec 4
    return $res.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Stop-Listener {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($conn in $conns) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}

if ($Stop) {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Stop-Listener
  Remove-Item $urlFile -ErrorAction SilentlyContinue
  Write-Host 'stopped' -ForegroundColor Yellow
  return
}

# --- the app ---------------------------------------------------------------
if ($NoServer) {
  Write-Host 'server left alone (-NoServer)' -ForegroundColor DarkGray
} elseif (Get-Health) {
  Write-Host "server already up on port $Port" -ForegroundColor DarkGray
} else {
  Stop-Listener
  Start-Sleep -Milliseconds 500
  Start-Process -FilePath 'node' -ArgumentList 'server/index.js' `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 400
    if (Get-Health) { $ready = $true; break }
  }
  if (-not $ready) {
    Write-Host "server did not answer - see $serverErr" -ForegroundColor Red
    exit 1
  }
  Write-Host "server up on http://${Host_}:$Port" -ForegroundColor Green
}

if ($NoTunnel) { return }

# --- the tunnel ------------------------------------------------------------
if (-not (Test-Path $exe)) {
  $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Write-Host 'fetching cloudflared...' -ForegroundColor DarkGray
  Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing -TimeoutSec 600
}

# One tunnel at a time: a second quick tunnel is a second random URL.
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400
Remove-Item $tunnelLog -ErrorAction SilentlyContinue

Start-Process -FilePath $exe `
  -ArgumentList 'tunnel', '--url', "http://${Host_}:$Port", '--no-autoupdate', '--logfile', $tunnelLog, '--loglevel', 'info' `
  -WindowStyle Hidden

$public = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $tunnelLog) {
    $match = [regex]::Match((Get-Content $tunnelLog -Raw), 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($match.Success) { $public = $match.Value; break }
  }
}
if (-not $public) {
  Write-Host "tunnel did not come up - see $tunnelLog" -ForegroundColor Red
  exit 1
}

$public | Set-Content -Path $urlFile -Encoding ascii
Write-Host ''
Write-Host "  injoy is live at  $public" -ForegroundColor Cyan
Write-Host ''
