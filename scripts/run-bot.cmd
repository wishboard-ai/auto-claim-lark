@echo off
rem ============================================================
rem  run-bot.cmd —— 后台运行机器人助手（供 update-and-restart.ps1 / 计划任务调用）
rem  以本文件所在目录(scripts)的上一级作为项目根，将输出追加到 logs\bot.out.log。
rem  经由 PowerShell 的 Start-Process -WindowStyle Hidden 调起，即可脱离前台常驻。
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
node "dist\src\index.js" >> "logs\bot.out.log" 2>&1
