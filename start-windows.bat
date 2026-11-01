@echo off
setlocal
cd /d "%~dp0"

rem Node and pnpm are installed after this shell may have started, so the
rem inherited PATH can be stale. winget puts Node in the machine PATH and npm
rem puts pnpm in the user PATH, so both are re-read from the registry. The two
rem directories below only matter when setup.ps1 fell back to the zip install.
set "REFRESHED="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$m=[Environment]::GetEnvironmentVariable('Path','Machine'); $u=[Environment]::GetEnvironmentVariable('Path','User'); if ($m -or $u) { $m + ';' + $u } else { $env:PATH }"`) do set "REFRESHED=%%P"
if defined REFRESHED set "PATH=%REFRESHED%"
set "PATH=%LOCALAPPDATA%\node;%APPDATA%\npm;%PATH%"

if not exist "node_modules\next\dist\bin\next" goto setup
if not exist ".next\BUILD_ID" goto setup
goto run

:run
where node >nul 2>nul
if errorlevel 1 goto nonode
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

:nonode
echo.
echo Node.js was not found on PATH.
echo Run the setup first, then try again:
echo   powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
goto end

:end
endlocal
