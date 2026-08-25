@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "TASK_NAME=FRAMEFLOW-V3-Service"
set "FORMAL_ROOT=%~dp0"
set "FORMAL_DATABASE=%FORMAL_ROOT%data\frameflow.db"

echo FRAMEFLOW V3 formal launcher
echo Official entrypoint: %TASK_NAME%
echo.

:: ── OpenCode Server 自启动（新增） ──────────────────────────
:: 逻辑：若 4096 已监听则复用；否则后台拉起 opencode serve，保持最小化窗口常驻
echo [OpenCode] 检查 127.0.0.1:4096 ...

where opencode >nul 2>&1
if errorlevel 1 (
  echo [OpenCode] 未安装 opencode-ai，跳过自启动。
  echo           请执行 npm install -g opencode-ai 后重试。
) else (
  set "OC_PID="
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr "127.0.0.1:4096" ^| findstr "LISTENING" 2^>nul') do set "OC_PID=%%P"
  if defined OC_PID (
    echo [OpenCode] 已在运行，PID !OC_PID!，复用现有服务。
  ) else (
    echo [OpenCode] 未运行，正在后台启动 opencode serve --hostname 127.0.0.1 --port 4096 ...
    if not exist "%FORMAL_ROOT%data\logs" mkdir "%FORMAL_ROOT%data\logs" >nul 2>&1
    :: 以最小化窗口后台常驻，日志写入 data/logs/opencode.log，关闭本窗口不影响它
    start "FRAMEFLOW-OpenCode" /MIN cmd /c "opencode serve --hostname 127.0.0.1 --port 4096 > "%FORMAL_ROOT%data\logs\opencode.log" 2>&1"
    :: 等待最多 10 秒，轮询 /global/health
    set "OC_OK="
    for /L %%I in (1,1,10) do (
      timeout /t 1 /nobreak >nul
      for /f "delims=" %%R in ('powershell -NoProfile -Command "try { $r=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:4096/global/health' -TimeoutSec 2; if ($r.healthy) { 'OK' } else { 'WAIT' } } catch { 'WAIT' }" 2^>nul') do set "OC_OK=%%R"
      if /I "!OC_OK!"=="OK" goto :oc_ready
    )
    echo [OpenCode] 警告：10 秒内未通过健康检查，请查看 %FORMAL_ROOT%data\logs\opencode.log
    echo           你仍可手动执行: opencode serve --hostname 127.0.0.1 --port 4096
    goto :oc_done
    :oc_ready
    echo [OpenCode] 启动成功，健康检查通过。
    :oc_done
  )
)
echo.

set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "127.0.0.1:8787" ^| findstr "LISTENING"') do set "PORT_PID=%%P"

if defined PORT_PID (
  set "IDENTITY_RESULT="
  for /f "delims=" %%R in ('powershell -NoProfile -Command "$d=$null; try {$d=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/system/doctor' -TimeoutSec 3} catch {}; if ($d -and $d.frontend_dist -like ('%FORMAL_ROOT%web\dist*') -and $d.database -eq ('%FORMAL_ROOT%data\frameflow.db')) { 'FORMAL' } else { 'NONFORMAL' }" 2^>nul') do set "IDENTITY_RESULT=%%R"
  if /I "!IDENTITY_RESULT!"=="FORMAL" (
    echo FRAMEFLOW already running on 8787; PID !PORT_PID!.
    echo No second server will be started.
    exit /b 0
  )
  echo PORT 8787 IS OCCUPIED BY NON-FORMAL FRAMEFLOW INSTANCE.
  echo Refusing to stop or replace the existing owner.
  exit /b 2
)

echo 8787 FREE. Starting %TASK_NAME%.
schtasks /Run /TN "%TASK_NAME%" >nul
if errorlevel 1 (
  echo [ERROR] Could not run %TASK_NAME%.
  exit /b 3
)

for /L %%N in (1,1,30) do (
  timeout /t 1 /nobreak >nul
  set "IDENTITY_RESULT="
  for /f "delims=" %%R in ('powershell -NoProfile -Command "$d=$null; try {$d=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/system/doctor' -TimeoutSec 3} catch {}; if ($d -and $d.frontend_dist -like ('%FORMAL_ROOT%web\dist*') -and $d.database -eq ('%FORMAL_ROOT%data\frameflow.db')) { 'FORMAL' } else { 'WAIT' }" 2^>nul') do set "IDENTITY_RESULT=%%R"
  if /I "!IDENTITY_RESULT!"=="FORMAL" goto :formal_ready
)

echo [ERROR] %TASK_NAME% did not expose the formal runtime within 30 seconds.
exit /b 4

:formal_ready
echo Formal FRAMEFLOW runtime is ready on 8787.
exit /b 0
