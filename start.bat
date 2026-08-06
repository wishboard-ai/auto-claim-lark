@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
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

rem ---------- 本地 Ollama 自动准备（仅当 .env 指向本地 Ollama 时） ----------
findstr /i "localhost:11434 127.0.0.1:11434" .env >nul 2>nul
if not errorlevel 1 (
  echo [Ollama] .env uses local Ollama, checking runtime and models...
  where ollama >nul 2>nul
  if errorlevel 1 (
    where winget >nul 2>nul
    if not errorlevel 1 (
      echo [Ollama] Installing via winget...
      winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements || echo [Ollama] winget install failed.
    ) else (
      echo [Ollama] Not installed. Please install from https://ollama.com/download and re-run.
    )
  )
  where ollama >nul 2>nul
  if not errorlevel 1 (
    rem 拉起服务
    curl -s -o nul http://localhost:11434/api/tags 2>nul
    if errorlevel 1 (
      echo [Ollama] Starting service...
      start "" /b ollama serve >nul 2>nul
      timeout /t 3 >nul
    )
    rem 解析并拉取所需模型
    set "OCR_PROVIDER_V=openai"
    call :getenv OCR_PROVIDER
    if defined ENVVAL set "OCR_PROVIDER_V=!ENVVAL!"
    if /i not "!OCR_PROVIDER_V!"=="paddle" (
      call :getenv OCR_MODEL
      if defined ENVVAL call :ensuremodel "!ENVVAL!"
    )
    call :getenv LLM_MODEL
    if defined ENVVAL call :ensuremodel "!ENVVAL!"
  )
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
exit /b 0

rem ===== 子程序 =====
:getenv
rem 读取 .env 中 %1 的值到 ENVVAL（去行内注释与首尾空格）
set "ENVVAL="
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b /c:"%~1=" .env 2^>nul`) do set "ENVVAL=%%B"
if not defined ENVVAL goto :eof
for /f "tokens=1 delims=#" %%C in ("!ENVVAL!") do set "ENVVAL=%%C"
:trimend
if defined ENVVAL if "!ENVVAL:~-1!"==" " set "ENVVAL=!ENVVAL:~0,-1!" & goto trimend
goto :eof

:ensuremodel
rem %1 = 模型名（带引号）
set "MODEL=%~1"
if "%MODEL%"=="" goto :eof
ollama list 2>nul | findstr /i /c:"%MODEL%" >nul 2>nul
if errorlevel 1 (
  echo [Ollama] Pulling model: %MODEL% ^(first time is slow^)...
  ollama pull "%MODEL%" || echo [Ollama] Pull failed: %MODEL%. You can run: ollama pull %MODEL%
) else (
  echo [Ollama] Model ready: %MODEL%
)
goto :eof
