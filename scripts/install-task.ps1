# Registers a Windows Scheduled Task that starts the watchdog (and so AgentControl) when you log on.
#   .\scripts\install-task.ps1            install / replace
#   .\scripts\install-task.ps1 -Remove    remove
param([switch]$Remove)

$name = 'AgentControl'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Task '$name' removed."
  return
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\scripts\watchdog.js`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'AgentControl server with restart watchdog' -Force | Out-Null
Write-Host "Task '$name' installed: it starts at logon. Start it now with: Start-ScheduledTask -TaskName $name"
