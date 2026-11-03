@echo off
REM Stops the local stack. Data is preserved in Docker volumes.
setlocal
REM From this file's own folder, whatever folder it was started in: run as administrator, Windows
REM starts a .bat in C:\Windows\System32, where infra\.env is not - like start.bat.
cd /d "%~dp0"
echo Stopping local stack...
REM --profile tunnel so the Cloudflare tunnel container is torn down too when it's in use.
REM Harmless when no tunnel is configured (the service simply isn't running).
docker compose --env-file infra\.env -f infra\docker-compose.yml --profile tunnel down
if errorlevel 1 (
  echo [X] Docker could not stop the stack - see the message above. If Docker Desktop is not
  echo     running, the panel is not running either.
) else (
  echo Done.
)
pause
endlocal
