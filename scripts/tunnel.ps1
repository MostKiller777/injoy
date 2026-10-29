# Share injoy on a public HTTPS URL with no account and no DNS.
#
#   .\scripts\tunnel.ps1                 # serves http://127.0.0.1:6967
#   .\scripts\tunnel.ps1 -Port 7000      # serves a different port
#   .\scripts\tunnel.ps1 -NoServer       # tunnel an already-running instance
#   .\scripts\tunnel.ps1 -NoTunnel       # start the server only
#
# The real work lives in publish\start.ps1 - this is the old entry point kept
# working. For a URL that survives reboots, publish\autostart.ps1 registers a
# logon task; for a stable hostname, see the README's Publish section.

[CmdletBinding()]
param(
    [int]$Port = 6967,
    [switch]$NoServer,
    [switch]$NoTunnel
)

$ErrorActionPreference = 'Stop'
$start = Join-Path (Split-Path -Parent $PSScriptRoot) 'publish\start.ps1'

if (-not (Test-Path $start)) { throw "missing $start" }

& $start -Port $Port -NoServer:$NoServer -NoTunnel:$NoTunnel
