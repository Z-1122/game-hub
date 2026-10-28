@echo off
chcp 65001 >nul
title 联机麻将启动器
cd /d "%~dp0"

echo ============================================
echo            联机麻将 启动器
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 Node.js，请先安装 https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo [1/2] 正在启动服务器...
start "麻将服务器" cmd /c "node server\server.js"
timeout /t 2 >nul

echo [2/2] 打开浏览器...
start "" "http://localhost:8787/"

echo.
echo 服务器窗口已经打开了，那里面会显示局域网地址
echo 让朋友用那个地址进来，输入房号就能一起打
echo.
echo 不玩了就把「麻将服务器」窗口关掉
echo.
pause