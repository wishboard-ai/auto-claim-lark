<#
  register-daily-update.ps1
  ------------------------------------------------------------
  注册一个 Windows 计划任务：每天 08:00 运行 update-and-restart.ps1，
  检查更新，如有更新则自动更新并重启机器人。以当前用户身份、登录时运行，无需管理员。

  用法：
    注册（默认 08:00）：
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-daily-update.ps1
    指定时间：
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-daily-update.ps1 -At 07:30
    移除：
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-daily-update.ps1 -Unregister
#>
[CmdletBinding()]
param(
  [switch]$Unregister,
  [string]$At = '08:00'
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$root = Split-Path -Parent $scriptDir
$updater = Join-Path $scriptDir 'update-and-restart.ps1'
$taskName = 'AutoClaimLark-DailyUpdate'

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "已移除计划任务：$taskName"
  } else {
    Write-Host "计划任务不存在：$taskName"
  }
  return
}

if (-not (Test-Path $updater)) { throw "找不到更新脚本：$updater" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $updater) `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Parse($At))

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "已注册计划任务：$taskName"
Write-Host "  触发：每天 $At（错过时间会在可用时补跑）"
Write-Host "  动作：$updater"
Write-Host "  行为：有更新才自动更新并后台重启；无更新则不打扰。"
Write-Host ""
Write-Host "查看： Get-ScheduledTask -TaskName $taskName ; 或  schtasks /query /tn `"$taskName`" /v /fo LIST"
Write-Host "手动跑一次： powershell -NoProfile -ExecutionPolicy Bypass -File `"$updater`""
Write-Host "移除： powershell -NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Unregister"
