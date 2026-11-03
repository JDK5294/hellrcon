@echo off
REM Install the panel on a Windows PC: double-click this file.
REM
REM It checks for the two programs the panel needs, Git and Docker Desktop, and offers to install
REM each one that is missing, or to open its download page. Then it gets the code into
REM %USERPROFILE%\hellrcon and hands over to start.bat, which starts everything and opens the
REM panel's setup page. Run start.bat from that folder afterwards to start or update the panel.
setlocal EnableExtensions
title Install the panel
set "REPO_URL=https://github.com/JDK5294/hellrcon.git"
set "REPO_BRANCH=main"
set "DIR=%USERPROFILE%\hellrcon"
if defined HELLRCON_REPO set "REPO_URL=%HELLRCON_REPO%"
if defined HELLRCON_BRANCH set "REPO_BRANCH=%HELLRCON_BRANCH%"
if defined HELLRCON_DIR set "DIR=%HELLRCON_DIR%"

echo ============================================
echo   Installing the panel
echo ============================================
echo.
echo   Two programs are needed: Git, which fetches the code and its updates, and Docker
echo   Desktop, which runs the panel. These are the ones recommended for Windows; other
echo   options (GitHub Desktop, Rancher Desktop, ...) work too if you already use them.
echo.

set "HAVE_WINGET="
where winget >nul 2>nul
if not errorlevel 1 set "HAVE_WINGET=1"

REM ---- Git ----
where git >nul 2>nul
if not errorlevel 1 goto git_ok
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%PATH%;%ProgramFiles%\Git\cmd" & goto git_ok
echo [!] Git is not installed.
set "WHAT=Git"
set "WINGET_ID=Git.Git"
set "PAGE=https://git-scm.com/download/win"
call :offer
if errorlevel 2 goto stopped
REM A fresh install is not on this window's PATH yet.
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
where git >nul 2>nul
if errorlevel 1 goto rerun
:git_ok
echo [OK] Git is installed.

REM ---- Docker Desktop ----
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" goto docker_ok
where docker >nul 2>nul
if not errorlevel 1 goto docker_ok
echo [!] Docker Desktop is not installed.
set "WHAT=Docker Desktop"
set "WINGET_ID=Docker.DockerDesktop"
set "PAGE=https://www.docker.com/products/docker-desktop/"
call :offer
if errorlevel 2 goto stopped
if not exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" goto rerun
echo.
echo [i] Docker Desktop is installed. If Windows asks you to restart, restart, then run
echo     install.bat again. The first time Docker Desktop opens it asks you to accept its terms.
:docker_ok
REM A fresh install is not on this window's PATH yet either, and start.bat looks for docker there:
REM without this it would say Docker is not installed a moment after installing it.
where docker >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" set "PATH=%PATH%;%ProgramFiles%\Docker\Docker\resources\bin"
echo [OK] Docker Desktop is installed.

REM ---- The code ----
REM Already inside a copy (this file next to start.bat): use it where it is.
if exist "%~dp0start.bat" if exist "%~dp0.git" set "DIR=%~dp0." & goto code_ok
if exist "%DIR%\.git" goto code_ok
echo.
echo [i] Getting the code into %DIR% ...
git clone -b "%REPO_BRANCH%" "%REPO_URL%" "%DIR%"
if errorlevel 1 (
  echo [X] Could not get the code. Check your internet connection, then run install.bat again.
  goto failed
)
:code_ok
echo [OK] The code is in %DIR%

echo.
echo [i] Starting the panel with start.bat - it opens the setup page when it is ready.
echo     From now on, start or update the panel with start.bat in %DIR%
echo.
cd /d "%DIR%"
call start.bat
exit /b %errorlevel%

REM ---- One program missing: install it with winget, open its page, or stop ----
REM errorlevel 0: installed (or tried), 1: the page was opened, 2: stop.
:offer
echo.
if defined HAVE_WINGET echo   [1] Install %WHAT% for me now (winget, Windows' own installer)
if not defined HAVE_WINGET echo   [1] (not available: winget, Windows' own installer, is missing on this PC)
echo   [2] Open the download page: %PAGE%
echo   [3] Stop here
choice /c 123 /n /m "  Choose 1, 2 or 3: "
if errorlevel 3 exit /b 2
if errorlevel 2 (
  start "" "%PAGE%"
  echo.
  echo   Install %WHAT% from the page that opened, then run install.bat again.
  pause
  exit /b 2
)
if not defined HAVE_WINGET (
  echo   winget is not available here - choose 2 to download %WHAT% instead.
  goto offer
)
echo.
echo [i] Installing %WHAT% - Windows may ask for permission...
winget install --id %WINGET_ID% -e --source winget --accept-package-agreements --accept-source-agreements
exit /b 0

:rerun
echo.
echo [!] The install finished, but this window cannot see it yet. Close it and run install.bat again.
pause
exit /b 1

:stopped
echo.
echo [i] Stopped. Run install.bat again whenever you are ready.
exit /b 1

:failed
pause
exit /b 1
