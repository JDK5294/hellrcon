@echo off
REM One-click local startup + updater for Windows. Double-click this file.
REM On each click it pulls the latest code (if this is a git clone), then rebuilds
REM and restarts the whole local stack (Postgres + Redis + API + worker) via Docker.
setlocal

REM Re-exec from a temp copy before doing anything else. cmd reads .bat files by byte
REM offset as it runs, so the `git pull` below overwriting THIS file mid-run would derail
REM the script. The temp copy is never touched by the pull, so it runs to completion.
if "%~1"=="__from_temp__" goto :main
cd /d "%~dp0"
copy /y "%~f0" "%TEMP%\app-start.bat" >nul & call "%TEMP%\app-start.bat" __from_temp__ & exit /b

:main
echo ============================================
echo   starting local stack
echo ============================================
echo.

REM 1) Check Docker is installed.
where docker >nul 2>nul
if errorlevel 1 (
  echo [X] Docker is not installed or not on PATH.
  echo     Install Docker Desktop from https://www.docker.com/products/docker-desktop/
  echo     then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM 2) Check the Docker engine is running - and start Docker Desktop when it is installed but not
REM    running, rather than asking for a second double-click. Its engine takes a minute or two to
REM    come up after the window appears, so the check waits for the engine itself, not the window.
docker info >nul 2>nul
if not errorlevel 1 goto docker_ready
set "DOCKER_DESKTOP=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if exist "%DOCKER_DESKTOP%" goto docker_start
echo [!] Docker is installed but not running. Start Docker Desktop and wait for it
echo     to finish starting, then double-click this file again.
echo.
pause
exit /b 1
:docker_start
echo [i] Docker Desktop is not running - starting it. This can take a minute or two...
set "STARTED_DOCKER=1"
start "" "%DOCKER_DESKTOP%"
set /a DOCKER_TRIES=0
:docker_wait
timeout /t 3 /nobreak >nul
docker info >nul 2>nul
if not errorlevel 1 goto docker_ready
set /a DOCKER_TRIES+=1
if %DOCKER_TRIES% lss 60 goto docker_wait
echo [X] Docker Desktop did not finish starting within 3 minutes. If it is asking you to
echo     accept its terms or to restart Windows, do that, then double-click this file again.
echo.
pause
exit /b 1
:docker_ready

REM 3) Seed .env from the template on first run.
if not exist "infra\.env" (
  copy "infra\.env.example" "infra\.env" >nul
  echo [i] Created infra\.env from the template. Edit it later if you need to.
)

REM 4) Pull the latest code (only if this is a git clone and git is installed).
REM    Your infra\.env is git-ignored, so it is never touched by the update. If the
REM    pull can't fast-forward (local commits/conflicts) we keep going with what's here.
if exist ".git" (
  where git >nul 2>nul
  if errorlevel 1 (
    echo [i] git not found on PATH - skipping update, using the code already here.
  ) else (
    echo [i] Checking for updates...
    git pull --ff-only
    if errorlevel 1 (
      echo.
      echo [!] ============================================================
      echo [!]  UPDATE FAILED - the latest code could NOT be pulled.
      echo [!]  The stack will start from the OLD code already on disk.
      echo [!]  Fix: resolve the git conflict shown above, then rerun.
      echo [!] ============================================================
      echo.
    ) else (
      echo [OK] Code is up to date.
    )
    REM Captured into GIT_COMMIT (not just echoed): compose passes it into the image build, and
    REM the panel's sidebar then shows which commit the running install was built from.
    for /f %%h in ('git rev-parse --short HEAD 2^>nul') do set "GIT_COMMIT=%%h"
  )
) else (
  echo [i] Not a git clone - skipping update. ^(Clone with git to enable one-click updates.^)
)
if defined GIT_COMMIT echo [i] Running code at commit %GIT_COMMIT%

REM 4b) Where this code came from, for the panel's "update available" check (apps\api\src\updates.ts):
REM     the branch the clone follows, and the GitHub repository as owner/name only - never the
REM     clone's address itself, which can carry a sign-in.
set "GIT_BRANCH="
set "GIT_REPO="
if not defined GIT_COMMIT goto origin_done
for /f %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "GIT_BRANCH=%%b"
if "%GIT_BRANCH%"=="HEAD" set "GIT_BRANCH="
set "GIT_ORIGIN="
for /f "delims=" %%u in ('git remote get-url origin 2^>nul') do set "GIT_ORIGIN=%%u"
for /f %%r in ('powershell -NoProfile -Command "if ($env:GIT_ORIGIN -match 'github\.com[/:]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(\.git)?/?$') { $Matches[1] + '/' + $Matches[2] }" 2^>nul') do set "GIT_REPO=%%r"
set "GIT_ORIGIN="
:origin_done

REM 4c) Plugins (installed-plugins\README.md): each one that is a git clone updates with the panel.
REM     What is there, at which commit, goes to compose as PLUGINS_STATE, a setting of the api
REM     container, so a plugin added, removed or updated recreates the api - and plugins are only
REM     read when it starts.
set "PLUGINS_STATE="
for /d %%d in ("installed-plugins\*") do call :plugin_update "%%~fd" "%%~nxd"

REM 5) Generate the at-rest encryption key on first run. It encrypts stored RCON passwords;
REM    infra\.env is git-ignored, so the key survives updates but must not be lost.
findstr /b /r "ENCRYPTION_KEY=." "infra\.env" >nul 2>nul
if not errorlevel 1 goto enckey_done
for /f %%k in ('powershell -NoProfile -Command "$b=[byte[]]::new(32);[Security.Cryptography.RandomNumberGenerator]::Fill($b);-join($b.ForEach({ $_.ToString('x2') }))"') do >> "infra\.env" echo ENCRYPTION_KEY=%%k
echo [i] Generated ENCRYPTION_KEY in infra\.env - it encrypts stored RCON passwords; keep the file safe.
:enckey_done

REM 5b) The database password. A brand-new install gets a random one. An install whose database
REM     already exists keeps the one that database was made with - the old template's `app` -
REM     because changing it here does not change the database's, and the app could no longer connect.
findstr /b /r "POSTGRES_PASSWORD=." "infra\.env" >nul 2>nul
if not errorlevel 1 goto dbpass_done
docker volume inspect app_pgdata >nul 2>nul
if errorlevel 1 goto dbpass_new
>> "infra\.env" echo POSTGRES_PASSWORD=app
echo [i] Kept the existing database's password in infra\.env.
goto dbpass_done
:dbpass_new
for /f %%k in ('powershell -NoProfile -Command "$b=[byte[]]::new(24);[Security.Cryptography.RandomNumberGenerator]::Fill($b);-join($b.ForEach({ $_.ToString('x2') }))"') do >> "infra\.env" echo POSTGRES_PASSWORD=%%k
echo [i] Generated a database password in infra\.env.
:dbpass_done

REM 6) Cloudflare tunnel: the panel runs it itself now (Administration - Online access), and a
REM    token an older infra\.env carries is moved into the panel on its first start. The separate
REM    tunnel container older installs ran is no longer started with the stack: once the panel is
REM    up it is removed when the panel's own tunnel connects, or started as a fallback when it
REM    cannot (see :tunnel_wait). The findstr pattern requires a non-empty value at the start of a
REM    line, so a commented-out or blank token counts as none.
set "LEGACY_TUNNEL="
findstr /b /r "CLOUDFLARE_TUNNEL_TOKEN=." "infra\.env" >nul 2>nul
if not errorlevel 1 (
  set "LEGACY_TUNNEL=1"
  echo [i] Cloudflare tunnel token found in infra\.env - the panel takes it over and runs the tunnel itself.
)

REM 6b) CRCON import: if a backup's db_data has been pasted in, bring its database up alongside
REM     the stack so the history can be imported by copying a folder instead of uploading it.
REM     PG_VERSION is a file that exists in every PostgreSQL data directory, so its presence is
REM     proof the paste landed correctly rather than one folder too deep.
set "CRCON_PROFILE="
if exist "crcon-db-data\PG_VERSION" (
  set "CRCON_PROFILE=--profile crcon-import"
  echo [i] CRCON backup found in crcon-db-data - starting its database too.
  echo     First start copies it into a container volume and can take several minutes.
  echo     Then follow docs\crcon-db-import.md to inventory, dry-run and import it.
) else (
  if exist "crcon-db-data" echo [!] crcon-db-data exists but has no PG_VERSION file - paste the CONTENTS of the backup's db_data folder into it.
)

REM 7) The panel's host port: API_PORT in infra\.env overrides the 8080 default (compose
REM    reads the same variable, so the mapping and this script always agree).
REM
REM    The value is then checked to be nothing but digits. A .env saved with Windows line endings,
REM    or with one stray space after the number, leaves an invisible character on the end of it —
REM    and pasted into a URL that produces a request which can never connect. The only symptom is
REM    a two-minute wait ending in "did not become healthy" while the API log plainly says it is
REM    listening, which sends you looking at the application for a fault in a text file.
REM    ` ` is in delims so a trailing space goes on its own; the test catches everything else.
set "API_PORT="
for /f "tokens=2 delims== " %%p in ('findstr /b /c:"API_PORT=" "infra\.env" 2^>nul') do set "API_PORT=%%p"
echo %API_PORT%| findstr /r /c:"^[0-9][0-9]*$" >nul 2>nul
if not errorlevel 1 goto port_ok
if defined API_PORT echo [!] API_PORT in infra\.env is not a plain number - ignoring it and using 8080.
set "API_PORT=8080"
:port_ok

REM 7b) Something else already on that port - another web server, another app's container - makes
REM     Docker refuse to start the panel with an error about the port. Ask instead: the next free
REM     port, or one typed in, saved as API_PORT in infra\.env. The panel's own container holding it
REM     is not "something else": an update restarts the panel on the same port. A port is free when
REM     nothing listens on it and Windows has not reserved it for its own networking (netsh's excluded
REM     port ranges). Nothing listens to find out: a program that does makes Windows Defender Firewall
REM     ask about it, in the middle of the start.
set "PS_FREE=function Free($p) { if ($null -eq $script:taken) { $script:taken = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().ForEach({ $_.Port })); $script:held = @(); foreach ($fam in 'ipv4', 'ipv6') { try { foreach ($line in (netsh interface $fam show excludedportrange protocol=tcp)) { if ($line -match '(\d+)\s+(\d+)') { $script:held += ,@([int]$Matches[1], [int]$Matches[2]) } } } catch { } } }; if ($script:taken -contains $p) { return $false }; foreach ($r in $script:held) { if ($p -ge $r[0] -and $p -le $r[1]) { return $false } }; return $true }"
REM     The panel's own container is found from Docker's answer to `compose port`, read by PowerShell.
REM     Docker ends that line with a bare line feed and findstr's `$` matches only before a carriage
REM     return, so a findstr test of it never matched: every update with the panel running asked
REM     for another port.
powershell -NoProfile -Command "$own = docker compose --env-file infra\.env -f infra\docker-compose.yml port api 8080; if (@($own) -match (':' + $env:API_PORT + '$')) { exit 0 }; exit 1" >nul 2>nul
if not errorlevel 1 goto port_free
call :port_busy %API_PORT%
if errorlevel 1 goto port_free
echo.
echo [!] Port %API_PORT% is already in use by another program, so the panel cannot start on it.
echo     [1] Find the next free port for me
echo     [2] Let me type a port
echo     [3] Stop here
choice /c 123 /n /m "    Choose 1, 2 or 3: "
if errorlevel 3 goto port_stop
if errorlevel 2 goto port_typed
set "NEW_PORT="
for /f %%p in ('powershell -NoProfile -Command "%PS_FREE%; $p = %API_PORT% + 1; while ($p -le 65535 -and -not (Free $p)) { $p++ }; if ($p -le 65535) { $p }" 2^>nul') do set "NEW_PORT=%%p"
if defined NEW_PORT goto port_save
echo [X] Could not find a free port above %API_PORT%. Choose one yourself instead.
:port_typed
set "NEW_PORT="
set /p "NEW_PORT=    Port to use (1024-65535): "
REM What was typed is checked where cmd never reads it: a stray & | < > in it, put on a command line,
REM is a syntax error, and cmd ends the whole script on one.
powershell -NoProfile -Command "if ($env:NEW_PORT -match '\A[1-9][0-9]{3,4}\z' -and [int]$env:NEW_PORT -ge 1024 -and [int]$env:NEW_PORT -le 65535) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 goto port_typed_bad
call :port_busy %NEW_PORT%
if errorlevel 1 goto port_save
echo     Port %NEW_PORT% is in use too - try another.
goto port_typed
:port_typed_bad
echo     Use a whole number from 1024 to 65535.
goto port_typed
:port_stop
echo.
echo [i] Stopped. Free port %API_PORT%, or run start.bat again to pick another port.
pause
exit /b 1
:port_save
REM Into infra\.env in place: its other lines are kept exactly, and it stays UTF-8 without a BOM,
REM which Docker reads as it did.
powershell -NoProfile -Command "$f = 'infra\.env'; $lines = [IO.File]::ReadAllLines($f); $found = $false; $out = foreach ($l in $lines) { if ($l.StartsWith('API_PORT=')) { $found = $true; 'API_PORT=%NEW_PORT%' } else { $l } }; if (-not $found) { $out = @($out) + 'API_PORT=%NEW_PORT%' }; [IO.File]::WriteAllLines($f, [string[]]$out, (New-Object Text.UTF8Encoding $false))"
if errorlevel 1 (
  echo [X] Could not save the port in infra\.env. Set API_PORT=%NEW_PORT% there yourself, then run start.bat again.
  pause
  exit /b 1
)
set "API_PORT=%NEW_PORT%"
echo [OK] The panel will use port %API_PORT% - saved as API_PORT in infra\.env.
:port_free

REM 8) Rebuild images from the current source and (re)start the stack. --build makes any
REM    pulled code take effect; Docker's layer cache keeps it fast when nothing changed.
echo [i] Building and starting containers (first run downloads images, please wait)...
docker compose --env-file infra\.env -f infra\docker-compose.yml %CRCON_PROFILE% up -d --build
if errorlevel 1 (
  echo.
  echo [X] Failed to start the stack. See the messages above.
  pause
  exit /b 1
)

REM 9) Don't declare victory until the panel actually answers. While booting, the API serves a
REM    "starting" page; /api/health returns {"status":"ok",...} once it is ready.
REM
REM    The probe keeps the HTTP STATUS rather than grepping the body for a word. Grepping cannot
REM    tell "nothing is listening on that port" from "the API answered 503, still migrating" from
REM    "curl is not installed" — all three are just "no match", and all three ended in the same
REM    unhelpful "did not become healthy" with an API log that says it is listening. The code says
REM    which, and the failure branch below turns it into a sentence.
set "HEALTH_URL=http://localhost:%API_PORT%/api/health"
set "HEALTH_BODY=%TEMP%\app-health.txt"
set "NO_CURL="
where curl >nul 2>nul
if not errorlevel 1 goto have_curl
set "NO_CURL=1"
echo [!] curl is not on PATH, so this script cannot reach the panel itself.
echo     Falling back to Docker's own health report for the api container.
:have_curl

echo.
echo [i] Waiting for the panel to come up at %HEALTH_URL% ...
set /a HEALTH_TRIES=0
:healthwait
set /a HEALTH_TRIES+=1
set "HEALTH_RESULT=no answer"
if defined NO_CURL goto healthwait_docker
for /f %%c in ('curl -s -o "%HEALTH_BODY%" -w "%%{http_code}" -m 3 "%HEALTH_URL%" 2^>nul') do set "HEALTH_RESULT=%%c"
if "%HEALTH_RESULT%"=="200" goto healthy
goto healthwait_tick

REM Without curl, ask Docker instead. This is the container's own healthcheck (see the compose
REM file), so it proves the app is up but says nothing about the host being able to reach it.
:healthwait_docker
for /f "delims=" %%s in ('docker compose --env-file infra\.env -f infra\docker-compose.yml ps --format "{{.Health}}" api 2^>nul') do set "HEALTH_RESULT=%%s"
if "%HEALTH_RESULT%"=="healthy" goto healthy

:healthwait_tick
if %HEALTH_TRIES% geq 40 goto unhealthy
timeout /t 3 /nobreak >nul
goto healthwait

:unhealthy
echo.
echo [X] The containers started but the panel did not answer within 2 minutes.
echo.
echo     Probed:      %HEALTH_URL%
echo     Last result: %HEALTH_RESULT%
echo.
REM Name the likely cause instead of leaving a status code on screen. These are the only outcomes
REM the probe can produce, and each one points somewhere different.
if "%HEALTH_RESULT%"=="000" echo     ^> Nothing accepted a connection on port %API_PORT%. The app itself may be fine:
if "%HEALTH_RESULT%"=="000" echo       check API_PORT in infra\.env matches the mapping in the container list below,
if "%HEALTH_RESULT%"=="000" echo       and that nothing else already holds that port.
if "%HEALTH_RESULT%"=="503" echo     ^> The API answered, but it is still booting - almost always the database.
if "%HEALTH_RESULT%"=="503" echo       The API log below names the phase it is stuck in.
if "%HEALTH_RESULT%"=="404" echo     ^> Something answered on that port, but it is not this panel.
echo.
echo     Container status ^(the api container reports its own health now^):
docker compose --env-file infra\.env -f infra\docker-compose.yml ps
echo.
if exist "%HEALTH_BODY%" echo     What the panel actually replied:
if exist "%HEALTH_BODY%" type "%HEALTH_BODY%"
if exist "%HEALTH_BODY%" echo.
echo     Last API log lines:
docker compose --env-file infra\.env -f infra\docker-compose.yml logs --no-log-prefix --tail=30 api
echo.
echo     More detail: docker compose --env-file infra\.env -f infra\docker-compose.yml logs --tail=200
echo.
pause
exit /b 1

:healthy
REM A brand-new install opens on its setup page with the one-time setup code filled in: the panel
REM wrote the code inside its own container, so it is read from there and handed over in the link.
REM `needed.:true` with a dot rather than a quote: findstr would need escaped quotes otherwise.
set "OPEN_URL=http://localhost:%API_PORT%"
set "SETUP_CODE="
if defined NO_CURL goto open_panel
curl -s -m 3 "http://localhost:%API_PORT%/api/setup/status" 2>nul | findstr /r /c:"needed.:true" >nul 2>nul
if errorlevel 1 goto open_panel
for /f "delims=" %%c in ('docker compose --env-file infra\.env -f infra\docker-compose.yml exec -T api cat /tmp/setup-code 2^>nul') do set "SETUP_CODE=%%c"
if defined SETUP_CODE set "OPEN_URL=http://localhost:%API_PORT%/#/setup?code=%SETUP_CODE%"
:open_panel
echo [OK] Panel is healthy. Opening it...
start "" "%OPEN_URL%"

REM The tunnel: the panel's own, or the container older installs ran. The panel's public status says
REM where its tunnel stands. "connected" retires the old container; "off" means the tunnel was
REM switched off in the panel, so the old one goes too; anything else after a minute keeps the old
REM container running, or starts it, while infra\.env still holds its token.
set "TUNNEL_NOTE="
set "TUNNEL_CONTAINER="
for /f "delims=" %%i in ('docker compose --env-file infra\.env -f infra\docker-compose.yml --profile tunnel ps -q cloudflared 2^>nul') do set "TUNNEL_CONTAINER=%%i"
if not defined TUNNEL_CONTAINER if not defined LEGACY_TUNNEL goto tunnel_done
if defined NO_CURL goto tunnel_fallback
echo [i] Waiting up to a minute for the panel's own Cloudflare tunnel to connect...
set /a TUNNEL_TRIES=0
:tunnel_wait
set "TUNNEL_STATE="
curl -s -m 3 "http://localhost:%API_PORT%/api/setup/status" 2>nul | findstr /r /c:"tunnel.:.connected" >nul 2>nul
if not errorlevel 1 set "TUNNEL_STATE=connected"
curl -s -m 3 "http://localhost:%API_PORT%/api/setup/status" 2>nul | findstr /r /c:"tunnel.:.off" >nul 2>nul
if not errorlevel 1 set "TUNNEL_STATE=off"
if defined TUNNEL_STATE goto tunnel_retire
set /a TUNNEL_TRIES+=1
if %TUNNEL_TRIES% geq 30 goto tunnel_fallback
timeout /t 2 /nobreak >nul
goto tunnel_wait
:tunnel_retire
if not defined TUNNEL_CONTAINER goto tunnel_done
docker compose --env-file infra\.env -f infra\docker-compose.yml --profile tunnel rm -sf cloudflared >nul 2>nul
set "TUNNEL_NOTE=retired-%TUNNEL_STATE%"
goto tunnel_done
:tunnel_fallback
if not defined LEGACY_TUNNEL goto tunnel_done
docker compose --env-file infra\.env -f infra\docker-compose.yml --profile tunnel up -d cloudflared >nul 2>nul
set "TUNNEL_NOTE=fallback"
:tunnel_done

REM After a Windows restart the panel comes back by itself only when Docker Desktop starts at
REM sign-in - off by default, per Docker's own settings page - and Windows signs in by itself.
REM Docker keeps its choice in settings-store.json under a key it does not document, so it counts as
REM off only when the file says so, or when this script just had to start Docker itself. Windows'
REM automatic sign-in is AutoAdminLogon=1, which Microsoft's Autologon tool and netplwiz both set.
set "DOCKER_AUTOSTART=unknown"
for /f %%s in ('powershell -NoProfile -Command "$f = @((Join-Path $env:APPDATA 'Docker\settings-store.json'), (Join-Path $env:APPDATA 'Docker\settings.json')).Where({ Test-Path $_ }, 'First'); if ($f.Count -eq 0) { 'unknown'; exit }; try { $j = ConvertFrom-Json (Get-Content -Raw $f[0]) } catch { 'unknown'; exit }; $k = $j.PSObject.Properties.Where({ $_.Name -eq 'autoStart' }, 'First'); if ($k.Count -eq 0) { 'unknown' } elseif ($k[0].Value -eq $true) { 'on' } else { 'off' }" 2^>nul') do set "DOCKER_AUTOSTART=%%s"
set "RESTART_DOCKER="
if "%DOCKER_AUTOSTART%"=="off" set "RESTART_DOCKER=1"
if "%DOCKER_AUTOSTART%"=="unknown" if defined STARTED_DOCKER set "RESTART_DOCKER=1"
set "AUTOLOGON="
for /f "tokens=3" %%v in ('reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon 2^>nul ^| findstr /i "AutoAdminLogon"') do set "AUTOLOGON=%%v"
set "RESTART_LOGON="
if not "%AUTOLOGON%"=="1" set "RESTART_LOGON=1"

echo.
echo   Panel:   http://localhost:%API_PORT%
if defined SETUP_CODE echo.
if defined SETUP_CODE echo   First-time setup: the page that just opened asks for this setup code
if defined SETUP_CODE echo   Setup code:       %SETUP_CODE%
if defined SETUP_CODE echo.
if "%TUNNEL_NOTE%"=="retired-connected" echo   Tunnel:  the panel runs it now - the separate tunnel container was removed
if "%TUNNEL_NOTE%"=="retired-off" echo   Tunnel:  switched off in the panel - the separate tunnel container was removed
if "%TUNNEL_NOTE%"=="fallback" echo   Tunnel:  the panel's own tunnel has not connected - the separate container runs meanwhile. See Administration - Online access.
if defined CRCON_PROFILE echo   CRCON:   backup database up - see docs\crcon-db-import.md to import it
if not defined RESTART_DOCKER if not defined RESTART_LOGON goto restart_done
echo.
echo   Restarts: after Windows restarts, for updates or a power cut, the panel comes back by itself
echo   once Docker Desktop is running again. Recommended, so nobody has to be there:
if defined RESTART_DOCKER echo   - Docker Desktop starts when you sign in. In Docker Desktop: Settings, General,
if defined RESTART_DOCKER echo     "Start Docker Desktop when you sign in to your computer".
if defined RESTART_LOGON echo   - Windows signs in by itself. Microsoft's free Autologon tool sets that up:
if defined RESTART_LOGON echo     https://learn.microsoft.com/sysinternals/downloads/autologon
if defined RESTART_LOGON echo     Only on a PC kept somewhere safe: whoever switches it on is signed in.
:restart_done
echo   Stop it: run stop.bat  (or: docker compose -f infra\docker-compose.yml down)
echo.
pause
endlocal
exit /b

REM ---- Is this port taken? errorlevel 0: in use, or reserved by Windows; 1: free. If PowerShell
REM      itself cannot run, the port counts as free and Docker says what it finds, as before.
:port_busy
powershell -NoProfile -Command "%PS_FREE%; if (Free %1) { exit 1 } else { exit 0 }" >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

REM ---- One installed plugin: pulled when it is a git clone, then added to PLUGINS_STATE as
REM      name@commit, or just its name. %1: its full path, %2: its folder's name.
:plugin_update
set "PLUGIN_AT="
if not exist "%~1\.git" goto plugin_state
where git >nul 2>nul
if errorlevel 1 goto plugin_state
git -C "%~1" pull --ff-only
if errorlevel 1 goto plugin_stuck
echo [OK] Plugin %~2 is up to date.
goto plugin_commit
:plugin_stuck
echo [!] Plugin %~2 could not be updated - it starts as it was.
:plugin_commit
for /f %%h in ('git -C "%~1" rev-parse --short HEAD 2^>nul') do set "PLUGIN_AT=@%%h"
:plugin_state
set "PLUGINS_STATE=%PLUGINS_STATE%%~2%PLUGIN_AT%;"
exit /b 0
