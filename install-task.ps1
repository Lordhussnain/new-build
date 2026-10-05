# Registers (or removes) "YouTubeArchiveEngine" as a logon scheduled task so
# the downloader starts automatically when you sign in to Windows 11.
#
# Install:   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
# Uninstall: powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Uninstall
#
# Notes:
#  - The task runs start-archive.bat from this folder (keeps the correct
#    working directory so config.json / archive.db / downloads are found).
#  - A console window may flash briefly at logon; for a fully hidden run,
#    open Task Scheduler -> YouTubeArchiveEngine -> General ->
#    "Run whether user is logged on or not".

param([switch]$Uninstall)

$taskName = "YouTubeArchiveEngine"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath = Join-Path $scriptDir "start-archive.bat"

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    if ($?) { Write-Host "Removed scheduled task '$taskName'." }
    else    { Write-Host "Task '$taskName' was not registered." }
    exit 0
}

if (-not (Test-Path $batPath)) {
    Write-Error "start-archive.bat not found next to install-task.ps1 ($scriptDir)."
    exit 1
}

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$batPath`"" -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Scheduled task '$taskName' registered - it will start with your next sign-in."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName '$taskName'"
