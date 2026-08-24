<#
  update-and-restart.ps1
  ------------------------------------------------------------
  检查 git 远端是否有更新；如有则：git pull --ff-only -> npm install -> npm run build
  -> 停止现有机器人进程 -> 以后台方式重启（run-bot.cmd）。
  「无更新」时默认不做任何事（不打扰正在运行的实例）。

  典型用法：由 Windows 计划任务每天 08:00 隐藏调起（见 register-daily-update.ps1）。

  参数：
    -CheckOnly   只检查是否有更新并写日志，不执行更新/重启（用于测试）。
    -Force       即使没有更新也强制重启一次（确保有实例在跑）。

  日志：
    logs\update.log      本脚本的检查/更新过程
    logs\bot.out.log     机器人自身的运行输出（由 run-bot.cmd 重定向）
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$Force
)

$ErrorActionPreference = 'Continue'
# 无人值守：禁止 git 弹出交互式凭据提示，未配置凭据时直接失败而非挂起。
$env:GIT_TERMINAL_PROMPT = '0'

$scriptDir = $PSScriptRoot
$root = Split-Path -Parent $scriptDir
Set-Location $root

$logDir  = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'update.log'
$idxRel  = 'dist\src\index.js'
$idxAbs  = Join-Path $root $idxRel
# 匹配「运行本项目 dist/src/index.js 的 node 进程」的正则（兼容正/反斜杠）
$botPattern = 'dist[\\/]+src[\\/]+index\.js'

function Log([string]$msg) {
  $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  Write-Host $line
  Add-Content -Path $logFile -Value $line
}

function Resolve-Exe([string[]]$candidates, [string]$fallback) {
  foreach ($c in $candidates) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $fallback
}

$git = Resolve-Exe @('git') 'git'
$node = Resolve-Exe @('node') 'node'
$nodeDir = try { Split-Path $node -Parent } catch { $null }
$npm = if ($nodeDir -and (Test-Path (Join-Path $nodeDir 'npm.cmd'))) { Join-Path $nodeDir 'npm.cmd' } else { Resolve-Exe @('npm.cmd','npm') 'npm.cmd' }

function Stop-Bot {
  $found = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match $botPattern })
  if ($found.Count -eq 0) { Log '未发现运行中的机器人进程。'; return }
  foreach ($proc in $found) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Log ("已停止机器人进程 PID={0}" -f $proc.ProcessId)
    } catch {
      Log ("停止 PID={0} 失败：{1}" -f $proc.ProcessId, $_.Exception.Message)
    }
  }
}

function Start-Bot {
  if (-not (Test-Path $idxAbs)) { Log ("找不到 {0}，跳过启动（编译可能失败）。" -f $idxRel); return }
  $runner = Join-Path $scriptDir 'run-bot.cmd'
  if (-not (Test-Path $runner)) { Log ("找不到 {0}，无法后台启动。" -f $runner); return }
  Start-Process -FilePath $runner -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
  $p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -match $botPattern }) | Select-Object -First 1
  if ($p) { Log ("已后台启动机器人 PID={0}（日志：logs\bot.out.log）" -f $p.ProcessId) }
  else    { Log '已请求后台启动机器人（若未见 PID，请查看 logs\bot.out.log）。' }
}

function Restart-Bot {
  Log '重启机器人…'
  Stop-Bot
  Start-Sleep -Seconds 1
  Start-Bot
}

Log '==== 定时检查开始 ===='

if (-not (Test-Path (Join-Path $root '.git'))) { Log '非 git 仓库，无法检查更新，退出。'; Log '==== 结束 ===='; return }

# 1) 拉取远端信息
$fetchOut = & $git fetch --quiet 2>&1
$fetchOut | ForEach-Object { if ("$_".Trim()) { Log ("git fetch: {0}" -f $_) } }

$upstream = (& $git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
if (-not $upstream) { Log '当前分支未设置上游(tracking)，无法检查更新，退出。'; Log '==== 结束 ===='; return }

$local  = (& $git rev-parse HEAD 2>$null)
$remote = (& $git rev-parse '@{u}' 2>$null)
$base   = (& $git merge-base HEAD '@{u}' 2>$null)
if (-not ($local -and $remote -and $base)) { Log 'git 版本比较失败，退出。'; Log '==== 结束 ===='; return }
$local = $local.Trim(); $remote = $remote.Trim(); $base = $base.Trim()
$sl = $local.Substring(0,7); $sr = $remote.Substring(0,7)

if ($local -eq $remote) {
  Log ("已是最新（{0}），无需更新。" -f $sl)
  if ($Force) { Log '-Force：强制重启当前实例。'; Restart-Bot }
  Log '==== 结束 ===='; return
}
if ($local -ne $base) {
  Log ("本地与远端已分叉（存在本地提交/改动），不做自动更新。local={0} remote={1}" -f $sl, $sr)
  Log '==== 结束 ===='; return
}

Log ("发现更新：{0} -> {1}" -f $sl, $sr)
if ($CheckOnly) { Log '-CheckOnly：仅检查，不执行更新与重启。'; Log '==== 结束 ===='; return }

# 2) 更新代码
$pullOut = & $git pull --ff-only 2>&1
$pullOut | ForEach-Object { if ("$_".Trim()) { Log ("git pull: {0}" -f $_) } }
if ($LASTEXITCODE -ne 0) { Log ("git pull 失败（exit={0}），可能有本地改动/网络问题，保持现状退出。" -f $LASTEXITCODE); Log '==== 结束 ===='; return }

# 3) 依赖 + 编译
Log 'npm install …'
& $npm install 2>&1 | ForEach-Object { if ("$_".Trim()) { Log ("npm: {0}" -f $_) } }

Log 'npm run build …'
& $npm run build 2>&1 | ForEach-Object { if ("$_".Trim()) { Log ("build: {0}" -f $_) } }
if ($LASTEXITCODE -ne 0) { Log ("编译失败（exit={0}），为避免以坏代码重启，保持现有实例，退出。" -f $LASTEXITCODE); Log '==== 结束 ===='; return }

# 4) 重启
Restart-Bot
Log '==== 定时检查结束（已更新并重启） ===='
