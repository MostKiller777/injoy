# injoy - keep the site published across reboots
#
#   powershell -ExecutionPolicy Bypass -File publish\autostart.ps1
#   powershell -ExecutionPolicy Bypass -File publish\autostart.ps1 -Remove
#
# Registers a per-user scheduled task that runs publish\start.ps1 at logon and
# again five minutes later if it ever dies. No elevation needed, nothing runs
# as SYSTEM, and the task lives entirely on this machine - free, forever, and
# gone the moment you remove it.

[CmdletBinding()]
param(
  [switch]$Remove,
  [string]$TaskName = 'injoy'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$start = Join-Path $PSScriptRoot 'start.ps1'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "$TaskName-watch" -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed scheduled tasks '$TaskName' and '$TaskName-watch'" -ForegroundColor Yellow
  return
}

if (-not (Test-Path $start)) { throw "missing $start" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`"" `
  -WorkingDirectory $root

# A bare username is rejected by the task scheduler; it wants DOMAIN\user.
$account = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'injoy - serve and publish on a free tunnel' `
  -Force | Out-Null

Write-Host "registered '$TaskName' - injoy starts at every logon" -ForegroundColor Green

# --- the watchdog ----------------------------------------------------------
# A quick tunnel can be reclaimed at any moment and never re-registers itself,
# so a second task pokes the published URL every ten minutes and rebuilds it.
$watch = Join-Path $PSScriptRoot 'watchdog.ps1'
$watchAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watch`"" `
  -WorkingDirectory $root
$watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 10) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$watchSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "$TaskName-watch" -Action $watchAction -Trigger $watchTrigger `
  -Principal $principal -Settings $watchSettings `
  -Description 'injoy - restart the tunnel if the published URL dies' `
  -Force | Out-Null

Write-Host "registered '$TaskName-watch' - checks the URL every ten minutes" -ForegroundColor Green
Write-Host 'run publish\start.ps1 now to publish without waiting for a logon' -ForegroundColor DarkGray
