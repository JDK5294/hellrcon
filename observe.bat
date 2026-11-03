@echo off
REM One-click Phase 1 observe test (Windows). Reads server details from infra\.env
REM and connects READ-ONLY (observe mode) — it cannot write to your server, so it is
REM safe to run against a live server that already has CRCON.
REM
REM Usage: observe.bat [serverNumber]   (defaults to 1)
setlocal

where node >nul 2>nul || (echo [X] Node.js is not installed. Install Node 22+ from https://nodejs.org/ & pause & exit /b 1)

if not exist "infra\.env" (
  copy "infra\.env.example" "infra\.env" >nul
  echo [i] Created infra\.env — open it, fill in SERVER_1_HOST/PORT/PASSWORD, then run this again.
  echo.
  pause
  exit /b 0
)

if not exist "packages\games\dist\dev\observe.js" (
  echo [i] First run: installing and building ^(this takes a minute^)...
  call corepack enable >nul 2>nul
  call pnpm install || (echo [X] pnpm install failed & pause & exit /b 1)
  call pnpm build || (echo [X] build failed & pause & exit /b 1)
)

set SERVER=%1
if "%SERVER%"=="" set SERVER=1

node scripts\observe.mjs %SERVER%
pause
endlocal
