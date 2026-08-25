@echo off
chcp 65001 >nul
echo ============================================
echo  FRAMEFLOW V3 - OpenCode 连接诊断
echo  目标: http://127.0.0.1:4096
echo ============================================
echo.

echo [1/6] 检查 opencode 是否已安装...
where opencode >nul 2>&1
if %errorlevel% neq 0 (
  echo   X 未找到 opencode 命令
  echo   -^> 请执行: npm install -g opencode-ai
  echo   -^> 或 pnpm add -g opencode-ai / bun add -g opencode-ai
) else (
  echo   OK 已安装
  for /f "delims=" %%v in ('opencode --version 2^>^&1') do echo      版本: %%v
)
echo.

echo [2/6] 检查 4096 端口是否被监听...
netstat -ano | findstr "127.0.0.1:4096" | findstr "LISTENING"
if %errorlevel% neq 0 (
  echo   X 4096 端口未监听 - OpenCode Server 没跑起来！
  echo   -^> 这就是截图里"All connection attempts failed"的原因
) else (
  echo   OK 端口正在监听
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:4096" ^| findstr "LISTENING"') do echo      PID: %%p
)
echo.

echo [3/6] 测试 /global/health 端点...
powershell -NoProfile -Command "try { $r=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:4096/global/health' -TimeoutSec 5; Write-Host ('  OK healthy=' + $r.healthy + ' version=' + $r.version) -ForegroundColor Green; $r | ConvertTo-Json -Depth 5 } catch { Write-Host ('  X 请求失败: ' + $_.Exception.Message) -ForegroundColor Red; Write-Host '     提示: 若刚启动请等 3-5 秒再试'; exit 1 }"
echo.

echo [4/6] 测试 /provider 端点 (需要 health 通过)...
powershell -NoProfile -Command "try { $r=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:4096/provider' -TimeoutSec 5; $c=$r.connected; if($null -eq $c){$c=@()}; Write-Host ('  OK 已连接 provider 数: ' + $c.Count) -ForegroundColor Green; if($c.Count -gt 0){ Write-Host ('     已连接: ' + ($c -join ', ')) } else { Write-Host '     警告: 没有已连接的 provider，请在 opencode 里完成登录/授权' -ForegroundColor Yellow }; Write-Host ('  全部 provider 数: ' + $r.all.Count) } catch { Write-Host ('  X 请求失败: ' + $_.Exception.Message) -ForegroundColor Red }"
echo.

echo [5/6] 检查环境变量 OPENCODE_SERVER_PASSWORD...
if defined OPENCODE_SERVER_PASSWORD (
  echo   已设置 (长度 %OPENCODE_SERVER_PASSWORD:~0,3%***)
  echo   -^> 若设置了密码，FrameFlow 设置页的"Server 密码"必须填同一个值
  echo   -^> 用户名固定为 opencode
) else (
  echo   未设置 (无 Basic Auth，正常)
  echo   -^> 若 FrameFlow 里填了密码但这里没设，会导致 401
)
echo.

echo [6/6] 检查 FrameFlow 自身是否运行 (8787)...
powershell -NoProfile -Command "try { $d=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/system/doctor' -TimeoutSec 3; Write-Host '  OK FrameFlow 运行中' -ForegroundColor Green } catch { Write-Host '  X FrameFlow 未响应 (8787)' -ForegroundColor Red }"
echo.

echo ============================================
echo  快速修复命令 (复制到 PowerShell 执行):
echo.
echo    opencode serve --hostname 127.0.0.1 --port 4096
echo.
echo  如需后台常驻, 另开一个终端窗口保持运行，
echo  再回到 FrameFlow: 设置 -^> Provider -^> OpenCode Agent -^> 连接检测
echo ============================================
echo.
pause
