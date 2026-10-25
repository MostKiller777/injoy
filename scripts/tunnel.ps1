# Share injoy on a public HTTPS URL with no account and no DNS.
#
#   .\scripts\tunnel.ps1                 # serves http://127.0.0.1:6967
#   .\scripts\tunnel.ps1 -Port 7000      # serves a different port
#   .\scripts\tunnel.ps1 -NoServer       # tunnel an already-running instance
#
# Cloudflare's quick tunnel is ephemeral: the URL lives as long as this process
# does, and a new one is issued next run. For a permanent hostname use the
# Docker path in the README.

param(
    [int]$Port = 6967,
    [string]$Bind = '127.0.0.1',
    [switch]$NoServer
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $env:LOCALAPPDATA 'injoy'
$exe = Join-Path $tools 'cloudflared.exe'

if (-not (Test-Path $exe)) {
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    Write-Host "fetching cloudflared..."
    curl.exe -L --fail --silent --show-error --max-time 300 `
        -o $exe 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    if ($LASTEXITCODE -ne 0) { throw "cloudflared download failed ($LASTEXITCODE)" }
}

if (-not $NoServer) {
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $listening) {
        Write-Host "starting injoy on ${Bind}:${Port}..."
        Start-Process -FilePath node -ArgumentList 'server/index.js' `
            -WorkingDirectory $root -WindowStyle Hidden `
            -Environment @{ PORT = "$Port"; HOST = $Bind }
        Start-Sleep -Seconds 2
    }
    $health = try { (Invoke-RestMethod -Uri "http://${Bind}:${Port}/api/health" -TimeoutSec 10).ok } catch { $false }
    if (-not $health) { throw "injoy is not answering on http://${Bind}:${Port}" }
}

Write-Host "opening tunnel - the public URL prints below, keep this window open"
& $exe tunnel --url "http://${Bind}:${Port}" --no-autoupdate
