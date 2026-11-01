@echo off
setlocal
cd /d "%~dp0"

rem setup.ps1 installs Node into %LOCALAPPDATA%\node and pnpm into %APPDATA%\npm,
rem but this cmd session keeps the PATH it started with, so both are prepended.
set "PATH=%LOCALAPPDATA%\node;%APPDATA%\npm;%PATH%"

if not exist "node_modules\next\dist\bin\next" goto setup
if not exist ".next\BUILD_ID" goto setup

:run
node scripts\mine-tui.mjs --serve %*
if errorlevel 1 pause
goto end

:setup
echo First run: installing dependencies and building. This takes a few minutes.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. Read the message above.
  pause
  goto end
)
goto run

:end
endlocal
