# injoy - ship this checkout to an always-on host and provision it there.
#
#   powershell -ExecutionPolicy Bypass -File deploy\push.ps1 -Server 123.45.67.89
#   powershell -ExecutionPolicy Bypass -File deploy\push.ps1 -Server host -User root -Key ~\.ssh\oracle
#
# Packs server/, public/, package.json and deploy/ into a tarball with Linux
# line endings, copies it to the host, and runs deploy/bootstrap.sh there as
# root. The host keeps running the site after this machine is switched off.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$User = 'ubuntu',
  [int]$Port = 22,
  [string]$Key = "$HOME\.ssh\id_ed25519",
  [switch]$NoProvision,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP ("injoy-push-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$tar = Join-Path $env:TEMP 'injoy.tar.gz'
$remoteTar = '/tmp/injoy.tar.gz'

function Assert-Exit([string]$what) {
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

if (-not (Test-Path $Key)) {
  if ($DryRun) { Write-Host "no key at $Key - dry run continues" -ForegroundColor DarkGray }
  else { throw "ssh key not found: $Key (pass -Key with the path to your key)" }
}

Write-Host "staging in $stage" -ForegroundColor DarkGray
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($entry in @('server', 'public', 'deploy')) {
  Copy-Item -Recurse -Force (Join-Path $root $entry) (Join-Path $stage $entry)
}
Copy-Item -Force (Join-Path $root 'package.json') $stage
if (Test-Path (Join-Path $root 'README.md')) {
  Copy-Item -Force (Join-Path $root 'README.md') $stage
}

# A Windows checkout can carry CRLF, and a shebang with a trailing CR is a
# silent "bad interpreter" on Linux. Normalise the scripts that run there.
$textExt = @('.sh', '.service', '.js', '.json', '.md')
Get-ChildItem -Path $stage -Recurse -File | Where-Object { $textExt -contains $_.Extension } | ForEach-Object {
  $body = [IO.File]::ReadAllText($_.FullName)
  $fixed = $body -replace "`r`n", "`n"
  if ($fixed -ne $body) { [IO.File]::WriteAllText($_.FullName, $fixed, [Text.UTF8Encoding]::new($false)) }
}

# The tunnel binary and the local library never travel: a host downloads its
# own media and keeps its own watchlist.
Remove-Item -Recurse -Force (Join-Path $stage 'deploy\bin') -ErrorAction SilentlyContinue
Remove-Item -Force $tar -ErrorAction SilentlyContinue

Push-Location $stage
try {
  & tar -czf $tar .
  Assert-Exit 'tar'
} finally {
  Pop-Location
}
$size = [math]::Round((Get-Item $tar).Length / 1MB, 1)
Write-Host "packed $size MB" -ForegroundColor DarkGray

if ($DryRun) {
  Write-Host "dry run - tarball at $tar" -ForegroundColor Yellow
  & tar -tzf $tar | Select-Object -First 25
  $crlf = 0
  Get-ChildItem -Path $stage -Recurse -File -Include *.sh, *.service | ForEach-Object {
    $bytes = [IO.File]::ReadAllBytes($_.FullName)
    if ([Array]::IndexOf($bytes, [byte]13) -ge 0) { $crlf++ }
  }
  Write-Host "scripts with CRLF: $crlf (must be 0)" -ForegroundColor $(if ($crlf) { 'Red' } else { 'Green' })
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  return
}

$sshOpts = @('-i', $Key, '-P', "$Port", '-o', 'StrictHostKeyChecking=accept-new')
Write-Host "copying to ${User}@${Server}" -ForegroundColor Cyan
& scp @sshOpts $tar "${User}@${Server}:$remoteTar"
Assert-Exit 'scp'

if ($NoProvision) {
  Write-Host "uploaded to $remoteTar - run: sudo bash /tmp/injoy/deploy/bootstrap.sh /tmp/injoy" -ForegroundColor Yellow
  Remove-Item -Recurse -Force $stage, $tar -ErrorAction SilentlyContinue
  return
}

Write-Host "provisioning (this installs node and chrome, a few minutes)" -ForegroundColor Cyan
$remote = "set -e; rm -rf /tmp/injoy; mkdir -p /tmp/injoy; tar -xzf $remoteTar -C /tmp/injoy; sudo bash /tmp/injoy/deploy/bootstrap.sh /tmp/injoy"
& ssh -i $Key -p $Port -o StrictHostKeyChecking=accept-new "${User}@${Server}" $remote
Assert-Exit 'bootstrap'

Remove-Item -Recurse -Force $stage, $tar -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "  done - the site keeps running on $Server with this machine off" -ForegroundColor Green
Write-Host ''
