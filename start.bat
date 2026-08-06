@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo    Feishu Invoice Reimbursement Bot
echo ============================================
echo.

rem 每次启动检查更新（git pull + 依赖 + 编译）。设 SKIP_UPDATE=1 可跳过。
if not "%SKIP_UPDATE%"=="1" (
  where git >nul 2>nul
  if not errorlevel 1 (
    if exist ".git" (
      echo [Update] git pull --ff-only ...
      git pull --ff-only || echo [Update] Skipped ^(offline / local changes / non-fast-forward^), using current code.
    )
  )
)

if not "%SKIP_UPDATE%"=="1" (
  echo [1/3] Installing/updating dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Please check Node.js and network.
    pause
    exit /b 1
  )
) else (
  if not exist "node_modules" (
    echo [1/3] Installing dependencies for the first run...
    call npm install
  ) else (
    echo [1/3] Dependencies ready.
  )
)

if not exist ".env" (
  echo.
  echo [ERROR] Config file .env not found.
  echo         Copy .env.example to .env and fill in the values first.
  pause
  exit /b 1
)

echo [2/3] Building TypeScript...
call npm run build
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. See the messages above.
  pause
  exit /b 1
)

echo [3/3] Starting bot. Keep this window open to stay online.
echo        Press Ctrl+C or close the window to stop.
echo.
node dist\src\index.js

echo.
echo Bot stopped. If this was not intentional, check the logs above.
pause
